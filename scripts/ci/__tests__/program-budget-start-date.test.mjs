/**
 * program-budget-start-date.test.mjs — the regression guard for #4253.
 *
 * ── WHAT BROKE ──────────────────────────────────────────────────────────────
 *
 * platform/fiab/bicep/modules/admin-plane/program-budget.bicep:45 declared
 *
 *     param startDate string = utcNow('yyyy-MM-01')
 *
 * and fed it straight into `timePeriod.startDate` on a
 * Microsoft.Consumption/budgets resource, which ARM treats as IMMUTABLE. The
 * default re-evaluated on every deployment, so on the 1st of each month the
 * template started asking for a start the live budget could never accept:
 *
 *     400 on 'loom-program-budget' → "Start date of budgets cannot be updated.
 *     Please delete and create a new budget."
 *
 * Because the budget is a leaf of the subscription-scope deployment, that one
 * refusal took the whole `az deployment sub create` with it. deploy-fiab-
 * commercial was green on 08-29/30/31 and failed 8 for 8 from 09-01, with no
 * change to the module in between — the calendar was the only input that moved.
 *
 * ── THE PROPERTY THIS FILE ENFORCES ─────────────────────────────────────────
 *
 * §3 is the one that bites: NO DEPLOY-TIME-DEPENDENT EXPRESSION MAY REACH AN
 * IMMUTABLE ARM FIELD. It is written as a sweep over the whole bicep tree with
 * a reasoned allowlist rather than as a check on the one line that broke,
 * because a guard that only knows about `startDate` cannot catch the next field
 * with the same shape — and this repo has already had this class twice, once
 * here and once on cost-export.bicep's recurrence window
 * (`csa_loom_bicep_newguid_is_a_rotator`).
 *
 * MUTATION-PROVEN: restoring `param startDate string = utcNow('yyyy-MM-01')`
 * turns §3 and §4 RED. A guard that does not fail on the original defect is not
 * a guard.
 *
 * Run: node --test scripts/ci/__tests__/program-budget-start-date.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyBudgetStartDateRead,
  normalizeStartDate,
  firstOfMonthUtc,
  deniedBy,
  composeRefusal,
  BUDGET_NAME,
  OUTPUT_VAR,
} from '../resolve-program-budget-start-date.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BICEP_ROOT = path.join(REPO_ROOT, 'platform/fiab/bicep');
const MODULE_PATH = path.join(BICEP_ROOT, 'modules/admin-plane/program-budget.bicep');
const ORCHESTRATOR_PATH = path.join(BICEP_ROOT, 'main.bicep');

const ok = (budgets) => ({ ok: true, stdout: JSON.stringify(budgets), stderr: '' });
const CTX = { budgetName: BUDGET_NAME, now: new Date(Date.UTC(2026, 8, 8)) }; // 2026-09-08

// ── 1. THE CLASSIFIER — discovered / greenfield / refuse ────────────────────

test('an existing budget has its start date echoed back UNCHANGED', () => {
  const v = classifyBudgetStartDateRead(
    ok([{ name: BUDGET_NAME, timePeriod: { startDate: '2026-08-01T00:00:00+00:00' } }]),
    CTX,
  );
  assert.equal(v.decision, 'discovered');
  // The whole point: NOT 2026-09-01, which is what the calendar would have said.
  assert.equal(v.value, '2026-08-01');
});

test('a readable subscription with no such budget is greenfield → first of the CURRENT month', () => {
  const v = classifyBudgetStartDateRead(ok([{ name: 'someone-elses-budget' }]), CTX);
  assert.equal(v.decision, 'greenfield');
  assert.equal(v.value, '2026-09-01');
});

test('an empty budget list is greenfield, not a failure', () => {
  const v = classifyBudgetStartDateRead(ok([]), CTX);
  assert.equal(v.decision, 'greenfield');
  assert.equal(v.value, '2026-09-01');
});

test('A FAILED READ IS NOT AN ABSENT BUDGET — an RBAC denial refuses', () => {
  // The R7 defect this resolver exists to avoid: "I could not look" must never
  // render as "it is not there". Classifying this greenfield would propose a
  // brand-new start date over a live budget's immutable one.
  const v = classifyBudgetStartDateRead(
    { ok: false, stdout: '', stderr: "ERROR: (AuthorizationFailed) The client does not have authorization to perform action 'Microsoft.Consumption/budgets/read'." },
    CTX,
  );
  assert.equal(v.decision, 'refuse');
  assert.equal(v.value, null);
  // …and it must say WHICH refusal this is. Nobody has confirmed the deploy SP
  // can read budgets in ANY boundary, so this is the most likely refusal on the
  // first real run, and its remediation (grant a role) shares nothing with the
  // generic "the read did not complete" case. The CAUSE lives on `reason`; the
  // ROLE lives on `remediation`, so a branch that established no permission
  // cause cannot print one.
  assert.match(v.reason, /DENIED/);
  assert.match(v.reason, /NOT "the budget does not exist"/);
  assert.match(v.remediation, /Cost Management Reader/);
});

test('deniedBy separates a denial from an ordinary failure', () => {
  // Narrow on purpose. Matching the bare word "denied" would turn an outage into
  // a confident "grant a role" instruction — the same R7 error one message over.
  assert.equal(deniedBy('ERROR: (AuthorizationFailed) ...'), true);
  assert.equal(deniedBy('ERROR: (LinkedAuthorizationFailed) ...'), true);
  assert.equal(deniedBy("The client 'x' does not have authorization to perform action 'y'"), true);
  assert.equal(deniedBy('ERROR: (429) Too many requests. Please retry after 600 seconds.'), false);
  assert.equal(deniedBy('ERROR: Could not connect to the endpoint URL'), false);
  assert.equal(deniedBy(''), false);
});

test('a throttle refuses WITHOUT claiming a permission problem', () => {
  const v = classifyBudgetStartDateRead(
    { ok: false, stdout: '', stderr: 'ERROR: (429) Too many requests. Please retry after 600 seconds.' },
    CTX,
  );
  assert.equal(v.decision, 'refuse');
  assert.doesNotMatch(v.reason, /DENIED|Cost Management Reader/);
  assert.match(v.reason, /UNKNOWN, not absent/);
});

// ── 1b. THE PRINTED STRING IS ALSO AN ASSERTION ─────────────────────────────
//
// The verdict `reason` was covered; the string the operator actually SEES was
// not. main() used to append "confirm the deploy service principal can read
// budgets … (Cost Management Reader or broader)" unconditionally, so a 429
// printed a role name — asserting a permission cause nothing had established.
// That is the same R7 defect the classifier is careful to avoid, one layer out,
// in the layer no test was reading.

test('COMPOSED OUTPUT: a throttle never prints a role name', () => {
  const v = classifyBudgetStartDateRead(
    { ok: false, stdout: '', stderr: 'ERROR: (429) Too many requests. Please retry after 600 seconds.' },
    CTX,
  );
  const printed = composeRefusal(v);
  assert.match(printed, /^::error::/);
  assert.doesNotMatch(printed, /Cost Management Reader/);
  assert.doesNotMatch(printed, /GRANT/);
  assert.match(printed, /read the raw az stderr/);
  // The escape hatches apply to every refusal and must still be offered.
  assert.match(printed, /programBudgetEnabled=false/);
});

test('COMPOSED OUTPUT: a denial DOES print the role to grant', () => {
  const v = classifyBudgetStartDateRead(
    { ok: false, stdout: '', stderr: 'ERROR: (AuthorizationFailed) ...' },
    CTX,
  );
  const printed = composeRefusal(v);
  assert.match(printed, /GRANT/);
  assert.match(printed, /Cost Management Reader/);
  assert.match(printed, /SUBSCRIPTION scope/);
});

test('COMPOSED OUTPUT: every refusal branch carries its own remediation', () => {
  // A branch that forgets one silently falls back to the generic hint, which
  // would be honest but would lose the specific cause — so it is pinned.
  const branches = [
    { ok: false, stdout: '', stderr: 'ERROR: (SubscriptionNotFound) ...' },
    { ok: false, stdout: '', stderr: 'ERROR: (AuthorizationFailed) ...' },
    { ok: false, stdout: '', stderr: 'ERROR: (429) throttled' },
    { ok: true, stdout: 'not json', stderr: '' },
    { ok: true, stdout: '{"value":[]}', stderr: '' },
    { ok: true, stdout: JSON.stringify([{ name: BUDGET_NAME, timePeriod: {} }]), stderr: '' },
  ];
  for (const attempt of branches) {
    const v = classifyBudgetStartDateRead(attempt, CTX);
    assert.equal(v.decision, 'refuse');
    assert.ok(
      typeof v.remediation === 'string' && v.remediation.length > 30,
      `refusal branch has no remediation: ${v.reason}`,
    );
    assert.match(composeRefusal(v), /REMEDIATION: /);
  }
});

test('a definite absence of the SUBSCRIPTION refuses — it is not a greenfield budget', () => {
  // SubscriptionNotFound is in the shared ABSENCE_CODES list, so the naive move
  // is to treat it as greenfield. It is not: there is no scope to hold a budget
  // and the apply would fail anyway. The code is NAMED in the refusal.
  const v = classifyBudgetStartDateRead(
    { ok: false, stdout: '', stderr: 'ERROR: (SubscriptionNotFound) Subscription abc was not found.' },
    CTX,
  );
  assert.equal(v.decision, 'refuse');
  assert.match(v.reason, /SubscriptionNotFound/);
  assert.match(v.reason, /absence of the SCOPE/);
});

test('exit 0 with a non-JSON payload refuses', () => {
  const v = classifyBudgetStartDateRead({ ok: true, stdout: 'not json', stderr: '' }, CTX);
  assert.equal(v.decision, 'refuse');
});

test('exit 0 with a non-LIST payload refuses — absence cannot be read off an unknown shape', () => {
  const v = classifyBudgetStartDateRead({ ok: true, stdout: '{"value":[]}', stderr: '' }, CTX);
  assert.equal(v.decision, 'refuse');
  assert.match(v.reason, /did not return a LIST/);
});

test('an existing budget carrying no readable start date refuses', () => {
  const v = classifyBudgetStartDateRead(ok([{ name: BUDGET_NAME, timePeriod: {} }]), CTX);
  assert.equal(v.decision, 'refuse');
  assert.match(v.reason, /IMMUTABLE/);
});

test('a preview-feature WARNING on stderr does not make a successful read fail', () => {
  // `az consumption` prints a preview warning to stderr on EVERY call, success
  // included. A resolver keyed on "stderr is non-empty" would refuse always.
  const v = classifyBudgetStartDateRead(
    {
      ok: true,
      stdout: JSON.stringify([{ name: BUDGET_NAME, timePeriod: { startDate: '2026-08-01T00:00:00+00:00' } }]),
      stderr: "WARNING: Command group 'consumption' is in preview and under development.",
    },
    CTX,
  );
  assert.equal(v.decision, 'discovered');
  assert.equal(v.value, '2026-08-01');
});

// ── 2. DATE HANDLING ────────────────────────────────────────────────────────

test('PRODUCTION FIXTURE: the live Commercial budget, measured 2026-09-08', () => {
  // Not a hypothetical. Read from subscription e093f4fd ("Limitlessdata - DMLZ",
  // which is where the Loom estate lives — the DEFAULT subscription returns
  // seven budgets and none of them is ours, which looks exactly like "never
  // created" and is not):
  //   name=loom-next-level-program  startDate=2026-08-01T00:00:00Z
  //   endDate=2036-07-29T00:00:00Z  amount=1000.0  timeGrain=Monthly
  // This is path (b) — the one that is broken in production right now. The
  // template renders 2026-09-01 today, the stored value is 2026-08-01, the field
  // is immutable, ARM 400s. The resolver must pass 2026-08-01 straight through.
  const live = ok([
    {
      name: BUDGET_NAME,
      amount: 1000.0,
      timeGrain: 'Monthly',
      category: 'Cost',
      timePeriod: { startDate: '2026-08-01T00:00:00Z', endDate: '2036-07-29T00:00:00Z' },
    },
  ]);
  const v = classifyBudgetStartDateRead(live, { budgetName: BUDGET_NAME, now: new Date(Date.UTC(2026, 8, 8)) });
  assert.equal(v.decision, 'discovered');
  assert.equal(v.value, '2026-08-01');
  // The value the OLD code would have sent, and the whole reason it 400s.
  assert.notEqual(v.value, '2026-09-01');
});

test('normalizeStartDate accepts the timestamp ARM actually returns', () => {
  assert.equal(normalizeStartDate('2026-08-01T00:00:00+00:00'), '2026-08-01');
  assert.equal(normalizeStartDate('2026-08-01'), '2026-08-01');
  assert.equal(normalizeStartDate('2017-06-01T00:00:00Z'), '2017-06-01');
});

test('normalizeStartDate REFUSES a non-first-of-month date instead of truncating it', () => {
  // Truncating 2026-08-15 to 2026-08-01 would quietly propose a change to an
  // immutable field. If the day is not 01 this is not the field we think it is.
  assert.equal(normalizeStartDate('2026-08-15T00:00:00+00:00'), null);
  assert.equal(normalizeStartDate(''), null);
  assert.equal(normalizeStartDate(null), null);
  assert.equal(normalizeStartDate(12345), null);
});

test('firstOfMonthUtc pads and uses UTC, and is stable within a month', () => {
  assert.equal(firstOfMonthUtc(new Date(Date.UTC(2026, 0, 31))), '2026-01-01');
  assert.equal(firstOfMonthUtc(new Date(Date.UTC(2026, 8, 1))), '2026-09-01');
  assert.equal(firstOfMonthUtc(new Date(Date.UTC(2026, 8, 30, 23, 59))), '2026-09-01');
  assert.equal(firstOfMonthUtc(new Date(Date.UTC(2026, 11, 5))), '2026-12-01');
});

test('THE BUG ITSELF: two deploys in different months resolve the SAME start for one live budget', () => {
  // This is the regression in one assertion. The old code made this pair differ,
  // which is exactly what ARM rejected.
  const live = ok([{ name: BUDGET_NAME, timePeriod: { startDate: '2026-08-01T00:00:00+00:00' } }]);
  const august = classifyBudgetStartDateRead(live, { budgetName: BUDGET_NAME, now: new Date(Date.UTC(2026, 7, 31)) });
  const september = classifyBudgetStartDateRead(live, { budgetName: BUDGET_NAME, now: new Date(Date.UTC(2026, 8, 1)) });
  assert.equal(august.value, september.value);
  assert.equal(september.value, '2026-08-01');
});

// ── 3. THE GENERAL PROPERTY — no rotator may reach an immutable ARM field ───
//
// A deploy-time-dependent expression (utcNow / newGuid) re-evaluates on every
// deployment. Feeding one into a field ARM will not let you update is a time
// bomb whose fuse is the calendar. Swept across the whole bicep tree, because
// the next instance will not be in the file that broke this time.

/** Bicep functions whose value MOVES between deployments. */
const ROTATORS = ['utcNow', 'newGuid'];

