// Behaviour tests for the Databricks SQL warehouse step (`id: dbx_sql_warehouse`)
// and the final failure gate (`id: bootstrap_failure_gate`) in
// .github/workflows/csa-loom-post-deploy-bootstrap.yml (#4765).
//
// ── WHY THIS SUITE EXISTS ───────────────────────────────────────────────────
// The warehouse step keeps `continue-on-error: true`, so the job's conclusion
// comes from the gate step, which WARNS for exactly one failure class
// (`network_blocked`, operator decision 2026-09-29, recorded at
// https://github.com/fgarofalo56/csa-inabox/issues/4765#issuecomment-5895322196)
// and FAILS the job for every other one. The shape guard
// (check-bootstrap-rg-subscription-scope.mjs, Rule 2) proves the gate exists,
// is last and runs always(); it cannot see WHICH reasons reach the `exit 1`.
// Reviews of #4767 measured defects the shape guard passed green:
//   - gate `if true` (every failure warns) / `if false` (the network class fails)
//   - any 401/403 classified network_blocked; the step's `fail_with` exiting 0
//   - a DNS failure, a timeout, a TLS failure and a 500/502 body containing the
//     phrase all classified network_blocked
//   - the network_blocked test requiring JSON, when run 36526911340's refusals
//     were PLAIN TEXT ("Unauthorized network access to workspace: <id>"), so the
//     measured refusal became auth_refused with a false remediation
//   - a create whose outcome was unknown (timeout, 5xx) followed by a SECOND
//     create for the same name
// This suite runs the REAL shell against stub curl/az and pins, per scenario,
// the recorded reason, the step exit code, the gate exit code, the exact
// annotation counts, the GET/POST attempt counts and the backoff sleeps.
//
// ── WHAT IS UNDER TEST ──────────────────────────────────────────────────────
// Both `run:` blocks AND the gate's `env:` wiring are lifted from the parsed
// workflow at run time (_workflow-yaml.mjs), never transcribed: an edit to
// either block, or to which step output feeds which WH_* variable, is what this
// suite executes. `sleep` is stubbed too (it records its argument and returns),
// so the retry backoff is asserted without waiting for it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkflow, scalarValue } from '../_workflow-yaml.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..', '..');
const WF = path.join(REPO, '.github', 'workflows', 'csa-loom-post-deploy-bootstrap.yml');
const JOB = 'bootstrap';
const STEP_ID = 'dbx_sql_warehouse';
const GATE_ID = 'bootstrap_failure_gate';
const TOKEN = 'tok-STUB-4765-must-never-print';
const TRACK_3744 = 'tracked on #3744 (the console is to ensure-create it from inside the VNet)';

const bashOk = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const jqOk = bashOk && spawnSync('bash', ['-c', 'jq -n 1 >/dev/null']).status === 0;
// Locally a missing bash/jq skips; in CI it is a FAILURE, because a suite that
// skips in CI is a control that watches nothing.
const SKIP = !(bashOk && jqOk) && !process.env.CI;

test('prerequisites: bash and jq are on PATH (fails in CI when either is missing)', { skip: SKIP }, () => {
  assert.ok(bashOk, 'bash is not runnable, so no scenario below ran');
  assert.ok(jqOk, 'jq is not runnable; the warehouse step needs it');
});

