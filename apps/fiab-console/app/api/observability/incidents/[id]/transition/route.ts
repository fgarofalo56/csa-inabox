/**
 * POST /api/observability/incidents/[id]/transition — N17 incident lifecycle.
 *
 * Body: { action: 'acknowledge' | 'resolve' | 'reopen' | 'note', note?: string }.
 * Runs the PURE state machine (transitionIncident); a legal transition appends a
 * timeline entry, AUDITS (emit-first), and persists. An illegal transition
 * returns 409 with the state-machine's precise reason (no write). Every state
 * change is audited (task binding). withTenantAdmin. FLAG0 gated.
 */
import { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiNotFound } from '@/lib/api/respond';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { transitionIncidentStatus } from '@/lib/observability/incident-store';
import { N17_FLAG_ID } from '@/lib/observability/incident-model';
import type { IncidentAction } from '@/lib/observability/incident-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_ACTIONS = new Set<IncidentAction>(['acknowledge', 'resolve', 'reopen', 'note']);

export const POST = withTenantAdmin<{ id: string }>(async (req: NextRequest, { session, params }) => {
  if (!(await runtimeFlag(N17_FLAG_ID, { default: true }))) {
    return apiError('the incident console is turned off (n17-incident-console)', 409, { code: 'flag_off' });
  }
  const id = params.id;
  if (!id) return apiNotFound();

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return apiError('invalid JSON body', 400, { code: 'bad_json' });
  }
  const action = String(body.action || '') as IncidentAction;
  if (!VALID_ACTIONS.has(action)) return apiError('action must be acknowledge | resolve | reopen | note', 400, { code: 'bad_action' });
  const note = typeof body.note === 'string' ? body.note : undefined;
  if (action === 'note' && !note?.trim()) return apiError('a note action requires a non-empty note', 400, { code: 'empty_note' });

  const actor = { oid: session.claims.oid, who: session.claims.upn || session.claims.oid, tenantId: session.claims.oid };
  const outcome = await transitionIncidentStatus(session.claims.oid, id, action, actor, note);
  if (!outcome.ok) {
    if (outcome.status === 404) return apiNotFound();
    return apiError(outcome.error || 'transition failed', outcome.status || 409, { code: 'illegal_transition' });
  }
  return apiOk({ incident: outcome.incident });
});
