/**
 * Self-tests for the deploy-path DISPOSITION register (#4144).
 *
 * ── WHAT IS BEING PINNED ────────────────────────────────────────────────────
 *
 * `deploy-staleness` reported eight stale / failing / never-run deploy paths on
 * every run. Two were tracked; SIX were not, and nothing in the repo recorded a
 * decision about any of them, so the check reported them daily into a void.
 * The fix has two halves and BOTH can rot silently:
 *
 *   1. Three lanes got an automatic TRIGGER (deploy-loom-uat, deploy-loom-verify,
 *      deploy-report-subscriptions), because they should run by themselves.
 *   2. Three lanes are dispatch-only BY DESIGN and now say so in
 *      scripts/ci/deploy-path-dispositions.json, where the check can read the
 *      intent and report ACK instead of failing (deploy-fiab-il5,
 *      gov-uc-purview-wire, deploy-loom-sharing).
 *
 * The failure mode this suite exists for is the one the register itself is
 * about: a control that LOOKS like a decision record while recording nothing.
 * Three ways that happens, each with tests below:
 *
 *   - a trigger is removed or narrowed and the lane goes back to never running,
 *     with the register still saying nothing about it;
 *   - a `workflow_run` names an upstream workflow that no longer exists (a
 *     rename in the OTHER file), so the trigger is a permanent no-op that fires
 *     for nothing and errors nowhere — a guard that does not watch;
 *   - the register acquires an entry for a lane that DOES run automatically, so
 *     one of the two halves is lying and neither says which.
 *
 * ── MUTATIONS THESE TESTS DIE UNDER ─────────────────────────────────────────
 *
 *   - narrow deploy-loom-uat.yml's `push: paths:` (e.g. drop the job script) →
 *     that WATCHED path is reachable by no trigger, is not declared in
 *     TRIGGER_GAPS, and the coverage test goes red.
 *   - delete a TRIGGER_GAPS entry's reason, or shorten it below
 *     MIN_REASON_CHARS → the coverage test goes red. A gap must say what was
 *     MEASURED, not that it exists.
 *   - ADD coverage for a declared gap (widen the push filter to include
 *     `apps/fiab-console/e2e/**`) → the coverage test ALSO goes red, because
 *     the exemption is now false. That inversion is deliberate: a `grep -l`
 *     exemption rots silently, a `grep -L` one cannot.
 *   - drop `workflow_run` from deploy-loom-verify.yml → the upstream-exists
 *     test goes red (its image-equality assertion is only meaningful
 *     immediately after a roll).
 *   - rename the upstream in a `workflow_run.workflows` list → the
 *     "upstream exists" test goes red (the whole point: GitHub does not error).
 *   - delete the `github.event.workflow_run.conclusion == 'success'` clause →
 *     the conclusion-gate test goes red (a FAILED roll would chain a deploy).
 *   - declare a triggered lane dormant in the register → the mutual-exclusion
 *     test goes red.
 *   - remove the NEVER_ACKNOWLEDGEABLE filter in _deploy-path-disposition.mjs →
 *     the `failing` refusal test goes red.
 *   - make applyDisposition return `stale:false` whenever an entry exists →
 *     the partial-acknowledgment test goes red.
 *   - make decide() ignore `findings` → the register-findings exit test goes red.
 *   - raise or remove MAX_REVIEW_DAYS → the far-future `reviewBy` refusal goes
 *     red (an entry you can hide in for 73 years is an allowlist).
 *
 * Run: node --test scripts/ci/__tests__/deploy-path-dispositions.test.mjs
 * (Auto-discovered by scripts/ci/check-node-test-suites.mjs, which the
 *  merge-blocking `guardrails` job runs — so these have teeth in CI.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkflow, scalarValue } from '../_workflow-yaml.mjs';
import {
  ACKNOWLEDGEABLE,
  auditDispositionRegister,
  classifyDisposition,
  DISPOSITION_PATH,
  DISPOSITIONS,
  MAX_REVIEW_DAYS,
  MIN_REASON_CHARS,
  NEVER_ACKNOWLEDGEABLE,
} from '../_deploy-path-disposition.mjs';
import { applyDisposition, conditionsOf, decide, WATCHED } from '../check-deploy-staleness.mjs';

const WORKFLOWS = '.github/workflows';
const TODAY = '2026-09-01';

/**
 * The lanes THIS change gave an automatic trigger, and the lanes it declared
 * deliberately dormant. Named rather than derived: the point of the tests below
 * is to catch the two sets drifting apart, and deriving both from the same
 * source would make that undetectable.
 */