// ── Lifting ─────────────────────────────────────────────────────────────────
function lift() {
  const doc = parseWorkflow(readFileSync(WF, 'utf8'));
  const steps = doc?.jobs?.[JOB]?.steps;
  assert.ok(Array.isArray(steps) && steps.length > 0, `job '${JOB}' has no steps in ${WF}`);
  const byId = (id) => {
    const s = steps.find((x) => scalarValue(x?.id) === id);
    assert.ok(s, `no step with id '${id}' in job '${JOB}' — renamed or removed?`);
    return s;
  };
  const wh = byId(STEP_ID);
  const gate = byId(GATE_ID);
  const whRun = String(scalarValue(wh.run) ?? '');
  const gateRun = String(scalarValue(gate.run) ?? '');
  // Shape checks that throw rather than let an empty extraction "pass".
  assert.match(whRun, /classify_failure\(\)/, 'lifted warehouse block has no classify_failure()');
  assert.match(gateRun, /WH_REASON/, 'lifted gate block does not read WH_REASON');
  assert.equal(String(scalarValue(wh['continue-on-error']) ?? ''), 'true',
    'the warehouse step no longer has continue-on-error: true — this suite models outcome != conclusion');
  const envMap = {};
  for (const [k, node] of Object.entries(gate.env ?? {})) {
    const expr = String(scalarValue(node) ?? '');
    const m = expr.match(/^\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.(outcome|outputs\.([A-Za-z0-9_]+))\s*\}\}$/);
    assert.ok(m, `gate env ${k}=${expr} is not a steps.<id>.outcome/outputs.<key> read this suite can evaluate`);
    assert.equal(m[1], STEP_ID, `gate env ${k} reads step '${m[1]}', not '${STEP_ID}'`);
    envMap[k] = m[3] ? { output: m[3] } : { outcome: true };
  }
  assert.ok(Object.values(envMap).some((v) => v.outcome), 'gate env reads no steps.dbx_sql_warehouse.outcome');
  return { whRun, gateRun, envMap, timeoutMinutes: scalarValue(wh['timeout-minutes']) };
}

// ── Stubs ───────────────────────────────────────────────────────────────────
const STUB_CURL = `#!/usr/bin/env bash
# Stub curl: -o FILE gets the body, stdout gets the HTTP code (-w '%{http_code}').
# S_GET_CODE / S_GET_RC (and S_POST_*) are space-separated per-call lists; the
# last element repeats. The body is S_GET_BODY_<n> for the n-th GET when set,
# else S_GET_BODY (same for POST). A non-zero rc prints 000 like real curl -w.
# Each call's time limits are logged as flags, never the arguments (the
# Authorization header carries the token).
out=""; method=GET
a=" $* "; ct=0; mt=0
[[ "$a" == *" --connect-timeout 15 "* ]] && ct=1
[[ "$a" == *" --max-time 60 "* ]] && mt=1
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -X) method="$2"; shift 2 ;;
    *) shift ;;
  esac
done
echo "$method" >> "$STUB_STATE/curl"
echo "$method ct=$ct mt=$mt" >> "$STUB_STATE/curl_limits"
n=$(grep -c "^$method\\$" "$STUB_STATE/curl")
pick() { local -a a; read -r -a a <<< "$1"; local i=$(( $2 - 1 )); [ "$i" -ge "\${#a[@]}" ] && i=$(( \${#a[@]} - 1 )); printf '%s' "\${a[$i]}"; }
if [ "$method" = GET ]; then codes="$S_GET_CODE"; rcs="\${S_GET_RC:-0}"; bvar="S_GET_BODY_$n"; body="\${!bvar-$S_GET_BODY}"
else codes="$S_POST_CODE"; rcs="\${S_POST_RC:-0}"; bvar="S_POST_BODY_$n"; body="\${!bvar-$S_POST_BODY}"; fi
code=$(pick "$codes" "$n"); rc=$(pick "$rcs" "$n")
if [ "$rc" != 0 ]; then echo "curl: ($rc) stub transport failure" >&2; printf '000'; exit "$rc"; fi
[ -n "$out" ] && printf '%s' "$body" > "$out"
printf '%s' "$code"
`;
const STUB_AZ = `#!/usr/bin/env bash
echo "az $*" >> "$STUB_STATE/az"
case "$1 $2" in
  "account get-access-token") [ "\${S_TOKEN:-yes}" = no ] || echo "${TOKEN}" ;;
  "resource list") if [ "$S_ARM" = unreadable ]; then echo "ERROR: (AuthorizationFailed) stub" >&2; exit 1; fi
    echo "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Databricks/workspaces/adb" ;;
  "resource show") echo "$S_ARM|NoAzureDatabricksRules" ;;
  "containerapp update") exit "\${S_CA_RC:-0}" ;;
  *) echo "unexpected az $*" >&2; exit 9 ;;
esac
`;
const STUB_SLEEP = `#!/usr/bin/env bash
echo "$*" >> "$STUB_STATE/sleep"
`;

