/**
 * BULK auto-bind repair — the durable counterpart to the per-open self-heal.
 *
 * ## Why this exists (#3796)
 *
 * `autoBindOnCreate` already fires on every item-creation route, but it races an
 * 8s deadline and deliberately never throws: a slow ADF control plane must not
 * fail the create. So the binding is BEST-EFFORT at create time, and an item
 * whose seed did not finish is left with a real, bound, but EMPTY backing
 * object. `autoBindOnOpen` repairs that — but only when a human opens the item,
 * and only for the two item types it is wired into. Nothing sweeps the backlog.
 *
 * That backlog is #3549's live population: an install that reported "created"
 * with counts, over pipelines whose ADF object holds zero activities.
 *
 * ## What this does NOT do
 *
 * It does not reimplement the bind algorithm. Live mode delegates every decision
 * to `autoBindOnOpen`, so idempotency, self-heal, name-drift and the
 * "never overwrite authored work" invariant are the ENGINE's, exercised here
 * rather than duplicated. Dry-run calls only the provider's READ methods
 * (`preflight` / `probe` / `isEmpty`, all documented non-mutating) and writes
 * nothing, anywhere.
 *
 * ## Why "36 → 0" is the WRONG success criterion
 *
 * `seedPipelineFromContent` authors `state.content` into the backing object. An
 * item created from the catalog picker has NO `state.content` — so its empty
 * pipeline is *correct*, and repair is a designed no-op. The honest target is
 * the one #3796 itself offers as its alternative: every empty backing object is
 * either repaired or carries a stated, inspectable reason. Every row this sweep
 * emits carries that reason.
 *
 * ## Coverage, stated rather than implied
 *
 * `maybeRepairSeed` needs BOTH `seedFromContent` and `isEmpty` on a provider.
 * Three of the five registered providers (eventstream, adx-database,
 * lakehouse-adls) have the former and not the latter, so they are structurally
 * unreachable by repair. They are reported as `no-empty-probe` — named and
 * counted, never silently omitted from the scan. Their reasoned opt-outs live in
 * `ISEMPTY_OPT_OUTS` (`__tests__/auto-bind-seed.test.ts`); each turns on "no
 * call site would reach it", and #3694 tracks the wiring that would change that.
 * This sweep IS such a call site, which is worth saying on #3694 — but adding
 * three data-plane emptiness probes is that issue's work, not this one's.
 *
 * ## The scan is TENANT-SCOPED, and that is not optional
 *
 * The Cosmos enumeration below is cross-partition by design — sweeping a backlog
 * means not knowing which workspace holds it. Cross-partition is therefore
 * cross-TENANT unless something scopes it, and nothing in the query can: the
 * `items` container is partitioned by `workspaceId`, and the tenant a workspace
 * belongs to is recorded on the WORKSPACE doc, not the item. So every row the
 * page returns is filtered through `resolveWorkspaceAccessByOid` with the
 * caller's `tid` — the same per-row chokepoint `listAllOwnedItems` uses, for the
 * same reason (#2703).
 *
 * That filter runs in `sweepAutoBind`, BEFORE classification, so it covers both
 * the dry-run report and the live mutation path with one gate. Putting it in
 * `loadSweepItems` would have left the `loadItems` test seam as a way around it.
 *
 * `session` is REQUIRED on {@link SweepOptions} for the same reason
 * `WorkspaceAccessOpts` is required on the resolver: a boundary that a caller
 * can switch off by omitting an argument reads as enforced and is not. A future
 * scheduler (the ACA Job the route's docblock describes, tracked in #3832) has
 * to supply a caller identity too — "there was nobody to attribute it to" is
 * not a licence to enumerate and rewrite every tenant's items.
 *
 * ## A CALLER-CHOSEN SCOPE is resolved BEFORE the query, and refused as NOT-FOUND
 *
 * The per-row filter above drops rows and reports how many it dropped, and
 * {@link SweepResult.excludedByAccess} defends that count on the grounds that
 * naming the rows would be the disclosure the filter prevents. THAT REASONING
 * HOLDS ONLY WHILE THE COUNT IS INCIDENTAL — a by-product of whatever page
 * happened to load. When the CALLER picks the scope it is not incidental; it is
 * an answer to a question they asked. Measured on the pre-fix tree, as a tenant
 * admin in one Entra tenant against a workspace in another holding five items:
 *
 *     POST { workspaceId: '<a guid from another tenant>', itemTypes: ['…'] }
 *     -> {"dryRun":true,"scanned":0,"excludedByAccess":5,
 *         "excludedByWriteAccess":0,"byDisposition":{},"rows":[],
 *         "truncated":false}
 *     …and the loader was called with that workspaceId, so the foreign id
 *     reached the parameterized Cosmos predicate.
 *
 * `excludedByAccess` was therefore a CARDINALITY ORACLE: it said the workspace
 * exists and how many sweepable items it holds, narrowable one item type at a
 * time. Ids and names never appeared — and did not need to. Same class as
 * #3823/#3824, and reintroduced by the very field added to make the filter
 * honest.
 *
 * The repo already states the answer verbatim in `lib/api/route-toolkit.ts:113`
 * — 404 not 403, "so an id can't be probed for existence across tenants". So
 * when `opts.workspaceId` is supplied it is resolved through the SAME
 * `resolveWorkspaceAccessByOid` BEFORE any query is issued, and a `null`
 * resolution throws {@link SweepScopeError}, which the route answers 404. No
 * count, no scan envelope, and a message identical for "does not exist" and
 * "exists in a tenant you cannot see".
 *
 * This is a SECOND check, never a replacement: the per-row filter still runs
 * over every row of every page, so a scope the caller can reach is not a licence
 * to act on rows within it that they cannot. With NO `workspaceId` the behaviour
 * is deliberately unchanged — the tenant-wide sweep's count is genuinely
 * incidental, it is the honest signal that `scanned` is not "everything the
 * query found", and it stays.
 *
 * ## A LIVE pass additionally requires `canWrite`
 *
 * `resolveWorkspaceAccessByOid` returns a ROLE, not a yes/no, and
 * `workspace-access.ts` states the contract in as many words: "Callers that gate
 * mutations MUST check `canWrite`." The sweep is a mutation path — a live pass
 * creates ADF objects, writes authored content into them, and stamps provenance
 * onto the item document — so a non-null access is NOT sufficient for it.
 *
 * The reachable case is a downgrading grant: a tenant admin who has been
 * deliberately given `Viewer` (or `Contributor`) on someone else's workspace.
 * Step 5 of the resolver returns `via:'acl'` with `canWrite:false` BEFORE the
 * tenant-admin bypass in step 6 can manufacture `Admin`, so the explicit
 * read-only grant is the caller's real authority there — and the sweep used to
 * write through it anyway (measured: `role:'Viewer', canWrite:false` →
 * `disposition:'created'`, the ADF object created and seeded, the Cosmos doc
 * stamped).
 *
 * So {@link scopeToCallerAccess} takes the mode: DRY-RUN keeps the read bar
 * (reporting what *would* be repaired is a read, and an operator holding Viewer
 * is entitled to that report), LIVE requires `canWrite`. Rows refused only for
 * want of write access are counted separately as `excludedByWriteAccess`, so a
 * live pass that returns fewer rows than the dry-run before it says WHY rather
 * than silently shrinking.
 *
 * ## The scan is CURSORED, so re-running actually advances
 *
 * `truncated` used to be a dead end. `loadSweepItems` had no `ORDER BY`, no
 * continuation and no "already swept" predicate, so every pass re-read the same
 * `TOP n` prefix: measured over 5 items at `limit:2`, three live passes returned
 * `id-1,id-2` every time (pass 1 `created`, passes 2-3 `already-healthy`) and
 * `id-3..id-5` were never reached — while both docblocks told the operator to
 * keep re-running. Cheaper is not the same as further.
 *
 * The scan is now ordered by `c.id` and takes an exclusive `cursor`
 * (`c.id > @cursor`), and a truncated result carries `nextCursor`. The cursor is
 * derived from the RAW page, never from the visible rows: a page whose entire
 * tail belongs to other tenants would otherwise leave the cursor un-advanced and
 * loop forever. Because it advances past rows the access filter dropped, it also
 * closes the crowding-out limitation this file used to disclose — a caller whose
 * own items sit behind a wall of other tenants' rows now reaches them by
 * re-running, instead of needing `workspaceId` to side-step the page cap.
 *
 * ## …and the cursor is SEALED, because its plaintext is a foreign id
 *
 * Advancing past dropped rows is what closes the crowding-out limitation, and it
 * has to stay. But the id it advances TO is, on exactly the page that motivates
 * it, an item id belonging to a tenant the caller cannot see — and the first cut
 * of this returned it verbatim. Measured on a fully-foreign truncated page:
 *
 *     {"dryRun":true,"scanned":0,"excludedByAccess":2,"excludedByWriteAccess":0,
 *      "byDisposition":{},"rows":[],"truncated":true,"truncatedBy":"limit",
 *      "nextCursor":"id-a2"}
 *
 * `id-a2` lived in another Entra tenant. That contradicts {@link SweepResult}'s
 * own stated invariant three fields above it — "a COUNT only: naming them would
 * be the cross-tenant disclosure the filter exists to prevent" — and at
 * `limit:1` it is a walkable oracle over every item id in the container, ordered
 * by `c.id`, with `itemTypes` narrowing each id to a type. Ids and types only,
 * and the caller must already be a tenant admin; it is still the same class as
 * #3823/#3824 and it was introduced by the fix for the paging defect.
 *
 * So `nextCursor` is now an OPAQUE token: {@link sealCursor} encrypts
 * `{v,id,tid}` with `encryptAtRest` (AES-256-GCM, `lib/auth/session` — the same
 * primitive the OBO/user-token stores use, keyed off SESSION_SECRET under its
 * own HKDF label). No new crypto, no new secret, no new env var: the route is
 * session-gated, and resolving a session already required SESSION_SECRET, so
 * any caller that can reach the sweep can necessarily seal and unseal.
 *
 * {@link unsealSweepCursor} FAILS CLOSED. A token that fails its GCM tag, does
 * not decode, or carries a different `tid` throws {@link SweepCursorError} — it
 * never degrades to "start from the beginning", which would silently turn a
 * tampered token into a full re-scan the operator did not ask for, and never
 * falls through to a query with no resume predicate. The binding is to `tid`
 * rather than `oid` deliberately: the boundary being protected is the TENANT, so
 * one admin may hand a resume point to another admin in the same tenant, while a
 * token minted in another tenant is refused outright.
 */
