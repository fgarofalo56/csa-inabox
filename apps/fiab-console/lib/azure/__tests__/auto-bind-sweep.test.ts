/**
 * BULK AUTO-BIND SWEEP — #3796.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THESE TESTS PIN
 * ---------------------------------------------------------------------------
 * #3549's repair exists, and it only fires when a human OPENS the item. Create
 * -time binding is best-effort by design (it races an 8s deadline and never
 * throws), so the estate accumulates real, bound, EMPTY backing objects that
 * nothing ever revisits — live, 36 of 41 pipelines in the default factory.
 * `auto-bind-by-default.md` §3 calls the binding self-healing; a heal that
 * waits for a human is not self-healing for an item nobody opens.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ACTUALLY BEING ASSERTED
 * ---------------------------------------------------------------------------
 * Not "36 → 0". `seedPipelineFromContent` authors `state.content`, and a
 * catalog-picker item HAS no `state.content` — its empty pipeline is correct.
 * So the acceptance tested here is #3796's own alternative branch: every empty
 * backing object is either repaired OR carries a stated, inspectable reason.
 * Each disposition below is a distinct such reason, and each test proves the
 * sweep can tell it apart from its neighbours.
 *
 * ---------------------------------------------------------------------------
 * MUTATION PROOF — measured, not asserted (temp/mutate.py + mutate.sh)
 * ---------------------------------------------------------------------------
 * Each mutation is applied byte-exactly (the applier REFUSES unless the needle
 * appears exactly once AND the file's sha256 moves — every file here is 100%
 * CRLF, and a CRLF mismatch otherwise no-ops the edit so the mutation "survives"
 * for the wrong reason), the two suites are run, the file restored, and the
 * restored sha re-printed and compared.
 *
 * The RC is captured on the line after the command, never inferred from a
 * pipeline, and the EXECUTED test count is read back on every run: a mutation
 * that merely makes the file unparseable also exits non-zero, and scoring that
 * as "caught" would be a gate that measures nothing.
 *
 * ── 2026-08-20, on the rebased tree (#3824 merged). Baseline 53 + 24 = 77
 *    green; all twelve CAUGHT, all twelve at 77 executed.
 *
 * The two the 2026-08-20 review left open, and the specs that now pin them:
 *
 *   N1  live mode stops requiring `canWrite`          → 2 RED (was 0)
 *   N2  the write bar is wired but never armed        → 2 RED (was 0)
 *   N3  the `c.id > @cursor` predicate is dropped     → 1 RED (was 0)
 *   N4  `ORDER BY c.id` is dropped                    → 2 RED (was 0)
 *   N5  cursor taken from reported rows, not the raw
 *       window (so a foreign page pins it forever)    → 1 RED (was 0)
 *   N6  the route stops forwarding `cursor`           → 2 RED (was 0)
 *
 * "was 0" is measured, not inferred: both defects were REPRODUCED on this tree
 * before the fix (see the two describe blocks below, which quote the raw
 * output), and the whole 58-spec suite was green over both.
 *
 * ── 2026-08-20 ROUND 2 — the SEALED cursor (#3808 review). The cursor round 1
 *    added was correct about WHERE to resume and wrong about what to hand back:
 *    it returned the raw Cosmos id, which on the very page that motivates
 *    advancing past dropped rows is a FOREIGN tenant's item id. Baseline
 *    59 + 26 = 85 green; all eight below CAUGHT, all eight at 85 executed,
 *    every restore sha256-verified against the pre-mutation bytes.
 *
 *   NEW1 nextCursor returned UNSEALED (the defect itself) → 9 RED (was 0)
 *   NEW2 an unusable cursor degrades to "no cursor"       → 2 RED (was 0)
 *   NEW3 the sealed `tid` binding is not checked          → 1 RED (was 0)
 *   B2a  `scopeToCallerAccess` neutered                   → 10 RED
 *   N1   `canWrite` dropped from the live bar             → 2 RED
 *   N4   `ORDER BY c.id` dropped                          → 2 RED
 *   N3   the `c.id > @cursor` predicate dropped           → 1 RED
 *   DL   the deadline cut records the row it did NOT
 *        process, permanently losing it                   → 1 RED
 *
 * NEW1's "was 0" is the important one, and it is the reason this round exists.
 * `leaks no identifier` scored ZERO RED against it: that spec's fixture is a
 * SINGLE item, so `page.length > limit` is never true, so the page never
 * truncates, so `nextCursor` — the only field that ever carried a foreign
 * identifier — was never emitted at all. The suite read as proof of a property
 * it did not cover. The truncated-page spec added below reproduces the leak
 * verbatim when NEW1 is applied:
 *
 *   expected '{…,"truncated":true,"truncatedBy":"limit","nextCursor":"id-a2"}'
 *            not to contain 'id-a2'
 *
 * ── 2026-08-21 ROUND 5 — the CALLER-CHOSEN scope, and the cursor-resumed page.
 *    Round 2 sealed the cursor; the count next to it was still an oracle when
 *    the caller picked the scope. Baseline 72 + 29 = 101 green; all nine below
 *    CAUGHT, all nine at 101 executed, every restore sha256-verified against
 *    the pre-mutation bytes.
 *
 * A FLAKE WAS FOUND AND FIXED IN THE PROOF ITSELF, which is worth recording
 * because it is the same class as everything else in this ledger. The round-2
 * tamper technique — flip the last base64url character — does NOT reliably
 * corrupt anything: base64url packs 3 bytes per 4 characters, so at a byte
 * length of 2 (mod 3) the final character's low bits are padding and the
 * decoded bytes come back identical. Measured: 4 of 64 possible final
 * characters for a 65-byte token, ~6% of runs, and the IV is random per seal so
 * every run re-rolls. The round-2 spec escaped it only because its fixture id
 * is one character longer (66 bytes, 0 of 64). Both now corrupt a byte inside
 * the GCM tag via {@link tamper}, and a 200-iteration control asserts the
 * corruption is real rather than assuming it.
 *
 *   R5a  the `workspaceId` pre-resolve deleted (the defect itself)  → 4 RED
 *   R5b  the refusal downgraded to an empty RESULT instead of a
 *        throw — i.e. "return a zero count" rather than not-found   → 4 RED
 *   R5c  the pre-resolve gated on `!opts.dryRun`, so a read-only
 *        probe still answers the cardinality question               → 4 RED
 *   R5d  the refusal message made per-case (names the workspace),
 *        reopening the probe through the ERROR path                 → 2 RED
 *   R5e  the route answers 403 instead of 404                       → 2 RED
 *   R5f  `scopeToCallerAccess` bypassed ONLY when a cursor was
 *        supplied — the reviewer's needle, which passed 85/85       → 1 RED
 *   R5g  `advancedTo` no longer initialised to `rawCursor`, so a
 *        deadline-cut RESUMED pass loses the operator's place       → 1 RED
 *   R5h  the SESSION_SECRET probe collapsed, so an unconfigured
 *        deployment is told its token was "altered, truncated"      → 1 RED
 *   R5i  `scopeToCallerAccess` neutered outright (round-2 B2a,
 *        re-proved on this tree so R5f's needle site is known live) → 12 RED
 *
 * R5f is the one worth reading twice. The shipped filter was ALREADY correct
 * and unconditional; the suite simply could not see it, because every fixture
 * that resumes puts the CALLER'S OWN rows on page 2 (`crowdedPage()` resumes
 * onto `['id-b1']`, ours; the `describe('the cursor')` fixture is `id-1..id-5`,
 * all ours). The one page on which the filter could stop running silently was
 * the one page no spec ever put a foreign row on — the same blind spot NEW1
 * had, one page further along.
 *
 * ── 2026-08-21 ROUND 6 — the pre-resolve's INPUT SHAPES. Round 5 added the
 *    `workspaceId` pre-resolve and proved it for exactly ONE request shape,
 *    `{workspaceId}` alone: `scopedSweep` hard-coded every other input to its
 *    default, so a gate conditioned on any other input was invisible. This is
 *    round 4's B2 rediscovered on round 5's own fix — R5f forced cursor
 *    coverage onto `scopeToCallerAccess`, and the same treatment was never
 *    extended to the pre-resolve that landed beside it.
 *
 * Measured BEFORE this round, on the round-5 tree, baseline 72 + 29 = 101
 * green. Each needle byte-exact, unique, sha256 asserted MOVED on apply and
 * RETURNED on restore, each run at 101 executed:
 *
 *   M3  `… && rawCursor === undefined`                    → 0 RED SURVIVED
 *   M2  `… && opts.itemTypes?.length !== 1`               → 0 RED SURVIVED
 *   M4  `… && (opts.limit === undefined || limit < 500)`  → 0 RED SURVIVED
 *   M6  `… && opts.loadItems !== undefined`               → 0 RED SURVIVED
 *   M1  the refusal `throw` deleted outright              → 4 RED caught
 *   M5  `… && opts.dryRun`                                → 1 RED caught
 *
 * M1 and M5 are the load-bearing pair in that table: the specs DID assert the
 * outcome, and the `dryRun` axis WAS covered. The gap was never the assertions,
 * only which inputs reached them.
 *
 * M6 is the worst of the four survivors and is this round's own find rather
 * than the reviewer's. A gate keyed to `opts.loadItems` runs in the SUITE —
 * every spec in that block injects the seam — and never on the live route,
 * which injects neither seam. The module docblock already claimed that property
 * in as many words ("a test seam must not be a way around a boundary") and
 * nothing could see it, because no spec ever took the un-injected path against
 * a workspace the caller cannot reach.
 *
 * AFTER, baseline 79 + 29 = 108 green (and 111 with the R7 specs below); every
 * one of the four now RED, each caught by exactly the spec written for it:
 *
 *   M3 → 1 RED  `… refused with a REAL nextCursor from a prior legitimate pass`
 *   M2 → 1 RED  `… refused with a single itemType`
 *   M4 → 1 RED  `… refused with limit at MAX_LIMIT`
 *   M6 → 1 RED  `… refused with NO injected loadItems or providers`
 *   M1 → 8 RED  (was 4 — the new refusals strengthen it)
 *   M5 → 1 RED  unchanged
 *
 * The cursor axis is the one that mattered most, and the fixture obtains its
 * token THE HONEST WAY: a legitimate tenant-wide pass over the caller's own
 * rows, then re-aimed at a foreign `workspaceId`. No forgery and no key access
 * — the route hands a cursor back on request, which is why it is the only axis
 * reachable without guessing.
 *
 * ── 2026-08-21 ROUND 6, R7 — the cursor's `tid` binding accepted a case its
 *    docblock said it refused. `(parsed.tid ?? null) !== (session.claims.tid ??
 *    null)` compares `null` to `null` and ACCEPTS, so a cursor minted by a
 *    tid-less caller unseals for a different tid-less caller. The comment
 *    claimed #3824's shape (`callerTid && wsDoc.tid && equal`), which rejects
 *    both-absent. Measured on the round-5 tree:
 *
 *      {"noTidB_unsealedTo":"id-p2","noTidB_refusal":null,
 *       "tidBearingCaller_refusal":"SweepCursorError"}
 *
 * The BEHAVIOUR is kept and the COMMENT was corrected, not the reverse —
 * tightening would refuse every resume for a tid-less caller (a documented,
 * supported state this file already pins twice) and would tell them the token
 * came from "a different Entra tenant", which is not what happened. Three
 * specs now pin the choice:
 *
 *   T1  tightened to `typeof parsed.tid === 'string' && …`  → 1 RED
 *   T2  the tid comparison dropped (`if (false)`)           → 3 RED
 *
 * The earlier set, RE-PROVED after the paging restructure — which moved the
 * access filter from a page-filter to a per-row decision and could have blinded
 * them:
 *
 *   B2a `scopeToCallerAccess` deleted                 → 9 RED
 *   B2b `callerTid: session.claims.tid` → `undefined` → 1 RED
 *   B2c classification runs BEFORE the row is dropped → 6 RED
 *   B3  `record?.seeded === true` → `record`          → 2 RED
 *   Bc  fetch `limit` instead of `limit + 1`          → 6 RED
 *   B5a route: `!== false` → `=== true`               → 4 RED
 *
 * Previously measured on the same suite and unchanged by this revision:
 *   B4a/B4b `persisted` asserted-not-measured / dropped; B5b route stops
 *   threading the session; B5c `withTenantAdmin` → `withSession`; the six the
 *   original commit claimed (engine verdict on `has-content`, the short-circuit
 *   before the engine, one item's throw aborting the sweep, a hand-listed
 *   `sweepableItemTypes`, dry-run calling `repairOne`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// A fake COSMOS, not a stub.
//
// `persistAutoBindPatch`, `loadSweepItems` and `resolveWorkspaceAccessByOid`
// all reach this module. The previous revision mocked `itemsContainer` to a
// bare `vi.fn()`, which `vi.resetAllMocks()` then emptied — so every live-mode
// test ran with the provenance write FAILING silently (`persistAutoBindPatch`
// swallows its own throw and returns false). The convergence property the route
// documents is a property of what the NEXT pass re-reads from Cosmos, so a
// harness where nothing is ever written cannot observe it, and the one test
// that claimed to was re-using the same in-memory array across both passes.
//
// `docStore` is therefore a real (in-memory) document store with working
// point-read + replace, and `wsStore` holds workspace docs so the REAL
// `resolveWorkspaceAccessByOid` runs — mocking the resolver would test the mock
// and reproduce exactly the blind spot #2703 filed.
// ---------------------------------------------------------------------------
interface WsDoc { id: string; tenantId: string; tid?: string; name: string }
/** Workspace docs, keyed by id. `tenantId` is the OWNER's oid (the partition). */
const wsStore = new Map<string, WsDoc>();
/** Item docs, keyed `${workspaceId}::${id}` — the PERSISTED estate. */
const docStore = new Map<string, WorkspaceItem>();

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function itemsFake() {
  return {
    item: (id: string, pk: string) => ({
      read: async () => ({ resource: docStore.get(`${pk}::${id}`) }),
      replace: async (doc: WorkspaceItem) => {
        docStore.set(`${pk}::${doc.id}`, clone(doc));
        return { resource: doc };
      },
    }),
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  };
}