const posix = (p) => p.replace(/\\/g, '/');
const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

function parseOutputs(file) {
  const out = {};
  for (const l of lines(file)) {
    const i = l.indexOf('=');
    if (i > 0) out[l.slice(0, i)] = l.slice(i + 1); // last write wins, as on a runner
  }
  return out;
}

/** Run the lifted warehouse block, then the lifted gate fed through the lifted env wiring. */
function scenario(s, blocks = lift()) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wh4765-'));
  const bin = path.join(dir, 'bin');
  const state = path.join(dir, 'state');
  mkdirSync(bin); mkdirSync(state);
  for (const [name, body] of [['curl', STUB_CURL], ['az', STUB_AZ], ['sleep', STUB_SLEEP]]) {
    writeFileSync(path.join(bin, name), body, 'utf8');
    chmodSync(path.join(bin, name), 0o755);
  }
  const stepFile = path.join(dir, 'step.sh');
  const gateFile = path.join(dir, 'gate.sh');
  const outFile = path.join(dir, 'github_output');
  writeFileSync(stepFile, blocks.whRun, 'utf8');
  writeFileSync(gateFile, blocks.gateRun, 'utf8');
  writeFileSync(outFile, '', 'utf8');
  const base = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    STUB_STATE: posix(state),
    GITHUB_OUTPUT: posix(outFile),
    DBX_HOST: 'adb-1.1.azuredatabricks.net', DBX_WS: 'adb',
    DLZ_RG: 'rg-dlz', DLZ_SUB: 'sub-dlz', ADMIN_RG: 'rg-admin', ADMIN_SUB: 'sub-admin',
    S_ARM: 'Enabled',
  };
  const step = spawnSync('bash', [posix(stepFile)], { encoding: 'utf8', env: { ...base, ...s.env } });
  const outputs = parseOutputs(outFile);
  const outcome = step.status === 0 ? 'success' : 'failure';
  const gateEnv = { ...process.env, PATH: base.PATH };
  for (const [k, v] of Object.entries(blocks.envMap)) gateEnv[k] = v.outcome ? outcome : (outputs[v.output] ?? '');
  const gate = spawnSync('bash', [posix(gateFile)], { encoding: 'utf8', env: gateEnv });
  const r = {
    stepRc: step.status,
    stepLog: `${step.stdout}${step.stderr}`,
    outputs,
    gateRc: gate.status,
    gateLog: `${gate.stdout}${gate.stderr}`,
    curl: lines(path.join(state, 'curl')),
    limits: lines(path.join(state, 'curl_limits')),
    az: lines(path.join(state, 'az')),
    sleeps: lines(path.join(state, 'sleep')),
  };
  r.errors = r.gateLog.split('\n').filter((l) => l.includes('::error::'));
  r.warnings = r.gateLog.split('\n').filter((l) => l.includes('::warning::'));
  rmSync(dir, { recursive: true, force: true });
  return r;
}

const count = (arr, v) => arr.filter((x) => x === v).length;
const WS_ID = '7405606457049619';
// The MEASURED shape: run 36526911340, bootstrap job 109290442554, log line 1657
// (SCIM) and 1862 (Delta Sharing) printed this body verbatim, with no JSON envelope.
const NET_PLAIN = `Unauthorized network access to workspace: ${WS_ID}`;
// The JSON shape of the same refusal, kept so both parse paths are pinned.
const NET_JSON = JSON.stringify({ error_code: '403', message: NET_PLAIN });
const EMPTY_LIST = '{"warehouses":[]}';
const LANDED = '{"warehouses":[{"name":"loom-default","id":"w-landed"}]}';
const NOT_LANDED = 'a re-list found no \'loom-default\'';

/**
 * The class table. Each row: env for the stubs, and what must hold. `breaks`
 * names the value that turns the row red (assertion-design.md).
 */