import type { SqlParameter } from '@azure/cosmos';
import type { WorkspaceItem } from '@/lib/types/workspace';
import type { SessionPayload } from '@/lib/auth/session';
import { resolveWorkspaceAccessByOid, type WorkspaceAccess, type WorkspaceAccessOpts } from '@/lib/auth/workspace-access';
import {
  autoBindContextFromItem,
  autoBindOnOpen,
  readAutoBindRecord,
  resolveAutoBindProvider,
  type AutoBindProvider,
} from './auto-bind';
import { AUTO_BIND_PROVIDERS } from './auto-bind-providers';

/**
 * What the sweep concluded about one item. Every value is a FACT the sweep
 * established, not a guess — which is what makes the "stated reason" branch of
 * #3796's acceptance checkable rather than rhetorical.
 */
export type SweepDisposition =
  /** LIVE: the item's authored content was written into the backing object. */
  | 'repaired'
  /** LIVE: the backing object was missing; the engine created (and seeded) it. */
  | 'created'
  /** `state.autoBind.seeded === true` — healthy. Costs ZERO control-plane calls. */
  | 'already-healthy'
  /** `isEmpty()` said false. Repair REFUSES to touch it. This is the safety case. */
  | 'has-content'
  /** Backing object empty, item carries nothing to author. Correctly empty. */
  | 'no-authored-content'
  /** DRY-RUN: object is empty AND the item carries a content object to author. */
  | 'would-repair'
  /** DRY-RUN: no backing object at all; a live run would create and seed one. */
  | 'missing'
  /** Provider implements no `isEmpty`, so repair cannot reach it (#3694). */
  | 'no-empty-probe'
  /** No registered provider claims this item type — it has no Azure backing. */
  | 'unsupported'
  /** Estate/permission gate from `preflight`. Needs a Fix-it, not a retry. */
  | 'unavailable'
  /** Transient (throttle / 5xx / provisioning in flight). Re-run the sweep. */
  | 'retry'
  /** LIVE: content EXISTED and could not be authored. Reported, never swallowed. */
  | 'seed-failed'
  /** The sweep itself threw on this item. Never aborts the rest of the scan. */
  | 'failed';

