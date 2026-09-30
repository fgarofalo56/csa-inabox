/**
 * Unit coverage for check-empty-claim-read-evidence.mjs (#3281).
 *
 * The guard already runs six embedded fixtures on EVERY invocation, so this
 * suite deliberately does NOT re-test those. It covers the shapes the fixtures
 * do not reach, and it pins the two properties the rule's credibility rests on:
 *
 *   1. Population membership does not depend on the fix. A component that
 *      adopted the safe pattern is still judged, and a NEW defect beside the
 *      fixed claim is still caught. (The controls prove this for one file
 *      shape; here it is proved for the early-return spelling of the fix.)
 *   2. UNKNOWN is never reported as safe.
 *
 * Discovered and run by scripts/ci/check-node-test-suites.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, '..', 'check-empty-claim-read-evidence.mjs');

// Import the analyser without running its CLI.
const source = readFileSync(GUARD, 'utf8').replace(/\nmain\(\);\s*$/, '\n');
const { judgeSource, e6Norm, E6_SHAPE_L, E6_SHAPE_W_QUERYFN, E6_SHAPE_W_HELPER, E6_SHAPE_W_WRAPPER } = await import(
  `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`
);

const verdicts = (src) => judgeSource(src, '<test>').claims.map((c) => c.verdict);
const reasons = (src) => judgeSource(src, '<test>').claims.map((c) => c.why);

test('early return on the error state gates the claim (E2 through a dominating return)', () => {
  const src = `'use client';
export function Panel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    clientFetch('/api/rows').then((r) => r.json()).then((j) => setRows(j.rows || []))
      .catch((e) => setErr(e?.message || String(e)));
  }, []);
  if (err) return <MessageBar intent="error">{err}</MessageBar>;
  return <div>{rows.length === 0 && <EmptyState title="No rows" />}</div>;
}
`;
  assert.deepEqual(verdicts(src), ['safe']);
  assert.match(String(reasons(src)[0]), /^E2/);
});

test('a SIBLING component in the same fixed file is still judged on its own merits', () => {
  const src = `'use client';
export function Panel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    clientFetch('/api/rows').then((r) => r.json()).then((j) => setRows(j.rows || []))
      .catch((e) => setErr(e?.message || String(e)));
  }, []);
  if (err) return <MessageBar intent="error">{err}</MessageBar>;
  return <div>{rows.length === 0 && <EmptyState title="No rows" />}</div>;
}

export function AuditPanel() {
  const [audits, setAudits] = useState<Row[]>([]);
  useEffect(() => {
    clientFetch('/api/audits').then((r) => r.json()).then((j) => setAudits(j.rows || []))
      .catch(() => {});
  }, []);
  return <div>{audits.length === 0 && <EmptyState title="No audit events" />}</div>;
}
`;
  // Panel adopted the fix; AuditPanel swallowed its read error. Adoption in one
  // component must never make the file stop being judged — this is the #3281
  // trap, tested across a component boundary rather than within one.
  assert.deepEqual(verdicts(src), ['safe', 'unguarded']);
});

test('a claim in a component with no read of its own is NOT judged', () => {
  const src = `'use client';
export function RowsTable({ rows }: { rows: Row[] }) {
  return <div>{rows.length === 0 && <EmptyState title="No rows" />}</div>;
}
`;
  const r = judgeSource(src, '<test>');
  assert.deepEqual(r.claims, []);
  assert.equal(r.noReadClaims, 1);
});

test('a component that reads but holds no useState is UNKNOWN, never safe', () => {
  const src = `'use client';
export function Panel() {
  const rows = useSomeCustomHook(() => clientFetch('/api/rows'));
  return <div>{rows.length === 0 && <EmptyState title="No rows" />}</div>;
}
`;
  assert.deepEqual(verdicts(src), ['unknown']);
});

test('a file the analyser cannot bracket-balance is UNKNOWN, never silently clean', () => {
  // A deliberately unbalanced source: the analyser must not report "no
  // violations here" on something it failed to parse.
  const src = `'use client';
export function Panel() {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => { clientFetch('/api/rows'); }, []);
  return <div>{rows.length === 0 && <EmptyState title="No rows" />}</div>;
`;
  assert.deepEqual(verdicts(src), ['unknown']);
});

test('an apostrophe in JSX prose does not open a phantom string', () => {
  // foundry-sub-editors.tsx: `a field's <em>Vector profile</em>` ran a phantom
  // string 900 lines to the next apostrophe and destroyed every scope boundary.
  const src = `'use client';
export function Panel() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    clientFetch('/api/rows').then((r) => r.json()).then((j) => setRows(j.rows || []))
      .catch((e) => setErr(String(e)));
  }, []);
  return (
    <div>
      <Caption1>Bind to a field's <em>Vector profile</em> in the Fields tab.</Caption1>
      {rows && rows.length === 0 && <EmptyState title="No rows" />}
    </div>
  );
}
`;
  assert.deepEqual(verdicts(src), ['safe']);
  assert.match(String(reasons(src)[0]), /^E1/);
});

test('a URL in JSX prose is not read as a line comment', () => {
  // airflow-job-editor.tsx: `<code>https://airflow.contoso.com</code>)` blanked
  // the rest of the line, including a closing paren.
  const src = `'use client';
export function Panel() {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => { clientFetch('/api/rows').then((r) => r.json()).then((j) => setRows(j.rows || [])); }, []);
  return (
    <div>
      <Caption1>Point it at <code>https://airflow.contoso.com</code> (any reachable host).</Caption1>
      {rows.length === 0 && <EmptyState title="No rows" />}
    </div>
  );
}
`;
  assert.deepEqual(verdicts(src), ['unguarded']);
});

// ---------------------------------------------------------------------------
// E6 — a react-query outcome as read evidence (#4771).
//
// Every negative below is ONE edit away from a SAFE base, and `variant()`
// throws if the edit did not apply — so no negative can silently be the base
// itself and pass for the wrong reason. Each names the guard condition whose
// removal turns it RED; the mutation run is in the PR body.
// ---------------------------------------------------------------------------

// The bases (WRAPPED, LOUD) and the review's acceptance set live in ONE module,
// so this suite and the round-6 comparison harness judge the same text.
import {
  variant, WRAPPED, LOUD, FIXTURES, REVIEW_IDS, ROUND7_IDS, ROUND8_IDS, COCKPIT_GETJSON, COCKPIT_READSTATE,
} from './_empty-claim-e6-acceptance.mjs';

test('E6 POSITIVE: a folded react-query outcome gates the claim (the finops cockpit shape)', () => {
  // Breaks if E6 stops recognising `W(Q).isError`, the fold, or the derived `rows`.
  assert.deepEqual(verdicts(WRAPPED), ['safe']);
  assert.match(String(reasons(WRAPPED)[0]), /^E6 !readState\(rowsQ\)\.isError$/);
});

/**
 * WRAPPED with the emptiness test reading `rowsQ.data` DIRECTLY instead of via
 * the derived `rows`. The negatives built on it are the ones where the data
 * link HOLDS, so the condition they target is the only thing that can stop
 * them — measured: on WRAPPED, three of them were also stopped by the data
 * link and their own mutation arm stayed green.
 */
