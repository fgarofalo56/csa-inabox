#!/usr/bin/env node
/**
 * estate-power.mjs — drive estate pause/resume through the Loom CONSOLE API as
 * the deploy service principal (#4876 step 3). The pause snapshot lives in a
 * private-endpoint-only Cosmos, so Actions cannot do this itself: it calls the
 * console, which owns the snapshot.
 *
 *   node scripts/estate-power/estate-power.mjs --boundary Commercial|GCC-High \
 *        --action preview|pause|resume|state [--dry-run] [--confirm <typed>]
 *
 * Env: CSA_LOOM_CONSOLE_URL, CSA_LOOM_CONSOLE_AUDIENCE (both required, no
 * defaults). Token: `az account get-access-token --resource <audience>` from the
 * logged-in az session; held in memory only.
 *
 * ORDER OF OPERATIONS (fail closed before any mutation):
 *   args -> env -> az cloud must equal the boundary -> token -> console calls.
 * Exit: 0 verified, 1 failed/unverified, 2 usage/config, 3 boundary refusal.
 *
 * PUBLICATION-SINKS: 2
 */
import { pathToFileURL } from 'node:url';
import {
  ACTIONS, FIELD, ENDPOINT_PATH, ESTATE_STATE, RESUME_SUCCESS,
  boundaryInfo, parseEnvelope, pauseSetOf, rowsOf,
} from './contract.mjs';
import { acquireToken, assertBoundary, defaultSpawn, sanitizeLine, scrub } from './token.mjs';

export const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2, BOUNDARY: 3 });
export const MAX_ATTEMPTS = 3;
export const BACKOFF_BASE_MS = 2000;
export const DEFAULT_POLL_TIMEOUT_MIN = 20;
export const POLL_INTERVAL_MS = 30000;
const REQUEST_TIMEOUT_MS = 60000;

// ── pure helpers ────────────────────────────────────────────────────────────

/**
 * Classify a failed console call. `networkError` true = no HTTP response.
 * @returns {'transient'|'permission'|'quota'|'config'|'defect'}
 */
export function classifyFailure({ status, networkError, message }) {
  if (networkError) return 'transient';
  const m = String(message ?? '');
  if (status === 401 || status === 403) return 'permission';
  if (status === 507 || /quota|capacity|SkuNotAvailable/i.test(m)) return 'quota';
  if (status === 429 || status === 502 || status === 503 || status === 504) return 'transient';
  if (status === 400 || status === 404 || status === 409 || status === 412 || status === 422) return 'config';
  return 'defect';
}

/**
 * Retry only transient failures, bounded. A MUTATING call is retried only when
 * the server said it did NOT process the request (429/503); a network error or
 * 502/504 leaves the outcome unknown, and a blind re-send is not safe.
 */
export function shouldRetry({ kind, status, networkError, mutating, attempt, maxAttempts = MAX_ATTEMPTS }) {
  if (kind !== 'transient') return false;
  if (attempt >= maxAttempts) return false;
  if (mutating && (networkError || (status !== 429 && status !== 503))) return false;
  return true;
}

export function remediationFor(kind, boundary) {
  switch (kind) {
    case 'permission':
      return `the deploy service principal was refused by the console. Grant it the Estate.Power app role on the ${boundary} console app registration, then re-run.`;
    case 'quota':
      return 'the console reported a quota/capacity condition. No retry resolves it; free capacity or change the SKU, then re-run.';
    case 'config':
      return 'the console rejected the request as invalid for the current estate state. Read the message above, fix the input (or run action=state), then re-run.';
    case 'transient':
      return 'the call did not complete after bounded retries. Run action=state to see what actually changed before re-running.';
    default:
      return 'the console returned an unclassified failure. Read the message above; nothing was assumed about the cause.';
  }
}

/**
 * Is every expected resource read back in a target state? `expected` is the
 * name list captured BEFORE the mutation, so a resource that vanished from the
 * read-back is a failure, not a pass.
 */