export interface SweepRow {
  itemId: string;
  workspaceId: string;
  itemType: string;
  displayName: string;
  /** Provider key, or null when nothing claims the type. */
  provider: string | null;
  /** The backing object's name, when one was resolved. */
  backingName: string | null;
  disposition: SweepDisposition;
  /** Why this row got that disposition. Always populated. */
  reason: string;
  /**
   * LIVE only — did the engine's provenance write LAND in Cosmos on this pass?
   *
   * Undefined on a dry-run row and on any live row the engine was never handed
   * (those cost no write, so there is nothing to report). Present and `false`
   * means the repair happened in Azure but the `state.autoBind` stamp did not
   * persist, and `persistAutoBindPatch` swallows that by design
   * (`auto-bind.ts` — "a failed provenance write must never break the editor
   * open that triggered it").
   *
   * That swallow is right for an editor open and WRONG for a sweep, because the
   * route's "each pass strictly cheapens the next" claim is a claim about what
   * the NEXT pass re-reads from Cosmos. If the stamp never lands, every sweep
   * re-seeds the same items and reports `repaired` forever with the count never
   * falling and nothing saying why. Surfacing it is what makes that observable
   * instead of silent.
   */
  persisted?: boolean;
}

export interface SweepResult {
  /** False only when the caller explicitly asked for writes. */
  dryRun: boolean;
  /** Items examined. */
  scanned: number;
  /**
   * Rows the Cosmos page returned that the caller cannot see — dropped by the
   * workspace-access boundary before classification. A COUNT only: naming them
   * would be the cross-tenant disclosure the filter exists to prevent. Reported
   * rather than silently discarded so `scanned` is never read as "everything the
   * query found".
   *
   * THAT DEFENCE IS CONDITIONAL, AND THE CONDITION IS ENFORCED ELSEWHERE. A
   * count is safe because it is INCIDENTAL — a by-product of whatever page
   * happened to load, which the caller did not choose. It stops being safe the
   * moment the caller chooses the scope, because then the count is an answer:
   * pre-fix, `{workspaceId:'<a foreign guid>'}` came back `excludedByAccess:5,
   * rows:[]`, which says the workspace exists and holds five sweepable items,
   * narrowable per `itemTypes`. The rows were never named and never needed to be
   * — the number was the disclosure.
   *
   * So the invariant this field relies on is upheld by {@link sweepAutoBind}:
   * a supplied {@link SweepOptions.workspaceId} is resolved against the caller's
   * access BEFORE the query and a refusal throws {@link SweepScopeError} (404,
   * no envelope), so no value of this field is ever an answer about a scope the
   * caller cannot reach. Read the two together — this comment is not
   * self-supporting, and asserting it as though it were is what let the oracle
   * in.
   */
  excludedByAccess: number;
  /**
   * LIVE only — rows the caller CAN see but may not WRITE (a workspace where
   * their highest role is read-only, e.g. an explicit `Viewer` grant). Always 0
   * on a dry-run, which deliberately keeps the read bar.
   *
   * Separate from `excludedByAccess` because the two mean different things and
   * have different fixes: that one is "not yours", this one is "yours, but you
   * hold read-only there — re-run with `dryRun:true` to see what a writer would
   * repair, or get a write role". Folding them together would make a live pass
   * that returns fewer rows than its dry-run look like a tenant-boundary drop.
   */
  excludedByWriteAccess: number;
  /** Count per disposition — the summary a support engineer reads first. */
  byDisposition: Record<string, number>;
  rows: SweepRow[];
  /**
   * True when the scan stopped early (row cap or deadline) — so a caller can
   * never read a partial scan as a complete one. Re-run with {@link nextCursor}.
   */
  truncated: boolean;
  /** Set when truncated, naming which bound stopped it. */
  truncatedBy?: 'limit' | 'deadline';
  /**
   * Where the NEXT pass should resume — pass it back as {@link SweepOptions.cursor}.
   * Present only when `truncated`.
   *
   * An OPAQUE, sealed token, never a raw id. The position it encodes is the last
   * row of the RAW Cosmos page this pass finished with, NOT the last row it
   * reported. Those differ whenever the access filter drops rows, and using the
   * reported one would re-read the dropped tail forever (a page belonging
   * entirely to other tenants would never advance at all) — which is exactly why
   * the plaintext is routinely an id the caller is NOT entitled to see, and
   * therefore why it is sealed. See the module docblock; returning it verbatim
   * was a cross-tenant identifier leak.
   *
   * Absent only on a FIRST pass — one the caller sent no `cursor` with — that a
   * `deadline` truncation cut before it processed anything: there is genuinely
   * no position to record, and the correct next call is the same (cursor-less)
   * request with a fresh budget.
   *
   * On a RESUMED pass that got through nothing it is PRESENT, and encodes the
   * position the caller sent: `advancedTo` is initialised to the unsealed
   * cursor, so the same point is re-sealed and handed back rather than dropped.
   * That is deliberate — the alternative loses the operator's place and makes
   * the next call re-scan (and, live, re-write) ground already covered. The
   * token is a fresh ciphertext each time (a random IV per seal), so it will not
   * be byte-equal to the one that was sent; only the position it encodes is.
   */
  nextCursor?: string;
}