const TRIGGERED = ['deploy-loom-uat.yml', 'deploy-loom-verify.yml', 'deploy-report-subscriptions.yml'];
const DECLARED_DORMANT = ['deploy-fiab-il5.yml', 'gov-uc-purview-wire.yml', 'deploy-loom-sharing.yml'];

const REGISTER = JSON.parse(readFileSync(DISPOSITION_PATH, 'utf8'));

/** A well-formed entry, minus whatever a test wants to break. */
const entry = (over = {}) => ({
  workflow: 'deploy-fiab-il5.yml',
  disposition: 'dispatch-only',
  owner: 'fgarofalo56',
  declaredOn: '2026-09-01',
  reviewBy: '2026-12-01',
  acknowledges: ['never-run'],
  reason: 'x'.repeat(MIN_REASON_CHARS + 10),
  ...over,
});
const reg = (...entries) => ({ dispositions: entries });
const classify = (register, workflow = 'deploy-fiab-il5.yml', today = TODAY) =>
  classifyDisposition({ register, workflow, today });

// ---------------------------------------------------------------------------
// Workflow-file helpers. parseWorkflow is a block parser, so a FLOW sequence
// (`workflows: ['a']`) arrives as one scalar string while a BLOCK sequence
// arrives as an array of scalar nodes. Both shapes are live in this repo, so
// normalise rather than pick one — a helper that understood only the shape the
// files happen to use today would silently read [] after a reformat.
// ---------------------------------------------------------------------------

