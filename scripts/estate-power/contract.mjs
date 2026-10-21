/**
 * contract.mjs — the ONE place the estate-power wire contract and the boundary
 * tables live (#4876 step 3, Actions/CLI lane).
 *
 * RECONCILED against the console lane (PR #4979, branch feat/4876-step3-console).
 * Every name below quotes its source as <file>:<symbol>; paths are under
 * apps/fiab-console/. A field the real contract does not have is NOT here.
 *
 *   lib/estate/estate-power-contract.ts   (ESTATE_POWER_*, EstatePowerStatus)
 *   lib/estate/estate-power-handlers.ts   (response bodies)
 *   lib/api/respond.ts                    (envelope: apiOk / apiError)
 *   lib/estate/pause-state.ts, pause-orchestrator.ts (state enum, progress rows)
 */

/** estate-power-contract.ts: ESTATE_POWER_ACTIONS = ['preview','pause','resume','state'] */
export const ACTIONS = Object.freeze(['preview', 'pause', 'resume', 'state']);
export const MUTATING_ACTIONS = Object.freeze(['pause', 'resume']);

/** estate-power-contract.ts: ESTATE_POWER_ROLE = 'Estate.Power' */
export const ROLE_CLAIM = 'Estate.Power';
/** route.ts: app/api/estate/power/route.ts (POST body {action, confirm?, confirmToken?}) */
export const ENDPOINT_PATH = '/api/estate/power';

/**
 * pause-state.ts: EstatePauseState = RUNNING | PAUSING | PAUSED | RESUMING | RESUME_FAILED.
 * Top-level `state` of every state/preview/pause/resume body (handlers: `state: poll.state`).
 */
export const ESTATE_STATE = Object.freeze({
  running: 'RUNNING', pausing: 'PAUSING', paused: 'PAUSED', resuming: 'RESUMING', resumeFailed: 'RESUME_FAILED',
});
export const IN_FLIGHT_STATES = Object.freeze([ESTATE_STATE.pausing, ESTATE_STATE.resuming]);

/**
 * Field names. Source per line.
 * Envelope (respond.ts): success {ok:true, ...fields} -- fields are TOP LEVEL, there is no `data`;
 * failure {ok:false, error: string, ...extra}.
 */
export const FIELD = Object.freeze({
  ok: 'ok', // respond.ts apiOk/apiError
  error: 'error', // respond.ts apiError(error: string, ...)
  state: 'state', // handlers: runningPayload `state: 'RUNNING'`, handleStateRead `state: poll.state`
  estateId: 'estateId', // handlers: `estateId: manifest.estateId`; pause confirm must equal it (handlePausePost)
  confirmToken: 'confirmToken', // handlers dryRun body `confirmToken: token`; runningPayload `confirmToken`
  preview: 'preview', // handlers: `preview: plan.dryRun` (DryRunResult, pause-inventory.ts)
  wouldPause: 'wouldPause', // DryRunResult.wouldPause: DryRunRow[]
  wouldLeaveRunning: 'wouldLeaveRunning', // DryRunResult.wouldLeaveRunning
  rowResourceId: 'resourceId', // DryRunRow / PausedResourceSnapshot / ResourceProgress
  rowName: 'name',
  rowType: 'resourceType',
  rowMechanism: 'mechanism', // DryRunRow.mechanism
  resources: 'resources', // handleStateRead (PAUSING/PAUSED/RESUMING/RESUME_FAILED): snapshot.resources
  progress: 'progress', // pause-orchestrator.ts: PausePollResult.progress / ResourceProgress[]
  progressPowerState: 'powerState', // ResourceProgress.powerState (EstatePowerState)
  progressAtExpected: 'atExpectedState', // ResourceProgress.atExpectedState
  progressExpectation: 'expectation', // ResourceProgress.expectation 'running'|'stopped'
  progressPhase: 'phase', // ResourceProgress.phase
  progressDetail: 'detail', // ResourceProgress.detail
  drifted: 'drifted', // handleStateRead PAUSING/PAUSED body
  driftedResources: 'driftedResources', // ditto
  reason: 'reason', // ditto
  outcomes: 'outcomes', // handleStateRead RESUMING/RESUME_FAILED body: ResumeOutcome[]
  outcomeResourceId: 'resourceId', // pause-state.ts ResumeOutcome.resourceId
  outcomeConfirmation: 'confirmation', // ResumeOutcome.confirmation
  outcomeReason: 'reason', // ResumeOutcome.reason
  power: 'power', // handlers: `power` on every state/preview body (EstatePowerStatus)
  activity: 'activity', // EstatePowerStatus.activity
  lastActivityAt: 'lastActivityAt', // EstateActivityStatus.lastActivityAt: string|null
  idleForSeconds: 'idleForSeconds', // EstateActivityStatus.idleForSeconds: number|null
  activityUnreadable: 'unreadable', // EstateActivityStatus.unreadable: boolean
  autoPause: 'autoPause', // EstatePowerStatus.autoPause
  autoPauseEnabled: 'enabled', // EstateAutoPauseSetting.enabled
  autoPauseIdleHours: 'idleHours', // EstateAutoPauseSetting.idleHours
  autoPauseSource: 'source', // EstateAutoPauseSetting.source 'stored'|'default'|'unreadable'
  lastPausedAt: 'lastPausedAt', // EstatePowerStatus.lastPausedAt
  lastResumedAt: 'lastResumedAt', // EstatePowerStatus.lastResumedAt
  pipelineActivity: 'pipelineActivity', // EstatePowerStatus.pipelineActivity (SP state route only)
});

export const AUTOPAUSE_SOURCE_UNREADABLE = 'unreadable'; // EstateAutoPauseSetting.source

/**
 * pause-orchestrator.ts: ResumeConfirmation success members, via pause-state.ts
 * isResumeSuccess(): 'confirmed-running' and 'confirmed-restored-paused'.
 */
export const RESUME_SUCCESS = Object.freeze(['confirmed-running', 'confirmed-restored-paused']);

/**
 * Boundary table. Sovereign authority + ARM + Synapse dev suffixes are the only
 * cloud-specific literals in this tree; console URL and audience are inputs,
 * never defaults. (The console pins issuer to login.microsoftonline.com / .us per
 * estate-power-contract.ts AUTH.)
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

/**
 * PURE. Split the repo envelope; never throws. `data` is the body minus `ok`
 * (fields are top level, respond.ts apiOk).
 */
export function parseEnvelope(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, data: null, error: 'response was not a JSON object' };
  }
  if (body[FIELD.ok] !== true) {
    const e = body[FIELD.error];
    const msg = typeof e === 'string' && e ? e : 'the console reported ok=false without an error message';
    return { ok: false, data: null, error: msg };
  }
  const { [FIELD.ok]: _ok, ...data } = body;
  return { ok: true, data, error: null };
}

/** PURE. Rows of the set the console would act on / holds, normalised for display. */
export function rowsOf(list) {
  if (!Array.isArray(list)) return null;
  return list.map((x) => ({
    id: String(x?.[FIELD.rowResourceId] ?? ''),
    name: String(x?.[FIELD.rowName] ?? '<unnamed>'),
    type: String(x?.[FIELD.rowType] ?? '<untyped>'),
    detail: String(x?.[FIELD.rowMechanism] ?? ''),
  }));
}

/** PURE. The pause set from a preview/running body: preview.wouldPause. */
export function pauseSetOf(data) {
  return rowsOf(data?.[FIELD.preview]?.[FIELD.wouldPause]);
}