export interface SweepOptions {
  /** Write when false. Callers must opt IN to mutation; see the route. */
  dryRun: boolean;
  /**
   * The CALLER. Required, and deliberately not optional: every row the scan
   * returns is filtered through `resolveWorkspaceAccessByOid` with this
   * session's `oid` + `tid`, and a boundary a caller can disable by leaving an
   * argument out is the exact shape of #2703. See the module docblock.
   */
  session: SessionPayload;
  /**
   * Restrict to one workspace. Omitted → every workspace the CALLER can see.
   *
   * CALLER-CHOSEN, therefore RESOLVED FIRST. When supplied, the caller's access
   * to THIS workspace is resolved before any query runs and a `null` resolution
   * throws {@link SweepScopeError} — because a scoped result's
   * {@link SweepResult.excludedByAccess} would otherwise answer "does this
   * workspace exist, and how much does it hold?" for any id the caller cares to
   * name. See the module docblock.
   */
  workspaceId?: string;
  /** Restrict to specific item types. Omitted → every type a provider claims. */
  itemTypes?: readonly string[];
  /** Max items to examine. Default 200, hard cap 1000. */
  limit?: number;
  /**
   * Resume point — the `nextCursor` of the previous (truncated) pass, which is
   * a SEALED token and not an id. Exclusive: the scan returns rows whose `id`
   * sorts strictly AFTER the position it encodes. Omitted → start at the
   * beginning. A token that fails to unseal throws {@link SweepCursorError};
   * it is never quietly treated as "no cursor".
   */
  cursor?: string;
  /**
   * Wall-clock budget in ms, default 120_000. A caller with its own budget
   * (an HTTP route has `maxDuration`) MUST pass its own — this module cannot
   * know what its caller can afford, and a sweep killed mid-flight by the host
   * returns nothing at all, which is strictly worse than a reported partial.
   */
  deadlineMs?: number;
  /** Test seam — the engine's own. Injected fakes exercise the REAL algorithm. */
  providers?: readonly AutoBindProvider[];
  /** Test seam — supply items instead of querying Cosmos. */
  loadItems?: (o: { itemTypes: string[]; workspaceId?: string; limit: number; cursor?: string }) => Promise<WorkspaceItem[]>;
  /** Test seam — monotonic clock for the deadline. */
  now?: () => number;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const DEFAULT_DEADLINE_MS = 120_000;

/**
 * Sealed-cursor envelope version. Bumping it invalidates every outstanding
 * token, which is the correct behaviour for a format change: an old token
 * decrypts fine and would otherwise be misread under the new shape.
 */
const CURSOR_VERSION = 1;

/**
 * A resume cursor that cannot be trusted — tampered, malformed, or minted for a
 * different tenant.
 *
 * Typed rather than a bare `Error` so the route can answer 400 with the message
 * verbatim (`apiHonestError`) instead of genericizing it into a 500. The message
 * is deliberately actionable and deliberately says NOTHING about the position
 * the token did or did not encode.
 *
 * This class is why the failure is CLOSED. The tempting alternative — treat an
 * unreadable cursor as absent and start from the beginning — is wrong twice
 * over: it silently re-scans (and, in live mode, re-writes) an estate the
 * operator believed was half-swept, and it converts a rejected token into a
 * query with no resume predicate at all.
 */
export class SweepCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SweepCursorError';
  }
}

/**
 * A caller-CHOSEN sweep scope the caller cannot reach.
 *
 * Thrown when {@link SweepOptions.workspaceId} is supplied and
 * `resolveWorkspaceAccessByOid` returns null for it — the workspace does not
 * exist, is in another Entra tenant, or is one the caller holds no role on. The
 * three are DELIBERATELY INDISTINGUISHABLE, in the class, the status code and
 * the message.
 *
 * WHY 404 AND NOT 403. `lib/api/route-toolkit.ts:113` states the repo's rule in
 * as many words — answer not-found "so an id can't be probed for existence
 * across tenants". A 403 concedes the workspace exists; so, more quietly, does
 * a 200 carrying `excludedByAccess:5`. Both are the same disclosure, and the
 * second one is the shape that shipped: the count told a tenant admin who knew
 * a workspace guid in another tenant that it existed and how many sweepable
 * items it held, narrowable by `itemTypes`.
 *
 * Typed, like {@link SweepCursorError}, so the route can map it to its own
 * status with `apiHonestError` rather than genericizing it into a 500 — and so
 * the branch is `instanceof`-checkable rather than string-matched.
 *
 * The message is honest under `deploy-integrity.md` R7 BECAUSE it is a
 * disjunction: it never asserts the workspace is missing (this code did not
 * establish that) and never asserts it belongs to someone else (nor that). It
 * states exactly what was established — the caller cannot reach it — and says
 * plainly that Loom does not distinguish the causes, so the silence is
 * disclosed rather than pretended.
 *
 * The resolver's own richer refusal (`WorkspaceAccessDenial`, e.g. the #3823
 * `tenant_unconfirmed` case) is deliberately NOT surfaced here: it would
 * confirm the workspace was read, which is the fact being withheld. It is still
 * logged server-side by the resolver, so it is not lost — only not told to the
 * caller.
 */
export class SweepScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SweepScopeError';
  }
}

/**
 * The refusal a caller sees for a scope they cannot reach.
 *
 * A CONSTANT, not a template. Any per-case variation — naming the workspace,
 * distinguishing "absent" from "forbidden", counting anything — reopens the
 * oracle through the error path instead of the success path.
 */
const SCOPE_REFUSAL =
  'That workspace is not in scope for this sweep — it does not exist in this deployment, or your '
  + 'account has no access to it. Loom deliberately does not say which, so a workspace id cannot be '
  + 'probed for existence across tenants. Re-run with no `workspaceId` to sweep every workspace you '
  + 'can see, or check the id on the workspaces list.';

/**
 * Seal a raw Cosmos id into the opaque token that leaves the process.
 *
 * `encryptAtRest` is `lib/auth/session`'s existing AES-256-GCM helper — the one
 * the OBO / SQL / Kusto / Power BI user-token stores already use — keyed by
 * HKDF off SESSION_SECRET under its own `loom-at-rest-v1` label, so a cursor can
 * never be replayed as a session cookie or vice versa. Imported dynamically for
 * the same reason `accessOptsForCaller` imports `isTenantAdmin` that way: this
 * module keeps its static graph clear of the auth (and therefore `next/headers`)
 * edge, and a caller that injects `loadItems` and never truncates never loads it.
 *
 * The `tid` rides INSIDE the sealed envelope, so it is authenticated by the same
 * GCM tag as the id — a token cannot be re-pointed at another tenant without
 * failing the tag.
 */
