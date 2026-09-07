/**
 * Workspaces admin client (F6 — Workspaces list & govern).
 *
 * Server-side ONLY (imports the Cosmos SDK singleton). Powers the tenant-wide
 * `/admin/workspaces` inventory: every workspace in the tenant, regardless of
 * owner, with LIVE item counts, last-activity, capacity, state, and the
 * resolved owner set.
 *
 * Why a CROSS-PARTITION scan: each workspace doc is partitioned by `/tenantId`,
 * and in this codebase `workspace.tenantId === the creating user's oid` (see
 * POST /api/workspaces — every workspace lives in its own logical partition
 * keyed by its creator). A single-partition query (the previous route) would
 * therefore only ever return the admin's OWN workspaces. To enumerate the whole
 * tenant we issue `SELECT * FROM c` with NO `{ partitionKey }` option so the
 * @azure/cosmos SDK fans out across every physical partition. The Console UAMI's
 * "Cosmos DB Built-in Data Contributor" role at account scope already authorises
 * the fan-out — no extra RBAC grant required. This is an admin-only surface
 * (gated by isTenantAdmin in the route), so the cost is acceptable.
 *
 * Per .claude/rules/no-vaporware.md: real Cosmos reads only — never `return []`
 * placeholders. Per .claude/rules/no-fabric-dependency.md: zero Fabric/Power BI
 * calls — Azure Cosmos DB NoSQL is the one and only backend.
 */

import {
  workspacesContainer,
  itemsContainer,
  workspaceRolesContainer,
} from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceImageMeta } from '@/lib/types/workspace';

/** Explicit lifecycle enum (no free-form string — per loom-no-freeform-config). */
export type WorkspaceState = 'Active' | 'Provisioning' | 'Suspended' | 'Deleted';

const VALID_STATES: readonly WorkspaceState[] = ['Active', 'Provisioning', 'Suspended', 'Deleted'];

/** Coerce a stored `state` value to a known enum member; default 'Active'. */
function normalizeState(s: unknown): WorkspaceState {
  return (VALID_STATES as readonly string[]).includes(s as string) ? (s as WorkspaceState) : 'Active';
}

export interface WorkspaceAdminRecord {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  /** Implicit owner — the creator. Always present in `owners`. */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  capacity?: string;
  domain?: string;
  /** ARM resource id of a bound storage account (for the OneLake settings tab). */
  storageAccountId?: string;
  state: WorkspaceState;
  /** Live item count from the items container. */
  itemCount: number;
  /** MAX(items.updatedAt) when the workspace has items, else workspace.updatedAt. */
  lastActivity: string;
  /** Resolved owner set: creator + every Admin-role principal on the workspace. */
  owners: string[];
  /** Power BI-style workspace image pointer (drives the admin-list row avatar). */
  image?: WorkspaceImageMeta;
}

interface RawWorkspaceDoc {
  id: string;
  tenantId?: string;
  name?: string;
  description?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  capacity?: string;
  domain?: string;
  storageAccountId?: string;
  state?: string;
  image?: WorkspaceImageMeta;
}

/**
 * Result of {@link listAllWorkspacesAdmin}. `degraded` is TRUE when a
 * best-effort enrichment sub-query (item counts / last-activity or the
 * owner-role resolve) failed and its fields fell back to defaults (0 counts /
 * `[createdBy]` owners). It lets the UI distinguish "this workspace really has
 * 0 items" from "the count store was unreachable", instead of both looking
 * identical (rel-T108). `degradedReasons` names which enrichment(s) fell back.
 */
export interface AdminWorkspacesResult {
  workspaces: WorkspaceAdminRecord[];
  degraded: boolean;
  degradedReasons: string[];
  /**
   * #3826 — how many workspace records were EXCLUDED because they record no
   * `tid` and therefore cannot be positively matched to any tenant. Surfaced so
   * a legacy estate cannot silently read as a SHORTER inventory: 0 counts and a
   * missing row look identical otherwise, which is the exact failure this
   * module's `degraded` flag already exists to prevent (rel-T108).
   */
  legacyUnstampedExcluded: number;
  /**
   * TRUE when the disclosure aggregate itself did not run, so
   * {@link legacyUnstampedExcluded} is 0 because nothing was COUNTED — never
   * because nothing was excluded. STRUCTURAL, for the same reason
   * {@link TenantWorkspaceTagsResult.scopeUnconfirmed} is: a consumer must be
   * able to tell "the count is zero" from "I could not count" without matching
   * a `degradedReasons` spelling.
   */
  legacyCountUnavailable: boolean;
  /**
   * The disclosure text for whichever legacy-count state is set: the backfill
   * remediation for a non-zero {@link legacyUnstampedExcluded}, or the
   * could-not-be-read notice when {@link legacyCountUnavailable} is true. Read
   * the two booleans FIRST — this string does not discriminate them.
   */
  legacyRemediation?: string;
}