function workspacesFake() {
  return {
    // Owner fast-path: a point read on (id, oid) only hits for the OWNER.
    item: (id: string, pk: string) => ({
      read: async () => {
        const d = wsStore.get(id);
        return { resource: d && d.tenantId === pk ? d : undefined };
      },
    }),
    // `readWorkspaceById` — cross-partition lookup by id.
    items: {
      query: (spec: { parameters?: Array<{ name: string; value: unknown }> }) => ({
        fetchAll: async () => {
          const id = spec?.parameters?.find((p) => p.name === '@id')?.value as string;
          const d = wsStore.get(id);
          return { resources: d ? [d] : [] };
        },
      }),
    },
  };
}

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(),
  workspacesContainer: async () => workspacesFake(),
  workspaceRolesContainer: async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } }),
  featurePermissionsContainer: async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } }),
}));
// No ACL grant by default — the caller reaches `ws-1` through the OWNER
// fast-path, so the shared-access path is off unless a test arms it.
vi.mock('@/lib/azure/workspace-roles-client', () => ({ resolveEffectiveRole: vi.fn() }));

import { sweepAutoBind, sweepableItemTypes, unsealSweepCursor, SweepCursorError, SweepScopeError, type SweepRow } from '@/lib/azure/auto-bind-sweep';
import { readAutoBindRecord, type AutoBindProvider } from '@/lib/azure/auto-bind';
import { AUTO_BIND_PROVIDERS } from '@/lib/azure/auto-bind-providers';
import { authoredContent } from '@/lib/azure/auto-bind-seed';
import type { WorkspaceItem } from '@/lib/types/workspace';
import type { SessionPayload } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { resolveEffectiveRole } from '@/lib/azure/workspace-roles-client';

/** The caller every sweep in this file runs as. */
const CALLER_OID = 'oid-sweep-caller';
const CALLER_TID = 'tid-alpha';
/** A DIFFERENT Entra tenant — the boundary tests' only changed variable. */
const FOREIGN_TID = 'tid-beta';
const SESSION = { claims: { oid: CALLER_OID, tid: CALLER_TID }, exp: 4_102_444_800 } as SessionPayload;

// The resume cursor is SEALED with `encryptAtRest`, which derives its key from
// SESSION_SECRET. Set here rather than mocking `@/lib/auth/session`, because a
// mocked `encryptAtRest` (the sibling token-store specs use `enc:${s}`) would
// make every seal assertion below a test of the mock — and the property under
// test is precisely that the token is UNREADABLE, which a reversible fake
// cannot demonstrate. Real AES-256-GCM, real tag, real tamper rejection.
//
// Not a credential: it is a per-run test key for an in-memory value that never
// leaves the process.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'auto-bind-sweep-spec-key';

/** Unseal with the REAL implementation — a hand-rolled decoder here would pin
 * the decoder, not the seal. */
const unseal = (token: string | undefined, session: SessionPayload = SESSION) => {
  expect(token).toBeDefined();
  return unsealSweepCursor(token!, session);
};

/**
 * Corrupt a sealed token so the GCM tag MUST reject it.
 *
 * Flips a bit inside the authentication tag of the DECODED bytes, rather than
 * editing the base64url TEXT — because editing the text does not reliably
 * corrupt anything. base64url packs 3 bytes into 4 characters, so when the byte
 * length is 2 (mod 3) the FINAL character carries only 4 significant bits and
 * its low 2 bits are pure padding: flipping it can leave the decoded bytes
 * byte-identical, in which case the "tampered" token unseals perfectly and the
 * spec passes having tested nothing.
 *
 * Not hypothetical — measured during the round-5 mutation proof, where it made
 * a spec fail ~6% of runs for a reason unrelated to the code under test. For a
 * 65-byte token (37-byte plaintext -> 87 chars) FOUR of the 64 possible final
 * characters make a last-character flip a no-op; for a 66-byte one (88 chars,
 * the shape the round-2 spec happens to produce) ZERO do. So the older spec was
 * correct only by the coincidence that its fixture id is one character longer,
 * and would have become a 1-in-16 flake the moment anyone renamed it. Both use
 * this helper now.
 *
 * Byte 20 is inside the 16-byte tag (iv 0..11, tag 12..27), so every call is a
 * genuine corruption of a byte the tag check must notice.
 */
const tamper = (token: string): string => {
  const raw = Buffer.from(token, 'base64url');
  raw[20] ^= 0xff;
  return raw.toString('base64url');
};


// ---------------------------------------------------------------------------
// A fake control plane that stores an object's CONTENT, not just its name —
// the same shape as `auto-bind-seed.test.ts`, because the same distinction is
// load-bearing here: the #3549 objects EXISTED, it was their contents that were
// missing, so a fake that tracked only existence could not see the bug.
//
// Extra counters over the sibling harness: `preflightCalls` / `probeCalls`, so
// "costs ZERO control-plane calls" can be asserted as a measurement rather than
// asserted about `isEmpty` alone.
// ---------------------------------------------------------------------------
class ContentPlane {
  objects = new Map<string, { activities: unknown[] }>();
  createCalls: string[] = [];
  seedCalls: string[] = [];
  emptyProbes: string[] = [];
  preflightCalls = 0;
  probeCalls: string[] = [];

  reset() {
    this.objects.clear();
    this.createCalls = [];
    this.seedCalls = [];
    this.emptyProbes = [];
    this.preflightCalls = 0;
    this.probeCalls = [];
  }

  /** Total calls that would have crossed the network on a real estate. */
  get networkCalls() {
    return this.preflightCalls + this.probeCalls.length + this.emptyProbes.length
      + this.createCalls.length + this.seedCalls.length;
  }
}

const plane = new ContentPlane();

/** The bundle shape a content bundle stamps onto `state.content` at install. */
const BUNDLE_CONTENT = {
  kind: 'adf-pipeline',
  activities: [
    { name: 'BronzeToSilverDQ', type: 'DatabricksNotebook' },
    { name: 'GoldAggregation', type: 'DatabricksNotebook', dependsOn: ['BronzeToSilverDQ'] },
    { name: 'OptimizeGold', type: 'DatabricksNotebook', dependsOn: ['GoldAggregation'] },
  ],
};

/** A provider shaped exactly like the real pipeline ones. */
function seedingProvider(over: Partial<AutoBindProvider> = {}): AutoBindProvider {
  return {
    provider: 'fake-pipeline',
    itemTypes: ['fake-item'],
    backingNameFor: (ctx) => ({ name: ctx.displayName.replace(/[^A-Za-z0-9-]+/g, '-'), sanitized: false }),
    preflight: async () => {
      plane.preflightCalls += 1;
      return { ok: true, coords: { factoryName: 'adf-test' } };
    },
    probe: async (name) => {
      plane.probeCalls.push(name);
      return plane.objects.has(name);
    },
    create: async (name) => {
      plane.createCalls.push(name);
      plane.objects.set(name, { activities: [] });
    },
    seedFromContent: async (name, _coords, ctx) => {
      plane.seedCalls.push(name);
      const content = authoredContent<{ activities?: unknown[] }>(ctx, ['adf-pipeline', 'synapse-pipeline']);
      if (!content?.activities?.length) return { seeded: false };
      plane.objects.set(name, { activities: content.activities });
      return { seeded: true, detail: `${content.activities.length} activities` };
    },
    isEmpty: async (name) => {
      plane.emptyProbes.push(name);
      return (plane.objects.get(name)?.activities.length ?? 0) === 0;
    },
    stateKeys: (name) => ({ pipelineName: name }),
    existingBinding: (ctx) => (typeof ctx.state.pipelineName === 'string' ? ctx.state.pipelineName : null),
    ...over,
  };
}

function item(o: {
  displayName: string;
  id?: string;
  itemType?: string;
  workspaceId?: string;
  state?: Record<string, unknown>;
}): WorkspaceItem {
  return {
    id: o.id ?? `id-${o.displayName}`,
    workspaceId: o.workspaceId ?? 'ws-1',
    itemType: o.itemType ?? 'fake-item',
    displayName: o.displayName,
    createdBy: 'tester@example.com',
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    ...(o.state ? { state: o.state } : {}),
  };
}

/** The exact state a GATED bundle install leaves behind: content, no binding. */
function gatedInstallState() {
  return { sourceApp: 'app-azure-realtime-analytics', content: BUNDLE_CONTENT };
}

/**
 * Put these items in the fake Cosmos as PERSISTED documents (deep-cloned, so
 * the in-memory objects a sweep mutates are not the same objects the store
 * holds — that distinction is the whole point of the convergence test), and
 * give any unseen workspace a doc the caller OWNS.
 */
function register(items: readonly WorkspaceItem[]) {
  for (const it of items) {
    if (!wsStore.has(it.workspaceId)) {
      wsStore.set(it.workspaceId, { id: it.workspaceId, tenantId: CALLER_OID, tid: CALLER_TID, name: it.workspaceId });
    }
    docStore.set(`${it.workspaceId}::${it.id}`, clone(it));
  }
}

/** Every doc in the fake store, as FRESH objects — what a later pass re-reads. */
const reread = async (): Promise<WorkspaceItem[]> => [...docStore.values()].map(clone);

/**
 * A workspace the CALLER owns, with no items in it.
 *
 * Needed wherever a spec supplies `workspaceId` without registering items:
 * a caller-chosen scope is resolved through `resolveWorkspaceAccessByOid`
 * BEFORE the query, so an id that is in no store resolves to null and the sweep
 * refuses it — which is the point of that check, and would silently turn an
 * unrelated spec into an assertion about the refusal path.
 */
const ourWorkspace = (id: string) =>
  wsStore.set(id, { id, tenantId: CALLER_OID, tid: CALLER_TID, name: id });

/** Run the sweep over a fixed item list, bypassing the Cosmos ENUMERATION. */
function sweep(items: WorkspaceItem[], o: Partial<Parameters<typeof sweepAutoBind>[0]> = {}) {
  register(items);
  return sweepAutoBind({
    dryRun: true,
    session: SESSION,
    providers: [seedingProvider()],
    loadItems: async () => items,
    ...o,
  });
}

const only = (rows: SweepRow[]): SweepRow => {
  expect(rows).toHaveLength(1);
  return rows[0];
};

beforeEach(() => {
  plane.reset();
  vi.resetAllMocks();
  wsStore.clear();
  docStore.clear();
  // The default workspace every `item()` lands in, OWNED by the caller — so the
  // access resolver takes its owner fast-path and the 26 pre-existing specs are
  // unaffected by the boundary while still passing through it.
  wsStore.set('ws-1', { id: 'ws-1', tenantId: CALLER_OID, tid: CALLER_TID, name: 'Ours' });
  vi.mocked(itemsContainer).mockImplementation(async () => itemsFake() as never);
});

