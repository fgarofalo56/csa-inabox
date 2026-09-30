/**
 * The E6 ACCEPTANCE SET for check-empty-claim-read-evidence.mjs (#4771).
 *
 * Twenty-eight shapes from the independent re-review of #4771 at 1b4b83318
 * (review 5898687296), RECONSTRUCTED here from the review's descriptions — the
 * reviewer's own fixture files were not available — plus a few extras marked
 * `extra: true`. Imported by empty-claim-read-evidence.test.mjs; the leading
 * underscore keeps it out of check-node-test-suites discovery (`*.test.*`).
 *
 * Every non-base fixture is ONE checked edit away from a SAFE base (`variant`
 * throws when the edit does not apply), so a fixture can never silently BE the
 * base and pass for the wrong reason. `expect` is the verdict the guard must
 * give; `rule` names the guard condition that stops it (the mutation arm).
 */

export const variant = (base, from, to) => {
  if (!base.includes(from)) throw new Error(`fixture edit did not apply: ${JSON.stringify(from)}`);
  const out = base.replace(from, to);
  if (out === base) throw new Error(`fixture edit was a no-op: ${JSON.stringify(from)}`);
  return out;
};

/** finops-cockpit-pane.tsx's shape: a RESOLVING fetcher + a same-file fold. */
export const WRAPPED = `'use client';
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
      {rowsQ.isPending ? <Spinner /> :
        readState(rowsQ).isError ? null :
        rows.length ? <Chart rows={rows} /> : (
          <EmptyState title="No rows" />
        )}
    </div>
  );
}
`;

/** The loud shape: the queryFn itself throws on a not-ok body. */
export const LOUD = `'use client';
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
  if (q.isPending) return <Spinner />;
  if (q.isError) return <MessageBar intent="error">failed</MessageBar>;
  const data = q.data!;
  return <div>{data.prompts.length === 0 ? <EmptyState title="No prompts" /> : <List items={data.prompts} />}</div>;
}
`;

const LOUD_BODY = "      const r = await clientFetch('/api/p');\n      const j = await r.json();\n      if (!j?.ok) throw new Error(j?.error || 'load failed');\n      return j;";
const LOUD_FN_OPEN = '    queryFn: async () => {\n' + LOUD_BODY + '\n    },';
const ROWS_OPTS = "useQuery({ queryKey: ['r', dimension], queryFn: () => getJson('/api/r') })";
const withOption = (opt) => variant(WRAPPED, ROWS_OPTS, `useQuery({ queryKey: ['r', dimension], ${opt}, queryFn: () => getJson('/api/r') })`);
const RENDER = "      {rowsQ.isPending ? <Spinner /> :\n        readState(rowsQ).isError ? null :\n        rows.length ? <Chart rows={rows} /> : (\n          <EmptyState title=\"No rows\" />\n        )}";
const GATE = 'readState(rowsQ).isError ? null :';

/** A loud same-file helper: rejects on any non-2xx. */
const LOUD_HELPER = (name, url) => `async function ${name}() {
  const r = await clientFetch('${url}');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
`;

