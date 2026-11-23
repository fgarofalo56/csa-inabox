#!/usr/bin/env node
/**
 * Orchestrator for .github/workflows/lhds-fhir-crud-probe.yml (#5422 decision 12, LHDS W2-2b B3): the live
 * receipt that a PDP-allowed FHIR create/read works against a synthetic tenant's per-tenant HAPI engine.
 * Runs in-VNet on the `loom-aca` fleet as the deploy SP. Three phases:
 *
 *   create   POST two synthetic tenants, submit tenant.create then fhir-tenant.create (one facility partition) for
 *            each, wait (bounded), print each job's state + control-plane-authored receipts (redacted, capped),
 *            discover the issuer, and publish the NON-SECRET results (owned slugs, issuer) to --outputs-file.
 *   probe    mint a WRITER token for tenant A and a READER token for tenant B (mint-tenant-token.mjs), write a probe
 *            script plus two `Authorization:` header files (0600) into a private temp dir, and run ONE
 *            `az aks command invoke` that curls each engine's ClusterIP Service from the aks-command pod. Tokens
 *            cross ARM once, as files, never on a command line; they exist only in this process's memory and in
 *            those files, which are deleted in a finally. Only `PROBE step=<name> status=<code>` lines are parsed
 *            from the pod's logs; raw az output is never printed.
 *   cleanup  (run under `if: always()`) disable the minted `fc-` clients of the tenants THIS run created, then for
 *            each owned tenant: tenant.destroy (health-tenant-destroy.mjs), then fhir-tenant.teardown.
 *
 * The probe's verdict per step (judge) names the status that breaks it. Exit 0 pass, 1 defect/failed, 2 unmeasured
 * (deploy-integrity R7: an outcome that was not established is never reported as a defect or as a pass).
 *
 * Args: --phase --cp-url --stamp --tenant-a --tenant-b [--partition] [--owned-file] [--outputs-file] [--timeout-s]
 *       [--issuer-path] [--aks-rg --aks-name --aks-subscription] [--retry-s]
 * Bearer: env LHDS_CP_TOKEN only.
 */
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cpCall, disableClient, discoverIssuer, mintTenantToken, MintError, verdictLines, redact, SLUG_RE } from './mint-tenant-token.mjs';
import { readOwned } from './lhds-edge-probe-run.mjs';
import { runDestroy } from '../../csa-loom/health-tenant-destroy.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const JOB_ID_RE = /^job-[0-9a-f]{32}$/;
/** runCommand provisioningState values after which the command result no longer changes. */
export const TERMINAL_RUN_STATES = new Set(['Succeeded', 'Failed', 'Canceled']);
/** A runCommand id as ARM returns it (hex, measured 32 chars); anything else is never put on an az command line. */
export const COMMAND_ID_RE = /^[A-Za-z0-9-]{8,80}$/;
/** Poll the result of a command az stopped waiting for: 40 x 15 s bounds it at 10 min past az's own ~300 s. */
export const RESULT_POLL_MS = 15_000;
export const RESULT_MAX_POLLS = 40;
// Mirrors apps/loom-health-cp/src/jobs/fhir-tenant-config.ts PARTITION_NAME (a test lifts the source pattern and compares).
const PARTITION_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/;
const GUID_RE = /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;

// The engine's Service, mirrored from apps/loom-health-cp/src/jobs/fhir-engine-host.ts (ENGINE_NAMESPACE, SERVICE_PORT) and
// fhir-tenant-config.ts (fhirNames().workloadName === `fhir-${slug}`). A unit test lifts those from the TS source.
export const ENGINE_NAMESPACE = 'loom-health';
export const SERVICE_PORT = 80;
export const workloadName = (slug) => `fhir-${slug}`;
export const engineBase = (slug) => `http://${workloadName(slug)}.${ENGINE_NAMESPACE}.svc.cluster.local:${SERVICE_PORT}/fhir`;

export const WRITER = Object.freeze({ scope: 'system/*.cruds', allowedScopes: ['system/*.cruds'], roleIds: ['fhir-data-writer'], clientPrefix: 'fc' });
export const READER = Object.freeze({ scope: 'system/*.rs', allowedScopes: ['system/*.rs'], roleIds: ['fhir-data-reader'], clientPrefix: 'fc' });

/**
 * The status each probe step must produce, and why. The 401/403 values are what the CLIENT sees: LoomPdpInterceptor throws
 * AuthenticationException (401) for a missing bearer BEFORE the PDP is asked, and ForbiddenOperationException (403, body "Access denied",
 * the rule that fired goes to the audit record only) for every PDP deny. So a tenant mismatch (e) and a missing role/scope (f) both read 403
 * here; the reason (`tenant-mismatch`, `scope-denied`) is in the engine's audit log, not in the response.
 */