const NET_ROWS = [];
for (const [shape, body] of [['plain-text (measured)', NET_PLAIN], ['JSON', NET_JSON]]) {
  NET_ROWS.push(
    { name: `network 403 ${shape}, ARM Enabled`, env: { S_GET_CODE: '403', S_GET_BODY: body, S_ARM: 'Enabled' },
      reason: 'network_blocked', stepRc: 1, gateRc: 0, err: 0, warn: 1, get: 1,
      has: ['was refused by the workspace', 'although ARM reports publicNetworkAccess=Enabled', TRACK_3744, NET_PLAIN], lacks: ['public network access is disabled', 'workspace admin'],
      breaks: `the ${shape} refusal is classed auth_refused (JSON-only read), the network class fails the job (\`if false\`), loses the #3744 sentence, or says "disabled" when ARM said Enabled` },
    { name: `network 403 ${shape}, ARM Disabled`, env: { S_GET_CODE: '403', S_GET_BODY: body, S_ARM: 'Disabled' },
      reason: 'network_blocked', stepRc: 1, gateRc: 0, err: 0, warn: 1, get: 1,
      has: ['its public network access is disabled (ARM: publicNetworkAccess=Disabled', TRACK_3744], lacks: ['workspace admin'],
      breaks: 'the Disabled reading is dropped, or the class fails the job' },
    { name: `network 403 ${shape}, ARM unreadable`, env: { S_GET_CODE: '403', S_GET_BODY: body, S_ARM: 'unreadable' },
      reason: 'network_blocked', stepRc: 1, gateRc: 0, err: 0, warn: 1, get: 1,
      has: ['could not be read from ARM', TRACK_3744], lacks: ['public network access is disabled', 'although ARM reports'],
      breaks: 'an ARM read that failed is reported as a Disabled/Enabled reading' },
  );
}

