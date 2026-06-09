/**
 * POST /api/items/semantic-model/[id]/direct-lake
 *
 * Azure-native Direct Lake query with transparent Serverless fallback.
 *
 * Analogous to Fabric's "Direct Lake on SQL" DirectQuery fallback behavior
 * (learn.microsoft.com/fabric/fundamentals/direct-lake-overview#fallback):
 * when the warm AAS cache (a Power BI Import/Premium model whose VertiPaq cache
 * is refreshed on every Gold Delta commit) is FRESH, data is served from the
 * in-memory cache via the Power BI executeQueries REST API. When the cache is
 * STALE or UNBUILT, the SAME data is served transparently via Synapse Serverless
 * OPENROWSET over the Gold Delta files on ADLS Gen2 — no error, no gap.
 *
 * Cache freshness: the last SUCCESSFUL dataset refresh must be within
 * LOOM_DL_CACHE_TTL_SECONDS (default 3600; 0 = always Serverless). If Power BI
 * is unconfigured, the dataset 404s, or the warm DAX query fails, the route
 * falls through to Serverless silently.
 *
 * Body:  { workspaceId: string; table: string; maxRows?: number; sql?: string }
 * Reply: { ok; servingFrom: 'warm-cache'|'serverless-fallback'; columns; rows;
 *          rowCount; executionMs; endpoint?; truncated?; deltaPath?;
 *          lastRefreshedAt?; cacheTtlSeconds? }
 *
 * Honest infra gates (per no-vaporware.md):
 *   - LOOM_SYNAPSE_WORKSPACE missing → 503 naming the var
 *   - LOOM_GOLD_URL missing (when a table query is requested) → 503 naming it
 *
 * No Fabric / OneLake / Power BI dependency on the DEFAULT (Serverless) path
 * (per no-fabric-dependency.md). The warm-cache path is strictly opt-in: it is
 * only attempted when a Power BI workspace is bound and the model was refreshed
 * recently; otherwise Serverless serves every query. RBAC:
 *   Synapse: Console UAMI needs Storage Blob Data Reader on the Gold ADLS
 *            container (already granted by the landing-zone Bicep) + CONNECT on
 *            the serverless DB.
 *   Power BI (warm path only): UAMI must be a workspace Member.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  executeQuery,
  serverlessTarget,
  getSynapseSqlSuffix,
  buildDeltaOpenRowsetSql,
  goldDeltaBulkUrl,
} from '@/lib/azure/synapse-sql-client';
import { listRefreshHistory, executeDatasetQueries } from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Seconds before the warm AAS cache is considered stale. 0 = always Serverless. */
function cacheTtlSeconds(): number {
  const v = parseInt(process.env.LOOM_DL_CACHE_TTL_SECONDS || '3600', 10);
  return isNaN(v) || v < 0 ? 3600 : v;
}

/**
 * ISO timestamp of the last COMPLETED dataset refresh, or null when no completed
 * refresh exists or Power BI is unreachable (unconfigured / 404 / token error) —
 * in which case the caller serves from Serverless.
 */
async function lastCompletedRefreshAt(workspaceId: string, datasetId: string): Promise<string | null> {
  try {
    const history = await listRefreshHistory(workspaceId, datasetId, 10);
    const last = history.find((r) => r.status === 'Completed');
    return last?.endTime ?? null;
  } catch {
    return null;
  }
}

function isCacheWarm(lastRefreshAt: string | null, ttlSeconds: number): boolean {
  if (ttlSeconds === 0 || !lastRefreshAt) return false;
  const ageMs = Date.now() - new Date(lastRefreshAt).getTime();
  if (isNaN(ageMs)) return false;
  return ageMs < ttlSeconds * 1000;
}