export const EXPECT = Object.freeze({ a: 200, b: 401, c: 201, d: 200, e: 403, f_ctrl: 200, f: 403 });
export const STEP_TITLES = Object.freeze({
  a: 'GET /fhir/metadata, no token',
  b: 'POST Patient, no token',
  c: 'POST Patient, writer token A, engine A',
  d: 'GET created Patient, token A, engine A',
  e: 'GET that Patient id, token A, engine B (cross-tenant)',
  f_ctrl: 'GET Patient?_count=1, reader token B, engine B (positive control for f)',
  f: 'POST Patient, reader token B, engine B (scope denial)',
});
const STEP_ORDER = Object.keys(EXPECT);

const mkSay = (deps) => { const out = deps.out ?? ((s) => console.log(s)); return (s) => out(`lhds-fhir-crud-probe: ${s}`); };

export function parseArgs(argv, env) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1]; i++; }
  const pick = (k, d = '') => String(a[k] ?? d).replace(/\r/g, '').trim();
  return {
    phase: pick('phase'), cpUrl: pick('cp-url'), stamp: pick('stamp'), a: pick('tenant-a'), b: pick('tenant-b'),
    partition: pick('partition', 'probe-site'), ownedFile: pick('owned-file'), outputsFile: pick('outputs-file'),
    timeoutS: Number.parseInt(pick('timeout-s', '1500'), 10), issuerPath: pick('issuer-path', '/auth'),
    aksRg: pick('aks-rg'), aksName: pick('aks-name'), aksSub: pick('aks-subscription'), retryS: Number.parseInt(pick('retry-s', '300'), 10),
    cpToken: String(env.LHDS_CP_TOKEN ?? '').replace(/[\r\n]/g, ''),
  };
}

export function validate(c) {
  if (!['create', 'probe', 'cleanup'].includes(c.phase)) return 'phase must be create, probe or cleanup';
  if (!c.cpToken) return 'no control-plane bearer token (set env LHDS_CP_TOKEN)';
  if (!SLUG_RE.test(c.a) || !SLUG_RE.test(c.b) || c.a === c.b) return 'tenant-a and tenant-b must be distinct slugs matching ^[a-z0-9][a-z0-9-]{1,19}$';
  if (!/^[a-z0-9]{1,20}$/.test(c.stamp)) return 'stamp must match ^[a-z0-9]{1,20}$';
  if (!PARTITION_RE.test(c.partition) || c.partition === 'default') return 'partition must be a facility name (^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$, not "default")';
  if (!Number.isInteger(c.timeoutS) || c.timeoutS < 1 || c.timeoutS > 2400) return 'timeout-s must be 1-2400';
  if (c.phase !== 'probe' && !c.ownedFile) return 'owned-file is required for create and cleanup (the slugs this run created; cleanup destroys only those)';
  if (c.phase === 'probe') {
    if (!/^[A-Za-z0-9._()-]{1,90}$/.test(c.aksRg)) return 'aks-rg is required (the stamp resource group)';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(c.aksName)) return 'aks-name is required (the stamp AKS cluster)';
    if (c.aksSub && !GUID_RE.test(c.aksSub)) return 'aks-subscription must be a GUID when given';
    if (!Number.isInteger(c.retryS) || c.retryS < 0 || c.retryS > 420) return 'retry-s must be 0-420';
  }
  return null;
}

const errText = (r) => r.status === 'network-error' ? `network-error ${r.code}` : `HTTP ${r.status} ${redact(r.json?.error?.code ?? '-', 60)}: ${redact(r.json?.error?.message ?? '(no body)', 200)}`;
const api = (c, deps, method, path, body) => cpCall(deps, method, `${new URL(c.cpUrl).origin}${path}`, { body, bearer: c.cpToken });

/** Remove every occurrence of a known secret from text before it can be printed. */
export function scrub(text, secrets) {
  let s = String(text ?? '');
  for (const x of secrets) if (x) s = s.split(x).join('<redacted>');
  return s;
}

/** Write NON-SECRET results to $GITHUB_OUTPUT-style file. Each value is shape-checked so it cannot inject a second output. */
function writeOutputs(c, say, kv) {
  if (!c.outputsFile) return;
  for (const [k, v] of Object.entries(kv)) {
    if (!/^[A-Za-z0-9_]+$/.test(k) || !/^[A-Za-z0-9:/._,-]*$/.test(String(v))) { say(`REFUSED to write output ${k}: value has characters outside the allowed set`); continue; }
    appendFileSync(c.outputsFile, `${k}=${v}\n`);
  }
}

