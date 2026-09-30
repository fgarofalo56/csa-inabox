/**
 * The E6 ACCEPTANCE SET for check-empty-claim-read-evidence.mjs (#4771).
 *
 * Twenty-eight shapes from the independent re-review of #4771 at 1b4b83318
 * (review 5898687296), RECONSTRUCTED here from the review's descriptions — the
 * reviewer's own fixture files were not available — plus extras marked
 * `extra: true`: six round-6 shapes, and nineteen round-7 shapes rebuilt from
 * re-reviews 5903094729 and 5903102490 (see ROUND7 below). Imported by
 * empty-claim-read-evidence.test.mjs; the leading
 * underscore keeps it out of check-node-test-suites discovery (`*.test.*`).
 *
 * Every non-base fixture is ONE checked edit away from a SAFE base (`variant`
 * throws when the edit does not apply), so a fixture can never silently BE the
 * base and pass for the wrong reason. `expect` is the verdict the guard must
 * give; `rule` names the guard condition that stops it (the mutation arm).
 *
 * Round 8 replaced E6's refuse-list with an ALLOW-LIST (Shape L, Shape W; see
 * the guard). Since then a fixture's `rule` names the part of the allow-list
 * it misses; where several fixtures miss the same part, only the ones named by
 * a broadening arm in the PR body are WITNESSES of it — the rest are held
 * regression guards and are counted as such, not as coverage.
 */

export const variant = (base, from, to) => {
  if (!base.includes(from)) throw new Error(`fixture edit did not apply: ${JSON.stringify(from)}`);
  const out = base.replace(from, to);
  if (out === base) throw new Error(`fixture edit was a no-op: ${JSON.stringify(from)}`);
  return out;
};

/**
 * The cockpit's fetch helper and fold, VERBATIM from finops-cockpit-pane.tsx
 * (:77-81 and :100-112). The suite asserts both still appear in that file, so
 * a drift in the real pane turns a test RED instead of leaving these bases
 * describing a shape nobody ships.
 */
export const COCKPIT_GETJSON = `async function getJson(url: string, timeout = 90_000): Promise<any> {
  const res = await clientFetch(url, { cache: 'no-store' }, timeout);
  const json = await res.json().catch(() => ({}));
  return { ...json, status: res.status };
}
`;
export const COCKPIT_READSTATE = `function readState(q: { isError: boolean; error: unknown; data: any; refetch: () => unknown }) {
  const status = typeof q.data?.status === 'number' ? q.data.status : null;
  const httpFailed = status !== null && status >= 400;
  return {
    isError: q.isError || httpFailed,
    error: q.isError
      ? q.error
      : httpFailed
        ? new Error(q.data?.error || \`Cost Management returned HTTP \${status}.\`)
        : null,
    refetch: q.refetch,
  };
}
`;
/** The one clientFetch import all four real E6 files carry. */
const CF_IMPORT = "import { clientFetch } from '@/lib/client-fetch';\n";

/** finops-cockpit-pane.tsx's shape (E6 Shape W): a RESOLVING fetcher + a same-file fold. */
export const WRAPPED = `'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
${CF_IMPORT}
${COCKPIT_GETJSON}
${COCKPIT_READSTATE}
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

/**
 * The loud shape (E6 Shape L): the queryFn itself throws on a not-ok body —
 * prompt-registry / search-quality / token-budget, with a literal message.
 */
export const LOUD = `'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
${CF_IMPORT}
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

/**
 * The loud shape with an HTTP not-ok test instead of a body test — the base the
 * round-7 re-reviews (5903094729 A, 5903102490 B) narrowed.
 */
export const LOUD_HTTP = variant(LOUD, LOUD_BODY,
  "      const r = await clientFetch('/api/p');\n      if (!r.ok) throw new Error('HTTP ' + r.status);\n      return r.json();");