function sanitize(e: any): string {
  return (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const workspaceId = (body?.workspaceId || '').toString().trim();
  const table = (body?.table || '').toString().trim();
  const rawSql = (body?.sql || '').toString().trim();
  const maxRows = Math.min(Math.max(1, parseInt(body?.maxRows ?? '1000', 10) || 1000), 5_000);
  const id = (await ctx.params).id;

  if (!table && !rawSql) {
    return NextResponse.json({ ok: false, error: 'table or sql required' }, { status: 400 });
  }

  // Synapse Serverless is required for the fallback path (and for raw sql).
  if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Synapse Serverless not configured. Set LOOM_SYNAPSE_WORKSPACE to the ' +
          'Synapse workspace whose -ondemand endpoint serves OPENROWSET over the ' +
          'Gold Delta tables, and grant the Console UAMI Storage Blob Data Reader ' +
          'on the Gold container. Required for Direct Lake Serverless fallback.',
        code: 'synapse_not_configured',
      },
      { status: 503 },
    );
  }

  const started = Date.now();
  const endpoint = `${process.env.LOOM_SYNAPSE_WORKSPACE}-ondemand.${getSynapseSqlSuffix()}`;

  // ── Raw SQL path: always Serverless, skip the cache check. ──────────────────
  if (rawSql) {
    if (rawSql.length > 65_536) {
      return NextResponse.json({ ok: false, error: 'sql too large (>64KB)' }, { status: 413 });
    }
    try {
      const result = await executeQuery(serverlessTarget('master'), rawSql, 60_000);
      return NextResponse.json({ ok: true, servingFrom: 'serverless-fallback', endpoint, ...result });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: sanitize(e), code: e?.code }, { status: 502 });
    }
  }

  // ── Table path: try warm cache, then fall back to Serverless. ───────────────
  const ttl = cacheTtlSeconds();
  // Only probe Power BI when a workspace is actually bound (opt-in warm path).
  const lastAt = workspaceId ? await lastCompletedRefreshAt(workspaceId, id) : null;
  const warm = !!workspaceId && isCacheWarm(lastAt, ttl);

  if (warm) {
    // Warm path: DAX EVALUATE TOPN via the Power BI executeQueries REST API.
    try {
      const dax = `EVALUATE TOPN(${maxRows}, '${table.replace(/'/g, "''")}')`;
      const pbiResult = await executeDatasetQueries(workspaceId, id, dax);
      const pbiRows = pbiResult.results?.[0]?.tables?.[0]?.rows ?? [];
      const columns = pbiRows.length > 0 ? Object.keys(pbiRows[0]) : [];
      return NextResponse.json({
        ok: true,
        servingFrom: 'warm-cache',
        lastRefreshedAt: lastAt,
        cacheTtlSeconds: ttl,
        columns,
        rows: pbiRows.map((r) => columns.map((c) => r[c])),
        rowCount: pbiRows.length,
        executionMs: Date.now() - started,
        truncated: pbiRows.length >= maxRows,
      });
    } catch (e: any) {
      // Power BI query failed (model unloaded, capacity paused, etc.) → fall
      // through transparently to Serverless. Log for diagnostics only.
      console.warn('[direct-lake] warm-cache DAX query failed, falling back to Serverless:', e?.message);
    }
  }

  // ── Serverless fallback path (the Azure-native DEFAULT). ─────────────────────
  let deltaUrl: string;
  try {
    deltaUrl = goldDeltaBulkUrl(table);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message, code: 'gold_url_not_configured' }, { status: 503 });
  }

  const openrowsetSql = buildDeltaOpenRowsetSql(deltaUrl, maxRows);

  try {
    const result = await executeQuery(serverlessTarget('master'), openrowsetSql, 60_000);
    return NextResponse.json({
      ok: true,
      servingFrom: 'serverless-fallback',
      lastRefreshedAt: lastAt,
      cacheTtlSeconds: ttl,
      endpoint,
      deltaPath: deltaUrl,
      ...result,
    });
  } catch (e: any) {
    const raw = sanitize(e);
    if (/timeout|cold/.test(raw)) {
      return NextResponse.json(
        {
          ok: false,
          code: 'synapse_cold_start',
          error:
            'Serverless fallback took longer than 60 seconds (cold-start). ' +
            'Retry — the pool stays warm and subsequent queries run faster.',
        },
        { status: 504 },
      );
    }
    return NextResponse.json({ ok: false, error: raw, code: e?.code }, { status: 502 });
  }
}