async function submit(c, deps, say, kind, tenant, key, input) {
  const j = await api(c, deps, 'POST', '/api/health/jobs', { kind, subjectType: 'tenant', subjectId: tenant, idempotencyKey: key, ...(input ? { input } : {}) });
  if ((j.status !== 202 && j.status !== 200) || !JOB_ID_RE.test(String(j.json?.data?.id ?? ''))) { say(`REFUSED submitting ${kind} for ${tenant}: ${errText(j)}`); return undefined; }
  say(`tenant=${tenant} kind=${kind} job=${j.json.data.id} state=${redact(j.json.data.state, 20)}`);
  return { t: tenant, kind, id: j.json.data.id, state: j.json.data.state, printed: 0 };
}

/** Poll until every job is terminal (bounded). Prints each job's new receipts once and its terminal error. Returns 0 only if all succeeded. */
async function waitJobs(c, deps, say, jobs) {
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + c.timeoutS * 1000;
  let failures = 0;
  while (jobs.some((j) => !TERMINAL.has(j.state))) {
    if (now() >= deadline) { say(`TIMEOUT after ${c.timeoutS}s: ${jobs.filter((j) => !TERMINAL.has(j.state)).map((j) => `${j.t}/${j.kind}=${j.state}`).join(' ')}. Outcome NOT verified.`); return 1; }
    await sleep(15_000);
    for (const j of jobs.filter((x) => !TERMINAL.has(x.state))) {
      const g = await api(c, deps, 'GET', `/api/health/jobs/${encodeURIComponent(j.id)}`);
      if (g.status !== 200 || !g.json?.data) {
        failures += 1;
        say(`read of job ${j.id} failed (${failures}/5): ${errText(g)}`);
        if (failures >= 5) { say('COULD NOT READ the job after 5 consecutive failures. Outcome NOT verified.'); return 1; }
        continue;
      }
      failures = 0;
      j.state = g.json.data.state;
      const rs = Array.isArray(g.json.data.receipts) ? g.json.data.receipts : [];
      for (; j.printed < rs.length; j.printed++) say(`receipt ${j.t}/${j.kind} ${redact(rs[j.printed]?.step, 60)} ${redact(rs[j.printed]?.detail, 300)}`);
      if (j.state === 'failed' || j.state === 'cancelled') {
        say(`${j.kind} for ${j.t} ${j.state}: ${redact(g.json.data.error?.code ?? '-', 60)}: ${redact(g.json.data.error?.message ?? '(none)', 300)}`);
        j.reported = true;
      } else if (j.state === 'succeeded') say(`${j.kind} for ${j.t} succeeded`);
    }
  }
  // A job already terminal at submit (a replayed idempotency key) never enters the loop, so judge by final state, not by the loop's tally.
  for (const j of jobs) if (j.state !== 'succeeded' && !j.reported) say(`${j.kind} for ${j.t} is ${j.state} (reported at submit; no receipts were read)`);
  return jobs.every((j) => j.state === 'succeeded') ? 0 : 1;
}

export async function phaseCreate(c, deps = {}) {
  const say = mkSay(deps);
  try {
    const tenantJobs = [];
    for (const t of [c.a, c.b]) {
      const r = await api(c, deps, 'POST', '/api/health/tenants', { id: t, displayName: `fhir crud probe ${t}`, stampId: c.stamp, quotas: { maxRequestsPerMinute: 30, maxStorageGiB: 1 } });
      if (r.status === 409) { say(`COLLISION: tenant ${t} already exists (HTTP 409). This run did not create it and will NOT destroy it; nothing was marked as owned for it.`); return 1; }
      if (r.status !== 201) { say(`REFUSED creating tenant ${t}: ${errText(r)}`); return 1; }
      // Ownership: only a 201 means THIS run created the slug. Recorded (slugs only, non-secret) before anything else can fail.
      appendFileSync(c.ownedFile, `${t}\n`);
      // Emitted NOW, cumulatively (the last `owned=` line wins), so a cancelled step or a lost runner during the waits below still hands cleanup the slug.
      writeOutputs(c, say, { owned: [...readOwned(c.ownedFile)].join(',') });
      const j = await submit(c, deps, say, 'tenant.create', t, `fc-create-${t}`);
      if (!j) return 1;
      tenantJobs.push(j);
    }
    if (await waitJobs(c, deps, say, tenantJobs) !== 0) return 1;
    say('both tenant.create jobs succeeded');
    const fhirJobs = [];
    for (const t of [c.a, c.b]) {
      const j = await submit(c, deps, say, 'fhir-tenant.create', t, `fc-fhir-create-${t}`, { partitions: [c.partition] });
      if (!j) return 1;
      fhirJobs.push(j);
    }
    if (await waitJobs(c, deps, say, fhirJobs) !== 0) return 1;
    say(`both fhir-tenant.create jobs succeeded (each read back the rollout, /fhir/metadata through the API-server proxy, partition "${c.partition}" through the PG job, and the isolation readback)`);
    let disc;
    try { disc = await discoverIssuer({ ...deps, cpUrl: c.cpUrl, issuerPath: c.issuerPath }); } catch (e) {
      say(`COULD NOT DISCOVER the issuer: ${redact(e?.message ?? '', 300)}. The publish step needs it; nothing was published.`);
      return e instanceof MintError ? e.exit : 1;
    }
    writeOutputs(c, say, { issuer_url: disc.issuer });
    say(`issuer discovered: ${redact(disc.issuer, 200)}`);
    return 0;
  } finally {
    writeOutputs(c, say, { owned: [...readOwned(c.ownedFile)].join(',') });
  }
}

