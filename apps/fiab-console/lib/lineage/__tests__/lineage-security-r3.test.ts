/**
 * LU-8 — ROUND-3 SECURITY SPECS.
 *
 * Round 2 closed the reported call sites and shipped specs that a mutation pass
 * later proved HOLLOW: the "refuses to treat a credential pair as an account
 * name" case still passed with both charset regexes neutered to `/^.*$/`,
 * because `stripUriCredentials` had already removed the colon-bearing userinfo
 * before the regex ran. Every spec in THIS file was written by first breaking
 * the fix, watching the spec go red, and then restoring it — the mutation is
 * named in each block comment so the next reviewer can repeat it.
 */
import { describe, it, expect } from 'vitest';

import {
  stripUriCredentials,
  canonicalStorageUri,
  canonicalDatasetIdentity,
  parseStorageUri,
} from '@/lib/lineage/dataset-naming';
import { resolveOwner, type PathItem } from '@/lib/lineage/dataset-item-resolver';
import { datasetUri, mapRunEventToEdges, parseRunEvent } from '@/lib/azure/openlineage-ingest';

// ---------------------------------------------------------------------------
// S1 CLASS — the query-string-free SAS the "charset validation" never stopped
// ---------------------------------------------------------------------------
describe('S1 class: a SAS smuggled through the abfss container slot', () => {
  // A SAS does not have to arrive after a `?`. `container@account` is legal
  // abfss syntax, so round 2's rule ("drop userinfo only when it contains a
  // colon") preserved this authority verbatim. parseStorageUri then REJECTED it
  // on CONTAINER_RE and canonicalStorageUri fell through to its non-Azure
  // passthrough — which returns the whole string, signature included, as the
  // value that is persisted as a thread-edge endpoint and rendered as a node
  // label. The charset check moved the leak; it did not stop it.
  //
  // MUTATION that turns this red: in `stripUriCredentials`, use
  //   isHttp || userinfo.includes(':')
  // in place of
  //   isHttp || !CONTAINER_RE.test(userinfo.toLowerCase())
  // → observed: 3 failures in this block, `sig=supersecretsignature` survives
  //   into canonicalDatasetIdentity's output.
  const SAS_AUTHORITY =
    'abfss://sv=2024-11-04&ss=b&sig=SUPERSECRETSIGNATURE@stloom.dfs.core.windows.net/silver/sales';

  it('strips a credential-shaped abfss authority instead of preserving it', () => {
    const stripped = stripUriCredentials(SAS_AUTHORITY);
    expect(stripped.toLowerCase()).not.toContain('sig=');
    expect(stripped.toLowerCase()).not.toContain('supersecret');
    expect(stripped).toBe('abfss://stloom.dfs.core.windows.net/silver/sales');
  });

  it('never lets the signature reach the PERSISTED dataset identity', () => {
    const id = canonicalDatasetIdentity(SAS_AUTHORITY);
    expect(id.toLowerCase()).not.toContain('sig=');
    expect(id.toLowerCase()).not.toContain('supersecret');
  });

  it('also covers the canonicalStorageUri passthrough branch (the actual leak path)', () => {
    // parseStorageUri still refuses this authority — that is the branch that
    // used to hand the raw string back.
    expect(parseStorageUri(SAS_AUTHORITY)).toBeNull();
    expect(canonicalStorageUri(SAS_AUTHORITY).toLowerCase()).not.toContain('supersecret');
  });

  it('does NOT over-strip a legitimate container@account authority', () => {
    // The fix must not be a blunt "drop all abfss userinfo" — that would break
    // every real dataset identity in the product.
    expect(stripUriCredentials('abfss://data@stloom.dfs.core.windows.net/silver/sales'))
      .toBe('abfss://data@stloom.dfs.core.windows.net/silver/sales');
    expect(canonicalDatasetIdentity('abfss://bronze-raw@stloom.dfs.core.windows.net/x'))
      .toBe('abfss://bronze-raw@stloom.dfs.core.windows.net/x');
  });
});

