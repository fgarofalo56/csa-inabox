/**
 * E5 — POST /api/admin/copilot-quality/run
 *
 * "Run now": start an execution of the in-VNet `loom-copilot-evaluator`
 * Container App Job for the requested surfaces (or all). Tenant-admin only.
 * Every trigger writes an `_auditLog` row (privileged admin action → ATO
 * evidence, per the loom-next audit standard). Honest-gate (no-vaporware): when
 * LOOM_COPILOT_EVALUATOR_JOB_ID is unset the route returns the
 * svc-copilot-evaluator gate with Fix-it, never a fake "started"; an ARM
 * failure (job not deployed, missing Contributor grant) degrades to an honest
 * error, not a 500. B-FN (2026-07-27) replaced the Y1 Function + host key with
 * this ARM job-start — Y1 is structurally broken on this estate.
 *
 * Body: { surfaces?: string[] }
 */
import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { tenantScopeId } from '@/lib/auth/session';
import { evaluatorRunGate, triggerEvaluatorRun } from '@/lib/azure/copilot-evaluator-client';

export const dynamic = 'force-dynamic';

async function writeAudit(entry: {
  tenantId: string; who: string; oid: string; surfaces: string[]; outcome: string; detail: unknown;
}): Promise<void> {
  try {
    const audit = await auditLogContainer();
    await audit.items.create({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      itemId: `copilot-quality:${entry.tenantId}`,
      tenantId: entry.tenantId,
      who: entry.who,
      actorOid: entry.oid,
      at: new Date().toISOString(),
      kind: 'copilot.eval-run-trigger',
      target: entry.surfaces.length ? entry.surfaces.join(',') : 'all',
      outcome: entry.outcome,
      detail: entry.detail,
    }).catch(() => undefined);
  } catch { /* audit failures are non-blocking */ }
}

export const POST = withTenantAdmin(async (req: NextRequest, { session }) => {
  try {
    let body: { surfaces?: unknown; mode?: unknown; domains?: unknown } = {};
    try { body = (await req.json()) as typeof body; } catch { /* empty = run all */ }
    const mode: 'copilot' | 'search' | 'tier' =
      body.mode === 'search' ? 'search' : body.mode === 'tier' ? 'tier' : 'copilot';
    const surfaces = Array.isArray(body.surfaces)
      ? body.surfaces.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const domains = Array.isArray(body.domains)
      ? body.domains.map((s) => String(s).trim()).filter(Boolean)
      : [];

    const tenantId = tenantScopeId(session);
    const who = session.claims.upn || session.claims.email || session.claims.name || session.claims.oid;
    const oid = session.claims.oid;

    const auditSurfaces = mode === 'search' ? domains : mode === 'tier' ? ['tier:router'] : surfaces;

    // Honest gate — job id not wired. Surface the registry gate + Fix-it.
    const gate = evaluatorRunGate();
    if (gate) {
      await writeAudit({ tenantId, who, oid, surfaces: auditSurfaces, outcome: 'gated', detail: { mode, missing: gate.missing } });
      return apiError('Copilot evaluator job is not configured in this deployment.', 503, {
        gated: true,
        gate: { id: gate.gateId, title: 'Copilot quality evaluator', remediation: gate.remediation, missing: gate.missing },
      });
    }

    const result = await triggerEvaluatorRun(
      mode === 'search'
        ? { mode, domains, trigger: 'manual' }
        : mode === 'tier'
          ? { mode, trigger: 'manual' }
          : { surfaces, trigger: 'manual' },
    );
    await writeAudit({
      tenantId, who, oid, surfaces: auditSurfaces,
      outcome: result.ok ? 'started' : 'failed',
      detail: { mode, status: result.status, error: result.error, body: result.body },
    });

    if (!result.ok) {
      return apiError(
        result.error || `The evaluator job did not accept the run (HTTP ${result.status}).`,
        502,
        { jobStatus: result.status, jobBody: result.body },
      );
    }
    return apiOk({
      started: true,
      surfaces: surfaces.length ? surfaces : 'all',
      // The run continues server-side; the page re-reads Cosmos on refresh.
      note: 'Run accepted — scores appear here once the Function finishes writing to Cosmos (refresh in a minute).',
      functionResponse: result.body,
    });
  } catch (e) {
    return apiServerError(e, 'failed to trigger evaluator run', 'copilot_quality_run_failed');
  }
});