// ---- the in-cluster probe -----------------------------------------------------------------------------------------------

/**
 * The probe script run in the aks-command pod. Uses only POSIX sh builtins plus curl and sleep (the pod is distroless Debian: curl and a shell
 * are measured present; nothing else is assumed). Tokens are NOT in this text: they arrive as `Authorization:` header files read with
 * `curl -H @file`, so no token is ever a process argument. It prints only `PROBE ...` lines: never a header, a token or a body.
 * Step (c) retries ONLY while the answer is 403 or 503, the two statuses a PDP that has not loaded the just-published bundle can produce (the
 * response does not say which rule fired), for at most `retrySeconds`, and prints every attempt.
 */
export function renderProbeScript({ tenantA, tenantB, partition, retrySeconds = 300 }) {
  for (const [k, v] of Object.entries({ tenantA, tenantB })) if (!SLUG_RE.test(v)) throw new Error(`renderProbeScript: ${k} is not a tenant slug`);
  if (!PARTITION_RE.test(partition)) throw new Error('renderProbeScript: partition is not a facility name');
  if (!Number.isInteger(retrySeconds) || retrySeconds < 0 || retrySeconds > 420) throw new Error('renderProbeScript: retrySeconds out of range');
  return `#!/bin/sh
# Generated by scripts/measure/health/lhds-fhir-crud-probe-run.mjs. Holds no secret: tokens are header files (hdrA, hdrB).
# Prints PROBE lines only. curl stderr is discarded; no header, token or response body is ever printed.
set -u
BASE_A='${engineBase(tenantA)}'
BASE_B='${engineBase(tenantB)}'
PART='${partition}'
RETRY_S=${retrySeconds}
TMP="\${TMPDIR:-/tmp}/lhds-probe.$$"
HF="$TMP.h"
BF="$TMP.b"
trap 'rm -f "$HF" "$BF" hdrA hdrB 2>/dev/null' EXIT
PAT='{"resourceType":"Patient","name":[{"family":"Probe","given":["Synthetic"]}]}'
CR=$(printf '\\r')
CODE=000

# req <hdrfile|-> <METHOD> <url> [json]  -> sets CODE; headers in $HF, body in $BF
req() {
  hdr=$1; method=$2; url=$3
  : > "$HF" 2>/dev/null; : > "$BF" 2>/dev/null
  if [ "$hdr" = "-" ]; then
    if [ "$#" -ge 4 ]; then
      CODE=$(curl -sS --max-time 20 -o "$BF" -D "$HF" -w '%{http_code}' -X "$method" -H 'content-type: application/fhir+json' --data "$4" "$url" 2>/dev/null) || CODE=000
    else
      CODE=$(curl -sS --max-time 20 -o "$BF" -D "$HF" -w '%{http_code}' -X "$method" "$url" 2>/dev/null) || CODE=000
    fi
  else
    if [ "$#" -ge 4 ]; then
      CODE=$(curl -sS --max-time 20 -o "$BF" -D "$HF" -w '%{http_code}' -X "$method" -H "@$hdr" -H 'content-type: application/fhir+json' --data "$4" "$url" 2>/dev/null) || CODE=000
    else
      CODE=$(curl -sS --max-time 20 -o "$BF" -D "$HF" -w '%{http_code}' -X "$method" -H "@$hdr" "$url" 2>/dev/null) || CODE=000
    fi
  fi
  case "$CODE" in [0-9][0-9][0-9]) ;; *) CODE=000 ;; esac
}

# The Patient id from the Location header of a create, shape-checked; empty when absent or odd.
created_id() {
  loc=''
  while IFS= read -r line; do
    line=\${line%"$CR"}
    case "$line" in [Ll]ocation:*) loc=\${line#*:} ;; esac
  done < "$HF"
  case "$loc" in *'/Patient/'*) rest=\${loc#*/Patient/}; id=\${rest%%/*} ;; *) id='' ;; esac
  case "$id" in ''|*[!A-Za-z0-9.-]*) id='' ;; esac
  printf '%s' "$id"
}

body_has_id() { # $1 = id ; 0 when the response body is a Patient whose id is $1
  b=''
  while IFS= read -r line || [ -n "$line" ]; do b="$b$line"; done < "$BF"
  case "$b" in *'"resourceType":"Patient"'*|*'"resourceType": "Patient"'*) ;; *) return 1 ;; esac
  case "$b" in *'"id":"'"$1"'"'*|*'"id": "'"$1"'"'*) return 0 ;; esac
  return 1
}

if command -v sleep >/dev/null 2>&1; then echo 'PROBE tool sleep=yes'; HAVE_SLEEP=1; else echo 'PROBE tool sleep=no'; HAVE_SLEEP=0; fi

req - GET "$BASE_A/metadata";                   echo "PROBE step=a status=$CODE"
req - POST "$BASE_A/$PART/Patient" "$PAT";      echo "PROBE step=b status=$CODE"

# (c) writer token A creates a Patient. Retry ONLY on 403/503 (PDP not yet admitting the tenant), bounded by RETRY_S.
waited=0; try=0; PID=''
while :; do
  try=$((try + 1))
  req hdrA POST "$BASE_A/$PART/Patient" "$PAT"
  [ "$CODE" = "201" ] && PID=$(created_id)
  echo "PROBE step=c_try n=$try status=$CODE"
  case "$CODE" in 403|503) ;; *) break ;; esac
  [ "$HAVE_SLEEP" = "1" ] && [ "$waited" -lt "$RETRY_S" ] || break
  sleep 15; waited=$((waited + 15))
done
if [ -n "$PID" ]; then echo "PROBE step=c status=$CODE id=$PID"; else echo "PROBE step=c status=$CODE"; fi

if [ -n "$PID" ]; then
  req hdrA GET "$BASE_A/$PART/Patient/$PID"
  if [ "$CODE" = "200" ] && body_has_id "$PID"; then echo "PROBE step=d status=$CODE id_match=yes"; else echo "PROBE step=d status=$CODE id_match=no"; fi
  req hdrA GET "$BASE_B/$PART/Patient/$PID";    echo "PROBE step=e status=$CODE"
fi
req hdrB GET "$BASE_B/$PART/Patient?_count=1";  echo "PROBE step=f_ctrl status=$CODE"
req hdrB POST "$BASE_B/$PART/Patient" "$PAT";   echo "PROBE step=f status=$CODE"
exit 0
`;
}

