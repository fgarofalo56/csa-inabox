#!/usr/bin/env node
/**
 * check-tenant-admin-binding — every deploy lane must SUPPLY the bootstrap
 * tenant-admin binding, and no param file may resolve it through the
 * compile-time trap that silently produced an empty one.
 *
 * WHY THIS EXISTS (measured live 2026-08-07).
 * The operator opened the onboarding queue on the live Commercial console and
 * got: "Admin access required. The onboarding queue is restricted to tenant
 * admins. Set LOOM_TENANT_ADMIN_OID to your user OID (or add yourself to
 * LOOM_TENANT_ADMIN_GROUP_ID) on the loom-console container app." — a textbook
 * auto-bind-by-default.md §5 violation ("'Set LOOM_X' as the terminal
 * user-facing state is a violation — the value must be produced by the
 * deploy"). Measured on the live container app: BOTH LOOM_TENANT_ADMIN_OID and
 * LOOM_TENANT_ADMIN_GROUP_ID were empty, so /admin/*, the onboarding queue and
 * every requireTenantAdmin route (Purview, DLP, sensitivity labels, the DSPM-AI
 * and governance-posture routes) were 403 for EVERY user in the tenant — with
 * no in-product way out, because the gate's own Fix-it
 * (POST /api/admin/gates/[id]/resolve) itself demands admin.env-config at
 * Admin. A locked-out user cannot unlock themselves.
 *
 * THREE INDEPENDENT DEFECTS PRODUCED IT, and nothing measured any of them:
 *
 *  D1 — THE .bicepparam COMPILE-TIME TRAP (the subtle one). Four param files
 *       carried
 *          param loomTenantAdminGroupId =
 *            readEnvironmentVariable('LOOM_TENANT_ADMIN_GROUP_ID', adminEntraGroupId)
 *       and commercial.bicepparam's comment claimed "the group defaults to the
 *       FiaB Admins group above, so setting that one GUID covers both". That is
 *       FALSE for every CI deploy. `adminEntraGroupId` in a .bicepparam resolves
 *       to THAT FILE's OWN expression at bicep COMPILE time — here
 *       readEnvironmentVariable('LOOM_ADMIN_ENTRA_GROUP_ID','') — and NEVER to
 *       the `--parameters adminEntraGroupId=…` override the workflow passes on
 *       the command line. Proven with `az bicep build-params` on an unset
 *       environment: the compiled file emits loomTenantAdminGroupId='' as an
 *       EXPLICIT value, which then wins over nothing at all, because the CLI
 *       override was for a DIFFERENT parameter.
 *
 *  D2 — THE GOV PARAM FILES NEVER DECLARED IT. gcc / gcc-high / il5 declared
 *       adminEntraGroupId only, so loomTenantAdminGroupId fell to the bicep
 *       default '' with no way for any caller to influence it short of an
 *       explicit CLI parameter — which none of the three lanes passed.
 *
 *  D3 — THE SOURCE SECRET DOES NOT EXIST. deploy-fiab-commercial.yml read
 *       `secrets.FIAB_ADMIN_GROUP_ID`; `gh secret list` carries only
 *       FIAB_GOV_ADMIN_GROUP_ID. So even adminEntraGroupId itself was passed
 *       EMPTY — confirmed on deployment csa-loom-ci-31210378858, where all
 *       three of adminEntraGroupId / loomTenantAdminGroupId /
 *       loomTenantAdminOid recorded empty.
 *
 * The bicep `deployer().objectId` fallback did not save it. It resolves (proven
 * live: a probe module returned a 36-char objectId at BOTH top level and inside
 * a module), but on a CI deploy it would bind the DEPLOY SERVICE PRINCIPAL as
 * the sole tenant admin — a principal that never signs in — so a non-empty
 * value there is still a locked-out console for every human.
 *
 * WHAT IT CHECKS.
 *  1. Every workflow that deploys platform/fiab/bicep/main.bicep passes
 *     `--parameters loomTenantAdminGroupId=…` (or loomTenantAdminOid) on EVERY
 *     `az deployment sub create|what-if` invocation of it. A lane that supplies
 *     the binding to the apply but not the preview is drift, and a lane that
 *     supplies neither ships the dead gate.
 *  2. No params/*.bicepparam resolves loomTenantAdminGroupId's fallback through
 *     a bare `adminEntraGroupId` reference (D1). The fallback must read an
 *     environment variable.
 *  3. Every param file a deploy lane names declares BOTH loomTenantAdminGroupId
 *     and loomTenantAdminOid (D2), so the binding is expressible at all.
 *
 * MUTATION PROOF: drop the `loomTenantAdminGroupId` --parameters line from any
 * lane → red naming the workflow and the invocation; restore → green. Revert a
 * param file to `readEnvironmentVariable('…', adminEntraGroupId)` → red naming
 * the file and the trap; restore → green. Both exercised by --selftest.
 *
 * Usage: node scripts/ci/check-tenant-admin-binding.mjs [repo-root]
 *        node scripts/ci/check-tenant-admin-binding.mjs --selftest
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Deploy lanes that provision platform/fiab/bicep/main.bicep, and the param
 *  file each one names. Keyed by workflow file under .github/workflows. */