async function sealCursor(rawId: string, session: SessionPayload): Promise<string> {
  const { encryptAtRest } = await import('@/lib/auth/session');
  return encryptAtRest(JSON.stringify({ v: CURSOR_VERSION, id: rawId, tid: session.claims.tid ?? null }));
}

/**
 * Unseal a token back to the raw Cosmos id, or THROW.
 *
 * Exported because the sweep's own specs assert the round trip with the real
 * implementation rather than a second, hand-rolled decoder — a test that
 * reimplements the thing it is checking pins the reimplementation.
 *
 * Every rejection path throws {@link SweepCursorError}; none returns
 * `undefined`. The tenant check is a POSITIVE match on `tid` (the shape #3824
 * settled on for the admin bypass), including the both-absent case, so a token
 * minted by a caller in another tenant is refused even though it decrypts
 * perfectly — the key is estate-wide, not per-tenant.
 */
export async function unsealSweepCursor(token: string, session: SessionPayload): Promise<string> {
  const { decryptAtRest } = await import('@/lib/auth/session');
  const plain = decryptAtRest(token);
  if (plain === null) {
    // R7 — SAY ONLY WHAT WAS ESTABLISHED. `decryptAtRest` returns null for TWO
    // causes, not one: a failed GCM tag, and `getAtRestKey()` throwing because
    // SESSION_SECRET is absent or empty (its own `catch` flattens that into the
    // same null). A single message naming only the first asserted a fact about
    // the TOKEN in a case where the token was never even compared — the key was
    // not derivable, so nothing about it was checked at all.
    //
    // Unreachable through the route today (`withSession` 401s before this runs,
    // and resolving a session already needs SESSION_SECRET), but reachable for
    // the ACA-Job caller the route's docblock proposes (#3832), which has no
    // cookie to 401 on — and that caller is precisely the one with nobody
    // watching to notice the message was wrong.
    if (!process.env.SESSION_SECRET) {
      throw new SweepCursorError(
        'The resume cursor could not be authenticated because this process has no SESSION_SECRET '
        + 'configured — the key that seals a cursor was never derivable here, so nothing about the '
        + 'token itself was established. Set SESSION_SECRET on this deployment (it is the same secret '
        + 'the session cookie already requires) and re-run the sweep.');
    }
    throw new SweepCursorError(
      'The resume cursor could not be authenticated — it was altered, truncated, or issued by a different '
      + 'deployment. Re-run the sweep with no cursor to start a fresh pass from the beginning.');
  }
  let parsed: { v?: unknown; id?: unknown; tid?: unknown };
  try {
    parsed = JSON.parse(plain) as typeof parsed;
  } catch {
    throw new SweepCursorError(
      'The resume cursor decrypted but did not decode. Re-run the sweep with no cursor to start a fresh pass.');
  }
  if (!parsed || typeof parsed !== 'object' || parsed.v !== CURSOR_VERSION
      || typeof parsed.id !== 'string' || !parsed.id) {
    throw new SweepCursorError(
      'The resume cursor is from an older, incompatible sweep format. Re-run the sweep with no cursor to '
      + 'start a fresh pass.');
  }
  if ((parsed.tid ?? null) !== (session.claims.tid ?? null)) {
    throw new SweepCursorError(
      'The resume cursor was issued to a different Entra tenant and will not be honoured. Re-run the sweep '
      + 'with no cursor to start a fresh pass in your own tenant.');
  }
  return parsed.id;
}

/**
 * Every item type some registered provider backs, derived from the registry.
 *
 * DERIVED, never hand-listed: a second list drifts from the first silently and
 * in one direction — a provider added tomorrow would simply never be swept, and
 * the sweep would report a clean estate it never looked at. Same argument, same
 * failure shape, as #3783's suite deriver.
 */
export function sweepableItemTypes(
  providers: readonly AutoBindProvider[] = AUTO_BIND_PROVIDERS,
): string[] {
  return [...new Set(providers.flatMap((p) => p.itemTypes))].sort();
}

/**
 * Does this item carry a content object that `seedFromContent` could author?
 *
 * Deliberately the WEAKER half of `authoredContent`'s test: shape only, no kind
 * matching. Only the provider's own `seedFromContent` knows which kinds it
 * accepts, and duplicating that list here would be the drift this file argues
 * against everywhere else. So dry-run reports `would-repair` (an attempt will be
 * made), and only the LIVE run distinguishes `repaired` from
 * `no-authored-content` — which it does from the engine's own seed record, not
 * from a second opinion.
 */
function carriesContentObject(state: Record<string, unknown> | undefined): boolean {
  const raw = state?.content;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return typeof (raw as { kind?: unknown }).kind === 'string';
}

/**
 * Query the items container for everything a provider could back.
 *
 * The Cosmos client is imported DYNAMICALLY, matching `persistAutoBindPatch` in
 * the sibling module: a caller that injects `loadItems` (every unit test, and
 * any future caller with its own enumeration) then never loads it at all.
 *
 * ORDERED AND CURSORED. `ORDER BY c.id` plus the exclusive `c.id > @cursor`
 * predicate is what makes `truncated` actionable: without a total order a
 * `TOP n` cross-partition query may return any n rows, and without the
 * predicate it returns the SAME n every time — which is exactly what the sweep
 * did (measured: three passes at `limit:2` over five items all returned
 * `id-1,id-2`; `id-3..id-5` were unreachable). `c.id` is the ordering key
 * because it is the one property every item carries, is unique, and is indexed
 * by the default policy — so no composite index is required for this
 * single-property sort.
 *
 * NOT tenant-scoped, and cannot be: the `items` container is partitioned by
 * `workspaceId` and carries no tenant field, so the boundary lives one level up
 * in `sweepAutoBind` where each row is resolved against the caller's access.
 * Nothing here — and nothing a `loadItems` seam returns — reaches classification
 * or mutation without passing that filter.
 */