const PROBE_LINE = /^PROBE step=([a-z_]+) status=(\d{3})(?: id=([A-Za-z0-9.-]{1,64}))?(?: id_match=(yes|no))?$/;

/** The step results in a pod's log text. The LAST line per step wins; anything that is not a PROBE line is ignored and never echoed. */
export function parseProbeLogs(text) {
  const out = {};
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = PROBE_LINE.exec(raw.trim());
    if (!m || !STEP_ORDER.includes(m[1])) continue;
    out[m[1]] = { status: Number(m[2]), ...(m[3] ? { id: m[3] } : {}), ...(m[4] ? { idMatch: m[4] === 'yes' } : {}) };
  }
  const tries = [...String(text ?? '').matchAll(/^PROBE step=c_try n=(\d+) status=(\d{3})$/gm)].map((m) => ({ n: Number(m[1]), status: Number(m[2]) }));
  return { steps: out, tries };
}

const UNAVAILABLE = (s) => s === 0 || s === 503; // curl could not get an answer (000), or the engine/PDP said it could not decide

/**
 * Judge the parsed steps. Each rule names the status that breaks it. A step is `pass`, `fail` (the system answered and the answer is wrong) or
 * `unmeasured` (no answer, or an answer that cannot support the claim). The denials (e, f) count as a pass ONLY when the paired positive control
 * showed the engine DOES admit the tenant: a 403 from a PDP that denies everything proves nothing.
 */
