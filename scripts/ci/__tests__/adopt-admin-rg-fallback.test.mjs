/**
 * discover-dlz-adopt-plan.sh — the admin-RG fallback for Service Bus + Batch (#4665).
 *
 * WHAT DEFECT THIS PINS. deploy-planner/service-bus.bicep and
 * deploy-planner/batch.bicep are ordinary resource-group-scoped modules, and on
 * the Commercial estate they were deployed straight into the ADMIN resource
 * group (`loom-servicebus-1784162471` / `loom-batch-1784162511`, both Succeeded
 * 2026-07-16, both into rg-csa-loom-admin-centralus). Discovery read only the
 * DLZ resource group — in a different subscription — so the plan omitted both
 * keys, `byoExisting.serviceBusNamespace` / `.batchAccount` resolved to '', and
 * LOOM_SERVICEBUS_NAMESPACE / LOOM_BATCH_ACCOUNT rendered empty on an estate
 * that owned both resources.
 *
 * HOW THIS TESTS IT. The REAL script is driven with a stub `az` on PATH that
 * answers by resource group, so these exercise the shipped control flow rather
 * than a re-implementation of it. Every assertion below names the value that
 * turns it red.
 *
 * MUTATION RECEIPTS (run 2026-09-22 against SANDBOX COPIES under temp/, never
 * the tracked tree; `git hash-object` on the real script was identical before
 * and after all three runs):
 *
 *   M1  the `#4665` fallback guard → `if false`   ⇒ 4 RED / 5 green
 *       kills: "adopts … from the ADMIN RG", "excluding the shim still leaves
 *              a real namespace adoptable", "two candidates adopt NEITHER",
 *              "an unreadable admin RG warns UNKNOWN"
 *   M2  `grep -v '^sb-loom-dlshim-'` → `cat`      ⇒ 2 RED / 7 green
 *       kills: both shim tests
 *   M3  `if [ -z "$SB" ]` → `if true`             ⇒ 1 RED / 8 green
 *       kills: "the DLZ wins"
 *
 * DISCLOSED, per assertion-design.md #5 — two tests are NOT killed by M1–M3:
 *   - "the direct-lake-shim namespace is excluded, not adopted" survives M1
 *     (with the fallback gone, nothing is adopted, so "the shim was not
 *     adopted" is vacuously true). It is an EQUIVALENT MUTANT for M1 and is
 *     counted only against M2, which does kill it. Its paired positive
 *     assertion — the test immediately after it — is what carries M1.
 *   - "omitting the admin coordinates leaves behaviour exactly as before" is a
 *     REGRESSION GUARD for the four existing callers that pass no admin
 *     coordinates. It has no mutation receipt here; it breaks if `--admin-rg`
 *     is ever made required or dereferenced unguarded under `set -u`.
 *
 * Run: node --test scripts/ci/__tests__/adopt-admin-rg-fallback.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = resolve(REPO, 'scripts/csa-loom/discover-dlz-adopt-plan.sh');

const DLZ_SUB = '11111111-1111-1111-1111-111111111111';
const DLZ_RG = 'rg-csa-loom-dlz-default-centralus';
const ADMIN_SUB = '22222222-2222-2222-2222-222222222222';
const ADMIN_RG = 'rg-csa-loom-admin-centralus';

/**
 * Drive the real discovery script against a stub `az`.
 *
 * @param {object} o
 * @param {string} [o.dlzSb]      names `az resource list` returns for Service Bus in the DLZ RG
 * @param {string} [o.dlzBatch]   ditto for Batch in the DLZ RG
 * @param {string} [o.adminSb]    ditto for Service Bus in the ADMIN RG (newline-separated for several)
 * @param {string} [o.adminBatch] ditto for Batch in the ADMIN RG
 * @param {string} [o.adminFail]  resource type whose ADMIN-RG read exits non-zero (the unreadable case)
 * @param {boolean} [o.passAdmin] pass --admin-subscription/--admin-rg at all (default true)
 */
