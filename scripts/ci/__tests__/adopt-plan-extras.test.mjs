/**
 * discover-dlz-adopt-plan.sh — the half-supplied admin guard, and the two new
 * adopt EXTRAS (eventhubs.schemaGroup, databricks.sqlWarehouseId).
 *
 * WHAT DEFECTS THIS PINS (all measured on the live Commercial console, where
 * the four env vars below rendered EMPTY after every scheduled reconcile):
 *
 *   1. LOOM_SERVICEBUS_NAMESPACE / LOOM_BATCH_ACCOUNT. deploy-fiab-commercial
 *      passed `--admin-subscription ""` (it bound `deploy_sub`, which is '' on
 *      every schedule) with a real `--admin-rg`. The #4665 admin-RG fallback
 *      needs both, so it was skipped IN SILENCE and the plan looked exactly like
 *      "the admin RG holds nothing". The script now exits 2 on half a pair.
 *   2. LOOM_EH_SCHEMA_GROUP. Nothing in the adopt path carried the schema group,
 *      and main.bicep never passed admin-plane's eventsConfig at all.
 *   3. LOOM_DATABRICKS_SQL_WAREHOUSE_ID. main.bicep never passed the param.
 *
 * HOW. The REAL script runs against a stub `az` and a stub `curl` on PATH, so
 * the shipped control flow is what is exercised. Every test names the value
 * that turns it red.
 *
 * MUTATION RECEIPTS: see the PR body — each arm was applied to a SANDBOX COPY
 * of the script under temp/ (via DISCOVER_SCRIPT), never to the tracked tree.
 *
 * DISCLOSED, per assertion-design.md #5:
 *   - The compiled-template assertions at the bottom pin WIRING (which ARM
 *     expression feeds which param). They do not EVALUATE the ternary; the
 *     create-mode 'loom-schemas' vs '' choice is pinned only as the exact
 *     compiled expression string, so a semantically-equivalent rewrite reads
 *     red here. That is deliberate (the string IS what deploys) but it is a
 *     shape check, not a behaviour check.
 *
 * Run: node --test scripts/ci/__tests__/adopt-plan-extras.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// DISCOVER_SCRIPT lets a mutation run point this suite at a sandbox copy.
const SCRIPT = process.env.DISCOVER_SCRIPT || resolve(REPO, 'scripts/csa-loom/discover-dlz-adopt-plan.sh');
const TEMPLATE = process.env.ADOPT_TEMPLATE || resolve(REPO, 'apps/fiab-console/deploy-templates/main.json');

const DLZ_SUB = '11111111-1111-1111-1111-111111111111';
const DLZ_RG = 'rg-csa-loom-dlz-default-centralus';
const ADMIN_SUB = '22222222-2222-2222-2222-222222222222';
const ADMIN_RG = 'rg-csa-loom-admin-centralus';
const EH_NS = 'evhns-loom-default-centralus';
const DBX_NAME = 'dbw-loom-default';
const DBX_HOST = 'adb-1234567890123456.7.azuredatabricks.net';
// Low-entropy placeholder, not a credential. Used only to prove where the
// token travels (curl's stdin) and where it must never appear (argv, logs).
const STUB_TOKEN = 'stubstubstubstub';

/**
 * @param {object} o
 * @param {string}  [o.eh]          eventhubs namespace name ('' = none)
 * @param {string}  [o.groups]      newline-separated schema groups the namespace lists
 * @param {boolean} [o.groupsFail]  schema-registry list exits non-zero
 * @param {boolean} [o.dbx]         a Databricks workspace exists
 * @param {boolean} [o.tokenFail]   `az account get-access-token` fails
 * @param {string}  [o.httpCode]    what curl's -w '%{http_code}' prints
 * @param {number}  [o.curlRc]      curl's exit code
 * @param {string}  [o.body]        the SQL Warehouses API body
 * @param {string[]|null} [o.admin] admin args override (null = pass none)
 */
