/**
 * GET /api/estate/paused - is any part of the estate paused? (operator decision
 * 2026-10-22: the console shows a banner when services are paused.)
 *
 * Any signed-in user may read it (the banner sits in the shared shell and tells
 * everyone why a service may be slow to wake), so this is `withSession`, not
 * `withTenantAdmin`. It exposes service NAMES and the time of the pause, never
 * resource ids, and the identity of whoever paused only to tenant admins.
 *
 * It reads the pause snapshot only (one Cosmos point read, the document the
 * admin estate power panel reads); it makes no ARM call. It is listed in
 * `estate-activity.ts` NOT_ACTIVITY_PREFIXES: a banner that polls on every page
 * must not count as a person using the console, or it would pin the estate awake.
 *
 * `canResume` mirrors the resume route's own gate (`withTenantAdmin`) so the UI
 * never offers a button the server will refuse.
 */
import type { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk, apiHonestError } from '@/lib/api/respond';
import { sessionMayResumeEstate } from '@/lib/estate/estate-resume-access';
import { tenantScopeId } from '@/lib/auth/session';
import { loadPauseSnapshot } from '@/lib/estate/pause-orchestrator';
import { summarizePausedSnapshot } from '@/lib/estate/estate-paused-banner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (_req: NextRequest, { session }) => {
  const isAdmin = sessionMayResumeEstate(session);
  let snapshot;
  try {
    snapshot = await loadPauseSnapshot(tenantScopeId(session));
  } catch (e) {
    // Not "nothing is paused": the snapshot could not be read. The banner treats a
    // failure as unknown and stays hidden rather than asserting either way.
    return apiHonestError(e, 503, 'The estate pause record could not be read, so whether services are paused is unknown.');
  }
  return apiOk({ ...summarizePausedSnapshot(snapshot, { isAdmin }), canResume: isAdmin });
});