/**
 * ARM fields this repo KNOWS to be immutable, and the bicep that assigns them.
 * This is the direct encoding of the property: a rotator must never reach one
 * of these. Every entry is a field that has ALREADY broken a deploy lane, or
 * carried the identical armed defect — so the registry records measured
 * immutability, not a guess about ARM.
 */
const IMMUTABLE_FIELDS = [
  {
    file: 'platform/fiab/bicep/modules/admin-plane/program-budget.bicep',
    field: 'startDate',
    why: 'Microsoft.Consumption/budgets — "Start date of budgets cannot be updated. Please delete and create a new budget." (#4253)',
  },
  {
    file: 'monitoring/alerts/budget-alerts.bicep',
    field: 'startDate',
    why: 'The SAME Consumption-budget field, found by widening this sweep past platform/fiab/bicep. It carried the identical `utcNow(\'yyyy-MM-01\')` default; no workflow deploys this file, so it was armed rather than firing (#4253).',
  },
  {
    file: 'platform/fiab/bicep/modules/admin-plane/network.bicep',
    field: 'privateIpAllocationMethod',
    why: 'Microsoft.Network/dnsResolvers/inboundEndpoints — ARM rejects a deployment naming a method differing from the live one (#3754)',
  },
];

/**
 * Uses of a rotator that are legitimate, each with the reason it is safe.
 * Adding an entry is a deliberate act: the question to answer is "does this
 * value reach a field ARM refuses to update?" — if it does, it does not belong
 * here.
 *
 * PROSE IS NOT CODE. Several @description strings discuss newGuid()/utcNow() at
 * length, and this file's header and cost-export.bicep's discuss the defect
 * itself. Those are stripped before matching (see stripProse), so the population
 * below is REAL CODE ONLY — seven uses across all 357 .bicep files in the repo.
 */
