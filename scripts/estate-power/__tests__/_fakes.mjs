// Shared fakes for the estate-power tests. Not a test file (no .test.mjs suffix).
// Body shapes mirror the REAL console (apps/fiab-console/lib/estate/estate-power-handlers.ts):
// envelope {ok:true, ...fields} at TOP LEVEL, state in RUNNING|PAUSING|PAUSED|RESUMING|RESUME_FAILED.

export const SENTINEL = 'SENTINEL-TOKEN-0123456789abcdef-DO-NOT-PRINT';
export const SUB = '11111111-2222-3333-4444-555555555555';
export const RG = 'rg-loom';
export const ADF_ID = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.DataFactory/factories/adf-loom`;
export const ESTATE_ID = 'estate-loom-1';
export const AAS_ID = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.AnalysisServices/servers/aas-one`;
export const ADX_ID = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Kusto/clusters/adx-one`;

/** spawn fake: routes on argv, records every call. */
export function fakeSpawn({ cloud = 'AzureCloud', accountFails = false, tokenFails = false, rest = null, list = null } = {}) {
  const calls = [];
  const fn = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = args.slice(0, 2).join(' ');
    if (key === 'account show') {
      return accountFails
        ? { status: 1, stdout: '', stderr: 'boom', error: null }
        : { status: 0, stdout: JSON.stringify({ environmentName: cloud }), stderr: '', error: null };
    }
    if (key === 'account get-access-token') {
      return tokenFails
        ? { status: 1, stdout: '', stderr: 'no login', error: null }
        : { status: 0, stdout: JSON.stringify({ accessToken: SENTINEL }), stderr: '', error: null };
    }
    if (args[0] === 'rest') {
      return rest ? rest(args) : { status: 0, stdout: JSON.stringify({ value: [] }), stderr: '', error: null };
    }
    if (key === 'resource list') {
      if (list) return list(args);
      const type = args[args.indexOf('--resource-type') + 1];
      const out = type === 'Microsoft.DataFactory/factories' ? [{ id: ADF_ID, name: 'adf-loom' }] : [];
      return { status: 0, stdout: JSON.stringify(out), stderr: '', error: null };
    }
    return { status: 1, stdout: '', stderr: `unexpected ${key}`, error: null };
  };
  fn.calls = calls;
  return fn;
}

/** fetch fake: handler(body, callIndex) -> {status, json} | throws */
export function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, auth: init.headers.authorization });
    const r = await handler(body, calls.length - 1);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json };
  };
  fn.calls = calls;
  return fn;
}

/** 200 envelope with TOP-LEVEL fields (respond.ts apiOk). */
export const ok = (fields) => ({ status: 200, json: { ok: true, ...fields } });
/** 202 accepted (handlers: pause/resume `{ status: 202 }`). */
export const accepted = (fields) => ({ status: 202, json: { ok: true, ...fields } });
/** respond.ts apiError. */
export const bad = (status, error, extra = {}) => ({ status, json: { ok: false, error, ...extra } });

export const ROWS = [
  { resourceId: AAS_ID, name: 'aas-one', resourceType: 'microsoft.analysisservices/servers', mechanism: 'arm-suspend' },
  { resourceId: ADX_ID, name: 'adx-one', resourceType: 'microsoft.kusto/clusters', mechanism: 'arm-stop' },
];

const NOW = Date.parse('2026-10-13T12:00:00Z');
export const power = (over = {}) => ({
  activity: { lastActivityAt: new Date(NOW - 5 * 3600e3).toISOString(), idleForSeconds: 5 * 3600, unreadable: false },
  autoPause: { enabled: true, idleHours: 4, source: 'stored', updatedAt: null, updatedBy: null },
  lastPausedAt: null,
  lastResumedAt: null,
  ...over,
});

/** handleStateRead / runningPayload when RUNNING. */
export const runningBody = (over = {}) => ({
  state: 'RUNNING', estateId: ESTATE_ID, confirmToken: 'tok-running', snapshotId: null,
  preview: { estateId: ESTATE_ID, wouldPause: ROWS, wouldLeaveRunning: [], summary: 's' }, power: power(), ...over,
});
/** handlePausePost dryRun body. */
export const previewBody = (over = {}) => ({
  dryRun: true, estateId: ESTATE_ID, confirmToken: 'tok-from-preview',
  preview: { estateId: ESTATE_ID, wouldPause: ROWS, wouldLeaveRunning: [], summary: 's' }, power: power(), ...over,
});
export const progressRows = (atExpected = true, powerState = 'Paused') => ROWS.map((r) => ({
  resourceId: r.resourceId, name: r.name, resourceType: r.resourceType, powerState,
  expectation: 'stopped', atExpectedState: atExpected, phase: atExpected ? 'done' : 'in-flight', detail: atExpected ? 'stopped' : 'still stopping',
}));
export const snapshotResources = ROWS.map((r) => ({ resourceId: r.resourceId, name: r.name, resourceType: r.resourceType }));
/** handleStateRead PAUSING/PAUSED. */
export const pausedBody = (state = 'PAUSED', atExpected = true) => ({
  state, estateId: ESTATE_ID, snapshotId: 's1', progress: progressRows(atExpected, atExpected ? 'Paused' : 'Pausing'),
  confirmed: atExpected ? 2 : 0, total: 2, drifted: false, driftedResources: [], reason: 'r', resources: snapshotResources, power: power(),
});
/** handleStateRead RESUMING / RESUME_FAILED. */
export const resumeBody = (state, outcomes = []) => ({
  state, estateId: ESTATE_ID, snapshotId: 's1', progress: [], outcomes, unconfirmed: 0, terminal: state === 'RESUME_FAILED', reason: 'resume reason', resources: snapshotResources, power: power(),
});

export function capture() {
  const out = [];
  const err = [];
  return { out, err, deps: { out: (s) => out.push(s), err: (s) => err.push(s) } };
}

/** A clock the fake sleep advances, so poll deadlines are testable without waiting. */
export function fakeClock(start = Date.parse('2026-10-13T12:00:00Z')) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

export const ENV = {
  CSA_LOOM_CONSOLE_URL: 'https://console.example.test',
  CSA_LOOM_CONSOLE_AUDIENCE: 'api://console-example',
};
