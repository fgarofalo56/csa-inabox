/**
 * contract.mjs — the ONE place the estate-power wire contract and the boundary
 * tables live (#4876 step 3, Actions/CLI lane).
 *
 * ASSUMED CONTRACT. The console lane exports the typed contract at
 * apps/fiab-console/lib/estate/estate-power-contract.ts. That file was not in
 * this lane's base, so every name below is ASSUMED from the lane brief:
 *
 *   POST /api/estate/power   body {action, confirm?, confirmToken?}
 *   envelope                 {ok, data, error}
 *   action                   'preview' | 'pause' | 'resume' | 'state'
 *   data.confirmToken        issued by preview/state, echoed back to pause
 *   data.lastActivityAt      ISO-8601
 *   data.idleForSeconds      number
 *   data.autoPause           {enabled, idleHours}
 *   data.lastPause / data.lastResume  ISO-8601 | null
 *
 * NOT stated in the brief and therefore a GUESS (reconcile first):
 *   data.overall             'RUNNING' | 'PAUSED' | ...   (estate-level state)
 *   data.inFlight            boolean  (a pause/resume is mid-flight)
 *   data.resources[]         {name, type, state}  state = EstatePowerState
 *   data.activityTargets[]   {kind:'adf'|'synapse', id, name}  (what to ask for runs)
 *   data.confirmPhrase       the typed phrase a pause expects
 *
 * Reconciling with the real contract is a ONE-FILE change: edit this file.
 */

export const ACTIONS = Object.freeze(['preview', 'pause', 'resume', 'state']);
export const MUTATING_ACTIONS = Object.freeze(['pause', 'resume']);

export const FIELD = Object.freeze({
  ok: 'ok',
  data: 'data',
  error: 'error',
  confirmToken: 'confirmToken',
  confirmPhrase: 'confirmPhrase',
  lastActivityAt: 'lastActivityAt',
  idleForSeconds: 'idleForSeconds',
  autoPause: 'autoPause',
  autoPauseEnabled: 'enabled',
  autoPauseIdleHours: 'idleHours',
  lastPause: 'lastPause',
  lastResume: 'lastResume',
  overall: 'overall',
  inFlight: 'inFlight',
  resources: 'resources',
  resourceName: 'name',
  resourceType: 'type',
  resourceState: 'state',
  activityTargets: 'activityTargets',
});

export const ENDPOINT_PATH = '/api/estate/power';
export const ROLE_CLAIM = 'Estate.Power';

/** Assumed estate-level state names. */
export const OVERALL_RUNNING = 'RUNNING';

/** Per-resource states that count as "read back paused" / "read back running". */
export const PAUSED_STATES = Object.freeze(['Paused', 'Stopped', 'Deallocated']);
export const RUNNING_STATES = Object.freeze(['Online']);

/** Fallback typed phrase when the server does not hand one back. ASSUMED. */
export const DEFAULT_PAUSE_CONFIRM = 'PAUSE';

/**
 * Boundary table. Sovereign authority + ARM + Synapse dev suffixes are the only
 * cloud-specific literals in this tree; console URL and audience are inputs,
 * never defaults.
 */
export const BOUNDARIES = Object.freeze({
  Commercial: Object.freeze({
    azEnvironment: 'AzureCloud',
    authority: 'https://login.microsoftonline.com',
    arm: 'https://management.azure.com',
    synapseDev: 'dev.azuresynapse.net',
  }),
  'GCC-High': Object.freeze({
    azEnvironment: 'AzureUSGovernment',
    authority: 'https://login.microsoftonline.us',
    arm: 'https://management.usgovcloudapi.net',
    synapseDev: 'dev.azuresynapse.usgovcloudapi.net',
  }),
});

export function boundaryInfo(name) {
  return Object.prototype.hasOwnProperty.call(BOUNDARIES, name) ? BOUNDARIES[name] : null;
}

/**
 * PURE. Is the active az cloud the one this boundary is? Unknown is a refusal.
 * @param {string} boundary
 * @param {string|null|undefined} environmentName from `az account show`
 */
export function classifyCloud(boundary, environmentName) {
  const info = boundaryInfo(boundary);
  if (!info) return { ok: false, reason: `unknown boundary '${boundary}' (expected ${Object.keys(BOUNDARIES).join(' or ')})` };
  if (typeof environmentName !== 'string' || environmentName.trim() === '') {
    return { ok: false, reason: `the active az cloud could not be read (az account show gave no environmentName); that is UNKNOWN, not ${info.azEnvironment}` };
  }
  if (environmentName.trim() !== info.azEnvironment) {
    return {
      ok: false,
      reason: `boundary ${boundary} requires az cloud ${info.azEnvironment} but the active az cloud is ${environmentName.trim()}`,
    };
  }
  return { ok: true, reason: null };
}

/** PURE. Pull the typed envelope apart; never throws. */
export function parseEnvelope(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, data: null, error: 'response was not a JSON object' };
  }
  if (body[FIELD.ok] !== true) {
    const e = body[FIELD.error];
    const msg = typeof e === 'string' ? e : e && typeof e === 'object' && typeof e.message === 'string' ? e.message : 'the console reported ok=false without an error message';
    return { ok: false, data: null, error: msg };
  }
  const data = body[FIELD.data];
  if (!data || typeof data !== 'object') return { ok: false, data: null, error: 'ok=true but no data object' };
  return { ok: true, data, error: null };
}

/** PURE. Resources array or null when absent/malformed. */
export function resourcesOf(data) {
  const r = data?.[FIELD.resources];
  if (!Array.isArray(r)) return null;
  return r.map((x) => ({
    name: String(x?.[FIELD.resourceName] ?? '<unnamed>'),
    type: String(x?.[FIELD.resourceType] ?? '<untyped>'),
    state: String(x?.[FIELD.resourceState] ?? 'Unknown'),
  }));
}