const ROTATOR_ALLOWLIST = [
  {
    file: 'platform/fiab/bicep/modules/admin-plane/entra-app-registration.bicep',
    match: 'param forceUpdateTag string = utcNow()',
    why: 'forceUpdateTag on a deploymentScript is DESIGNED to change every run — that is how the script is made to re-execute. It is not persisted as a resource property, so it reaches no immutable field.',
  },
  {
    file: 'platform/fiab/bicep/modules/admin-plane/front-door.bicep',
    match: 'param forceUpdateTag string = utcNow()',
    why: 'Same deploymentScript re-execution tag as above.',
  },
  {
    file: 'deploy/bicep/DMLZ/modules/Network/privateDnsZones/privateDnsZones.bicep',
    match: 'param utcValue string = utcNow()',
    why: 'Two uses, both safe: a deploymentScript forceUpdateTag (:102), and a nested DEPLOYMENT name (:126). A deployment name is per-run by design and is not a resource property at all, so neither reaches an immutable field.',
  },
  {
    file: 'platform/fiab/bicep/modules/admin-plane/main.bicep',
    match: 'param loomGeneratedSecretSeed string = newGuid()',
    why: 'A deliberately UNPREDICTABLE secret seed. Rotating is the security property, not a defect (a stable guid(rg.id, <public-const>) would be offline-derivable). It reaches Key Vault secret VALUES, which are mutable by design.',
  },
  {
    file: 'platform/fiab/bicep/modules/admin-plane/pbi-vm-data-gateway.bicep',
    match: 'param adminPassword string = newGuid()',
    why: 'VM admin password — a mutable secret value, unpredictable on purpose.',
  },
  {
    file: 'platform/fiab/bicep/modules/admin-plane/pbi-vm-data-gateway.bicep',
    match: 'param recoveryKey string = newGuid()',
    why: 'Gateway recovery key — a mutable secret value, unpredictable on purpose.',
  },
];

