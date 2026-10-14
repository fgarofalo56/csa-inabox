/**
 * GET/PUT /api/admin/estate/autopause — the idle auto-pause setting
 * (PRP-02 step 3, #4876). `{ enabled: boolean, idleHours: number }`, idleHours in
 * [1, 168], default enabled / 2h (operator decision: armed by default). Stored in
 * Cosmos (`estate-autopause:current`, see lib/estate/estate-autopause.ts).
 *
 * This is only the knob the auto-pause lane reads. Saving it does not pause
 * anything, and the pause path itself stays behind LOOM_ESTATE_PAUSE_ENABLED, the
 * typed confirm and the drift token.
 *
 * Authorization is `withTenantAdmin` (interactive cookie session), the wrapper,
 * never an inline check. Every PUT writes a Cosmos audit row and a SIEM event
 * with the before and after values.
 */
import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiHonestError } from '@/lib/api/respond';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { callerFromSession } from '@/lib/estate/estate-caller';
import { audit } from '@/lib/estate/estate-power-handlers';
import { loadAutoPause, saveAutoPause, validateAutoPause } from '@/lib/estate/estate-autopause';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withTenantAdmin(async (_req: NextRequest, { session }) => {
  const caller = callerFromSession(session);
  return apiOk({ autoPause: await loadAutoPause(caller.tenantId) });
});

export const PUT = withTenantAdmin(async (req: NextRequest, { session }) => {
  const caller = callerFromSession(session);
  const body = await req.json().catch(() => null);
  const v = validateAutoPause(body);
  if (!v.ok) return apiError(v.error, 400);

  const before = await loadAutoPause(caller.tenantId);
  let saved;
  try {
    saved = await saveAutoPause(caller.tenantId, v.value, caller.who);
  } catch (e) {
    return apiHonestError(
      e,
      503,
      'The auto-pause setting could not be saved: the settings store (Cosmos maintenance-jobs) '
        + 'did not accept the write. Nothing was changed.',
    );
  }
  const change = {
    before: { enabled: before.enabled, idleHours: before.idleHours, source: before.source },
    after: { enabled: saved.enabled, idleHours: saved.idleHours },
  };
  await audit(caller, 'estate-autopause.updated', change);
  emitAuditEvent({
    actorOid: caller.actorOid,
    actorUpn: caller.who,
    action: 'platform.estate-autopause',
    targetType: 'loom-estate',
    targetId: 'autopause',
    tenantId: caller.actorTid || caller.tenantId,
    outcome: 'success',
    detail: change,
  });
  return apiOk({ autoPause: saved });
});
