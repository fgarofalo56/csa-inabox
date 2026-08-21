/**
 * #3833 — TENANT BOUNDARY on POST /api/workspaces/bulk-delete.
 *
 * THE DEFECT THESE PIN. The route used to resolve each id itself:
 *
 *     let ws = await loadWorkspace(id, tenantId);
 *     if (!ws && admin) ws = await loadWorkspaceAdmin(id);   // NO tenant predicate
 *     if (!ws) { failed.push({ id, error: 'not_found' }); continue; }
 *     if (!admin && ws.createdBy && ws.createdBy !== session.claims.oid) { … }
 *     const receipts = await deleteOne(ws, cascade);
 *
 * For `admin === true` the cross-partition read had no tenant filter, the
 * ownership check underneath was skipped WHOLESALE by `!admin &&`, and the doc
 * went straight into `deleteOne`. A tenant admin holding a workspace GUID from
 * another tenant DESTROYED it — and on `cascade`, tore down its Azure backends.
 *
 * The siblings in this family (#3823/#3825/#3826) were reads or authorize
 * bypasses. This one destroys, so these specs assert on the SURVIVAL OF THE DOC
 * and on `teardownWorkspaceBackends` never being reached — not merely on the
 * response body. A response that says `not_found` while the delete already
 * happened would pass a body-only assertion.
 *
 * They exercise the REAL POST handler with mocked Cosmos (per no-vaporware.md),
 * through the same shared resolver the single-workspace route uses, and they
 * cover the four properties the fix must hold plus the control that admin
 * cleanup of same-tenant UAT debris — this endpoint's whole purpose — still
 * works.
 *
 * TWO AXES ARE COVERED EXHAUSTIVELY RATHER THAN BY SAMPLE, because three review
 * rounds died to a bypass narrowed onto an axis the fixtures happened not to
 * span:
 *   - POSITION — every non-empty subset of foreign positions for sizes 1..4
 *     (the batch-shape matrix);
 *   - SIZE — every batch size in [1, MAX_BATCH], the entire domain the delete
 *     loop can ever see, with the interval's far end pinned from the outside
 *     (the batch-size sweep). Rounds 2 and 3 each answered a size-narrowed
 *     bypass by moving a ceiling; the frontier moved with it both times.
 * Both are crossed with cascade off/on, and both assert DOCUMENT SURVIVAL.
 *
 * EDGE THIS SUITE CANNOT SEE, disclosed rather than left to be discovered:
 * `vi.resetModules()` in afterEach plus the per-call dynamic `import()` in
 * `post()` hands every test a FRESH module, so process-lifetime module state
 * is invisible here. The route has none today (its only module scope is
 * `const MAX_BATCH = 500`), but `export const runtime = 'nodejs'` means the
 * module IS long-lived across requests — a memo/cache added to it later would
 * be untestable by these specs and needs its own coverage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'admin-oid', upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  tenantScopeId: (s: any) => s?.claims?.tid ?? s?.claims?.oid,
}));

vi.mock('@azure/identity', () => {
  class Cred {
    async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

interface FakeItem { id: string; pk: string; doc: any }
function makeContainer(crossPartitionById = false) {
  const store = new Map<string, FakeItem>();
  return {
    _store: store,
    item(id: string, pk: string) {
      const key = `${pk}::${id}`;
      return {
        async read<T>() {
          const it = store.get(key);
          if (!it) { const e: any = new Error('not found'); e.code = 404; throw e; }
          return { resource: it.doc as T };
        },
        async delete() {
          if (!store.has(key)) { const e: any = new Error('nf'); e.code = 404; throw e; }
          store.delete(key);
        },
      };
    },
    items: {
      query(q: any) {
        return {
          async fetchAll() {
            if (crossPartitionById) {
              const idParam = q?.parameters?.find((p: any) => p.name === '@id')?.value;
              const rows = [...store.values()].map((v) => v.doc).filter((d) => !idParam || d.id === idParam);
              return { resources: rows };
            }
            return { resources: [] };
          },
        };
      },
    },
  };
}

const containers = {
  workspaces: makeContainer(true),
  items: makeContainer(false),
  workspaceRoles: makeContainer(false),
};

vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => containers.workspaces,
  itemsContainer: async () => containers.items,
  workspaceRolesContainer: async () => containers.workspaceRoles,
}));

vi.mock('@/lib/azure/loom-search', () => ({
  upsertLoomDoc: vi.fn(),
  deleteLoomDoc: vi.fn(),
  docForWorkspace: (w: any) => ({ id: `ws:${w.id}` }),
}));

vi.mock('@/lib/azure/lineage-gc', () => ({ cleanupWorkspaceMetadata: vi.fn() }));

// The DESTRUCTIVE half of a cascade delete. Spied, never stubbed away silently:
// several specs below assert it was NOT reached for a refused id.
const teardownMock = vi.fn(async () => [] as any[]);
vi.mock('@/lib/azure/resource-teardown', () => ({
  teardownWorkspaceBackends: (...a: any[]) => teardownMock(...(a as [])),
}));

const resolveEffectiveRoleMock = vi.fn(async () => null);
vi.mock('@/lib/azure/workspace-roles-client', () => ({
  resolveEffectiveRole: (...a: any[]) => resolveEffectiveRoleMock(...(a as [])),
}));

const isTenantAdminMock = vi.fn(() => true);
vi.mock('@/lib/auth/feature-gate', () => ({
  isTenantAdmin: (...args: any[]) => isTenantAdminMock(...(args as [])),
}));

/** The Entra tenant the admin session lives in. */
const HOME_TID = 'tid-contoso';
/** A DIFFERENT Entra tenant. Nothing in it may ever be deleted from here. */
const FOREIGN_TID = 'tid-fabrikam';
/** Owner oid for the home-tenant workspaces in the batch-shape matrix. */
const HOME_OWNER = 'alice-oid';
/** Owner oid for the foreign-tenant workspaces — a principal in FOREIGN_TID. */
const FOREIGN_OWNER = 'mallory-oid';
/**
 * A pre-rel-T11 workspace id — GUID-SHAPED, like every other fixture here.
 *
 * ROUND 3 DISCLOSED THIS AS A RESIDUAL AND DECLINED TO FIX IT, on a stated cost
 * of "61 lines". Round-4 review measured the fix at +12/-11 (this constant plus
 * eleven literal swaps) and reproduced the hole on the shipped bytes: a bypass
 * narrowed to `id.length === 36 && id.split('-').length === 5 && !doc.tid`
 * passed the whole suite, because the round-3 GUID sweep reached only the
 * matrix fixtures — every doc of which carries a `tid` — while the only
 * tid-LESS fixtures kept short labels like `wsLegacy`. Neither half saw it.
 * Synthetic value, never an estate GUID (this repo is public).
 */
