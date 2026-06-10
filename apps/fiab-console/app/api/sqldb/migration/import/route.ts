/**
 * POST /api/sqldb/migration/import
 *   body: { statements: { kind, object, sql, skipped? }[], dryRun?: boolean }
 *
 * SQL DB migration assistant — step 2. Replays the assessment-generated, ordered
 * T-SQL DDL into the env-bound Azure Synapse **Dedicated SQL pool** over the
 * real TDS connection (AAD token, BFF service identity), returning a per-object
 * receipt:
 *   { ok, target, executed, succeeded, skipped, failed, results[] }
 *
 * Each statement runs independently so one incompatible object does not abort
 * the whole import (the receipt records its error). `dryRun: true` validates the
 * gate + echoes the plan without touching the pool.
 *
 * Honest config gate: when LOOM_SYNAPSE_WORKSPACE / LOOM_SYNAPSE_DEDICATED_POOL
 * are unset the route returns 503 with the exact env vars to set — no Fabric
 * dependency. Works with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeQuery, dedicatedTarget } from '@/lib/azure/synapse-sql-client';
import { auditLogContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PlanStatement {
  kind: string;
  object: string;
  sql: string;
  skipped?: boolean;
  reason?: string;
}

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

const SYNAPSE_GATE = {
  code: 'not-configured',
  error: 'Synapse Dedicated SQL pool is not configured for migration import.',
  missing: ['LOOM_SYNAPSE_WORKSPACE', 'LOOM_SYNAPSE_DEDICATED_POOL'],
  hint: {
    bicepModule: 'platform/fiab/bicep/modules/synapse/synapse-pool.bicep',
    followUp:
      'Provision a dedicated SQL pool and set LOOM_SYNAPSE_WORKSPACE + LOOM_SYNAPSE_DEDICATED_POOL on the Console app; the Console UAMI must be the Synapse AAD admin (network.bicep wires the private endpoint + DNS).',
  },
};

async function audit(tenantId: string, who: string, fields: Record<string, unknown>) {
  try {
    const c = await auditLogContainer();
    await c.items
      .create({
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        itemId: 'sqldb-migration',
        tenantId,
        who,
        at: new Date().toISOString(),
        kind: 'sqldb.migration.import',
        ...fields,
      })
      .catch(() => {});
  } catch {
    /* best-effort */
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401);

  const body = await req.json().catch(() => ({}));
  const statements: PlanStatement[] = Array.isArray(body?.statements) ? body.statements : [];
  const dryRun = body?.dryRun === true;
  if (statements.length === 0) {
    return err('statements[] is required (run /api/sqldb/migration/assess first)', 400);
  }

  // Resolve the dedicated-pool target — honest gate when env is unset.
  let target: ReturnType<typeof dedicatedTarget>;
  try {
    target = dedicatedTarget();
  } catch {
    return NextResponse.json({ ok: false, ...SYNAPSE_GATE }, { status: 503 });
  }

  const runnable = statements.filter((s) => !s.skipped && s.sql && !/^\s*--/.test(s.sql));
  const skippedCount = statements.length - runnable.length;

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      target: { server: target.server, database: target.database },
      planned: runnable.length,
      skipped: skippedCount,
    });
  }

  const results: { kind: string; object: string; status: 'ok' | 'error'; error?: string; recordsAffected?: number }[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const s of runnable) {
    try {
      const r = await executeQuery(target, s.sql, 120_000);
      results.push({ kind: s.kind, object: s.object, status: 'ok', recordsAffected: r.recordsAffected });
      succeeded++;
    } catch (e: any) {
      results.push({ kind: s.kind, object: s.object, status: 'error', error: e?.message || String(e) });
      failed++;
    }
  }

  const tenantId = session.claims.oid;
  const who = session.claims.upn || session.claims.email || tenantId;
  await audit(tenantId, who, {
    server: target.server,
    database: target.database,
    executed: runnable.length,
    succeeded,
    failed,
    skipped: skippedCount,
  });

  return NextResponse.json({
    ok: failed === 0,
    target: { server: target.server, database: target.database },
    executed: runnable.length,
    succeeded,
    failed,
    skipped: skippedCount,
    results,
  });
}
