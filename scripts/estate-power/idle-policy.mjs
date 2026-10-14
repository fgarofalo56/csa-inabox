/**
 * idle-policy.mjs — PURE. Should the scheduled lane pause this estate?
 *
 * Encodes the console contract's caller rules (estate-power-contract.ts, "RULES
 * FOR THE CALLER"): pause only when autoPause.enabled === true, autoPause.source
 * !== 'unreadable', activity.lastActivityAt !== null and
 * activity.idleForSeconds >= idleHours * 3600. UNKNOWN IS NEVER IDLE: every branch
 * that cannot establish idleness returns `skip` with the reason.
 */
import { FIELD, ESTATE_STATE, IN_FLIGHT_STATES, AUTOPAUSE_SOURCE_UNREADABLE } from './contract.mjs';

const ACTIVE_RUN_STATUSES = new Set(['inprogress', 'queued', 'running', 'canceling']);

function ms(v) {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * @param {object} p
 * @param {object} p.state    the console state body (top-level fields)
 * @param {{ok:boolean, reason?:string, runs?:Array<{startedAt:string|null,status?:string}>}} p.activity
 * @param {Date|number} p.now
 * @param {{declared:boolean, reason?:string}} [p.declared]  classifyPauseDeclaration result
 * @returns {{decision:'pause'|'skip', code:string, reason:string}}
 */
export function decideIdlePause({ state, activity, now, declared }) {
  const skip = (code, reason) => ({ decision: 'skip', code, reason });
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) return skip('now-invalid', 'the clock reading was not a number, so idleness cannot be computed');
  if (!state || typeof state !== 'object') return skip('state-missing', 'no estate state was read');

  if (declared?.declared === true) return skip('declared-paused', 'the boundary is declared paused in the pause register; nothing to do');

  const power = state[FIELD.power];
  const ap = power?.[FIELD.autoPause];
  if (!ap || ap[FIELD.autoPauseEnabled] !== true) return skip('autopause-disabled', 'power.autoPause.enabled is not true');
  if (ap[FIELD.autoPauseSource] === AUTOPAUSE_SOURCE_UNREADABLE) {
    return skip('autopause-unreadable', 'power.autoPause.source is unreadable: the setting read failed, its values must not be acted on');
  }

  const st = state[FIELD.state];
  if (IN_FLIGHT_STATES.includes(st)) return skip('in-flight', `estate state is ${st}: a pause/resume is in flight`);
  if (st !== ESTATE_STATE.running) return skip('not-running', `estate state is ${JSON.stringify(st ?? null)}, not ${ESTATE_STATE.running}`);

  const idleHours = Number(ap[FIELD.autoPauseIdleHours]);
  if (!Number.isFinite(idleHours) || idleHours <= 0) return skip('idle-hours-invalid', `autoPause.idleHours is ${JSON.stringify(ap[FIELD.autoPauseIdleHours] ?? null)}, not a positive number`);

  const act = power?.[FIELD.activity];
  if (!act || act[FIELD.activityUnreadable] === true) return skip('activity-unknown', 'power.activity is missing or flagged unreadable; unknown is never idle');
  const lastMs = ms(act[FIELD.lastActivityAt]);
  if (lastMs === null) return skip('activity-unknown', 'lastActivityAt is null or unparseable (null means no activity recorded, NOT idle forever); unknown is never idle');
  const serverIdle = act[FIELD.idleForSeconds];
  if (typeof serverIdle !== 'number' || !Number.isFinite(serverIdle)) return skip('activity-unknown', 'idleForSeconds is not a number although lastActivityAt is set');

  if (!activity || activity.ok !== true || !Array.isArray(activity.runs)) {
    return skip('activity-read-failed', `pipeline activity could not be read (${activity?.reason ?? 'no reason reported'}); not pausing on an unestablished answer`);
  }

  const windowMs = idleHours * 3600 * 1000;
  const windowStart = nowMs - windowMs;
  for (const r of activity.runs) {
    const started = ms(r?.startedAt);
    const live = ACTIVE_RUN_STATUSES.has(String(r?.status ?? '').toLowerCase());
    if (live || started === null || started >= windowStart) {
      return skip('recent-pipeline-run', `a pipeline run is active or started within the last ${idleHours}h (startedAt=${r?.startedAt ?? 'unparseable'}, status=${r?.status ?? 'n/a'})`);
    }
  }

  // Both clocks must agree: the console's own idleForSeconds AND ours from lastActivityAt.
  const idleMs = Math.min(nowMs - lastMs, serverIdle * 1000);
  if (idleMs < windowMs) {
    return skip('not-idle-long-enough', `last activity ${new Date(lastMs).toISOString()}; idle ${Math.floor(idleMs / 1000)}s of the required ${windowMs / 1000}s`);
  }
  return { decision: 'pause', code: 'idle', reason: `idle ${Math.floor(idleMs / 1000)}s >= ${windowMs / 1000}s (idleHours=${idleHours}), no pipeline run in the window` };
}
