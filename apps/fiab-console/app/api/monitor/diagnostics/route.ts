/**
 * Monitor → Diagnostics coverage. Audits whether EVERY Loom Azure resource has
 * a diagnostic setting routing its logs + metrics to the Loom Log Analytics
 * workspace, and lets an admin turn it on for any that's missing — covering
 * runtime-created resources and config drift on top of the deploy-time bicep
 * (modules/shared/diagnostic-settings.bicep).
 *
 *   GET  /api/monitor/diagnostics            → { ok, data: { law, items: DiagCoverage[], summary } }
 *   POST /api/monitor/diagnostics
 *     body { resourceId }                     → enable on one resource
 *     body { all: true }                      → enable on every supported+missing resource
 *                                             → { ok, data: { enabled: [...], failed: [...] } }
 *
 * Honest gate: when LOOM_LOG_ANALYTICS_RESOURCE_ID / LOOM_SUBSCRIPTION_ID are
 * unset, returns { ok:false, gate } so the pane shows a precise MessageBar.
 * Real ARM REST only — no mocks (see .claude/rules/no-vaporware.md).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getDiagnosticsCoverage, enableDiagnostics, logAnalyticsResourceId,
  MonitorNotConfiguredError, MonitorError,
} from '@/lib/azure/monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gateOrError(e: unknown) {
  if (e instanceof MonitorNotConfiguredError) {
    return NextResponse.json({ ok: false, gate: { missing: e.missing, message: e.message } });
  }
  const status = e instanceof MonitorError ? e.status : 500;
  return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const items = await getDiagnosticsCoverage();
    const supported = items.filter((i) => i.supported);
    const summary = {
      total: items.length,
      supported: supported.length,
      covered: supported.filter((i) => i.routesToLoomLaw).length,
      missing: supported.filter((i) => !i.routesToLoomLaw).length,
      unsupported: items.length - supported.length,
    };
    return NextResponse.json({ ok: true, data: { law: logAnalyticsResourceId(), items, summary } });
  } catch (e) { return gateOrError(e); }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }

  try {
    if (body?.all === true) {
      const items = await getDiagnosticsCoverage();
      const targets = items.filter((i) => i.supported && !i.routesToLoomLaw);
      const enabled: Array<{ id: string; name: string; mode: string }> = [];
      const failed: Array<{ id: string; name: string; error: string }> = [];
      // Sequential to be gentle on ARM write limits; the set is small.
      for (const t of targets) {
        try {
          const r = await enableDiagnostics(t.id);
          enabled.push({ id: t.id, name: t.name, mode: r.mode });
        } catch (e) {
          failed.push({ id: t.id, name: t.name, error: (e as Error).message });
        }
      }
      return NextResponse.json({ ok: true, data: { enabled, failed, attempted: targets.length } });
    }

    const resourceId = typeof body?.resourceId === 'string' ? body.resourceId.trim() : '';
    if (!resourceId) {
      return NextResponse.json({ ok: false, error: 'resourceId or all:true required' }, { status: 400 });
    }
    const r = await enableDiagnostics(resourceId);
    return NextResponse.json({ ok: true, data: { resourceId, ...r } });
  } catch (e) { return gateOrError(e); }
}