const WRAPPED_DIRECT = variant(WRAPPED,
  'rows.length ? <Chart rows={rows} /> : (',
  '(rowsQ.data?.rows || []).length ? <Chart rows={rowsQ.data.rows} /> : (');

test('E6 POSITIVE: the same gate with the emptiness test reading the query data directly', () => {
  assert.deepEqual(verdicts(WRAPPED_DIRECT), ['safe']);
  assert.match(String(reasons(WRAPPED_DIRECT)[0]), /^E6 /);
});

test('E6 NEGATIVE (round 8): bare isError over a helper that throws on not-ok is not an allow-listed shape', () => {
  // Round 7 called this SAFE, and it is honest code. But no real E6 claim reads
  // a bare isError through a same-file helper, so the allow-list refuses it: a
  // DISCLOSED false negative (guard header), not a finding. Breaks if a bare
  // isError is ever accepted over `() => H(URL)`, i.e. if Shape L stops
  // requiring the loud read to be the queryFn itself.
  const loudHelper = variant(
    variant(WRAPPED, '  const json = await res.json().catch(() => ({}));',
      "  if (!res.ok) throw new Error('HTTP ' + res.status);\n  const json = await res.json().catch(() => ({}));"),
    'readState(rowsQ).isError ? null :', 'rowsQ.isError ? null :');
  assert.deepEqual(verdicts(loudHelper), ['unguarded']);
  // Paired positive: the unedited base is SAFE, so the refusal is the edit's.
  assert.deepEqual(verdicts(WRAPPED), ['safe']);
});