async function loadSweepItems(o: {
  itemTypes: string[];
  workspaceId?: string;
  limit: number;
  cursor?: string;
}): Promise<WorkspaceItem[]> {
  const { itemsContainer } = await import('@/lib/azure/cosmos-client');
  const container = await itemsContainer();
  const where = ['ARRAY_CONTAINS(@types, c.itemType)'];
  const parameters: SqlParameter[] = [{ name: '@types', value: o.itemTypes }];
  if (o.workspaceId) {
    where.push('c.workspaceId = @ws');
    parameters.push({ name: '@ws', value: o.workspaceId });
  }
  if (o.cursor) {
    where.push('c.id > @cursor');
    parameters.push({ name: '@cursor', value: o.cursor });
  }
  const { resources } = await container.items
    .query<WorkspaceItem>({
      query: `SELECT TOP @limit c.id, c.workspaceId, c.itemType, c.displayName, c.state
              FROM c WHERE ${where.join(' AND ')} ORDER BY c.id`,
      parameters: [...parameters, { name: '@limit', value: o.limit }],
    })
    .fetchAll();
  return resources;
}

/**
 * Build the access options for the CALLER from their own session.
 *
 * Mirrors `item-crud`'s private `accessOptsFor` field for field, including the
 * empty-`groups` care: an empty array is truthy and would send
 * `resolveEffectiveRole` down its "group set already known" fast path, silently
 * skipping the Graph membership probe (#3175 — the claim is never populated
 * live today, so this is latent rather than active).
 *
 * There is no ambient-session branch here because there is no principal
 * mismatch to guard against: the `oid` IS `session.claims.oid`. `isTenantAdmin`
 * is imported dynamically so this module keeps its static graph free of a
 * feature-gate (and therefore Cosmos) edge, matching `ambientAccessOptsFor`.
 */
async function accessOptsForCaller(session: SessionPayload): Promise<WorkspaceAccessOpts> {
  const { isTenantAdmin } = await import('@/lib/auth/feature-gate');
  return {
    callerTid: session.claims.tid,
    groups: session.claims.groups?.length ? session.claims.groups : undefined,
    tenantAdmin: isTenantAdmin(session),
  };
}

/**
 * What the access boundary decided about ONE row of the raw Cosmos page.
 *
 * Kept in RAW page order (including the rows that were dropped) because two
 * things downstream need the order and not just the survivors: the cursor, which
 * must advance past dropped rows or never advance at all, and the two exclusion
 * counts, which must cover exactly the rows this pass actually consumed.
 */
interface AccessDecision {
  item: WorkspaceItem;
  /** May this pass classify (and, in live mode, mutate) the row? */
  allowed: boolean;
  /** LIVE only — the caller CAN see this workspace but holds no write role. */
  refusedForWrite: boolean;
}

/**
 * Decide, for every row of a Cosmos page, whether the caller may act on it.
 *
 * One resolve per DISTINCT workspace (cached), which is what keeps this cheap on
 * a page of 200 items spread over a handful of workspaces — the same shape, and
 * the same cache, as `listAllOwnedItems`.
 *
 * The tenant-admin bypass inside the resolver (step 6) is what lets an admin
 * sweep workspaces they neither own nor are a member of; since #3824 that bypass
 * requires a POSITIVE tid match, so a workspace whose tenancy Loom cannot
 * confirm resolves to `null` here and is excluded. This filter agrees with that
 * refusal rather than masking it — it is a SECOND, independent check, never a
 * substitute for the resolver's own.
 *
 * `requireWrite` is the live-mode bar. `resolveWorkspaceAccessByOid` returns a
 * ROLE, and `workspace-access.ts` is explicit that "callers that gate mutations
 * MUST check `canWrite`" — a sweep that writes to ADF and stamps Cosmos is such
 * a caller. A tenant admin deliberately granted `Viewer` on someone's workspace
 * resolves at step 5 (`via:'acl'`, `canWrite:false`) BEFORE the admin bypass can
 * upgrade them, so that read-only grant is their real authority and a live pass
 * must honour it.
 */
async function scopeToCallerAccess(
  page: readonly WorkspaceItem[],
  session: SessionPayload,
  requireWrite: boolean,
): Promise<AccessDecision[]> {
  if (page.length === 0) return [];
  const oid = session.claims.oid;
  const opts = await accessOptsForCaller(session);
  const cache = new Map<string, WorkspaceAccess | null>();
  const decisions: AccessDecision[] = [];
  for (const it of page) {
    let access = cache.get(it.workspaceId);
    if (access === undefined) {
      access = await resolveWorkspaceAccessByOid(oid, it.workspaceId, opts);
      cache.set(it.workspaceId, access);
    }
    const writable = access !== null && access.canWrite;
    decisions.push({
      item: it,
      allowed: access !== null && (!requireWrite || writable),
      refusedForWrite: access !== null && requireWrite && !writable,
    });
  }
  return decisions;
}

function row(
  item: WorkspaceItem,
  provider: string | null,
  backingName: string | null,
  disposition: SweepDisposition,
  reason: string,
  persisted?: boolean,
): SweepRow {
  return {
    itemId: item.id,
    workspaceId: item.workspaceId,
    itemType: item.itemType,
    displayName: item.displayName || '',
    provider,
    backingName,
    disposition,
    reason,
    ...(persisted === undefined ? {} : { persisted }),
  };
}

/**
 * Classify one item WITHOUT writing anything.
 *
 * Mirrors `maybeRepairSeed`'s guard ORDER exactly, including its cheapness
 * property: a `seeded:true` item returns before any network call, so a healthy
 * estate costs the sweep almost nothing.
 */
