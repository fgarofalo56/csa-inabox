/**
 * /api/items/warehouse/[id]/migrate — SQL DB migration assistant.
 *
 * The Azure-native equivalent of Fabric's "Migration Assistant for Fabric Data
 * Warehouse" (Build 2026 #22), targeting the Synapse Dedicated SQL pool that
 * backs the Loom Warehouse item. No Fabric / Power BI dependency — works fully
 * with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 *
 * GET
 *   Probes the dedicated pool state (Online/Paused) so the wizard can gate the
 *   deploy step honestly. Returns the bound pool/sku.
 *
 * POST  multipart/form-data
 *   field `file`   — the .dacpac (data-tier application) bytes (required)
 *   field `action` — "scan" (default) | "deploy"
 *   field `distribution` — ROUND_ROBIN | HASH | REPLICATE  (deploy only)
 *   field `index`        — "CLUSTERED COLUMNSTORE INDEX" | "HEAP" (deploy only)
 *   field `ifNotExists`  — "true" to make the run idempotent (deploy only)
 *
 *   scan   → parses the model, runs the dedicated-pool compatibility scan, and
 *            returns { metadata, counts, report, preview } where preview is the
 *            generated DDL (so the operator reviews before deploying). Read-only.
 *   deploy → re-parses with bodies, generates the DDL, and executes it on the
 *            live dedicated pool over TDS (real backend). Returns per-object
 *            results.
 *
 * Grounded in:
 *   https://learn.microsoft.com/sql/tools/sqlpackage/sqlpackage-for-azure-synapse-analytics
 *   https://learn.microsoft.com/azure/synapse-analytics/sql/develop-tables-overview#unsupported-table-features
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dedicatedTarget } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';
import {
  parseDacpac,
  parseDacpacWithBodies,
  scanCompatibility,
  generateDeployScript,
  deployToSynapse,
  type DeployOptions,
} from '@/lib/azure/dacpac-migrate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Largest DACPAC we accept in one upload (model.xml, not data). */
const MAX_BYTES = 50 * 1024 * 1024; // 50 MiB

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const state = await getPoolState().catch(() => null);
    return NextResponse.json({
      ok: true,
      pool: process.env.LOOM_SYNAPSE_DEDICATED_POOL || null,
      workspace: process.env.LOOM_SYNAPSE_WORKSPACE || null,
      state: state?.state || 'Unknown',
      sku: state?.sku || null,
      online: state?.state === 'Online',
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  if (!process.env.LOOM_SYNAPSE_WORKSPACE || !process.env.LOOM_SYNAPSE_DEDICATED_POOL) {
    return NextResponse.json(
      {
        ok: false,
        notConfigured: true,
        error:
          'No Synapse Dedicated SQL pool is bound. Set LOOM_SYNAPSE_WORKSPACE and ' +
          'LOOM_SYNAPSE_DEDICATED_POOL (provisioned by platform/fiab/bicep/modules/analytics/synapse.bicep) ' +
          'so the migration assistant has a target warehouse.',
      },
      { status: 503 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: 'Expected multipart/form-data with a .dacpac file.' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: 'file field (the .dacpac) is required.' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: `.dacpac is ${(file.size / 1048576).toFixed(1)} MiB — exceeds the ${MAX_BYTES / 1048576} MiB limit.` },
      { status: 413 },
    );
  }

  const action = (form.get('action')?.toString() || 'scan').toLowerCase();
  const bytes = Buffer.from(await file.arrayBuffer());

  // ── scan: read-only parse + compatibility report + DDL preview ──
  if (action === 'scan') {
    try {
      const parsed = parseDacpacWithBodies(bytes);
      const report = scanCompatibility(parsed);
      const gen = generateDeployScript(parsed, deployOptsFrom(form));
      return NextResponse.json({
        ok: true,
        fileName: file.name,
        metadata: parsed.metadata,
        counts: parsed.counts,
        objectCount: parsed.objects.length,
        columnCount: parsed.columns.length,
        report,
        preview: {
          statementCount: gen.statements.length,
          script: gen.script,
          skipped: gen.skipped,
        },
      });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 422 });
    }
  }

  // ── deploy: execute the generated DDL on the live dedicated pool ──
  if (action === 'deploy') {
    const state = await getPoolState().catch(() => null);
    if (!state || state.state !== 'Online') {
      return NextResponse.json(
        {
          ok: false,
          state: state?.state || 'Unknown',
          error: `Dedicated SQL pool is ${state?.state || 'not Online'} — resume it on the Warehouse / Dedicated pool editor before importing.`,
        },
        { status: 409 },
      );
    }
    try {
      const parsed = parseDacpacWithBodies(bytes);
      const report = scanCompatibility(parsed);
      const gen = generateDeployScript(parsed, deployOptsFrom(form));
      const result = await deployToSynapse(gen, dedicatedTarget());
      return NextResponse.json({
        ok: result.failed === 0,
        fileName: file.name,
        report,
        deploy: result,
        skipped: gen.skipped,
        pool: process.env.LOOM_SYNAPSE_DEDICATED_POOL,
      });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  return NextResponse.json({ ok: false, error: `Unknown action "${action}" (expected scan | deploy).` }, { status: 400 });
}

function deployOptsFrom(form: FormData): DeployOptions {
  const distribution = form.get('distribution')?.toString();
  const index = form.get('index')?.toString();
  const ifNotExists = form.get('ifNotExists')?.toString() === 'true';
  return {
    distribution:
      distribution === 'HASH' || distribution === 'REPLICATE' || distribution === 'ROUND_ROBIN'
        ? distribution
        : 'ROUND_ROBIN',
    index: index === 'HEAP' ? 'HEAP' : 'CLUSTERED COLUMNSTORE INDEX',
    ifNotExists,
    createSchemas: true,
  };
}