test('E6 POSITIVE: a queryFn that throws on a not-ok body makes bare q.isError evidence', () => {
  // Breaks if the loud-queryFn proof or the early-return `if (q.isError)` path is lost.
  assert.deepEqual(verdicts(LOUD), ['safe']);
  assert.match(String(reasons(LOUD)[0]), /^E6 !q\.isError$/);
});

test('E6 NEGATIVE: a claim gated on a DIFFERENT query\'s isError is unguarded', () => {
  // otherQ succeeding says nothing about rowsQ. Both spellings of the claim's
  // data are pinned: through the derived `rows` (RED if a const derived from
  // ANY query is accepted) and reading rowsQ.data directly (RED if ANY query's
  // data is accepted).
  const viaDerived = variant(WRAPPED, 'readState(rowsQ).isError ? null :', 'readState(otherQ).isError ? null :');
  assert.deepEqual(verdicts(viaDerived), ['unguarded']);
  const direct = variant(WRAPPED_DIRECT, 'readState(rowsQ).isError ? null :', 'readState(otherQ).isError ? null :');
  assert.deepEqual(verdicts(direct), ['unguarded']);
});

test('E6 NEGATIVE: a claim with no isError gate at all is unguarded', () => {
  // RED if E6 accepts the data link alone, without a required-false isError.
  const src = variant(WRAPPED, '        readState(rowsQ).isError ? null :\n', '');
  assert.deepEqual(verdicts(src), ['unguarded']);
});

test('E6 NEGATIVE: a claim on the ERRORED side of the gate is unguarded (ternary)', () => {
  // "On error, and no rows, say empty" — the claim renders ONLY when the read
  // failed. The data link HOLDS (`rows.length` is on its path), so only the
  // polarity requirement can stop it: RED if E6 accepts a required-TRUE isError.
  const src = variant(WRAPPED,
    'readState(rowsQ).isError ? null :\n        rows.length ? <Chart rows={rows} /> : (\n          <EmptyState title="No rows" />\n        )',
    'readState(rowsQ).isError ? (rows.length ? null : <EmptyState title="No rows" />) : <Chart rows={rows} />');
  assert.deepEqual(verdicts(src), ['unguarded']);
});

test('E6 NEGATIVE: a claim that IS the early return of `if (q.isError)` is unguarded', () => {
  // The early-return pass misreads this COND as required-false (pre-existing,
  // disclosed in the guard header). The data link HOLDS via the earlier
  // `if (…length) return`, so only E6's refusal of flagged literals stops it:
  // RED if that refusal goes.
  const src = variant(LOUD,
    'if (q.isError) return <MessageBar intent="error">failed</MessageBar>;',
    'if ((q.data?.prompts || []).length) return <List items={q.data.prompts} />;\n  if (q.isError) return <EmptyState title="No prompts" />;');
  const got = judgeSource(src, '<test>').claims.sort((a, b) => a.line - b.line);
  assert.equal(got.length, 2);
  assert.equal(got[0].verdict, 'unguarded', `the errored-side claim must not be safe: ${JSON.stringify(got[0])}`);
});

test('E6 NEGATIVE: readState over something that is NOT a useQuery result is unguarded', () => {
  // Built on WRAPPED_DIRECT so the data link holds — RED if E6 stops requiring
  // `const Q = useQuery(…)` in the same component.
  const src = variant(WRAPPED_DIRECT,
    "const rowsQ = useQuery({ queryKey: ['r', dimension], queryFn: () => getJson('/api/r') });",
    "const rowsQ = useCachedRead(['r', dimension], () => getJson('/api/r'));");
  assert.deepEqual(verdicts(src), ['unguarded']);
});

