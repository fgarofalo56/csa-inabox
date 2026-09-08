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
  assert.match(v.reason, /UNKNOWN, not absent/);
});

test('a throttle refuses rather than guessing', () => {
  const v = classifyBudgetStartDateRead(
    { ok: false, stdout: '', stderr: 'ERROR: (429) Too many requests. Please retry after 600 seconds.' },
    CTX,
  );
  assert.equal(v.decision, 'refuse');
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
 * of these. Both entries are fields that have ALREADY broken a deploy lane —
 * the budget start (#4253) and the DNS resolver's addressing (#3754) — so the
 * registry is a record of measured immutability, not a guess about ARM.
 */
const IMMUTABLE_FIELDS = [
  {
    file: 'modules/admin-plane/program-budget.bicep',
    field: 'startDate',
    why: 'Microsoft.Consumption/budgets — "Start date of budgets cannot be updated. Please delete and create a new budget." (#4253)',
  },
  {
    file: 'modules/admin-plane/network.bicep',
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
 * length, and the header of this file and of cost-export.bicep discuss the
 * defect itself. Those are stripped before matching (see stripProse), so the
 * population below is REAL CODE ONLY — five uses across the whole tree.
 */
const ROTATOR_ALLOWLIST = [
  {
    file: 'modules/admin-plane/entra-app-registration.bicep',
    match: 'param forceUpdateTag string = utcNow()',
    why: 'forceUpdateTag on a deploymentScript is DESIGNED to change every run — that is how the script is made to re-execute. It is not persisted as a resource property, so it reaches no immutable field.',
  },
  {
    file: 'modules/admin-plane/front-door.bicep',
    match: 'param forceUpdateTag string = utcNow()',
    why: 'Same deploymentScript re-execution tag as above.',
  },
  {
    file: 'modules/admin-plane/main.bicep',
    match: 'param loomGeneratedSecretSeed string = newGuid()',
    why: 'A deliberately UNPREDICTABLE secret seed. Rotating is the security property, not a defect (a stable guid(rg.id, <public-const>) would be offline-derivable). It reaches Key Vault secret VALUES, which are mutable by design.',
  },
  {
    file: 'modules/admin-plane/pbi-vm-data-gateway.bicep',
    match: 'param adminPassword string = newGuid()',
    why: 'VM admin password — a mutable secret value, unpredictable on purpose.',
  },
  {
    file: 'modules/admin-plane/pbi-vm-data-gateway.bicep',
    match: 'param recoveryKey string = newGuid()',
    why: 'Gateway recovery key — a mutable secret value, unpredictable on purpose.',
  },
];

function bicepFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...bicepFiles(full));
    else if (entry.name.endsWith('.bicep')) out.push(full);
  }
  return out;
}

/**
 * Remove line comments and single-quoted string contents, so a rotator NAMED in
 * prose is not mistaken for one CALLED in code. Without this the sweep flags 25
 * lines, 20 of them @description text — and a guard that cries wolf twenty
 * times gets its allowlist padded until it constrains nothing.
 */
function stripProse(line) {
  return line.replace(/\/\/.*$/, '').replace(/'[^']*'/g, "''");
}

test('THE PROPERTY: no rotator reaches a field ARM treats as IMMUTABLE', () => {
  // The narrowest, most direct statement of the bug. For each known-immutable
  // field, find what bicep assigns to it, and if that is a parameter, check the
  // parameter cannot default to a deploy-time value.
  for (const entry of IMMUTABLE_FIELDS) {
    const src = fs.readFileSync(path.join(BICEP_ROOT, entry.file), 'utf8');
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
  const offenders = [];
  for (const file of bicepFiles(BICEP_ROOT)) {
    const rel = path.relative(BICEP_ROOT, file).split(path.sep).join('/');
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

test('CONTROL: the allowlist has no dead entries', () => {
  // An allowlist that outlives its target silently stops constraining anything,
  // and the next reader trusts it. Every entry must still match real source.
  for (const a of ROTATOR_ALLOWLIST) {
    const full = path.join(BICEP_ROOT, a.file);
    assert.ok(fs.existsSync(full), `allowlist names a file that no longer exists: ${a.file}`);
    assert.ok(
      fs.readFileSync(full, 'utf8').includes(a.match),
      `allowlist entry for ${a.file} no longer matches any line: ${a.match}`,
    );
    assert.ok(a.why && a.why.length > 30, `allowlist entry for ${a.file} needs a real reason`);
  }
});

test('CONTROL: stripProse removes prose without blinding the sweep to code', () => {
  // The sweep's correctness rests entirely on this. If it over-strips, the
  // guard silently stops seeing real calls — the failure mode that matters.
  assert.equal(stripProse("@description('derived from newGuid()')").includes('newGuid('), false);
  assert.equal(stripProse("  // param x = utcNow()").includes('utcNow('), false);
  assert.equal(stripProse("when: '@utcNow()'").includes('utcNow('), false);
  assert.equal(stripProse('param forceUpdateTag string = utcNow()').includes('utcNow('), true);
  assert.equal(stripProse("param startDate string = utcNow('yyyy-MM-01')").includes('utcNow('), true);
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

test('CONTROL: every deploy lane that APPLIES main.bicep resolves the start date first', () => {
  // The counterpart to "empty means do not declare": if a lane forgets the
  // resolver it stops managing the budget SILENTLY. That is safe for the estate
  // but it is not what anyone intended, so it is pinned here rather than left to
  // be noticed.
  const lanes = [
    'deploy-fiab-commercial.yml',
    'deploy-fiab-gcc.yml',
    'deploy-fiab-gcch.yml',
    'deploy-fiab-il5.yml',
  ];
  for (const lane of lanes) {
    const src = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows', lane), 'utf8');
    assert.match(
      src,
      /resolve-program-budget-start-date\.mjs/,
      `${lane} applies platform/fiab/bicep/main.bicep, so it must resolve the program budget's immutable ` +
        'start date from the estate before the apply (#4253) — every boundary carries the same bomb on its ' +
        'own month boundary (cloud-parity.md).',
    );
    assert.match(
      src,
      new RegExp(`programBudgetStartDate|${OUTPUT_VAR}`),
      `${lane} resolves the start date but never passes it through to observabilityConfig.`,
    );
  }
});