const HTTP_TEST = "      if (!r.ok) throw new Error('HTTP ' + r.status);";
const httpTest = (to) => variant(LOUD_HTTP, HTTP_TEST, to);
/** Return `installed` from `loadInstalled()` beside the body and put the claim on it (review A's R-U2). */
const onInstalled = (src) => variant(
  variant(src, '      return j;', '      return { ...j, installed: await loadInstalled() };'),
  '  return <div>{data.prompts.length === 0 ? <EmptyState title="No prompts" /> : <List items={data.prompts} />}</div>;',
  '  return <div>{data.installed.length === 0 ? <EmptyState title="No extensions installed" /> : <List items={data.installed} />}</div>;');

/**
 * Round 7. `review` names the finding each fixture reproduces (A = 5903094729,
 * B = 5903102490); the fixtures are rebuilt from the reviews' descriptions.
 * Each review-sourced negative was SAFE on the round-6 guard (4f78087) — the
 * harness in temp/ measures that — and is held by the rule named in `rule`.
 * The two `round-7 witness` negatives (1a-dead, 1b-dead) were already
 * unguarded on round 6; they exist so the never-returns rule has a fixture no
 * round-7 rule also holds.
 */
const ROUND7 = [
  // ---- honest shapes the round-7 rules did not refuse. Round 8 (allow-list)
  // flips all three to unguarded: an HTTP `!r.ok` test, a `.catch` on the
  // fetch, and a computed URL are not what any of the six real E6 claims use.
  // They are false NEGATIVES by design (the scan does not move: no real file
  // has these shapes), disclosed in the guard header. R-S1b stays SAFE. ----
  { id: 'P3', extra: true, review: 'base', klass: 'allow-list refusal', expect: 'unguarded', rule: 'not an allow-listed shape (HTTP !r.ok test, not Shape L)', src: LOUD_HTTP },
  { id: 'P4', extra: true, review: 'base', klass: 'allow-list refusal', expect: 'unguarded', rule: 'not an allow-listed shape (.catch on the fetch)',
    src: variant(LOUD_HTTP, "      const r = await clientFetch('/api/p');",
      "      const r = await clientFetch('/api/p').catch((e) => { throw new Error('network: ' + e); });") },
  { id: 'R-S1b', extra: true, review: 'A-3', klass: 'positive control', expect: 'safe', rule: 'a leading `return` is not part of the emptiness test',
    src: variant(LOUD, '  return <div>{data.prompts.length === 0 ? <EmptyState title="No prompts" /> : <List items={data.prompts} />}</div>;',
      '  return data.prompts.length === 0 ? <EmptyState title="No prompts" /> : <List items={data.prompts} />;') },
  { id: 'P5', extra: true, review: 'base', klass: 'allow-list refusal', expect: 'unguarded', rule: 'not an allow-listed shape (URL is a call expression)',
    src: variant(LOUD_HTTP, "      const r = await clientFetch('/api/p');",
      "      const r = await clientFetch('/api/p?scope=' + encodeURIComponent('all users'));") },

  // ---- a return beside a top-level throw, with no nested if ----
  // Round 7 built these as sole witnesses of its never-returns rule. Under the
  // allow-list Shape L's exact text holds them, alongside 1a and 1b.
  { id: '1a-dead', extra: true, review: 'round-7 witness', klass: 'shared with E2', expect: 'unguarded', rule: 'Shape L is exact (a try/catch; the throw after its return is dead)',
    src: variant(LOUD, LOUD_BODY,
      "      try {\n  " + LOUD_BODY.replace(/\n/g, '\n  ') + "\n      } catch (e) {\n        return { prompts: [] };\n        throw e;\n      }") },
  { id: '1b-dead', extra: true, review: 'round-7 witness', klass: 'shared with E2', expect: 'unguarded', rule: 'Shape L is exact (a block not-ok branch; the throw is dead)',
    src: variant(LOUD, "      if (!j?.ok) throw new Error(j?.error || 'load failed');",
      "      if (!j?.ok) {\n        return { prompts: [] };\n        throw new Error(j?.error || 'load failed');\n      }") },

  // ---- a NARROWED not-ok test: a 403 resolves, isError stays false ----
  // Built on LOUD_HTTP, which round 8 no longer accepts (P3), so since round 8
  // these are held by their BASE and witness nothing on their own; L-narrow
  // (ROUND8) is the Shape L sibling that does witness the exact not-ok test.
  { id: '1d', extra: true, review: 'B-2', klass: 'E6-specific', expect: 'unguarded', rule: 'not an allow-listed shape (HTTP base as P3; narrowed && status >= 500)',
    src: httpTest("      if (!r.ok && r.status >= 500) throw new Error('HTTP ' + r.status);") },
  { id: '1e', extra: true, review: 'A-1', klass: 'E6-specific', expect: 'unguarded', rule: 'not an allow-listed shape (HTTP base as P3; narrowed && status !== 403)',
    src: httpTest("      if (!r.ok && r.status !== 403) throw new Error('HTTP ' + r.status);") },
  { id: '1e-404', extra: true, review: 'B-2', klass: 'E6-specific', expect: 'unguarded', rule: 'not an allow-listed shape (HTTP base as P3; narrowed && status !== 404)',
    src: httpTest("      if (!r.ok && r.status !== 404) throw new Error('HTTP ' + r.status);") },
  { id: '1f', extra: true, review: 'B-2', klass: 'E6-specific', expect: 'unguarded', rule: 'not an allow-listed shape (HTTP base as P3; narrowed && status === 401)',
    src: httpTest("      if (!r.ok && r.status === 401) throw new Error('HTTP ' + r.status);") },
  { id: '1g', extra: true, review: 'A-1', klass: 'E6-specific', expect: 'unguarded', rule: 'not an allow-listed shape (HTTP base as P3; nested if)',
    src: httpTest("      if (!r.ok) {\n        if (r.status >= 500) throw new Error('HTTP ' + r.status);\n      }") },
  // 1g's inner test is itself a narrowed status test, so the exact-test rule
  // holds it too. Here the inner test reads no response, so ONLY the nested-if
  // rule stands between it and SAFE.
  { id: '1g-open', extra: true, review: 'A-1', klass: 'E6-specific', expect: 'unguarded', rule: 'not an allow-listed shape (HTTP base as P3; nested if on non-response state)',
    src: httpTest("      if (!r.ok) {\n        if (open) throw new Error('HTTP ' + r.status);\n      }") },
  { id: '1h', extra: true, review: 'B-6', klass: 'E6-specific', expect: 'unguarded', rule: 'not an allow-listed shape (HTTP base as P3; throw deferred to a then)',
    src: httpTest("      if (!r.ok) {\n        Promise.resolve().then(() => { throw new Error('HTTP ' + r.status); });\n      }") },
  { id: '1h-timeout', extra: true, review: 'B-6', klass: 'E6-specific', expect: 'unguarded', rule: 'not an allow-listed shape (HTTP base as P3; throw deferred to setTimeout)',
    src: httpTest("      if (!r.ok) {\n        setTimeout(() => { throw new Error('HTTP ' + r.status); });\n      }") },

  // ---- a callee E6 cannot read ----
  { id: '2d', extra: true, review: 'A-2', klass: 'E6-specific', expect: 'unguarded', rule: 'Shape L return is exact (return { ...j, installed } from a component-local swallowing fetcher)',
    src: onInstalled(variant(LOUD, '  const q = useQuery({\n',
      "  const loadInstalled = async () => {\n    try {\n      const r2 = await clientFetch('/api/installed');\n      return (await r2.json()).items;\n    } catch {\n      return [];\n    }\n  };\n  const q = useQuery({\n")) },
  { id: '2e', extra: true, review: 'A-2 (sibling)', klass: 'E6-specific', expect: 'unguarded', rule: 'Shape L return is exact (return { ...j, installed } from an imported fetcher)',
    src: onInstalled(variant(LOUD, "import { useQuery } from '@tanstack/react-query';\n",
      "import { useQuery } from '@tanstack/react-query';\nimport { apiGet } from '@/lib/api';\n\nasync function loadInstalled() {\n  try {\n    return await apiGet('/api/installed');\n  } catch {\n    return [];\n  }\n}\n")) },
  // Round 7: an imported binding that shadows a builtin name. The round-8
  // allow-list has no callee lists at all; Shape L's exact text holds it.
  { id: '2f', extra: true, review: 'round-7 witness', klass: 'E6-specific', expect: 'unguarded', rule: 'Shape L is exact (the queryFn calls other functions)',
    src: variant(
      variant(LOUD, "import { useQuery } from '@tanstack/react-query';\n",
        "import { useQuery } from '@tanstack/react-query';\nimport { Object } from '@/lib/rows-client';\n\n" + LOUD_HELPER('ensureAuth', '/api/me')),
      LOUD_FN_OPEN, "    queryFn: async () => { await ensureAuth(); return Object('/api/p'); },") },

  // ---- a wrapper whose fold is overwritten after it ----
  { id: '3f', extra: true, review: 'B-3', klass: 'E6-specific', expect: 'unguarded', rule: 'Shape W wrapper return is exact (a spread after the fold)',
    src: variant(WRAPPED, '    refetch: q.refetch,\n  };', '    refetch: q.refetch,\n    ...q,\n  };') },
  { id: '3g', extra: true, review: 'B-3 (sibling)', klass: 'E6-specific', expect: 'unguarded', rule: 'Shape W wrapper return is exact (a second, quoted isError key)',
    src: variant(WRAPPED, '    refetch: q.refetch,\n  };', "    refetch: q.refetch,\n    'isError': q.isError,\n  };") },

  // ---- a `function` expression shadowing the query ----
  { id: '6c', extra: true, review: 'B-6', klass: 'held negative', expect: 'unguarded', rule: 'function-expression param shadowing the query',
    src: variant(WRAPPED, RENDER,
      '      {rowsQ.isPending ? <Spinner /> : qs.map(function (rowsQ) {\n        return (readState(rowsQ).isError ? null :\n        (rowsQ.data?.rows || []).length ? <Chart rows={rowsQ.data.rows} /> : <EmptyState title="No rows" />);\n      })}') },
];

