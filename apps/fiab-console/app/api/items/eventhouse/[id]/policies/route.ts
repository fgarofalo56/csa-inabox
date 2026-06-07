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
import {
  updateKustoClusterAutoscale,
  updateKustoStreamingIngest,
  KustoArmError,
  KustoNotConfiguredError,
} from '@/lib/azure/kusto-arm-client';

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

/**
 * PATCH /api/items/eventhouse/[id]/policies
 *
 * Body: { optimizedAutoscale: { isEnabled: boolean, minimum: number, maximum: number } }
 *
 * Cluster-level (not per-database) operation: calls ARM
 * `PATCH /clusters` with properties.optimizedAutoscale to enable/disable ADX
 * optimized auto-scale and set the min/max instance bounds. `version` is
 * pinned to 1 by the client per the ARM schema.
 *
 * ARM rejects optimizedAutoscale on Dev(No SLA)/Basic-tier SKUs with HTTP 400;
 * that is surfaced as an honest 422 SKU gate per .claude/rules/no-vaporware.md.
 * Azure-native path — no Fabric workspace required.
 */
export async function PATCH(req: NextRequest, _ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const as = body?.optimizedAutoscale;
  if (
    !as ||
    typeof as.isEnabled !== 'boolean' ||
    typeof as.minimum !== 'number' ||
    typeof as.maximum !== 'number'
  ) {
    return NextResponse.json(
      { ok: false, error: 'optimizedAutoscale.{isEnabled,minimum,maximum} are required' },
      { status: 400 },
    );
  }
  const isEnabled: boolean = as.isEnabled;
  const minimum = Math.floor(as.minimum);
  const maximum = Math.floor(as.maximum);
  if (!Number.isInteger(minimum) || minimum < 2) {
    return NextResponse.json({ ok: false, error: 'minimum must be an integer >= 2' }, { status: 400 });
  }
  if (!Number.isInteger(maximum) || maximum > 1000 || maximum < minimum) {
    return NextResponse.json(
      { ok: false, error: `maximum must be an integer in [${minimum}, 1000]` },
      { status: 400 },
    );
  }

  try {
    const cluster = await updateKustoClusterAutoscale(isEnabled, minimum, maximum);
    return NextResponse.json({
      ok: true,
      optimizedAutoscale: cluster.optimizedAutoscale,
      provisioningState: cluster.provisioningState,
    });
  } catch (e: any) {
    if (e instanceof KustoNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, missing: e.missing }, { status: 503 });
    }
    if (e instanceof KustoArmError) {
      const skuGate = e.status === 400
        ? 'Optimized auto-scale requires a Standard-tier ADX SKU. This cluster is on a Dev(No SLA)/Basic SKU. Upgrade the cluster SKU via Manage › Scale up first, then re-apply.'
        : undefined;
      return NextResponse.json(
        { ok: false, error: skuGate || e.message, armStatus: e.status },
        { status: e.status === 400 || e.status === 409 ? 422 : 502 },
      );
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
