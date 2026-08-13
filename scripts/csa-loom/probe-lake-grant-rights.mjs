#!/usr/bin/env node
/**
 * probe-lake-grant-rights.mjs — can THIS deploying identity grant at the lake?
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * When the lake is discovered in a Data Landing Zone SUBSCRIPTION, the grants
 * inside `modules/admin-plane/main.bicep` skip (`loomStorageAccountSameSub` is
 * false) and #3336's cross-subscription pass has to make them instead — from a
 * `scope: resourceGroup(<lakeSub>, <lakeRg>)` module in the subscription-scoped
 * orchestrator.
 *
 * That pass CANNOT be armed unconditionally. Two rights are needed in the lake's
 * subscription, and a principal holding neither does not get a skipped grant:
 *
 *     Microsoft.Resources/deployments/write        submit the nested deployment
 *     Microsoft.Authorization/roleAssignments/write   create the assignment
 *
 * It gets `AuthorizationFailed`, and ARM fails the WHOLE deployment. That is
 * exactly the P0 class that failed two full Commercial deploys on 2026-08-13
 * (#3333, fixed by #3329) — a module that dereferenced a resource it could not
 * resolve. Arming a grant the deployer cannot make would trade one broken
 * capability for a broken estate.
 *
 * ── WHY IT IS A MEASUREMENT AND NOT A QUESTION ──────────────────────────────
 *
 * `auto-bind-by-default.md` forbids user-performed plumbing: the platform figures
 * the binding out, it does not ask. So the deploy lane asks ARM — as the identity
 * that will actually attempt the grant — what that identity may do at the exact
 * scope where it will attempt it:
 *
 *     GET /subscriptions/{sub}/resourceGroups/{rg}
 *         /providers/Microsoft.Authorization/permissions?api-version=2022-04-01
 *
 * That endpoint returns the CALLER's effective actions/notActions at the scope,
 * unioned across every assignment including ones inherited from the subscription
 * and its management groups. It is the authoritative answer, it needs no Graph
 * read, and it never needs the client id of the credential — the token IS the
 * subject of the question. The customer does nothing.
 *
 * ── FAIL-SOFT, WITHOUT DISCARDING ANYTHING ──────────────────────────────────
 *
 * A false verdict makes the bicep condition false, so the module is NOT
 * DEPLOYED. That is not the same as swallowing an error: nothing here uses
 * `|| true`, `2>/dev/null` or `continue-on-error`, every az failure is captured,
 * classified and PRINTED, and an UNKNOWN answer (transport error, throttle,
 * denied read) is reported as UNKNOWN and treated as "do not arm" — never as
 * "denied", and never as a silent pass. `csa_loom_unknown_as_negative_class` is
 * the mistake this avoids in one direction; R7 ("an error must not assert a cause
 * it did not establish") is the one it avoids in the other.
 *
 * ── SELF-DEFENCE ────────────────────────────────────────────────────────────
 *
 * The evaluator runs against EMBEDDED FIXTURES before it is allowed to touch a
 * live payload, and the script exits non-zero if any fixture disagrees. This is
 * not decoration. The obvious "control" — probing for a nonsense action and
 * expecting DENIED — is VACUOUS against an Owner, because `actions: ['*']`
 * genuinely does allow every action string including invented ones. Measured
 * 2026-08-13: that exact control reported "evaluator is broken" against a
 * correctly-working evaluator. A control that cannot distinguish a broken
 * evaluator from a privileged caller measures nothing
 * (`csa_loom_guard_with_zero_population_needs_embedded_control`), so the
 * discrimination is proved on fixtures where the expected answer is known.
 *
 * ── WHAT THIS DOES *NOT* MEASURE ────────────────────────────────────────────
 *
 * It measures RIGHTS, not EXISTENCE. ARM's permissions endpoint answers for a
 * scope PATH — inherited subscription/management-group assignments apply whether
 * or not the resource group has been created — so probing a nonexistent RG
 * returns the caller's inherited rights, not a 404. Verified 2026-08-13.
 *
 * That is correct here and not a hole: the lake's existence is established by
 * the step that produced the adopt plan, which only emits a `storage-adls` entry
 * after `az storage account list` actually returned that account. The probe's
 * job is the one thing discovery cannot answer — "and may I write RBAC there?"
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *
 *   node scripts/csa-loom/probe-lake-grant-rights.mjs \
 *        --adopt-json "$LOOM_ADOPT_JSON" --deploy-subscription <sub> \
 *        [--github-output <file>]
 *
 *   # or point it at a scope directly (one-off check):
 *   node scripts/csa-loom/probe-lake-grant-rights.mjs \
 *        --lake-subscription <sub> --lake-rg <rg>
 *
 * Emits `cross_sub_lake_grants=true|false` plus `verdict=` (allowed | denied |
 * unknown | not-applicable) and `reason=`. Exit 0 on any DECIDED outcome
 * including denied — a deployer without the right is a supported estate, not a
 * broken run. Exit non-zero only when the script itself cannot be trusted
 * (an embedded control failed).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const NEEDED = [
  'Microsoft.Authorization/roleAssignments/write',
  'Microsoft.Resources/deployments/write',
];

/** Escape every regex metacharacter in a literal segment. Written as an explicit
 *  character loop rather than a `replace(/[…]/g)` literal on purpose: the class
 *  needed to contain `$`, `{`, `}`, `[`, `]` and `\`, which is exactly the shape
 *  that is easy to get subtly wrong and hard to read. A loop cannot be
 *  mis-escaped. */