/** Directories with no deployable bicep of ours. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'temp', 'dist', 'build', '.next', 'out']);

function bicepFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...bicepFiles(full));
    else if (entry.name.endsWith('.bicep')) out.push(full);
  }
  return out;
}

/**
 * Remove line comments and PROSE inside string literals, so a rotator NAMED in
 * prose is not mistaken for one CALLED in code. Without this the sweep flags 25
 * lines, 20 of them @description text — and a guard that cries wolf twenty
 * times gets its allowlist padded until it constrains nothing.
 *
 * INTERPOLATIONS ARE PRESERVED. An earlier revision blanked every single-quoted
 * span outright, and in Bicep `'${newGuid()}'` IS one — so appending
 * `param zzMutation string = '${newGuid()}'` left the whole suite green. That
 * is a live rotator the sweep could not see, and the control below asserted the
 * blindness was correct, which would have made it look deliberate to whoever
 * found it later. Quoted text is dropped; `${…}` contents survive, because that
 * is where a string literal can still CALL something.
 */
function stripProse(line) {
  // STRIP THE CARRIAGE RETURN FIRST. In JavaScript regex `.` does not match
  // `\r`, so on a CRLF line `/\/\/.*$/` cannot reach the end-anchor and fails
  // to match AT ALL — comment-stripping silently no-ops. platform/fiab/bicep is
  // LF so this was invisible there; monitoring/alerts/budget-alerts.bicep is
  // CRLF, and the moment the sweep was widened to reach it, this file's own
  // explanatory comments were reported as live rotators. Noise rather than
  // blindness (failing to strip only ADDS matches), but a guard that cries wolf
  // gets its allowlist padded until it constrains nothing.
  return line
    .replace(/\r$/, '')
    .replace(/\/\/.*$/, '')
    .replace(/'[^']*'/g, (span) => {
      const interpolations = span.match(/\$\{[^}]*\}/g);
      return interpolations ? interpolations.join(' ') : "''";
    });
}