async function previewOne(
  item: WorkspaceItem,
  providers: readonly AutoBindProvider[],
): Promise<SweepRow> {
  const ctx = autoBindContextFromItem(item);
  const provider = resolveAutoBindProvider(ctx, providers);
  if (!provider) {
    return row(item, null, null, 'unsupported', `No registered provider claims item type '${item.itemType}'.`);
  }

  // Guard 1 — provenance says the content was authored. Zero control-plane calls.
  const record = readAutoBindRecord(item.state as Record<string, unknown> | undefined);
  if (record?.seeded === true) {
    return row(item, provider.provider, record.backingName, 'already-healthy',
      'state.autoBind.seeded is true — the backing object was authored on a previous bind.');
  }

  // Guard 2 — the provider cannot answer "is it empty?", so repair never reaches it.
  if (!provider.seedFromContent || !provider.isEmpty) {
    return row(item, provider.provider, record?.backingName ?? null, 'no-empty-probe',
      `Provider '${provider.provider}' implements no isEmpty probe, so the engine's repair path cannot `
      + 'evaluate it. Reasoned opt-out in ISEMPTY_OPT_OUTS; wiring tracked in #3694.');
  }

  const pre = await provider.preflight(ctx);
  if (!pre.ok) {
    return row(item, provider.provider, null, pre.kind === 'retry' ? 'retry' : 'unavailable', pre.reason);
  }

  const target = provider.backingNameFor(ctx);
  const name = record?.backingName || provider.existingBinding?.(ctx) || target.name;
  if (!(await provider.probe(name, pre.coords, ctx))) {
    return row(item, provider.provider, name, 'missing',
      'No backing object of that name exists. A live sweep would create it and seed any authored content.');
  }

  if (!(await provider.isEmpty(name, pre.coords, ctx))) {
    return row(item, provider.provider, name, 'has-content',
      'The backing object already holds content. Repair refuses to touch it.');
  }

  if (!carriesContentObject(item.state as Record<string, unknown> | undefined)) {
    return row(item, provider.provider, name, 'no-authored-content',
      'The backing object is empty and the item carries no content to author — for a blank item this is '
      + 'the CORRECT state, not a defect.');
  }

  return row(item, provider.provider, name, 'would-repair',
    'The backing object is empty and the item carries authored content. A live sweep would seed it.');
}

/**
 * Run the repair for one item by delegating the ACTION wholly to the engine.
 *
 * Classification comes from `previewOne` — the same read-only pass dry-run uses
 * — and only rows that need something from the engine are handed to
 * `autoBindOnOpen`: `would-repair` and `missing` for the action, `has-content`
 * for the provenance stamp alone. Everything else is returned as measured.
 *
 * That is not the sweep second-guessing the engine; deciding WHICH items to
 * hand over is the sweep's entire job. Three things fall out of it:
 *
 *   - Dry-run and live agree BY CONSTRUCTION on every non-actionable row, since
 *     one function produces both. They cannot drift.
 *   - The safety case costs one read and zero engine round-trips.
 *   - `has-content` stays distinguishable from `no-authored-content`. The engine
 *     deliberately collapses them — `maybeRepairSeed` returns
 *     `{seeded:true, detail:'backing object already holds content'}` when it
 *     REFUSES, which is right for the editor (it clears a stale seedError) and
 *     wrong for a report: classifying that as `repaired` would inflate the
 *     headline count with items nothing was written to.
 */
async function repairOne(
  item: WorkspaceItem,
  providers: readonly AutoBindProvider[],
): Promise<SweepRow> {
  const preview = await previewOne(item, providers);
  const actionable = preview.disposition === 'would-repair' || preview.disposition === 'missing';
  if (!actionable && preview.disposition !== 'has-content') {
    return preview;
  }

  const { outcome, persisted } = await autoBindOnOpen(item, undefined, { providers });

  // `has-content` is handed over for its SIDE EFFECT, not for a verdict. The
  // engine's refusal stamps `seeded:true` ("stops every later open paying for
  // this probe" — its words), which is what makes each sweep pass strictly
  // cheaper than the last. But the verdict stays the one WE measured: the
  // engine reports that refusal as `seeded:true`, and reading that back as
  // `repaired` would credit the sweep with a write it did not make.
  //
  // `persisted` rides along even here — ESPECIALLY here. The cheapening is a
  // property of the Cosmos document the next pass re-reads, not of the
  // in-memory item this one mutated, so a row that reports the refusal without
  // reporting whether the stamp landed is asserting convergence it did not
  // establish.
  if (!actionable) return { ...preview, persisted };

  if (outcome.status === 'unsupported') {
    return row(item, preview.provider, null, 'unsupported', 'The engine resolved no provider for this item.', persisted);
  }
  if (outcome.status === 'unavailable') {
    return row(item, outcome.provider, null, 'unavailable', outcome.reason, persisted);
  }
  if (outcome.status === 'retry') {
    return row(item, outcome.provider, null, 'retry', outcome.reason, persisted);
  }

  const r = outcome.record;
  if (r.seedError) {
    return row(item, r.provider, r.backingName, 'seed-failed', r.seedError, persisted);
  }

  // The reason is always the ENGINE's own `seedDetail`, never a sentence of
  // ours describing what we assume it did. If the object gained content between
  // the preview and the act, the engine refuses and its detail says so verbatim
  // — the row stays readable rather than silently asserting a write we did not
  // make. The invariant itself is the engine's and holds either way.
  const created = r.via === 'created' || r.via === 'recreated';
  if (r.seeded === true) {
    return row(item, r.provider, r.backingName, created ? 'created' : 'repaired',
      r.seedDetail || (created ? 'Backing object created and seeded.' : 'Authored content written into the empty backing object.'),
      persisted);
  }
  return row(item, r.provider, r.backingName, 'no-authored-content',
    r.seedDetail
    || (created
      ? 'The engine created the backing object and found no authored content of a kind this provider seeds.'
      : 'The engine found no authored content of a kind this provider seeds — for a blank item this is the '
        + 'CORRECT state, not a defect.'),
    persisted);
}

/**
 * Sweep every auto-bindable item THE CALLER CAN SEE, repairing empty backing
 * objects.
 *
 * Sequential by design. A healthy item costs zero control-plane calls (guard 1),
 * so the expensive rows are exactly the broken ones, and serializing them keeps
 * a large estate from throttling the ADF control plane — the failure mode that
 * would turn a repair pass into a self-inflicted outage.
 *
 * PAGING. The scan owns a WINDOW of `limit` raw rows per pass and asks Cosmos
 * for one more, purely to learn whether another window exists. A truncated
 * result carries `nextCursor` — a SEALED token for the last raw row the window
 * finished with — and passing it back resumes strictly after it. That is what
 * makes the "re-run until `truncated` is false" instruction TRUE; before the
 * cursor existed every pass re-read the same prefix and the tail beyond `limit`
 * was unreachable no matter how many times it was run.
 *
 * The cursor comes from the raw window, not from the reported rows, so it
 * advances past rows the access filter dropped. A page belonging entirely to
 * other tenants therefore still moves the scan forward — and the crowding-out
 * problem this file used to disclose (a caller's own items pushed off page 1 by
 * rows they cannot see, with no way to reach them short of scoping by
 * `workspaceId`) is closed by the same mechanism.
 *
 * It is SEALED for exactly that reason: the row it names is, on that very page,
 * one the caller may not see. The position is carried across the wire without
 * the identifier. See the module docblock.
 */