function discover({
  dlzSb = '',
  dlzBatch = '',
  adminSb = '',
  adminBatch = '',
  adminFail = '',
  passAdmin = true,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adopt-admin-'));

  // The stub answers the shapes the script uses. It keys off `-g` so a DLZ read
  // and an ADMIN read of the SAME resource type return different answers —
  // which is the entire behaviour under test.
  const az = `#!/usr/bin/env bash
RG=""; TYPE=""; prev=""
for a in "$@"; do
  case "$prev" in
    -g) RG="$a" ;;
    --resource-type) TYPE="$a" ;;
  esac
  prev="$a"
done
# The DLZ resource group exists; that guard is not what these cases exercise.
if [ "$1" = "group" ] && [ "$2" = "show" ]; then exit 0; fi
if [ "$1" = "resource" ] && [ "$2" = "list" ]; then
  if [ "$RG" = ${JSON.stringify(ADMIN_RG)} ]; then
    if [ -n "\${STUB_ADMIN_FAIL:-}" ] && [ "\$STUB_ADMIN_FAIL" = "$TYPE" ]; then
      echo "(AuthorizationFailed) The client does not have authorization to perform action 'Microsoft.Resources/subscriptions/resourceGroups/resources/read'." >&2
      exit 1
    fi
    case "$TYPE" in
      Microsoft.ServiceBus/namespaces) printf '%s' "\${STUB_ADMIN_SB:-}" ;;
      Microsoft.Batch/batchAccounts)   printf '%s' "\${STUB_ADMIN_BATCH:-}" ;;
    esac
    exit 0
  fi
  case "$TYPE" in
    Microsoft.ServiceBus/namespaces) printf '%s' "\${STUB_DLZ_SB:-}" ;;
    Microsoft.Batch/batchAccounts)   printf '%s' "\${STUB_DLZ_BATCH:-}" ;;
  esac
  exit 0
fi
# storage / eventhubs / synapse / databricks: absent, which is legitimate.
exit 0
`;
  const azPath = join(dir, 'az');
  writeFileSync(azPath, az);
  chmodSync(azPath, 0o755);

  const args = ['--dlz-subscription', DLZ_SUB, '--dlz-rg', DLZ_RG];
  if (passAdmin) args.push('--admin-subscription', ADMIN_SUB, '--admin-rg', ADMIN_RG);

  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      STUB_DLZ_SB: dlzSb,
      STUB_DLZ_BATCH: dlzBatch,
      STUB_ADMIN_SB: adminSb,
      STUB_ADMIN_BATCH: adminBatch,
      STUB_ADMIN_FAIL: adminFail,
    },
  });

  let plan;
  try {
    plan = JSON.parse((r.stdout || '').trim() || '{}');
  } catch (e) {
    throw new Error(`script did not emit parseable JSON.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
  return { plan, stderr: r.stderr || '', status: r.status };
}

test('the shipped discovery script is present — these tests drive the REAL script', () => {
  assert.ok(existsSync(SCRIPT), `${SCRIPT} must exist`);
});

// ─────────────────────────────────────────────────────────────────────────────
// POSITIVE CONTROL. If the stub never answers, every case below would report a
// clean "nothing adopted" and the suite would pass while measuring nothing.
// This pins that the harness can produce a non-empty plan at all.
// BREAKS ON: a stub whose `az resource list` arm never fires (wrong arg parsing,
// `az` not found on PATH), which is exactly the blind-instrument failure mode.
// ─────────────────────────────────────────────────────────────────────────────
test('CONTROL: a DLZ-resident namespace is adopted from the DLZ RG', () => {
  const { plan } = discover({ dlzSb: 'sb-loom-in-the-dlz' });
  assert.equal(plan.servicebus?.target?.name, 'sb-loom-in-the-dlz');
  assert.equal(plan.servicebus?.target?.rg, DLZ_RG, 'a DLZ hit must carry the DLZ rg');
});

// ── 1. the defect itself ─────────────────────────────────────────────────────
// BREAKS ON: deleting the `#4665` fallback block — `plan.servicebus` and
// `plan.batch` become undefined, which is the pre-fix behaviour verbatim.
test('adopts Service Bus + Batch from the ADMIN RG when the DLZ holds neither', () => {
  const { plan } = discover({
    adminSb: 'sb-loom-k6mvh5sm6z7do',
    adminBatch: 'batchloomk6mvh5sm6z7do',
  });

  assert.equal(plan.servicebus?.target?.name, 'sb-loom-k6mvh5sm6z7do');
  assert.equal(plan.servicebus?.target?.rg, ADMIN_RG, 'the rg must travel with the name');
  assert.equal(plan.servicebus?.target?.sub, ADMIN_SUB, 'the sub must travel with the name');
  assert.equal(plan.servicebus?.mode, 'adopt');

  assert.equal(plan.batch?.target?.name, 'batchloomk6mvh5sm6z7do');
  assert.equal(plan.batch?.target?.rg, ADMIN_RG);
  assert.equal(plan.batch?.target?.sub, ADMIN_SUB);
});

// ── 2. precedence ────────────────────────────────────────────────────────────
// BREAKS ON: inverting the `if [ -z "$SB" ]` guard so the admin RG overrides a
// landing zone that already answered. A DLZ-resident namespace is the canonical
// one; adopting an admin-RG namesake over it would silently re-point the console.
test('the DLZ wins: an admin-RG candidate never overrides a DLZ hit', () => {
  const { plan } = discover({
    dlzSb: 'sb-loom-in-the-dlz',
    dlzBatch: 'batchloom-in-the-dlz',
    adminSb: 'sb-loom-in-the-admin-rg',
    adminBatch: 'batchloom-in-the-admin-rg',
  });
  assert.equal(plan.servicebus?.target?.name, 'sb-loom-in-the-dlz');
  assert.equal(plan.servicebus?.target?.rg, DLZ_RG);
  assert.equal(plan.batch?.target?.name, 'batchloom-in-the-dlz');
  assert.equal(plan.batch?.target?.rg, DLZ_RG);
});

// ── 3. the sibling that must NOT be adopted ──────────────────────────────────
// admin-plane/aas.bicep creates the direct-lake-shim's OWN Service Bus namespace
// in this same resource group (`sb-loom-dlshim-<region>`, admin-plane/main.bicep
// :2223). Binding svc-servicebus to it would point the navigator at the shim's
// internal queue.
// BREAKS ON: removing the `grep -v '^sb-loom-dlshim-'` exclusion — the shim gets
// adopted as the estate's Service Bus namespace.
test('the direct-lake-shim namespace is excluded, not adopted', () => {
  const { plan } = discover({ adminSb: 'sb-loom-dlshim-centralus' });
  assert.equal(plan.servicebus, undefined, 'the shim namespace must never be adopted');
});

// A paired POSITIVE assertion, per assertion-design.md #4: the exclusion must
// remove the shim WITHOUT disabling adoption for everything else in that RG.
// BREAKS ON: broadening the exclusion to `^sb-loom-` (which would match both).
test('excluding the shim still leaves a real namespace adoptable alongside it', () => {
  const { plan } = discover({ adminSb: 'sb-loom-dlshim-centralus\nsb-loom-k6mvh5sm6z7do' });
  assert.equal(plan.servicebus?.target?.name, 'sb-loom-k6mvh5sm6z7do');
  assert.equal(plan.servicebus?.target?.rg, ADMIN_RG);
});

// ── 4. ambiguity fails closed ────────────────────────────────────────────────
// BREAKS ON: replacing the exactly-one rule with `[0]` — the first name ARM
// happens to list wins, which is a coin flip reported as a measurement.
test('two candidates adopt NEITHER, and say so', () => {
  const { plan, stderr } = discover({ adminSb: 'sb-loom-one\nsb-loom-two' });
  assert.equal(plan.servicebus, undefined, 'ambiguous discovery must adopt nothing');
  assert.match(stderr, /2 candidates for 'servicebus'/);
  assert.match(stderr, /LOOM_ADOPT_JSON/, 'the warning must name the explicit escape hatch');
});

// ── 5. unreadable is not absent ──────────────────────────────────────────────
// The unknown-as-negative class this script's own header refuses: a subscription
// the deploy identity cannot read must not render as "the estate has none".
// BREAKS ON: reading the admin RG through the existing `q()` helper (which ends
// `2>/dev/null || true`) — the failure becomes an empty string, the warning
// disappears, and an authorization gap reads exactly like a greenfield estate.
test('an unreadable admin RG warns UNKNOWN rather than reporting absence', () => {
  const { plan, stderr } = discover({
    adminSb: 'sb-loom-k6mvh5sm6z7do',
    adminFail: 'Microsoft.ServiceBus/namespaces',
    adminBatch: 'batchloomk6mvh5sm6z7do',
  });
  assert.equal(plan.servicebus, undefined, 'nothing may be adopted off a failed read');
  assert.match(stderr, /UNKNOWN, not 'absent'/);
  assert.match(stderr, /AuthorizationFailed/, 'the real az stderr must be surfaced, not swallowed');
  // The failure must be scoped to the one lookup: Batch still adopts.
  // BREAKS ON: aborting the whole fallback on the first unreadable type.
  assert.equal(plan.batch?.target?.name, 'batchloomk6mvh5sm6z7do');
});

// ── 6. the flag is optional ──────────────────────────────────────────────────
// BREAKS ON: making --admin-rg required, or dereferencing it unguarded under
// `set -u` — every existing caller omits it and would start exiting non-zero.
test('omitting the admin coordinates leaves behaviour exactly as before', () => {
  const { plan, status } = discover({ adminSb: 'sb-loom-k6mvh5sm6z7do', passAdmin: false });
  assert.equal(status, 0, 'the script must still succeed with no admin coordinates');
  assert.equal(plan.servicebus, undefined, 'no admin coordinates means no admin-RG lookup');
});