/** The round-7 ids, for a LITERAL membership test. */
export const ROUND7_IDS = ROUND7.map((f) => f.id);

/**
 * Round 8 (re-reviews 5904912205 A, 5904901510 B at cd560987e). Each shape was
 * SAFE on the round-7 refuse-list; the allow-list refuses all of them by
 * construction. The `witness` fixtures below them exist so that each part of
 * the allow-list has a fixture that goes SAFE when ONLY that part is broadened
 * (the broadening arms in the PR body name them).
 */
const LOUD_THROW = "      if (!j?.ok) throw new Error(j?.error || 'load failed');";
/** LOUD with `extra` top-level code after the imports and `fnLine` as the queryFn. */
const loudWith = (extra, fnLine) => variant(variant(LOUD, CF_IMPORT, CF_IMPORT + '\n' + extra), LOUD_FN_OPEN, fnLine);
/** LOUD with `stmt` declared in the component, before the query. */
const inPanel = (stmt) => variant(LOUD, '  const q = useQuery({\n', stmt + '  const q = useQuery({\n');
const HOOKS = LOUD_HELPER('loadHooks', '/api/hooks');
const OR_EMPTY = 'async function orEmpty(p) { try { return await p; } catch { return { prompts: [] }; } }\n';

const ROUND8 = [
  // ---- review A: a failure swallowed one level away from the fetch ----
  { id: 'R-U4', extra: true, review: 'A-1', klass: 'allow-list refusal', expect: 'unguarded', rule: 'Shape L is exact (a helper that catches and returns empty)',
    src: loudWith(HOOKS + OR_EMPTY, '    queryFn: () => orEmpty(loadHooks()),') },
  { id: 'R-U4b', extra: true, review: 'A-1', klass: 'allow-list refusal', expect: 'unguarded', rule: 'Shape L is exact (the same helper, awaited in a body)',
    src: loudWith(HOOKS + OR_EMPTY, '    queryFn: async () => { return await orEmpty(loadHooks()); },') },
  { id: 'R-U3', extra: true, review: 'A-2', klass: 'allow-list refusal', expect: 'unguarded', rule: 'Shape L is exact (Promise.allSettled with a fallback)',
    src: loudWith(HOOKS, "    queryFn: async () => { const [r] = await Promise.allSettled([loadHooks()]); return r.status === 'fulfilled' ? r.value : { prompts: [] }; },") },
  { id: 'R-U6', extra: true, review: 'A-2', klass: 'allow-list refusal', expect: 'unguarded', rule: 'Shape L is exact (Promise.any with a resolving fallback)',
    src: loudWith(HOOKS, '    queryFn: async () => Promise.any([loadHooks(), Promise.resolve({ prompts: [] })]),') },
  { id: 'R-U6-race', extra: true, review: 'A-2 (sibling)', klass: 'allow-list refusal', expect: 'unguarded', rule: 'Shape L is exact (Promise.race against a resolving timer)',
    src: loudWith(HOOKS, '    queryFn: async () => Promise.race([loadHooks(), new Promise((ok) => setTimeout(() => ok({ prompts: [] }), 5000))]),') },
  // ---- review B: a throw that never runs, a receiver that is not the read ----
  { id: 'B-iife-arrow', extra: true, review: 'B-3', klass: 'allow-list refusal', expect: 'unguarded', rule: 'Shape L throw is the direct consequent (a never-invoked arrow)',
    src: variant(LOUD, LOUD_THROW, "      if (!j?.ok) (() => { throw new Error(j?.error || 'load failed'); });") },
  { id: 'B-iife-fn', extra: true, review: 'B-3', klass: 'allow-list refusal', expect: 'unguarded', rule: 'Shape L throw is the direct consequent (a never-invoked function)',
    src: variant(LOUD, LOUD_THROW, "      if (!j?.ok) (function () { throw new Error(j?.error || 'load failed'); });") },
  { id: 'B-decoy', extra: true, review: 'B-4', klass: 'allow-list refusal', expect: 'unguarded', rule: 'Shape L is exact (a decoy { ok: true } is tested, the response is not)',
    src: variant(LOUD, LOUD_BODY, "      const r = await clientFetch('/api/p');\n      const d = { ok: true };\n      if (!d.ok) throw new Error('x');\n      return r.json();") },
  // ---- witnesses: each goes SAFE when exactly one part is broadened ----
  { id: 'B-decoy-recv', extra: true, review: 'round-8 witness', klass: 'allow-list refusal', expect: 'unguarded', rule: 'Shape L tests the parsed body J itself (a decoy receiver)',
    src: variant(inPanel("  const d = { ok: true, error: '' };\n"), LOUD_THROW, "      if (!d?.ok) throw new Error(d?.error || 'load failed');") },
  { id: 'L-narrow', extra: true, review: 'round-8 witness', klass: 'allow-list refusal', expect: 'unguarded', rule: 'Shape L not-ok test is exactly !J?.ok (narrowed && status >= 500)',
    src: variant(LOUD, LOUD_THROW, "      if (!j?.ok && r.status >= 500) throw new Error(j?.error || 'load failed');") },
  { id: 'M-slot', extra: true, review: 'round-8 witness', klass: 'allow-list refusal', expect: 'unguarded', rule: 'the MSG slot is a literal (a 5xx that returns empty after the throw)',
    src: variant(LOUD, '      return j;\n', '      if (r.status >= 500) return ({ prompts: [] });\n      return j;\n') },
  { id: 'L-fetch-catch', extra: true, review: 'round-8 witness', klass: 'allow-list refusal', expect: 'unguarded', rule: 'Shape L fetch takes one URL (a .catch that resolves ok)',
    src: variant(LOUD, "      const r = await clientFetch('/api/p');",
      "      const r = await clientFetch('/api/p').catch(() => ({ json: async () => ({ ok: true, prompts: [] }) }));") },
  { id: 'S-cf', extra: true, review: 'round-8 witness', klass: 'allow-list refusal', expect: 'unguarded', rule: 'clientFetch is only ever called (a local rebinding)',
    src: inPanel('  const clientFetch = async (u: string) => ({ json: async () => ({ ok: true, prompts: [] }) });\n') },
  { id: 'S-cf-import', extra: true, review: 'round-8 witness', klass: 'allow-list refusal', expect: 'unguarded', rule: 'clientFetch comes from @/lib/client-fetch (another module)',
    src: variant(LOUD, CF_IMPORT, "import { clientFetch } from '@/lib/evil-fetch';\n") },
  { id: 'S-cf-commented', extra: true, review: 'round-8 witness', klass: 'allow-list refusal', expect: 'unguarded', rule: 'the clientFetch import is code (the real one is commented out)',
    // The replacement binding is a PROPERTY write, which e6OnlyCalled skips, so
    // the in-code check on the import is this fixture's only hold (a second
    // `import { clientFetch }` would also be refused as a non-call mention).
    src: variant(LOUD, CF_IMPORT, '/*\n' + CF_IMPORT + "*/\nglobalThis.clientFetch = async () => ({ json: async () => ({ ok: true, prompts: [] }) });\n") },
  { id: 'S-getJson', extra: true, review: 'round-8 witness', klass: 'allow-list refusal', expect: 'unguarded', rule: 'the Shape W helper is only ever called (a local getJson)',
    src: variant(WRAPPED, "  const [dimension, setDimension] = useState('service');\n",
      "  const [dimension, setDimension] = useState('service');\n  const getJson = async (u: string) => ({ rows: [] });\n") },
  { id: 'W-catch', extra: true, review: 'round-8 witness', klass: 'allow-list refusal', expect: 'unguarded', rule: 'Shape W helper is exact (a .catch on the fetch resolves 200)',
    src: variant(WRAPPED, "  const res = await clientFetch(url, { cache: 'no-store' }, timeout);",
      "  const res = await clientFetch(url, { cache: 'no-store' }, timeout).catch(() => ({ status: 200, json: async () => ({ rows: [] }) }));") },
  { id: 'W-qf-catch', extra: true, review: 'round-8 witness', klass: 'allow-list refusal', expect: 'unguarded', rule: 'Shape W queryFn is exactly () => H(URL) (a .catch that resolves empty)',
    src: variant(WRAPPED, ROWS_OPTS, "useQuery({ queryKey: ['r', dimension], queryFn: () => getJson('/api/r').catch(() => ({ rows: [] })) })") },
];