test('E6 NEGATIVE: bare q.isError over a RESOLVING fetcher is unguarded', () => {
  // getJson resolves on a 504, so rowsQ.isError stays false — the exact C2 arm
  // in #4771. RED if E6 stops proving the queryFn rejects on failure.
  const src = variant(WRAPPED, 'readState(rowsQ).isError ? null :', 'rowsQ.isError ? null :');
  assert.deepEqual(verdicts(src), ['unguarded']);
});

test('E6 NEGATIVE: a wrapper that DROPS the query\'s own isError is unguarded', () => {
  // A rejected fetch would then read as not-errored. RED if E6 stops requiring
  // `isError: <param>.isError || …`.
  const src = variant(WRAPPED, '    isError: q.isError || httpFailed,', '    isError: httpFailed,');
  assert.deepEqual(verdicts(src), ['unguarded']);
});

test('E6 NEGATIVE: a wrapper with no HTTP fold, over a RESOLVING fetcher, is unguarded', () => {
  // `q.isError || false` adds nothing, and getJson resolves on a 504. RED if a
  // wrapper that only passes isError through is accepted without a loud queryFn.
  const src = variant(WRAPPED, '    isError: q.isError || httpFailed,', '    isError: q.isError || false,');
  assert.deepEqual(verdicts(src), ['unguarded']);
});

test('E6 NEGATIVE: a wrapper whose status is NOT read from the query data is unguarded', () => {
  // The fold compares SOME status against 400, but not the response's. RED if
  // E6 stops tracing `status` back to `<param>.data`.
  const src = variant(WRAPPED,
    "const status = typeof q.data?.status === 'number' ? q.data.status : null;",
    'const status = Number(lastKnownStatus);');
  assert.deepEqual(verdicts(src), ['unguarded']);
});

test('E6 NEGATIVE: a loud queryFn whose catch SWALLOWS the failure is unguarded', () => {
  // The throw is caught and turned back into data. RED if the swallow check goes.
  const src = variant(LOUD,
    "      const r = await clientFetch('/api/p');\n      const j = await r.json();\n      if (!j?.ok) throw new Error(j?.error || 'load failed');\n      return j;",
    "      try {\n        const r = await clientFetch('/api/p');\n        const j = await r.json();\n        if (!j?.ok) throw new Error(j?.error || 'load failed');\n        return j;\n      } catch (e) { return { prompts: [] }; }");
  assert.deepEqual(verdicts(src), ['unguarded']);
});

test('E6 NEGATIVE: an emptiness test over a const that mixes in useState is unguarded', () => {
  // `dimension` is state, so `rows` is no longer PURELY rowsQ's data. RED if
  // derived consts stop refusing state in their initialiser.
  const src = variant(WRAPPED, 'const rows = rowsQ.data?.rows || [];', 'const rows = rowsQ.data?.rows || dimension;');
  assert.deepEqual(verdicts(src), ['unguarded']);
});

// ---------------------------------------------------------------------------
// The acceptance set from the #4771 re-review (5898687296). Round 5's E6 called
// 18 of these SAFE; the merge-base guard called none of them SAFE. Each row
// below goes RED if the rule it names is removed (arms in the PR body).
// ---------------------------------------------------------------------------