test('THE PROPERTY: no rotator reaches a field ARM treats as IMMUTABLE', () => {
  // The narrowest, most direct statement of the bug. For each known-immutable
  // field, find what bicep assigns to it, and if that is a parameter, check the
  // parameter cannot default to a deploy-time value.
  for (const entry of IMMUTABLE_FIELDS) {
    const src = fs.readFileSync(path.join(REPO_ROOT, entry.file), 'utf8');
    const assign = new RegExp(`^\\s*${entry.field}:\\s*(.+)$`, 'm').exec(src);
    assert.ok(assign, `${entry.file} no longer assigns ${entry.field} — update IMMUTABLE_FIELDS`);
    const expr = assign[1].trim();

    // (a) the assignment itself must not call a rotator inline.
    for (const fn of ROTATORS) {
      assert.ok(
        !stripProse(expr).includes(`${fn}(`),
        `${entry.file} assigns ${entry.field} directly from ${fn}(). ${entry.why}`,
      );
    }

    // (b) if it is a bare identifier, that parameter must not DEFAULT to one.
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(expr)) {
      const decl = new RegExp(`^param ${expr} string(?: = (.+))?$`, 'm').exec(src);
      if (decl && decl[1]) {
        for (const fn of ROTATORS) {
          assert.ok(
            !stripProse(decl[1]).includes(`${fn}(`),
            `${entry.file}: param '${expr}' feeds the IMMUTABLE field '${entry.field}' but defaults to ` +
              `${fn}(), which re-evaluates on every deployment. ${entry.why} Read the value from the ` +
              'estate instead (scripts/ci/resolve-program-budget-start-date.mjs is the pattern).',
          );
        }
      }
    }
  }
});