export function judge(parsed) {
  const s = parsed.steps;
  const res = {};
  const put = (step, verdict, note) => { res[step] = { step, expect: EXPECT[step], got: s[step]?.status, verdict, note }; };
  const generic = (step) => {
    const g = s[step];
    if (!g) return put(step, 'unmeasured', 'no result line for this step');
    if (UNAVAILABLE(g.status)) return put(step, 'unmeasured', g.status === 0 ? 'curl got no HTTP answer (no connection to the engine)' : 'the engine answered 503 (it could not decide); no claim about the result');
    return put(step, g.status === EXPECT[step] ? 'pass' : 'fail', g.status === EXPECT[step] ? '' : `expected ${EXPECT[step]}`);
  };
  generic('a');
  generic('b');
  // c: 201 with an id. 403 after the bounded retry is a FAIL whose cause is NOT established (denial and bundle lag read the same).
  if (!s.c) put('c', 'unmeasured', 'no result line for this step');
  else if (UNAVAILABLE(s.c.status)) put('c', 'unmeasured', s.c.status === 0 ? 'curl got no HTTP answer' : `still 503 after ${parsed.tries.length} attempt(s): the PDP could not decide, so whether the bundle admitted the tenant is not established`);
  else if (s.c.status === 201 && !s.c.id) put('c', 'fail', 'created, but the Location header carried no Patient id');
  else if (s.c.status === 201) put('c', 'pass', '');
  else if (s.c.status === 403) put('c', 'fail', `403 on all ${parsed.tries.length} attempt(s). A PDP deny and a bundle not yet loaded read the same from here; the rule that fired is in the engine audit log (audit decision/reason), not established by this probe`);
  else put('c', 'fail', `expected 201`);
  const cOk = res.c.verdict === 'pass';
  // d: 200 AND the returned id equals the created one.
  if (!cOk) put('d', 'unmeasured', 'not evaluated: the create (c) did not pass');
  else if (!s.d) put('d', 'unmeasured', 'no result line for this step');
  else if (UNAVAILABLE(s.d.status)) put('d', 'unmeasured', 'no usable answer');
  else if (s.d.status !== 200) put('d', 'fail', 'expected 200');
  else if (s.d.idMatch !== true) put('d', 'fail', 'the read returned 200 but the body is not the Patient that was created');
  else put('d', 'pass', '');
  const dOk = res.d.verdict === 'pass';
  // e: a cross-tenant read that SUCCEEDS is a leak and fails regardless of anything else; a 403 counts only after c and d passed.
  // f_ctrl first: it shows tenant B's engine admits B at all, so a 403 from B in (e) is a tenant mismatch and not 'B is not homed in the bundle'.
  generic('f_ctrl');
  const ctrlOk = res.f_ctrl.verdict === 'pass';
  const e = s.e;
  if (e && (e.status >= 200 && e.status < 300)) put('e', 'fail', `CROSS-TENANT LEAK: engine B answered ${e.status} to a token minted for tenant A`);
  else if (!e) put('e', 'unmeasured', cOk ? 'no result line for this step' : 'not evaluated: no Patient was created to read');
  else if (UNAVAILABLE(e.status)) put('e', 'unmeasured', 'no usable answer');
  else if (e.status !== 403) put('e', 'fail', 'expected 403');
  else if (cOk && dOk && ctrlOk) put('e', 'pass', '');
  else put('e', 'unmeasured', '403 is not evidence while the same-tenant create/read (c, d) or the engine-B positive control (f_ctrl) did not pass');
  // f_ctrl (judged above) is also the positive control for f.
  const f = s.f;
  if (f && f.status >= 200 && f.status < 300) put('f', 'fail', `a READER token created a Patient (HTTP ${f.status}): the scope is not enforced`);
  else if (!f) put('f', 'unmeasured', 'no result line for this step');
  else if (UNAVAILABLE(f.status)) put('f', 'unmeasured', 'no usable answer');
  else if (f.status !== 403) put('f', 'fail', 'expected 403');
  else if (ctrlOk) put('f', 'pass', '');
  else put('f', 'unmeasured', '403 is not evidence while the reader positive control (f_ctrl) did not pass');
  const list = STEP_ORDER.map((k) => res[k]);
  const code = list.some((r) => r.verdict === 'fail') ? 1 : list.some((r) => r.verdict === 'unmeasured') ? 2 : 0;
  return { results: list, code };
}