const ROWS = [
  // ── network_blocked: the ONLY class that warns (gate rc 0) ────────────────
  ...NET_ROWS,
  // ── transport_error: FAILS the job, after a bounded retry ────────────────
  { name: 'curl exit 6 (DNS) on every GET', env: { S_GET_CODE: '000', S_GET_RC: '6' },
    reason: 'transport_error', stepRc: 1, gateRc: 1, err: 1, warn: 0, get: 3, sleeps: ['5', '10'],
    has: ['curl exit 6: could not resolve host', 'after 3 attempt(s)', 'this step did not establish why', 'the attempt count is in the cause above'], lacks: ['refused', 'retried DNS'],
    breaks: 'DNS failure classed network_blocked (warns, rc 0), the retry removed (1 GET) or unbounded (>3 GETs)' },
  { name: 'curl exit 28 (timeout) on every GET', env: { S_GET_CODE: '000', S_GET_RC: '28' },
    reason: 'transport_error', stepRc: 1, gateRc: 1, err: 1, warn: 0, get: 3, sleeps: ['5', '10'],
    has: ['curl exit 28: operation timed out'], lacks: ['refused'],
    breaks: 'a timeout warned as a network refusal, or not retried' },
  { name: 'curl exit 60 (TLS certificate) is not retried', env: { S_GET_CODE: '000', S_GET_RC: '60' },
    reason: 'transport_error', stepRc: 1, gateRc: 1, err: 1, warn: 0, get: 1, sleeps: [],
    has: ['curl exit 60: peer certificate', 'after 1 attempt(s)'], lacks: ['refused'],
    breaks: 'a TLS failure warned as a network block, or retried as if transient' },
  { name: 'GET timeout then success: the retry recovers', env: { S_GET_CODE: '000 200', S_GET_RC: '28 0', S_GET_BODY: '{"warehouses":[{"name":"loom-default","id":"w-reuse"}]}' },
    reason: '', stepRc: 0, gateRc: 0, err: 0, warn: 0, get: 2, sleeps: ['5'],
    has: ['No gated step failed.'], lacks: [],
    breaks: 'the retry is removed (the first 28 fails the step)' },
  // ── a create whose outcome is unknown is NEVER followed by a second create ─
  { name: 'create times out, re-list finds nothing: one POST, no classic', env: { S_GET_CODE: '200', S_GET_BODY: EMPTY_LIST, S_POST_CODE: '000', S_POST_RC: '28' },
    reason: 'transport_error', stepRc: 1, gateRc: 1, err: 1, warn: 0, get: 2, post: 1, sleeps: [], phase: 'create',
    has: ['curl exit 28', NOT_LANDED], lacks: ['refused', 'retrying as a classic'], stepLacks: ['returned no warehouse id (HTTP 000'],
    breaks: 'a create with an unknown outcome is followed by the classic create (2 POSTs), or not re-listed (1 GET)' },
  { name: 'create times out, re-list finds the landed warehouse: reuse it', env: { S_GET_CODE: '200 200', S_GET_BODY_1: EMPTY_LIST, S_GET_BODY_2: LANDED, S_POST_CODE: '000', S_POST_RC: '28' },
    reason: '', stepRc: 0, gateRc: 0, err: 0, warn: 0, get: 2, post: 1, wired: 'w-landed',
    has: ['No gated step failed.'], lacks: ['retrying as a classic'],
    breaks: 'the re-list is removed (the step fails) or a second create is sent' },
  { name: 'create 503 JSON, re-list finds nothing: one POST', env: { S_GET_CODE: '200', S_GET_BODY: EMPTY_LIST, S_POST_CODE: '503', S_POST_BODY: '{"error_code":"TEMPORARILY_UNAVAILABLE","message":"try later"}' },
    reason: 'http_error', stepRc: 1, gateRc: 1, err: 1, warn: 0, get: 2, post: 1, phase: 'create',
    has: ['HTTP 503', NOT_LANDED], lacks: ['retrying as a classic'],
    breaks: 'a 5xx create (outcome unknown) falls through to the classic create' },
  { name: 'create times out and the re-list cannot read: unknown, one POST', env: { S_GET_CODE: '200 000', S_GET_RC: '0 7', S_GET_BODY: EMPTY_LIST, S_POST_CODE: '000', S_POST_RC: '28' },
    reason: 'transport_error', stepRc: 1, gateRc: 1, err: 1, warn: 0, get: 4, post: 1, sleeps: ['5', '10'], phase: 'create',
    has: ['curl exit 28', 'whether the create landed is unknown'], lacks: [NOT_LANDED],
    breaks: 'a failed re-list is reported as "found no loom-default"' },
  { name: 'serverless rejected with 4xx JSON, classic succeeds', env: { S_GET_CODE: '200', S_GET_BODY: EMPTY_LIST, S_POST_CODE: '400 200', S_POST_BODY_1: '{"error_code":"INVALID_PARAMETER_VALUE","message":"serverless not available"}', S_POST_BODY_2: '{"id":"w-classic"}' },
    reason: '', stepRc: 0, gateRc: 0, err: 0, warn: 0, get: 1, post: 2, wired: 'w-classic',
    has: ['No gated step failed.'], lacks: [], stepHas: ['Serverless create was rejected (HTTP 400'],
    breaks: 'the classic fallback is removed after a definite rejection' },
  { name: 'create 400 quota on both', env: { S_GET_CODE: '200', S_GET_BODY: EMPTY_LIST, S_POST_CODE: '400', S_POST_BODY: '{"error_code":"QUOTA_EXCEEDED","message":"quota"}' },
    reason: 'http_error', stepRc: 1, gateRc: 1, err: 1, warn: 0, get: 1, post: 2, phase: 'create',
    has: ['QUOTA_EXCEEDED: quota', 'Class: configuration or capacity'], lacks: [NOT_LANDED],
    breaks: 'an API error exits 0 (fail_with exit 0), or a definite rejection is re-listed' },
  { name: 'create 200 JSON without an id: re-list, one POST', env: { S_GET_CODE: '200', S_GET_BODY: EMPTY_LIST, S_POST_CODE: '200', S_POST_BODY: '{"state":"STARTING"}' },
    reason: 'no_id_in_response', stepRc: 1, gateRc: 1, err: 1, warn: 0, get: 2, post: 1, phase: 'create',
    has: ['Class: defect', NOT_LANDED], lacks: ['retrying as a classic'],
    breaks: 'a 2xx without an id is treated as success, or followed by the classic create' },
  // ── the phrase outside the 403 shape is NOT network_blocked ──────────────
  { name: '500 JSON whose message STARTS with the phrase', env: { S_GET_CODE: '500', S_GET_BODY: JSON.stringify({ error_code: 'X', message: `${NET_PLAIN}` }) },
    reason: 'http_error', stepRc: 1, gateRc: 1, err: 1, warn: 0, get: 1,
    has: ['HTTP 500'], lacks: ['refused', TRACK_3744],
    breaks: 'the HTTP 403 status check is dropped (review arm D)' },
  { name: '400 JSON whose message STARTS with the phrase', env: { S_GET_CODE: '400', S_GET_BODY: JSON.stringify({ error_code: 'X', message: `${NET_PLAIN}` }) },
    reason: 'http_error', stepRc: 1, gateRc: 1, err: 1, warn: 0, get: 1,
    has: ['HTTP 400'], lacks: ['refused', TRACK_3744],
    breaks: 'the HTTP 403 status check is dropped, or loosened to any 4xx' },
  { name: '500 plain text that STARTS with the phrase', env: { S_GET_CODE: '500', S_GET_BODY: NET_PLAIN },
    reason: 'not_json', stepRc: 1, gateRc: 1, err: 1, warn: 0, get: 1,
    has: ['was not JSON'], lacks: ['refused', TRACK_3744],
    breaks: 'the plain-text read runs on a status other than 403' },
  { name: '500 JSON whose message contains the phrase', env: { S_GET_CODE: '500', S_GET_BODY: '{"error_code":"INTERNAL_ERROR","message":"upstream said: unauthorized network access"}' },
    reason: 'http_error', stepRc: 1, gateRc: 1, err: 1, warn: 0, get: 1,
    has: ['HTTP 500'], lacks: ['refused'],
    breaks: 'the phrase matched anywhere, on any status (the first review\'s B1 shape)' },
  { name: '502 HTML from a proxy containing the phrase', env: { S_GET_CODE: '502', S_GET_BODY: '<html><body>502 Bad Gateway. Unauthorized network access to workspace</body></html>' },
    reason: 'not_json', stepRc: 1, gateRc: 1, err: 1, warn: 0, get: 1,
    has: ['HTML, not JSON'], lacks: ['refused'],
    breaks: 'the phrase matched in a non-JSON body on a non-403 status' },
  { name: '403 JSON whose message only CONTAINS the phrase', env: { S_GET_CODE: '403', S_GET_BODY: '{"error_code":"PERMISSION_DENIED","message":"denied; not an Unauthorized network access to workspace case"}' },
    reason: 'auth_refused', stepRc: 1, gateRc: 1, err: 1, warn: 0, get: 1,
    has: ['Class: permission'], lacks: [TRACK_3744],
    breaks: 'the JSON .message test is a substring match instead of a prefix match' },
  { name: '403 plain text that only CONTAINS the phrase', env: { S_GET_CODE: '403', S_GET_BODY: `denied: ${NET_PLAIN}` },
    reason: 'auth_refused', stepRc: 1, gateRc: 1, err: 1, warn: 0, get: 1,
    has: ['Class: permission'], lacks: [TRACK_3744],
    breaks: 'the plain-text first-line test is a substring match instead of a prefix match' },
  // ── every other class FAILS the job ──────────────────────────────────────
  { name: '403 JSON PERMISSION_DENIED', env: { S_GET_CODE: '403', S_GET_BODY: '{"error_code":"PERMISSION_DENIED","message":"User is not authorized"}' },
    reason: 'auth_refused', stepRc: 1, gateRc: 1, err: 1, warn: 0, get: 1,
    has: ['Class: permission'], lacks: [TRACK_3744],
    breaks: 'any 401/403 classed network_blocked, or the gate warns for every class (`if true`)' },
  { name: '401 JSON', env: { S_GET_CODE: '401', S_GET_BODY: '{"error_code":"401","message":"Credential was not sent"}' },
    reason: 'auth_refused', stepRc: 1, gateRc: 1, err: 1, warn: 0, get: 1,
    has: ['Class: permission'], lacks: [TRACK_3744],
    breaks: 'a 401 classed network_blocked' },
  { name: '200 HTML sign-in page', env: { S_GET_CODE: '200', S_GET_BODY: '<html>sign in</html>' },
    reason: 'not_json', stepRc: 1, gateRc: 1, err: 1, warn: 0, get: 1,
    has: ['Class: configuration'], lacks: ['jq: parse error'],
    breaks: 'a non-JSON 200 exits 0, or reaches jq unguarded' },
  { name: 'no Databricks token', env: { S_TOKEN: 'no' },
    reason: 'no_token', stepRc: 1, gateRc: 1, err: 1, warn: 0, get: 0, phase: 'token',
    has: ['no token for the Azure Databricks resource', 'failed at token'], lacks: ['no cause recorded'],
    breaks: 'a missing token exits 0, or records no phase/detail' },
  { name: 'Console env update fails', env: { S_GET_CODE: '200', S_GET_BODY: '{"warehouses":[{"name":"loom-default","id":"w-1"}]}', S_CA_RC: '1' },
    reason: 'console_env_not_set', stepRc: 1, gateRc: 1, err: 1, warn: 0, get: 1, phase: 'console',
    has: ['Contributor on loom-console'], lacks: [],
    breaks: 'a Console env failure exits 0' },
  // ── success paths: no reason, gate silent ────────────────────────────────
  { name: 'create succeeds', env: { S_GET_CODE: '200', S_GET_BODY: EMPTY_LIST, S_POST_CODE: '200', S_POST_BODY: '{"id":"w-new"}' },
    reason: '', stepRc: 0, gateRc: 0, err: 0, warn: 0, get: 1, post: 1, wired: 'w-new',
    has: ['No gated step failed.'], lacks: [],
    breaks: 'a successful create records a reason or fails' },
  { name: 'no Databricks host bound: skip', env: { DBX_HOST: '' },
    reason: '', stepRc: 0, gateRc: 0, err: 0, warn: 0, get: 0,
    has: ['No gated step failed.'], lacks: [],
    breaks: 'the no-host skip starts failing' },
];