const LEGACY_GUID = '00000000-0000-4000-8000-0000000000ab';

function seedWorkspace(id: string, ownerOid: string, extra: Record<string, unknown> = {}) {
  const doc = {
    id, tenantId: ownerOid, name: `ws-${id}`, createdBy: `${ownerOid}@example.test`,
    createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z', ...extra,
  };
  containers.workspaces._store.set(`${ownerOid}::${id}`, { id, pk: ownerOid, doc });
  return doc;
}

/** True while the workspace doc is still in Cosmos — i.e. NOT destroyed. */
const stillExists = (id: string, ownerOid: string) =>
  containers.workspaces._store.has(`${ownerOid}::${id}`);

const post = async (body: unknown) => {
  const { POST } = await import('@/app/api/workspaces/bulk-delete/route');
  return POST({ json: async () => body } as any);
};

beforeEach(() => {
  for (const c of Object.values(containers)) (c as any)._store.clear();
  getSessionMock.mockReturnValue({
    claims: { oid: 'admin-oid', upn: 'admin@contoso.com', tid: HOME_TID },
    exp: Date.now() / 1000 + 3600,
  } as any);
  isTenantAdminMock.mockReturnValue(true);
  resolveEffectiveRoleMock.mockResolvedValue(null);
  teardownMock.mockClear();
  teardownMock.mockResolvedValue([] as any[]);
  delete process.env.LOOM_MULTIUSER_ACL; // default ON
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('#3833 — a tenant admin cannot bulk-delete across the tenant boundary', () => {
  it('REFUSES a foreign-tenant workspace and LEAVES THE DOC INTACT', async () => {
    // The exact attack: an admin in tid-contoso holding a GUID from tid-fabrikam.
    seedWorkspace('wsX', 'mallory-oid', { name: 'Fabrikam Finance', tid: FOREIGN_TID });

    const r = await post({ ids: ['wsX'] });
    const j = await r.json();

    expect(j.ok).toBe(false);
    expect(j.deleted).toEqual([]);
    expect(j.failed).toEqual([{ id: 'wsX', error: 'not_found' }]);
    // The consequence, not just the message: the workspace SURVIVES.
    expect(stillExists('wsX', 'mallory-oid')).toBe(true);
  });

  it('REFUSES a foreign-tenant workspace on CASCADE and never reaches Azure teardown', async () => {
    // cascade is the destructive flag — it tears down the workspace's real Azure
    // backends. The refusal must happen BEFORE deleteOne, not inside it.
    seedWorkspace('wsX', 'mallory-oid', { name: 'Fabrikam Finance', tid: FOREIGN_TID });

    const r = await post({ ids: ['wsX'], cascade: true });
    const j = await r.json();

    expect(j.deleted).toEqual([]);
    expect(j.failed).toEqual([{ id: 'wsX', error: 'not_found' }]);
    expect(stillExists('wsX', 'mallory-oid')).toBe(true);
    // The Azure resources were never touched.
    expect(teardownMock).not.toHaveBeenCalled();
  });

  it('REFUSES a foreign-tenant workspace in FIRST batch position, while a home-tenant id in the same batch deletes', async () => {
    // Position matters: a bypass scoped to "the first id" would delete wsX here
    // and still report a green-looking body for the batch.
    seedWorkspace('wsX', 'mallory-oid', { name: 'Fabrikam Finance', tid: FOREIGN_TID });
    seedWorkspace('wsHome', 'alice-oid', { name: 'Contoso Sales', tid: HOME_TID });

    const r = await post({ ids: ['wsX', 'wsHome'] });
    const j = await r.json();

    expect(j.deleted).toEqual(['wsHome']);
    expect(j.failed).toEqual([{ id: 'wsX', error: 'not_found' }]);
    expect(stillExists('wsX', 'mallory-oid')).toBe(true);
    expect(stillExists('wsHome', 'alice-oid')).toBe(false);
  });

  it('REFUSES a foreign-tenant workspace in LAST batch position too', async () => {
    seedWorkspace('wsHome', 'alice-oid', { name: 'Contoso Sales', tid: HOME_TID });
    seedWorkspace('wsX', 'mallory-oid', { name: 'Fabrikam Finance', tid: FOREIGN_TID });

    const r = await post({ ids: ['wsHome', 'wsX'] });
    const j = await r.json();

    expect(j.deleted).toEqual(['wsHome']);
    expect(j.failed).toEqual([{ id: 'wsX', error: 'not_found' }]);
    expect(stillExists('wsX', 'mallory-oid')).toBe(true);
  });
});

/**
 * BATCH-SHAPE MATRIX — the axis a fixed set of hand-written cases cannot cover.
 *
 * ROUND-2 REVIEW FOUND THE SPECS ABOVE BLIND ABOVE TWO IDS. Every one of them
 * posts one or two ids, so a bypass narrowed to `ids.length >= 3` — call the
 * resolver, DISCARD its tenancy verdict, cross-partition read the doc, delete it
 * — passed all of them and the whole suite stayed green (measured: 2 files /
 * 27 tests / RC=0 with that mutation live). MIDDLE position was untested for the
 * same reason: it is not expressible below three ids.
 *
 * ADDING "A 3-ID CASE" WOULD HAVE CLOSED EXACTLY THOSE TWO HOLES AND LEFT THE
 * NEXT ONE OPEN. Five PRs in this program have died to a bypass narrowed onto an
 * axis the fixtures hard-coded, so the batch SHAPE is a PARAMETER here, not one
 * more fixed case: every size 1..MAX_SHAPE_SIZE crossed with every non-empty
 * subset of positions that are foreign, crossed with cascade off/on. First,
 * middle, last, several-at-once and all-foreign fall OUT of the generator
 * instead of being enumerated by hand, and widening the covered range is a
 * one-token change to MAX_SHAPE_SIZE.
 *
 * THE ASSERTION IS DOCUMENT SURVIVAL (`stillExists`), NOT A CALL COUNT. A bypass
 * that consults the resolver and ignores the answer — the evasion that defeated
 * the strongest instrument in the sibling PR — satisfies any "was it called"
 * check and cannot satisfy this one.
 *
 * AND THIS MATRIX DID EXACTLY WHAT THE PARAGRAPH ABOVE WARNS ABOUT. Parameterising
 * to MAX_SHAPE_SIZE = 4 closed sizes 1..4 and left the next one open: round-4
 * review measured a bypass gated `ids.length >= 5` passing the entire suite,
 * RC=0, 81/81. The frontier had moved one step, which is not the same as closing
 * an axis. The BATCH-SIZE SWEEP below is the actual closure — read it as the
 * continuation of this block, not as a competing one. This matrix keeps its job:
 * it is the exhaustive POSITION cover (every subset), which the sweep does not
 * attempt; the sweep is the exhaustive SIZE cover, which this cannot reach.
 */

/** Batch sizes 1..this are covered exhaustively (2**n - 1 shapes each). */
const MAX_SHAPE_SIZE = 4;

/** Every non-empty set of foreign positions, for every batch size 1..max. */
function foreignPositionShapes(max: number): { size: number; foreign: number[] }[] {
  const shapes: { size: number; foreign: number[] }[] = [];
  for (let size = 1; size <= max; size++) {
    for (let mask = 1; mask < 1 << size; mask++) {
      const foreign: number[] = [];
      for (let i = 0; i < size; i++) if (mask & (1 << i)) foreign.push(i);
      shapes.push({ size, foreign });
    }
  }
  return shapes;
}

/** Seed one batch: `foreign` positions live in FOREIGN_TID, the rest in HOME_TID. */
function seedShape(size: number, foreign: number[]) {
  const isForeign = new Set(foreign);
  const ids: string[] = [];
  for (let i = 0; i < size; i++) {
    // GUID-SHAPED ON PURPOSE. Review measured a bypass narrowed onto the id
    // SHAPE — `id.length === 36 && id.split('-').length === 5`, destroy the
    // foreign doc, still report `not_found` — passing this suite 80/80, RC=0,
    // solely because every fixture id was a short label. (Control: force that
    // gate true and 59 tests fail, so the body was live the whole time.) The
    // attack in the header IS "an admin holding a workspace GUID from another
    // tenant", so the fixtures have to look like one. padStart holds the
    // 8-4-4-4-12 shape for any MAX_SHAPE_SIZE, not just single digits.
    const id = `${String(i).padStart(8, '0')}-0000-4000-8000-${String(i).padStart(12, '0')}`;
    ids.push(id);
    if (isForeign.has(i)) seedWorkspace(id, FOREIGN_OWNER, { name: `Fabrikam ${i}`, tid: FOREIGN_TID });
    else seedWorkspace(id, HOME_OWNER, { name: `Contoso ${i}`, tid: HOME_TID });
  }
  return {
    ids,
    foreignIds: ids.filter((_, i) => isForeign.has(i)),
    homeIds: ids.filter((_, i) => !isForeign.has(i)),
  };
}

describe('#3833 property 1b — the boundary holds at every BATCH SHAPE, not just 1–2 ids', () => {
  const shapes = foreignPositionShapes(MAX_SHAPE_SIZE);

  it('generates every foreign-position subset, including the ones below 3 ids cannot express', () => {
    // The generator is itself under test — a matrix that silently produced two
    // shapes would look like coverage and be none. sum(2**n - 1) for n=1..N.
    // The LITERAL first: the formula below is self-referential, so at
    // MAX_SHAPE_SIZE = 0 it evaluates to 0 and `expect([]).toHaveLength(0)`
    // PASSES — on its own it cannot catch a shrink of the matrix. This number
    // is keyed to MAX_SHAPE_SIZE = 4; widening the range is now a deliberate
    // TWO-line edit, which is the point.
    expect(shapes).toHaveLength(26);
    expect(shapes).toHaveLength(2 ** (MAX_SHAPE_SIZE + 1) - MAX_SHAPE_SIZE - 2);
    // MIDDLE position, the case that needs 3 ids to exist at all.
    expect(shapes).toContainEqual({ size: 3, foreign: [1] });
    // Interior-only foreign pair — neither end of the batch.
    expect(shapes).toContainEqual({ size: 4, foreign: [1, 2] });
    // Every id foreign: nothing may be deleted at all.
    expect(shapes).toContainEqual({ size: 4, foreign: [0, 1, 2, 3] });
  });

  for (const cascade of [false, true]) {
    for (const { size, foreign } of shapes) {
      const isForeign = new Set(foreign);
      const shape = Array.from({ length: size }, (_, i) => (isForeign.has(i) ? 'F' : 'H')).join('');
      it(`${shape} (${size} ids, cascade=${cascade}) — deletes every HOME id and NO foreign one`, async () => {
        const { ids, foreignIds, homeIds } = seedShape(size, foreign);

        const r = await post({ ids, ...(cascade ? { cascade: true } : {}) });
        const j = await r.json();

        // Body: exactly the home ids, in batch order; every foreign id refused
        // with the same opaque code a nonexistent id gets.
        expect(j.deleted).toEqual(homeIds);
        expect(j.failed).toEqual(foreignIds.map((id) => ({ id, error: 'not_found' })));
        expect(j.ok).toBe(false); // every shape carries at least one foreign id

        // THE CONSEQUENCE, PER ID. This is the assertion a consult-then-discard
        // bypass cannot satisfy: the foreign documents are still in Cosmos.
        for (const id of foreignIds) expect(stillExists(id, FOREIGN_OWNER)).toBe(true);
        for (const id of homeIds) expect(stillExists(id, HOME_OWNER)).toBe(false);

        // On cascade, Azure teardown ran once per HOME id and never for a foreign one.
        expect(teardownMock).toHaveBeenCalledTimes(cascade ? homeIds.length : 0);
      });
    }
  }
});

/**
 * BATCH-SIZE SWEEP — the size axis closed by EXHAUSTING IT, not by moving its
 * ceiling.
 *
 * WHY A CEILING BUMP IS NOT A FIX. Round 2 rejected this PR for a bypass gated
 * `ids.length >= 3`. Round 3 answered by parameterising the matrix to
 * MAX_SHAPE_SIZE = 4 — and round 4 found the identical evasion one step along at
 * `>= 5`, passing the full suite RC=0 / 81 of 81. `MAX_SHAPE_SIZE 4 -> 5` would
 * put it at 6. The matrix cannot go further either way: it costs 2**n - 1 shapes
 * per size, so exhausting positions and sizes together is combinatorially out of
 * reach. Three rounds of moving the frontier is the evidence that the frontier
 * is the wrong instrument.
 *
 * WHAT ACTUALLY CLOSES IT: THE SIZE AXIS IS FINITE, SO IT CAN BE EXHAUSTED.
 * `route.ts` de-dupes, then refuses `ids.length > MAX_BATCH` with a 400 BEFORE
 * the delete loop is entered, and refuses an empty list with a 400 as well. So
 * every batch that can EVER reach the loop has a size in [1, MAX_BATCH]. This
 * block walks EVERY ONE of those sizes, crossed with cascade off/on, and the
 * companion spec below pins both ends of the interval — MAX_BATCH is processed,
 * MAX_BATCH + 1 never reaches the loop. Together there is no size at which a
 * size-keyed predicate can hide: not `>= N`, not `=== N`, not `% k`, not a
 * range, not "only the biggest batch anyone actually sends".
 *
 * FOREIGN IDS ARE SCATTERED, NOT CLUSTERED, and the scatter offset MOVES with
 * the batch size (see {@link sweepForeignPositions}), so this also denies an
 * evasion keyed on INDEX POSITION at sizes the matrix cannot reach — "the first
 * id", "the last id", "index 7". Deterministic: no Math.random(), so a failure
 * reproduces byte-for-byte.
 *
 * SAME ASSERTION AS THE MATRIX: document survival. A consult-then-discard bypass
 * leaves `deleted`, `failed` and the teardown count all exactly as expected and
 * is visible ONLY in `stillExists`.
 */

/**
 * `MAX_BATCH` in `app/api/workspaces/bulk-delete/route.ts`. Not imported — the
 * route does not export it — so it is PINNED instead by the companion spec
 * below, which asserts this many ids are processed and one more is refused. If
 * someone raises the route's constant, that spec fails and forces this one to be
 * raised with it; the sweep can therefore never silently stop short of the real
 * domain.
 */
const ROUTE_MAX_BATCH = 500;

/** Sizes per `it()`. Purely a failure-reporting granularity knob. */
const SWEEP_CHUNK = 50;

/**
 * Which positions of a size-`n` batch are foreign.
 *
 * The residue MOVES with the batch size, so no fixed index is foreign in every
 * batch or home in every batch — an evasion keyed on a position, or on "the
 * first/last id", has no index that works across the sweep. Every batch of 3 or
 * more carries at least one foreign id and at least one home id, so both halves
 * of every assertion always have teeth.
 */
const sweepForeignPositions = (size: number): number[] => {
  const foreign: number[] = [];
  for (let i = 0; i < size; i++) if ((i + size) % 3 === 0) foreign.push(i);
  return foreign;
};

describe('#3833 property 1c — the boundary holds at EVERY admissible batch size', () => {
  it('the sweep spans the whole domain, and scatters foreign ids through the interior', () => {
    // The generator is under test before anything relies on it — a scatter that
    // silently degenerated to "index 0 only" would look like coverage and be
    // none, which is precisely the failure mode of the last three rounds.
    // A literal pin at one size, so the shape is legible and not just asserted:
    expect(sweepForeignPositions(32)).toEqual([1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31]);

    const everForeign = new Set<number>();
    const everHome = new Set<number>();
    const headOnly: number[] = [];
    const noInterior: number[] = [];
    const allForeign: number[] = [];
    for (let size = 1; size <= ROUTE_MAX_BATCH; size++) {
      const foreign = sweepForeignPositions(size);
      const set = new Set(foreign);
      for (let i = 0; i < size; i++) (set.has(i) ? everForeign : everHome).add(i);
      if (foreign.length === size) allForeign.push(size);
      if (size >= 3 && foreign.length === 1 && foreign[0] === 0) headOnly.push(size);
      if (size >= 5 && !foreign.some((i) => i > 0 && i < size - 1)) noInterior.push(size);
    }
    // No batch is entirely foreign — every size still proves home ids DELETE,
    // so the sweep cannot pass by refusing everything.
    expect(allForeign).toEqual([]);
    // From 5 ids up, at least one foreign id sits strictly inside the batch:
    // an "only the head"/"only the tail" bypass is not sufficient to pass.
    expect(noInterior).toEqual([]);
    // Size 3 is the one degenerate shape (foreign = [0] alone). Named rather
    // than hidden — sizes 1-4 are covered exhaustively by the matrix above, so
    // it costs nothing here.
    expect(headOnly).toEqual([3]);
    // Every index position that CAN be both is both. The top two indices exist
    // in fewer than three batches, so all three residues are not available to
    // them — stated, not glossed, and irrelevant because the matrix + the rest
    // of the sweep already deny a position-keyed narrowing.
    for (let i = 0; i <= ROUTE_MAX_BATCH - 3; i++) {
      expect({ i, foreign: everForeign.has(i), home: everHome.has(i) })
        .toEqual({ i, foreign: true, home: true });
    }
  });

  for (const cascade of [false, true]) {
    for (let lo = 1; lo <= ROUTE_MAX_BATCH; lo += SWEEP_CHUNK) {
      const hi = Math.min(lo + SWEEP_CHUNK - 1, ROUTE_MAX_BATCH);
      it(`sizes ${lo}–${hi} (cascade=${cascade}) — every FOREIGN doc survives, every HOME doc is deleted`, async () => {
        for (let size = lo; size <= hi; size++) {
          // Ids repeat across sizes, so the store MUST be cleared between them
          // or a stale doc from the previous size would answer `stillExists`.
          for (const c of Object.values(containers)) (c as any)._store.clear();
          teardownMock.mockClear();

          const { ids, foreignIds, homeIds } = seedShape(size, sweepForeignPositions(size));
          const r = await post({ ids, ...(cascade ? { cascade: true } : {}) });
          const j = await r.json();

          // `size` rides along in every assertion so a failure names the size it
          // failed at — the sweep is 500 iterations inside 10 `it()` blocks.
          expect({ size, deleted: j.deleted }).toEqual({ size, deleted: homeIds });
          expect({ size, failed: j.failed }).toEqual({
            size,
            failed: foreignIds.map((id) => ({ id, error: 'not_found' })),
          });

          // THE CONSEQUENCE. Everything above is response bytes, which a
          // consult-then-discard bypass reproduces exactly. Only this sees it.
          expect({ size, destroyed: foreignIds.filter((id) => !stillExists(id, FOREIGN_OWNER)) })
            .toEqual({ size, destroyed: [] });
          expect({ size, undeleted: homeIds.filter((id) => stillExists(id, HOME_OWNER)) })
            .toEqual({ size, undeleted: [] });
          expect({ size, teardowns: teardownMock.mock.calls.length })
            .toEqual({ size, teardowns: cascade ? homeIds.length : 0 });
        }
      });
    }
  }

  it(`accepts a full ${ROUTE_MAX_BATCH}-id batch and refuses ${ROUTE_MAX_BATCH + 1} BEFORE deleting anything`, async () => {
    // THIS IS WHAT MAKES THE SWEEP EXHAUSTIVE RATHER THAN MERELY LARGE. The
    // sweep stops at MAX_BATCH because the ROUTE stops there; this pins that
    // claim from the outside instead of trusting it. It also pins the constant:
    // raise MAX_BATCH in the route and this spec fails, which is the mechanism
    // that keeps ROUTE_MAX_BATCH above honest.
    const over = seedShape(ROUTE_MAX_BATCH + 1, sweepForeignPositions(ROUTE_MAX_BATCH + 1));
    const seeded = containers.workspaces._store.size;
    expect(seeded).toBe(ROUTE_MAX_BATCH + 1);

    const r = await post({ ids: over.ids });
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.error).toContain(`max ${ROUTE_MAX_BATCH} per request`);
    // Nothing was destroyed — not the foreign docs, and not the home ones
    // either. The delete loop was never entered at all.
    expect(containers.workspaces._store.size).toBe(seeded);
    expect(teardownMock).not.toHaveBeenCalled();
  });
});

describe('#3833 property 3 — a foreign id is INDISTINGUISHABLE from a nonexistent id', () => {
  it('emits byte-identical per-id output for a cross-tenant id and an id that does not exist', async () => {
    // route-toolkit.ts states the precedent (404-not-403): an id must not be
    // probeable for existence across tenants. A test that only asserts "foreign
    // is refused" would pass while a distinguishable message leaked existence.
    seedWorkspace('wsX', 'mallory-oid', { name: 'Fabrikam Finance', tid: FOREIGN_TID });

    const rForeign = await post({ ids: ['wsX'] });
    const jForeign = await rForeign.json();

    containers.workspaces._store.clear();
    const rGhost = await post({ ids: ['wsGhost'] });
    const jGhost = await rGhost.json();

    // Same error string...
    expect(jForeign.failed[0].error).toBe(jGhost.failed[0].error);
    // ...and the same SHAPE — no extra field (reason/remediation/detail) on one
    // and not the other. Compared with the id normalized away.
    expect({ ...jForeign.failed[0], id: '<id>' }).toEqual({ ...jGhost.failed[0], id: '<id>' });
    expect(Object.keys(jForeign.failed[0]).sort()).toEqual(Object.keys(jGhost.failed[0]).sort());
    // ...and the same envelope.
    expect(jForeign.ok).toBe(jGhost.ok);
    expect(jForeign.deleted).toEqual(jGhost.deleted);
  });
});

describe('#3833 property 4 — a tid-less workspace doc is refused HONESTLY and distinguishably', () => {
  it('reports tenant_unconfirmed (not forbidden, not not_found) with the backfill remediation, and keeps the doc', async () => {
    seedWorkspace(LEGACY_GUID, 'alice-oid', { name: 'Legacy Sales' }); // no tid

    const r = await post({ ids: [LEGACY_GUID] });
    const j = await r.json();

    expect(j.deleted).toEqual([]);
    expect(j.failed).toHaveLength(1);
    const f = j.failed[0];
    expect(f.id).toBe(LEGACY_GUID);
    expect(f.error).toBe('tenant_unconfirmed');
    // Distinguishable from BOTH neighbouring codes — the UI must be able to say
    // something true about why, which 'forbidden' would not permit.
    expect(f.error).not.toBe('forbidden');
    expect(f.error).not.toBe('not_found');
    // deploy-integrity R7 — the reason states what was ESTABLISHED. It must not
    // claim the workspace is missing.
    expect(f.reason).toMatch(/could not confirm the workspace belongs to your Entra tenant/i);
    expect(f.reason).not.toMatch(/not found/i);
    expect(f.remediation).toContain('scripts/csa-loom/backfill-workspace-tid.mjs');
    // And the doc is still there — a refusal, not a delete.
    expect(stillExists(LEGACY_GUID, 'alice-oid')).toBe(true);
  });

  it('does not reach Azure teardown for a tid-less doc even on cascade', async () => {
    seedWorkspace(LEGACY_GUID, 'alice-oid', { name: 'Legacy Sales' });

    const r = await post({ ids: [LEGACY_GUID], cascade: true });
    const j = await r.json();

    expect(j.deleted).toEqual([]);
    expect(j.failed[0].error).toBe('tenant_unconfirmed');
    expect(stillExists(LEGACY_GUID, 'alice-oid')).toBe(true);
    expect(teardownMock).not.toHaveBeenCalled();
  });

  it('records the SAME refusal when the CALLER has no tid — over a fully tid-stamped FOREIGN workspace', async () => {
    // The other, WIDER half of the same gate. Resolver step 4 is truthiness-
    // guarded on BOTH sides, so with no `callerTid` it cannot fire and step 6
    // records the denial instead — for a workspace that DOES carry a tid, in a
    // tenant that is not the caller's. So when the CALLER is the unconfirmed
    // side, the residual oracle covers every workspace in any tenant, not only
    // tid-less ones. Inherited from #3824 and unmodified here; pinned so the
    // disclosure in the PR body stays true (deploy-integrity R7).
    seedWorkspace('wsX', 'mallory-oid', { name: 'Fabrikam Finance', tid: FOREIGN_TID });
    getSessionMock.mockReturnValue({
      claims: { oid: 'admin-oid', upn: 'admin@contoso.com' }, // no tid claim
      exp: Date.now() / 1000 + 3600,
    } as any);

    const r = await post({ ids: ['wsX'] });
    const j = await r.json();

    expect(j.failed[0].error).toBe('tenant_unconfirmed');
    // A REFUSAL, not a delete — the foreign doc survives.
    expect(stillExists('wsX', 'mallory-oid')).toBe(true);

    // ...while an id that exists nowhere still gets the opaque code, which is
    // exactly what makes the pair distinguishable. Recorded as the residual,
    // not asserted as desirable.
    containers.workspaces._store.clear();
    const rGhost = await post({ ids: ['wsGhost'] });
    expect((await rGhost.json()).failed[0].error).toBe('not_found');
  });

  it('never leaks tenant_unconfirmed to a NON-admin — they get the plain not_found', async () => {
    // The denial is only recorded for a tenant-admin refusal. A non-admin must
    // not learn that a tid-less workspace with this id exists anywhere.
    seedWorkspace(LEGACY_GUID, 'alice-oid', { name: 'Legacy Sales' });
    isTenantAdminMock.mockReturnValue(false);

    const r = await post({ ids: [LEGACY_GUID] });
    const j = await r.json();

    expect(j.failed).toEqual([{ id: LEGACY_GUID, error: 'not_found' }]);
    expect(stillExists(LEGACY_GUID, 'alice-oid')).toBe(true);
  });
});

describe('#3833 property 5 — legitimate same-tenant admin cleanup STILL WORKS (the control)', () => {
  it('a tenant admin deletes a FOREIGN-OWNED workspace inside their own confirmed tenant', async () => {
    // This is the endpoint's stated purpose: purging UAT/test debris the admin
    // did not personally create. If this spec fails, the fix over-corrected.
    seedWorkspace('wsUat1', 'alice-oid', { name: 'UAT debris 1', tid: HOME_TID });
    seedWorkspace('wsUat2', 'bob-oid', { name: 'UAT debris 2', tid: HOME_TID });

    const r = await post({ ids: ['wsUat1', 'wsUat2'] });
    const j = await r.json();

    expect(j.ok).toBe(true);
    expect(j.failed).toEqual([]);
    expect(j.deleted.sort()).toEqual(['wsUat1', 'wsUat2']);
    expect(stillExists('wsUat1', 'alice-oid')).toBe(false);
    expect(stillExists('wsUat2', 'bob-oid')).toBe(false);
  });

  it('same-tenant admin cleanup with CASCADE still tears down the Azure backends', async () => {
    seedWorkspace('wsUat1', 'alice-oid', { name: 'UAT debris 1', tid: HOME_TID });

    const r = await post({ ids: ['wsUat1'], cascade: true });
    const j = await r.json();

    expect(j.deleted).toEqual(['wsUat1']);
    expect(teardownMock).toHaveBeenCalledTimes(1);
  });

  it('a NON-admin owner still deletes their own workspace, with NO tid anywhere (legacy doc)', async () => {
    // The blast radius of refusing tid-less docs is confined to the ADMIN path.
    // The owner fast-path never depended on the tenant bypass and must not
    // regress for pre-rel-T11 data.
    seedWorkspace('wsMine', 'admin-oid', { name: 'My Space' });
    getSessionMock.mockReturnValue({
      claims: { oid: 'admin-oid', upn: 'admin@contoso.com' },
      exp: Date.now() / 1000 + 3600,
    } as any);
    isTenantAdminMock.mockReturnValue(false);

    const r = await post({ ids: ['wsMine'] });
    const j = await r.json();

    expect(j.ok).toBe(true);
    expect(j.deleted).toEqual(['wsMine']);
    expect(stillExists('wsMine', 'admin-oid')).toBe(false);
  });
});

describe('#3833 property 2 — authorization is evaluated for ADMINS too (no `!admin &&` short-circuit)', () => {
  it('refuses an admin who resolves at a non-Admin ACL role, instead of skipping the check', async () => {
    // The resolver returns the caller's REAL role when they hold one (step 5
    // runs before the admin bypass), so an admin who is an explicit Member of
    // this workspace resolves via:'acl' role:'Member'. Destroying a workspace
    // is Owner/Admin-scoped — identical to DELETE /api/workspaces/[id].
    //
    // Under the old code `!admin &&` skipped this branch entirely for any
    // admin, so this id was DELETED.
    seedWorkspace('wsShared', 'alice-oid', { name: 'Shared Space', tid: HOME_TID });
    resolveEffectiveRoleMock.mockResolvedValue('Member' as any);

    const r = await post({ ids: ['wsShared'] });
    const j = await r.json();

    expect(j.deleted).toEqual([]);
    expect(j.failed).toEqual([{ id: 'wsShared', error: 'forbidden' }]);
    expect(stillExists('wsShared', 'alice-oid')).toBe(true);
  });

  it('admits an admin who resolves at ACL role Admin', async () => {
    seedWorkspace('wsShared', 'alice-oid', { name: 'Shared Space', tid: HOME_TID });
    resolveEffectiveRoleMock.mockResolvedValue('Admin' as any);

    const r = await post({ ids: ['wsShared'] });
    const j = await r.json();

    expect(j.deleted).toEqual(['wsShared']);
    expect(stillExists('wsShared', 'alice-oid')).toBe(false);
  });

  it('refuses a NON-admin Member — the pre-existing rule, unchanged', async () => {
    seedWorkspace('wsShared', 'alice-oid', { name: 'Shared Space', tid: HOME_TID });
    getSessionMock.mockReturnValue({
      claims: { oid: 'bob-oid', upn: 'bob@contoso.com', tid: HOME_TID },
      exp: Date.now() / 1000 + 3600,
    } as any);
    isTenantAdminMock.mockReturnValue(false);
    resolveEffectiveRoleMock.mockResolvedValue('Member' as any);

    const r = await post({ ids: ['wsShared'] });
    const j = await r.json();

    expect(j.failed).toEqual([{ id: 'wsShared', error: 'forbidden' }]);
    expect(stillExists('wsShared', 'alice-oid')).toBe(true);
  });
});

/**
 * #3833 property 6 — THE BEHAVIOURAL WIDENING THIS PR CARRIES, PINNED.
 *
 * The old route had exactly one authorization branch:
 *
 *     let ws = await loadWorkspace(id, tenantId);            // caller's partition
 *     if (!ws && admin) ws = await loadWorkspaceAdmin(id);   // ADMIN ONLY
 *     if (!admin && ws.createdBy && ws.createdBy !== oid) { … forbidden }
 *
 * A NON-admin therefore only ever saw their OWN partition, so they could
 * bulk-delete only workspaces they owned. An explicit workspace-level `Admin`
 * grant on someone else's workspace bought them nothing here — it reported
 * `not_found`.
 *
 * Routing through the shared resolver replaces that with the rule
 * `DELETE /api/workspaces/[id]` already applies — `app/api/workspaces/[id]/route.ts:153`,
 * `access.via !== 'owner' && access.role !== 'Admin'` — and on this one axis that
 * rule is WIDER: a caller who is NOT a tenant admin but holds a workspace-level
 * `Admin` ACL on a workspace they do not own can now bulk-delete it.
 *
 * That is the intended consequence of deleting the private path rather than
 * patching it: the whole point is that bulk-delete and the per-workspace DELETE
 * decide access identically, and the per-workspace route has permitted this
 * since rel-T11. It is pinned here because rounds 1-3 shipped it UNTESTED and
 * UNMENTIONED — an undisclosed widening is the part that outlives the merge
 * (deploy-integrity.md R7: state what is established, including about your own
 * change). The tenant boundary still sits in front of it, because the resolver
 * applies the tid check (step 4) BEFORE the ACL lookup (step 5).
 */
describe('#3833 property 6 — a workspace-level Admin ACL can bulk-delete (widening, disclosed)', () => {
  /** A non-tenant-admin caller in the HOME tenant who owns nothing here. */
  const asAclAdmin = () => {
    getSessionMock.mockReturnValue({
      claims: { oid: 'bob-oid', upn: 'bob@contoso.com', tid: HOME_TID },
      exp: Date.now() / 1000 + 3600,
    } as any);
    isTenantAdminMock.mockReturnValue(false); // NOT a tenant admin
    resolveEffectiveRoleMock.mockResolvedValue('Admin' as any); // explicit ACL grant
  };

  it('a NON-tenant-admin with workspace role Admin DELETES a workspace they do not own, in their own tenant', async () => {
    seedWorkspace('wsShared', HOME_OWNER, { name: 'Shared Space', tid: HOME_TID });
    asAclAdmin();

    const r = await post({ ids: ['wsShared'] });
    const j = await r.json();

    expect(j.ok).toBe(true);
    expect(j.failed).toEqual([]);
    expect(j.deleted).toEqual(['wsShared']);
    // The widening, as a consequence and not just a status code.
    expect(stillExists('wsShared', HOME_OWNER)).toBe(false);
  });

  it('the SAME ACL across the TENANT BOUNDARY is still refused, and the doc survives', async () => {
    // The widening is scoped by the resolver's step-4 tid check, which runs
    // BEFORE the ACL lookup — so an Admin-role row cannot be used to reach out
    // of the caller's tenant. cascade on, so the destructive half is covered.
    seedWorkspace('wsX', FOREIGN_OWNER, { name: 'Fabrikam Finance', tid: FOREIGN_TID });
    asAclAdmin();

    const r = await post({ ids: ['wsX'], cascade: true });
    const j = await r.json();

    expect(j.ok).toBe(false);
    expect(j.deleted).toEqual([]);
    expect(j.failed).toEqual([{ id: 'wsX', error: 'not_found' }]);
    expect(stillExists('wsX', FOREIGN_OWNER)).toBe(true);
    expect(teardownMock).not.toHaveBeenCalled();
  });
});

describe('#3833 — envelope regressions', () => {
  it('401s when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const r = await post({ ids: ['wsX'] });
    expect(r.status).toBe(401);
  });

  it('400s on a body that is not { ids: string[] }', async () => {
    const r = await post({ ids: 'nope' });
    expect(r.status).toBe(400);
  });

  it('400s on an empty id list', async () => {
    const r = await post({ ids: [] });
    expect(r.status).toBe(400);
  });
});
