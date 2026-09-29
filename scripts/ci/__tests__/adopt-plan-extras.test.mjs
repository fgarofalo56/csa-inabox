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
// The interpreter the script would resolve without a stub. The python-failure
// tests put a `python` wrapper FIRST on PATH that fails at one call site and
// execs this for every other call, so only the site under test changes.
const REAL_PY = (spawnSync('bash', ['-c', 'command -v python || command -v python3'], { encoding: 'utf8' }).stdout || '').trim();
// A substring of each python program the failure stub targets. Each is asserted
// to occur exactly once in the script before it is used, so a rewrite of that
// program makes the test RED instead of silently leaving the stub inert.
const PY_SITE_MARKERS = {
  prefer: 'PREFER = ("loom-default", "loom-governance")',
  validity: 'json.load(sys.stdin)',
};

/**
 * @param {object} o
 * @param {string}  [o.eh]          eventhubs namespace name ('' = none)
 * @param {string}  [o.groups]      newline-separated schema groups the namespace lists
 * @param {boolean} [o.groupsFail]  schema-registry list exits non-zero
 * @param {string}  [o.groupsErr]   the stderr of that failure (default: an AuthorizationFailed line)
 * @param {boolean} [o.dbx]         a Databricks workspace exists
 * @param {boolean} [o.tokenFail]   `az account get-access-token` fails
 * @param {string}  [o.httpCode]    what curl's -w '%{http_code}' prints
 * @param {number}  [o.curlRc]      curl's exit code
 * @param {string}  [o.body]        the SQL Warehouses API body
 * @param {string[]|null} [o.admin] admin args override (null = pass none)
 * @param {''|'prefer'|'validity'} [o.pyFail] make python exit non-zero at ONE site:
 *        'prefer' = the warehouse-body parse, 'validity' = the final plan check
 */