function seq(node) {
  if (Array.isArray(node)) return node.map(scalarValue).filter((v) => typeof v === 'string');
  const s = scalarValue(node);
  if (typeof s !== 'string') return [];
  const flow = s.trim().match(/^\[(.*)\]$/s);
  const body = flow ? flow[1] : s;
  return body
    .split(',')
    .map((p) => p.trim().replace(/^['"]|['"]$/g, ''))
    .filter((p) => p.length > 0);
}

const docFor = (file) => parseWorkflow(readFileSync(join(WORKFLOWS, file), 'utf8'));

/** file name → parsed doc, and workflow `name:` → file name, for the whole dir. */
const ALL_WORKFLOWS = readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
const BY_NAME = new Map();
for (const f of ALL_WORKFLOWS) {
  const n = scalarValue(parseWorkflow(readFileSync(join(WORKFLOWS, f), 'utf8')).name);
  if (typeof n === 'string' && !BY_NAME.has(n)) BY_NAME.set(n, f);
}

/** True when this workflow can start without a human dispatching it. */
function hasAutomaticTrigger(file) {
  const on = docFor(file).on || {};
  return Boolean(on.push || on.schedule || on.workflow_run);
}

/**
 * Every `push` path filter reachable from `file`, following `workflow_run`
 * upstreams transitively.
 *
 * A lane can be reached two ways: its own `push` filter, or a chain
 * (`deploy-loom-uat` ← `loom-roll-and-validate` ← `build-fiab-images-acr-tasks`,
 * whose recursive `apps/fiab-<app>` filter is what actually carries an e2e
 * change through to it). Only following the chain can tell "covered by the
 * chain" apart from "not covered at all", and those have opposite fixes.
 */
function reachablePushFilters(file, seen = new Set(), depth = 0) {
  if (seen.has(file) || depth > 4) return [];
  seen.add(file);
  const on = docFor(file).on || {};
  const out = seq(on.push?.paths);
  for (const upstreamName of seq(on.workflow_run?.workflows)) {
    const upstreamFile = BY_NAME.get(upstreamName);
    if (upstreamFile) out.push(...reachablePushFilters(upstreamFile, seen, depth + 1));
  }
  return out;
}

/**
 * A GitHub path filter as an anchored RegExp. `**` crosses `/`, `*` does not.
 * Deliberately NOT a full glob engine — it is only ever asked whether one
 * concrete witness path matches, which is the narrow question below.
 */
function filterToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') { re += '.*'; i++; continue; }
    if (pattern[i] === '*') { re += '[^/]*'; continue; }
    re += pattern[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** One concrete file path the WATCHED pattern denotes, for the match above. */
function witnessFor(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') { out += 'sub/leaf'; i++; continue; }
    if (pattern[i] === '*') { out += 'x'; continue; }
    out += pattern[i];
  }
  return out;
}

// ===========================================================================
// classifyDisposition — SUPPRESSION TAKES POSITIVE EVIDENCE
// ===========================================================================

test('a well-formed, owned, unexpired entry IS declared (the one accepting path)', () => {
  const v = classify(reg(entry()));
  assert.equal(v.declared, true);
  assert.equal(v.hasEntry, true);
  assert.deepEqual(v.acknowledges, ['never-run']);
  assert.match(v.reason, /DECLARED dispatch-only/);
});

test('CONTROL: no register at all acknowledges nothing — judged exactly as before', () => {
  for (const register of [null, undefined]) {
    const v = classify(register);
    assert.equal(v.declared, false, 'a missing register must never suppress');
    assert.equal(v.hasEntry, false, 'and must not read as a REFUSED entry either');
  }
});

test('an entry for a DIFFERENT lane never covers this one', () => {
  const v = classify(reg(entry({ workflow: 'gov-uc-purview-wire.yml' })), 'deploy-fiab-il5.yml');
  assert.equal(v.declared, false);
  assert.equal(v.hasEntry, false);
});

test('every malformed shape resolves to NOT-acknowledging, and says which rule failed', () => {
  // Table-driven so a NEW rule that forgets to refuse is a missing row here, not
  // a silent hole. Each `why` is asserted against the printed reason, because a
  // refusal the operator cannot read is the same as no refusal (R7).
  const cases = [
    ['not an object', 'not a JSON object', reg().dispositions],
    ['no dispositions array', 'no `dispositions` array', {}],
    ['unknown disposition value', 'is not one of', reg(entry({ disposition: 'runs-automatically' }))],
    ['no owner', 'names no `owner`', reg(entry({ owner: '   ' }))],
    ['thin reason', `minimum ${MIN_REASON_CHARS}`, reg(entry({ reason: 'dormant' }))],
    ['placeholder reason', 'placeholder', reg(entry({ reason: `TODO ${'x'.repeat(MIN_REASON_CHARS)}` }))],
    ['declaredOn not a date', '`declaredOn` is not an ISO date', reg(entry({ declaredOn: 'yesterday' }))],
    ['declaredOn in the future', 'LATER than today', reg(entry({ declaredOn: '2027-01-01', reviewBy: '2027-06-01' }))],
    ['reviewBy not a date', '`reviewBy` is not an ISO date', reg(entry({ reviewBy: 'soon' }))],
    ['born expired', 'not after its `declaredOn`', reg(entry({ reviewBy: '2026-09-01' }))],
    ['expired', 'EXPIRED on', reg(entry({ declaredOn: '2026-01-01', reviewBy: '2026-02-01' }))],
    // The far-future entry is the one that made expiry advisory: it satisfies
    // EVERY other rule in the chain — real ISO dates, after declaredOn, not yet
    // past — and acknowledged for 73 years. The cap is what makes the register
    // an expiring decision rather than an allowlist with extra ceremony.
    ['reviewBy past the cap', `over the ${MAX_REVIEW_DAYS}-day cap`, reg(entry({ reviewBy: '2099-12-31' }))],
    // ISO-SHAPED but not a date. Every other date rule here compares strings, so
    // month 13 sorts ABOVE every real date in 2026 and reads as a far expiry to
    // all of them. Only the span check parses, so only the span check catches it.
    ['impossible month', 'not real dates', reg(entry({ reviewBy: '2026-13-45' }))],
    ['no acknowledges', 'declares no `acknowledges`', reg(entry({ acknowledges: [] }))],
    ['unknown condition', 'unrecognised condition', reg(entry({ acknowledges: ['nevr-run'] }))],
    ['duplicate lanes', 'declared 2 times', reg(entry(), entry())],
  ];
  for (const [label, why, register] of cases) {
    const v = classify(register);
    assert.equal(v.declared, false, `${label}: MUST NOT acknowledge`);
    assert.ok(v.reason.includes(why), `${label}: reason should name the rule; got ${JSON.stringify(v.reason)}`);
  }
  assert.ok(cases.length >= 16, 'the refusal table must not shrink silently');
});

test('a bad `today` refuses rather than suppressing forever (an expiry that cannot fire)', () => {
  const v = classify(reg(entry()), 'deploy-fiab-il5.yml', 'not-a-date');
  assert.equal(v.declared, false);
  assert.match(v.reason, /reviewBy expiry could not be evaluated/);
});

test('NO entry may acknowledge failing / disabled / state-unknown / query-failed', () => {
  // The P0 signals. Six weeks of red full-app-deploy-commercial and seventeen
  // red GCC-High runs are what these exist for, and no amount of register
  // editing may suppress them.
  for (const forbidden of NEVER_ACKNOWLEDGEABLE) {
    const v = classify(reg(entry({ acknowledges: [forbidden] })));
    assert.equal(v.declared, false, `${forbidden} must never be acknowledgeable`);
    assert.ok(v.reason.includes(forbidden));
  }
  assert.equal(NEVER_ACKNOWLEDGEABLE.length, 4, 'the forbidden set must not shrink silently');
});

test('a forbidden condition beside a legal one refuses the WHOLE entry', () => {
  // Not "drops the bad one and honours the rest": that would let `failing` ride
  // along inside an otherwise reasonable-looking entry and suppress `never-run`
  // while the operator believed only the legal half was in play.
  const v = classify(reg(entry({ acknowledges: ['never-run', 'failing'] })));
  assert.equal(v.declared, false);
  assert.deepEqual(v.acknowledges, []);
});

// ===========================================================================
// applyDisposition — a disposition covers ONLY what it names
// ===========================================================================

test('conditionsOf names every wrong thing, and [] when the row is clean', () => {
  assert.deepEqual(conditionsOf({ neverRan: true }, { failing: true }, { disabled: true }),
    ['never-run', 'failing', 'disabled']);
  assert.deepEqual(conditionsOf({ stale: true, driftDays: 20 }, {}, {}), ['drift']);
  assert.deepEqual(conditionsOf({ queryFailed: true, neverRan: true }, {}, {}), ['query-failed'],
    'an unreadable history is ONE fact, not two — never-run is not established');
  assert.deepEqual(conditionsOf({}, {}, {}), []);
  assert.deepEqual(conditionsOf({}, {}, { unknown: true }), ['state-unknown']);
});

test('acknowledging EVERY condition clears stale but reports ACKNOWLEDGED, never ok', () => {
  const v = applyDisposition({
    conditions: ['never-run'],
    disposition: { declared: true, acknowledges: ['never-run'] },
  });
  assert.equal(v.stale, false);
  assert.equal(v.acknowledged, true, 'the row must still be distinguishable from a clean one');
  assert.deepEqual(v.unacknowledged, []);
});

test('acknowledging SOME leaves the row STALE on the remainder', () => {
  // The asymmetry that matters. A `never-run` sign-off cannot cover a failure
  // streak that appears beside it.
  const v = applyDisposition({
    conditions: ['never-run', 'failing'],
    disposition: { declared: true, acknowledges: ['never-run'] },
  });
  assert.equal(v.stale, true);
  assert.equal(v.acknowledged, false, 'half-covered is NOT acknowledged — that would assert more than was established');
  assert.deepEqual(v.unacknowledged, ['failing']);
});

test('CONTROL: no disposition leaves the verdict byte-for-byte what it was', () => {
  assert.equal(applyDisposition({ conditions: ['drift'], disposition: { declared: false } }).stale, true);
  assert.equal(applyDisposition({ conditions: [], disposition: { declared: false } }).stale, false);
  assert.equal(applyDisposition({ conditions: [], disposition: { declared: false } }).acknowledged, false,
    'a clean row is ok, never ACK');
});

test('a REFUSED entry acknowledges nothing even though acknowledges[] is populated', () => {
  // declared:false is the only thing that may suppress. Reading `acknowledges`
  // without it would honour every entry the classifier had just rejected.
  const v = applyDisposition({
    conditions: ['never-run'],
    disposition: { declared: false, acknowledges: ['never-run'] },
  });
  assert.equal(v.stale, true);
});

// ===========================================================================
// auditDispositionRegister + decide — the register must stay TRUE
// ===========================================================================

test('an entry for a lane that is not WATCHED is a FINDING, not a silent no-op', () => {
  const f = auditDispositionRegister({
    register: reg(entry({ workflow: 'deploy-renamed.yml' })),
    rows: [{ workflow: 'deploy-fiab-il5.yml', conditions: ['never-run'] }],
  });
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'not-watched');
});

test('a never-run sign-off on a lane that HAS now run must be drained', () => {
  const f = auditDispositionRegister({
    register: reg(entry({ acknowledges: ['never-run'] })),
    rows: [{ workflow: 'deploy-fiab-il5.yml', conditions: [] }],
  });
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'never-run-drained');
});

test('CONTROL: a `drift` sign-off on a lane that is no longer drifting is NOT a finding', () => {
  // Drift oscillates; demanding a drain the moment it clears would make the
  // register churn. That entry expires on reviewBy instead.
  const f = auditDispositionRegister({
    register: reg(entry({ acknowledges: ['drift'] })),
    rows: [{ workflow: 'deploy-fiab-il5.yml', conditions: [] }],
  });
  assert.deepEqual(f, []);
});

test('a duplicate entry, and a malformed register, are findings', () => {
  const dup = auditDispositionRegister({
    register: reg(entry(), entry()),
    rows: [{ workflow: 'deploy-fiab-il5.yml', conditions: ['never-run'] }],
  });
  assert.deepEqual(dup.map((x) => x.kind), ['duplicate-entry']);

  const bad = auditDispositionRegister({ register: { nope: true }, rows: [] });
  assert.deepEqual(bad.map((x) => x.kind), ['register-malformed']);

  assert.deepEqual(auditDispositionRegister({ register: null, rows: [] }), [],
    'no register is not a finding — the common case is a repo with nothing dormant');
});

test('decide(): a register finding fails the check even when EVERY row is clean', () => {
  // Wired into the exit code, not printed beside it. A signal that is computed
  // and then discarded is the gate-that-cannot-fail shape.
  const clean = [{ stale: false }, { stale: false }];
  assert.equal(decide(clean).code, 0);
  assert.equal(decide(clean, [{ kind: 'not-watched', subject: 'x', why: 'y' }]).code, 1);
  assert.equal(decide([{ stale: true }], []).code, 1);
});

// ===========================================================================
// THE SHIPPED REGISTER vs THE SHIPPED WORKFLOWS
// ===========================================================================

test('every shipped register entry names a WATCHED lane and is structurally valid', () => {
  const watched = new Set(WATCHED.map((w) => w.workflow));
  assert.ok(Array.isArray(REGISTER.dispositions) && REGISTER.dispositions.length > 0,
    `${DISPOSITION_PATH} must carry at least one entry while lanes are declared dormant`);
  for (const e of REGISTER.dispositions) {
    assert.ok(watched.has(e.workflow),
      `${e.workflow} is declared dormant but is not WATCHED — the entry acknowledges nothing while reading as a decision`);
    assert.ok(DISPOSITIONS.includes(e.disposition), `${e.workflow}: unknown disposition ${e.disposition}`);
    for (const c of e.acknowledges) {
      assert.ok(ACKNOWLEDGEABLE.includes(c), `${e.workflow}: ${c} is not acknowledgeable`);
    }
    // Validated AS OF ITS OWN declaredOn, deliberately. Asserting "unexpired
    // today" would put a time bomb in a merge-blocking suite: on the day a
    // reviewBy lapsed, every PR in the repo would go red for a reason no PR
    // caused. Expiry is the STALENESS CHECK's teeth — it turns the row red
    // there, where the operator is looking — and this only proves the entry was
    // well-formed and not born expired.
    //
    // It ALSO enforces MAX_REVIEW_DAYS on shipped data, and does so without
    // reintroducing that time bomb: the cap is measured declaredOn→reviewBy, a
    // property of the entry itself, so it reads the same on every day forever.
    // Shortening the cap below any shipped entry's span turns this red.
    const v = classifyDisposition({ register: REGISTER, workflow: e.workflow, today: e.declaredOn });
    assert.equal(v.declared, true, `${e.workflow}: shipped entry is refused on its own declaredOn — ${v.reason}`);
  }
});

test('the three lanes declared dormant carry an entry; the three triggered lanes do not', () => {
  // THE MUTUAL EXCLUSION. An entry saying "dispatch-only" on a lane that runs on
  // a push is a register that has stopped describing reality — and reading as a
  // decision is exactly what makes that dangerous.
  const declared = new Set(REGISTER.dispositions.map((e) => e.workflow));
  for (const wf of DECLARED_DORMANT) {
    assert.ok(declared.has(wf), `${wf} is dispatch-only by design but is declared nowhere — it reports into a void`);
  }
  for (const wf of TRIGGERED) {
    assert.ok(!declared.has(wf), `${wf} runs automatically; a dormancy declaration for it would be false`);
  }
});

test('a DECLARED-dormant lane must genuinely have no automatic trigger', () => {
  // The other direction of the same lie: someone adds a schedule and leaves the
  // "deliberately dormant" entry in place, so the register keeps ACKing a lane
  // that is in fact running (or, in the reviewer-gated case, stacking `waiting`
  // runs that execute nothing — #4233).
  for (const e of REGISTER.dispositions) {
    assert.equal(hasAutomaticTrigger(e.workflow), false,
      `${e.workflow} is declared ${e.disposition} in ${DISPOSITION_PATH} but has an automatic trigger. `
      + 'One of the two is wrong: either drain the entry, or remove the trigger.');
  }
});

test('a WATCHED lane that has NEVER been able to run must be declared or triggered', () => {
  // The population this whole issue was about. Both never-run lanes are covered:
  // deploy-fiab-il5 by a declaration (its environment carries required_reviewers,
  // so a trigger would only stack `waiting` runs), deploy-report-subscriptions by
  // a push filter. Neither may quietly become "dispatch-only and undeclared".
  const declared = new Set(REGISTER.dispositions.map((e) => e.workflow));
  const subjects = [...TRIGGERED, ...DECLARED_DORMANT];
  for (const wf of subjects) {
    assert.ok(hasAutomaticTrigger(wf) || declared.has(wf),
      `${wf} neither runs by itself nor records a decision that it should not — that is the #4144 void`);
  }
  assert.equal(subjects.length, 6, 'all six #4144 lanes must stay in this population');
});

// ===========================================================================
// THE TRIGGERS THEMSELVES
// ===========================================================================

/**
 * WATCHED paths deliberately left WITHOUT an automatic trigger, and why.
 *
 * This is an exemption register, not an exemption list: the test below asserts
 * each declared gap is STILL genuinely uncovered. Add coverage for one of these
 * and the entry goes red, forcing the exemption to be deleted rather than
 * quietly outliving its reason. That inversion is the point — a `grep -l`
 * exemption rots silently, a `grep -L` one cannot.
 */
const TRIGGER_GAPS = Object.freeze({
  'deploy-loom-uat.yml': Object.freeze({
    'apps/fiab-console/Dockerfile.uat':
      'inside build-fiab-images-acr-tasks.yml\'s own `apps/fiab-*/**` push filter, so any trigger here '
      + 'co-fires this lane with the image builder. MEASURED 2026-09-01 over the builder\'s last 12 runs: it '
      + 'holds the per-registry ACR firewall lease for a median of 37 minutes (range 24-94) against this '
      + 'lane\'s 25-minute LOOM_ACR_LEASE_WAIT_MINUTES budget — so the loser hard-fails more often than not. '
      + 'An automatic trigger here would go red on precisely the commits that fire it. Dispatch instead; the '
      + 'staleness check still reports this lane STALE, which is a visible signal, not a void.',
    'apps/fiab-console/e2e/**':
      'same measurement, same filter: `apps/fiab-console/e2e/**` sits inside the image builder\'s '
      + '`apps/fiab-*/**` push filter. deploy-loom-uat.yml\'s header has always cited ACR-lease collision as '
      + 'the reason it declines to trigger on e2e/**; the numbers above are that argument, measured. Closing '
      + 'this gap needs the lease wait raised past the builder\'s observed 94-minute maximum, not a new trigger.',
    'scripts/ci/resolve-automation-oid.mjs':
      'the same collision reached INDIRECTLY, which is why it survived the first two entries. Being outside '
      + '`apps/fiab-*/**` is necessary and NOT sufficient: this file is a node in the committed security graph '
      + 'and its node encodes LINE-NUMBERED sinks (console:member:456/459/465/471), so any ordinary edit shifts '
      + 'them and forces `apps/fiab-console/lib/brain/security/extract/__generated__/security-graph.json` to be '
      + 'regenerated in the SAME commit — the drift gate is merge-blocking. That artifact IS inside the builder\'s '
      + 'filter. So a commit touching this file starts this lane under `acr-firewall-<region>` AND the builder '
      + 'under `build-fiab-images-acr-tasks-<boundary>` — two DISJOINT groups GitHub will not serialize — and the '
      + 'loser waits out the same 25-minute budget against the same median-37-minute holder. It was a trigger '
      + 'until the round-2 review of #4266 measured the coupling. It remains a trigger on deploy-loom-verify.yml, '
      + 'which takes no ACR lease at all, so co-firing there costs nothing.',
  }),
});

test('each triggered lane can be reached by every source check-deploy-staleness watches', () => {
  // The claim the trigger makes: the drift this check MEASURES is now
  // self-clearing. A push filter narrowed below the WATCHED set silently
  // re-opens the gap, which is how deploy-loom-uat accumulated 28 days.
  let checked = 0;
  let gapsSeen = 0;
  for (const wf of TRIGGERED) {
    const entryW = WATCHED.find((w) => w.workflow === wf);
    assert.ok(entryW, `${wf} must be WATCHED — a trigger on an unwatched lane proves nothing`);
    const filters = reachablePushFilters(wf).map(filterToRegExp);
    assert.ok(filters.length > 0, `${wf}: no push filter is reachable at all`);
    const gaps = TRIGGER_GAPS[wf] || {};
    for (const p of entryW.paths) {
      const witness = witnessFor(p);
      const covered = filters.some((re) => re.test(witness));
      if (Object.hasOwn(gaps, p)) {
        // The exemption must stay TRUE. If coverage appears, delete the entry.
        assert.ok(!covered,
          `${wf}: WATCHED path ${p} is declared a trigger gap but IS now reachable by a push filter. `
          + 'Delete the TRIGGER_GAPS entry — a stale exemption is how a real gap hides behind an old reason.');
        assert.ok(String(gaps[p]).length >= MIN_REASON_CHARS,
          `${wf}: the trigger gap for ${p} must say what was MEASURED, in at least ${MIN_REASON_CHARS} chars`);
        gapsSeen++;
        continue;
      }
      assert.ok(covered,
        `${wf}: WATCHED path ${p} (witness ${witness}) is not covered by any reachable push filter. `
        + 'A change there would be undeployed with nothing to trigger a deploy. If that is deliberate, '
        + 'declare it in TRIGGER_GAPS with the measurement that justifies it.');
      checked++;
    }
    // No exemption may name a path the register no longer watches.
    assert.equal(Object.keys(gaps).length, Object.keys(gaps).filter((p) => entryW.paths.includes(p)).length,
      `${wf}: a TRIGGER_GAPS entry names a path that is no longer in WATCHED — delete it`);
  }
  // POPULATION, pinned two ways. The floor alone was not enough: moving a path
  // from `checked` into `TRIGGER_GAPS` lowers it by one, which reads as "the
  // floor still holds" rather than as "a source stopped being covered". So the
  // TOTAL is pinned as well — a path may move between the buckets only with
  // both numbers edited, and it can never leave the population unnoticed.
  //
  // 12 = 10 covered + 2 exempt until the round-2 review of #4266, which measured
  // that `scripts/ci/resolve-automation-oid.mjs` reaches the image builder's
  // path filter INDIRECTLY, through the line-numbered security-graph artifact it
  // forces to be regenerated. It is now 9 + 3.
  assert.equal(checked + gapsSeen, 12,
    `every WATCHED path of the triggered lanes must be either covered or exempt; saw ${checked} + ${gapsSeen}`);
  assert.ok(checked >= 9, `expected every non-exempt WATCHED path of all three lanes; only ${checked} were checked`);
  assert.equal(gapsSeen, 3, `exactly the three measured lease-collision gaps are expected; saw ${gapsSeen}`);
});

test('every workflow_run upstream names a workflow that EXISTS', () => {
  // GitHub does not error on a `workflow_run` naming nothing: the trigger simply
  // never fires. So a rename in the OTHER file turns this lane back into a
  // dispatch-only one with no signal anywhere — a guard that does not watch.
  let refs = 0;
  for (const wf of TRIGGERED) {
    for (const name of seq(docFor(wf).on?.workflow_run?.workflows)) {
      assert.ok(BY_NAME.has(name),
        `${wf} chains off workflow_run "${name}", and no file in ${WORKFLOWS} declares that name. `
        + 'The trigger can never fire, silently.');
      refs++;
    }
  }
  // Named, not counted: deploy-loom-verify is the ONE remaining chain. Its
  // image-equality assertion (`$IMAGE != $CONSOLE_IMAGE`) is only meaningful
  // immediately after a roll, so it is the one lane the chain genuinely buys
  // something for — and it takes no ACR lease, so it cannot collide.
  // deploy-loom-uat chained here too until the lease measurement below.
  assert.ok(seq(docFor('deploy-loom-verify.yml').on?.workflow_run?.workflows).length > 0,
    'deploy-loom-verify.yml must still chain off the roll — its image assertion is worthless on a push trigger');
  assert.ok(refs >= 1, `expected the loom-verify chain; found ${refs} workflow_run reference(s)`);
});

test('a workflow_run consumer must gate on the upstream CONCLUSION', () => {
  // Without it a FAILED roll chains a deploy: loom-verify would be re-pinned to
  // an image that is not serving.
  let gated = 0;
  for (const wf of TRIGGERED) {
    const doc = docFor(wf);
    if (!doc.on?.workflow_run) continue;
    const jobs = doc.jobs || {};
    for (const jobName of Object.keys(jobs)) {
      const cond = scalarValue(jobs[jobName].if) ?? '';
      assert.match(cond, /workflow_run\.conclusion\s*==\s*'success'/,
        `${wf}: job "${jobName}" runs on a workflow_run trigger without checking the upstream conclusion`);
      gated++;
    }
  }
  assert.ok(gated >= 1, `expected the surviving workflow_run consumer to be gated; found ${gated}`);
});

test('no triggered lane runs in a protected ENVIRONMENT (the #4233 waiting-run trap)', () => {
  // MEASURED 2026-09-01: `gh api repos/fgarofalo56/csa-inabox/environments`
  // reports required_reviewers on il5-deploy, gcc-high-deploy and prod. An
  // automatic trigger on a job in one of those produces runs that park at
  // `waiting` and execute NOTHING, one per firing, forever — which is why
  // deploy-fiab-il5 got a declaration instead of a schedule. The checkable
  // proxy is that these three lanes name no environment at all.
  let jobs = 0;
  for (const wf of TRIGGERED) {
    const doc = docFor(wf);
    for (const jobName of Object.keys(doc.jobs || {})) {
      assert.equal(doc.jobs[jobName].environment, undefined,
        `${wf}: job "${jobName}" declares an environment. If it is reviewer-gated, every automatic run parks `
        + 'at `waiting` and deploys nothing — an honest stale row replaced by a queue of runs that measure nothing.');
      jobs++;
    }
  }
  assert.ok(jobs >= 3, `expected at least one job per triggered lane; found ${jobs}`);
});

test('a triggered lane must not be able to auto-run in DRY-RUN mode', () => {
  // All three default `dry_run: true` so a human exploring the lane deploys
  // nothing by accident. That default must reach ONLY the dispatch path: on a
  // push or workflow_run the `inputs` context is empty, so the deploy step's
  // `!inputs.dry_run` is true. If someone "fixes" that to a defaulted
  // expression, every automatic run would succeed having deployed nothing and
  // would CLEAR the lane's drift — the exact false receipt the DRY RUN filter
  // in check-deploy-staleness exists to refuse.
  let guarded = 0;
  for (const wf of TRIGGERED) {
    const text = readFileSync(join(WORKFLOWS, wf), 'utf8');
    assert.ok(/if:\s*\$\{\{\s*!inputs\.dry_run\s*\}\}/.test(text),
      `${wf}: the deploy step must be gated on the bare \`!inputs.dry_run\`, so an automatic run (empty inputs) `
      + 'deploys for real');
    assert.ok(!/inputs\.dry_run\s*\|\|\s*true/.test(text),
      `${wf}: defaulting dry_run to true would make every automatic run a no-op that still clears the drift row`);
    guarded++;
  }
  assert.equal(guarded, TRIGGERED.length);
});
