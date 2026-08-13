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
