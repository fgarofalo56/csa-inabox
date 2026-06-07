/**
 * POST /api/items/eventhouse/[id]/policies
 *
 * Body: {
 *   database: string,
 *   hotCacheDays?: number,
 *   softDeleteDays?: number,
 *   oneLakeAvailability?: boolean,
 *   enableStreamingIngest?: boolean
 * }
 *
 * Applies per-database caching + retention policies via the KQL management
 * commands `.alter database policy caching` / `.alter database policy
 * retention`. OneLake availability is a Fabric-managed cluster feature; on
 * the stand-alone ADX cluster (`adx-csa-loom-shared`) we return a structured
 * note explaining where the flag lives (LOOM_KUSTO_FABRIC_MANAGED=true).
 *
 * Streaming ingestion is a two-step activation: (1) an ARM PATCH that sets the
 * cluster-level `properties.enableStreamingIngest` capability flag, and (2) a
 * KQL `.alter database policy streamingingestion enable` so the `.ingest
 * inline` low-latency path is live for that database. Both run here.
 *
 * Real backend, no mocks. Per .claude/rules/no-vaporware.md.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeMgmtCommand, KustoError } from '@/lib/azure/kusto-client';
import { updateKustoStreamingIngest, KustoArmError } from '@/lib/azure/kusto-arm-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function validIdent(s: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_\-]{0,127}$/.test(s);
}

export async function POST(req: NextRequest, _ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const database = String(body?.database || '').trim();
  if (!database) return NextResponse.json({ ok: false, error: 'database required' }, { status: 400 });
  if (!validIdent(database)) return NextResponse.json({ ok: false, error: 'invalid database name' }, { status: 400 });

  const hot = Number(body?.hotCacheDays);
  const soft = Number(body?.softDeleteDays);
  const wantOneLake = !!body?.oneLakeAvailability;
  // undefined => field absent => no-op; only act when an explicit boolean.
  const wantStreaming = typeof body?.enableStreamingIngest === 'boolean'
    ? (body.enableStreamingIngest as boolean)
    : undefined;

  const applied: string[] = [];
  const errors: string[] = [];

  if (Number.isFinite(hot) && hot >= 0) {
    const cmd = `.alter database ["${database}"] policy caching hot = ${Math.floor(hot)}d`;
    try {
      await executeMgmtCommand(database, cmd);
      applied.push(`cache=${Math.floor(hot)}d`);
    } catch (e: any) {
      errors.push(`cache: ${e?.message || String(e)}`);
    }
  }

  if (Number.isFinite(soft) && soft > 0) {
    // retention policy uses JSON body
    const retentionJson = JSON.stringify({ SoftDeletePeriod: `${Math.floor(soft)}.00:00:00`, Recoverability: 'Enabled' });
    const cmd = `.alter database ["${database}"] policy retention \`\`\`${retentionJson}\`\`\``;
    try {
      await executeMgmtCommand(database, cmd);
      applied.push(`retention=${Math.floor(soft)}d`);
    } catch (e: any) {
      errors.push(`retention: ${e?.message || String(e)}`);
    }
  }

  let oneLakeNote: string | undefined;
  if (wantOneLake) {
    // OneLake mirroring is a Fabric-managed eventhouse feature. The
    // stand-alone shared ADX cluster does NOT support it; surface a
    // structured note instead of pretending it worked.
    const fabricMode = process.env.LOOM_KUSTO_FABRIC_MANAGED === 'true';
    if (!fabricMode) {
      oneLakeNote = 'OneLake availability requires a Fabric-managed eventhouse (set LOOM_KUSTO_FABRIC_MANAGED=true once the cluster is migrated). Skipped on the stand-alone shared ADX cluster.';
    } else {
      // Fabric-only mgmt command. If the cluster rejects it the error is
      // surfaced verbatim.
      try {
        await executeMgmtCommand(database, `.alter database ["${database}"] policy OneLakeAvailability "true"`);
        applied.push('onelake=true');
      } catch (e: any) {
        const status = e instanceof KustoError ? e.status : 502;
        errors.push(`onelake: ${e?.message || String(e)} (status ${status})`);
      }
    }
  }

  let streamingNote: string | undefined;
  if (typeof wantStreaming === 'boolean') {
    // Two-step activation: (1) cluster-level ARM flag, (2) database policy so
    // the .ingest inline low-latency path is live. Step 1 is the source of
    // truth for the cluster capability; step 2 is only meaningful when
    // enabling (and is non-fatal if it fails after the flag is set).
    try {
      const arm = await updateKustoStreamingIngest(wantStreaming);
      applied.push(`streamingIngest=${wantStreaming}`);
      if (arm.provisioningState === 'Updating') {
        streamingNote = 'Cluster streaming-ingestion flag is reconfiguring (async). Enabling completes in seconds–minutes; the database policy below is already applied.';
      }
      if (wantStreaming) {
        const cmd = `.alter database ["${database}"] policy streamingingestion enable`;
        try {
          await executeMgmtCommand(database, cmd);
          applied.push('db-streamingpolicy=enabled');
        } catch (e: any) {
          // Non-fatal: the cluster flag is already set. Surface as a warning so
          // the operator can retry the per-database policy once the cluster
          // finishes reconfiguring.
          const status = e instanceof KustoError ? e.status : 502;
          errors.push(`db-streamingpolicy: ${e?.message || String(e)} (status ${status})`);
        }
      }
      // When disabling we intentionally leave the db-level policy in place: a
      // later re-enable then needs no policy re-apply. A full per-table disable
      // is available via `.delete table T policy streamingingestion` in the
      // query editor.
    } catch (e: any) {
      const status = e instanceof KustoArmError ? e.status : 502;
      errors.push(`streamingIngest: ${e?.message || String(e)} (status ${status})`);
    }
  }

  if (errors.length && !applied.length) {
    return NextResponse.json({ ok: false, error: errors.join('; '), applied, oneLakeNote, streamingNote }, { status: 502 });
  }
  return NextResponse.json({
    ok: true,
    database,
    applied,
    errors: errors.length ? errors : undefined,
    oneLakeNote,
    streamingNote,
  });
}