test('the acceptance set carries every fixture the review named, by id', () => {
  // A LITERAL list, not derived from FIXTURES: deleting a fixture from the
  // module turns this RED instead of silently shrinking the set.
  assert.deepEqual([...REVIEW_IDS].sort(), [
    '10', '11', '1a', '1b', '1c', '2b', '2c', '3a', '3b', '3c', '4a', '4b', '5a', '5b',
    '5c', '5d', '6a', '6b', '7a', '7b', '8a', '9a', '9b', 'N1', 'N2', 'P1', 'P2', 'U1',
  ]);
  // 72 fixtures: 28 review + 6 round-6 extras + 20 round-7 + 18 round-8. 68
  // unguarded = 72 minus 3 positive controls (P1, P2, R-S1b) minus 1 unjudged
  // (U1). Round 8 flipped P3, P4 and P5 to unguarded (allow-list refusals).
  // Adding a fixture without deciding its class turns this RED.
  assert.equal(FIXTURES.length, 72);
  assert.equal(FIXTURES.filter((f) => f.expect === 'unguarded').length, 68);
  assert.deepEqual(
    FIXTURES.filter((f) => f.expect === 'safe').map((f) => f.id).sort(),
    ['P1', 'P2', 'R-S1b'].sort(),
  );
});

test('the acceptance set carries every round-7 re-review shape, by id', () => {
  // LITERAL, as above. A = review 5903094729, B = review 5903102490.
  assert.deepEqual([...ROUND7_IDS].sort(), [
    '1d', '1e', '1e-404', '1f', '1g', '1g-open', '1h', '1h-timeout', '2d', '2e', '2f',
    '3f', '3g', '6c', 'P3', 'P4', 'P5', 'R-S1b', '1a-dead', '1b-dead',
  ].sort());
});

test('the acceptance set carries every round-8 re-review shape and witness, by id', () => {
  // LITERAL, as above. A = review 5904912205, B = review 5904901510.
  assert.deepEqual([...ROUND8_IDS].sort(), [
    'R-U4', 'R-U4b', 'R-U3', 'R-U6', 'R-U6-race', 'B-iife-arrow', 'B-iife-fn', 'B-decoy',
    'B-decoy-recv', 'L-narrow', 'M-slot', 'L-fetch-catch', 'S-cf', 'S-cf-import',
    'S-cf-commented', 'S-getJson', 'W-catch', 'W-qf-catch',
  ].sort());
});

// ---------------------------------------------------------------------------
// The allow-list against the REAL sites it was lifted from (#4771 round 8).
// ---------------------------------------------------------------------------

const ADMIN = join(HERE, '..', '..', '..', 'apps', 'fiab-console', 'lib', 'components', 'admin');
/** The six real E6 claims, by file. A LITERAL list: the allow-list's whole reason to exist. */
const REAL_E6 = {
  'finops-cockpit-pane.tsx': ['E6 !readState(anomaliesQ).isError', 'E6 !readState(breakdownQ).isError', 'E6 !readState(budgetsQ).isError'],
  'prompt-registry-panel.tsx': ['E6 !q.isError'],
  'search-quality-panel.tsx': ['E6 !q.isError'],
  'token-budget-panel.tsx': ['E6 !q.isError'],
};

test('E6 REAL SITES: each of the six real E6 claims is SAFE on its allow-listed shape', () => {
  // Scope: the four files the shapes were lifted from; the full-tree numbers
  // (124/220/6) are the scan's job, this pins WHICH six. Breaks if a shape is
  // removed or narrowed so a real site stops matching (then that site reads
  // unguarded and drops out of `got`), or if the real code drifts off its
  // shape, which means the allow-list is stale, not that the code is wrong.
  for (const [file, want] of Object.entries(REAL_E6)) {
    const src = readFileSync(join(ADMIN, file), 'utf8');
    const got = judgeSource(src, file).claims
      .filter((c) => c.verdict === 'safe' && /^E6 /.test(String(c.why)))
      .map((c) => c.why).sort();
    assert.deepEqual(got, [...want].sort(), `${file}: E6-safe claims`);
  }
});

