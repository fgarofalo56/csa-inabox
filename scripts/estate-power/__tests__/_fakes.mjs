// Shared fakes for the estate-power tests. Not a test file (no .test.mjs suffix).

export const SENTINEL = 'SENTINEL-TOKEN-0123456789abcdef-DO-NOT-PRINT';
export const ADF_ID =
  '/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/rg-loom/providers/Microsoft.DataFactory/factories/adf-loom';

/** spawn fake: routes on argv, records every call. */
export function fakeSpawn({ cloud = 'AzureCloud', accountFails = false, tokenFails = false, rest = null } = {}) {
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

export const ok = (data) => ({ status: 200, json: { ok: true, data } });

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

export const RES = (state) => [
  { name: 'aas-one', type: 'Microsoft.AnalysisServices/servers', state },
  { name: 'adx-one', type: 'Microsoft.Kusto/clusters', state },
];
