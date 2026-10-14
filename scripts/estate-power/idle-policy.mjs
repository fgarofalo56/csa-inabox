/**
 * idle-policy.mjs — PURE. Should the scheduled lane pause this estate?
 *
 * UNKNOWN IS NEVER IDLE. Every branch that cannot establish idleness returns
 * `skip` with the reason; the only path to `pause` is every rule satisfied by
 * positive evidence.
 */
import { FIELD, OVERALL_RUNNING } from './contract.mjs';

const ACTIVE_RUN_STATUSES = new Set(['inprogress', 'queued', 'running', 'canceling']);

function ms(v) {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * @param {object} p
 * @param {object} p.state    the console state `data` object
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

  const ap = state[FIELD.autoPause];
  if (!ap || ap[FIELD.autoPauseEnabled] !== true) return skip('autopause-disabled', 'autoPause.enabled is not true');

  if (state[FIELD.overall] !== OVERALL_RUNNING) {
    return skip('not-running', `estate state is ${JSON.stringify(state[FIELD.overall] ?? null)}, not ${OVERALL_RUNNING}`);
  }
  if (state[FIELD.inFlight] !== false) {
    // strict: true means in flight, and a missing field is unknown, which is not "idle"
    return skip('in-flight', state[FIELD.inFlight] === true ? 'a pause/resume is in flight' : 'whether a pause/resume is in flight was not reported');
  }

  const idleHours = Number(ap[FIELD.autoPauseIdleHours]);
  if (!Number.isFinite(idleHours) || idleHours <= 0) return skip('idle-hours-invalid', `autoPause.idleHours is ${JSON.stringify(ap[FIELD.autoPauseIdleHours] ?? null)}, not a positive number`);

  const lastMs = ms(state[FIELD.lastActivityAt]);
  if (lastMs === null) return skip('activity-unknown', 'lastActivityAt is missing or unparseable; unknown is never idle');

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

  const idleMs = nowMs - lastMs;
  if (idleMs < windowMs) {
    const mins = Math.ceil((windowMs - idleMs) / 60000);
    return skip('not-idle-long-enough', `last activity ${new Date(lastMs).toISOString()}; idle ${Math.floor(idleMs / 1000)}s of the required ${windowMs / 1000}s (about ${mins} min to go)`);
  }
  return { decision: 'pause', code: 'idle', reason: `idle ${Math.floor(idleMs / 1000)}s >= ${windowMs / 1000}s (idleHours=${idleHours}), no pipeline run in the window` };
}