export function verifyPaused(data, expectedIds) {
  const st = data?.[FIELD.state];
  const failures = [];
  const progress = Array.isArray(data?.[FIELD.progress]) ? data[FIELD.progress] : null;
  if (progress) {
    for (const p of progress) {
      if (p?.[FIELD.progressAtExpected] !== true) {
        failures.push({ name: String(p?.[FIELD.rowName] ?? '<unnamed>'), type: String(p?.[FIELD.rowType] ?? '<untyped>'), state: String(p?.[FIELD.progressPowerState] ?? 'Unknown'), why: String(p?.[FIELD.progressDetail] ?? 'not at the expected state') });
      }
    }
    const seen = new Set(progress.map((p) => String(p?.[FIELD.rowResourceId] ?? '').toLowerCase()));
    for (const id of expectedIds) {
      if (!seen.has(id.toLowerCase())) failures.push({ name: id, type: '', state: 'absent', why: 'not present in the read-back' });
    }
  }
  if (st !== ESTATE_STATE.paused) return { ok: false, terminal: false, failures, note: `estate state is ${JSON.stringify(st ?? null)}, not ${ESTATE_STATE.paused}` };
  if (!progress || progress.length === 0) return { ok: false, terminal: false, failures, note: 'state is PAUSED but the response carried no per-resource progress, so nothing was verified' };
  if (data?.[FIELD.drifted] === true) failures.push({ name: 'estate', type: '', state: 'drifted', why: `drifted resources: ${JSON.stringify(data?.[FIELD.driftedResources] ?? null)}` });
  return { ok: failures.length === 0, terminal: false, failures, note: failures.length ? 'PAUSED but not every resource is at its expected state' : '' };
}

/**
 * Resume verification. The console reports RUNNING only once every resource
 * passes BOTH an ARM read and a real request to the service; RESUME_FAILED is
 * terminal and carries per-resource `outcomes`.
 */
export function verifyResumed(data) {
  const st = data?.[FIELD.state];
  if (st === ESTATE_STATE.running) return { ok: true, terminal: false, failures: [], note: '' };
  if (st === ESTATE_STATE.resumeFailed) {
    const names = new Map((Array.isArray(data?.[FIELD.resources]) ? data[FIELD.resources] : []).map((r) => [String(r?.[FIELD.rowResourceId] ?? ''), r]));
    const outcomes = Array.isArray(data?.[FIELD.outcomes]) ? data[FIELD.outcomes] : [];
    const failures = outcomes
      .filter((o) => !RESUME_SUCCESS.includes(o?.[FIELD.outcomeConfirmation]))
      .map((o) => {
        const r = names.get(String(o?.[FIELD.outcomeResourceId] ?? ''));
        return { name: String(r?.[FIELD.rowName] ?? o?.[FIELD.outcomeResourceId] ?? '<unnamed>'), type: String(r?.[FIELD.rowType] ?? ''), state: String(o?.[FIELD.outcomeConfirmation] ?? 'unknown'), why: String(o?.[FIELD.outcomeReason] ?? '') };
      });
    return { ok: false, terminal: true, failures, note: String(data?.[FIELD.reason] ?? 'the console reported RESUME_FAILED') };
  }
  return { ok: false, terminal: false, failures: [], note: `estate state is ${JSON.stringify(st ?? null)}, not ${ESTATE_STATE.running}` };
}