/** The round-8 ids, for a LITERAL membership test. */
export const ROUND8_IDS = ROUND8.map((f) => f.id);

/** Where each fixture sits in the review: E6-specific, shared with E2, or a held negative/control. */
export const FIXTURES = [
  // ---- positive controls (SAFE on the new guard) ----
  { id: 'P1', klass: 'positive control', expect: 'safe', src: WRAPPED, rule: 'E6 wrapped fold' },
  { id: 'P2', klass: 'positive control', expect: 'safe', src: LOUD, rule: 'E6 loud queryFn' },

  // ---- 1: a queryFn that is loud only SOMETIMES ----
  { id: '1a', klass: 'shared with E2', expect: 'unguarded', rule: 'Shape L is exact (a try/catch around the read)',
    src: variant(LOUD, LOUD_BODY,
      "      try {\n  " + LOUD_BODY.replace(/\n/g, '\n  ') + "\n      } catch (e) {\n        if (e instanceof TypeError) return { prompts: [] };\n        throw e;\n      }") },
  { id: '1b', klass: 'shared with E2', expect: 'unguarded', rule: 'Shape L is exact (a return inside the not-ok branch)',
    src: variant(LOUD, "      if (!j?.ok) throw new Error(j?.error || 'load failed');",
      "      if (!j?.ok) {\n        if (r.status === 503 || r.status === 504) return { prompts: [] };\n        throw new Error(j?.error || 'load failed');\n      }") },
  { id: '1c', klass: 'shared with E2', expect: 'unguarded', rule: 'Shape L is exact (a second fetch)',
    src: variant(LOUD, LOUD_BODY,
      "      const c = await clientFetch('/api/cfg');\n      if (!c.ok) throw new Error('config ' + c.status);\n      const r = await clientFetch('/api/p');\n      const j = r.ok ? await r.json() : { ok: true, prompts: [] };\n      if (!j?.ok) throw new Error(j?.error || 'load failed');\n      return j;") },
  { id: '1c-single', extra: true, klass: 'shared with E2', expect: 'unguarded', rule: 'Shape L is exact (J is `await R.json()` itself)',
    src: variant(LOUD, "      const j = await r.json();", "      const j = r.ok ? await r.json() : { ok: true, prompts: [] };") },

  // ---- 2: a queryFn that calls more than one fetching helper ----
  { id: '2b', klass: 'E6-specific', expect: 'unguarded', rule: 'Shape L is exact (the queryFn calls other functions)',
    src: variant(
      variant(LOUD, "import { useQuery } from '@tanstack/react-query';\n",
        "import { useQuery } from '@tanstack/react-query';\nimport { fetchRows } from '@/lib/rows-client';\n\n" + LOUD_HELPER('ensureAuth', '/api/me')),
      LOUD_FN_OPEN, '    queryFn: async () => { await ensureAuth(); return fetchRows(); },') },
  { id: '2c', klass: 'E6-specific', expect: 'unguarded', rule: 'Shape L is exact (the queryFn calls other functions)',
    src: variant(
      variant(LOUD, "import { useQuery } from '@tanstack/react-query';\n",
        "import { useQuery } from '@tanstack/react-query';\n\n" + LOUD_HELPER('getConfig', '/api/cfg')
        + "\nasync function getJson(url: string): Promise<any> {\n  const res = await clientFetch(url, { cache: 'no-store' });\n  const json = await res.json().catch(() => ({}));\n  return { ...json, status: res.status };\n}\n"),
      LOUD_FN_OPEN, "    queryFn: async () => { await getConfig(); return getJson('/api/p'); },") },

  // ---- 3: a wrapper whose fold is not complete ----
  { id: '3a', klass: 'E6-specific', expect: 'unguarded', rule: 'Shape W wrapper is exact (httpFailed narrowed with < 500)',
    src: variant(WRAPPED, 'status !== null && status >= 400;', 'status !== null && status >= 400 && status < 500;') },
  { id: '3b', klass: 'E6-specific', expect: 'unguarded', rule: 'Shape W wrapper is exact (an early return before the fold)',
    src: variant(WRAPPED, "function readState(q: { isError: boolean; error: unknown; data: any; refetch: () => unknown }) {\n",
      "function readState(q: { isError: boolean; error: unknown; data: any; refetch: () => unknown }) {\n  if (q.data?.status === 504) return { isError: false, error: null, refetch: q.refetch };\n") },
  { id: '3c', klass: 'E6-specific', expect: 'unguarded', rule: 'Shape W wrapper is exact (status not read from P.data?.status)',
    src: variant(WRAPPED, "const status = typeof q.data?.status === 'number' ? q.data.status : null;",
      'const status = q.data?.meta?.status ?? 200;') },
  // The fold reads `data.status`, so the fetcher must merge the HTTP status
  // LAST — otherwise a body field (or nothing) is what the fold sees.
  { id: '3d-unmerged', extra: true, klass: 'E6-specific', expect: 'unguarded', rule: 'Shape W helper is exact (status not merged)',
    src: variant(WRAPPED, '  return { ...json, status: res.status };', '  return json;') },
  { id: '3e-status-first', extra: true, klass: 'E6-specific', expect: 'unguarded', rule: 'Shape W helper is exact (body spread after status)',
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
  ...ROUND7,
  ...ROUND8,
];

/** The review's own 28 (the extras are ours). */
export const REVIEW_IDS = FIXTURES.filter((f) => !f.extra).map((f) => f.id);