const LANES = [
  { wf: 'deploy-fiab-commercial.yml', param: 'commercial.bicepparam' },
  { wf: 'deploy-fiab-gcc.yml', param: 'gcc.bicepparam' },
  { wf: 'deploy-fiab-gcch.yml', param: 'gcc-high.bicepparam' },
  { wf: 'deploy-fiab-il5.yml', param: 'il5.bicepparam' },
];

/** Param files that must declare the binding even without a dedicated lane —
 *  they are named by the documented from-scratch path (no-vaporware.md) and by
 *  bicep-whatif / drift-check. */
const EXTRA_PARAM_FILES = ['commercial-full.bicepparam', 'tenant-dmlz.bicepparam'];

/** Params that express the binding in a param file — both must be declarable. */
const BINDING_PARAMS = ['loomTenantAdminGroupId', 'loomTenantAdminOid'];

/**
 * The parameter a deploy lane must pass UNCONDITIONALLY.
 *
 * It is the GROUP, deliberately, and not "either of the two". Every lane also
 * passes loomTenantAdminOid, but inside `if [ -n "${INPUT_TENANT_ADMIN_OID:-}" ]`
 * — it is a per-dispatch override that contributes NOTHING on a scheduled run,
 * which is how the estate is actually reconciled. An earlier version of this
 * guard accepted either name and therefore stayed GREEN when the unconditional
 * group binding was deleted from the Commercial lane, because the conditional
 * oid line still matched. A binding that only exists when a human types it is
 * not a binding; the day-one default has to be the group.
 */
const REQUIRED_BINDING = 'loomTenantAdminGroupId';

/**
 * Does this workflow supply a tenant-admin binding on EVERY bicep invocation?
 *
 * Two lane shapes exist and they must be judged differently, or the check is a
 * lie in one of them:
 *
 *  - COMPOSED (deploy-fiab-commercial): arguments are appended once with an
 *    `add` helper into $ARGS_FILE, and BOTH `az deployment sub what-if` and
 *    `az deployment sub create` expand that same file — a shape
 *    check-deploy-input-safety.mjs already enforces, and whose sha256 the
 *    workflow re-asserts. ONE `add --parameters loomTenantAdmin…=` therefore
 *    covers every invocation.
 *
 *  - INLINE (the three Gov lanes): each `az deployment sub …` carries its own
 *    hand-written flags, so a binding on the apply but not the preview is real
 *    drift. Require one occurrence per invocation.
 *
 * Returns { ok, shape, invocations, occurrences }.
 */
function bindingCoverage(text) {
  const invocations = countMainBicepInvocations(text);
  const composed = /add\s+--parameters/.test(text) && /mapfile\s+-t\s+DEPLOY_ARGS/.test(text);
  const m = text.match(new RegExp(`--parameters\\s+"?${REQUIRED_BINDING}=`, 'g'));
  const occurrences = m ? m.length : 0;
  const need = composed ? Math.min(1, invocations) : invocations;
  return { ok: occurrences >= need && occurrences > 0, shape: composed ? 'composed' : 'inline', invocations, occurrences, need };
}

/**
 * Every `az deployment sub create|what-if` that names main.bicep must be
 * covered. Returns the count found so a lane that stops invoking bicep at all
 * (rename, refactor) is reported rather than silently passing.
 *
 * COUNTS COMMANDS, NOT MENTIONS. The Gov lanes both comment about
 * "az deployment sub create" in prose AND pass it as a human-readable label —
 * `--step "az deployment sub create (gcc $CSA_LOOM_TOPOLOGY)"` — to the
 * failure-classifier wrapper. A naive /az deployment sub (create|what-if)/g
 * counted 4 invocations in a lane that has 2, demanded 4 bindings, and would
 * have reported a correctly-wired lane as broken: a guard that fails honest
 * code teaches people to delete the guard. Comment lines are dropped and
 * double-quoted spans removed before counting, so only real command text is
 * measured.
 */