/** Where each fixture sits in the review: E6-specific, shared with E2, or a held negative/control. */
export const FIXTURES = [
  // ---- positive controls (SAFE on the new guard) ----
  { id: 'P1', klass: 'positive control', expect: 'safe', src: WRAPPED, rule: 'E6 wrapped fold' },
  { id: 'P2', klass: 'positive control', expect: 'safe', src: LOUD, rule: 'E6 loud queryFn' },

  // ---- 1: a queryFn that is loud only SOMETIMES ----
  { id: '1a', klass: 'shared with E2', expect: 'unguarded', rule: 'catch must throw and never return',
    src: variant(LOUD, LOUD_BODY,
      "      try {\n  " + LOUD_BODY.replace(/\n/g, '\n  ') + "\n      } catch (e) {\n        if (e instanceof TypeError) return { prompts: [] };\n        throw e;\n      }") },
  { id: '1b', klass: 'shared with E2', expect: 'unguarded', rule: 'not-ok branch must throw and never return',
    src: variant(LOUD, "      if (!j?.ok) throw new Error(j?.error || 'load failed');",
      "      if (!j?.ok) {\n        if (r.status === 503 || r.status === 504) return { prompts: [] };\n        throw new Error(j?.error || 'load failed');\n      }") },
  { id: '1c', klass: 'shared with E2', expect: 'unguarded', rule: 'at most one direct fetch',
    src: variant(LOUD, LOUD_BODY,
      "      const c = await clientFetch('/api/cfg');\n      if (!c.ok) throw new Error('config ' + c.status);\n      const r = await clientFetch('/api/p');\n      const j = r.ok ? await r.json() : { ok: true, prompts: [] };\n      if (!j?.ok) throw new Error(j?.error || 'load failed');\n      return j;") },
  { id: '1c-single', extra: true, klass: 'shared with E2', expect: 'unguarded', rule: 'every .ok/.status read sits in a not-ok test',
    src: variant(LOUD, "      const j = await r.json();", "      const j = r.ok ? await r.json() : { ok: true, prompts: [] };") },

  // ---- 2: a queryFn that calls more than one fetching helper ----
  { id: '2b', klass: 'E6-specific', expect: 'unguarded', rule: 'no imported callee',
    src: variant(
      variant(LOUD, "import { useQuery } from '@tanstack/react-query';\n",
        "import { useQuery } from '@tanstack/react-query';\nimport { fetchRows } from '@/lib/rows-client';\n\n" + LOUD_HELPER('ensureAuth', '/api/me')),
      LOUD_FN_OPEN, '    queryFn: async () => { await ensureAuth(); return fetchRows(); },') },
  { id: '2c', klass: 'E6-specific', expect: 'unguarded', rule: 'EVERY fetching helper must be loud',
    src: variant(
      variant(LOUD, "import { useQuery } from '@tanstack/react-query';\n",
        "import { useQuery } from '@tanstack/react-query';\n\n" + LOUD_HELPER('getConfig', '/api/cfg')
        + "\nasync function getJson(url: string): Promise<any> {\n  const res = await clientFetch(url, { cache: 'no-store' });\n  const json = await res.json().catch(() => ({}));\n  return { ...json, status: res.status };\n}\n"),
      LOUD_FN_OPEN, "    queryFn: async () => { await getConfig(); return getJson('/api/p'); },") },

  // ---- 3: a wrapper whose fold is not complete ----
  { id: '3a', klass: 'E6-specific', expect: 'unguarded', rule: 'fold refuses < / <=',
    src: variant(WRAPPED, 'status !== null && status >= 400;', 'status !== null && status >= 400 && status < 500;') },
  { id: '3b', klass: 'E6-specific', expect: 'unguarded', rule: 'wrapper has exactly one return',
    src: variant(WRAPPED, "function readState(q: { isError: boolean; data: any }) {\n",
      "function readState(q: { isError: boolean; data: any }) {\n  if (q.data?.status === 504) return { isError: false };\n") },
  { id: '3c', klass: 'E6-specific', expect: 'unguarded', rule: 'status is P.data?.status itself',
    src: variant(WRAPPED, "const status = typeof q.data?.status === 'number' ? q.data.status : null;",
      'const status = q.data?.meta?.status ?? 200;') },
  // The fold reads `data.status`, so the fetcher must merge the HTTP status
  // LAST — otherwise a body field (or nothing) is what the fold sees.
  { id: '3d-unmerged', extra: true, klass: 'E6-specific', expect: 'unguarded', rule: 'fetcher merges status last (not at all)',
    src: variant(WRAPPED, '  return { ...json, status: res.status };', '  return json;') },
  { id: '3e-status-first', extra: true, klass: 'E6-specific', expect: 'unguarded', rule: 'fetcher merges status last (body spread overrides it)',
    src: variant(WRAPPED, '  return { ...json, status: res.status };', '  return { status: res.status, ...json };') },

  // ---- 4: the claim's data is not purely the gated query's ----
  { id: '4a', klass: 'E6 invariant (E2 has no data link)', expect: 'unguarded', rule: 'derived const refuses a foreign identifier',
    src: variant(
      variant(WRAPPED, "  const otherQ = useQuery({ queryKey: ['o'], queryFn: () => getJson('/api/o') });\n",
        "  const otherQ = useQuery({ queryKey: ['o'], queryFn: () => getJson('/api/o') });\n  const { data: other } = useQuery({ queryKey: ['o2'], queryFn: () => getJson('/api/o2') });\n"),
      'const rows = rowsQ.data?.rows || [];', 'const rows = [...(rowsQ.data?.rows ?? []), ...(other?.rows ?? [])];') },
  { id: '4b', klass: 'held negative', expect: 'unguarded', rule: 'data link reads only the gated query',
    src: variant(WRAPPED, 'rows.length ? <Chart rows={rows} /> : (',
      '[...(rowsQ.data?.rows || []), ...(otherQ.data?.rows || [])].length ? <Chart rows={rows} /> : (') },
  { id: '4c-derived-other', extra: true, klass: 'held negative', expect: 'unguarded', rule: 'a derived const must derive from the GATED query',
    src: variant(WRAPPED, 'const rows = rowsQ.data?.rows || [];', 'const rows = otherQ.data?.rows || [];') },

  // ---- 5: the claim on the ERRORED side ----
  { id: '5a', klass: 'held negative', expect: 'unguarded', rule: 'isError must be required FALSE',
    src: variant(WRAPPED, RENDER,
      '      {rowsQ.isPending ? <Spinner /> :\n        readState(rowsQ).isError ? (rows.length ? null : <EmptyState title="No rows" />) : <Chart rows={rows} />}') },
  { id: '5b', klass: 'held negative', expect: 'unguarded', rule: 'isError must be required FALSE (negated nested ternary)',
    src: variant(WRAPPED, RENDER,
      '      {rowsQ.isPending ? <Spinner /> :\n        !readState(rowsQ).isError ? <Chart rows={rows} /> :\n        rows.length ? null : <EmptyState title="No rows" />}') },
  { id: '5c', klass: 'held negative', expect: 'unguarded', rule: 'isError must be required FALSE (early return with ||)', firstClaimOnly: true,
    src: variant(LOUD, '  if (q.isError) return <MessageBar intent="error">failed</MessageBar>;',
      '  if (q.isError || (q.data?.prompts || []).length === 0) return <EmptyState title="No prompts" />;') },
  { id: '5d', klass: 'shared with E2', expect: 'unguarded', rule: 'a CONDITIONAL return inside if (q.isError) is not a gate',
    src: variant(LOUD, '  if (q.isError) return <MessageBar intent="error">failed</MessageBar>;',
      '  if (q.isError) { if (open) return <MessageBar intent="error">failed</MessageBar>; }') },

  // ---- 6: the claim does not see the query it names ----
  { id: '6a', klass: 'shared with E2', expect: 'unguarded', rule: 'claim inside useMemo / useCallback is out of reach',
    src: variant(WRAPPED, '  return (\n    <div>\n' + RENDER + '\n    </div>\n  );',
      '  const body = useMemo(() => (rowsQ.isPending ? <Spinner /> :\n        readState(rowsQ).isError ? null :\n        rows.length ? <Chart rows={rows} /> : <EmptyState title="No rows" />), [rowsQ.data]);\n  return <div>{body}</div>;') },
  { id: '6b', klass: 'held negative', expect: 'unguarded', rule: 'arrow param shadowing the query (held by the settled rule; see 6b-settled)',
    src: variant(WRAPPED, RENDER,
      '      {qs.map((rowsQ) => rowsQ.isPending ? <Spinner /> :\n        readState(rowsQ).isError ? null :\n        (rowsQ.data?.rows || []).length ? <Chart rows={rowsQ.data.rows} /> : <EmptyState title="No rows" />)}') },
  // 6b is held by the settled rule (its ternary test sits right after `=>` and
  // does not decompose), so it never reaches the shadow check. Here the OUTER
  // query is settled, the arrow body is parenthesised so its ternary DOES
  // decompose, and the INNER, shadowing `rowsQ` carries the gate.
  { id: '6b-settled', extra: true, klass: 'held negative', expect: 'unguarded', rule: 'arrow param shadowing the query (outer query settled)',
    src: variant(WRAPPED, RENDER,
      '      {rowsQ.isPending ? <Spinner /> : qs.map((rowsQ) => (\n        readState(rowsQ).isError ? null :\n        (rowsQ.data?.rows || []).length ? <Chart rows={rowsQ.data.rows} /> : <EmptyState title="No rows" />))}') },

  // ---- 7-9: options that make !isError stop meaning "this data was read" ----
  { id: '7a', klass: 'E6-specific', expect: 'unguarded', rule: 'option whitelist (select)', src: withOption('select: (d: any) => ({ rows: d.rows ?? [] })') },
  { id: '7b', klass: 'E6-specific', expect: 'unguarded', rule: 'option whitelist (select)', src: withOption('select: (d: any) => (d.partial ? { rows: [] } : d)') },
  { id: '8a', klass: 'pending class', expect: 'unguarded', rule: 'option whitelist (enabled)', src: withOption('enabled: false') },
  { id: '9a', klass: 'pending class', expect: 'unguarded', rule: 'option whitelist (placeholderData)', src: withOption('placeholderData: { rows: [] }') },
  { id: '9b', klass: 'E6-specific', expect: 'unguarded', rule: 'option whitelist (initialData)', src: withOption('initialData: { rows: [] }') },

  // ---- 10: no settled gate ----
  { id: '10', klass: 'shared with E2', expect: 'unguarded', rule: 'claim requires the query settled',
    src: variant(WRAPPED, '      {rowsQ.isPending ? <Spinner /> :\n', '      {') },
  { id: '10-isLoading', extra: true, klass: 'pending class', expect: 'unguarded', rule: 'isLoading is not settled (a paused query is not loading and has no data)',
    src: variant(WRAPPED, '{rowsQ.isPending ? <Spinner /> :', '{rowsQ.isLoading ? <Spinner /> :') },

  // ---- 11: a rebindable query ----
  { id: '11', klass: 'E6-specific', expect: 'unguarded', rule: 'const-only query bindings',
    src: variant(WRAPPED, `  const rowsQ = ${ROWS_OPTS};\n`,
      `  let rowsQ = ${ROWS_OPTS};\n  if (dimension === 'preview') rowsQ = { ...rowsQ, isError: false } as any;\n`) },

  // ---- negative controls ----
  { id: 'N1', klass: 'negative control', expect: 'unguarded', rule: 'bare isError over a RESOLVING fetcher',
    src: variant(WRAPPED, GATE, 'rowsQ.isError ? null :') },
  { id: 'N2', klass: 'negative control', expect: 'unguarded', rule: 'no isError gate at all',
    src: variant(WRAPPED, '        ' + GATE + '\n', '') },

  // ---- unjudged: the component has no read of its own ----
  { id: 'U1', klass: 'unjudged', expect: 'unjudged', rule: 'no in-component read',
    src: variant(WRAPPED, /export function Pane\(\)[\s\S]*$/.exec(WRAPPED)[0],
      'export function RowsView({ rowsQ }: { rowsQ: any }) {\n  return <div>{readState(rowsQ).isError ? null : (rowsQ.data?.rows || []).length ? <Chart /> : <EmptyState title="No rows" />}</div>;\n}\n') },
];

/** The review's own 28 (the extras are ours). */
export const REVIEW_IDS = FIXTURES.filter((f) => !f.extra).map((f) => f.id);