for (const row of ROWS) {
  test(`${row.name} -> ${row.reason || 'no reason'}, step rc ${row.stepRc}, gate rc ${row.gateRc} (breaks if: ${row.breaks})`, { skip: SKIP }, () => {
    const r = scenario(row);
    const ctx = `\n--- step log ---\n${r.stepLog}\n--- gate log ---\n${r.gateLog}`;
    assert.equal(r.outputs.reason ?? '', row.reason, `recorded reason${ctx}`);
    assert.equal(r.stepRc, row.stepRc, `step exit code${ctx}`);
    assert.equal(r.gateRc, row.gateRc, `gate exit code${ctx}`);
    assert.equal(r.errors.length, row.err, `::error:: count${ctx}`);
    assert.equal(r.warnings.length, row.warn, `::warning:: count${ctx}`);
    assert.equal(count(r.curl, 'GET'), row.get, `GET attempts${ctx}`);
    if (row.post !== undefined) assert.equal(count(r.curl, 'POST'), row.post, `POST attempts${ctx}`);
    if (row.sleeps !== undefined) assert.deepEqual(r.sleeps, row.sleeps, `backoff sleeps${ctx}`);
    if (row.phase !== undefined) assert.equal(r.outputs.phase, row.phase, `recorded phase${ctx}`);
    for (const needle of row.has) assert.ok(r.gateLog.includes(needle), `gate output lacks "${needle}"${ctx}`);
    for (const needle of row.lacks) assert.ok(!`${r.stepLog}${r.gateLog}`.includes(needle), `output contains "${needle}"${ctx}`);
    for (const needle of row.stepHas ?? []) assert.ok(r.stepLog.includes(needle), `step output lacks "${needle}"${ctx}`);
    for (const needle of row.stepLacks ?? []) assert.ok(!r.stepLog.includes(needle), `step output contains "${needle}"${ctx}`);
    assert.ok(!`${r.stepLog}${r.gateLog}`.includes(TOKEN), 'the Databricks token was printed');
    // Positive pair for the absence checks above: the step really ran (it called
    // az for a token unless the host was unbound).
    if (row.env.DBX_HOST !== '') assert.ok(r.az.some((l) => l.startsWith('az account get-access-token')), `the step never asked az for a token${ctx}`);
    // R6 bounded: every curl call carries both time limits (breaks if either flag is dropped).
    assert.equal(r.limits.length, r.curl.length, `curl limit log does not match the call count${ctx}`);
    for (const l of r.limits) assert.match(l, / ct=1 mt=1$/, `a curl call lacked --connect-timeout 15 / --max-time 60: ${l}`);
    if (row.wired !== undefined) {
      assert.ok(r.az.some((l) => l.startsWith('az containerapp update') && l.includes('--subscription sub-admin') && l.includes(`LOOM_DATABRICKS_SQL_WAREHOUSE_ID=${row.wired}`)),
        `loom-console was not updated with warehouse ${row.wired} in the admin subscription${ctx}`);
    }
  });
}

