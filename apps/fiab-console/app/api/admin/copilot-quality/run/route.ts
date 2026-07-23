/**
 * POST /api/admin/copilot-quality/run (E5 — "Run now")
 *
 * Proxies the admin "Run now" action to the copilot-evaluator Function's E2 HTTP
 * trigger (POST {LOOM_COPILOT_EVALUATOR_URL}/api/copilotEvaluatorHttp), which
 * runs the golden eval sets against the REAL retrieval + AOAI path and writes
 * scored `eval-run`/`eval-result` docs to Cosmos. Body: { surfaces?: string[] }.
 *
 * Auth to the Function: the host key (authLevel 'function' on the trigger) via
 * LOOM_COPILOT_EVALUATOR_KEY (bicep-wired secretRef from the module's
 * functionKey output — same pattern as LOOM_POSTURE_FUNCTION_KEY /
 * LOOM_SCC_LABELS_KEY). When the key is absent the call is still attempted (a
 * VNet-internal / Entra-fronted deployment may not need it); a 401 then surfaces
 * honestly rather than silently.
 *
 * Tenant-admin scoped. When LOOM_COPILOT_EVALUATOR_URL is unset the route
 * returns an HONEST 503 gate naming the svc-copilot-evaluator remediation (the
 * page renders the shared HonestGate + Fix-it) — never a fabricated success.
 * The manual trigger is written to the audit log (best-effort).
 */
import { apiError, apiOk, apiServerError } from '@/lib/api/respond';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import type { SessionPayload } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Known surfaces are validated loosely (the Function is the authority) —
 *  reject non-string / oversized input so we never forward junk. */
function sanitizeSurfaces(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out = input
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter((s) => s.length > 0 && s.length <= 64 && /^[a-z0-9-]+$/i.test(s))
    .slice(0, 20);
  return out.length ? out : undefined;
}

async function auditRun(session: SessionPayload, surfaces: string[] | undefined, ok: boolean, status: number): Promise<void> {
  const now = new Date().toISOString();
  try {
    const audit = await auditLogContainer();
    await audit.items
      .create({
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        itemId: 'copilot-quality:run',
        tenantId: session.claims.tid || session.claims.oid,
        who: session.claims.upn || session.claims.email || session.claims.name,
        actorOid: session.claims.oid,
        at: now,
        kind: 'copilot-quality.run',
        target: (surfaces && surfaces.join(',')) || 'all',
        detail: { surfaces: surfaces ?? 'all', ok, status },
      })
      .catch(() => undefined);
  } catch { /* audit failures never block */ }
  emitAuditEvent({
    actorOid: session.claims.oid,
    actorUpn: session.claims.upn || session.claims.email || session.claims.name,
    action: 'copilot-quality.run',
    targetType: 'copilot-quality',
    targetId: (surfaces && surfaces.join(',')) || 'all',
    tenantId: session.claims.tid || session.claims.oid,
    detail: { surfaces: surfaces ?? 'all', ok, status },
  });
}

export const POST = withTenantAdmin(async (req, { session }) => {
  const base = (process.env.LOOM_COPILOT_EVALUATOR_URL || '').trim().replace(/\/+$/, '');
  if (!base) {
    return apiError('not_configured', 503, {
      gated: true,
      gate: {
        id: 'svc-copilot-evaluator',
        title: 'Copilot quality evaluator',
        missing: ['LOOM_COPILOT_EVALUATOR_URL'],
      },
      remediation:
        'The copilot-evaluator Function is not wired in this deployment. Deploy modules/admin-plane/copilot-evaluator-function.bicep (default-ON) so LOOM_COPILOT_EVALUATOR_URL is set, then Run now can trigger a live evaluation.',
    });
  }

  let body: unknown = {};
  try { body = await req.json(); } catch { /* empty body = run every surface */ }
  const surfaces = sanitizeSurfaces((body as { surfaces?: unknown })?.surfaces);

  const key = (process.env.LOOM_COPILOT_EVALUATOR_KEY || '').trim();
  const url = `${base}/api/copilotEvaluatorHttp${key ? `?code=${encodeURIComponent(key)}` : ''}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers['x-functions-key'] = key;

  try {
    // The Function runs the eval synchronously (retrieval + judge per Q) — allow
    // a generous budget; the client shows a spinner + polls the summary after.
    const res = await fetchWithTimeout(
      url,
      { method: 'POST', headers, body: JSON.stringify({ surfaces, trigger: 'manual' }) },
      120_000,
    );
    const text = (await res.text()).slice(0, 8 * 1024);
    let payload: unknown = text;
    try { payload = JSON.parse(text); } catch { /* non-JSON body → raw text */ }

    await auditRun(session, surfaces, res.ok, res.status);

    if (!res.ok) {
      return apiError(`evaluator returned ${res.status}`, res.status === 409 ? 409 : 502, {
        detail: typeof payload === 'object' ? payload : String(payload).slice(0, 300),
      });
    }
    return apiOk({ triggered: true, surfaces: surfaces ?? 'all', result: payload });
  } catch (e) {
    await auditRun(session, surfaces, false, 0);
    return apiServerError(e);
  }
});
