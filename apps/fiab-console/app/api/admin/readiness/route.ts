/**
 * GET /api/admin/readiness — the capability dependency graph (H1) + workload
 * readiness scorecard (H2) in ONE call.
 *
 * Real data only (no-vaporware.md):
 *   - capability state comes from the REAL gate registry (lib/gates/registry —
 *     allGateStatuses(), the exact env-presence checks the per-client
 *     *ConfigGate() helpers gate on), and
 *   - live verification comes from the REAL self-audit probes (lib/admin/
 *     health-probes.ts — each a read-only call against the actual Azure backend
 *     as the Console UAMI). A capability with no live probe is honestly marked
 *     verified:'config-only', never a fabricated live green.
 *
 * The self-audit run is best-effort: if it throws/times out we still return the
 * gate-derived graph (probes empty), so the surface degrades honestly instead
 * of erroring. Admin-scoped to the same capability as the gate registry.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { GATES, allGateStatuses } from '@/lib/gates/registry';
import { buildReadiness, GATE_PROBE_MAP, type ProbeLite } from '@/lib/admin/readiness';
import { detectLoomCloud } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Pull the live probe results the readiness graph consumes from a self-audit
 *  run — narrowed to the probe ids the gate→probe map references. Best-effort. */
async function collectProbes(): Promise<{ probes: ProbeLite[]; probeError?: string }> {
  const wanted = new Set(Object.values(GATE_PROBE_MAP));
  try {
    const { runSelfAudit } = await import('@/lib/admin/self-audit');
    const report = await runSelfAudit(new Date().toISOString());
    const probes: ProbeLite[] = report.results
      .filter((r) => wanted.has(r.id))
      .map((r) => ({ id: r.id, status: r.status, detail: r.detail, remediation: r.remediation }));
    return { probes };
  } catch (e: any) {
    return { probes: [], probeError: e?.message || String(e) };
  }
}

export async function GET() {
  const session = getSession();
  const gate = await enforceCapability(session, 'admin.env-config', 'Admin');
  if (gate) return gate;

  const statuses = allGateStatuses();
  const { probes, probeError } = await collectProbes();
  const report = buildReadiness(
    { gates: GATES, statuses, probes },
    { generatedAt: new Date().toISOString(), cloud: detectLoomCloud() },
  );

  return NextResponse.json({
    ok: true,
    ...report,
    probed: probes.length,
    probeError,
  });
}
