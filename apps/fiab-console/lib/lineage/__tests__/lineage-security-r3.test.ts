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
import { describe, it, expect, beforeEach, vi } from 'vitest';

const edgesWritten: any[] = [];

const mocks = vi.hoisted(() => ({
  getPipeline: vi.fn(),
  getDataset: vi.fn(),
  getLinkedService: vi.fn(async () => null),
  listActivityRuns: vi.fn(async () => []),
  queryItems: vi.fn(async () => ({ resources: [] })),
}));

vi.mock('@/lib/azure/adf-client', () => ({
  getPipeline: mocks.getPipeline,
  getDataset: mocks.getDataset,
  getLinkedService: mocks.getLinkedService,
  listActivityRuns: mocks.listActivityRuns,
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: { query: (s: any) => ({ fetchAll: async () => mocks.queryItems(String(s?.query || '')) }) },
  }),
  auditLogContainer: async () => ({ items: { create: async (d: any) => ({ resource: d }) } }),
  workspacesContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [{ tenantId: 'owner-1' }] }) }) },
  }),
}));

vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: vi.fn() }));

vi.mock('@/lib/thread/thread-edges', () => ({
  recordThreadEdge: vi.fn(async (_s: any, e: any) => { edgesWritten.push(e); }),
  listThreadEdges: vi.fn(async () => edgesWritten),
}));

import {
  stripUriCredentials,
  canonicalStorageUri,
  canonicalDatasetIdentity,
  parseStorageUri,
} from '@/lib/lineage/dataset-naming';
import { resolveOwner, type PathItem } from '@/lib/lineage/dataset-item-resolver';
import { harvestPipelineRunLineage, __resetHarvestDedupe } from '@/lib/lineage/synapse-lineage-harvest';

const SESSION = { claims: { oid: 'caller-1', upn: 'caller@loom.test' }, exp: 0 } as any;

beforeEach(() => {
  edgesWritten.length = 0;
  __resetHarvestDedupe();
  vi.clearAllMocks();
  mocks.queryItems.mockResolvedValue({ resources: [] } as any);
  mocks.listActivityRuns.mockResolvedValue([] as any);
  mocks.getLinkedService.mockResolvedValue(null as any);
});

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
// Budget treadmill — a truncated pass must ADVANCE, not restart
// ---------------------------------------------------------------------------
describe('harvest budget: a truncated pass resumes instead of rewriting the head', () => {
  // The 8s wall clock deliberately does not mark a truncated run harvested, so
  // the next poll retries — but the retry re-entered at activity 0, rewriting
  // the same leading activities every poll and never reaching the tail. The
  // per-principal 5/s limit does not bound that: it permits five 8-second ARM
  // fan-outs per second per user.
  //
  // MUTATION: in `harvestPipelineRunLineage`, `const start = 0;` (ignore
  // resumeCursor).
  // → observed: 1 failure — pass 2 re-writes act-0/act-1's sinks
  //   (`['sink0','sink1','sink2','sink3']` becomes `['sink0','sink1']` again).
  const ACTS = ['a0', 'a1', 'a2', 'a3'];

  function wireFourCopies() {
    mocks.getPipeline.mockResolvedValue({
      properties: {
        activities: ACTS.map((n) => ({
          type: 'Copy',
          name: n,
          inputs: [{ referenceName: 'src' }],
          outputs: [{ referenceName: `sink_${n}` }],
        })),
      },
    } as any);
    mocks.getDataset.mockImplementation(async (name: string) => ({
      properties: {
        type: 'Parquet',
        linkedServiceName: { referenceName: 'ls' },
        typeProperties: {
          location: {
            type: 'AzureBlobFSLocation',
            fileSystem: 'data',
            folderPath: name === 'src' ? 'bronze/src' : `silver/${name}`,
          },
        },
      },
    } as any));
    mocks.getLinkedService.mockResolvedValue({
      properties: { typeProperties: { url: 'https://stloom.dfs.core.windows.net' } },
    } as any);
  }

  function sinkLeaves(): string[] {
    return edgesWritten.map((e) => String(e.toItemId).split('/').pop() as string);
  }

  it('the second poll harvests the activities the first one could not reach', async () => {
    wireFourCopies();

    // Clock: t0 = 0 (deadline 8000), then +3000 per read. The loop's pre-check
    // trips on the third activity, so pass 1 collects a0 + a1 only.
    let t = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { t += 3000; return t - 3000; });

    const first = await harvestPipelineRunLineage(SESSION, {
      workspaceId: 'ws-1', adfPipelineName: 'p1', factoryName: 'f1',
      runId: 'run-1', runStatus: 'Succeeded',
    });
    clock.mockRestore();

    expect(first.ok).toBe(true);
    const pass1 = sinkLeaves();
    expect(pass1.length).toBeGreaterThan(0);
    expect(pass1.length).toBeLessThan(ACTS.length);

    // Pass 2: real clock, no truncation. It must pick up where pass 1 stopped.
    edgesWritten.length = 0;
    const second = await harvestPipelineRunLineage(SESSION, {
      workspaceId: 'ws-1', adfPipelineName: 'p1', factoryName: 'f1',
      runId: 'run-1', runStatus: 'Succeeded',
    });
    expect(second.ok).toBe(true);
    const pass2 = sinkLeaves();

    // THE ASSERTION: no activity is harvested twice, and between the two passes
    // every activity is covered exactly once.
    expect(pass2.filter((s) => pass1.includes(s))).toEqual([]);
    expect([...pass1, ...pass2].sort()).toEqual(ACTS.map((a) => `sink_${a}`).sort());
  });

  it('a completed pass clears the cursor so a later poll is a no-op', async () => {
    wireFourCopies();
    await harvestPipelineRunLineage(SESSION, {
      workspaceId: 'ws-1', adfPipelineName: 'p1', factoryName: 'f1',
      runId: 'run-2', runStatus: 'Succeeded',
    });
    edgesWritten.length = 0;
    const again = await harvestPipelineRunLineage(SESSION, {
      workspaceId: 'ws-1', adfPipelineName: 'p1', factoryName: 'f1',
      runId: 'run-2', runStatus: 'Succeeded',
    });
    expect(again.reason).toBe('already harvested in this replica');
    expect(edgesWritten).toHaveLength(0);
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