describe('S1 class: the SAME defect one field over — a credential in the host slot', () => {
  // Found while writing the block above, by asking what ACCOUNT_RE actually
  // protects. Answer: it *rejected the parse* and handed the raw string to the
  // same passthrough, exactly like CONTAINER_RE did. So
  // `abfss://data@st:secret.dfs.core.windows.net/x` persisted `secret`
  // verbatim as the thread-edge endpoint. An authority is `host[:port]` and a
  // port is numeric; a non-numeric `:tail` is not a host.
  //
  // MUTATION: in `stripUriCredentials`, delete the `stripMalformedPort(host)`
  // call (or make that helper `return host`).
  // → observed: 2 failures — 'secret' survives into the persisted identity.
  it('drops a non-numeric host tail instead of passing it through', () => {
    const raw = 'abfss://data@st:secret.dfs.core.windows.net/x';
    expect(stripUriCredentials(raw)).not.toContain('secret');
    expect(canonicalDatasetIdentity(raw)).not.toContain('secret');
  });

  it('keeps a REAL numeric port (the fix must not mangle valid authorities)', () => {
    expect(stripUriCredentials('sqlserver://syn.sql.azuresynapse.net:1433/dw.sales.orders'))
      .toBe('sqlserver://syn.sql.azuresynapse.net:1433/dw.sales.orders');
    expect(canonicalDatasetIdentity('sqlserver://syn.sql.azuresynapse.net:1433/dw.sales.orders'))
      .toBe('dw.sales.orders');
    expect(stripUriCredentials('s3://bucket/key')).toBe('s3://bucket/key');
  });

  // HONEST NOTE, correcting a round-2 claim rather than restating it:
  // ACCOUNT_RE is NOT a credential defense and never was. Neutering it to
  // `/^.*$/` breaks no spec in this repo, because every credential shape that
  // could reach the account slot is now removed by `stripUriCredentials`
  // BEFORE the regex runs. It survives as a well-formedness check — it keeps a
  // malformed authority out of the canonical `abfss://{container}@{account}`
  // shape — and this comment is the accurate statement of its role.
});

// ---------------------------------------------------------------------------
// S5 residual — the claim/observation fold asymmetry
// ---------------------------------------------------------------------------
describe('S5 residual: an item rooted at a folded segment still owns itself', () => {
  // Ownership CLAIMS are canonicalized `{ fold: false }` (folding a claim
  // widens it — that was the S5 fix and it stays). But observations were only
  // ever matched in their FOLDED form, so an item whose stored root genuinely
  // ends in `part-…` / `_delta_log` could never resolve its own root: the
  // dataset was written as an `external` node or probed as foreign instead.
  //
  // MUTATION: in `resolveOwner`, drop `|| pathOwns(p, literal)`.
  // → observed: 2 failures — resolveOwner returns null for the item's own root.
  const item = (id: string, path: string): PathItem => ({
    id, workspaceId: 'ws-1', itemType: 'lakehouse', displayName: id, paths: [path],
  });

  it('resolves a root ending in a part-file-shaped segment', () => {
    const c = [item('lh-parted', 'abfss://data@stloom.dfs.core.windows.net/sales/part-a')];
    expect(resolveOwner('abfss://data@stloom.dfs.core.windows.net/sales/part-a', c)?.id)
      .toBe('lh-parted');
  });

  it('resolves a root ending in _delta_log', () => {
    const c = [item('lh-log', 'abfss://data@stloom.dfs.core.windows.net/tbl/_delta_log')];
    expect(resolveOwner('abfss://data@stloom.dfs.core.windows.net/tbl/_delta_log', c)?.id)
      .toBe('lh-log');
  });

  it('still does NOT let the unfolded match widen a claim to its siblings', () => {
    // The S5 attack, re-asserted: an item rooted at `warehouses/part-a` must
    // NOT own `warehouses/part-b`.
    const c = [item('lh-narrow', 'abfss://data@stloom.dfs.core.windows.net/warehouses/part-a')];
    expect(resolveOwner('abfss://data@stloom.dfs.core.windows.net/warehouses/part-b', c))
      .toBeNull();
    expect(resolveOwner('abfss://data@stloom.dfs.core.windows.net/warehouses/other', c))
      .toBeNull();
  });

  it('still folds an OBSERVED delta log onto the table folder an item claims', () => {
    const c = [item('lh-sales', 'abfss://data@stloom.dfs.core.windows.net/silver/sales')];
    expect(resolveOwner('abfss://data@stloom.dfs.core.windows.net/silver/sales/_delta_log', c)?.id)
      .toBe('lh-sales');
  });
});