function countMainBicepInvocations(text) {
  const code = text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/"[^"]*"/g, '""'))
    .join('\n');
  const m = code.match(/az deployment sub (?:create|what-if)/g);
  return m ? m.length : 0;
}

/** D1 — the compile-time trap. */
function usesParamFileTrap(text) {
  // `readEnvironmentVariable('LOOM_TENANT_ADMIN_GROUP_ID', adminEntraGroupId)`
  // — a bare identifier (not a nested readEnvironmentVariable, not a literal)
  // as the fallback. Whitespace-tolerant; the identifier must be exactly the
  // paramfile-local `adminEntraGroupId`.
  return /loomTenantAdminGroupId\s*=\s*readEnvironmentVariable\(\s*'[^']*'\s*,\s*adminEntraGroupId\s*\)/.test(text);
}

function declaresParam(text, name) {
  return new RegExp(`^\\s*param\\s+${name}\\s*=`, 'm').test(text);
}

function run(root) {
  const errors = [];
  const wfDir = join(root, '.github', 'workflows');
  const paramDir = join(root, 'platform', 'fiab', 'bicep', 'params');

  for (const lane of LANES) {
    const wfPath = join(wfDir, lane.wf);
    if (!existsSync(wfPath)) {
      errors.push(`${lane.wf}: deploy lane is missing. If it was renamed, update LANES in this guard — a lane that vanishes from the list stops being checked, which is how the binding went unmeasured in the first place.`);
      continue;
    }
    const text = readFileSync(wfPath, 'utf8');
    const cov = bindingCoverage(text);
    if (cov.invocations === 0) {
      errors.push(`${lane.wf}: no 'az deployment sub create|what-if' found. This guard can no longer see how the lane deploys, so it cannot assert the tenant-admin binding. Update LANES.`);
      continue;
    }
    if (!cov.ok) {
      errors.push(
        `${lane.wf}: ${cov.invocations} 'az deployment sub' invocation(s) of platform/fiab/bicep/main.bicep (${cov.shape} shape) but only ${cov.occurrences} unconditional '--parameters ${REQUIRED_BINDING}=' occurrence(s); needs ${cov.need}. ` +
        `A conditional 'loomTenantAdminOid' does NOT count — it contributes nothing on the scheduled reconcile that actually maintains the estate. ` +
        `The param file cannot fill this in for you: a .bicepparam that falls back to 'adminEntraGroupId' resolves that name at bicep COMPILE time, not from your --parameters override, so the console ships with LOOM_TENANT_ADMIN_GROUP_ID and LOOM_TENANT_ADMIN_OID both empty and /admin/* is shut for EVERY user (live defect, 2026-08-07). Pass the binding explicitly on every invocation — a preview that previews a different binding than the apply is the drift #3022 closed for the other parameters.`);
    }
  }

  const paramFiles = [...new Set([...LANES.map((l) => l.param), ...EXTRA_PARAM_FILES])];
  for (const pf of paramFiles) {
    const p = join(paramDir, pf);
    if (!existsSync(p)) {
      errors.push(`params/${pf}: named by a deploy lane (or by the documented from-scratch path) but does not exist.`);
      continue;
    }
    const text = readFileSync(p, 'utf8');
    if (usesParamFileTrap(text)) {
      errors.push(
        `params/${pf}: loomTenantAdminGroupId falls back to the bare identifier 'adminEntraGroupId'. That resolves to THIS FILE's own compile-time expression — never to a '--parameters adminEntraGroupId=…' CLI override — so it silently compiles to '' and shuts the admin gate. Read the environment variable directly: readEnvironmentVariable('LOOM_TENANT_ADMIN_GROUP_ID', readEnvironmentVariable('LOOM_ADMIN_ENTRA_GROUP_ID', '')).`);
    }
    for (const bp of BINDING_PARAMS) {
      if (!declaresParam(text, bp)) {
        errors.push(`params/${pf}: does not declare 'param ${bp}'. Without the declaration the bicep default '' is the only reachable value, so no caller can bind a bootstrap admin (this is why GCC / GCC-High / IL5 shipped a dead admin gate).`);
      }
    }
  }

  return errors;
}