function discover({
  eh = EH_NS,
  groups = '',
  groupsFail = false,
  dbx = false,
  tokenFail = false,
  httpCode = '200',
  curlRc = 0,
  body = '{"warehouses":[]}',
  admin = null,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adopt-extras-'));
  const curlLog = join(dir, 'curl.argv');
  const curlStdin = join(dir, 'curl.stdin');

  const az = `#!/usr/bin/env bash
Q=""; prev=""
for a in "$@"; do
  [ "$prev" = "--query" ] && Q="$a"
  prev="$a"
done
if [ "$1" = "group" ] && [ "$2" = "show" ]; then exit 0; fi
if [ "$1" = "eventhubs" ] && [ "$2" = "namespace" ] && [ "$3" = "schema-registry" ]; then
  if [ -n "\${STUB_SG_FAIL:-}" ]; then
    echo "(AuthorizationFailed) The client does not have authorization to perform action 'Microsoft.EventHub/namespaces/schemagroups/read'." >&2
    exit 1
  fi
  [ -n "\${STUB_SG:-}" ] && printf '%s\\n' "$STUB_SG"
  exit 0
fi
if [ "$1" = "eventhubs" ] && [ "$2" = "namespace" ] && [ "$3" = "list" ]; then
  printf '%s' "\${STUB_EH:-}"; exit 0
fi
if [ "$1" = "databricks" ] && [ "$2" = "workspace" ] && [ "$3" = "list" ]; then
  [ -z "\${STUB_DBX:-}" ] && exit 0
  case "$Q" in
    *workspaceUrl*) printf '%s' ${JSON.stringify(DBX_HOST)} ;;
    *) printf '%s' ${JSON.stringify(DBX_NAME)} ;;
  esac
  exit 0
fi
if [ "$1" = "account" ] && [ "$2" = "get-access-token" ]; then
  if [ -n "\${STUB_TOKEN_FAIL:-}" ]; then echo "AADSTS500011: resource principal not found" >&2; exit 1; fi
  printf '%s\\n' ${JSON.stringify(STUB_TOKEN)}; exit 0
fi
# storage / synapse / adf / servicebus / batch: absent.
exit 0
`;
  const curl = `#!/usr/bin/env bash
printf '%s\\n' "$@" > ${JSON.stringify(curlLog.replace(/\\/g, '/'))}
cat > ${JSON.stringify(curlStdin.replace(/\\/g, '/'))}
OUT=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && OUT="$a"; prev="$a"; done
[ -n "$OUT" ] && printf '%s' "$STUB_BODY" > "$OUT"
[ "\${STUB_CURL_RC:-0}" != "0" ] && echo "curl: (6) Could not resolve host" >&2
printf '%s' "$STUB_CODE"
exit "\${STUB_CURL_RC:-0}"
`;
  for (const [n, s] of [['az', az], ['curl', curl]]) {
    writeFileSync(join(dir, n), s);
    chmodSync(join(dir, n), 0o755);
  }

  const args = ['--dlz-subscription', DLZ_SUB, '--dlz-rg', DLZ_RG];
  if (admin) args.push(...admin);

  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      STUB_EH: eh,
      STUB_SG: groups,
      STUB_SG_FAIL: groupsFail ? '1' : '',
      STUB_DBX: dbx ? '1' : '',
      STUB_TOKEN_FAIL: tokenFail ? '1' : '',
      STUB_CODE: httpCode,
      STUB_CURL_RC: String(curlRc),
      STUB_BODY: body,
    },
  });
  const stdout = r.stdout || '';
  let plan = null;
  if (r.status === 0) {
    try {
      plan = JSON.parse(stdout.trim() || '{}');
    } catch {
      throw new Error(`script did not emit parseable JSON.\nstdout: ${stdout}\nstderr: ${r.stderr}`);
    }
  }
  return {
    plan,
    stdout,
    stderr: r.stderr || '',
    status: r.status,
    curlArgv: existsSync(curlLog) ? readFileSync(curlLog, 'utf8') : null,
    curlStdin: existsSync(curlStdin) ? readFileSync(curlStdin, 'utf8') : null,
  };
}

test('the shipped discovery script is present — these tests drive the REAL script', () => {
  assert.ok(existsSync(SCRIPT), `${SCRIPT} must exist`);
});