/** Default az runner: argv array, no shell, stdout/stderr captured, never echoed. */
export function defaultExec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: process.env });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', (e) => resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` }));
    p.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function phaseProbe(c, deps = {}) {
  const say = mkSay(deps);
  const exec = deps.exec ?? defaultExec;
  const sleep = deps.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
  const minted = [];
  const secrets = [];
  let code = 0;
  let dir;
  const wipe = () => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; } };
  const onSig = () => { wipe(); process.exit(143); };
  try {
    const tokens = {};
    for (const [t, grant, label] of [[c.a, WRITER, 'writer'], [c.b, READER, 'reader']]) {
      const m = await mintTenantToken({ ...deps, cpUrl: c.cpUrl, cpToken: c.cpToken, tenant: t, issuerPath: c.issuerPath, ...grant });
      minted.push(m.clientId);
      secrets.push(m.accessToken);
      tokens[t] = m.accessToken;
      const v = verdictLines(t, m);
      for (const l of v.lines) say(`${label} ${l}`);
      if (!v.ok) code = 1;
      // The grant must be exactly what was asked for: a writer without cruds, or a reader WITH it, makes the probe meaningless.
      const got = new Set(m.scope.split(' ').filter(Boolean));
      const want = new Set(grant.scope.split(' '));
      const same = got.size === want.size && [...want].every((x) => got.has(x));
      say(`${label} tenant=${t} scope_is_exactly_requested=${same}`);
      if (!same) code = 1;
    }
    if (code !== 0) { say('VERDICT FAIL: the minted tokens are not what the probe needs; the engines were not contacted.'); return 1; }

    dir = mkdtempSync(join(deps.tmpRoot ?? process.env.RUNNER_TEMP ?? tmpdir(), 'lhds-fcp-'));
    process.once('SIGTERM', onSig);
    process.once('SIGINT', onSig);
    try { chmodSync(dir, 0o700); } catch { /* best effort on filesystems without modes */ }
    const put = (name, text) => { writeFileSync(join(dir, name), text, { mode: 0o600 }); try { chmodSync(join(dir, name), 0o600); } catch { /* as above */ } };
    put('probe.sh', renderProbeScript({ tenantA: c.a, tenantB: c.b, partition: c.partition, retrySeconds: c.retryS }));
    put('hdrA', `Authorization: Bearer ${tokens[c.a]}\n`);
    put('hdrB', `Authorization: Bearer ${tokens[c.b]}\n`);

    // ONE invoke. The files are relative to cwd, so the token files are attached by NAME and no token is on any command line.
    const args = ['aks', 'command', 'invoke', '-g', c.aksRg, '-n', c.aksName, ...(c.aksSub ? ['--subscription', c.aksSub] : []),
      '--command', 'sh probe.sh', '--file', 'probe.sh', '--file', 'hdrA', '--file', 'hdrB', '-o', 'json'];
    say(`running the probe in the aks-command pod of ${redact(c.aksName, 60)} (one az aks command invoke; retry window for step c: ${c.retryS}s)`);
    let r = await exec('az', args, { cwd: dir });
    let logs = '';
    let podExit;
    let state = '';
    let reason = '';
    let sub = 'invoke'; // the az subcommand whose answer is being read, so a failure names it
    const readResult = (out) => {
      try {
        const j = JSON.parse(out.stdout);
        logs = String(j.logs ?? ''); podExit = j.exitCode; state = String(j.provisioningState ?? ''); reason = String(j.reason ?? '');
        return j;
      } catch {
        // R7: an answer that is not JSON must not leave the PREVIOUS poll's state or logs to be reported or judged as this one.
        logs = ''; podExit = undefined; state = 'unparseable'; reason = '';
        return undefined;
      }
    };
    const first = readResult(r);
    // `az aks command invoke` stops waiting after about 300 s and returns the IN-FLIGHT result (provisioningState Running,
    // exitCode null, logs null) with exit 0, while the command keeps running in the cluster. Measured on aks-lhds-dev01
    // 2026-11-23: a 290 s command came back Succeeded with its logs, a 330 s one came back Running, and
    // `az aks command result --command-id` then returned Succeeded with the logs. B3 run 45142805007 hit exactly this.
    // So a non-terminal answer is polled to the end rather than read as "no logs".
    const cmdId = String(first?.id ?? '');
    if (r.code === 0 && first && !TERMINAL_RUN_STATES.has(state) && COMMAND_ID_RE.test(cmdId)) {
      const resArgs = ['aks', 'command', 'result', '-g', c.aksRg, '-n', c.aksName, ...(c.aksSub ? ['--subscription', c.aksSub] : []), '--command-id', cmdId, '-o', 'json'];
      for (let i = 1; i <= RESULT_MAX_POLLS && !TERMINAL_RUN_STATES.has(state); i++) {
        say(`command ${redact(cmdId, 80)} is ${redact(state || 'unreported', 20)} (az stops waiting at about 300 s); polling its result (${i}/${RESULT_MAX_POLLS})`);
        await sleep(RESULT_POLL_MS);
        r = await exec('az', resArgs, { cwd: dir }); sub = 'result';
        if (r.code !== 0 || !readResult(r)) break;
      }
    }
    if (r.code !== 0 || !logs) {
      // R7: say what ARM reported, never just "no logs".
      const what = r.code !== 0 ? `exited ${r.code}` : `returned no pod logs (state=${redact(state || 'unreported', 20)} exitCode=${podExit === undefined || podExit === null ? 'none' : redact(podExit, 10)}${reason ? ` reason=${redact(scrub(reason, secrets), 200)}` : ''})`;
      say(`UNMEASURED: az aks command ${sub} ${what}: ${redact(scrub(r.stderr || '(no stderr)', secrets), 300)}. Nothing is established about the engines.`);
      code = 2;
    } else {
      const parsed = parseProbeLogs(scrub(logs, secrets));
      say(`pod exit code ${podExit === undefined ? 'unreported' : redact(podExit, 10)}; step lines parsed: ${Object.keys(parsed.steps).length}`);
      const v = judge(parsed);
      for (const x of v.results) {
        say(`step ${x.step} ${x.verdict.toUpperCase()} expect=${x.expect} got=${x.got === undefined ? 'none' : x.got} [${STEP_TITLES[x.step]}]${x.note ? ` ${redact(x.note, 300)}` : ''}`);
      }
      if (parsed.steps.c?.id) say(`created Patient id=${parsed.steps.c.id} (synthetic, in tenant ${c.a}'s partition ${c.partition}; it is deleted with the tenant database)`);
      code = v.code;
    }
  } catch (e) {
    if (e instanceof MintError) { say(`mint failed class=${e.cls}: ${redact(scrub(e.message, secrets), 500)}`); code = e.exit; }
    else { say(`unexpected ${redact(e?.name ?? 'error', 40)}: ${redact(scrub(e?.message ?? '', secrets), 200)}`); code = 1; }
  } finally {
    wipe();
    process.removeListener('SIGTERM', onSig);
    process.removeListener('SIGINT', onSig);
    for (const id of minted) {
      const ok = await disableClient({ ...deps, cpUrl: c.cpUrl, cpToken: c.cpToken }, id).catch(() => false);
      say(`cleanup client ${id} disabled=${ok}`);
      if (!ok && code === 0) code = 2;
    }
  }
  say(`VERDICT ${code === 0 ? 'PASS' : code === 1 ? 'FAIL' : 'UNMEASURED'}`);
  return code;
}