/**
 * The tenant this inventory is scoped to. REQUIRED, and an object rather than a
 * bare string, for the same reason `WorkspaceAccessOpts` is
 * (`lib/auth/workspace-access.ts`): a tenant-wide fan-out must not be
 * scope-able by OMISSION, and adding a call site that forgets the scope has to
 * be a COMPILE ERROR rather than a silent cross-tenant read.
 *
 * `callerTid` is `session.claims.tid` — NOT `tenantScopeId(session)`, which
 * falls back to the caller's `oid` when the tid claim is absent and so cannot
 * be told apart from a real tenant id by looking at it.
 */
export interface AdminWorkspaceScope {
  /** The caller's Entra tenant id. `undefined` is accepted and FAILS CLOSED. */
  callerTid: string | undefined;
}

/** One tenant-wide workspace row, id + domain tag only. */
export interface TenantWorkspaceTag {
  id: string;
  domain?: string;
}

export interface TenantWorkspaceTagsResult {
  workspaces: TenantWorkspaceTag[];
  /**
   * TRUE when the caller's tenancy could not be established, so NO read ran and
   * `workspaces` is empty by REFUSAL rather than because the tenant is empty.
   *
   * This is a STRUCTURAL discriminator on purpose. Consumers that must fail
   * closed (the mesh panel zeroes its rollup and shows a gate) previously had to
   * branch on `degraded`, which now also goes true for a merely INCOMPLETE
   * answer — a legacy estate with unstamped rows. Keying that branch on the
   * spelling of a `degradedReasons` entry would put the fail-closed path one
   * string rename away from silently reading a partial rollup as authoritative.
   */
  scopeUnconfirmed: boolean;
  degraded: boolean;
  degradedReasons: string[];
  /**
   * How many workspace records carry NO `tid` and are therefore excluded from
   * this tenant-scoped answer. Mirrors {@link AdminWorkspacesResult}; see
   * {@link countUnstampedWorkspaces} for why it must travel with the count.
   */
  legacyUnstampedExcluded: number;
  /**
   * TRUE when the disclosure aggregate itself did not run. Mirrors
   * {@link AdminWorkspacesResult.legacyCountUnavailable}: 0 then means NOT
   * COUNTED, not "nothing excluded".
   */
  legacyCountUnavailable: boolean;
  /**
   * The disclosure text for whichever legacy-count state is set — the backfill
   * remediation, or the could-not-be-read notice. Mirrors
   * {@link AdminWorkspacesResult.legacyRemediation}.
   */
  legacyRemediation?: string;
}

/**
 * How many workspace records exist that NO tenant can claim.
 *
 * Every tenant-scoped read in this file uses `WHERE c.tid = @tid`, and Cosmos
 * `=` does not match a property that is not defined — so a workspace created
 * before rel-T11 (which stamps `tid`) is silently absent from the result. A
 * count that excludes rows it cannot attribute is HONEST only if it says so;
 * without this disclosure a caller reports a shorter number as complete.
 *
 * IT RETURNS WHETHER IT ESTABLISHED THE NUMBER, NOT JUST THE NUMBER. This is a
 * disclosure ABOUT the answer and must never fail the inventory it annotates —
 * but the earlier version of this helper discharged that by returning a bare
 * `0` from its `catch`, which every caller then reported as "nothing was
 * excluded, the answer is COMPLETE". Measured in review of PR #4316: with only
 * this aggregate rejecting (`Request rate is large (429)`) while the scoped
 * read succeeded, `listTenantWorkspaceTags` answered
 * `{degraded:false, legacyUnstampedExcluded:0}` — the exact
 * assert-completeness-you-did-not-establish state (R7) that the disclosure
 * exists to prevent, reached through the swallow instead of through a missing
 * predicate. `established:false` makes "I could not count" a state a caller
 * cannot render as a count.
 *
 * A cross-partition `COUNT(1)` runs on every `/admin/domains` load and every
 * mesh load, so RU-pressure rejection here is an ordinary condition, not a
 * corner.
 */