test('the warehouse step is bounded by timeout-minutes (breaks if: the key is removed, or raised past 30)', { skip: SKIP }, () => {
  const { timeoutMinutes } = lift();
  const n = Number(timeoutMinutes);
  assert.ok(Number.isInteger(n) && n > 0 && n <= 30, `timeout-minutes is ${timeoutMinutes}`);
});

test('gate: a skipped or unreached warehouse step is not reported; a failure with no reason fails (breaks if: an empty outcome fails the job, or an unrecorded failure warns)', { skip: SKIP }, () => {
  const { gateRun, envMap } = lift();
  const dir = mkdtempSync(path.join(tmpdir(), 'gate4765-'));
  const file = path.join(dir, 'gate.sh');
  writeFileSync(file, gateRun, 'utf8');
  const run = (outcome, reason) => {
    const env = { ...process.env };
    for (const [k, v] of Object.entries(envMap)) env[k] = v.outcome ? outcome : (v.output === 'reason' ? reason : '');
    const g = spawnSync('bash', [posix(file)], { encoding: 'utf8', env });
    return { rc: g.status, out: `${g.stdout}${g.stderr}` };
  };
  for (const outcome of ['skipped', '', 'success']) {
    const g = run(outcome, '');
    assert.equal(g.rc, 0, `outcome '${outcome}' -> gate rc ${g.rc}\n${g.out}`);
    assert.ok(g.out.includes('No gated step failed.'), `outcome '${outcome}' did not print the no-failure line\n${g.out}`);
    assert.ok(!g.out.includes('::error::') && !g.out.includes('::warning::'), `outcome '${outcome}' annotated\n${g.out}`);
  }
  const u = run('failure', '');
  assert.equal(u.rc, 1, `an unrecorded failure must fail the job\n${u.out}`);
  assert.ok(u.out.includes('Class: unclassified'), u.out);
  rmSync(dir, { recursive: true, force: true });
});

test('every class the gate names is exercised by a row above (breaks if: a class is added to the gate with no scenario)', { skip: SKIP }, () => {
  const { gateRun } = lift();
  const named = [...gateRun.matchAll(/^\s*([a-z_]+)\) CLASS=/gm)].map((m) => m[1]).sort();
  assert.ok(named.includes('network_blocked') && named.includes('transport_error'),
    `lifted gate names neither expected class: [${named.join(', ')}]`);
  const covered = new Set(ROWS.map((r) => r.reason));
  const missing = named.filter((c) => !covered.has(c));
  assert.deepEqual(missing, [], `gate classes with no scenario: ${missing.join(', ')}`);
  // network_blocked is the only row family allowed to leave the job green on failure.
  const warners = [...new Set(ROWS.filter((r) => r.stepRc !== 0 && r.gateRc === 0).map((r) => r.reason))];
  assert.deepEqual(warners, ['network_blocked']);
});