const RX_META = new Set(['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\', '/', '-']);
function rxEscape(literal) {
  let out = '';
  for (const ch of literal) out += RX_META.has(ch) ? '\\' + ch : ch;
  return out;
}

/**
 * Does `action` match an ARM permission pattern? ARM patterns use an asterisk as
 * a multi-segment wildcard — a bare asterisk, `Microsoft.Storage/<star>`, or
 * `<star>/read`.
 *
 * (Those wildcards are spelled out rather than written literally: an asterisk
 * immediately followed by a slash CLOSES this block comment, which is exactly
 * how the first draft of this file turned its own doc comment into code and
 * produced a SyntaxError two functions further down. Same class as the
 * `# shellcheck` comment that aborted a scan and made a broken tree measure
 * clean.)
 */
function matches(pattern, action) {
  const rx = new RegExp('^' + pattern.split('*').map(rxEscape).join('.*') + '$', 'i');
  return rx.test(action);
}

/** Effective allow for one action across a permission set (allow minus notActions). */
export function isAllowed(permissions, action) {
  return permissions.some(
    (p) =>
      (p.actions || []).some((a) => matches(a, action)) &&
      !(p.notActions || []).some((n) => matches(n, action)),
  );
}

// ── EMBEDDED CONTROLS ───────────────────────────────────────────────────────
// Each fixture has a KNOWN answer, so a green result here cannot be produced by
// a privileged caller, an empty population, or a regex that matches everything.
const FIXTURES = [
  {
    name: 'Owner (actions ["*"]) allows the grant',
    perms: [{ actions: ['*'], notActions: [] }],
    action: 'Microsoft.Authorization/roleAssignments/write',
    expect: true,
  },
  {
    name: 'Contributor (notActions excludes roleAssignments/write) DENIES the grant',
    perms: [{ actions: ['*'], notActions: ['Microsoft.Authorization/*/Write', 'Microsoft.Authorization/*/Delete'] }],
    action: 'Microsoft.Authorization/roleAssignments/write',
    expect: false,
  },
  {
    name: 'Contributor still allows submitting the nested deployment',
    perms: [{ actions: ['*'], notActions: ['Microsoft.Authorization/*/Write', 'Microsoft.Authorization/*/Delete'] }],
    action: 'Microsoft.Resources/deployments/write',
    expect: true,
  },
  {
    name: 'Reader (*/read only) denies the grant',
    perms: [{ actions: ['*/read'], notActions: [] }],
    action: 'Microsoft.Authorization/roleAssignments/write',
    expect: false,
  },
  {
    name: 'User Access Administrator (explicit action) allows the grant',
    perms: [{ actions: ['*/read', 'Microsoft.Authorization/*'], notActions: [] }],
    action: 'Microsoft.Authorization/roleAssignments/write',
    expect: true,
  },
  {
    name: 'an EMPTY permission set denies (a blank payload must never read as allowed)',
    perms: [],
    action: 'Microsoft.Authorization/roleAssignments/write',
    expect: false,
  },
];

export function verifyControls() {
  const bad = FIXTURES.filter((f) => isAllowed(f.perms, f.action) !== f.expect);
  return { total: FIXTURES.length, failures: bad.map((f) => f.name) };
}

/**
 * Where does the LAKE live, according to the adopt plan bicep will read?
 *
 * The plan (scripts/csa-loom/discover-dlz-adopt-plan.sh, possibly overlaid by an
 * explicit LOOM_ADOPT_JSON) is the ONLY authority: main.bicep's
 * `adoptSub(adopt,'storage-adls')` / `adoptRg(…)` read exactly these fields. The
 * discovered DLZ_SUB / DLZ_RG are NOT a substitute — an explicit plan can name a
 * different account, and measuring rights at a resource group nothing deploys to
 * would be a green light for the wrong scope.
 *
 * Returns `{ sub: '', rg: '' }` for every case main.bicep treats as local: no
 * plan, no storage-adls entry, mode !== 'adopt', no explicit `sub` (the plan
 * omits it for same-sub targets), or a `sub` equal to the deployment's own. That
 * mirrors `loomStorageAccountSameSub` deliberately — if this function and that
 * expression ever disagree, the probe measures a scope the template does not use.
 */
export function lakeCoordsFromAdoptPlan(plan, deploySubscription) {
  const entry = (plan && typeof plan === 'object' && plan['storage-adls']) || null;
  if (!entry || entry.mode !== 'adopt') return { sub: '', rg: '' };
  const target = entry.target || {};
  const sub = String(target.sub || '');
  const rg = String(target.rg || '');
  if (!sub || !rg) return { sub: '', rg: '' };
  if (sub === String(deploySubscription || '')) return { sub: '', rg: '' };
  return { sub, rg };
}

// Controls for the extractor. Same doctrine as the permission fixtures: the
// answers are known, so a green result cannot come from an empty plan or a
// too-permissive read.
const PLAN_FIXTURES = [
  { name: 'cross-sub adopt is detected', plan: { 'storage-adls': { mode: 'adopt', target: { name: 'sa', rg: 'rg-dlz', sub: 'SUB-B' } } }, deploySub: 'SUB-A', expect: { sub: 'SUB-B', rg: 'rg-dlz' } },
  { name: 'same-sub adopt is NOT cross-sub', plan: { 'storage-adls': { mode: 'adopt', target: { name: 'sa', rg: 'rg-dlz', sub: 'SUB-A' } } }, deploySub: 'SUB-A', expect: { sub: '', rg: '' } },
  { name: 'adopt with NO explicit sub is local by the plan convention', plan: { 'storage-adls': { mode: 'adopt', target: { name: 'sa', rg: 'rg-dlz' } } }, deploySub: 'SUB-A', expect: { sub: '', rg: '' } },
  { name: 'mode=create is never adopted', plan: { 'storage-adls': { mode: 'create', target: { name: 'sa', rg: 'rg-dlz', sub: 'SUB-B' } } }, deploySub: 'SUB-A', expect: { sub: '', rg: '' } },
  { name: 'an empty plan yields no lake', plan: {}, deploySub: 'SUB-A', expect: { sub: '', rg: '' } },
  { name: 'a plan adopting OTHER services but not the lake yields no lake', plan: { synapse: { mode: 'adopt', target: { name: 'syn', rg: 'rg-dlz', sub: 'SUB-B' } } }, deploySub: 'SUB-A', expect: { sub: '', rg: '' } },
  { name: 'a cross-sub adopt with no rg cannot be scoped, so it is not armed', plan: { 'storage-adls': { mode: 'adopt', target: { name: 'sa', sub: 'SUB-B' } } }, deploySub: 'SUB-A', expect: { sub: '', rg: '' } },
];

export function verifyPlanControls() {
  const bad = PLAN_FIXTURES.filter((f) => {
    const got = lakeCoordsFromAdoptPlan(f.plan, f.deploySub);
    return got.sub !== f.expect.sub || got.rg !== f.expect.rg;
  });
  return { total: PLAN_FIXTURES.length, failures: bad.map((f) => f.name) };
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : '';
  };

  // Controls FIRST. A probe that has not proved it can say "no" is not allowed
  // to say "yes" about a live estate.
  const ctl = verifyControls();
  const planCtl = verifyPlanControls();
  const allFailures = [...ctl.failures, ...planCtl.failures];
  if (allFailures.length) {
    console.error(
      `::error::[lake-grant-probe] ${allFailures.length}/${ctl.total + planCtl.total} embedded control(s) FAILED — the permission ` +
        `evaluator and/or the adopt-plan reader does not behave as specified, so no verdict this script produces about the live ` +
        `estate can be trusted in EITHER direction. Failing instead of guessing.\n` +
        allFailures.map((n) => `  - ${n}`).join('\n'),
    );
    process.exit(2);
  }
  console.log(
    `[lake-grant-probe] embedded controls: ${ctl.total}/${ctl.total} permission, ${planCtl.total}/${planCtl.total} adopt-plan — all held.`,
  );

  const out = arg('--github-output') || process.env.GITHUB_OUTPUT || '';

  const emit = (armed, verdict, reason) => {
    console.log(`[lake-grant-probe] verdict=${verdict} armed=${armed}`);
    console.log(`[lake-grant-probe] reason: ${reason}`);
    if (out) {
      fs.appendFileSync(out, `cross_sub_lake_grants=${armed}\nverdict=${verdict}\nreason=${reason}\n`);
    }
  };

  // Coordinates: explicit flags win (useful for a one-off check), otherwise
  // derived from the adopt plan — the document main.bicep itself reads.
  let sub = arg('--lake-subscription');
  let rg = arg('--lake-rg');
  const adoptJsonRaw = arg('--adopt-json');
  if ((!sub || !rg) && adoptJsonRaw) {
    let plan;
    try {
      plan = JSON.parse(adoptJsonRaw);
    } catch (e) {
      // A malformed plan is UNKNOWN, not "no lake". Bicep's own `json()` would
      // fail the compile on this input, so the deploy is not silently fine —
      // saying "no cross-sub lake" here would be asserting a fact we do not have.
      emit('false', 'unknown', `The adopt plan did not parse as JSON (${e.message}), so the lake's location could not be established. Disarming rather than guessing.`);
      process.exit(0);
    }
    const coords = lakeCoordsFromAdoptPlan(plan, arg('--deploy-subscription'));
    sub = coords.sub;
    rg = coords.rg;
  }

  // NOT-APPLICABLE is a first-class, correct answer: a same-subscription (or
  // greenfield) estate never reaches the cross-sub pass, and reporting that as
  // "denied" would be the UNKNOWN-as-NEGATIVE mistake in a different costume.
  if (!sub || !rg) {
    emit(
      'false',
      'not-applicable',
      'No cross-subscription lake on this run — the adopt plan names no storage-adls target in another subscription. admin-plane makes its own lake grants, and the cross-sub pass has nothing to do.',
    );
    process.exit(0);
  }
  console.log(`[lake-grant-probe] measuring rights at the adopted lake's resource group '${rg}' (subscription id withheld from the log).`);

  const url =
    `https://management.azure.com/subscriptions/${sub}/resourceGroups/${rg}` +
    `/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`;

  // stderr is CAPTURED and reported, never merged into stdout and never
  // discarded — merging them is how a CLI warning became a phantom data row
  // earlier in this same investigation.
  //
  // On Windows `az` is a .cmd shim, which spawnSync cannot exec directly
  // (ENOENT). CI runs on Linux where it is a real executable, but a probe that
  // only works on the runner is a probe nobody can reproduce locally — and the
  // ENOENT would surface as verdict=unknown, i.e. silently disarmed rather than
  // obviously broken. `shell: true` on win32 only, so the Linux path keeps
  // argv-array semantics and never goes through a shell.
  const onWindows = process.platform === 'win32';
  const res = spawnSync(onWindows ? 'az.cmd' : 'az', ['rest', '--method', 'get', '--url', url], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: onWindows,
  });

  if (res.error || res.status !== 0) {
    const err = (res.stderr || String(res.error || '')).trim().split('\n').slice(0, 4).join(' | ');
    emit(
      'false',
      'unknown',
      `Could not READ the deploying identity's permissions at the lake resource group (az exit ${res.status}). This is NOT a finding that the right is missing — it is a failure to measure, and the pass stays disarmed because an unverified grant is the failure mode that takes deployments down. az said: ${err}`,
    );
    process.exit(0);
  }

  let perms;
  try {
    perms = JSON.parse(res.stdout).value;
  } catch (e) {
    emit('false', 'unknown', `The permissions payload did not parse as JSON (${e.message}). Disarming rather than guessing.`);
    process.exit(0);
  }
  if (!Array.isArray(perms)) {
    emit('false', 'unknown', 'The permissions payload carried no `value` array. Disarming rather than guessing.');
    process.exit(0);
  }

  const results = NEEDED.map((a) => ({ action: a, allowed: isAllowed(perms, a) }));
  for (const r of results) console.log(`[lake-grant-probe]   ${r.allowed ? 'ALLOWED' : 'DENIED '}  ${r.action}`);
  const missing = results.filter((r) => !r.allowed).map((r) => r.action);

  if (missing.length === 0) {
    emit(
      'true',
      'allowed',
      `The deploying identity holds every action the cross-subscription lake grant pass needs at the lake resource group (${perms.length} permission entr${perms.length === 1 ? 'y' : 'ies'} evaluated). Arming modules/data-plane/dlz-lake-grant-pass.bicep.`,
    );
    process.exit(0);
  }

  // A REAL denial. Named precisely, with the exact remediation — deploy-integrity
  // R6: name the role and the scope, never a generic failure.
  console.log(
    `::warning::[lake-grant-probe] The deploying identity CANNOT create the lake role assignment. ` +
      `Missing: ${missing.join(', ')} at the adopted lake's resource group. The cross-subscription grant pass is NOT armed, ` +
      `so this deploy will not fail — but svc-s3-gateway will not deploy either, and the console will honest-gate with a Fix-it ` +
      `naming this exact grant. To close it, give the deploying service principal "User Access Administrator" (or "Role Based Access ` +
      `Control Administrator", or Owner) on the lake's subscription or resource group, then re-run this deploy.`,
  );
  emit(
    'false',
    'denied',
    `Measured at the lake resource group: missing ${missing.join(', ')}. Grant the deploying principal User Access Administrator / RBAC Administrator / Owner at that scope and re-run.`,
  );
  process.exit(0);
}

// Importable for tests; only runs the probe when invoked directly.
if (process.argv[1] && process.argv[1].endsWith('probe-lake-grant-rights.mjs')) main();