// ─────────────────────────────────────────────────────────────────────────────
// POSITIVE CONTROL — both extras populated in one run. If the stubs never
// answered, every "no key" case below would pass while measuring nothing.
// BREAKS ON: a stub arm that never fires (e.g. `az`/`curl` not on PATH), or
// the script dropping either extra from the plan.
// ─────────────────────────────────────────────────────────────────────────────
test('CONTROL: schema group AND warehouse id both reach the plan', () => {
  const { plan, status } = discover({
    groups: 'loom-schemas',
    dbx: true,
    body: '{"warehouses":[{"id":"d1e2f3a4b5c6","name":"loom-default"}]}',
  });
  assert.equal(status, 0);
  assert.equal(plan.eventhubs?.extra?.schemaGroup, 'loom-schemas');
  assert.equal(plan.databricks?.extra?.sqlWarehouseId, 'd1e2f3a4b5c6');
  assert.equal(plan.databricks?.extra?.hostname, DBX_HOST, 'the pre-existing hostname extra must survive');
});

// ── 1. half-supplied admin coordinates ──────────────────────────────────────
// BREAKS ON: deleting the guard — the script then exits 0 with a plan that has
// no servicebus/batch keys, which is the scheduled-run defect verbatim.
test('an EMPTY --admin-subscription beside a real --admin-rg exits 2, loudly', () => {
  const r = discover({ admin: ['--admin-subscription', '', '--admin-rg', ADMIN_RG] });
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stderr, /::error::\[discover-dlz-adopt\] admin coordinates are HALF-supplied/);
  assert.match(r.stderr, /--admin-subscription is EMPTY/);
  assert.equal(r.stdout.trim(), '', 'a refused run must not emit a plan a caller could mistake for a real one');
});

// BREAKS ON: a guard that checks only the rg-without-sub direction.
test('the mirror half (--admin-subscription with no --admin-rg) also exits 2', () => {
  const r = discover({ admin: ['--admin-subscription', ADMIN_SUB] });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--admin-subscription is set/);
});

// Paired positive (assertion-design #4): the guard must not refuse a WHOLE pair.
// BREAKS ON: a guard that fires on any admin argument at all.
test('both admin halves supplied: no refusal, plan emitted', () => {
  const r = discover({ admin: ['--admin-subscription', ADMIN_SUB, '--admin-rg', ADMIN_RG] });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /HALF-supplied/);
  assert.equal(r.plan.eventhubs?.target?.name, EH_NS);
});

