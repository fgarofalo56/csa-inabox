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
const { judgeSource } = await import(
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

const variant = (base, from, to) => {
  assert.ok(base.includes(from), `fixture edit did not apply: ${JSON.stringify(from)}`);
  const out = base.replace(from, to);
  assert.notEqual(out, base);
  return out;
};

/** finops-cockpit-pane.tsx's shape: a RESOLVING fetcher + a same-file fold. */
const WRAPPED = `'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

async function getJson(url: string): Promise<any> {
  const res = await clientFetch(url, { cache: 'no-store' });
  const json = await res.json().catch(() => ({}));
  return { ...json, status: res.status };
}

function readState(q: { isError: boolean; data: any }) {
  const status = typeof q.data?.status === 'number' ? q.data.status : null;
  const httpFailed = status !== null && status >= 400;
  return { isError: q.isError || httpFailed };
}

export function Pane() {
  const [dimension, setDimension] = useState('service');
  const rowsQ = useQuery({ queryKey: ['r', dimension], queryFn: () => getJson('/api/r') });
  const otherQ = useQuery({ queryKey: ['o'], queryFn: () => getJson('/api/o') });
  const rows = rowsQ.data?.rows || [];
  return (
    <div>
      {rowsQ.isLoading ? <Spinner /> :
        readState(rowsQ).isError ? null :
        rows.length ? <Chart rows={rows} /> : (
          <EmptyState title="No rows" />
        )}
    </div>
  );
}
`;

/** The loud shape: the queryFn itself throws on a not-ok body. */
const LOUD = `'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

export function Panel() {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['p'],
    queryFn: async () => {
      const r = await clientFetch('/api/p');
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || 'load failed');
      return j;
    },
  });
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <MessageBar intent="error">failed</MessageBar>;
  const data = q.data!;
  return <div>{data.prompts.length === 0 ? <EmptyState title="No prompts" /> : <List items={data.prompts} />}</div>;
}
`;

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

test('E6 POSITIVE: a queryFn whose same-file helper throws on a not-ok response', () => {
  // The fetcher is loud here, so bare `rowsQ.isError` IS complete. Breaks if E6
  // stops following one same-file helper from the queryFn.
  const loudHelper = variant(
    variant(WRAPPED, '  const json = await res.json().catch(() => ({}));',
      "  if (!res.ok) throw new Error('HTTP ' + res.status);\n  const json = await res.json().catch(() => ({}));"),
    'readState(rowsQ).isError ? null :', 'rowsQ.isError ? null :');
  assert.deepEqual(verdicts(loudHelper), ['safe']);
  assert.match(String(reasons(loudHelper)[0]), /^E6 !rowsQ\.isError$/);
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
  const src = variant(WRAPPED, 'return { isError: q.isError || httpFailed };', 'return { isError: httpFailed };');
  assert.deepEqual(verdicts(src), ['unguarded']);
});

test('E6 NEGATIVE: a wrapper with no HTTP fold, over a RESOLVING fetcher, is unguarded', () => {
  // `q.isError || false` adds nothing, and getJson resolves on a 504. RED if a
  // wrapper that only passes isError through is accepted without a loud queryFn.
  const src = variant(WRAPPED, 'return { isError: q.isError || httpFailed };', 'return { isError: q.isError || false };');
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