/**
 * Cleanup. Destroys ONLY slugs in the owned file (a 201 on create). tenant.destroy does NOT remove the tenant's FHIR engine, its PG principal or
 * (in the engine host) anything in the cluster: only fhir-tenant.teardown does, and that kind refuses unless the tenant is already `destroying`,
 * which tenant.destroy sets as its first act and never undoes. So the order is destroy, then teardown.
 */
export async function phaseCleanup(c, deps = {}) {
  const say = mkSay(deps);
  let rc = 0;
  const owned = readOwned(c.ownedFile);
  const list = await api(c, deps, 'GET', '/api/health/auth/clients');
  if (list.status === 200 && Array.isArray(list.json?.data?.clients)) {
    for (const cl of list.json.data.clients.filter((x) => owned.has(x.tenant) && String(x.clientId).startsWith('fc-') && x.status !== 'disabled')) {
      const ok = await disableClient({ ...deps, cpUrl: c.cpUrl, cpToken: c.cpToken }, cl.clientId).catch(() => false);
      say(`cleanup client ${cl.clientId} disabled=${ok}`);
      if (!ok) rc = 1;
    }
  } else { say(`COULD NOT LIST clients to disable leftovers: ${errText(list)}`); rc = 1; }
  for (const t of [c.a, c.b]) {
    if (!owned.has(t)) { say(`tenant ${t} was not created by this run (no ownership record): NOT destroying it`); continue; }
    const g = await api(c, deps, 'GET', `/api/health/tenants/${encodeURIComponent(t)}`);
    if (g.status === 404) { say(`tenant ${t} was never registered (HTTP 404): nothing to destroy`); continue; }
    const r = await runDestroy({
      cpUrl: c.cpUrl, tenant: t, stamp: c.stamp, idempotencyKey: `fc-destroy-${t}`, allowNonSynthetic: true,
      allowMissingStorage: false, timeoutS: c.timeoutS, intervalS: 15, token: c.cpToken,
    }, deps.destroyDeps ?? {});
    if (r.code !== 0) rc = 1;
    // Even after a failed destroy the tenant is `destroying` (set first), so the engine can and should still be removed.
    const j = await submit(c, deps, say, 'fhir-tenant.teardown', t, `fc-teardown-${t}`, { confirmTenantId: t });
    if (!j || await waitJobs(c, deps, say, [j]) !== 0) { rc = 1; say(`the FHIR engine / PG principal of ${t} may be LEAKED: fhir-tenant.teardown did not succeed`); }
  }
  say(`cleanup ${rc === 0 ? 'complete' : 'INCOMPLETE: see lines above (a leaked tenant or engine keeps billing)'}`);
  return rc;
}

export async function main(argv, env, deps = {}) {
  const c = parseArgs(argv, env);
  const bad = validate(c);
  if (bad) { mkSay(deps)(`REFUSED (input): ${redact(bad, 200)}. Nothing was contacted.`); return 2; }
  return c.phase === 'create' ? phaseCreate(c, deps) : c.phase === 'probe' ? phaseProbe(c, deps) : phaseCleanup(c, deps);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) main(process.argv.slice(2), process.env).then((code) => process.exit(code));