function discover({
  eh = EH_NS,
  groups = '',
  groupsFail = false,
  groupsErr = '',
  dbx = false,
  tokenFail = false,
  httpCode = '200',
  curlRc = 0,
  body = '{"warehouses":[]}',
  admin = null,
  pyFail = '',
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
    if [ -n "\${STUB_SG_ERR:-}" ]; then
      echo "$STUB_SG_ERR" >&2
    else
      echo "(AuthorizationFailed) The client does not have authorization to perform action 'Microsoft.EventHub/namespaces/schemagroups/read'." >&2
    fi
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
  if (pyFail) {
    // Fails ONLY when its -c program contains the marker of the chosen site
    // (PY_SITE_MARKERS, each asserted present in the script by its test), and
    // execs the real interpreter for every other call.
    const marker = PY_SITE_MARKERS[pyFail];
    const py = `#!/usr/bin/env bash
case "$*" in
  *${JSON.stringify(marker)}*) echo "stub python: forced failure at the '${pyFail}' site" >&2; exit 3 ;;
esac
exec ${JSON.stringify(REAL_PY)} "$@"
`;
    writeFileSync(join(dir, 'python'), py);
    chmodSync(join(dir, 'python'), 0o755);
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
      STUB_SG_ERR: groupsErr,
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
  // The remediation is conditional on what az said. This fixture's stderr names
  // AuthorizationFailed, so the grant is named. BREAKS ON: dropping the grant
  // from the AuthorizationFailed arm.
  assert.match(stderr, /az reports AuthorizationFailed, so the deploy identity lacks read on the namespace: grant it Reader on the namespace/);
  // Whether the env is applied is not this script's to know (an infra-only
  // run applies no console env). BREAKS ON: restoring the ef310624a
  // "will render '' for this run".
  assert.match(stderr, /The plan carries no schemaGroup, so LOOM_EH_SCHEMA_GROUP would render '' if this run applies the console env/);
});

// The same failure with a stderr that does NOT name an authorization failure.
// BREAKS ON: an unconditional "grant Reader" remediation (the ef310624a text),
// which presumes an RBAC cause that a throttled or otherwise failed read did
// not establish.
test('an unreadable namespace whose az stderr is NOT AuthorizationFailed: no grant is prescribed', () => {
  const { plan, stderr, status } = discover({
    groupsFail: true,
    groupsErr: '(TooManyRequests) The request was throttled. Retry after 30 seconds.',
  });
  assert.equal(status, 0);
  assert.equal(plan.eventhubs?.target?.name, EH_NS, 'the BASE eventhubs adopt entry must survive');
  assert.match(stderr, /could NOT list schema groups.*The cause was NOT established from the az exit alone; the az stderr below is the evidence/);
  assert.match(stderr, /TooManyRequests/, 'the az stderr must be surfaced');
  assert.doesNotMatch(stderr, /grant it Reader/, 'no RBAC remediation without an RBAC cause');
  assert.doesNotMatch(stderr, /Grant the deploy identity Reader/, 'regression guard: the ef310624a unconditional remediation');
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
  // The bootstrap binds the FIRST 'loom-default' (csa-loom-post-deploy-bootstrap.yml,
  // `jq ... | head -1`) where this lookup refuses, so the two disagree on a
  // duplicate. BREAKS ON: dropping that disclosure from the AMBIG warning.
  assert.match(stderr, /lists 2 warehouses named 'loom-default'.*csa-loom-post-deploy-bootstrap\.yml does NOT refuse a duplicate 'loom-default': it binds the first one listed.*#4784/);
});

// The bootstrap disclosure is about 'loom-default' only. BREAKS ON: printing it
// for a duplicated 'loom-governance', where no bootstrap binding is in play.
test('two loom-governance warehouses (no loom-default): adopts NONE, without the loom-default bootstrap note', () => {
  const { plan, stderr } = discover({
    dbx: true,
    body: '{"warehouses":[{"id":"9a8b7c6d5e4f","name":"loom-governance"},{"id":"0e0e0e0e","name":"loom-governance"}]}',
  });
  assert.equal(plan.databricks?.extra?.hostname, DBX_HOST);
  assert.equal(plan.databricks?.extra?.sqlWarehouseId, undefined);
  assert.match(stderr, /::warning::.*lists 2 warehouses named 'loom-governance'; adopting NONE/, 'positive: the duplicate is still reported');
  assert.doesNotMatch(stderr, /does NOT refuse a duplicate 'loom-default'/);
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
// CAUSE TEXT (deploy-integrity R7): the body names neither network access nor
// an IP ACL, so the cause is NOT established, and workspace membership may be
// offered only as ONE cause that can produce it. BREAKS ON: restoring the
// ef310624a wording, which asserted the identity "is likely not a user of that
// workspace" (the not-established pin goes RED, and the doesNotMatch guard is
// the regression guard for that exact phrase).
test('API REFUSED (403): no key, a ::warning:: naming HTTP 403 — never "absent", and the cause is NOT asserted', () => {
  const { plan, stderr, status } = discover({ dbx: true, httpCode: '403', body: '{"error_code":"PERMISSION_DENIED"}' });
  assert.equal(status, 0);
  assert.equal(plan.databricks?.extra?.hostname, DBX_HOST);
  assert.equal(plan.databricks?.extra?.sqlWarehouseId, undefined);
  assert.match(stderr, /::warning::.*did NOT answer 200 \(HTTP 403, curl exit 0\).*UNKNOWN — not 'absent'/);
  assert.match(stderr, /the cause of this refusal was NOT established by this lookup/, 'a plain 403 must say its cause is unknown');
  assert.match(stderr, /One cause that produces a 401\/403 here is a deploy identity that is not a user of that workspace/,
    'membership is offered as one candidate, not as the cause');
  assert.doesNotMatch(stderr, /is likely not a user of that workspace/, 'regression guard: the ef310624a asserted cause');
  assert.doesNotMatch(stderr, /at the NETWORK layer/, 'a plain 403 must not be blamed on the network');
  assert.match(stderr, /PERMISSION_DENIED/, 'the body excerpt must be surfaced');
  assert.doesNotMatch(stderr, /lists NO warehouse/);
});

// A non-auth, non-network error status. BREAKS ON: routing every non-200 into
// the 401/403 text (the membership candidate would appear for a 500).
test('API error that is not 401/403 (HTTP 500): cause NOT established, membership not offered', () => {
  const { plan, stderr, status } = discover({ dbx: true, httpCode: '500', body: '{"error_code":"INTERNAL_ERROR"}' });
  assert.equal(status, 0);
  assert.equal(plan.databricks?.extra?.hostname, DBX_HOST, 'the BASE databricks adopt entry must survive');
  assert.match(stderr, /HTTP 500, curl exit 0\).*The cause was NOT established by this lookup; the body below is the evidence/);
  assert.doesNotMatch(stderr, /not a user of that workspace/);
});

// The refusal shape seen on the Commercial estate: a 403 whose body names
// network access. BREAKS ON: deleting the network-access branch (the warning
// would fall to the plain-401/403 text and offer workspace membership, the
// false-cause shape under deploy-integrity R7), or matching it on a plain 403
// (the test above goes RED).
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
  // Not vacuous: the plain-401/403 branch emits this phrase (test above).
  assert.doesNotMatch(stderr, /not a user of that workspace/);
});

// A Databricks IP access list refusal. The body shape is the one three
// independent codebases match (reviewer A, round 4: the Databricks-owned
// security-analysis-tool, PostHog's Databricks source, and a Genie bot's
// troubleshooting doc); it was NOT measured on this estate, and Learn quotes
// no body. It contains no "network access", so before this branch it fell to
// the plain-401/403 text and blamed workspace membership.
// BREAKS ON: deleting the IP-ACL branch (the positive pin goes RED: measured
// RED at ef310624a, arm F0), or matching it after the membership text.
const ACL_BODY = '{"error_code":"403","message":"Source IP address: 20.1.2.3 is blocked by Databricks IP ACL for workspace: 1234567890123456"}';
test('IP-ACL 403: the IP access list is named as the refusing control, never workspace membership', () => {
  const { plan, stderr, status } = discover({ dbx: true, httpCode: '403', body: ACL_BODY });
  assert.equal(status, 0);
  const warning = stderr.split('\n').find((l) => l.includes('did NOT answer 200')) ?? '';
  assert.match(warning, /an IP access list refused this runner's egress IP/, 'positive: the IP ACL is named as the refusing control');
  assert.match(warning, /Which IP access list, and what it admits, was NOT established/, 'what was not read must be disclosed');
  assert.match(warning, /#3744/, 'the tracked in-VNet producer must be named');
  // Not vacuous: the plain-401/403 branch emits this phrase for another 403.
  assert.doesNotMatch(warning, /not a user of that workspace/, 'an IP ACL block must not be blamed on membership');
  assert.doesNotMatch(warning, /at the NETWORK layer/, 'the body names an IP ACL, not network access');
  assert.equal(plan.databricks?.target?.name, DBX_NAME, 'the BASE databricks entry survives');
  assert.equal(plan.databricks?.extra?.sqlWarehouseId, undefined);
});

// The CAUSE text of the network-layer warning (deploy-integrity R7). The body
// proves only that the refusal is network-layer. More than one control can
// produce it (the script names public network access and a workspace IP access
// list, both workspace settings, and the ACCOUNT-level context-based ingress
// policies, as an OPEN list), and the script reads none of them. A body that
// names an IP ACL takes its own branch (the test above).
// BREAKS ON (each measured as a RED arm on a sandbox copy): the 033c8abae
// single-cause wording ("a workspace with publicNetworkAccess Disabled is
// reachable only through its private endpoint, so a hosted runner cannot read
// it at all"); the 072bf5b5b CLOSED-set wording (a stated count of exactly
// two controls), which fails the open-list pin; dropping either named
// candidate, the context-based ingress mention, the NOT-established
// disclosure, the "reads none of those settings" disclosure (restoring the
// 072bf5b5b "reads neither ... nor ..." pair), or the #3744 pointer.
// It does NOT detect a single cause asserted in NEW words: appending
// " The cause is the IP access list." to the warning stays green (measured,
// reviewer arm R5). The two doesNotMatch below are regression guards for the
// 033c8abae wording only, paired with the positive matches above them.
test('network-layer 403: the warning names candidate controls as an OPEN list and says which refused was NOT established', () => {
  const { stderr } = discover({
    dbx: true,
    httpCode: '403',
    body: '{"error_code":"403","message":"Unauthorized network access to workspace: 1234567890123456"}',
  });
  const warning = stderr.split('\n').find((l) => l.includes('did NOT answer 200')) ?? '';
  assert.match(warning, /refused this runner at the NETWORK layer/, 'positive: the refusal itself is named');
  assert.match(warning, /Workspace controls that can produce that refusal include /,
    'the candidate controls must be an OPEN list; a closed count of controls asserts a set the script never established');
  assert.match(warning, /public network access set to Disabled/, 'candidate 1 must be named');
  // Anchored on "or a workspace": a bare /IP access list/ could be satisfied
  // by another sentence mentioning it, so the candidate itself is pinned.
  assert.match(warning, /or a workspace IP access list/, 'candidate 2 must be named');
  assert.match(warning, /context-based ingress policies/, 'the third documented control must be named');
  assert.match(warning, /Which one refused it was NOT established/, 'the unresolved cause must be disclosed');
  assert.match(warning, /this lookup reads none of those settings/, 'the disclosure must not enumerate what was not read as a closed pair');
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
  // BREAKS ON: restoring the ef310624a "HTTP 000 means the host was
  // unreachable", which names one cause for any of curl's failure exits.
  assert.match(stderr, /HTTP 000 means curl received no HTTP response; the curl exit and stderr below say why/);
});

// BREAKS ON: calling the API with an empty bearer, or reporting "absent".
test('no Databricks token: UNKNOWN warning, and the API is never called', () => {
  const { plan, stderr, curlArgv } = discover({ dbx: true, tokenFail: true });
  assert.equal(plan.databricks?.extra?.hostname, DBX_HOST);
  assert.equal(plan.databricks?.extra?.sqlWarehouseId, undefined);
  assert.match(stderr, /::warning::.*could NOT obtain an Azure Databricks AAD token \(az exit 1\)/);
  assert.equal(curlArgv, null, 'curl must not run without a token');
  // BREAKS ON: restoring the ef310624a "renders '' for this run".
  assert.match(stderr, /could NOT obtain.*The plan carries no sqlWarehouseId, so LOOM_DATABRICKS_SQL_WAREHOUSE_ID would render '' if this run applies the console env/);
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

// The stub-marker precondition for the two python-failure tests below. If a
// marker no longer occurs exactly once, the stub cannot target its site, and
// this fails first instead of letting those tests measure an inert stub.
test('python-failure stub: each site marker occurs exactly once in the script, and a real python exists', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  for (const [site, marker] of Object.entries(PY_SITE_MARKERS)) {
    assert.equal(src.split(marker).length - 1, 1, `the '${site}' marker must occur exactly once in ${SCRIPT}`);
  }
  assert.ok(REAL_PY, 'a real python must be on PATH for the stub to exec');
});

// python ITSELF fails while reading a 200 body. Nothing is then known about the
// body, so the warning must not describe it. BREAKS ON: folding ERR:python-exit
// back into the generic arm, which said the body "is not the documented JSON"
// (the ef310624a text: the positive pin goes RED and the doesNotMatch guard
// fires). The body here IS the documented JSON with a match, so a claim that it
// is not would be false by construction.
test('python exits non-zero while reading a 200 body: the warning says the body was never parsed, not that it was malformed', () => {
  const { plan, stderr, status } = discover({
    dbx: true,
    body: '{"warehouses":[{"id":"d1e2f3a4b5c6","name":"loom-default"}]}',
    pyFail: 'prefer',
  });
  assert.equal(status, 0, stderr);
  assert.match(stderr, /stub python: forced failure at the 'prefer' site/, 'control: the stub fired at this site');
  assert.match(stderr, /answered 200, but python \(.+\) exited non-zero while reading the body, so the body was never parsed/);
  assert.doesNotMatch(stderr, /not the documented JSON/, 'regression guard: a claim about a body nobody read');
  assert.equal(plan.databricks?.target?.name, DBX_NAME, 'the BASE databricks adopt entry must survive');
  assert.equal(plan.databricks?.extra?.sqlWarehouseId, undefined, 'the valid id in the body must NOT be adopted: it was never read');
});

// The final validity check refuses a plan. Its ::error:: must reach STDERR:
// the caller captures stdout as the plan, so a refusal on stdout never reaches
// the log. BREAKS ON: dropping `>&2` from the refusal (stdout then holds the
// ::error:: line and the stderr pin goes RED), or on the check no longer
// failing closed (status 0 with a plan).
// NOT WITNESSED: the switch from `python` to "$PY". Wherever `python` resolves
// both name the same interpreter, and hiding `python` while keeping `python3`
// is not portable across the runners and workstations this suite runs on.
test('the plan validity check refuses on STDERR and emits nothing on stdout', () => {
  const r = discover({ pyFail: 'validity' });
  assert.match(r.stderr, /stub python: forced failure at the 'validity' site/, 'control: the stub fired at this site');
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stderr, /::error::\[discover-dlz-adopt\] composed an INVALID adopt plan — refusing to emit it/);
  assert.equal(r.stdout, '', 'a refused plan must leave stdout EMPTY, so the caller cannot capture the refusal as a plan');
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

// ── plan ENCODING ───────────────────────────────────────────────────────────
// Discovered names are JSON-encoded, never spliced into a quoted template. The
// fixture carries a double quote AND a backslash in both an adopt TARGET name
// (the `add` path) and an EXTRA value (the `json_obj` path), and the assertion
// is that each round-trips byte-for-byte.
// BREAKS ON: restoring the printf splice in `add` or in `json_obj` — the plan
// is then invalid JSON, the script's own validity check exits 1, and
// `status` is 1 instead of 0 (measured RED at 072bf5b5b, where both spliced).
test('a discovered name holding a double quote and a backslash round-trips into a VALID plan', () => {
  const nasty = 'evhns"q\\b';
  const group = 'grp"q\\b';
  const r = discover({ eh: nasty, groups: group });
  assert.equal(r.status, 0, `the plan must stay valid JSON; stderr: ${r.stderr}`);
  assert.equal(r.plan.eventhubs?.target?.name, nasty, 'the target name (add) must round-trip exactly');
  assert.equal(r.plan.eventhubs?.extra?.schemaGroup, group, 'the extra value (json_obj) must round-trip exactly');
  assert.equal(r.plan.eventhubs?.target?.rg, DLZ_RG, 'positive pair: an ordinary value is unchanged');
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

// ── 5. PAST the module boundary: admin-plane's own variables and the console env ──
// The two tests above stop at the arguments main.bicep PASSES. These follow the
// value into admin-plane's nested template and onto the loom-console env array,
// so a hop that silently drops the value inside admin-plane is visible.
// DISCLOSED (assertion-design #5): these are SHAPE pins on compiled ARM
// expression strings, like the ones above. They do not evaluate the
// expressions. A semantically equivalent rewrite reads red here, on purpose.

/** The loom-console app entry inside admin-plane's appDeployments module. */
function consoleEnv(adminPlaneTemplate) {
  const inner = adminPlaneTemplate.resources;
  const list = Array.isArray(inner) ? inner : Object.values(inner);
  const hits = [];
  for (const r of list) {
    const apps = r?.properties?.parameters?.apps?.value;
    if (Array.isArray(apps)) hits.push(...apps.filter((a) => a?.name === 'loom-console'));
  }
  assert.equal(hits.length, 1, 'exactly one loom-console app entry must exist in admin-plane');
  assert.equal(typeof hits[0].env, 'string', 'the console env compiles to one ARM expression string');
  return hits[0].env;
}

/**
 * Asserts the console env names `name` exactly ONCE, with exactly `value`.
 * A second entry for the same name (e.g. a later literal '') would override
 * the first at runtime, so the count is pinned as well as the value.
 */
function assertEnvEntry(env, name, value) {
  const needle = `'name', '${name}'`;
  const count = env.split(needle).length - 1;
  assert.equal(count, 1, `${name} must appear exactly once in the loom-console env, found ${count}`);
  assert.ok(
    env.includes(`createObject('name', '${name}', 'value', ${value})`),
    `${name} must render ${value}; the env entry reads: ${env.slice(env.indexOf(needle) - 20, env.indexOf(needle) + 160)}`,
  );
}

// BREAKS ON (reviewer arm A2): `var loomEhSchemaGroup = ''` in admin-plane —
// the variable then compiles to '' and the first assertion goes RED. Also on
// the env entry reading anything but that variable, or on a duplicate
// LOOM_EH_SCHEMA_GROUP / LOOM_DATABRICKS_SQL_WAREHOUSE_ID entry.
test('compiled template: the schema group and warehouse id reach the loom-console env inside admin-plane', () => {
  const tpl = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  const inner = adminPlaneModule(tpl).properties.template;
  assert.equal(
    inner.variables.loomEhSchemaGroup,
    "[coalesce(tryGet(parameters('eventsConfig'), 'loomEhSchemaGroup'), '')]",
    'admin-plane must read the schema group from the eventsConfig main.bicep passes',
  );
  const env = consoleEnv(inner);
  assertEnvEntry(env, 'LOOM_EH_SCHEMA_GROUP', "variables('loomEhSchemaGroup')");
  assertEnvEntry(env, 'LOOM_DATABRICKS_SQL_WAREHOUSE_ID', "parameters('loomDatabricksSqlWarehouseId')");
});

// The Service Bus and Batch values this PR's discovery emits (adopt keys
// `servicebus` / `batch`) reach the console only through main.bicep's
// byoExisting object (main.bicep, the serviceBus* / batch* fields) and
// admin-plane's variables. None of that code is new in this PR, but the PR's
// outcome rests on it.
// BREAKS ON (reviewer arms B2, B3): `serviceBusNamespace: !empty('')` (the
// adopt branch is dead, so the expression no longer starts with the adoptName
// test) and `serviceBusRg: ''` (compiles to ''). Also on the same shapes for
// serviceBusSub, batchAccount and batchRg, and on admin-plane reading a
// different byoExisting field or emitting a different env variable.
test('compiled template: servicebus and batch take the ADOPT branch into byoExisting and reach the console env', () => {
  const tpl = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  const m = adminPlaneModule(tpl);
  const byo = m.properties.parameters.byoExisting?.value;
  assert.ok(byo && typeof byo === 'object', 'main.bicep must pass byoExisting to admin-plane');
  const adoptBranch = (key, accessor) =>
    `[if(not(empty(__bicep.adoptName(parameters('adopt'), '${key}'))), __bicep.${accessor}(parameters('adopt'), '${key}'), `;
  assert.ok(
    String(byo.serviceBusNamespace).startsWith(adoptBranch('servicebus', 'adoptName')),
    `serviceBusNamespace must prefer the adopted name; got ${byo.serviceBusNamespace}`,
  );
  assert.equal(byo.serviceBusRg, "[__bicep.adoptRg(parameters('adopt'), 'servicebus')]");
  assert.equal(byo.serviceBusSub, "[__bicep.adoptSub(parameters('adopt'), 'servicebus')]");
  assert.ok(
    String(byo.batchAccount).startsWith(adoptBranch('batch', 'adoptName')),
    `batchAccount must prefer the adopted name; got ${byo.batchAccount}`,
  );
  assert.ok(
    String(byo.batchRg).startsWith(adoptBranch('batch', 'adoptRg')),
    `batchRg must carry the adopted RG when a batch account is adopted; got ${byo.batchRg}`,
  );

  const inner = m.properties.template;
  const v = inner.variables;
  assert.equal(v.loomServiceBusNamespace, "[coalesce(tryGet(parameters('byoExisting'), 'serviceBusNamespace'), '')]");
  assert.equal(v.loomServiceBusRgIn, "[coalesce(tryGet(parameters('byoExisting'), 'serviceBusRg'), '')]");
  assert.equal(v.loomServiceBusSubIn, "[coalesce(tryGet(parameters('byoExisting'), 'serviceBusSub'), '')]");
  assert.equal(
    v.effServiceBusRg,
    "[if(not(empty(variables('loomServiceBusRgIn'))), variables('loomServiceBusRgIn'), parameters('loomDlzRg'))]",
    'a supplied Service Bus RG must win over the DLZ RG fallback',
  );
  assert.equal(
    v.effServiceBusSub,
    "[if(not(empty(variables('loomServiceBusSubIn'))), variables('loomServiceBusSubIn'), subscription().subscriptionId)]",
    'a supplied Service Bus subscription must win over the deployment subscription',
  );
  assert.equal(v.loomBatchAccount, "[coalesce(tryGet(parameters('byoExisting'), 'batchAccount'), '')]");
  assert.ok(
    String(v.loomBatchRg).includes("parameters('byoExisting').batchRg"),
    `admin-plane must read the batch RG from byoExisting; got ${v.loomBatchRg}`,
  );
  const env = consoleEnv(inner);
  assertEnvEntry(env, 'LOOM_SERVICEBUS_NAMESPACE', "variables('loomServiceBusNamespace')");
  assertEnvEntry(env, 'LOOM_SERVICEBUS_RG', "variables('effServiceBusRg')");
  assertEnvEntry(env, 'LOOM_SERVICEBUS_SUB', "variables('effServiceBusSub')");
  assertEnvEntry(env, 'LOOM_BATCH_ACCOUNT', "variables('loomBatchAccount')");
  assertEnvEntry(env, 'LOOM_BATCH_RG', "if(empty(variables('loomBatchAccount')), '', variables('loomBatchRg'))");
});