/** Self-test: prove the guard's verdict CHANGES when the wiring is removed. */
function selftest() {
  const composedWf = [
    'add --parameters "adminEntraGroupId=$X"',
    'add --parameters "loomTenantAdminGroupId=$Y"',
    'mapfile -t DEPLOY_ARGS < "$ARGS_FILE"',
    'az deployment sub what-if "${DEPLOY_ARGS[@]}"',
    'az deployment sub create "${DEPLOY_ARGS[@]}"',
  ].join('\n');
  const composedWfNoBinding = composedWf.replace('add --parameters "loomTenantAdminGroupId=$Y"\n', '');
  // The exact shape that made an earlier version of this guard stay green when
  // the unconditional group binding was deleted: the conditional oid remains.
  const composedWfOidOnly = composedWfNoBinding.replace(
    'mapfile', 'if [ -n "$OID" ]; then add --parameters "loomTenantAdminOid=$OID"; fi\nmapfile');
  const inlineBoth = [
    'az deployment sub what-if --parameters loomTenantAdminGroupId=${{ secrets.G }}',
    'az deployment sub create --parameters loomTenantAdminGroupId=${{ secrets.G }}',
  ].join('\n');
  // The drift shape the old presence-only check would have passed: bound on the
  // apply, UNBOUND on the preview.
  const inlineApplyOnly = [
    'az deployment sub what-if --parameters adminEntraGroupId=${{ secrets.G }}',
    'az deployment sub create --parameters loomTenantAdminGroupId=${{ secrets.G }}',
  ].join('\n');

  const cases = [
    ['composed lane WITH binding', bindingCoverage(composedWf).ok, true],
    ['composed lane WITHOUT binding', bindingCoverage(composedWfNoBinding).ok, false],
    ['composed lane with ONLY a conditional oid (not a binding)', bindingCoverage(composedWfOidOnly).ok, false],
    ['inline lane bound on BOTH invocations', bindingCoverage(inlineBoth).ok, true],
    ['inline lane bound on the apply ONLY (preview/apply drift)', bindingCoverage(inlineApplyOnly).ok, false],
    // The two false-positive shapes that made the first version of this guard
    // fail correctly-wired Gov lanes.
    ['comment mentioning the command is not an invocation',
      countMainBicepInvocations('          # wrong subscription. az deployment sub create scoped to the target sub'), 0],
    ['a --step label is not an invocation',
      countMainBicepInvocations('              --step "az deployment sub create (gcc $T)" \\'), 0],
    ['a real invocation still counts',
      countMainBicepInvocations('              -- az deployment sub create \\'), 1],
    ['trap form detected', usesParamFileTrap("param loomTenantAdminGroupId = readEnvironmentVariable('LOOM_TENANT_ADMIN_GROUP_ID', adminEntraGroupId)"), true],
    ['fixed form not flagged', usesParamFileTrap("param loomTenantAdminGroupId = readEnvironmentVariable('LOOM_TENANT_ADMIN_GROUP_ID', readEnvironmentVariable('LOOM_ADMIN_ENTRA_GROUP_ID', ''))"), false],
    ['declaration present', declaresParam("param loomTenantAdminOid = readEnvironmentVariable('X','')", 'loomTenantAdminOid'), true],
    ['declaration absent', declaresParam("param adminEntraGroupId = ''", 'loomTenantAdminOid'), false],
  ];
  let bad = 0;
  for (const [name, got, want] of cases) {
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name} (got ${got}, want ${want})`);
  }
  if (bad) {
    console.error(`\ncheck-tenant-admin-binding --selftest: ${bad} case(s) failed.`);
    process.exit(1);
  }
  console.log('\ncheck-tenant-admin-binding --selftest: all cases passed.');
}

const arg = process.argv[2];
if (arg === '--selftest') {
  selftest();
} else {
  const root = arg || process.cwd();
  const errors = run(root);
  if (errors.length) {
    console.error('check-tenant-admin-binding FAILED — a deploy lane would ship a console whose admin gate no one can pass:\n');
    for (const e of errors) console.error(`  - ${e}`);
    console.error(`\n${errors.length} problem(s). See .claude/rules/auto-bind-by-default.md §5 and .claude/rules/deploy-integrity.md R2.`);
    process.exit(1);
  }
  console.log(`check-tenant-admin-binding OK — ${LANES.length} deploy lane(s) supply a bootstrap tenant-admin binding; ${new Set([...LANES.map((l) => l.param), ...EXTRA_PARAM_FILES]).size} param file(s) declare it without the compile-time trap.`);
}