// ── 2. schema group choice ──────────────────────────────────────────────────
// `loom-schemas` is listed SECOND on purpose. BREAKS ON: a `[0]`/first-line
// pick (→ 'aaa-first'), or dropping the preference (2 groups → ambiguous → no
// key at all).
test('loom-schemas is preferred over another group, whatever the list order', () => {
  const { plan, stderr } = discover({ groups: 'aaa-first\nloom-schemas' });
  assert.equal(plan.eventhubs?.extra?.schemaGroup, 'loom-schemas');
  assert.match(stderr, /schema group = loom-schemas \(the preferred name; 2 group\(s\)/);
});

// BREAKS ON: deleting the single-group arm (→ no key).
test('a namespace with exactly ONE group adopts that group', () => {
  const { plan, stderr } = discover({ groups: 'orders' });
  assert.equal(plan.eventhubs?.extra?.schemaGroup, 'orders');
  assert.match(stderr, /the ONLY group/);
});

// BREAKS ON: picking the first of several (→ 'alpha' would be adopted).
test('several groups and none is loom-schemas: adopts NONE and says why', () => {
  const { plan, stderr } = discover({ groups: 'alpha\nbeta' });
  assert.equal(plan.eventhubs?.mode, 'adopt', 'the namespace itself is still adopted');
  assert.equal(plan.eventhubs?.extra?.schemaGroup, undefined);
  assert.match(stderr, /::warning::.*holds 2 schema groups/);
});

// BREAKS ON: emitting `"schemaGroup":""` or an empty `extra:{}` — json_obj must
// omit empty values. Also on the notice being demoted to silence.
test('a namespace read with zero groups: no key, a ::notice:: (a measured negative)', () => {
  const { plan, stderr } = discover({ groups: '' });
  assert.equal(plan.eventhubs?.target?.name, EH_NS);
  assert.equal(plan.eventhubs?.extra, undefined);
  assert.match(stderr, /::notice::.*holds NO schema groups/);
  assert.doesNotMatch(stderr, /could NOT list schema groups/);
});

// BREAKS ON: reading through q()'s `|| true` (or any collapse of failure into
// the zero-groups arm) — stderr would then say "holds NO schema groups".
// ALSO BREAKS ON (#3701 property — a failed EXTRA lookup must never cost the
// BASE adopt entry): `EH=""` in the read-failure branch drops `eventhubs` from
// the plan, and the target-name pin below goes RED (reviewer mutation M2).
test('an UNREADABLE namespace is reported UNKNOWN, never "no groups"', () => {
  const { plan, stderr, status } = discover({ groupsFail: true });
  assert.equal(status, 0, 'an unreadable schema registry must not fail the deploy');
  assert.equal(plan.eventhubs?.target?.name, EH_NS, 'the BASE eventhubs adopt entry must survive a failed schema-group read');
  assert.equal(plan.eventhubs?.mode, 'adopt');
  assert.equal(plan.eventhubs?.extra, undefined);
  assert.match(stderr, /::warning::.*could NOT list schema groups.*UNKNOWN, not 'none'/);
  assert.match(stderr, /AuthorizationFailed/, 'the az stderr must be surfaced, not swallowed');
  assert.doesNotMatch(stderr, /holds NO schema groups/);
});

// ── 3. the SQL warehouse, three states ──────────────────────────────────────
// BREAKS ON: taking the first warehouse regardless of name (→ 'aaaa0000').
test('found: the id of the warehouse NAMED loom-default is adopted', () => {
  const { plan, stderr } = discover({
    dbx: true,
    body: '{"warehouses":[{"id":"aaaa0000","name":"someone-elses"},{"id":"d1e2f3a4b5c6","name":"loom-default"}]}',
  });
  assert.equal(plan.databricks?.extra?.sqlWarehouseId, 'd1e2f3a4b5c6');
  assert.match(stderr, /databricks SQL warehouse 'loom-default' = d1e2f3a4b5c6 \(preference: loom-default, then loom-governance\)/);
});

// The Gov writers (gov-provision-dbx-sql.yml, gov-provision-dbx-sql-invnet.yml)
// create `loom-governance`. BREAKS ON: a lookup that knows only `loom-default`
// (→ no key, and the NONE notice), or on printing the wrong name in the log.
test('found: a workspace with only loom-governance adopts it, and says which name matched', () => {
  const { plan, stderr } = discover({
    dbx: true,
    body: '{"warehouses":[{"id":"aaaa0000","name":"other"},{"id":"9a8b7c6d5e4f","name":"loom-governance"}]}',
  });
  assert.equal(plan.databricks?.extra?.sqlWarehouseId, '9a8b7c6d5e4f');
  assert.match(stderr, /databricks SQL warehouse 'loom-governance' = 9a8b7c6d5e4f/);
  assert.doesNotMatch(stderr, /lists NO warehouse/);
});

// Both names present, `loom-governance` listed FIRST so list order and the
// preference disagree. BREAKS ON: a swapped preference or a first-match-in-list
// pick (→ '9a8b7c6d5e4f'). The two ids are distinct, so a swap is visible.
test('both names present: loom-default is preferred over loom-governance, whatever the list order', () => {
  const { plan, stderr } = discover({
    dbx: true,
    body: '{"warehouses":[{"id":"9a8b7c6d5e4f","name":"loom-governance"},{"id":"d1e2f3a4b5c6","name":"loom-default"}]}',
  });
  assert.equal(plan.databricks?.extra?.sqlWarehouseId, 'd1e2f3a4b5c6');
  assert.match(stderr, /databricks SQL warehouse 'loom-default' = d1e2f3a4b5c6/);
});

// BREAKS ON: falling through to `loom-governance` when the PREFERRED name is
// duplicated (→ '9a8b7c6d5e4f'), or on picking one of the duplicates.
test('two loom-default warehouses: adopts NONE, and does not fall back to loom-governance', () => {
  const { plan, stderr } = discover({
    dbx: true,
    body: '{"warehouses":[{"id":"d1e2f3a4b5c6","name":"loom-default"},{"id":"0f0f0f0f","name":"loom-default"},{"id":"9a8b7c6d5e4f","name":"loom-governance"}]}',
  });
  assert.equal(plan.databricks?.extra?.hostname, DBX_HOST);
  assert.equal(plan.databricks?.extra?.sqlWarehouseId, undefined);
  assert.match(stderr, /::warning::.*lists 2 warehouses named 'loom-default'; adopting NONE/);
});

// Neither name. BREAKS ON: demoting the no-match notice, on emitting an empty
// key, or on adopting some other warehouse (→ 'aaaa0000'). The fixture's only
// warehouse is named 'other', the case the Azure Government writers can bind
// (they fall back to the first warehouse of ANY name), so the notice must say
// that name is not adopted. ALSO BREAKS ON: restoring the earlier notice, which
// said "the next deploy after one exists binds it" with no qualifier (false
// here: 'other' exists and the next deploy still binds nothing).
test('API answered 200 with neither loom-default nor loom-governance: no key, a ::notice::, no ::warning::', () => {
  const { plan, stderr } = discover({ dbx: true, body: '{"warehouses":[{"id":"aaaa0000","name":"other"}]}' });
  assert.equal(plan.databricks?.extra?.hostname, DBX_HOST);
  assert.equal(plan.databricks?.extra?.sqlWarehouseId, undefined);
  assert.match(stderr, /::notice::.*answered 200 and lists NO warehouse named 'loom-default' or 'loom-governance'/);
  assert.match(stderr, /::notice::.*a warehouse under any other name is not adopted/);
  assert.doesNotMatch(stderr, /the next deploy after one exists binds it/);
  assert.doesNotMatch(stderr, /::warning::.*SQL Warehouses API/);
});

// The load-bearing distinction. BREAKS ON: collapsing the non-200 branch into
// the NONE branch (stderr would say "lists NO warehouse" — a false negative
// that reads as "not created yet" when the truth is "could not look").
test('API REFUSED (403): no key, a ::warning:: naming HTTP 403 — never "absent"', () => {
  const { plan, stderr, status } = discover({ dbx: true, httpCode: '403', body: '{"error_code":"PERMISSION_DENIED"}' });
  assert.equal(status, 0);
  assert.equal(plan.databricks?.extra?.hostname, DBX_HOST);
  assert.equal(plan.databricks?.extra?.sqlWarehouseId, undefined);
  assert.match(stderr, /::warning::.*did NOT answer 200 \(HTTP 403, curl exit 0\).*UNKNOWN — not 'absent'/);
  assert.match(stderr, /likely not a user of that workspace/);
  assert.doesNotMatch(stderr, /at the NETWORK layer/, 'a plain 403 must not be blamed on the network');
  assert.match(stderr, /PERMISSION_DENIED/, 'the body excerpt must be surfaced');
  assert.doesNotMatch(stderr, /lists NO warehouse/);
});

// The refusal shape seen on the Commercial estate: a 403 whose body names
// network access. BREAKS ON: deleting the network-access branch (the warning
// would blame workspace membership, a false cause under deploy-integrity R7),
// or matching it on a plain 403 (the test above goes RED).
test('API REFUSED at the network layer (403 "Unauthorized network access"): the warning says NETWORK, not RBAC', () => {
  const { plan, stderr, status } = discover({
    dbx: true,
    httpCode: '403',
    body: '{"error_code":"403","message":"Unauthorized network access to workspace: 1234567890123456"}',
  });
  assert.equal(status, 0);
  assert.equal(plan.databricks?.extra?.hostname, DBX_HOST, 'the BASE databricks adopt entry must survive');
  assert.equal(plan.databricks?.extra?.sqlWarehouseId, undefined);
  assert.match(stderr, /refused this runner at the NETWORK layer/);
  assert.doesNotMatch(stderr, /likely not a user of that workspace/);
});

// The CAUSE text of that warning (deploy-integrity R7). The body proves only
// that the refusal is network-layer; two workspace controls produce it, and
// the script reads neither. BREAKS ON: a warning that names ONE control as the
// cause, e.g. the earlier "a workspace with publicNetworkAccess Disabled is
// reachable only through its private endpoint, so a hosted runner cannot read
// it at all" (this test goes RED against it), or one that drops the IP access
// list, the "NOT established" disclosure, or the pointer to the tracked
// in-VNet producer.
test('network-layer 403: the warning names BOTH candidate controls and says which refused was NOT established', () => {
  const { stderr } = discover({
    dbx: true,
    httpCode: '403',
    body: '{"error_code":"403","message":"Unauthorized network access to workspace: 1234567890123456"}',
  });
  const warning = stderr.split('\n').find((l) => l.includes('did NOT answer 200')) ?? '';
  assert.match(warning, /refused this runner at the NETWORK layer/, 'positive: the refusal itself is named');
  assert.match(warning, /public network access set to Disabled/, 'candidate 1 must be named');
  // Anchored on "or a workspace": the disclosure sentence also says "IP access
  // list", so a bare /IP access list/ stays green when the candidate is dropped.
  assert.match(warning, /or a workspace IP access list/, 'candidate 2 must be named');
  assert.match(warning, /Which one refused it was NOT established/, 'the unresolved cause must be disclosed');
  assert.match(warning, /#3744/, 'the tracked in-VNet producer must be named');
  assert.doesNotMatch(warning, /publicNetworkAccess Disabled/, 'a single control must not be asserted as the cause');
  assert.doesNotMatch(warning, /cannot read it at all/, 'an unestablished remedy must not be asserted');
});

// BREAKS ON: `set -e` aborting on curl's non-zero exit (status would be 6),
// or on an empty http_code being printed as '' instead of 000.
// ALSO BREAKS ON (#3701): the caller setting `DBX_N=""` when the host is
// unreachable, which drops the BASE databricks entry — the hostname pin goes
// RED (reviewer mutation M3).
test('host UNREACHABLE: HTTP 000 and the curl exit are named, the script continues', () => {
  const { plan, stderr, status } = discover({ dbx: true, httpCode: '', curlRc: 6, body: '' });
  assert.equal(status, 0);
  assert.equal(plan.databricks?.extra?.hostname, DBX_HOST, 'the BASE databricks adopt entry must survive an unreachable host');
  assert.equal(plan.databricks?.target?.name, DBX_NAME);
  assert.equal(plan.databricks?.extra?.sqlWarehouseId, undefined);
  assert.match(stderr, /HTTP 000, curl exit 6/);
});

// BREAKS ON: calling the API with an empty bearer, or reporting "absent".
test('no Databricks token: UNKNOWN warning, and the API is never called', () => {
  const { plan, stderr, curlArgv } = discover({ dbx: true, tokenFail: true });
  assert.equal(plan.databricks?.extra?.hostname, DBX_HOST);
  assert.equal(plan.databricks?.extra?.sqlWarehouseId, undefined);
  assert.match(stderr, /::warning::.*could NOT obtain an Azure Databricks AAD token \(az exit 1\)/);
  assert.equal(curlArgv, null, 'curl must not run without a token');
});

// BREAKS ON: a JSON array body tripping `set -e` through an uncaught python
// AttributeError (status would be non-zero and no plan emitted), or on the
// BASE databricks entry being dropped when the body is unreadable.
test('a 200 body of the wrong SHAPE degrades to a warning, not a dead deploy', () => {
  const { plan, stderr, status } = discover({ dbx: true, body: '[]' });
  assert.equal(status, 0, stderr);
  assert.equal(plan.databricks?.extra?.hostname, DBX_HOST, 'the BASE databricks adopt entry must survive');
  assert.equal(plan.databricks?.extra?.sqlWarehouseId, undefined);
  assert.match(stderr, /not the documented JSON \(ERR:AttributeError\)/);
});

// The OTHER wrong shape: a well-formed object whose warehouses are not objects.
// `[]` above fails at `d.get` and never reaches the per-warehouse read, so it
// cannot witness this one. BREAKS ON: the per-warehouse match being moved out
// of the try (an uncaught AttributeError → no verdict token → the NONE/ID arms
// never print and the ERR warning is missing).
test('a 200 body whose warehouses are not objects also degrades to a warning', () => {
  const { plan, stderr, status } = discover({ dbx: true, body: '{"warehouses":["loom-default"]}' });
  assert.equal(status, 0, stderr);
  assert.equal(plan.databricks?.extra?.hostname, DBX_HOST, 'the BASE databricks adopt entry must survive');
  assert.equal(plan.databricks?.extra?.sqlWarehouseId, undefined);
  assert.match(stderr, /not the documented JSON \(ERR:AttributeError\)/);
});

// Token hygiene. BREAKS ON: `curl -H "Authorization: Bearer $tok"` (the token
// lands in argv, visible in /proc and in any `set -x` trace), or on echoing it.
// Plain substring checks, not RegExps built from fixture values.
test('the AAD token travels on curl STDIN only — never argv, never the log', () => {
  const r = discover({ dbx: true, body: '{"warehouses":[{"id":"d1e2f3a4b5c6","name":"loom-default"}]}' });
  assert.ok(r.curlStdin, 'curl must have been called');
  assert.ok(r.curlStdin.includes('Authorization: Bearer ' + STUB_TOKEN), `the header must arrive via --config on stdin; got:\n${r.curlStdin}`);
  assert.ok(!r.curlArgv.includes(STUB_TOKEN), `token found in curl argv:\n${r.curlArgv}`);
  assert.ok(!r.stderr.includes(STUB_TOKEN), 'token found in stderr');
  assert.ok(!r.stdout.includes(STUB_TOKEN), 'token found in stdout');
  assert.match(r.curlArgv, /\n--config\n-\n/);
  assert.ok(
    r.curlArgv.includes('https://' + DBX_HOST + '/api/2.0/sql/warehouses'),
    `curl must call the SQL Warehouses list endpoint on the discovered host; argv:\n${r.curlArgv}`,
  );
});

// BREAKS ON: minting a token / calling curl when no workspace was discovered.
test('no Databricks workspace: no token requested, no API call, no databricks key', () => {
  const { plan, curlArgv } = discover({ dbx: false });
  assert.equal(plan.databricks, undefined);
  assert.equal(curlArgv, null);
  assert.equal(plan.eventhubs?.target?.name, EH_NS, 'positive pair: the run still produced a plan');
});

// ── 4. the compiled template (what actually deploys) ────────────────────────
// Asserted against the SHIPPED compiled artifact (ADOPT_TEMPLATE overrides it
// for a pre-regeneration check). BREAKS ON: main.bicep not passing either
// value, passing a literal '', or reading the wrong adopt key/field.
function adminPlaneModule(tpl) {
  const resources = Array.isArray(tpl.resources) ? tpl.resources : Object.values(tpl.resources);
  const m = resources.find(
    (r) => r && typeof r === 'object' && r.type === 'Microsoft.Resources/deployments' &&
      JSON.stringify(r.name ?? '').includes('admin-plane'),
  );
  assert.ok(m, 'the compiled template must contain the admin-plane module deployment');
  return m;
}

test('compiled template: both extras are read with adoptExtra from the right key', () => {
  const tpl = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  assert.equal(
    tpl.variables.existingEventHubSchemaGroup,
    "[__bicep.adoptExtra(parameters('adopt'), 'eventhubs', 'schemaGroup')]",
  );
  assert.equal(
    tpl.variables.existingDatabricksSqlWarehouseId,
    "[__bicep.adoptExtra(parameters('adopt'), 'databricks', 'sqlWarehouseId')]",
  );
});

test('compiled template: admin-plane receives the warehouse id and the schema group', () => {
  const tpl = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  const m = adminPlaneModule(tpl);
  const passed = m.properties.parameters;
  assert.equal(passed.loomDatabricksSqlWarehouseId?.value, "[variables('existingDatabricksSqlWarehouseId')]");
  assert.equal(
    passed.eventsConfig?.value?.loomEhSchemaGroup,
    "[if(not(empty(variables('existingEventHubSchemaGroup'))), variables('existingEventHubSchemaGroup'), if(and(variables('useSingleDlz'), variables('provisionEventHubs')), 'loom-schemas', ''))]",
  );
  assert.deepEqual(Object.keys(passed.eventsConfig.value), ['loomEhSchemaGroup'],
    'only the schema group is set; every other eventsConfigT field must keep its admin-plane default');
  // The receiving side exists under the SAME names — a rename in admin-plane
  // would otherwise make these params dead on arrival.
  const declared = m.properties.template.parameters;
  assert.ok(declared.loomDatabricksSqlWarehouseId, 'admin-plane must declare loomDatabricksSqlWarehouseId');
  assert.ok(declared.eventsConfig, 'admin-plane must declare eventsConfig');
});