test('the WRAPPED base carries the cockpit helper and fold verbatim', () => {
  // Breaks on ANY character of drift between finops-cockpit-pane.tsx and the
  // fixture bases, so the Shape W fixtures cannot quietly describe old code.
  const cockpit = readFileSync(join(ADMIN, 'finops-cockpit-pane.tsx'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(cockpit.includes(COCKPIT_GETJSON), 'getJson in the cockpit no longer matches COCKPIT_GETJSON');
  assert.ok(cockpit.includes(COCKPIT_READSTATE), 'readState in the cockpit no longer matches COCKPIT_READSTATE');
  assert.ok(WRAPPED.includes(COCKPIT_GETJSON) && WRAPPED.includes(COCKPIT_READSTATE), 'WRAPPED must embed both');
});

test('e6Norm keeps a space only between two word characters', () => {
  // Breaks if it drops the `const a` space (identifiers would fuse) or keeps
  // the ` = ` spaces (every shape regex would miss real formatting).
  assert.equal(e6Norm('const  a =\n  b ;\n return  j as T ;'), 'const a=b;return j as T;');
});

test('E6 shape regexes: each accepts its real text and refuses a one-token change', () => {
  const n = (s) => e6Norm(s);
  // Shape L: the prompt-registry queryFn with its template message and `as T`.
  const L = "async () => {\n  const r = await clientFetch('/api/admin/copilot-quality/prompts');\n  const j = await r.json();\n"
    + "  if (!j?.ok) throw new Error(j?.error || `load failed (${r.status})`);\n  return j as PromptsResponse;\n}";
  assert.ok(E6_SHAPE_L.test(n(L)), 'Shape L must accept the real queryFn');
  assert.ok(!E6_SHAPE_L.test(n(L.replace('if (!j?.ok)', 'if (!j?.ok && r.status >= 500)'))), 'narrowed not-ok test');
  assert.ok(!E6_SHAPE_L.test(n(L.replace('return j as PromptsResponse;', 'return { ...j, more: [] };'))), 'return is not J');
  assert.ok(!E6_SHAPE_L.test(n(L.replace('`load failed (${r.status})`', 'fmt(r)'))), 'MSG slot refuses a call');
  assert.ok(!E6_SHAPE_L.test(n(L.replace("clientFetch('/api/admin/copilot-quality/prompts')", "clientFetch(u).catch(() => null)"))), 'fetch takes one URL');
  // Shape W queryFn: a literal URL, or a template whose holes are identifiers.
  assert.ok(E6_SHAPE_W_QUERYFN.test(n("() => getJson('/api/admin/finops/budgets')")));
  assert.ok(E6_SHAPE_W_QUERYFN.test(n('() => getJson(`/api/b?d=${dimension}`)')));
  assert.ok(!E6_SHAPE_W_QUERYFN.test(n('() => getJson(`/api/b?d=${encodeURIComponent(d)}`)')), 'hole is a call');
  assert.ok(!E6_SHAPE_W_QUERYFN.test(n("() => getJson('/api/r').catch(() => ({}))")), 'a .catch after the helper');
  // Shape W helper and wrapper: the cockpit's own text, and one token off it.
  assert.ok(E6_SHAPE_W_HELPER.test(n(COCKPIT_GETJSON)), 'helper must accept the real getJson');
  assert.ok(!E6_SHAPE_W_HELPER.test(n(COCKPIT_GETJSON.replace('return { ...json, status: res.status };', 'return { status: res.status, ...json };'))), 'status merged first');
  assert.ok(E6_SHAPE_W_WRAPPER.test(n(COCKPIT_READSTATE)), 'wrapper must accept the real readState');
  assert.ok(!E6_SHAPE_W_WRAPPER.test(n(COCKPIT_READSTATE.replace('status >= 400;', 'status >= 500;'))), 'threshold moved');
});

for (const f of FIXTURES) {
  test(`acceptance ${f.id} (${f.klass}): ${f.expect} — ${f.rule}`, () => {
    const r = judgeSource(f.src, '<test>');
    if (f.expect === 'unjudged') {
      assert.deepEqual(r.claims, []);
      assert.equal(r.noReadClaims, 1);
      return;
    }
    const got = [...r.claims].sort((a, b) => a.line - b.line);
    assert.ok(got.length >= 1, `${f.id}: no claim judged`);
    const judged = f.firstClaimOnly ? [got[0]] : got;
    for (const c of judged) {
      assert.equal(c.verdict, f.expect, `${f.id} must be ${f.expect} (stopped by: ${f.rule}); got ${c.verdict} ${c.why || ''}`);
    }
    if (f.expect === 'safe') assert.match(String(got[0].why), /^E6 /);
  });
}