async function countUnstampedWorkspaces(
  wsC: Awaited<ReturnType<typeof workspacesContainer>>,
): Promise<{ count: number; established: boolean }> {
  try {
    const { resources } = await wsC.items
      .query<{ n: number }>({ query: 'SELECT VALUE COUNT(1) FROM c WHERE NOT IS_DEFINED(c.tid)' })
      .fetchAll();
    return { count: Number(resources?.[0] ?? 0) || 0, established: true };
  } catch {
    return { count: 0, established: false };
  }
}

/**
 * The disclosure for a count that could not be read at all.
 *
 * It says only what the code established — the aggregate did not answer — and
 * NOT how many records are excluded, which is precisely what is unknown here.
 */
const UNSTAMPED_COUNT_UNAVAILABLE =
  'Loom could not read how many workspace records carry no Entra tenant, so the count above may ' +
  'exclude records it cannot attribute to your tenant — that number is UNKNOWN, not zero. The ' +
  'disclosure query (`SELECT VALUE COUNT(1) FROM c WHERE NOT IS_DEFINED(c.tid)`) is a ' +
  'cross-partition aggregate and is the first thing Cosmos rejects under RU pressure; retry the ' +
  'page. Run `node scripts/csa-loom/backfill-workspace-tid.mjs` (DRY-RUN by default) to see ' +
  'whether any unstamped records exist.';

/** The one remediation text for a non-zero unstamped count. */
function unstampedRemediation(n: number): string | undefined {
  return n
    ? `${n} workspace record(s) record no Entra tenant (workspaces created ` +
      'before rel-T11 were not stamped) and are therefore excluded from every tenant-scoped ' +
      'inventory — Loom will not show a record it cannot positively attribute to your tenant. ' +
      'Run `node scripts/csa-loom/backfill-workspace-tid.mjs` to see what it would change (it is ' +
      'DRY-RUN by default), then re-run it with `--apply`.'
    : undefined;
}

/**
 * Every workspace IN THE CALLER'S TENANT, id + domain tag only (#3747).
 *
 * THE ONE counter behind both Domains panels. Before this existed the
 * "Federated data-mesh" summary and the domain List each computed their own
 * workspace count from a DIFFERENT wrong scope, and disagreed on screen:
 *
 *   - `domain-mesh.readWorkspaceTags` queried `WHERE c.tenantId = @t` with
 *     `{ partitionKey: ownerOid }` — `Workspace.tenantId` holds the CREATOR's
 *     oid, so that is one creator's workspaces, not the tenant's.
 *   - `/api/admin/domains workspaceCounts` did the same with
 *     `tenantScopeId(session)`, which is the real Entra tid when the claim is
 *     present — and no workspace doc is partitioned by a tid, so it read an
 *     empty partition and reported 0 for every domain.
 *
 * The correct tenant-wide shape is `WHERE c.tid = @tid` with NO `partitionKey`
 * option (cross-partition fan-out), exactly as `listAllWorkspacesAdmin` does:
 * `tid` is the stamped Entra tenant, `tenantId` is the partition key holding a
 * creator oid. Passing a `partitionKey` here is the bug, not an optimisation.
 *
 * Fails CLOSED on an unconfirmed tenancy, mirroring `listAllWorkspacesAdmin`:
 * with no caller tid there is no positive match to make, so the result is empty
 * with a named reason rather than an unscoped read.
 *
 * CARRIES THE LEGACY DISCLOSURE. `WHERE c.tid = @tid` cannot match a record
 * that has no `tid`, and workspaces created before rel-T11 have none — so this
 * counter, like `listAllWorkspacesAdmin`, answers a SHORTER list than the
 * container holds. `/admin/workspaces` already discloses that; when this
 * function did not, the two Domains panels reported the shorter number with no
 * notice and disagreed with the workspace inventory — the same cross-surface
 * disagreement this shared counter exists to remove, one surface over. The
 * count travels WITH the result so no consumer can report it as complete.
 */