export function parseArgs(argv) {
  const o = { boundary: null, action: null, dryRun: false, confirm: null, timeoutMin: DEFAULT_POLL_TIMEOUT_MIN };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${a} needs a value`);
      return argv[i];
    };
    if (a === '--boundary') o.boundary = val();
    else if (a === '--action') o.action = val();
    else if (a === '--confirm') o.confirm = val();
    else if (a === '--timeout-minutes') o.timeoutMin = Number(val());
    else if (a === '--dry-run') o.dryRun = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!boundaryInfo(o.boundary)) throw new Error('--boundary must be Commercial or GCC-High');
  if (!ACTIONS.includes(o.action)) throw new Error(`--action must be one of ${ACTIONS.join('|')}`);
  if (!Number.isFinite(o.timeoutMin) || o.timeoutMin <= 0) throw new Error('--timeout-minutes must be a positive number');
  return o;
}

/** https only, no credentials, origin only; returns the endpoint URL string or null. */
export function endpointUrl(base) {
  let u;
  try { u = new URL(String(base)); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.pathname !== '/' && u.pathname !== '')) return null;
  return new URL(ENDPOINT_PATH, u.origin).toString();
}

// ── io ──────────────────────────────────────────────────────────────────────

const stdoutSink = (s) => process.stdout.write(`${s}\n`);
const stderrSink = (s) => process.stderr.write(`${s}\n`);
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One console call with classification and bounded retry.
 * @returns {Promise<{ok:true,data:object}|{ok:false,kind:string,status:number|null,message:string,attempts:number}>}
 */
export async function callConsole({ url, token, body, mutating, fetchFn, sleep, boundary }) {
  for (let attempt = 1; ; attempt += 1) {
    let status = null;
    let networkError = false;
    let message = '';
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = res.status;
      // Read TEXT first so an unparseable body can be described rather than
      // reduced to "not a JSON object" — that string did not say whether the
      // reply was a Front Door/WAF page, an HTML 5xx, or an empty 200 (R7).
      const raw = await res.text().catch(() => '');
      let json = null;
      try { json = JSON.parse(raw); } catch { json = null; }
      const env = parseEnvelope(json);
      if (res.ok && env.ok) return { ok: true, data: env.data };
      message = env.error ?? `HTTP ${status} with no readable envelope`;
      if (json === null) {
        const ctype = res.headers?.get?.('content-type') ?? 'no content-type';
        const snippet = raw.replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 120);
        message = `HTTP ${status} (${ctype}) body was not JSON${snippet ? `: ${snippet}` : ' (empty body)'}`;
      }
      if (res.ok && !env.ok) status = 200;
    } catch (e) {
      networkError = true;
      message = `network error: ${e?.name === 'TimeoutError' ? 'request timed out' : e?.message ?? 'unknown'}`;
    }
    const kind = classifyFailure({ status, networkError, message });
    if (shouldRetry({ kind, status, networkError, mutating, attempt })) {
      await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      continue;
    }
    return { ok: false, kind, status, message, attempts: attempt, remediation: remediationFor(kind, boundary), outcomeUnknown: mutating && kind === 'transient' };
  }
}

// ── flow ────────────────────────────────────────────────────────────────────

/**
 * @param {object} args parsed args
 * @param {object} deps {env, spawn, fetchFn, sleep, now, out, err}
 * @returns {Promise<number>} exit code
 */
export async function runPower(args, deps = {}) {
  const env = deps.env ?? process.env;
  const spawn = deps.spawn ?? defaultSpawn;
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? (() => Date.now());
  const secrets = [];
  const out = (s) => (deps.out ?? stdoutSink)(sanitizeLine(scrub(s, secrets)));
  const err = (s) => (deps.err ?? stderrSink)(sanitizeLine(scrub(s, secrets)));
  const fail = (code, msg) => { err(`ERROR: ${msg}`); return code; };

  const url = endpointUrl(env.CSA_LOOM_CONSOLE_URL);
  if (!url) return fail(EXIT.USAGE, 'CSA_LOOM_CONSOLE_URL must be an https origin with no credentials and no path');
  const audience = env.CSA_LOOM_CONSOLE_AUDIENCE;
  if (!audience || !String(audience).trim()) return fail(EXIT.USAGE, 'CSA_LOOM_CONSOLE_AUDIENCE is not set');

  // Fail closed BEFORE the token and before any mutation.
  const cloud = assertBoundary(args.boundary, spawn);
  if (!cloud.ok) return fail(EXIT.BOUNDARY, `refusing to act on ${args.boundary}: ${cloud.reason}. No token was requested and no console call was made.`);
  out(`boundary ${args.boundary}: az cloud matches ${boundaryInfo(args.boundary).azEnvironment}`);

  const tok = acquireToken(audience, spawn);
  if (!tok.ok) return fail(EXIT.FAILED, tok.reason);
  secrets.push(tok.token);

  const call = (body, mutating = false) => callConsole({ url, token: tok.token, body, mutating, fetchFn, sleep, boundary: args.boundary });
  const callOrFail = async (body, mutating, what) => {
    const r = await call(body, mutating);
    if (r.ok) return r;
    err(`ERROR: ${what} failed [${r.kind}] after ${r.attempts} attempt(s): ${r.message}`);
    err(`REMEDIATION: ${r.remediation}`);
    if (r.outcomeUnknown) err('The request may or may not have been applied; this run did not verify it. Run action=state before re-running.');
    return null;
  };
  const printSet = (label, rows) => {
    out(`${label} (${rows.length} resource(s)):`);
    for (const r of rows) out(`  - ${r.name} | ${r.type} | ${r.detail}`);
  };
  const summarize = (d) => {
    const p = d[FIELD.power];
    out(`${FIELD.state}=${d[FIELD.state] ?? 'n/a'} ${FIELD.estateId}=${d[FIELD.estateId] ?? 'n/a'} `
      + `${FIELD.lastActivityAt}=${p?.[FIELD.activity]?.[FIELD.lastActivityAt] ?? 'n/a'} `
      + `${FIELD.lastPausedAt}=${p?.[FIELD.lastPausedAt] ?? 'n/a'} ${FIELD.lastResumedAt}=${p?.[FIELD.lastResumedAt] ?? 'n/a'}`);
  };

  if (args.action === 'state' || args.action === 'preview') {
    const r = await callOrFail({ action: args.action }, false, `action=${args.action}`);
    if (!r) return EXIT.FAILED;
    summarize(r.data);
    const rows = args.action === 'preview' ? pauseSetOf(r.data) : rowsOf(r.data[FIELD.resources]);
    if (rows) printSet(args.action, rows);
    return EXIT.OK;
  }

  const isPause = args.action === 'pause';

  // Where is the estate NOW? Decides whether there is anything to do at all.
  const cur = await callOrFail({ action: 'state' }, false, 'pre-action state read');
  if (!cur) return EXIT.FAILED;
  const curState = cur.data[FIELD.state];
  summarize(cur.data);
  if (curState === ESTATE_STATE.pausing || curState === ESTATE_STATE.resuming) {
    return fail(EXIT.FAILED, `estate state is ${curState}: a pause/resume is already in flight. Nothing was sent; wait for it to settle (action=state) and re-run.`);
  }
  if (isPause && curState === ESTATE_STATE.paused) {
    const v = verifyPaused(cur.data, []);
    if (v.ok) { out('already PAUSED and every resource reads back at its expected state; no pause sent.'); return EXIT.OK; }
    return fail(EXIT.FAILED, `estate state is PAUSED but not verified: ${v.note}. Nothing was sent.`);
  }
  if (isPause && curState !== ESTATE_STATE.running) {
    return fail(EXIT.FAILED, `estate state is ${JSON.stringify(curState ?? null)}; pause needs RUNNING. Nothing was sent.`);
  }
  if (!isPause && curState === ESTATE_STATE.running) {
    out('estate is already RUNNING per the console; no resume sent.');
    return EXIT.OK;
  }
  if (!isPause && curState !== ESTATE_STATE.paused && curState !== ESTATE_STATE.resumeFailed) {
    return fail(EXIT.FAILED, `estate state is ${JSON.stringify(curState ?? null)}; resume needs PAUSED or RESUME_FAILED. Nothing was sent.`);
  }

  // Establish the real set: preview.wouldPause for pause, the snapshot resources for resume.
  let pre = cur;
  let rows;
  if (isPause) {
    pre = await callOrFail({ action: 'preview' }, false, 'preview');
    if (!pre) return EXIT.FAILED;
    rows = pauseSetOf(pre.data);
  } else {
    rows = rowsOf(pre.data[FIELD.resources]);
  }
  if (!rows || rows.length === 0) {
    return fail(EXIT.FAILED, `the console reported no resources to ${args.action}; the set to verify against is not established, so nothing was changed`);
  }
  printSet(isPause ? 'pause set' : 'resume set', rows);

  if (args.dryRun) {
    out('dry-run: no mutation was sent.');
    return EXIT.OK;
  }

  const body = { action: args.action };
  if (isPause) {
    const token = pre.data[FIELD.confirmToken];
    const estateId = pre.data[FIELD.estateId];
    if (typeof token !== 'string' || token === '') return fail(EXIT.FAILED, `preview returned no ${FIELD.confirmToken}; pause cannot be authorised`);
    if (typeof estateId !== 'string' || estateId === '') return fail(EXIT.FAILED, `preview returned no ${FIELD.estateId}, which is the typed confirmation; pause cannot be authorised`);
    if (!args.confirm) return fail(EXIT.USAGE, `pause needs --confirm <typed estate id> (the console expects the estate id ${JSON.stringify(estateId)})`);
    if (args.confirm.trim() !== estateId) return fail(EXIT.USAGE, `--confirm does not equal the estate id ${JSON.stringify(estateId)}. Nothing was sent.`);
    body.confirm = args.confirm;
    body.confirmToken = token;
  }
  const sent = await callOrFail(body, true, `action=${args.action}`);
  if (!sent) return EXIT.FAILED;
  const goal = isPause ? 'PAUSED (every resource at its expected state)' : 'RUNNING';
  out(`${args.action} accepted by the console (202 is a dispatch, not a result); polling until the console reports ${goal}.`);

  const expectedIds = rows.map((r) => r.id).filter(Boolean);
  const deadline = now() + args.timeoutMin * 60000;
  let last = null;
  let lastProgress = null;
  for (;;) {
    const s = await callOrFail({ action: 'state' }, false, 'poll state read');
    if (!s) return EXIT.FAILED;
    if (Array.isArray(s.data[FIELD.progress])) lastProgress = s.data[FIELD.progress];
    last = isPause ? verifyPaused(s.data, expectedIds) : verifyResumed(s.data);
    if (last.ok) {
      out(`VERIFIED: the console reports ${isPause ? ESTATE_STATE.paused : ESTATE_STATE.running}.`);
      if (lastProgress) for (const p of lastProgress) out(`  - ${p?.[FIELD.rowName]} | ${p?.[FIELD.rowType]} | ${p?.[FIELD.progressPowerState]}`);
      return EXIT.OK;
    }
    if (last.terminal || now() >= deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }
  err(`ERROR: ${args.action} is NOT verified${last.terminal ? '' : ` within ${args.timeoutMin} minute(s)`}: ${last.note}`);
  for (const f of last.failures) err(`  - ${f.name} | ${f.type} | ${f.state} (${f.why})`);
  err(last.terminal
    ? 'REMEDIATION: the console reported RESUME_FAILED. Read the per-resource reasons above (they come from the console), fix the named cause, then re-run action=resume.'
    : `REMEDIATION: the ${args.action} was accepted but is unverified. Run action=state, and if a resource stays stuck read its ARM activity log; re-run action=${args.action} once the console reports no pause/resume in flight.`);
  return EXIT.FAILED;
}

export async function main(argv, deps = {}) {
  let args;
  try { args = parseArgs(argv); } catch (e) {
    (deps.err ?? stderrSink)(`ERROR: ${e.message}`);
    return EXIT.USAGE;
  }
  return runPower(args, deps);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
}
