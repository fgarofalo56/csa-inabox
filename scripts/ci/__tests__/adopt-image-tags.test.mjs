/**
 * Self-tests for adopt-image-tags.mjs (#3449, the design half of #3161).
 *
 * WHAT IS BEING PINNED. #3161 put the sixteen `LOOM_*_TAG` variables in scope
 * where the Gov lanes deploy. That is necessary and not sufficient: in scope
 * with `${{ vars.LOOM_CONSOLE_TAG || 'v0.1' }}` and the repo variable unset —
 * its normal state — a scheduled reconcile still proposes the param file's own
 * default over whatever the estate is running, which is why deploy-fiab-gcch
 * failed every scheduled run. These tests prove the deploy now RESOLVES that
 * value from the estate instead of demanding a human type it.
 *
 * Every CONTROL is chosen to DIE under an obvious mutation:
 *
 *   - drop the `adopted` branch (always take the param default) -> the #3449
 *     control and the live-GCC-High control both go red.
 *   - order adoption ABOVE the explicit request -> the request-wins control
 *     goes red (a reconcile would silently undo an operator's roll forward,
 *     which is the same defect with the sign flipped).
 *   - treat UNKNOWN as adoptable (invent a tag for a digest-pinned app) ->
 *     the digest control goes red.
 *   - collapse a FAILED probe into "nothing is running" -> the failed-probe
 *     control goes red; that collapse is what deploy-integrity R7 forbids.
 *   - emit env lines only for RUNNING apps (reconcile-resolve.mjs's rule) ->
 *     the every-declared-tag control goes red, and the Gov consumers that run
 *     under `set -u` would abort on the missing variable.
 *
 * The running-image side is NOT re-implemented here: it comes from
 * resolveRunningImageTags() in reconcile-policy.mjs, the same function the
 * Commercial lane uses in production, and the declared defaults come from
 * declaredTagDefaults() reading the REAL `.bicepparam` files. A fixture that
 * modelled the code instead of running the dependency would agree with itself
 * and prove nothing (`csa_loom_fixtures_that_model_the_code`).
 *
 * Run: node --test scripts/ci/__tests__/adopt-image-tags.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decideAdoptions, requestVarFor, ENTRY_BY_ENV_VAR } from '../adopt-image-tags.mjs';
import { decideTagWrites, declaredTagDefaults } from '../assert-no-silent-image-tag-revert.mjs';
import { resolveRunningImageTags, APP_IMAGE_TAGS } from '../reconcile-policy.mjs';

const ACR = 'acrloomxxxx.azurecr.us';
const declared = new Map([['LOOM_CONSOLE_TAG', 'v0.1'], ['LOOM_UNITY_TAG', 'v0.1'], ['LOOM_TRINO_TAG', 'v0.1']]);
const running = (pairs) => resolveRunningImageTags(pairs.map(([name, image]) => ({ name, image })));
const row = (r, envVar) => r.rows.find((x) => x.envVar === envVar);
const envOf = (r) => Object.fromEntries(r.envLines.map((l) => {
  const i = l.indexOf('=');
  return [l.slice(0, i), l.slice(i + 1)];
}));

// ---------------------------------------------------------------------------
// THE #3449 CONTROL — the value the deploy needed was already measurable
// ---------------------------------------------------------------------------

test('CONTROL: a live SHA-pinned app is ADOPTED, not flattened to the param default', () => {
  const r = decideAdoptions({
    declared,
    env: {}, // no repo variable set — the state that broke the scheduled lane
    resolution: running([
      ['loom-console', `${ACR}/loom-console:28de89fb`],
      ['loom-unity', `${ACR}/loom-unity:v0.1`],
      ['loom-trino', `${ACR}/loom-trino:v0.1`],
    ]),
  });
  assert.equal(row(r, 'LOOM_CONSOLE_TAG').source, 'adopted');
  assert.equal(row(r, 'LOOM_CONSOLE_TAG').value, '28de89fb');
  assert.equal(envOf(r).LOOM_CONSOLE_TAG, '28de89fb');
  // …and the tags that legitimately run the default are still the default.
  assert.equal(envOf(r).LOOM_UNITY_TAG, 'v0.1');
});

test('CONTROL: an EXPLICIT request outranks the estate — adoption never undoes intent', () => {
  const r = decideAdoptions({
    declared,
    env: { [requestVarFor('LOOM_CONSOLE_TAG')]: 'abc1234' },
    resolution: running([['loom-console', `${ACR}/loom-console:28de89fb`]]),
  });
  assert.equal(row(r, 'LOOM_CONSOLE_TAG').source, 'requested');
  assert.equal(envOf(r).LOOM_CONSOLE_TAG, 'abc1234');
});

test('an EMPTY request variable is not a request — `${{ vars.X }}` with X unset is the empty string', () => {
  const r = decideAdoptions({
    declared,
    env: { [requestVarFor('LOOM_CONSOLE_TAG')]: '  ' },
    resolution: running([['loom-console', `${ACR}/loom-console:28de89fb`]]),
  });
  assert.equal(row(r, 'LOOM_CONSOLE_TAG').source, 'adopted');
  assert.equal(envOf(r).LOOM_CONSOLE_TAG, '28de89fb');
});

// ---------------------------------------------------------------------------
// UNKNOWN IS NOT ADOPTABLE
// ---------------------------------------------------------------------------

test('CONTROL: a DIGEST-pinned app is UNRESOLVED — no tag is invented for it', () => {
  const r = decideAdoptions({
    declared,
    env: {},
    resolution: running([['loom-unity', `${ACR}/loom-unity@sha256:0123456789abcdef`]]),
  });
  assert.equal(row(r, 'LOOM_UNITY_TAG').source, 'unresolved');
  assert.match(row(r, 'LOOM_UNITY_TAG').why, /digest/);
  // The param default is still exported so the consuming steps have a value —
  // and NOTHING claims that writing it preserves what is running.
  assert.equal(envOf(r).LOOM_UNITY_TAG, 'v0.1');
  assert.equal(r.unresolved.length, 1);
});

test('CONTROL: a FAILED container-app query is UNRESOLVED for every tag, never an empty estate', () => {
  const r = decideAdoptions({ declared, env: {}, resolution: resolveRunningImageTags(null) });
  assert.equal(r.adopted, 0);
  assert.equal(r.unresolved.length, declared.size);
  assert.ok(r.rows.every((x) => x.source === 'unresolved'));
  assert.ok(r.rows.every((x) => /NOT established/.test(x.why)));
});

test('two containers on one repository at two tags is UNRESOLVED, not a silent pick', () => {
  const r = decideAdoptions({
    declared,
    env: {},
    resolution: running([
      ['loom-unity', `${ACR}/loom-unity:v0.1`],
      ['iceberg-catalog', `${ACR}/loom-unity:abc9999`],
    ]),
  });
  assert.equal(row(r, 'LOOM_UNITY_TAG').source, 'unresolved');
});

// ---------------------------------------------------------------------------
// THE HONEST DEFAULTS
// ---------------------------------------------------------------------------

test('an app that is not deployed takes the param default — there is no image to preserve', () => {
  const r = decideAdoptions({ declared, env: {}, resolution: running([]) });
  assert.ok(r.rows.every((x) => x.source === 'default'));
  assert.equal(envOf(r).LOOM_TRINO_TAG, 'v0.1');
  assert.equal(r.unresolved.length, 0);
});

test('greenfield: no admin RG at all resolves to the param defaults with no warning noise', () => {
  const r = decideAdoptions({ declared, env: {}, resolution: null, greenfield: true });
  assert.ok(r.rows.every((x) => x.source === 'default'));
  assert.ok(r.rows.every((x) => x.running === '(no estate)'));
  assert.equal(r.unresolved.length, 0);
});

test('CONTROL: EVERY declared tag gets an env line — the Gov consumers run under `set -u`', () => {
  // reconcile-resolve.mjs emits a line only for a RUNNING app. On the Gov lanes
  // `assert-acr-image-tags.sh … "loom-unity:${LOOM_UNITY_TAG}"` runs with
  // `set -u`, so an unexported variable aborts the step rather than falling
  // through to the param default.
  const r = decideAdoptions({
    declared,
    env: {},
    resolution: running([['loom-console', `${ACR}/loom-console:28de89fb`]]), // unity+trino absent
  });
  assert.equal(r.envLines.length, declared.size);
  for (const envVar of declared.keys()) assert.ok(envVar in envOf(r), `${envVar} was not exported`);
});

test('a tag var absent from APP_IMAGE_TAGS is reported unmapped, and still exported', () => {
  const r = decideAdoptions({
    declared: new Map([['LOOM_NOT_A_REAL_TAG', 'v9']]),
    env: {},
    resolution: running([]),
  });
  assert.equal(row(r, 'LOOM_NOT_A_REAL_TAG').source, 'unmapped');
  assert.equal(envOf(r).LOOM_NOT_A_REAL_TAG, 'v9');
});

// ---------------------------------------------------------------------------
// THE REAL PARAM FILES — the defaults must come from the file, not a literal
// ---------------------------------------------------------------------------

test('the REAL Gov param files drive the adopter, and every declared tag maps to an image', () => {
  for (const f of ['gcc-high', 'il5']) {
    const d = declaredTagDefaults(readFileSync(`platform/fiab/bicep/params/${f}.bicepparam`, 'utf8'));
    assert.ok(d.size >= 16, `${f}.bicepparam declared only ${d.size} tag defaults`);
    const r = decideAdoptions({ declared: d, env: {}, resolution: running([]) });
    assert.equal(r.rows.filter((x) => x.source === 'unmapped').length, 0,
      `${f}.bicepparam declares a LOOM_*_TAG that APP_IMAGE_TAGS does not know`);
    assert.equal(r.envLines.length, d.size);
  }
});

test("IL5's non-v0.1 defaults survive: the adopter reads the FILE, so no workflow literal can override it", () => {
  // #3303 wrote `|| 'v0.1'` on all sixteen IL5 lines while six of that
  // boundary's declared defaults are not v0.1 — an invisible override fixing an
  // invisible override. Reading the param file removes that class entirely.
  const d = declaredTagDefaults(readFileSync('platform/fiab/bicep/params/il5.bicepparam', 'utf8'));
  const r = decideAdoptions({ declared: d, env: {}, resolution: running([]) });
  assert.equal(envOf(r).LOOM_CONSOLE_TAG, d.get('LOOM_CONSOLE_TAG'));
  assert.equal(envOf(r).LOOM_CONSOLE_TAG, 'v3.0');
});

test('requestVarFor is mechanical and collides with no tag name bicep reads', () => {
  for (const e of APP_IMAGE_TAGS) {
    assert.equal(requestVarFor(e.envVar), `REQUESTED_${e.envVar}`);
    assert.ok(!ENTRY_BY_ENV_VAR[requestVarFor(e.envVar)],
      'the request variable must never itself be a name a .bicepparam reads');
  }
});

// ---------------------------------------------------------------------------
// THE PAIRING: adoption satisfies the guard, and does NOT blind it
// ---------------------------------------------------------------------------

test('CONTROL: run 31793715708 — adoption turns the two TAG refusals into no-ops', () => {
  // The measured GCC-High estate from the failing scheduled run: loom-console
  // on 28de89fb, loom-wrangler-host on 7ba2ec0f, everything else on v0.1.
  const d = new Map([
    ['LOOM_CONSOLE_TAG', 'v0.1'], ['LOOM_WRANGLER_TAG', 'v0.1'], ['LOOM_DUCKDB_TAG', 'v0.1'],
  ]);
  const estate = running([
    ['loom-console', `${ACR}/loom-console:28de89fb`],
    ['loom-wrangler-host', `${ACR}/loom-wrangler-host:7ba2ec0f`],
    ['loom-duckdb', `${ACR}/loom-duckdb:v0.1`],
  ]);
  // BEFORE: the job-level env literal resolves to the param default.
  const before = decideTagWrites({
    declared: d, env: { LOOM_CONSOLE_TAG: 'v0.1', LOOM_WRANGLER_TAG: 'v0.1', LOOM_DUCKDB_TAG: 'v0.1' },
    resolution: estate,
  });
  assert.equal(before.decision, 'refuse');
  assert.equal(before.refusals.length, 2);

  // AFTER: the adopter's env is what the deploy actually runs with.
  const adopted = decideAdoptions({ declared: d, env: {}, resolution: estate });
  const after = decideTagWrites({ declared: d, env: envOf(adopted), resolution: estate });
  assert.equal(after.decision, 'proceed');
  assert.ok(after.rows.every((x) => x.verdict === 'no-op'), JSON.stringify(after.rows));
});

test('CONTROL: adoption does NOT blind the guard — a STALE adopted value is still refused', () => {
  // The two scripts probe the estate independently. If the adopter's read is
  // stale (the estate moved between the two reads, or the adopter was fed a
  // different estate), the guard is comparing the FINAL env against ITS OWN
  // fresh read and the disagreement surfaces. A guard that trusted the
  // adopter's verdict instead of re-measuring would report this green.
  const d = new Map([['LOOM_CONSOLE_TAG', 'v0.1']]);
  const stale = decideAdoptions({
    declared: d, env: {}, resolution: running([['loom-console', `${ACR}/loom-console:v0.1`]]),
  });
  assert.equal(envOf(stale).LOOM_CONSOLE_TAG, 'v0.1');
  const nowRunning = running([['loom-console', `${ACR}/loom-console:28de89fb`]]);
  const verdict = decideTagWrites({ declared: d, env: envOf(stale), resolution: nowRunning });
  assert.equal(verdict.decision, 'refuse');
});

test('CONTROL: adoption cannot rescue a deploy whose estate is unreadable', () => {
  // The adopter exports the param defaults on a failed probe. If that were
  // enough to satisfy the guard, an unreadable control plane would become a
  // silent green — the exact UNKNOWN-as-NEGATIVE collapse.
  const d = new Map([['LOOM_CONSOLE_TAG', 'v0.1']]);
  const blind = decideAdoptions({ declared: d, env: {}, resolution: resolveRunningImageTags(null) });
  const verdict = decideTagWrites({
    declared: d, env: envOf(blind), resolution: running([['loom-console', `${ACR}/loom-console:28de89fb`]]),
  });
  assert.equal(verdict.decision, 'refuse');
});