export async function listTenantWorkspaceTags(
  scope: AdminWorkspaceScope,
): Promise<TenantWorkspaceTagsResult> {
  if (!scope.callerTid) {
    return {
      workspaces: [],
      scopeUnconfirmed: true,
      degraded: true,
      degradedReasons: ['tenant-scope-unconfirmed'],
      // No read ran, so nothing was EXCLUDED by a tenant predicate — reporting a
      // legacy count here would assert something this call did not establish.
      legacyUnstampedExcluded: 0,
      legacyCountUnavailable: false,
    };
  }
  const wsC = await workspacesContainer();
  const [tagged, unstamped] = await Promise.all([
    wsC.items
      .query<TenantWorkspaceTag>({
        query: 'SELECT c.id, c.domain FROM c WHERE c.tid = @tid',
        parameters: [{ name: '@tid', value: scope.callerTid }],
      })
      .fetchAll(),
    countUnstampedWorkspaces(wsC),
  ]);
  // The count is only a count when it was ESTABLISHED. When the aggregate did
  // not answer, this stays 0 AND `legacyCountUnavailable` says why — the two
  // together are what stop a caller reading 0 as "nothing excluded".
  const legacyUnstampedExcluded = unstamped.established ? unstamped.count : 0;
  const legacyCountUnavailable = !unstamped.established;
  const legacyRemediation = legacyCountUnavailable
    ? UNSTAMPED_COUNT_UNAVAILABLE
    : unstampedRemediation(legacyUnstampedExcluded);
  // TWO distinct non-complete states, each named. Collapsing them would put an
  // unreadable disclosure back on the "complete" path, which is the #4316
  // review's blocker 1.
  const degradedReasons: string[] = [];
  if (legacyCountUnavailable) degradedReasons.push('legacy-count-unavailable');
  else if (legacyUnstampedExcluded > 0) degradedReasons.push('legacy-unstamped-excluded');
  return {
    workspaces: (tagged.resources || []).filter((w) => !!w?.id),
    scopeUnconfirmed: false,
    // An answer that excludes records it cannot attribute is INCOMPLETE, and so
    // is one whose exclusion count could not be read at all. Every consumer must
    // be able to see that without knowing this query's text.
    degraded: degradedReasons.length > 0,
    degradedReasons,
    legacyUnstampedExcluded,
    legacyCountUnavailable,
    ...(legacyRemediation ? { legacyRemediation } : {}),
  };
}

/**
 * Enumerate every workspace IN THE CALLER'S TENANT with live item counts,
 * last-activity, and resolved owners. Cross-partition Cosmos reads only.
 *
 * #3826 — THIS USED TO BE `SELECT * FROM c` WITH NO TENANT PREDICATE. The
 * `workspaces` container is partitioned on `/tenantId`, which in this codebase
 * holds the CREATING USER'S OID, not an Entra tenant — so the fan-out that makes
 * the admin inventory work at all also crossed every tenant in the account. The
 * `isTenantAdmin` gate on the route in front of it does not narrow the result:
 * it establishes that the caller is AN admin, never WHICH tenant they administer.
 * Two consumers took the unfiltered set — the `/admin/workspaces` inventory
 * (names, owners, domains, storage account ids) and
 * `lib/azure/workspace-chargeback.ts`, which additionally ALLOCATED one tenant's
 * real Cost Management dollars across another tenant's workspaces.
 *
 * THE SCOPE IS APPLIED IN THE QUERY, not by filtering afterwards, so a row from
 * another tenant is never materialised, never enriched, and never counted. A
 * caller with no `tid` gets an EMPTY inventory and a named reason: with no
 * caller tenant there is no positive match to make, and per
 * `lib/auth/tenant-boundary.ts` an unconfirmed tenancy is a refusal, never a
 * fall-through.
 *
 * The primary workspace scan is authoritative — it THROWS on failure (the route
 * genericizes it via apiServerError). The two enrichment sub-queries are
 * best-effort: a failure degrades their fields to defaults AND is surfaced via
 * the returned `degraded` flag so a store blip can't silently read as "empty".
 */