// ===========================================================================
// THE CROSS-TENANT BOUNDARY (#2703 applied to a cross-partition scan)
//
// The sweep's default scope — no `workspaceId` — is the only shape that can
// reach a backlog, and it is a cross-partition query over a container that
// holds EVERY tenant's items. Nothing in the query can scope it: `items` is
// partitioned by `workspaceId` and the owning tenant is recorded on the
// WORKSPACE doc. So the boundary has to be a per-row filter, and these specs
// are what make its absence visible — the previous revision referenced the
// boundary zero times and every one of the other 26 specs stayed green.
//
// The REAL `resolveWorkspaceAccessByOid` runs (only Cosmos and the session are
// faked): mocking the resolver would test the mock, which is precisely the
// blind spot #2703 was filed about.
//
// DISCRIMINATION. The admin-open bypass is deliberately ON for these
// (`LOOM_TENANT_ADMIN_OID` = the caller), because that is the live shape — this
// route is admin-gated. With the bypass on, the tid comparison is the ONLY
// thing standing between the caller and every workspace in the container, and
// the include/exclude pair below differs in exactly one field: `tid`.
// ===========================================================================
describe('a workspace in another Entra tenant is out of scope', () => {
  const FOREIGN_WS = 'ws-theirs';
  const OTHER_OWNER = 'oid-someone-else';
  let priorAdminOid: string | undefined;

  /** Register the foreign workspace doc; `tid` is the variable under test. */
  const theirWorkspace = (tid: string) =>
    wsStore.set(FOREIGN_WS, { id: FOREIGN_WS, tenantId: OTHER_OWNER, tid, name: 'Theirs' });

  /** No backing object exists — so a live sweep WOULD create and seed one. */
  const theirItem = () =>
    item({ displayName: 'Theirs-ETL', id: 'id-theirs', workspaceId: FOREIGN_WS, state: gatedInstallState() });

  beforeEach(() => {
    priorAdminOid = process.env.LOOM_TENANT_ADMIN_OID;
    process.env.LOOM_TENANT_ADMIN_OID = CALLER_OID;
  });
  afterEach(() => {
    if (priorAdminOid === undefined) delete process.env.LOOM_TENANT_ADMIN_OID;
    else process.env.LOOM_TENANT_ADMIN_OID = priorAdminOid;
  });

  it('is excluded from the DRY-RUN rows, and not even probed', async () => {
    theirWorkspace(FOREIGN_TID);

    const result = await sweep([theirItem()]);

    expect(result.rows).toEqual([]);
    expect(result.scanned).toBe(0);
    // Counted, never silently dropped — `scanned` must not read as "all of it".
    expect(result.excludedByAccess).toBe(1);
    // The filter runs BEFORE classification, so the row costs zero reads.
    expect(plane.networkCalls).toBe(0);
  });

  it('is excluded from the LIVE mutation path — nothing created, seeded or stamped', async () => {
    theirWorkspace(FOREIGN_TID);

    const result = await sweep([theirItem()], { dryRun: false });

    expect(result.rows).toEqual([]);
    expect(result.excludedByAccess).toBe(1);
    // The concrete harm: a live sweep over an unbound item CREATES the ADF
    // object and writes the item's authored activities into it.
    expect(plane.createCalls).toEqual([]);
    expect(plane.seedCalls).toEqual([]);
    // …and stamps provenance on their Cosmos document.
    expect(readAutoBindRecord(docStore.get(`${FOREIGN_WS}::id-theirs`)!.state)).toBeNull();
  });

  it('leaks no identifier for it — the response carries a COUNT and nothing else', async () => {
    theirWorkspace(FOREIGN_TID);

    const body = JSON.stringify(await sweep([theirItem()]));

    expect(body).not.toContain('Theirs-ETL');
    expect(body).not.toContain('id-theirs');
    expect(body).not.toContain(FOREIGN_WS);
  });

  // -------------------------------------------------------------------------
  // …AND THE SAME, WHEN THE PAGE TRUNCATES (#3808 review round 2)
  //
  // The spec above passed for a reason that had nothing to do with the property
  // it claims. Its fixture is ONE item, so `page.length > limit` is never true,
  // so `truncated` is false, so `nextCursor` is never emitted — the only field
  // that ever carried a foreign identifier. It read as proof of a property it
  // did not cover.
  //
  // The leak it missed: `advancedTo = d.item.id` correctly advances past rows
  // the access filter dropped (that is what closes crowding-out and must stay),
  // and the raw id was then returned VERBATIM. Measured on this exact fixture,
  // pre-fix:
  //
  //   {"dryRun":true,"scanned":0,"excludedByAccess":2,"excludedByWriteAccess":0,
  //    "byDisposition":{},"rows":[],"truncated":true,"truncatedBy":"limit",
  //    "nextCursor":"id-a2"}
  //
  // `id-a2` lives in `ws-theirs`, tid `tid-beta`. At `limit:1` that is a
  // walkable oracle over every item id in the container, ordered by `c.id`.
  // -------------------------------------------------------------------------
  const FOREIGN_IDENTIFIERS = ['id-a1', 'id-a2', FOREIGN_WS, 'Theirs-ETL'];

  /** Assert a serialized result names NO foreign identifier. Returns the body. */
  const expectNoForeignIdentifier = (result: unknown): string => {
    const body = JSON.stringify(result);
    for (const needle of FOREIGN_IDENTIFIERS) expect(body).not.toContain(needle);
    return body;
  };

  /** A page of two foreign rows ahead of one of the caller's own. */
  const crowdedPage = () => {
    const theirs = [1, 2].map((n) =>
      item({ displayName: `Theirs-ETL-${n}`, id: `id-a${n}`, workspaceId: FOREIGN_WS, state: gatedInstallState() }));
    const ours = item({ displayName: 'Ours', id: 'id-b1', state: gatedInstallState() });
    const all = [...theirs, ours];
    register([ours]);
    return async (o: { limit: number; cursor?: string }) =>
      [...all].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .filter((i) => (o.cursor ? i.id > o.cursor : true))
        .slice(0, o.limit).map(clone);
  };

  it('leaks no identifier on a TRUNCATED, fully-foreign page either — the cursor is sealed', async () => {
    theirWorkspace(FOREIGN_TID);
    const loadItems = crowdedPage();

    const p1 = await sweepAutoBind({
      dryRun: true, session: SESSION, providers: [seedingProvider()], limit: 2, loadItems,
    });

    // The page MUST have truncated, or this asserts nothing — which is exactly
    // how the single-item spec above escaped the defect for a whole round.
    expect(p1.truncated).toBe(true);
    expect(p1.truncatedBy).toBe('limit');
    expect(p1.nextCursor).toBeDefined();
    expect(p1.rows).toEqual([]);
    expect(p1.excludedByAccess).toBe(2);

    expectNoForeignIdentifier(p1);

    // The OTHER half of the disjoint pair: the position is still carried, so
    // this cannot be satisfied by dropping the cursor.
    expect(await unseal(p1.nextCursor)).toBe('id-a2');
  });

  it('and that scan is CAPABLE of failing — the pre-fix body trips it', () => {
    // Verbatim, the body measured on the unsealed tree with the fixture above.
    // Without this control `expectNoForeignIdentifier` could be vacuous and the
    // spec above would read as proof of a property it never tested — the same
    // failure the truncation gap already produced once.
    const preFix = {
      dryRun: true, scanned: 0, excludedByAccess: 2, excludedByWriteAccess: 0,
      byDisposition: {}, rows: [], truncated: true, truncatedBy: 'limit', nextCursor: 'id-a2',
    };

    expect(() => expectNoForeignIdentifier(preFix)).toThrow();
  });

  it('the sealed cursor still advances the scan — pass 2 reaches the caller\'s own row', async () => {
    // The crowding-out closure is the REASON the cursor advances past dropped
    // rows, and sealing must not have cost it. Without this, "seal it" could be
    // satisfied by a token that resumes nowhere.
    theirWorkspace(FOREIGN_TID);
    const loadItems = crowdedPage();

    const p1 = await sweepAutoBind({
      dryRun: true, session: SESSION, providers: [seedingProvider()], limit: 2, loadItems,
    });
    const p2 = await sweepAutoBind({
      dryRun: true, session: SESSION, providers: [seedingProvider()], limit: 2, loadItems, cursor: p1.nextCursor,
    });

    expect(p2.rows.map((r) => r.itemId)).toEqual(['id-b1']);
    expect(p2.truncated).toBe(false);
  });

  it('a TAMPERED cursor is refused — not silently restarted from the beginning', async () => {
    theirWorkspace(FOREIGN_TID);
    const loadItems = crowdedPage();
    const p1 = await sweepAutoBind({
      dryRun: true, session: SESSION, providers: [seedingProvider()], limit: 2, loadItems,
    });

    // Corrupt a byte inside the GCM tag — the tag check must catch it. NOT a
    // last-character edit: see {@link tamper} for why that silently no-ops.
    const tampered = tamper(p1.nextCursor!);

    const calls: unknown[] = [];
    await expect(sweepAutoBind({
      dryRun: true, session: SESSION, providers: [seedingProvider()], limit: 2,
      loadItems: async (o) => { calls.push(o); return loadItems(o); },
      cursor: tampered,
    })).rejects.toThrow(SweepCursorError);

    // FAIL CLOSED. The tempting degradation — treat it as absent — would run an
    // unfiltered, cursor-less query and silently re-scan (in live mode,
    // re-write) the whole estate. Nothing was queried at all.
    expect(calls).toEqual([]);
  });

  it('and the TAMPER itself is real every time — the control on the control', async () => {
    // The spec above is only as good as its corruption, and the obvious
    // corruption is not good: editing the last base64url character leaves the
    // decoded bytes UNCHANGED whenever the byte length is 2 (mod 3), because
    // that character's low bits are padding. Measured during the round-5
    // mutation proof — 4 of the 64 possible final characters, ~6% of runs, a
    // token that unseals perfectly and a spec that passes having tested nothing.
    //
    // The IV is random per seal, so this is a fresh dice roll on every run and
    // could not be pinned by a single example. 200 freshly-sealed tokens is.
    theirWorkspace(FOREIGN_TID);
    const loadItems = crowdedPage();

    for (let i = 0; i < 200; i += 1) {
      const p = await sweepAutoBind({
        dryRun: true, session: SESSION, providers: [seedingProvider()], limit: 2, loadItems,
      });
      const token = p.nextCursor!;
      const bad = tamper(token);
      // The property that actually failed: different TEXT is not enough.
      expect(Buffer.from(bad, 'base64url').equals(Buffer.from(token, 'base64url'))).toBe(false);
      await expect(unsealSweepCursor(bad, SESSION)).rejects.toThrow(SweepCursorError);
    }
  });

  it('a cursor minted in ANOTHER tenant is refused, though it decrypts perfectly', async () => {
    // The key is estate-wide, so a valid token from another tenant's admin
    // decrypts; the `tid` sealed INSIDE the envelope is what refuses it.
    theirWorkspace(FOREIGN_TID);
    const loadItems = crowdedPage();
    const foreignSession = { claims: { oid: 'oid-other-admin', tid: FOREIGN_TID }, exp: 4_102_444_800 } as SessionPayload;

    const theirPass = await sweepAutoBind({
      dryRun: true, session: foreignSession, providers: [seedingProvider()], limit: 2, loadItems,
    });
    expect(theirPass.nextCursor).toBeDefined();
    // It is genuinely well-formed — for its OWN tenant.
    expect(await unseal(theirPass.nextCursor, foreignSession)).toBe('id-a2');

    await expect(sweepAutoBind({
      dryRun: true, session: SESSION, providers: [seedingProvider()], limit: 2, loadItems,
      cursor: theirPass.nextCursor,
    })).rejects.toThrow(/different Entra tenant/);
  });

  // -------------------------------------------------------------------------
  // THE BOTH-ABSENT tid CASE — ACCEPTED, and pinned so it cannot drift (R7)
  //
  // The docblock above `unsealSweepCursor` used to claim this was #3824's shape
  // (`callerTid && wsDoc.tid && equal`), which REFUSES both-absent. It is not:
  // `(parsed.tid ?? null) !== (session.claims.tid ?? null)` compares `null` to
  // `null` and accepts. Measured, on the round-5 tree:
  //
  //   {"noTidB_unsealedTo":"id-p2","noTidB_refusal":null,
  //    "tidBearingCaller_refusal":"SweepCursorError"}
  //
  // The behaviour is KEPT and the comment was corrected to match, not the other
  // way round. Tightening would refuse every resume for a tid-less caller — a
  // documented, supported state two specs above already pin — and would tell
  // them the cursor came from "a different Entra tenant", which is not what
  // happened. The full reasoning is in the docblock; what these three specs do
  // is make the choice explicit so a later "hardening" has to argue with a
  // named test rather than silently break page 2 for that caller class.
  //
  // The two refusal controls are what keep the first from being a claim that
  // the binding does nothing at all.
  // -------------------------------------------------------------------------

  /** A session with no `tid` claim: pre-rel-T11, or a PAT without `createdByTid`. */
  const noTid = (oid: string) => ({ claims: { oid }, exp: 4_102_444_800 }) as SessionPayload;

  /** Mint a real, truncated pass's cursor as `session`. */
  const cursorAs = async (session: SessionPayload): Promise<string> => {
    const p = await sweepAutoBind({
      dryRun: true, session, providers: [seedingProvider()], limit: 2, loadItems: crowdedPage(),
    });
    expect(p.truncated).toBe(true);
    expect(p.nextCursor).toBeDefined();
    return p.nextCursor!;
  };

  it('minted by a tid-LESS caller is ACCEPTED by another tid-less caller — deliberate, not a match', async () => {
    theirWorkspace(FOREIGN_TID);
    const token = await cursorAs(noTid('oid-no-tid-a'));

    // Different oid, different notional tenant, no tid on either side.
    expect(await unsealSweepCursor(token, noTid('oid-no-tid-b'))).toBe('id-a2');
  });

  it('but a tid-BEARING caller refuses that same tid-less cursor — control', async () => {
    theirWorkspace(FOREIGN_TID);
    const token = await cursorAs(noTid('oid-no-tid-a'));

    await expect(unsealSweepCursor(token, SESSION)).rejects.toThrow(SweepCursorError);
  });

  it('and a tid-less caller refuses a tid-BEARING cursor — the other direction', async () => {
    theirWorkspace(FOREIGN_TID);
    const token = await cursorAs(SESSION);

    await expect(unsealSweepCursor(token, noTid('oid-no-tid-a'))).rejects.toThrow(SweepCursorError);
  });

  it('the token is OPAQUE — the raw id is not recoverable without the key', async () => {
    theirWorkspace(FOREIGN_TID);
    const loadItems = crowdedPage();
    const p1 = await sweepAutoBind({
      dryRun: true, session: SESSION, providers: [seedingProvider()], limit: 2, loadItems,
    });

    const token = p1.nextCursor!;
    // Not the id, and not a trivially reversible encoding of it — the two
    // shapes a "sealed" cursor most plausibly regresses to.
    expect(token).not.toContain('id-a2');
    expect(Buffer.from(token, 'base64url').toString('utf-8')).not.toContain('id-a2');
    expect(Buffer.from(token, 'base64').toString('utf-8')).not.toContain('id-a2');
  });

  it('but the SAME row IS swept when that workspace is in the caller\'s tenant', async () => {
    // Byte-identical to the exclusion cases except for this one field. Without
    // this control the specs above would also pass on a sweep that returns
    // nothing at all, or one whose provider never matched.
    theirWorkspace(CALLER_TID);

    const result = await sweep([theirItem()], { dryRun: false });

    expect(result.rows.map((r) => r.disposition)).toEqual(['created']);
    expect(result.excludedByAccess).toBe(0);
    expect(plane.createCalls).toEqual(['Theirs-ETL']);
    expect(plane.objects.get('Theirs-ETL')!.activities).toHaveLength(3);
  });

  it('a mixed page reports only the caller\'s rows and counts the rest', async () => {
    theirWorkspace(FOREIGN_TID);
    plane.objects.set('Ours-ETL', { activities: [] });

    const result = await sweep([
      theirItem(),
      item({ displayName: 'Ours-ETL', state: gatedInstallState() }),
      theirItem(),
    ]);

    expect(result.rows.map((r) => r.workspaceId)).toEqual(['ws-1']);
    expect(result.scanned).toBe(1);
    expect(result.excludedByAccess).toBe(2);
    // One resolve per DISTINCT workspace, not per row — the cache is what keeps
    // a 200-row page from costing 200 workspace lookups.
    expect(only(result.rows).disposition).toBe('would-repair');
  });

  // -------------------------------------------------------------------------
  // #3824 — THE RESOLVER'S OWN REFUSAL, NOT MASKED BY THIS FILTER
  //
  // The sweep's filter is now the SECOND check, not the only one. #3824 tightened
  // the tenant-admin bypass (step 6) from "no contradiction" to a POSITIVE tid
  // match, so a workspace whose `tid` is absent — a documented, supported state
  // for any doc created before rel-T11 — is refused by the resolver itself.
  //
  // What is pinned here is AGREEMENT: the sweep must inherit that refusal rather
  // than paper over it. Before #3824 this fixture was swept and mutated, because
  // step 4's boundary is truthiness-guarded on both sides and decided nothing
  // when either tid was missing. The two controls below are one field apart from
  // it, which is what stops this passing on a sweep that returns nothing at all.
  // -------------------------------------------------------------------------
  it('a workspace with NO recorded tid is refused by the resolver, and the sweep agrees', async () => {
    wsStore.set(FOREIGN_WS, { id: FOREIGN_WS, tenantId: OTHER_OWNER, name: 'Legacy, unstamped' });

    const result = await sweep([theirItem()], { dryRun: false });

    expect(result.rows).toEqual([]);
    expect(result.excludedByAccess).toBe(1);
    // Not a write-access refusal — the caller has NO access here at all.
    expect(result.excludedByWriteAccess).toBe(0);
    expect(plane.createCalls).toEqual([]);
    expect(plane.seedCalls).toEqual([]);
    expect(readAutoBindRecord(docStore.get(`${FOREIGN_WS}::id-theirs`)!.state)).toBeNull();
  });

  it('and a caller with no tid CLAIM is refused on the same workspace', async () => {
    // The other documented absence: a session minted before rel-T11, or a PAT
    // issued without `createdByTid`. The workspace here IS stamped.
    theirWorkspace(CALLER_TID);
    const tidless = { claims: { oid: CALLER_OID }, exp: 4_102_444_800 } as SessionPayload;

    const result = await sweepAutoBind({
      dryRun: false,
      session: tidless,
      providers: [seedingProvider()],
      loadItems: async () => [theirItem()],
    });

    expect(result.rows).toEqual([]);
    expect(result.excludedByAccess).toBe(1);
    expect(plane.createCalls).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // …AND ON A CURSOR-RESUMED PAGE (#3808 review round 5)
  //
  // The shipped filter is UNCONDITIONAL — `scopeToCallerAccess` runs on every
  // page — and the suite could not see it. A mutation that bypasses the filter
  // ONLY when a cursor was supplied passed all 85 specs, because every fixture
  // that resumes puts the CALLER'S OWN rows on page 2: `crowdedPage()` above
  // resumes onto `['id-b1']` (ours), and the whole `describe('the cursor')`
  // fixture is `id-1..id-5`, all ours. So the ONE page where the filter could
  // silently stop running was the one page no spec ever put a foreign row on.
  //
  // Same failure shape as the truncation gap round 2 found: a property the
  // suite read as covered, over an input it never constructed.
  //
  // Ordering is the whole fixture. The caller owns `id-1`/`id-2`; `id-3` lives
  // in `ws-theirs`; `limit:2` therefore lands the foreign row strictly AFTER
  // the cursor, which is the only arrangement that can discriminate.
  // -------------------------------------------------------------------------

  /**
   * Three ordered rows, the third owned by `lateWorkspaceId`, paged the way
   * Cosmos pages: `ORDER BY c.id`, resumed strictly after `cursor`.
   */
  const pageWithLateRow = (lateWorkspaceId: string) => {
    const ours = [1, 2].map((n) =>
      item({ displayName: `Ours-${n}`, id: `id-${n}`, state: gatedInstallState() }));
    const late = item({
      displayName: 'Late-ETL', id: 'id-3', workspaceId: lateWorkspaceId, state: gatedInstallState(),
    });
    register(ours);
    const all = [...ours, late];
    return async (o: { limit: number; cursor?: string }) =>
      [...all].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .filter((i) => (o.cursor ? i.id > o.cursor : true))
        .slice(0, o.limit).map(clone);
  };

  /** Sweep page 1, assert it landed on the caller's own rows, return the cursor. */
  const firstPage = async (loadItems: ReturnType<typeof pageWithLateRow>) => {
    const p1 = await sweepAutoBind({
      dryRun: true, session: SESSION, providers: [seedingProvider()], limit: 2, loadItems,
    });
    // If this ever stops holding, the fixture no longer puts the foreign row on
    // page 2 and the spec below is asserting about page 1 all over again.
    expect(p1.rows.map((r) => r.itemId)).toEqual(['id-1', 'id-2']);
    expect(p1.truncated).toBe(true);
    expect(p1.nextCursor).toBeDefined();
    return p1.nextCursor;
  };

  it('is excluded on a CURSOR-RESUMED page too, not only on the first one', async () => {
    theirWorkspace(FOREIGN_TID);
    const loadItems = pageWithLateRow(FOREIGN_WS);

    const p2 = await sweepAutoBind({
      dryRun: true, session: SESSION, providers: [seedingProvider()], limit: 2, loadItems,
      cursor: await firstPage(loadItems),
    });

    expect(p2.rows).toEqual([]);
    // The load-bearing count: it proves the row WAS on page 2 and WAS dropped.
    // Without it, `rows: []` would also be satisfied by a cursor that resumed
    // onto nothing at all.
    expect(p2.excludedByAccess).toBe(1);
    // …and page 2 names it no more than page 1 would have.
    const body = JSON.stringify(p2);
    expect(body).not.toContain('id-3');
    expect(body).not.toContain('Late-ETL');
    expect(body).not.toContain(FOREIGN_WS);
  });

  it('but the same LATE row IS swept when it is in the caller\'s tenant — the control', async () => {
    // One field apart from the spec above (`ws-1` instead of `ws-theirs`), so
    // neither can be satisfied by a resumed pass that returns nothing at all.
    const loadItems = pageWithLateRow('ws-1');

    const p2 = await sweepAutoBind({
      dryRun: true, session: SESSION, providers: [seedingProvider()], limit: 2, loadItems,
      cursor: await firstPage(loadItems),
    });

    expect(p2.rows.map((r) => r.itemId)).toEqual(['id-3']);
    expect(p2.excludedByAccess).toBe(0);
  });
});

// ===========================================================================
// A CALLER-CHOSEN SCOPE IS RESOLVED BEFORE THE QUERY (#3808 review round 5)
//
// `excludedByAccess` is documented as safe because it is a COUNT and naming the
// rows would be the disclosure the filter prevents. That reasoning holds only
// while the count is INCIDENTAL to whatever page happened to load. When the
// CALLER picks the scope it is not incidental — it is an answer to a question
// the caller asked.
//
// Measured on the pre-fix tree, as a tenant admin in `tid-alpha`, against a
// workspace in `tid-beta` holding five items:
//
//   POST { workspaceId: 'ws-theirs', itemTypes: ['fake-item'] }
//   -> { "dryRun":true, "scanned":0, "excludedByAccess":5, "rows":[] }
//   …and `loadItems` was called with workspaceId='ws-theirs', so the foreign id
//   reached the Cosmos predicate.
//
// `excludedByAccess` is then a cardinality oracle: it says the workspace EXISTS
// and how many sweepable items it holds, narrowable per `itemTypes`. Same class
// as #3823/#3824, and the repo already states the answer verbatim in
// `lib/api/route-toolkit.ts:113` — 404 not 403, "so an id can't be probed for
// existence across tenants".
//
// So a supplied `workspaceId` is resolved through the SAME resolver first, and
// a refusal is a not-found with no count at all. The tenant-wide sweep (no
// `workspaceId`) is deliberately unchanged — see the last spec in this block.
// ===========================================================================
describe('a caller-chosen workspaceId', () => {
  const FOREIGN_WS = 'ws-theirs';
  const OTHER_OWNER = 'oid-someone-else';
  let priorAdminOid: string | undefined;

  beforeEach(() => {
    // The live shape: this route is admin-gated. With the bypass ON, the tid
    // comparison is the only thing between the caller and every workspace in
    // the container — which is exactly the position the oracle exploited.
    priorAdminOid = process.env.LOOM_TENANT_ADMIN_OID;
    process.env.LOOM_TENANT_ADMIN_OID = CALLER_OID;
  });
  afterEach(() => {
    if (priorAdminOid === undefined) delete process.env.LOOM_TENANT_ADMIN_OID;
    else process.env.LOOM_TENANT_ADMIN_OID = priorAdminOid;
  });

  /** `n` items in `ws`, so a surviving count would be a cardinality answer. */
  const itemsIn = (ws: string, n: number) =>
    Array.from({ length: n }, (_, i) =>
      item({ displayName: `Theirs-${i + 1}`, id: `id-t${i + 1}`, workspaceId: ws, state: gatedInstallState() }));

  /**
   * The inputs a caller controls ALONGSIDE `workspaceId`.
   *
   * Round 5 hard-coded every one of these to its default, so the pre-resolve
   * was proven for exactly ONE request shape and a gate conditioned on any
   * other input was invisible. See {@link EXTRA_SHAPES}.
   */
  interface ScopedShape {
    dryRun?: boolean;
    cursor?: string;
    itemTypes?: readonly string[];
    limit?: number;
  }

  /**
   * Run a scoped sweep, recording whether the loader was reached at all.
   *
   * Returns a SETTLED-result promise, not a raw one. The rejection handler is
   * attached in the SAME synchronous turn the promise is created, because a
   * rejected promise that sits unhandled across a macrotask boundary surfaces
   * as an unhandled-rejection failure — a flake with nothing to do with the
   * property under test. The specs below hold two of these open at once, which
   * is exactly the shape that makes that reachable.
   *
   * `cursor` / `itemTypes` / `limit` are passed straight through as `undefined`
   * when unset, which is what the module already tests for (`opts.cursor ===
   * undefined`, `opts.itemTypes?.length`, `opts.limit ?? DEFAULT_LIMIT`) — so an
   * unset axis is indistinguishable from an omitted key.
   */
  const scopedSweep = (workspaceId: string, rows: WorkspaceItem[], shape: ScopedShape = {}) => {
    const asked: Array<{ workspaceId?: string }> = [];
    const settled = sweepAutoBind({
      dryRun: shape.dryRun ?? true,
      session: SESSION,
      providers: [seedingProvider()],
      workspaceId,
      cursor: shape.cursor,
      itemTypes: shape.itemTypes,
      limit: shape.limit,
      loadItems: async (o) => { asked.push(o); return rows; },
    }).then(
      (result) => ({ result, error: null as Error | null }),
      (error: Error) => ({ result: null as Awaited<ReturnType<typeof sweepAutoBind>> | null, error }),
    );
    return { settled, asked };
  };

  it('in ANOTHER tenant is refused outright — no count, and the query is never issued', async () => {
    wsStore.set(FOREIGN_WS, { id: FOREIGN_WS, tenantId: OTHER_OWNER, tid: FOREIGN_TID, name: 'Theirs' });
    const { settled, asked } = scopedSweep(FOREIGN_WS, itemsIn(FOREIGN_WS, 5));

    const { result, error } = await settled;

    expect(error).toBeInstanceOf(SweepScopeError);
    // No envelope at all — not a zero count, which would still be an answer
    // about a scope the caller chose.
    expect(result).toBeNull();
    // THE WHOLE FINDING. Pre-fix this resolved to
    // `{excludedByAccess: 5, rows: []}` and `asked` held the foreign id.
    expect(asked).toEqual([]);
  });

  it('carries NO cardinality — 5 items and 1 item are indistinguishable', async () => {
    // The oracle was never the rows; it was the COUNT. Two foreign workspaces
    // differing only in how much they hold must produce the same answer.
    wsStore.set('ws-big', { id: 'ws-big', tenantId: OTHER_OWNER, tid: FOREIGN_TID, name: 'Big' });
    wsStore.set('ws-small', { id: 'ws-small', tenantId: OTHER_OWNER, tid: FOREIGN_TID, name: 'Small' });

    const big = await scopedSweep('ws-big', itemsIn('ws-big', 5)).settled;
    const small = await scopedSweep('ws-small', itemsIn('ws-small', 1)).settled;

    expect(big.error).toBeInstanceOf(SweepScopeError);
    expect(small.error!.message).toBe(big.error!.message);
    // …and neither message names a count, an id, or a display name.
    expect(big.error!.message).not.toMatch(/\b[15]\b/);
    expect(big.error!.message).not.toContain('ws-big');
    expect(big.error!.message).not.toContain('Theirs-1');
  });

  it('that does not EXIST is indistinguishable from one that does — 404, not 403', async () => {
    // `route-toolkit.ts:113` states the rule the repo already follows: answer
    // not-found so an id cannot be probed for existence across tenants. If the
    // two answers ever diverge, the probe is back.
    wsStore.set(FOREIGN_WS, { id: FOREIGN_WS, tenantId: OTHER_OWNER, tid: FOREIGN_TID, name: 'Theirs' });

    const exists = await scopedSweep(FOREIGN_WS, itemsIn(FOREIGN_WS, 3)).settled;
    const absent = await scopedSweep('ws-never-created', []).settled;

    expect(exists.error).toBeInstanceOf(SweepScopeError);
    expect(absent.error).toBeInstanceOf(SweepScopeError);
    expect(absent.error!.message).toBe(exists.error!.message);
  });

  it('is refused on the LIVE path too, before anything can be written', async () => {
    wsStore.set(FOREIGN_WS, { id: FOREIGN_WS, tenantId: OTHER_OWNER, tid: FOREIGN_TID, name: 'Theirs' });
    const { settled, asked } = scopedSweep(FOREIGN_WS, itemsIn(FOREIGN_WS, 2), { dryRun: false });

    const { error } = await settled;

    expect(error).toBeInstanceOf(SweepScopeError);
    expect(asked).toEqual([]);
    expect(plane.createCalls).toEqual([]);
    expect(plane.seedCalls).toEqual([]);
  });

  it('in the caller\'s OWN tenant sweeps normally — the control', async () => {
    // One field apart from the refusals above. Without it every spec here would
    // also pass on a sweep that refuses every `workspaceId` ever supplied,
    // which would break the scope filter rather than secure it.
    wsStore.set(FOREIGN_WS, { id: FOREIGN_WS, tenantId: OTHER_OWNER, tid: CALLER_TID, name: 'Theirs, same tenant' });
    const rows = itemsIn(FOREIGN_WS, 2);
    register(rows);

    const { settled, asked } = scopedSweep(FOREIGN_WS, rows);
    const { result, error } = await settled;

    expect(error).toBeNull();
    expect(result!.rows.map((r) => r.itemId)).toEqual(['id-t1', 'id-t2']);
    expect(result!.excludedByAccess).toBe(0);
    // The scope really did reach the query — the refusal is about ACCESS, not
    // about dropping the parameter.
    expect(asked).toEqual([{ itemTypes: ['fake-item'], workspaceId: FOREIGN_WS, limit: 201, cursor: undefined }]);
  });

  // -------------------------------------------------------------------------
  // …AND FOR EVERY OTHER REQUEST SHAPE (#3808 review round 6)
  //
  // Everything above supplies `workspaceId` with each OTHER input left at its
  // default, so the pre-resolve was proven for exactly one shape:
  // `{workspaceId}` alone. Three gates conditioned on a different input each
  // SURVIVED the whole suite — byte-exact, unique, all at 101 executed:
  //
  //   `… && rawCursor === undefined`                         → 0 RED
  //   `… && opts.itemTypes?.length !== 1`                    → 0 RED
  //   `… && (opts.limit === undefined || opts.limit < 500)`  → 0 RED
  //
  // …and each reopens round 4's defect verbatim. Under the first:
  //
  //   {"threw":null,"excludedByAccess":5,"scanned":0,
  //    "foreignIdReachedQuery":["ws-probe-theirs"]}
  //
  // The outcome assertions were never the gap — deleting the throw outright is
  // caught 4 RED. The gap was which INPUTS reached them. This is round 4's own
  // finding rediscovered on round 5's fix: R5f forced cursor coverage onto
  // `scopeToCallerAccess`, and the same treatment was never extended to the
  // pre-resolve that landed beside it.
  //
  // `dryRun` is deliberately NOT in this table: it has its own dedicated spec
  // above (which additionally asserts nothing was created or seeded), and a
  // gate flipped to `&& opts.dryRun` is already caught 1 RED by it.
  // -------------------------------------------------------------------------

  /** `MAX_LIMIT` in the module under test. Not exported, so restated here. */
  const MAX_LIMIT = 1000;

  /**
   * A REAL `nextCursor`, obtained THE HONEST WAY: a legitimate tenant-wide pass
   * over the caller's OWN rows. No forgery, no key access, nothing the route
   * would refuse — `POST {limit:1}` hands one back to anybody allowed to sweep
   * at all.
   *
   * That is what makes the cursor the one axis here an attacker reaches without
   * guessing, and why it is the one that must not be skipped: the token is
   * opaque, so it cannot be MADE — but it is issued on request, so it does not
   * need to be. Mint it, then re-aim it at a foreign `workspaceId`.
   */
  const honestCursor = async (): Promise<string> => {
    const mine = [1, 2].map((n) =>
      item({ displayName: `Mine-${n}`, id: `id-m${n}`, state: gatedInstallState() }));
    register(mine);
    const p1 = await sweepAutoBind({
      dryRun: true, session: SESSION, providers: [seedingProvider()], limit: 1,
      loadItems: async (o) =>
        mine.filter((i) => (o.cursor ? i.id > o.cursor : true)).slice(0, o.limit).map(clone),
    });
    // If this ever stops truncating there is no cursor at all, and the shapes
    // below would silently degrade to the bare one — the exact blind spot this
    // block exists to close.
    expect(p1.truncated).toBe(true);
    expect(p1.nextCursor).toBeDefined();
    return p1.nextCursor!;
  };

  /** One entry per input a caller controls besides `workspaceId` itself. */
  const EXTRA_SHAPES: Array<{ label: string; shape: () => Promise<ScopedShape> }> = [
    {
      label: 'a REAL nextCursor from a prior legitimate pass',
      shape: async () => ({ cursor: await honestCursor() }),
    },
    { label: 'a single itemType', shape: async () => ({ itemTypes: ['fake-item'] }) },
    { label: 'limit at MAX_LIMIT', shape: async () => ({ limit: MAX_LIMIT }) },
  ];

  for (const { label, shape } of EXTRA_SHAPES) {
    it(`in ANOTHER tenant is refused with ${label} too — no count, no query`, async () => {
      wsStore.set(FOREIGN_WS, { id: FOREIGN_WS, tenantId: OTHER_OWNER, tid: FOREIGN_TID, name: 'Theirs' });
      const extra = await shape();

      const { settled, asked } = scopedSweep(FOREIGN_WS, itemsIn(FOREIGN_WS, 5), extra);
      const { result, error } = await settled;

      expect(error).toBeInstanceOf(SweepScopeError);
      // No envelope at all — not a zero count, which would still be an answer
      // about a scope the caller chose.
      expect(result).toBeNull();
      // THE WHOLE FINDING, on this shape: the foreign id never reaches Cosmos.
      expect(asked).toEqual([]);
    });

    it(`in the caller's OWN tenant still sweeps with ${label} — the control`, async () => {
      // Two-sided, so neither direction can be satisfied by a gate that simply
      // refuses (or admits) every request carrying this input. Without it, a
      // mutation widening the gate to `|| opts.cursor !== undefined` would break
      // every legitimate RESUMED sweep and no spec would notice.
      wsStore.set(FOREIGN_WS, { id: FOREIGN_WS, tenantId: OTHER_OWNER, tid: CALLER_TID, name: 'Theirs, same tenant' });
      const rows = itemsIn(FOREIGN_WS, 2);
      register(rows);
      const extra = await shape();

      const { settled, asked } = scopedSweep(FOREIGN_WS, rows, extra);
      const { result, error } = await settled;

      expect(error).toBeNull();
      expect(result!.rows.map((r) => r.itemId)).toEqual(['id-t1', 'id-t2']);
      expect(result!.excludedByAccess).toBe(0);
      expect(asked.map((o) => o.workspaceId)).toEqual([FOREIGN_WS]);
    });
  }

  it('is refused with NO injected loadItems or providers — the SEAM is not what is guarded', async () => {
    // The axis the three above do not reach, and the worst of the set: every
    // spec in this block injects `loadItems`, so a gate keyed to
    // `opts.loadItems !== undefined` runs in the suite and NEVER on the live
    // route, which injects neither seam. Measured on the round-5 tree, at 101
    // executed: `… && opts.loadItems !== undefined` → 0 RED, SURVIVED.
    //
    // The module's own docblock already claims this property in as many words
    // — "a test seam must not be a way around a boundary" — and nothing could
    // see it, because no spec ever took the un-injected path with a workspace
    // the caller cannot reach. `providers` is dropped for the same reason.
    wsStore.set(FOREIGN_WS, { id: FOREIGN_WS, tenantId: OTHER_OWNER, tid: FOREIGN_TID, name: 'Theirs' });
    // A zero-population registry would make `itemTypes` empty, the sweep would
    // early-return before any query, and this spec would pass without testing
    // anything. Assert the population rather than assume it.
    expect(sweepableItemTypes().length).toBeGreaterThan(0);

    const queries: unknown[] = [];
    vi.mocked(itemsContainer).mockResolvedValue({
      items: {
        query: (s: unknown) => { queries.push(s); return { fetchAll: async () => ({ resources: [] }) }; },
      },
    } as never);

    await expect(sweepAutoBind({ dryRun: true, session: SESSION, workspaceId: FOREIGN_WS }))
      .rejects.toBeInstanceOf(SweepScopeError);

    // The real enumeration was never issued, so the foreign id never reached
    // the Cosmos predicate on the path that has no seam to blame.
    expect(queries).toEqual([]);
  });

  it('and a workspace the caller OWNS is unaffected', async () => {
    // `ws-1` resolves `via:'owner'` on the resolver's fast path, so the common
    // single-operator case never touches the ACL or the admin bypass at all.
    plane.objects.set('Ours-ETL', { activities: [] });

    const result = await sweep([item({ displayName: 'Ours-ETL', state: gatedInstallState() })], { workspaceId: 'ws-1' });

    expect(only(result.rows).disposition).toBe('would-repair');
  });

  it('the TENANT-WIDE sweep still reports its incidental count — no workspaceId, no refusal', async () => {
    // The count is only an oracle when the CALLER picked the scope. With no
    // `workspaceId` it is incidental to whatever page loaded, it is the honest
    // signal that `scanned` is not "everything the query found", and it stays.
    // A fix that also silenced this one would have broken the disclosure the
    // access filter exists to make.
    wsStore.set(FOREIGN_WS, { id: FOREIGN_WS, tenantId: OTHER_OWNER, tid: FOREIGN_TID, name: 'Theirs' });

    const result = await sweepAutoBind({
      dryRun: true, session: SESSION, providers: [seedingProvider()],
      loadItems: async () => itemsIn(FOREIGN_WS, 3),
    });

    expect(result.rows).toEqual([]);
    expect(result.excludedByAccess).toBe(3);
  });
});

// ===========================================================================
// A LIVE PASS REQUIRES `canWrite`, NOT MERELY ACCESS
//
// `resolveWorkspaceAccessByOid` returns a ROLE, and `workspace-access.ts` says
// so in as many words: "Callers that gate mutations MUST check `canWrite`."
// `item-crud.ts` does (`if (!opts.allowReadRoles && !access.canWrite) return
// null`). The sweep did not — it asked only `!== null` — and a sweep is a
// mutation path: it creates ADF objects, writes authored content into them, and
// stamps provenance onto the item document.
//
// THE REACHABLE CASE IS A DOWNGRADING GRANT. Step 5 of the resolver (the ACL
// lookup) returns BEFORE the tenant-admin bypass in step 6, so a tenant admin
// who has been deliberately given `Viewer` on someone's workspace resolves
// `role:'Viewer', via:'acl', canWrite:false` — and the sweep wrote through it
// anyway. Measured on the pre-fix tree, with the admin bypass ON:
//   resolvedAccess={"role":"Viewer","via":"acl","canWrite":false}
//   -> rows=[{"disposition":"created"}] createCalls=["SharedPipe"]
//      seedCalls=["SharedPipe"] cosmosDocStamped={"via":"created","seeded":true}
//
// Dry-run deliberately keeps the READ bar: reporting what a writer would repair
// is a read, and a Viewer is entitled to it. So the pair below is the whole
// finding — same fixture, same role, opposite verdict, decided by `dryRun`.
// ===========================================================================
describe('a read-only role cannot start a write', () => {
  const SHARED_WS = 'ws-shared';
  const OTHER_OWNER = 'oid-someone-else';
  let priorAdminOid: string | undefined;

  /** Someone else's workspace, in the CALLER's tenant, shared with the caller. */
  const sharedWorkspace = () =>
    wsStore.set(SHARED_WS, { id: SHARED_WS, tenantId: OTHER_OWNER, tid: CALLER_TID, name: 'Shared' });

  /** No backing object exists, so a live sweep WOULD create and seed one. */
  const sharedItem = () =>
    item({ displayName: 'SharedPipe', id: 'id-shared', workspaceId: SHARED_WS, state: gatedInstallState() });

  beforeEach(() => {
    // The live shape: this route is admin-gated, so the admin bypass is ON.
    // With it on, `canWrite` is the ONLY thing between a read-only grant and a
    // bulk rewrite of someone else's ADF objects.
    priorAdminOid = process.env.LOOM_TENANT_ADMIN_OID;
    process.env.LOOM_TENANT_ADMIN_OID = CALLER_OID;
    sharedWorkspace();
  });
  afterEach(() => {
    if (priorAdminOid === undefined) delete process.env.LOOM_TENANT_ADMIN_OID;
    else process.env.LOOM_TENANT_ADMIN_OID = priorAdminOid;
  });

  it('DRY-RUN still REPORTS a Viewer-ACL workspace — the report is a read', async () => {
    vi.mocked(resolveEffectiveRole).mockResolvedValue('Viewer');

    const result = await sweep([sharedItem()]);

    expect(only(result.rows).disposition).toBe('missing');
    expect(only(result.rows).workspaceId).toBe(SHARED_WS);
    expect(result.excludedByAccess).toBe(0);
    expect(result.excludedByWriteAccess).toBe(0);
  });

  it('LIVE REFUSES the same row — nothing created, seeded or stamped', async () => {
    vi.mocked(resolveEffectiveRole).mockResolvedValue('Viewer');

    const result = await sweep([sharedItem()], { dryRun: false });

    expect(result.rows).toEqual([]);
    expect(result.scanned).toBe(0);
    // Counted as a WRITE refusal, not a tenant drop — different cause, different
    // fix, and folding them together would make this look like a boundary hit.
    expect(result.excludedByWriteAccess).toBe(1);
    expect(result.excludedByAccess).toBe(0);
    // The concrete harm the pre-fix tree caused, item by item.
    expect(plane.createCalls).toEqual([]);
    expect(plane.seedCalls).toEqual([]);
    expect(plane.objects.has('SharedPipe')).toBe(false);
    expect(readAutoBindRecord(docStore.get(`${SHARED_WS}::id-shared`)!.state)).toBeNull();
  });

  it('but a WRITE role on the very same workspace IS mutated — the control', async () => {
    // One field apart from the refusal above. Without it, both specs would also
    // pass on a sweep that refuses everything, or one whose provider never
    // matched — the failure mode a boundary test cannot afford.
    vi.mocked(resolveEffectiveRole).mockResolvedValue('Member');

    const result = await sweep([sharedItem()], { dryRun: false });

    expect(result.rows.map((r) => r.disposition)).toEqual(['created']);
    expect(result.excludedByWriteAccess).toBe(0);
    expect(plane.createCalls).toEqual(['SharedPipe']);
    expect(plane.objects.get('SharedPipe')!.activities).toHaveLength(3);
    expect(readAutoBindRecord(docStore.get(`${SHARED_WS}::id-shared`)!.state)?.seeded).toBe(true);
  });

  it('`Contributor` is read-only in this role model, and is refused too', async () => {
    // WRITE_ROLES is Owner/Admin/Member — `Contributor` maps to a READ role here
    // despite the Azure-RBAC-sounding name, so it is worth pinning explicitly
    // rather than leaving to the reader's assumption.
    vi.mocked(resolveEffectiveRole).mockResolvedValue('Contributor');

    const result = await sweep([sharedItem()], { dryRun: false });

    expect(result.excludedByWriteAccess).toBe(1);
    expect(plane.createCalls).toEqual([]);
  });

  it('an OWNED workspace is unaffected — the owner fast-path writes as before', async () => {
    // Guards against a fix that gates the common case too: `ws-1` is owned by
    // the caller, resolves `via:'owner'` with canWrite:true, and never consults
    // the ACL at all.
    plane.objects.set('Ours-ETL', { activities: [] });

    const result = await sweep([item({ displayName: 'Ours-ETL', state: gatedInstallState() })], { dryRun: false });

    expect(only(result.rows).disposition).toBe('repaired');
    expect(result.excludedByWriteAccess).toBe(0);
  });
});


// ===========================================================================
// THE SAFETY CASE — the one that must never regress
// ===========================================================================
describe('an authored backing object is never touched', () => {
  const authored = [{ name: 'UserWrote', type: 'Copy' }];

  it('a LIVE sweep leaves a non-empty pipeline byte-identical', async () => {
    plane.objects.set('Prod-ETL', { activities: authored });

    const result = await sweep([item({ displayName: 'Prod-ETL', state: gatedInstallState() })], { dryRun: false });

    expect(only(result.rows).disposition).toBe('has-content');
    // The seed hook was never invoked, so bundle content cannot have overwritten
    // work the user (or a previous authoring run) put there.
    expect(plane.seedCalls).toEqual([]);
    expect(plane.objects.get('Prod-ETL')!.activities).toBe(authored);
  });

  it('a REFUSED repair is never reported as repaired', async () => {
    plane.objects.set('Prod-ETL', { activities: authored });

    const result = await sweep([item({ displayName: 'Prod-ETL', state: gatedInstallState() })], { dryRun: false });
    const r = only(result.rows);

    // `maybeRepairSeed` answers a refusal with `{seeded:true, detail:'backing
    // object already holds content'}` — right for the editor (it clears a stale
    // seedError), wrong for a report. Reading that back as `repaired` would
    // credit the sweep with a write it never made, and the count would be wrong
    // in the flattering direction.
    expect(r.disposition).not.toBe('repaired');
    expect(r.disposition).not.toBe('created');
    expect(result.byDisposition.repaired).toBeUndefined();
    expect(r.reason).toMatch(/already holds content/i);
  });

  it('a second pass over the same estate costs nothing', async () => {
    plane.objects.set('Prod-ETL', { activities: authored });
    const items = [item({ displayName: 'Prod-ETL', state: gatedInstallState() })];

    await sweep(items, { dryRun: false });
    // The engine stamped provenance on the in-memory item — that stamp is the
    // entire reason `has-content` rows are still handed to it.
    expect(readAutoBindRecord(items[0].state)?.seeded).toBe(true);

    plane.reset();
    plane.objects.set('Prod-ETL', { activities: authored });
    const second = await sweep(items, { dryRun: false });

    expect(only(second.rows).disposition).toBe('already-healthy');
    // Guard 1 returns before ANY network call. Without this, every later sweep
    // re-pays the isEmpty probe and the route's "each pass strictly cheapens the
    // next" claim is false.
    expect(plane.networkCalls).toBe(0);
  });
});

// ===========================================================================
// GUARD 1 — `already-healthy` is the ONE disposition that verifies nothing
//
// It returns before `preflight`, before `probe`, before `isEmpty`: the entire
// basis for calling an item healthy is the provenance record on its own state.
// So exactly what that guard accepts is load-bearing, and until these specs
// existed it was pinned by nothing — widening `record?.seeded === true` to
// `record` left all 26 other tests green while reclassifying #3549's ACTUAL
// population (an item bound at create time whose seed never finished, so the
// record exists and `seeded` is absent, over an empty ADF pipeline) from
// "repair this" to "healthy, don't look".
// ===========================================================================
describe('guard 1 accepts a SEEDED record, not merely a record', () => {
  /** #3549's population: bound (record present) but never seeded. */
  const boundUnseeded = () => item({
    displayName: 'Legacy-Bound',
    state: {
      ...gatedInstallState(),
      autoBind: { provider: 'fake-pipeline', backingName: 'Legacy-Bound', via: 'created' },
    },
  });

  it('a record WITHOUT `seeded` over an empty object is would-repair, not already-healthy', async () => {
    plane.objects.set('Legacy-Bound', { activities: [] });

    const r = only((await sweep([boundUnseeded()])).rows);

    expect(r.disposition).toBe('would-repair');
    expect(r.disposition).not.toBe('already-healthy');
    // It has to actually LOOK. `already-healthy` short-circuits every probe, so
    // the emptiness probe firing is what proves the guard did not swallow it.
    expect(plane.emptyProbes).toEqual(['Legacy-Bound']);
  });

  it('and a LIVE sweep repairs it', async () => {
    plane.objects.set('Legacy-Bound', { activities: [] });

    const r = only((await sweep([boundUnseeded()], { dryRun: false })).rows);

    expect(r.disposition).toBe('repaired');
    expect(plane.objects.get('Legacy-Bound')!.activities).toHaveLength(3);
  });

  it('while the SAME record WITH `seeded:true` is already-healthy at zero cost', async () => {
    // The discrimination control: one field apart from the fixture above. It is
    // what stops "would-repair" being the answer to everything.
    plane.objects.set('Legacy-Bound', { activities: [] });
    const seeded = item({
      displayName: 'Legacy-Bound',
      state: {
        ...gatedInstallState(),
        autoBind: { provider: 'fake-pipeline', backingName: 'Legacy-Bound', via: 'created', seeded: true },
      },
    });

    const r = only((await sweep([seeded])).rows);

    expect(r.disposition).toBe('already-healthy');
    expect(plane.networkCalls).toBe(0);
  });
});

// ===========================================================================
// CONVERGENCE IS A PROPERTY OF COSMOS, NOT OF THE IN-MEMORY ITEM
//
// The route's docblock justifies returning a partial result with "each pass
// strictly cheapens the next". The next pass is a different request in a
// different process: it re-reads the document. `autoBindOnOpen` merges the
// patch into the in-memory item ALWAYS and persists it only best-effort —
// `persistAutoBindPatch` catches its own failure and returns false, which the
// sweep used to discard. A suite that hands pass 2 the same array pass 1
// mutated therefore measures the merge and never the write.
// ===========================================================================
describe('the provenance write', () => {
  it('is reported as landed on a repaired row, and is in the STORE', async () => {
    plane.objects.set('Daily-Batch', { activities: [] });

    const r = only((await sweep(
      [item({ displayName: 'Daily-Batch', state: gatedInstallState() })],
      { dryRun: false },
    )).rows);

    expect(r.disposition).toBe('repaired');
    expect(r.persisted).toBe(true);
    // Not the in-memory item — the document a later pass will re-read.
    expect(readAutoBindRecord(docStore.get('ws-1::id-Daily-Batch')!.state)?.seeded).toBe(true);
  });

  it('is reported as landed on a REFUSED (has-content) row too — that stamp IS the cheapening', async () => {
    plane.objects.set('Prod-ETL', { activities: [{ name: 'UserWrote', type: 'Copy' }] });

    const r = only((await sweep(
      [item({ displayName: 'Prod-ETL', state: gatedInstallState() })],
      { dryRun: false },
    )).rows);

    expect(r.disposition).toBe('has-content');
    expect(r.persisted).toBe(true);
    expect(readAutoBindRecord(docStore.get('ws-1::id-Prod-ETL')!.state)?.seeded).toBe(true);
  });

  it('is reported as NOT landed when the write is swallowed', async () => {
    plane.objects.set('Ghost', { activities: [] });
    // Deliberately NOT registered in the store: `persistAutoBindPatch` reads the
    // document first, finds nothing, and returns false without throwing. Before
    // `persisted` was surfaced this row was indistinguishable from a converged
    // one — the sweep would report `repaired` on every pass, forever, with
    // nothing anywhere saying why the count never fell.
    const orphan = item({ displayName: 'Ghost', state: gatedInstallState() });

    const r = only((await sweepAutoBind({
      dryRun: false,
      session: SESSION,
      providers: [seedingProvider()],
      loadItems: async () => [orphan],
    })).rows);

    expect(r.disposition).toBe('repaired');
    expect(r.persisted).toBe(false);
    expect(docStore.has('ws-1::id-Ghost')).toBe(false);
  });

  it('makes a second pass that RE-READS Cosmos already-healthy at zero cost', async () => {
    plane.objects.set('Daily-Batch', { activities: [] });
    await sweep([item({ displayName: 'Daily-Batch', state: gatedInstallState() })], { dryRun: false });

    plane.reset();
    plane.objects.set('Daily-Batch', { activities: BUNDLE_CONTENT.activities });
    const second = await sweepAutoBind({
      dryRun: false,
      session: SESSION,
      providers: [seedingProvider()],
      // FRESH documents out of the fake Cosmos — not the objects pass 1 mutated.
      loadItems: reread,
    });

    expect(only(second.rows).disposition).toBe('already-healthy');
    expect(plane.networkCalls).toBe(0);
    expect(plane.seedCalls).toEqual([]);
  });

  it('is absent on a dry-run row — nothing was written, so there is nothing to report', async () => {
    plane.objects.set('Empty-One', { activities: [] });

    const r = only((await sweep([item({ displayName: 'Empty-One', state: gatedInstallState() })])).rows);

    expect(r.disposition).toBe('would-repair');
    expect(r.persisted).toBeUndefined();
    expect('persisted' in r).toBe(false);
  });
});

// ===========================================================================
// DRY-RUN WRITES NOTHING
// ===========================================================================
describe('dry-run', () => {
  it('creates nothing and seeds nothing, even for items that need both', async () => {
    plane.objects.set('Empty-One', { activities: [] });
    const items = [
      item({ displayName: 'Empty-One', state: gatedInstallState() }),
      item({ displayName: 'Absent-One', state: gatedInstallState() }),
    ];

    const result = await sweep(items);

    expect(result.dryRun).toBe(true);
    expect(result.rows.map((r) => r.disposition)).toEqual(['would-repair', 'missing']);
    expect(plane.createCalls).toEqual([]);
    expect(plane.seedCalls).toEqual([]);
    expect(plane.objects.get('Empty-One')!.activities).toEqual([]);
    expect(plane.objects.has('Absent-One')).toBe(false);
  });

  it('separates "empty with content to author" from "correctly empty"', async () => {
    plane.objects.set('Has-Content', { activities: [] });
    plane.objects.set('Blank-Item', { activities: [] });

    const result = await sweep([
      item({ displayName: 'Has-Content', state: gatedInstallState() }),
      item({ displayName: 'Blank-Item' }),
    ]);

    expect(result.rows[0].disposition).toBe('would-repair');
    // The picker-created item: empty backing object, nothing to author. #3796's
    // "stated reason" branch, not a defect to be counted against 36 → 0.
    expect(result.rows[1].disposition).toBe('no-authored-content');
    expect(result.rows[1].reason).toMatch(/CORRECT state/);
  });
});

// ===========================================================================
// LIVE MODE — the repair actually lands
// ===========================================================================
describe('live mode', () => {
  it('authors the item\'s real activities into an existing EMPTY object', async () => {
    plane.objects.set('Daily-Batch', { activities: [] });

    const result = await sweep(
      [item({ displayName: 'Daily-Batch', state: gatedInstallState() })],
      { dryRun: false },
    );
    const r = only(result.rows);

    expect(r.disposition).toBe('repaired');
    expect(r.backingName).toBe('Daily-Batch');
    // The reason is the ENGINE's own seedDetail, not a sentence of ours guessing
    // at what it did.
    expect(r.reason).toBe('3 activities');
    expect(plane.objects.get('Daily-Batch')!.activities).toHaveLength(3);
  });

  it('creates AND seeds a backing object that does not exist', async () => {
    const result = await sweep(
      [item({ displayName: 'Missing-One', state: gatedInstallState() })],
      { dryRun: false },
    );

    expect(only(result.rows).disposition).toBe('created');
    expect(plane.createCalls).toEqual(['Missing-One']);
    expect(plane.objects.get('Missing-One')!.activities).toHaveLength(3);
  });

  it('reports content of a kind this provider cannot author, rather than claiming a repair', async () => {
    plane.objects.set('Odd-Kind', { activities: [] });

    // Dry-run can only test SHAPE — the accepted kind list lives inside the
    // provider's own seedFromContent, and a second copy here would drift. So
    // dry-run says `would-repair` and only the live run knows better.
    const dry = await sweep([item({ displayName: 'Odd-Kind', state: { content: { kind: 'power-bi-report' } } })]);
    expect(only(dry.rows).disposition).toBe('would-repair');

    plane.reset();
    plane.objects.set('Odd-Kind', { activities: [] });
    const live = await sweep(
      [item({ displayName: 'Odd-Kind', state: { content: { kind: 'power-bi-report' } } })],
      { dryRun: false },
    );

    expect(only(live.rows).disposition).toBe('no-authored-content');
    expect(plane.objects.get('Odd-Kind')!.activities).toEqual([]);
  });

  it('surfaces a seed that FAILED instead of swallowing it', async () => {
    plane.objects.set('Boom', { activities: [] });
    const providers = [seedingProvider({
      seedFromContent: async () => { throw new Error('ADF returned 403 on pipeline write'); },
    })];

    const result = await sweep(
      [item({ displayName: 'Boom', state: gatedInstallState() })],
      { dryRun: false, providers },
    );
    const r = only(result.rows);

    expect(r.disposition).toBe('seed-failed');
    expect(r.reason).toContain('403');
  });
});

// ===========================================================================
// DRY-RUN AND LIVE AGREE ON EVERY NON-ACTIONABLE ROW
// ===========================================================================
describe('the two modes cannot drift', () => {
  it('agree on every disposition that needs no action', async () => {
    plane.objects.set('Full', { activities: [{ name: 'x' }] });
    plane.objects.set('Blank', { activities: [] });
    const items = () => [
      item({ displayName: 'Full', state: gatedInstallState() }),
      item({ displayName: 'Blank' }),
      item({ displayName: 'Alien', itemType: 'no-such-type' }),
      item({
        displayName: 'Healthy',
        state: { autoBind: { provider: 'fake-pipeline', backingName: 'Healthy', seeded: true } },
      }),
    ];

    const dry = await sweep(items());
    plane.emptyProbes = [];
    const live = await sweep(items(), { dryRun: false });

    // Both verdicts come from ONE function (`previewOne`), which is what makes
    // this hold by construction rather than by two lists being kept in step.
    expect(dry.rows.map((r) => r.disposition)).toEqual(['has-content', 'no-authored-content', 'unsupported', 'already-healthy']);
    expect(live.rows.map((r) => r.disposition)).toEqual(dry.rows.map((r) => r.disposition));
    expect(live.rows.map((r) => r.reason)).toEqual(dry.rows.map((r) => r.reason));
  });

  it('report an infrastructure gate identically and probe nothing', async () => {
    const providers = [seedingProvider({
      preflight: async () => {
        plane.preflightCalls += 1;
        return { ok: false, kind: 'unavailable', reason: 'LOOM_ADF_NAME is not set on this deployment.' };
      },
    })];
    const items = [item({ displayName: 'Gated', state: gatedInstallState() })];

    for (const dryRun of [true, false]) {
      plane.reset();
      const result = await sweep(items, { dryRun, providers });
      const r = only(result.rows);
      expect(r.disposition).toBe('unavailable');
      expect(r.reason).toContain('LOOM_ADF_NAME');
      expect(plane.probeCalls).toEqual([]);
    }
  });

  it('classify a transient preflight as retry, not as a permanent gate', async () => {
    const providers = [seedingProvider({
      preflight: async () => ({ ok: false, kind: 'retry', reason: 'ADF returned 429.' }),
    })];

    const result = await sweep([item({ displayName: 'Throttled' })], { providers });
    expect(only(result.rows).disposition).toBe('retry');
  });
});

// ===========================================================================
// COVERAGE STATED, NEVER IMPLIED
// ===========================================================================
describe('providers repair cannot reach', () => {
  it('names a provider with no isEmpty probe instead of skipping it silently', async () => {
    plane.objects.set('No-Probe', { activities: [] });
    const providers = [seedingProvider({ isEmpty: undefined })];

    const r = only((await sweep([item({ displayName: 'No-Probe', state: gatedInstallState() })], { providers })).rows);

    // eventstream / adx-database / lakehouse-adls land here on the real
    // registry. Counted and named — the alternative is a sweep that reports a
    // clean estate over item types it never evaluated.
    expect(r.disposition).toBe('no-empty-probe');
    expect(r.reason).toContain('#3694');
    expect(plane.emptyProbes).toEqual([]);
  });

  it('names an item type no provider claims', async () => {
    const r = only((await sweep([item({ displayName: 'Orphan', itemType: 'mirrored-database' })])).rows);
    expect(r.disposition).toBe('unsupported');
    expect(r.reason).toContain('mirrored-database');
    expect(r.provider).toBeNull();
  });
});

// ===========================================================================
// A PARTIAL SCAN IS NEVER REPORTED AS A COMPLETE ONE
// ===========================================================================
describe('truncation honesty', () => {
  it('an exactly-full page is not reported as a complete scan', async () => {
    const items = ['a', 'b', 'c'].map((n) => item({ displayName: n }));
    let asked = 0;

    const result = await sweepAutoBind({
      dryRun: true,
      session: SESSION,
      providers: [seedingProvider()],
      limit: 2,
      loadItems: async (o) => { asked = o.limit; return items; },
    });

    // Fetch limit+1: a page of exactly `limit` rows is otherwise
    // indistinguishable from an estate that happens to hold exactly that many.
    expect(asked).toBe(3);
    expect(result.scanned).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('limit');
  });

  it('a full page that fits is NOT flagged truncated', async () => {
    const result = await sweep([item({ displayName: 'a' }), item({ displayName: 'b' })], { limit: 2 });
    expect(result.scanned).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.truncatedBy).toBeUndefined();
  });

  it('stops on the wall-clock budget and says so', async () => {
    // [deadline base, item-1 check, item-2 check]
    const ticks = [0, 0, 9_999];
    let i = 0;

    const result = await sweep(
      [item({ displayName: 'a' }), item({ displayName: 'b' })],
      { deadlineMs: 500, now: () => ticks[Math.min(i++, ticks.length - 1)] },
    );

    expect(result.scanned).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('deadline');
  });

  it('clamps the row cap to the documented bounds', async () => {
    const asked: number[] = [];
    const run = (limit: number) => sweepAutoBind({
      dryRun: true,
      session: SESSION,
      providers: [seedingProvider()],
      limit,
      loadItems: async (o) => { asked.push(o.limit); return []; },
    });

    await run(5000);
    await run(0);
    expect(asked).toEqual([1001, 2]); // MAX_LIMIT + 1, then min 1 + 1
  });
});

// ===========================================================================
// RE-RUNNING ACTUALLY ADVANCES
//
// Both docblocks told the operator to re-run until `truncated` is false, and
// that instruction was FALSE. `loadSweepItems` had no `ORDER BY`, no resume
// predicate and nothing excluding already-swept items, so every pass re-read
// the same `TOP n` prefix. Measured on the pre-fix tree, 5 items at `limit:2`,
// three LIVE passes:
//
//   PASS1 items=["id-1","id-2"] dispositions=["created","created"]
//   PASS2 items=["id-1","id-2"] dispositions=["already-healthy","already-healthy"]
//   PASS3 items=["id-1","id-2"] dispositions=["already-healthy","already-healthy"]
//   NEVER_REACHED=["id-3","id-4","id-5"]
//
// Every pass really WAS cheaper than the last — which is exactly why the claim
// survived review the first time. Cheaper is not further. Any estate above
// MAX_LIMIT could never be swept whole.
// ===========================================================================
describe('the cursor', () => {
  /** A fake Cosmos page: ordered by id, resumed strictly after `cursor`. */
  const paged = (all: WorkspaceItem[]) =>
    async (o: { limit: number; cursor?: string }) =>
      [...all]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .filter((i) => (o.cursor ? i.id > o.cursor : true))
        .slice(0, o.limit)
        .map(clone);

  const five = () => [1, 2, 3, 4, 5].map((n) =>
    item({ displayName: `P${n}`, id: `id-${n}`, state: gatedInstallState() }));

  it('carries pass 2 onto the rows pass 1 could not reach', async () => {
    const items = five();
    register(items);
    const loadItems = paged(items);

    const p1 = await sweepAutoBind({ dryRun: true, session: SESSION, providers: [seedingProvider()], limit: 2, loadItems });
    expect(p1.rows.map((r) => r.itemId)).toEqual(['id-1', 'id-2']);
    expect(p1.truncated).toBe(true);
    expect(p1.truncatedBy).toBe('limit');
    // The token is opaque on the wire; what it ENCODES is still the last raw row.
    expect(await unseal(p1.nextCursor)).toBe('id-2');

    const p2 = await sweepAutoBind({
      dryRun: true, session: SESSION, providers: [seedingProvider()], limit: 2, loadItems, cursor: p1.nextCursor,
    });

    // THE ASSERTION THE WHOLE FINDING TURNS ON. Pre-fix this was id-1,id-2.
    expect(p2.rows.map((r) => r.itemId)).toEqual(['id-3', 'id-4']);
    expect(await unseal(p2.nextCursor)).toBe('id-4');
  });

  it('walks the WHOLE estate in bounded passes and then stops', async () => {
    const items = five();
    register(items);
    const loadItems = paged(items);

    const seen: string[] = [];
    let cursor: string | undefined;
    let passes = 0;
    for (;;) {
      const r = await sweepAutoBind({
        dryRun: false, session: SESSION, providers: [seedingProvider()], limit: 2, loadItems, cursor,
      });
      passes += 1;
      seen.push(...r.rows.map((x) => x.itemId));
      if (!r.truncated) break;
      cursor = r.nextCursor;
      if (passes > 10) throw new Error('the cursor did not converge');
    }

    expect(seen).toEqual(['id-1', 'id-2', 'id-3', 'id-4', 'id-5']);
    expect(passes).toBe(3); // 2 + 2 + 1, the last one not truncated
    // …and every one of them was actually repaired, not merely enumerated.
    expect(plane.createCalls.sort()).toEqual(['P1', 'P2', 'P3', 'P4', 'P5']);
  });

  it('advances past rows the ACCESS FILTER dropped, so a foreign page cannot pin it', async () => {
    // The interaction the old KNOWN LIMIT disclosed: the row cap applies to the
    // Cosmos page and the filter runs after it, so a caller's own items can be
    // crowded off page 1. Deriving the cursor from the RAW window (not from the
    // reported rows) is what closes it — a page belonging ENTIRELY to another
    // tenant still moves the scan forward instead of looping on itself.
    process.env.LOOM_TENANT_ADMIN_OID = CALLER_OID;
    try {
      wsStore.set('ws-theirs', { id: 'ws-theirs', tenantId: 'oid-other', tid: FOREIGN_TID, name: 'Theirs' });
      const theirs = [1, 2].map((n) =>
        item({ displayName: `T${n}`, id: `id-a${n}`, workspaceId: 'ws-theirs', state: gatedInstallState() }));
      const ours = item({ displayName: 'Ours', id: 'id-b1', state: gatedInstallState() });
      const all = [...theirs, ours];
      register([ours]);
      const loadItems = paged(all);

      const p1 = await sweepAutoBind({ dryRun: true, session: SESSION, providers: [seedingProvider()], limit: 2, loadItems });
      expect(p1.rows).toEqual([]);
      expect(p1.excludedByAccess).toBe(2);
      expect(p1.truncated).toBe(true);
      // Pre-cursor this was a dead end: nothing to resume from, so `id-b1` was
      // unreachable without scoping the sweep by workspaceId.
      expect(await unseal(p1.nextCursor)).toBe('id-a2');
      // …and `id-a2` is a FOREIGN id, which is why the wire form is sealed.
      // This pair is the disjoint control: the position must survive AND the
      // plaintext must not appear. Neither the pre-fix behaviour (raw id) nor a
      // "just drop the cursor" cop-out can satisfy both.
      expect(JSON.stringify(p1)).not.toContain('id-a2');

      const p2 = await sweepAutoBind({
        dryRun: true, session: SESSION, providers: [seedingProvider()], limit: 2, loadItems, cursor: p1.nextCursor,
      });

      expect(p2.rows.map((r) => r.itemId)).toEqual(['id-b1']);
      expect(p2.truncated).toBe(false);
    } finally {
      delete process.env.LOOM_TENANT_ADMIN_OID;
    }
  });

  it('resumes from the last row PROCESSED when the deadline cuts a pass short', async () => {
    const items = five();
    register(items);
    const loadItems = paged(items);
    // [deadline base, item-1 check, item-2 check]
    const ticks = [0, 0, 9_999];
    let i = 0;

    const p1 = await sweepAutoBind({
      dryRun: true, session: SESSION, providers: [seedingProvider()], limit: 4, loadItems,
      deadlineMs: 500, now: () => ticks[Math.min(i++, ticks.length - 1)],
    });

    expect(p1.truncatedBy).toBe('deadline');
    expect(p1.rows.map((r) => r.itemId)).toEqual(['id-1']);
    // NOT the end of the window (`id-4`) — the rows after the cut were never
    // looked at, and skipping them would lose them permanently. Sealing changed
    // the wire form and must NOT have changed which row that is.
    expect(await unseal(p1.nextCursor)).toBe('id-1');

    const p2 = await sweepAutoBind({
      dryRun: true, session: SESSION, providers: [seedingProvider()], limit: 4, loadItems, cursor: p1.nextCursor,
    });
    expect(p2.rows.map((r) => r.itemId)).toEqual(['id-2', 'id-3', 'id-4', 'id-5']);
  });

  it('omits nextCursor entirely on a complete pass', async () => {
    const result = await sweep([item({ displayName: 'a' }), item({ displayName: 'b' })], { limit: 2 });
    expect(result.truncated).toBe(false);
    expect(result.nextCursor).toBeUndefined();
    expect('nextCursor' in result).toBe(false);
  });

  it('re-seals the SAME position when a deadline cuts a RESUMED pass before any row', async () => {
    // #3808 review round 5 (N2). The docblock said `nextCursor` is "absent on a
    // deadline truncation that got through nothing at all". That is true only of
    // a FIRST pass: `advancedTo` is initialised to the unsealed cursor, so a
    // resumed pass re-seals its own position and hands it back. The behaviour is
    // right — losing it would strand the operator on a token they must remember
    // — and the sentence was wrong, so the sentence now describes THIS.
    const items = five();
    register(items);
    const loadItems = paged(items);

    const p1 = await sweepAutoBind({
      dryRun: true, session: SESSION, providers: [seedingProvider()], limit: 2, loadItems,
    });
    expect(await unseal(p1.nextCursor)).toBe('id-2');

    // [deadline base, first row check] — expired before any row is classified.
    const ticks = [0, 9_999];
    let i = 0;
    const p2 = await sweepAutoBind({
      dryRun: true, session: SESSION, providers: [seedingProvider()], limit: 2, loadItems,
      cursor: p1.nextCursor, deadlineMs: 500, now: () => ticks[Math.min(i++, ticks.length - 1)],
    });

    expect(p2.rows).toEqual([]);
    expect(p2.truncatedBy).toBe('deadline');
    // NOT absent. A pass that got through nothing still knows where it started,
    // and dropping that would make the next call a full re-scan of ground the
    // operator already covered.
    expect(p2.nextCursor).toBeDefined();
    expect(await unseal(p2.nextCursor)).toBe('id-2');
  });

  // -------------------------------------------------------------------------
  // THE REFUSAL MESSAGES MUST BE TRUE (deploy-integrity R7)
  //
  // `decryptAtRest` returns null for TWO causes, not one: a failed GCM tag, and
  // `getAtRestKey()` throwing because SESSION_SECRET is absent or empty (its
  // own `catch` swallows that into the same null). The single message named
  // only the first — "altered, truncated, or issued by a different deployment"
  // — asserting a cause the code never established. Unreachable through the
  // route today (`getSession` 401s first), but reachable for the ACA-Job caller
  // the docblock proposes (#3832), which has no session cookie to 401 on.
  // -------------------------------------------------------------------------
  const withoutSessionSecret = async (fn: () => Promise<void>) => {
    const prior = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    try { await fn(); } finally {
      if (prior === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = prior;
    }
  };

  it('says SESSION_SECRET is missing rather than blaming the token for it', async () => {
    await withoutSessionSecret(async () => {
      const err = await unsealSweepCursor('any-token-at-all', SESSION).then(() => null, (e: Error) => e);

      expect(err).toBeInstanceOf(SweepCursorError);
      expect(err!.message).toContain('SESSION_SECRET');
      // The false claim this replaces. Nothing about the token was established
      // — the key was never derivable, so it was never even compared.
      expect(err!.message).not.toContain('altered, truncated');
    });
  });

  it('and still blames the TOKEN when the secret IS configured — the control', async () => {
    // One variable apart. Without this the spec above would also pass on a
    // module that had collapsed both branches onto the SESSION_SECRET wording,
    // which would be the same R7 defect pointing the other way.
    const p1 = await sweepAutoBind({
      dryRun: true, session: SESSION, providers: [seedingProvider()], limit: 1,
      loadItems: async () => [item({ displayName: 'x', id: 'id-1' }), item({ displayName: 'y', id: 'id-2' })],
    });
    const token = p1.nextCursor!;
    const tampered = tamper(token);

    const err = await unsealSweepCursor(tampered, SESSION).then(() => null, (e: Error) => e);

    expect(err).toBeInstanceOf(SweepCursorError);
    expect(err!.message).toContain('altered, truncated');
    expect(err!.message).not.toContain('SESSION_SECRET');
  });

  it('is threaded into the Cosmos query as an EXCLUSIVE, parameterized predicate', async () => {
    let spec: { query: string; parameters: { name: string; value: unknown }[] } | undefined;
    vi.mocked(itemsContainer).mockResolvedValue({
      items: {
        query: (s: typeof spec) => { spec = s; return { fetchAll: async () => ({ resources: [] }) }; },
      },
    } as never);

    // The caller supplies the SEALED token; only the unsealed plaintext may
    // reach the predicate. Minted the way the sweep mints it — by running one
    // truncating pass — so this cannot pass against a hand-built envelope the
    // production code would reject.
    const minted = await sweepAutoBind({
      dryRun: true, session: SESSION, providers: [seedingProvider()], limit: 1,
      loadItems: async () => [item({ displayName: 'x', id: 'id-42' }), item({ displayName: 'y', id: 'id-43' })],
    });
    expect(await unseal(minted.nextCursor)).toBe('id-42');

    await sweepAutoBind({
      dryRun: true, session: SESSION, providers: [seedingProvider()], limit: 5, cursor: minted.nextCursor,
    });

    expect(spec!.query).toContain('c.id > @cursor');
    // Without a total order the predicate is meaningless — a TOP-n
    // cross-partition query may return any n rows that satisfy it.
    expect(spec!.query).toContain('ORDER BY c.id');
    // The RAW id, not the token: a sealed blob in the predicate would silently
    // match nothing and the sweep would report a clean estate it never scanned.
    expect(spec!.parameters).toContainEqual({ name: '@cursor', value: 'id-42' });
  });

  it('omits the resume predicate on the FIRST pass', async () => {
    let spec: { query: string; parameters: { name: string; value: unknown }[] } | undefined;
    vi.mocked(itemsContainer).mockResolvedValue({
      items: {
        query: (s: typeof spec) => { spec = s; return { fetchAll: async () => ({ resources: [] }) }; },
      },
    } as never);

    await sweepAutoBind({ dryRun: true, session: SESSION, providers: [seedingProvider()] });

    expect(spec!.query).not.toContain('@cursor');
    // The ORDER BY is unconditional — it is what makes pass 1's prefix stable
    // enough for pass 2's cursor to mean anything.
    expect(spec!.query).toContain('ORDER BY c.id');
    expect(spec!.parameters.map((p) => p.name)).toEqual(['@types', '@limit']);
  });
});

// ===========================================================================
// ONE BAD ITEM MUST NOT COST THE REST OF THE ESTATE
// ===========================================================================
describe('resilience', () => {
  it('one item that throws does not abort the sweep', async () => {
    plane.objects.set('Good', { activities: [] });
    const providers = [seedingProvider({
      probe: async (name) => {
        plane.probeCalls.push(name);
        if (name === 'Poison') throw new Error('ETIMEDOUT reading pipeline');
        return plane.objects.has(name);
      },
    })];

    const result = await sweep(
      [item({ displayName: 'Poison' }), item({ displayName: 'Good', state: gatedInstallState() })],
      { providers },
    );

    expect(result.rows[0].disposition).toBe('failed');
    expect(result.rows[0].reason).toContain('ETIMEDOUT');
    // The backlog is exactly the population most likely to throw, so aborting on
    // the first failure would make the sweep useless precisely where it matters.
    expect(result.rows[1].disposition).toBe('would-repair');
    expect(result.scanned).toBe(2);
  });

  it('tallies every disposition it emitted', async () => {
    plane.objects.set('Full', { activities: [{ name: 'x' }] });
    plane.objects.set('E1', { activities: [] });
    plane.objects.set('E2', { activities: [] });
    plane.objects.set('Blank', { activities: [] });

    const result = await sweep([
      item({ displayName: 'Full', state: gatedInstallState() }),
      item({ displayName: 'E1', state: gatedInstallState() }),
      item({ displayName: 'E2', state: gatedInstallState() }),
      item({ displayName: 'Blank' }),
    ]);

    expect(result.byDisposition).toEqual({ 'has-content': 1, 'would-repair': 2, 'no-authored-content': 1 });
    expect(Object.values(result.byDisposition).reduce((a, b) => a + b, 0)).toBe(result.scanned);
  });
});

// ===========================================================================
// SCOPE SELECTION
// ===========================================================================
describe('scope', () => {
  it('item types are DERIVED from the registry, never hand-listed', async () => {
    const derived = sweepableItemTypes();

    expect(derived.length).toBeGreaterThan(0); // a list that can silently empty is not a control
    expect(derived).toEqual([...new Set(AUTO_BIND_PROVIDERS.flatMap((p) => p.itemTypes))].sort());
    // Known-true anchor: two providers claim `data-pipeline`, so this also
    // proves the de-duplication rather than just the flatten.
    expect(derived).toContain('data-pipeline');
    expect(derived.filter((t) => t === 'data-pipeline')).toHaveLength(1);
    expect([...derived]).toEqual([...derived].sort());
  });

  it('narrows to the intersection of the request and the registry', async () => {
    let passed: string[] = [];
    await sweepAutoBind({
      dryRun: true,
      session: SESSION,
      providers: [seedingProvider(), { ...seedingProvider(), provider: 'other', itemTypes: ['other-item'] }],
      itemTypes: ['fake-item', 'not-a-real-type'],
      loadItems: async (o) => { passed = o.itemTypes; return []; },
    });
    expect(passed).toEqual(['fake-item']);
  });

  it('queries nothing at all when the requested types match no provider', async () => {
    let called = false;
    const result = await sweepAutoBind({
      dryRun: true,
      session: SESSION,
      providers: [seedingProvider()],
      itemTypes: ['mirrored-database'],
      loadItems: async () => { called = true; return []; },
    });

    expect(called).toBe(false);
    expect(result.scanned).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.excludedByAccess).toBe(0);
  });

  it('passes the workspace filter through to the loader', async () => {
    // A supplied `workspaceId` is now resolved against the caller's access
    // BEFORE the query (see `describe('a caller-chosen workspaceId')`), so the
    // scope has to be a workspace the caller can actually reach — otherwise
    // this would be asserting about a sweep that never got as far as the loader.
    ourWorkspace('ws-42');
    let seen: string | undefined = 'unset';
    await sweep([], { workspaceId: 'ws-42', loadItems: async (o) => { seen = o.workspaceId; return []; } });
    expect(seen).toBe('ws-42');
  });
});

// ===========================================================================
// THE REAL COSMOS ENUMERATION (the path no injected loader exercises)
// ===========================================================================
describe('loadSweepItems', () => {
  it('filters by item type and workspace, and caps with TOP', async () => {
    let spec: { query: string; parameters: { name: string; value: unknown }[] } | undefined;
    vi.mocked(itemsContainer).mockResolvedValue({
      items: {
        query: (s: typeof spec) => { spec = s; return { fetchAll: async () => ({ resources: [] }) }; },
      },
    } as never);

    // Reachable by the caller: a scoped sweep resolves the workspace before it
    // ever builds this query, so an unregistered id would never reach Cosmos.
    ourWorkspace('ws-7');
    await sweepAutoBind({
      dryRun: true,
      session: SESSION,
      providers: [seedingProvider()],
      workspaceId: 'ws-7',
      limit: 5,
    });

    expect(spec!.query).toContain('ARRAY_CONTAINS(@types, c.itemType)');
    expect(spec!.query).toContain('c.workspaceId = @ws');
    expect(spec!.query).toContain('SELECT TOP @limit');
    expect(spec!.parameters).toEqual([
      { name: '@types', value: ['fake-item'] },
      { name: '@ws', value: 'ws-7' },
      { name: '@limit', value: 6 },
    ]);
  });

  it('omits the workspace predicate when sweeping every workspace', async () => {
    let spec: { query: string; parameters: { name: string; value: unknown }[] } | undefined;
    vi.mocked(itemsContainer).mockResolvedValue({
      items: {
        query: (s: typeof spec) => { spec = s; return { fetchAll: async () => ({ resources: [] }) }; },
      },
    } as never);

    await sweepAutoBind({ dryRun: true, session: SESSION, providers: [seedingProvider()] });

    // `c.workspaceId` is also a PROJECTED column (SweepRow reports it), so the
    // assertion has to name the predicate, not the identifier.
    expect(spec!.query).toContain('c.workspaceId,');
    expect(spec!.query).not.toContain('= @ws');
    expect(spec!.parameters.map((p) => p.name)).toEqual(['@types', '@limit']);
  });
});
