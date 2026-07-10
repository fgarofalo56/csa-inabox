/**
 * Spark-telemetry reconciler BFF (tenant-admin).
 *
 *   GET  /api/admin/spark-telemetry/audit
 *     → audits diagnostic-settings coverage across every Spark engine (Synapse
 *       Spark, Databricks, Azure ML), persists the run, and returns the report
 *       + the last apply outcome.
 *   POST /api/admin/spark-telemetry/audit   body: { ids?: string[] }
 *     → applies the standardized Loom diagnostic setting to the Spark resources
 *       missing it (all missing when `ids` omitted), persists, returns the
 *       apply report + a fresh audit. Default-ON, no approval gate.
 *
 * Honest gate (no-vaporware): returns { ok:false, gate:{missing,message} }
 * (HTTP 200) when LOOM_LOG_ANALYTICS_RESOURCE_ID is unset so the card renders a
 * MessageBar. The Console UAMI needs Monitoring Reader to audit and Monitoring
 * Contributor to apply.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession, tenantScopeId } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import {
  auditSparkTelemetry, applySparkTelemetry, saveLastRun, readLastRun,
  MonitorNotConfiguredError, MonitorError,
} from '@/lib/azure/spark-telemetry-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GATE_MESSAGE =
  'The Spark-telemetry reconciler audits diagnostic-settings coverage across every '
  + 'Spark engine (Synapse Spark, Databricks, Azure ML) and routes each to the Loom Log '
  + 'Analytics workspace. Set LOOM_LOG_ANALYTICS_RESOURCE_ID (the ARM resource id of '
  + 'law-csa-loom-<region>) on the Console app, and grant the Console UAMI Monitoring '
  + 'Contributor on the Loom subscription so it can enable the missing settings.';

function gateResponse(e: MonitorNotConfiguredError) {
  return NextResponse.json({ ok: false, gate: { missing: e.missing, message: GATE_MESSAGE } });
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = requireTenantAdmin(s);
  if (gate) return gate;

  try {
    const audit = await auditSparkTelemetry();
    const tenantId = tenantScopeId(s);
    const prior = await readLastRun(tenantId);
    // Persist this run (best-effort — a Cosmos hiccup never fails the read).
    saveLastRun(tenantId, audit, prior?.lastApply, s.claims.upn || s.claims.email).catch(() => {});
    return NextResponse.json({ ok: true, audit, lastApply: prior?.lastApply, lastRunAt: prior?.updatedAt });
  } catch (e) {
    if (e instanceof MonitorNotConfiguredError) return gateResponse(e);
    const st = e instanceof MonitorError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: st });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = requireTenantAdmin(s);
  if (gate) return gate;

  let ids: string[] | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    if (Array.isArray(body?.ids)) ids = body.ids.filter((x: unknown) => typeof x === 'string');
  } catch { /* empty body → remediate all missing */ }

  try {
    const lastApply = await applySparkTelemetry(ids);
    const audit = await auditSparkTelemetry();
    const tenantId = tenantScopeId(s);
    saveLastRun(tenantId, audit, lastApply, s.claims.upn || s.claims.email).catch(() => {});
    return NextResponse.json({ ok: true, audit, lastApply });
  } catch (e) {
    if (e instanceof MonitorNotConfiguredError) return gateResponse(e);
    const st = e instanceof MonitorError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: st });
  }
}