export async function listAllWorkspacesAdmin(scope: AdminWorkspaceScope): Promise<AdminWorkspacesResult> {
  const wsC = await workspacesContainer();

  // A tenant scope we could not establish is a REFUSAL, not an unfiltered read.
  if (!scope.callerTid) {
    return {
      workspaces: [],
      degraded: true,
      degradedReasons: ['tenant-scope-unconfirmed'],
      legacyUnstampedExcluded: 0,
      legacyCountUnavailable: false,
      legacyRemediation:
        'Your sign-in session carries no Entra tenant (`tid`) claim, so Loom cannot scope the ' +
        'tenant-wide workspace inventory to your tenant and will not run it unscoped. Sign out ' +
        'and sign in again to mint a session that carries `tid`. If you are calling with the ' +
        'CLI, re-run `loom auth login` — service-principal sessions minted before the #3845 ' +
        'fix carry no tenant.',
    };
  }

  // 1) Every workspace IN THIS TENANT, all partitions (no partitionKey option =
  //    cross-partition fan-out, now bounded by a tenant predicate).
  //    Case-sensitivity note: Entra tids are GUIDs and Cosmos `=` is
  //    case-sensitive, so this predicate is marginally STRICTER than
  //    `sameTenantConfirmed`'s normalised compare. Stricter is the safe
  //    direction for a scope — it can withhold a row, never admit a foreign one.
  const { resources: docs } = await wsC.items
    .query<RawWorkspaceDoc>({
      query: 'SELECT * FROM c WHERE c.tid = @tid',
      parameters: [{ name: '@tid', value: scope.callerTid }],
    })
    .fetchAll();

  // The reasons this inventory is not authoritative, accumulated in the order
  // they are established. Declared HERE, above the legacy count, so the
  // empty-tenant early return below reports the same degradations the full path
  // does — an unreadable disclosure must not read as clean just because the
  // tenant happens to hold no workspaces.
  const degradedReasons: string[] = [];

  // How many records exist that NO tenant can claim, so a legacy estate does not
  // silently read as a shorter list. Shared with `listTenantWorkspaceTags` so
  // the two surfaces cannot disclose different numbers for the same container.
  // `established:false` is a DEGRADATION, not a zero: see
  // `countUnstampedWorkspaces`.
  const unstamped = await countUnstampedWorkspaces(wsC);
  const legacyUnstampedExcluded = unstamped.established ? unstamped.count : 0;
  const legacyCountUnavailable = !unstamped.established;
  if (legacyCountUnavailable) degradedReasons.push('legacy-count-unavailable');
  const legacyRemediation = legacyCountUnavailable
    ? UNSTAMPED_COUNT_UNAVAILABLE
    : unstampedRemediation(legacyUnstampedExcluded);

  if (docs.length === 0) {
    return {
      workspaces: [],
      degraded: degradedReasons.length > 0,
      degradedReasons,
      legacyUnstampedExcluded,
      legacyCountUnavailable,
      ...(legacyRemediation ? { legacyRemediation } : {}),
    };
  }

  const ids = docs.map((w) => w.id);
  const inParams = ids.map((id, i) => ({ name: `@w${i}`, value: id }));
  const inExpr = inParams.map((p) => p.name).join(',');

  // 2) Batch item-count + last-activity for ALL workspaces in one cross-partition
  //    GROUP BY (same proven pattern as GET /api/workspaces?count=true). Degrades
  //    gracefully to zero counts if the aggregate fails (e.g. RU pressure) — and
  //    records the degradation so the caller can flag it.
  const counts = new Map<string, number>();
  const lastActivity = new Map<string, string>();
  try {
    const itC = await itemsContainer();
    const { resources: rows } = await itC.items
      .query<{ workspaceId: string; n: number; lastActivity?: string }>({
        query: `SELECT c.workspaceId, COUNT(1) AS n, MAX(c.updatedAt) AS lastActivity
                FROM c WHERE c.workspaceId IN (${inExpr}) GROUP BY c.workspaceId`,
        parameters: inParams,
      })
      .fetchAll();
    for (const r of rows) {
      if (!r?.workspaceId) continue;
      counts.set(r.workspaceId, r.n ?? 0);
      if (r.lastActivity) lastActivity.set(r.workspaceId, r.lastActivity);
    }
  } catch {
    // leave counts/lastActivity empty — records fall back to 0 / workspace.updatedAt
    degradedReasons.push('item-counts');
  }

  // 3) Resolve owners: creator + every Admin-role principal (F5 workspace-roles).
  //    Cross-partition read; failure degrades to owners = [createdBy].
  const adminsByWs = new Map<string, Set<string>>();
  try {
    const rolesC = await workspaceRolesContainer();
    const { resources: roleRows } = await rolesC.items
      .query<{ workspaceId: string; displayName?: string; role?: string }>({
        query: `SELECT c.workspaceId, c.displayName, c.role
                FROM c WHERE c.workspaceId IN (${inExpr}) AND c.role = @admin`,
        parameters: [...inParams, { name: '@admin', value: 'Admin' }],
      })
      .fetchAll();
    for (const r of roleRows) {
      if (!r?.workspaceId || !r.displayName) continue;
      let set = adminsByWs.get(r.workspaceId);
      if (!set) { set = new Set<string>(); adminsByWs.set(r.workspaceId, set); }
      set.add(r.displayName);
    }
  } catch {
    // leave adminsByWs empty — owners fall back to [createdBy]
    degradedReasons.push('owner-roles');
  }

  const workspaces = docs.map((w) => {
    const createdBy = w.createdBy || w.tenantId || 'unknown';
    const owners = new Set<string>();
    if (createdBy) owners.add(createdBy);
    for (const a of adminsByWs.get(w.id) ?? []) owners.add(a);
    return {
      id: w.id,
      tenantId: w.tenantId || createdBy,
      name: w.name || w.id,
      description: w.description,
      createdBy,
      createdAt: w.createdAt || w.updatedAt || '',
      updatedAt: w.updatedAt || w.createdAt || '',
      capacity: w.capacity,
      domain: w.domain,
      storageAccountId: w.storageAccountId,
      state: normalizeState(w.state),
      itemCount: counts.get(w.id) ?? 0,
      lastActivity: lastActivity.get(w.id) ?? w.updatedAt ?? w.createdAt ?? '',
      owners: Array.from(owners),
      ...(w.image ? { image: w.image } : {}),
    };
  });

  return {
    workspaces,
    degraded: degradedReasons.length > 0,
    degradedReasons,
    legacyUnstampedExcluded,
    legacyCountUnavailable,
    ...(legacyRemediation ? { legacyRemediation } : {}),
  };
}