export async function sweepAutoBind(opts: SweepOptions): Promise<SweepResult> {
  // FIRST, and before any query, any early return, and any provider work: an
  // unusable resume token stops the pass outright rather than degrading into a
  // scan from the beginning. See {@link SweepCursorError}.
  const rawCursor = opts.cursor === undefined
    ? undefined
    : await unsealSweepCursor(opts.cursor, opts.session);

  // SECOND, and still before any item query, any provider work and any count:
  // a CALLER-CHOSEN scope is resolved against the caller's own access to it.
  //
  // The per-row filter further down is the enforcement point for what may be
  // reported or written, and it stays — but it runs AFTER the query, so with a
  // caller-supplied `workspaceId` it produced a scoped `excludedByAccess`, and
  // that number answers "does this workspace exist, and how many sweepable
  // items does it hold?" for any guid the caller cares to name. Measured
  // pre-fix: 5 items in another tenant's workspace came back as
  // `excludedByAccess:5, rows:[]`, and the foreign id reached the Cosmos
  // predicate. `route-toolkit.ts:113` states the repo's answer verbatim — 404
  // not 403, "so an id can't be probed for existence across tenants".
  //
  // Note this runs even when `loadItems` is injected, for the same reason
  // `scopeToCallerAccess` lives here rather than in `loadSweepItems`: a test
  // seam must not be a way around a boundary.
  //
  // Deliberately NOT gated on `dryRun`. Existence is disclosed by a read, so a
  // dry-run leaks exactly as much as a live pass does.
  if (opts.workspaceId !== undefined) {
    const scope = await resolveWorkspaceAccessByOid(
      opts.session.claims.oid,
      opts.workspaceId,
      await accessOptsForCaller(opts.session),
    );
    // No `canWrite` check here on purpose: this gate is about DISCLOSURE, and a
    // caller who can read the workspace already knows it exists. Whether they
    // may WRITE to rows inside it is still decided per row by
    // `scopeToCallerAccess`, and reported as `excludedByWriteAccess`.
    if (scope === null) throw new SweepScopeError(SCOPE_REFUSAL);
  }

  const providers = opts.providers ?? AUTO_BIND_PROVIDERS;
  const now = opts.now ?? (() => Date.now());
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const deadline = now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);

  const allTypes = sweepableItemTypes(providers);
  const itemTypes = opts.itemTypes?.length
    ? allTypes.filter((t) => opts.itemTypes!.includes(t))
    : allTypes;

  const rows: SweepRow[] = [];
  let truncated = false;
  let truncatedBy: SweepResult['truncatedBy'];

  if (itemTypes.length === 0) {
    return {
      dryRun: opts.dryRun, scanned: 0, excludedByAccess: 0, excludedByWriteAccess: 0,
      byDisposition: {}, rows, truncated: false,
    };
  }

  // Ask for one more than the cap so a full page is distinguishable from an
  // exactly-full estate. Reporting a truncated scan as complete is the whole
  // class of defect this repo keeps re-learning.
  const load = opts.loadItems ?? loadSweepItems;
  const page = await load({ itemTypes, workspaceId: opts.workspaceId, limit: limit + 1, cursor: rawCursor });

  // The rows this pass OWNS. The (limit+1)th row, if it came back, is a
  // lookahead and nothing else — it is neither classified nor stepped over, so
  // the next pass starts on it rather than skipping it.
  const pageWindow = page.slice(0, limit);
  if (page.length > limit) {
    truncated = true;
    truncatedBy = 'limit';
  }

  // THE TENANT BOUNDARY. Applied to the window BEFORE anything classifies,
  // reports or mutates it, so dry-run and live are gated by one filter and the
  // `loadItems` seam is not a way around it. In live mode it additionally
  // requires `canWrite`. Truncation is still judged on the RAW page: the query
  // really did fill it, and saying otherwise because rows were filtered out
  // afterwards would report a partial scan as complete.
  const decisions = await scopeToCallerAccess(pageWindow, opts.session, !opts.dryRun);

  let excludedByAccess = 0;
  let excludedByWriteAccess = 0;
  // The last RAW row this pass finished with. Advanced for dropped rows too —
  // that is precisely what stops a page full of other tenants' items from
  // pinning the cursor in place forever. Held here as the RAW id (the sealed
  // form is minted once, at the return) so the deadline case can resume from
  // the last row actually PROCESSED.
  let advancedTo: string | undefined = rawCursor;

  for (const d of decisions) {
    if (!d.allowed) {
      if (d.refusedForWrite) excludedByWriteAccess += 1;
      else excludedByAccess += 1;
      advancedTo = d.item.id;
      continue;
    }
    // Checked only before work that can cost a round trip; stepping over a
    // dropped row is free and must not be able to strand the cursor.
    if (now() >= deadline) {
      truncated = true;
      truncatedBy = 'deadline';
      break;
    }
    try {
      rows.push(opts.dryRun ? await previewOne(d.item, providers) : await repairOne(d.item, providers));
    } catch (e) {
      // One item's failure must never abort the sweep — the backlog is exactly
      // the population most likely to throw.
      rows.push(row(d.item, null, null, 'failed', e instanceof Error ? e.message : String(e)));
    }
    advancedTo = d.item.id;
  }

  const byDisposition: Record<string, number> = {};
  for (const r of rows) byDisposition[r.disposition] = (byDisposition[r.disposition] || 0) + 1;

  // Sealed exactly once, on the way out. `advancedTo` is a raw Cosmos id and,
  // on the very page that motivates advancing past dropped rows, an id from a
  // tenant the caller cannot see — so the raw value must not reach the caller.
  const nextCursor = truncated && advancedTo !== undefined
    ? await sealCursor(advancedTo, opts.session)
    : undefined;

  return {
    dryRun: opts.dryRun,
    scanned: rows.length,
    excludedByAccess,
    excludedByWriteAccess,
    byDisposition,
    rows,
    truncated,
    truncatedBy,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}