test('no bicep rotator (utcNow/newGuid) outside the reasoned allowlist', () => {
  // The broader net behind the registry above: the next immutable field to bite
  // will not be in IMMUTABLE_FIELDS yet, so every NEW rotator has to be looked
  // at and justified when it is introduced.
  //
  // SWEPT FROM THE REPO ROOT, not from platform/fiab/bicep. Rooting it at the
  // Loom tree was a real blind spot, not a theoretical one: it hid an IDENTICAL
  // armed `utcNow('yyyy-MM-01')` on a Consumption budget's startDate in
  // monitoring/alerts/budget-alerts.bicep, in a guard whose whole subject is
  // that defect. A guard that cannot see a live instance of the exact bug it
  // was written for is the shape this repo keeps producing.
  const offenders = [];
  for (const file of bicepFiles(REPO_ROOT)) {
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const code = stripProse(line).trim();
        if (!ROTATORS.some((fn) => code.includes(`${fn}(`))) return;
        const allowed = ROTATOR_ALLOWLIST.some(
          (a) => a.file === rel && line.trim().includes(a.match),
        );
        if (!allowed) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(
    offenders,
    [],
    'A deploy-time-dependent expression re-evaluates on every deployment. If its value reaches a field ARM ' +
      'treats as IMMUTABLE the deploy fails permanently once the value moves — #4253, where ' +
      "`utcNow('yyyy-MM-01')` on a Consumption budget's startDate broke the Commercial lane for eight days. " +
      'Either read the value from the estate (scripts/ci/resolve-program-budget-start-date.mjs is the ' +
      'pattern) or add it to ROTATOR_ALLOWLIST with the reason it reaches no immutable field.\nOffenders:\n' +
      offenders.join('\n'),
  );
});

test('CONTROL: the sweep actually covers the whole repo, not one subtree', () => {
  // The docstring used to claim "the whole bicep tree" while BICEP_ROOT was
  // platform/fiab/bicep. Asserting the real population size stops that drifting
  // back silently — and stops the sweep quietly finding nothing.
  const files = bicepFiles(REPO_ROOT);
  assert.ok(files.length > 300, `expected the repo-wide bicep population, found ${files.length}`);
  const rels = files.map((f) => path.relative(REPO_ROOT, f).split(path.sep).join('/'));
  for (const outside of ['monitoring/alerts/budget-alerts.bicep', 'csa_platform/governance/finops/budgetAlerts.bicep']) {
    assert.ok(rels.includes(outside), `the sweep must reach ${outside}, which is outside platform/fiab/bicep`);
  }
});

test('CONTROL: the allowlist has no dead entries', () => {
  // An allowlist that outlives its target silently stops constraining anything,
  // and the next reader trusts it. Every entry must still match real source.
  for (const a of ROTATOR_ALLOWLIST) {
    const full = path.join(REPO_ROOT, a.file);
    assert.ok(fs.existsSync(full), `allowlist names a file that no longer exists: ${a.file}`);
    assert.ok(
      fs.readFileSync(full, 'utf8').includes(a.match),
      `allowlist entry for ${a.file} no longer matches any line: ${a.match}`,
    );
    assert.ok(a.why && a.why.length > 30, `allowlist entry for ${a.file} needs a real reason`);
  }
});

test('KNOWN GAP, stated rather than implied: a PINNED literal is invisible to this sweep', () => {
  // csa_platform/governance/finops/budgetAlerts.bicep pins
  // `param startDate string = '2026-04-01'` into the same immutable field. That
  // is the OTHER half of the #4253 failure — it does not rotate, so no rotator
  // sweep can see it, but Azure accepts only the current month's first on a
  // CREATE, so it goes stale and breaks a fresh deploy instead of an existing
  // one. Nothing deploys that file today. Recording it here keeps the guard's
  // claimed coverage honest: this sweep catches ROTATORS, not stale constants.
  const src = fs.readFileSync(
    path.join(REPO_ROOT, 'csa_platform/governance/finops/budgetAlerts.bicep'),
    'utf8',
  );
  assert.match(src, /param startDate string = '\d{4}-\d{2}-\d{2}'/);
});

test('CONTROL: stripProse removes prose without blinding the sweep to code', () => {
  // The sweep's correctness rests entirely on this. If it over-strips, the
  // guard silently stops seeing real calls — the failure mode that matters.
  assert.equal(stripProse("@description('derived from newGuid()')").includes('newGuid('), false);
  assert.equal(stripProse('  // param x = utcNow()').includes('utcNow('), false);
  assert.equal(stripProse('param forceUpdateTag string = utcNow()').includes('utcNow('), true);
  assert.equal(stripProse("param startDate string = utcNow('yyyy-MM-01')").includes('utcNow('), true);

  // AN INTERPOLATION IS CODE, NOT PROSE. These two lines look almost identical
  // and differ completely: the first is a Logic App workflow string the Logic
  // Apps runtime evaluates at trigger time (ARM never calls it), the second is a
  // bicep call that runs at deploy time and rotates. Blanking both is what let a
  // live rotator through.
  assert.equal(stripProse("when: '@utcNow()'").includes('utcNow('), false);
  assert.equal(stripProse("param zzMutation string = '${newGuid()}'").includes('newGuid('), true);
  assert.equal(stripProse("var x = 'prefix-${utcNow()}'").includes('utcNow('), true);

  // CRLF. `.` does not match `\r` in JS, so without the explicit CR strip the
  // comment regex fails to match at all and the whole line survives. This is
  // not hypothetical: it made the widened sweep report budget-alerts.bicep's own
  // documentation as live rotators.
  assert.equal(stripProse('// param x = utcNow()\r').includes('utcNow('), false);
  assert.equal(stripProse("// `utcNow('yyyy-MM-01')` broke the lane\r").includes('utcNow('), false);
  assert.equal(stripProse('param forceUpdateTag string = utcNow()\r').includes('utcNow('), true);
});

// ── 4. CONTROLS — the wiring the classifier depends on ──────────────────────

test('program-budget.bicep declares startDate with NO default at all', () => {
  // The narrow, direct form of §3 for the field that broke. A default of ANY
  // kind here re-opens the question of what the module invents when nobody
  // passes a value; the answer must be "it cannot deploy".
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  assert.match(
    src,
    /^param startDate string$/m,
    'program-budget.bicep must declare `param startDate string` as REQUIRED — no default. ' +
      'timePeriod.startDate is immutable and the value has to be read from the estate.',
  );
});

test('the budget resource still consumes the startDate PARAMETER', () => {
  // Without this the parameter could be required, every test above still pass,
  // and the resource quietly go back to a literal — the "guard with zero
  // population" shape.
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  assert.match(src, /startDate: startDate/);
});

test('CONTROL: the orchestrator does NOT declare the budget when no start date was resolved', () => {
  // Empty must mean "do not touch the budget", never "pick something". An
  // incremental deploy then leaves a live budget alone rather than proposing a
  // start it cannot change.
  const src = fs.readFileSync(ORCHESTRATOR_PATH, 'utf8');
  assert.match(src, /if \(programBudgetEnabled && !empty\(programBudgetStartDate\)\)/);
  assert.match(src, /startDate: programBudgetStartDate/);
});

test('CONTROL: the budget name the resolver READS matches the one bicep DEPLOYS', () => {
  // Greenfield and "I looked for the wrong name" are indistinguishable in the
  // results: both are simply not in the list. If the module renames the budget,
  // the resolver would report greenfield against a live budget and propose a
  // start it cannot accept — silently reintroducing #4253.
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  const m = src.match(/param budgetName string = '([^']+)'/);
  assert.ok(m, 'program-budget.bicep must declare budgetName with a default');
  assert.equal(m[1], BUDGET_NAME);
});