/**
 * Load ONE workspace by id across EVERY partition — the admin-scoped counterpart
 * to the owner point-read `container.item(id, ownerOid).read()`.
 *
 * Each workspace doc is partitioned by `/tenantId` where `tenantId === the
 * creating user's oid`, so an admin acting on a workspace they did not create
 * does not know its partition key. A single `SELECT * FROM c WHERE c.id = @id`
 * with NO `{ partitionKey }` option fans the read out across all partitions and
 * returns the one matching doc (ids are unique account-wide in this container).
 *
 * SECURITY: this bypasses partition isolation AND carries no tenant predicate,
 * so it must ONLY be called AFTER a tenant-admin check AND with its result
 * subjected to the tenant boundary — see `resolveAdminWorkspace` in
 * lib/auth/workspace-guard.ts, which does both.
 *
 * #3826 — AN EARLIER VERSION OF THIS PARAGRAPH SAID `resolveAdminWorkspace` IS
 * "the single caller that gates it". THAT WAS FALSE, and a doc claim the code
 * did not establish is the R7 defect this repo tracks by name. Measured on this
 * tree there are TWO executable callers: `resolveAdminWorkspace`, and
 * `getPbiWorkspaceMapping` (`lib/azure/powerbi-workspace-mapping.ts:68`), which
 * takes no session and applies no tenant boundary of its own. Its one caller
 * (`app/api/items/report/[id]/publish/route.ts:120`) passes an already-authorized
 * `item.workspaceId`, so it is not currently reachable with an attacker-chosen
 * id — but that is a property of ITS CALLER, not of this function, and it is
 * exactly the assumption the sentence above got wrong once already. Tracked for
 * the owner of that module; do NOT read this note as a clearance.
 *
 * Mirrors {@link listAllWorkspacesAdmin}'s query style + error handling. Returns
 * `null` when no workspace has that id.
 */
export async function loadWorkspaceAdmin(id: string): Promise<Workspace | null> {
  const wsC = await workspacesContainer();
  const { resources } = await wsC.items
    .query<Workspace>({
      query: 'SELECT * FROM c WHERE c.id = @id',
      parameters: [{ name: '@id', value: id }],
    })
    .fetchAll();
  return resources[0] ?? null;
}