// ---------------------------------------------------------------------------
// ReDoS — these parsers run on a 5 MB attacker-controlled OpenLineage body
// ---------------------------------------------------------------------------
describe('dataset naming is linear on hostile input (CodeQL js/polynomial-redos)', () => {
  // CodeQL flagged 7 HIGH polynomial-ReDoS alerts across this module and
  // `unified-lineage.normalizeIdentity` on the round-3 head, and it was right:
  // the flagged patterns paired a lazy `([^/]+?)` with an optional trailing
  // `(?:\/(.*))?$`, and `/\/+$/` is quadratic on a long run of slashes. Every
  // one of these functions is reachable from `POST /api/lineage/openlineage`
  // with a 5 MB body, so it is a reachable DoS, not a lint nit. The parsers are
  // index-based now; these are the regression guards.
  //
  // The catastrophic shape was measured, not assumed. Probing each removed
  // pattern against 100k-200k hostile inputs, the lazy-quantifier authority
  // regexes came back in ~0ms (V8 optimizes those), but
  //   ('abfss://x/' + '/'.repeat(200_000) + 'a').replace(/\/+$/, '')
  // took **26,152 ms** — slashes followed by a non-slash tail force `/+` to
  // retry from every position. That is the reachable DoS, and it is exactly
  // the shape a dataset name like `abfss://c@a.dfs…/x/////…////part-0` has.
  //
  // MUTATION: `export function trimSlashes(p) { return String(p||'')
  //   .replace(/^\/+/, '').replace(/\/+$/, ''); }`
  // → observed: 1 failure — the 200k-slash case takes ~26s against a 1s budget.
  const BUDGET_MS = 1_000;

  function underBudget(label: string, fn: () => void) {
    const t0 = Date.now();
    fn();
    const ms = Date.now() - t0;
    expect(ms, `${label} took ${ms}ms`).toBeLessThan(BUDGET_MS);
  }

  it('survives a 200k-slash run FOLLOWED BY A TAIL (the 26s case)', () => {
    // The tail is load-bearing: with the slashes at the very end `/+$` matches
    // on the first try. It is the non-matching tail that makes it quadratic.
    const evil = `abfss://data@stloom.dfs.core.windows.net/silver/${'/'.repeat(200_000)}part-0`;
    underBudget('canonicalDatasetIdentity(slashes+tail)', () => canonicalDatasetIdentity(evil));
  });

  it('survives a 200k-char scheme-ish prefix', () => {
    const evil = `${'a.'.repeat(100_000)}://host/x`;
    underBudget('canonicalDatasetIdentity(scheme)', () => canonicalDatasetIdentity(evil));
  });

  it('survives a 200k-char authority with no terminating slash', () => {
    const evil = `abfss://data@${'a'.repeat(200_000)}.dfs.core.windows.net`;
    underBudget('parseStorageUri(authority)', () => parseStorageUri(evil));
  });

  it('survives a 200k-char path with no separators', () => {
    const evil = `https://stloom.dfs.core.windows.net/data/${'a'.repeat(200_000)}`;
    underBudget('canonicalStorageUri(path)', () => canonicalStorageUri(evil));
  });

  // …and still parses correctly after the index-based rewrite. A fast parser
  // that stopped parsing would be a worse bug than the one it replaced.
  it('still parses every spelling onto ONE canonical identity', () => {
    const want = 'abfss://silver@stloom.dfs.core.windows.net/sales';
    expect(canonicalStorageUri('abfss://silver@stloom.dfs.core.windows.net/sales')).toBe(want);
    expect(canonicalStorageUri('wasbs://silver@stloom.blob.core.windows.net/sales')).toBe(want);
    expect(canonicalStorageUri('https://stloom.dfs.core.windows.net/silver/sales')).toBe(want);
    expect(canonicalStorageUri('abfss://silver@stloom.dfs.core.windows.net/sales/_delta_log')).toBe(want);
    expect(canonicalStorageUri('https://stloom.dfs.core.windows.net:443/silver/sales')).toBe(want);
    // sovereign suffix carried through, never assumed
    expect(canonicalStorageUri('abfss://silver@stloom.dfs.core.usgovcloudapi.net/sales'))
      .toBe('abfss://silver@stloom.dfs.core.usgovcloudapi.net/sales');
    // OneLake still opts out of the ADLS shape
    expect(parseStorageUri('abfss://ws-guid@onelake.dfs.fabric.microsoft.com/lh/Files/x')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ROUND 4 — the SAME ReDoS, one function UPSTREAM of everything above
// ---------------------------------------------------------------------------
describe('openlineage-ingest.datasetUri is linear on hostile input', () => {
  // Commit `bc267d6d` said "kill the polynomial ReDoS on the OpenLineage ingest
  // path" and did not. It rewrote `dataset-naming` + `unified-lineage` — the
  // modules CodeQL had flagged — and left the quadratic `/\/+$/` in
  // `openlineage-ingest.datasetUri()`, which runs BEFORE either of them on every
  // dataset in the POST body. CodeQL did not flag it (`datasetUri` joins two
  // fields and returns; the taint step into the trim was not modelled), so
  // "alerts 7 -> 0" was true and irrelevant. A commit message asserting a fix
  // that did not land stops the next person looking, which is why this block
  // names it.
  //
  // Measured against the pre-fix expression, one field, one core:
  //   N =  20_000 slashes ->    219 ms
  //   N =  50_000          ->  1_357 ms
  //   N = 100_000          ->  6_362 ms
  //   N = 200_000          -> 28_743 ms
  // `namespace` has NO length cap in `parseRunEvent` (only `name`, `run.runId`
  // and `job.name` do) and OL_MAX_DATASETS is 50, so one in-budget 5 MB request
  // could buy minutes of event-loop time on the shared console replicas.
  //
  // MUTATION: in `datasetUri`, restore
  //   const ns = String(ds.namespace || '').trim().replace(/\/+$/, '');
  // → observed: 2 failures against a 1,000 ms budget —
  //     'survives a 200k-slash namespace'            26,152 ms
  //     'survives the whole END-TO-END map'         209,032 ms
  //   The second one is the number that matters: 3.5 minutes of event-loop time
  //   bought by ONE request that is inside every declared limit (under the 5 MB
  //   body cap, at the 50-dataset fan-out cap, one rate-limit token). It is
  //   3.5 MINUTES, not 3.5 seconds.
  const BUDGET_MS = 1_000;

  function underBudget(label: string, fn: () => void) {
    const t0 = Date.now();
    fn();
    const ms = Date.now() - t0;
    expect(ms, `${label} took ${ms}ms`).toBeLessThan(BUDGET_MS);
  }

  it('survives a 200k-slash namespace with a non-slash tail', () => {
    const evil = `abfss://data@stloom.dfs.core.windows.net/silver${'/'.repeat(200_000)}a`;
    underBudget('datasetUri(namespace)', () => datasetUri({ namespace: evil, name: 'sales' }));
  });

  it('survives a 200k-char scheme-ish `name` (the scheme probe is slice-bounded)', () => {
    const evil = `${'a.'.repeat(100_000)}://host/x`;
    underBudget('datasetUri(name scheme)', () => datasetUri({ namespace: '', name: evil }));
  });

  it('survives the whole END-TO-END map with the cap-many hostile datasets', () => {
    // The reachable shape: ONE request, inputs+outputs at the fan-out cap, each
    // namespace hostile. This is the spec that makes the DoS concrete rather
    // than a micro-benchmark.
    const evilNs = `abfss://data@stloom.dfs.core.windows.net/silver${'/'.repeat(20_000)}a`;
    const ds = (i: number) => ({ namespace: evilNs, name: `/t${i}` });
    const parsed = parseRunEvent({
      eventType: 'COMPLETE',
      eventTime: '2026-07-29T00:00:00Z',
      run: { runId: 'r1' },
      job: { namespace: 'j', name: 'evil' },
      inputs: Array.from({ length: 25 }, (_, i) => ds(i)),
      outputs: Array.from({ length: 25 }, (_, i) => ds(100 + i)),
    });
    expect(parsed.ok).toBe(true);
    underBudget('mapRunEventToEdges(50 hostile datasets)', () => {
      if (parsed.ok) mapRunEventToEdges(parsed.event);
    });
  });

  // …and the join still behaves. A fast function that stopped joining would be
  // a worse bug than the one it replaced.
  it('still joins namespace + name exactly as before', () => {
    expect(datasetUri({ namespace: 'abfss://data@stloom.dfs.core.windows.net/', name: '/silver/sales' }))
      .toBe('abfss://data@stloom.dfs.core.windows.net/silver/sales');
    expect(datasetUri({ namespace: 'abfss://data@stloom.dfs.core.windows.net', name: 'silver/sales' }))
      .toBe('abfss://data@stloom.dfs.core.windows.net/silver/sales');
    // a whole URI in `name` wins over the namespace (the OL convention)
    expect(datasetUri({ namespace: 'ignored', name: 'S3://Bucket/Key' })).toBe('s3://bucket/key');
    // `sqlserver://` is a scheme too — it must NOT be re-prefixed
    expect(datasetUri({ namespace: 'sqlserver://h:1433', name: 'sqlserver://h:1433/db.s.t' }))
      .toBe('sqlserver://h:1433/db.s.t');
    expect(datasetUri({ namespace: '', name: '/Silver/Sales' })).toBe('/silver/sales');
    // and the canonical identity the route persists is unchanged end-to-end
    expect(canonicalDatasetIdentity(datasetUri({
      namespace: 'wasbs://data@stloom.blob.core.windows.net',
      name: '/silver/sales/_delta_log',
    }))).toBe('abfss://data@stloom.dfs.core.windows.net/silver/sales');
  });
});