test('CONTROL: the resolver uses the SHARED definition of "definitely absent"', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/ci/resolve-program-budget-start-date.mjs'), 'utf8');
  assert.match(src, /from '\.\/_arm-absence\.mjs'/);
});

// ── 5. THE WIRE, END TO END ─────────────────────────────────────────────────
//
// The resolver writes an env var; a .bicepparam reads it; main.bicep gates on
// it. Break ANY link and the budget silently stops being managed — no error,
// just a resource that quietly drops out of the deployment. Each link below is
// asserted separately, because an earlier revision of this file asserted only
// the workflow end and stayed green when the .bicepparam block was deleted
// outright.

const WF_DIR = path.join(REPO_ROOT, '.github/workflows');
const PARAMS_DIR = path.join(BICEP_ROOT, 'params');

/** Drop `#` comment lines and ::notice::/echo prose, so a mention of a command
 *  in documentation is never mistaken for the command itself. Without this the
 *  lane assertions below pass on a COMMENTED-OUT step: in all four lanes the
 *  only literal occurrences of the env var are in `#` comments. */
function workflowCode(src) {
  return src
    .split('\n')
    .filter((l) => !/^\s*#/.test(l) && !/::(notice|error|warning)::|^\s*echo\b/.test(l))
    .join('\n');
}

/**
 * DERIVED, never hardcoded. A hardcoded population cannot see a fifth lane —
 * and there nearly was one: `csa-loom-post-deploy-bootstrap.yml` matches a
 * naive "mentions az deployment sub create" test, purely from an ::notice::
 * string and a comment. An apply lane is one that hands
 * platform/fiab/bicep/main.bicep to `az deployment sub create` in real code.
 */
function applyLanes() {
  return fs
    .readdirSync(WF_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .filter((f) => {
      const code = workflowCode(fs.readFileSync(path.join(WF_DIR, f), 'utf8'));
      return (
        /--template-file\s+\S*platform\/fiab\/bicep\/main\.bicep/.test(code) &&
        /az deployment sub create/.test(code)
      );
    });
}

/** The .bicepparam files those lanes actually pass. */
function paramFilesOf(laneSrc) {
  const code = workflowCode(laneSrc);
  return [...new Set([...code.matchAll(/params\/([A-Za-z0-9._-]+)\.bicepparam/g)].map((m) => m[1]))];
}

test('CONTROL: the apply-lane population is derived and NON-EMPTY', () => {
  // A guard over zero lanes proves nothing while reading green.
  const lanes = applyLanes();
  assert.ok(lanes.length >= 4, `expected at least the four boundary lanes, derived: ${lanes.join(', ')}`);
});

test('every deploy lane that APPLIES main.bicep resolves the start date first', () => {
  for (const lane of applyLanes()) {
    const code = workflowCode(fs.readFileSync(path.join(WF_DIR, lane), 'utf8'));
    assert.match(
      code,
      /resolve-program-budget-start-date\.mjs/,
      `${lane} applies platform/fiab/bicep/main.bicep, so it must resolve the program budget's immutable ` +
        'start date from the estate before the apply (#4253) — every boundary carries the same bomb on its ' +
        'own month boundary (cloud-parity.md). Asserted against COMMENT-STRIPPED source: a commented-out ' +
        'step is not a step.',
    );
  }
});

test('THE MISSING LINK: every param file an apply lane uses reads the resolved value', () => {
  // Deleting the `param observabilityConfig` block from a .bicepparam severs
  // the ONLY wire between the $GITHUB_ENV export and the deployment, and the
  // deploy still succeeds — it just stops managing the budget. Nothing else in
  // this suite notices, which is why this assertion exists.
  const lanes = applyLanes();
  let checked = 0;
  for (const lane of lanes) {
    for (const name of paramFilesOf(fs.readFileSync(path.join(WF_DIR, lane), 'utf8'))) {
      const file = path.join(PARAMS_DIR, `${name}.bicepparam`);
      assert.ok(fs.existsSync(file), `${lane} passes params/${name}.bicepparam, which does not exist`);
      const src = fs.readFileSync(file, 'utf8');
      assert.match(
        src,
        new RegExp(`programBudgetStartDate:\\s*readEnvironmentVariable\\(\\s*'${OUTPUT_VAR}'`),
        `params/${name}.bicepparam is used by ${lane} but never reads ${OUTPUT_VAR}. The resolver would ` +
          'export the start date and NOTHING would consume it: main.bicep gates the budget on a non-empty ' +
          'value, so the budget would silently stop being deployed (#4253).',
      );
      checked += 1;
    }
  }
  assert.ok(checked >= 4, `expected to check at least 4 param files, checked ${checked}`);
});
