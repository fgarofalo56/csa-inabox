/**
 * LU-4 — Unity Catalog **effective-permissions resolver** (inheritance walk).
 *
 * Databricks Unity Catalog exposes `GET /effective-permissions/{securable}/{name}`,
 * which answers "what can this principal actually do here?" after inheritance,
 * ownership and group membership are resolved. The OSS Unity Catalog server
 * (`loom-unity`, the Azure-Government default per `no-fabric-dependency.md`)
 * implements only the *direct* grants surface (`/permissions/...`), so Loom used
 * to gate the feature as Databricks-only. This module removes that gate: the
 * BFF composes the answer from the direct grants it CAN read, following the
 * composition Unity Catalog itself specifies.
 *
 * Everything here is PURE — no fetch, no credentials, no env reads — so it is
 * unit-testable and safe to import from a client component (the grants pane
 * shares {@link UC_PRIVILEGES_BY_SECURABLE} with it). The I/O adapter that
 * feeds it real REST responses is `uc-effective-permissions-live.ts`
 * (`computeEffectivePermissions`); the ONLY edge from this file to the UC client
 * is an `import type`, which TypeScript erases — see the "client-safe" spec in
 * `__tests__/uc-effective-permissions.test.ts`, which fails if that ever becomes
 * a value import and drags `@azure/identity` into the browser bundle.
 *
 * ── The rules, each grounded in Microsoft Learn (NOT from memory) ────────────
 *
 *  1. **Privilege inheritance is downward and resolved at READ time.**
 *     "When you grant a privilege on a parent object, that privilege
 *     automatically applies to all current and future child objects."
 *     — Learn, *Unity Catalog permissions model concepts § Privilege
 *     inheritance*. So the walk starts at the target and climbs its containment
 *     ancestors; a privilege granted on `main` in January is returned for a
 *     table created in March, and nothing is materialized so nothing goes stale.
 *     Metastore grants are excluded: "Privileges granted on a metastore do not
 *     inherit to child objects" (same page).
 *
 *  2. **Ownership does NOT inherit downward.** "Ownership doesn't inherit
 *     downward in Unity Catalog. As the owner of an object, you're automatically
 *     granted all privileges on that object *only*. … However, you do
 *     automatically get the `MANAGE` privilege on all new and existing child
 *     objects" and "Because ownership doesn't inherit downward to child objects,
 *     owners still require explicit grants on those child objects."
 *     — Learn, *permissions-concepts § Privilege inheritance / § Ownership*.
 *     Therefore: owner of the TARGET → the target's full applicable set; owner
 *     of an ANCESTOR → {@link UC_OWNER_IMPLIED_ON_DESCENDANT} (`MANAGE`) and
 *     nothing else. Reporting SELECT/MODIFY for a catalog owner on a descendant
 *     table would be a false-positive on an access-review surface.
 *
 *  3. **`ALL PRIVILEGES` expands, it never vanishes.** "`ALL PRIVILEGES`
 *     *implies* all applicable privileges for a specific object type … does not
 *     include the `EXTERNAL USE SCHEMA`, `EXTERNAL USE LOCATION`, or `MANAGE`
 *     privileges." — Learn, *permissions-concepts § ALL PRIVILEGES behavior*.
 *     A grant of `ALL PRIVILEGES` on a catalog therefore lands on a descendant
 *     table as SELECT + MODIFY + APPLY_TAG, never as an empty answer.
 *
 *  4. **Usage privileges are prerequisites, and they are checked.** "To read
 *     from a table, a user needs `SELECT` on the table, `USE SCHEMA` on the
 *     parent schema, and `USE CATALOG` on the parent catalog. … All three are
 *     required." — Learn, *permissions-concepts § Usage privileges*. Owners are
 *     exempt ("Requires usage privileges — Owner: No"; *§ Ownership versus the
 *     MANAGE privilege*). So every answer carries {@link UcEffectiveAssignment.usage}
 *     and any privilege whose prerequisites are unmet is returned with
 *     `blocked_by` set — reported, never silently promoted to "can read".
 *
 *  5. **Group membership is transitive**, including nested groups. The closure
 *     walk is breadth-first over a visited set, so a membership CYCLE
 *     (a ∈ b, b ∈ c, c ∈ a — which Entra forbids but a Loom-native or SCIM-fed
 *     group source can still produce) terminates instead of hanging the BFF.
 *
 *  6. **The privilege vocabulary is backend-narrowed.** The OSS Unity Catalog
 *     0.5 server implements neither `MANAGE` nor `BROWSE` nor `APPLY TAG`, so on
 *     that backend the answer must not claim them — pass `{ oss: true }` and the
 *     resolver uses {@link ucPrivilegesFor}`(type, { oss: true })` throughout.
 *
 * Privilege spellings are normalized to the underscore form the Loom UI uses
 * (`USE_CATALOG`); the OSS server spells the same privilege `USE CATALOG`.
 */
import type { UCSecurableType, UCPermissionAssignment } from '@/lib/azure/unity-catalog-client';

// ============================================================
// The privilege model
// ============================================================

/**
 * Every privilege that is *applicable* at each securable type. This is the
 * inheritance filter: a privilege granted on a parent flows to a child only when
 * the child's type accepts it (granting `CREATE_SCHEMA` on a catalog does NOT
 * make it an effective privilege on a table), it is the expansion of
 * `ALL PRIVILEGES` at that type, and it is the set an OWNER of THAT object
 * implicitly holds.
 *
 * Single source of truth for the grants pane's checkbox grid too — the pane
 * imports this rather than keeping a second copy.
 */
export const UC_PRIVILEGES_BY_SECURABLE: Record<UCSecurableType, string[]> = {
  METASTORE: ['CREATE_CATALOG', 'CREATE_EXTERNAL_LOCATION', 'CREATE_STORAGE_CREDENTIAL', 'CREATE_CONNECTION', 'CREATE_SHARE', 'CREATE_RECIPIENT', 'CREATE_PROVIDER'],
  CATALOG: ['USE_CATALOG', 'USE_SCHEMA', 'CREATE_SCHEMA', 'CREATE_TABLE', 'CREATE_FUNCTION', 'CREATE_VOLUME', 'CREATE_MODEL', 'SELECT', 'MODIFY', 'EXECUTE', 'READ_VOLUME', 'WRITE_VOLUME', 'BROWSE', 'APPLY_TAG', 'EXTERNAL_USE_SCHEMA', 'MANAGE'],
  SCHEMA: ['USE_SCHEMA', 'CREATE_TABLE', 'CREATE_FUNCTION', 'CREATE_VOLUME', 'CREATE_MODEL', 'SELECT', 'MODIFY', 'EXECUTE', 'READ_VOLUME', 'WRITE_VOLUME', 'APPLY_TAG', 'EXTERNAL_USE_SCHEMA', 'MANAGE'],
  TABLE: ['SELECT', 'MODIFY', 'APPLY_TAG', 'MANAGE'],
  VOLUME: ['READ_VOLUME', 'WRITE_VOLUME', 'APPLY_TAG', 'MANAGE'],
  FUNCTION: ['EXECUTE', 'APPLY_TAG', 'MANAGE'],
  REGISTERED_MODEL: ['EXECUTE', 'APPLY_TAG', 'MANAGE'],
  EXTERNAL_LOCATION: ['CREATE_EXTERNAL_TABLE', 'CREATE_EXTERNAL_VOLUME', 'READ_FILES', 'WRITE_FILES', 'CREATE_MANAGED_STORAGE', 'BROWSE', 'MANAGE'],
  STORAGE_CREDENTIAL: ['CREATE_EXTERNAL_LOCATION', 'CREATE_EXTERNAL_TABLE', 'READ_FILES', 'WRITE_FILES', 'MANAGE'],
};

/** Privileges the OSS Unity Catalog 0.5 spec does not define — hidden on that
 *  backend so the pane never offers a grant the server will reject, AND so the
 *  effective answer never claims a privilege that backend cannot enforce. */
export const UC_DBX_ONLY_PRIVILEGES = new Set([
  'BROWSE', 'MANAGE', 'APPLY_TAG', 'EXTERNAL_USE_SCHEMA', 'EXTERNAL_USE_LOCATION',
  'CREATE_CONNECTION', 'CREATE_SHARE', 'CREATE_RECIPIENT', 'CREATE_PROVIDER', 'CREATE_MANAGED_STORAGE',
]);

/** The wire spelling of the "everything applicable here" grant, post-normalize. */
export const UC_ALL_PRIVILEGES = 'ALL_PRIVILEGES';

/**
 * What `ALL PRIVILEGES` deliberately does NOT imply.
 * Learn (*permissions-concepts § ALL PRIVILEGES behavior*): "`ALL PRIVILEGES`
 * does not include the `EXTERNAL USE SCHEMA`, `EXTERNAL USE LOCATION`, or
 * `MANAGE` privileges" — the first two to avoid accidental data exfiltration,
 * `MANAGE` to avoid accidental privilege escalation.
 */
export const UC_ALL_PRIVILEGES_EXCLUDES = new Set(['MANAGE', 'EXTERNAL_USE_SCHEMA', 'EXTERNAL_USE_LOCATION']);

/**
 * The ONLY privilege an owner of an ANCESTOR implicitly holds on a descendant.
 * Learn (*permissions-concepts § Privilege inheritance*): "you do automatically
 * get the `MANAGE` privilege on all new and existing child objects". Everything
 * else requires an explicit grant.
 */
export const UC_OWNER_IMPLIED_ON_DESCENDANT = 'MANAGE';

/** Normalize a privilege to the underscore form the Loom UI uses. Databricks
 *  says `USE_CATALOG`; OSS Unity Catalog says `USE CATALOG`. */
export function normalizeUcPrivilege(v: string): string {
  return String(v || '').toUpperCase().trim().replace(/\s+/g, '_');
}

/** The privileges offerable at a securable type, optionally narrowed to what
 *  the OSS Unity Catalog server accepts. Unknown types yield `[]` rather than
 *  throwing — the grants pane keeps its securable as a plain string. */
export function ucPrivilegesFor(securableType: string, opts?: { oss?: boolean }): string[] {
  const all = UC_PRIVILEGES_BY_SECURABLE[securableType as UCSecurableType] || [];
  return opts?.oss ? all.filter((p) => !UC_DBX_ONLY_PRIVILEGES.has(p)) : all;
}

/**
 * Expand `ALL PRIVILEGES` at a securable type, per Learn's exclusion list.
 * Returns `[]` for an unknown type (the caller then keeps the literal grant).
 */
export function expandAllPrivileges(securableType: string, opts?: { oss?: boolean }): string[] {
  return ucPrivilegesFor(securableType, opts).filter((p) => !UC_ALL_PRIVILEGES_EXCLUDES.has(p));
}

// ============================================================
// Securable containment
// ============================================================

export interface UcSecurableRef {
  type: UCSecurableType;
  /** Full name (`main`, `main.sales`, `main.sales.orders`); `''` for METASTORE. */
  name: string;
}

/**
 * The containment chain for a securable, **target first, root last**:
 *
 *   TABLE main.sales.orders → [TABLE main.sales.orders, SCHEMA main.sales, CATALOG main]
 *   SCHEMA main.sales       → [SCHEMA main.sales, CATALOG main]
 *   CATALOG main            → [CATALOG main]
 *
 * The walk deliberately stops at the catalog: "Privileges granted on a metastore
 * do not inherit to child objects" (Learn, *permissions-concepts § Privilege
 * inheritance*), and OSS Unity Catalog's `metastore_summary` carries no `owner`,
 * so a metastore node could only add a guaranteed round-trip. METASTORE,
 * EXTERNAL_LOCATION and STORAGE_CREDENTIAL are metastore-level securables with
 * no parent, so each is its own single-element chain.
 *
 * A malformed / partially-qualified name yields ONLY what the name fully
 * supports — never an invented ancestor. `TABLE main.orders` (2 parts where 3
 * are required) resolves to `[TABLE main.orders]`, not to a read against a
 * catalog `main` whose grants would then be attributed to a securable that does
 * not exist.
 */
export function ucSecurableChain(type: UCSecurableType, fullName: string): UcSecurableRef[] {
  const name = (fullName || '').trim();
  if (type === 'METASTORE') return [{ type: 'METASTORE', name: '' }];
  if (type === 'EXTERNAL_LOCATION' || type === 'STORAGE_CREDENTIAL') return [{ type, name }];
  const parts = name.split('.').filter(Boolean);
  const chain: UcSecurableRef[] = [{ type, name }];
  if (type === 'CATALOG') return chain;
  if (type === 'SCHEMA') {
    // catalog.schema — exactly the 2-part form, nothing inferred from 1 part.
    if (parts.length === 2) chain.push({ type: 'CATALOG', name: parts[0] });
    return chain;
  }
  // TABLE | VOLUME | FUNCTION | REGISTERED_MODEL — catalog.schema.object. A
  // 2-part name is under-qualified: neither ancestor is knowable from it.
  if (parts.length === 3) {
    chain.push({ type: 'SCHEMA', name: `${parts[0]}.${parts[1]}` });
    chain.push({ type: 'CATALOG', name: parts[0] });
  }
  return chain;
}

// ============================================================
// Transitive (nested) group membership
// ============================================================

/** Returns the groups a principal is a DIRECT member of, by the name Unity
 *  Catalog grants are keyed on (UPN for users, display name for groups). */
export type UcDirectGroupsResolver = (principalName: string) => Promise<string[]>;

export interface UcPrincipalClosure {
  /** The principal plus every group it transitively belongs to, de-duplicated
   *  case-insensitively, with the original casing of first sighting. */
  closure: string[];
  /** Just the groups (closure minus the principal itself). */
  groups: string[];
  /** True when the walk hit `maxPrincipals` / `maxDepth` / `deadlineMs` and
   *  stopped early — the result is then a SUBSET and the caller must say so
   *  rather than imply it is the complete answer. */
  truncated: boolean;
}

/**
 * Breadth-first closure over group membership. Nested groups are followed to
 * `maxDepth`; a principal already visited is never expanded twice, which is what
 * makes a membership **cycle** (a ∈ b ∈ c ∈ a) terminate rather than recurse
 * forever. Bounded by `maxPrincipals` AND by a wall clock (`deadlineMs`) so a
 * pathological or slow directory cannot pin the BFF either.
 *
 * `directGroups` failures are contained: a principal whose parents cannot be
 * read contributes nothing, and the closure returned is still valid (just
 * smaller). The caller surfaces the reason — never a silent "no access".
 */
export async function expandPrincipalClosure(
  principal: string,
  directGroups: UcDirectGroupsResolver,
  opts?: {
    maxDepth?: number;
    maxPrincipals?: number;
    /** Wall clock for the whole walk. Elapsed → stop and report `truncated`. */
    deadlineMs?: number;
    now?: () => number;
    onError?: (principal: string, err: unknown) => void;
  },
): Promise<UcPrincipalClosure> {
  const maxDepth = opts?.maxDepth ?? 10;
  const maxPrincipals = opts?.maxPrincipals ?? 200;
  const deadlineMs = opts?.deadlineMs ?? 10_000;
  const now = opts?.now ?? (() => Date.now());
  const startedAt = now();
  const root = (principal || '').trim();
  if (!root) return { closure: [], groups: [], truncated: false };

  const seen = new Map<string, string>([[root.toLowerCase(), root]]);
  let frontier = [root];
  let truncated = false;

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    if (now() - startedAt >= deadlineMs) { truncated = true; break; }
    const next: string[] = [];
    // One level at a time, in parallel — the directory calls dominate latency.
    const results = await Promise.all(
      frontier.map(async (p) => {
        try {
          return await directGroups(p);
        } catch (e) {
          opts?.onError?.(p, e);
          return [] as string[];
        }
      }),
    );
    for (const groups of results) {
      for (const g of groups) {
        const name = (g || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;          // ← the cycle guard
        if (seen.size >= maxPrincipals) { truncated = true; continue; }
        seen.set(key, name);
        next.push(name);
      }
    }
    if (truncated) break;
    frontier = next;
  }
  if (frontier.length > 0) truncated = true;  // stopped on maxDepth with work left

  const closure = [...seen.values()];
  return { closure, groups: closure.slice(1), truncated };
}

// ============================================================
// The resolver
// ============================================================

/** One node of the containment chain, with the facts read from the catalog. */
export interface UcSecurableNode extends UcSecurableRef {
  /** The securable's owner, when the backend reports one. */
  owner?: string;
  /** DIRECT grants recorded on this securable (`/permissions/...`). */
  assignments: UCPermissionAssignment[];
  /** Set by the live adapter when this node's grants could NOT be read (403 on
   *  a parent, transport error…). The resolver then reports usage prerequisites
   *  anchored here as `unknown` rather than asserting they are missing. */
  unreadable?: boolean;
  /** Set when the node's OWNER could not be read (same honesty rule). */
  ownerUnreadable?: boolean;
}

export type UcPrivilegeSource = 'GRANT' | 'OWNERSHIP';

/** One effective privilege, with the provenance that explains WHY it is held.
 *  Field names mirror the Databricks `EffectivePrivilege` shape so the BFF can
 *  format both backends through one function. */
export interface UcEffectivePrivilege {
  privilege: string;
  /** Set when the privilege comes from an ancestor rather than this securable. */
  inherited_from_type?: UCSecurableType;
  inherited_from_name?: string;
  /** Set when the grant landed on a GROUP the queried principal belongs to
   *  (possibly through nesting) rather than on the principal itself. */
  via_principal?: string;
  /** GRANT (an explicit privilege assignment) vs OWNERSHIP (implied by owning
   *  the securable or, for `MANAGE` only, one of its ancestors). Databricks
   *  omits it; treat undefined as GRANT. */
  source?: UcPrivilegeSource;
  /** Set when this row came from expanding an `ALL PRIVILEGES` grant. */
  implied_by?: typeof UC_ALL_PRIVILEGES;
  /** Usage prerequisites the principal does NOT hold, so this privilege is
   *  present but NOT exercisable ("Having only the `SELECT` privilege on a table
   *  is not sufficient to read it if you lack `USE CATALOG` or `USE SCHEMA`" —
   *  Learn). Rendered as a blocked badge; never silently dropped. */
  blocked_by?: string[];
}

/** One usage prerequisite (`USE CATALOG` / `USE SCHEMA`) evaluated for a
 *  principal at the securable that must carry it. */
export interface UcUsagePrerequisite {
  privilege: 'USE_CATALOG' | 'USE_SCHEMA';
  securable_type: UCSecurableType;
  securable_name: string;
  /** held → the principal has it · missing → it does not · unknown → the node
   *  was unreadable or absent from the chain, so no claim is made either way. */
  status: 'held' | 'missing' | 'unknown';
  /** Why it is held (a group grant, or ownership of that securable / an ancestor). */
  via_principal?: string;
  source?: UcPrivilegeSource;
}

export interface UcEffectiveAssignment {
  principal: string;
  privileges: UcEffectivePrivilege[];
  /** The `USE CATALOG` / `USE SCHEMA` prerequisites for exercising ANY privilege
   *  at this securable, and whether this principal holds them. Empty for
   *  metastore-level securables, which have no usage prerequisites. */
  usage?: UcUsagePrerequisite[];
}

/**
 * The wire shape `listEffectivePermissions` returns for BOTH backends — a
 * superset of the Databricks `PermissionsList` (whose `privilege_assignments`
 * carry `EffectivePrivilege` objects) plus the honesty fields the Loom resolver
 * adds. Lives here, with the pure model, so the I/O adapter and the UC client
 * can share it without importing each other.
 */
export interface UCEffectivePermissions {
  privilege_assignments?: UcEffectiveAssignment[];
  /** Operator-facing notes about anything the walk could NOT read (an ancestor
   *  the caller lacks permission on, a directory it cannot query). The result is
   *  still returned — a partial answer that SAYS it is partial beats a 500. */
  warnings?: string[];
  /** The queried principal plus every group it transitively belongs to, when a
   *  `principal` filter was used. Lets the pane show WHICH memberships counted. */
  principal_closure?: string[];
  /** True when a `principal` filter was used AND the transitive group closure
   *  was actually resolved from the directory. False when the closure is just
   *  `[principal]` because Graph was unavailable — the pane must NOT then say
   *  "…nor through any group it belongs to". */
  closure_resolved?: boolean;
}

export interface ResolveEffectiveOptions {
  /** Answer only for this principal ("what can Ada do here?"). Omit to return
   *  the effective set for every principal that appears anywhere on the chain. */
  principal?: string;
  /** The principal's transitive group closure from {@link expandPrincipalClosure}.
   *  Ignored unless `principal` is set; when omitted only the principal's own
   *  grants count. */
  principalClosure?: Iterable<string>;
  /** Narrow the privilege vocabulary to what the OSS Unity Catalog server
   *  implements, so a Gov answer never claims BROWSE / MANAGE / APPLY_TAG. */
  oss?: boolean;
  /** Called for each ancestor privilege the target type cannot express, so the
   *  caller can decide whether that is expected (CREATE_SCHEMA on a table) or
   *  worth a warning (an unmodeled privilege spelling). */
  onNotApplicable?: (privilege: string, from: UcSecurableRef) => void;
}

/**
 * How "close" a privilege's provenance is. Lower wins when the same principal
 * holds the same privilege by several routes, so the answer always explains the
 * MOST direct reason: a direct grant here beats a group grant here beats
 * ownership here beats anything inherited from a parent.
 */
function provenanceRank(distance: number, p: UcEffectivePrivilege): number {
  return distance * 4 + (p.source === 'OWNERSHIP' ? 2 : 0) + (p.via_principal ? 1 : 0);
}

/** Which usage prerequisites gate the target, and which chain node carries each.
 *  Learn, *permissions-concepts § Usage privileges*: `USE CATALOG` on the parent
 *  catalog + `USE SCHEMA` on the parent schema are required for tables, views,
 *  volumes and functions; `USE CATALOG` alone for a schema. Metastore-level
 *  securables (external locations, storage credentials) have none. */
function usagePrerequisiteRefs(chain: UcSecurableNode[]): Array<{ privilege: 'USE_CATALOG' | 'USE_SCHEMA'; nodeIndex: number; type: UCSecurableType; name: string }> {
  const target = chain[0];
  const out: Array<{ privilege: 'USE_CATALOG' | 'USE_SCHEMA'; nodeIndex: number; type: UCSecurableType; name: string }> = [];
  const idxOf = (t: UCSecurableType) => chain.findIndex((n) => n.type === t);
  const push = (privilege: 'USE_CATALOG' | 'USE_SCHEMA', t: UCSecurableType) => {
    const i = idxOf(t);
    // Absent from the chain (partial name) → still declare the prerequisite, but
    // with no node to evaluate it against; the status becomes `unknown`.
    out.push({ privilege, nodeIndex: i, type: t, name: i >= 0 ? chain[i].name : '' });
  };
  switch (target.type) {
    case 'TABLE': case 'VOLUME': case 'FUNCTION': case 'REGISTERED_MODEL':
      push('USE_CATALOG', 'CATALOG'); push('USE_SCHEMA', 'SCHEMA'); break;
    case 'SCHEMA':
      push('USE_CATALOG', 'CATALOG'); push('USE_SCHEMA', 'SCHEMA'); break;
    case 'CATALOG':
      push('USE_CATALOG', 'CATALOG'); break;
    default:
      break; // METASTORE / EXTERNAL_LOCATION / STORAGE_CREDENTIAL
  }
  return out;
}

/** Every privilege spelling a grant on `node` confers at `node`'s own type,
 *  with `ALL PRIVILEGES` expanded. Used for the usage-prerequisite probe, which
 *  asks about the ANCESTOR's own vocabulary rather than the target's. */
function privilegesAt(node: UcSecurableNode, principals: Set<string> | null, oss: boolean): Map<string, { via?: string }> {
  const held = new Map<string, { via?: string }>();
  for (const a of node.assignments || []) {
    const grantee = (a.principal || '').trim();
    if (!grantee) continue;
    if (principals && !principals.has(grantee.toLowerCase())) continue;
    for (const raw of a.privileges || []) {
      const p = normalizeUcPrivilege(typeof raw === 'string' ? raw : String((raw as { privilege?: unknown })?.privilege ?? ''));
      if (!p) continue;
      const names = p === UC_ALL_PRIVILEGES ? expandAllPrivileges(node.type, { oss }) : [p];
      for (const n of names) if (!held.has(n)) held.set(n, { via: grantee });
    }
  }
  return held;
}

/**
 * Evaluate the usage prerequisites for one principal (identified by the set of
 * names it answers to — itself plus its group closure).
 */
function evaluateUsage(chain: UcSecurableNode[], principals: Set<string> | null, oss: boolean): UcUsagePrerequisite[] {
  return usagePrerequisiteRefs(chain).map((ref) => {
    const base: UcUsagePrerequisite = {
      privilege: ref.privilege, securable_type: ref.type, securable_name: ref.name, status: 'unknown',
    };
    if (ref.nodeIndex < 0) return base;                                   // not in the chain — no claim
    // Owners are exempt from usage privileges ("Requires usage privileges —
    // Owner: No", Learn § Ownership versus the MANAGE privilege), and owning a
    // container implies the ability to work with everything under it. So
    // ownership of the anchoring node OR of any of ITS ancestors satisfies it.
    for (let i = ref.nodeIndex; i < chain.length; i++) {
      const owner = (chain[i].owner || '').trim();
      if (!owner) continue;
      if (principals && !principals.has(owner.toLowerCase())) continue;
      return { ...base, status: 'held', source: 'OWNERSHIP', via_principal: owner };
    }
    // Otherwise an explicit grant of the usage privilege at that node or any of
    // its ancestors (USE SCHEMA granted on a catalog inherits to its schemas).
    let sawUnreadable = false;
    for (let i = ref.nodeIndex; i < chain.length; i++) {
      const node = chain[i];
      if (node.unreadable || node.ownerUnreadable) { sawUnreadable = true; continue; }
      if (i > ref.nodeIndex && !ucPrivilegesFor(node.type, { oss }).includes(ref.privilege)) continue;
      const held = privilegesAt(node, principals, oss);
      const hit = held.get(ref.privilege);
      if (hit) return { ...base, status: 'held', source: 'GRANT', ...(hit.via ? { via_principal: hit.via } : {}) };
    }
    return { ...base, status: sawUnreadable ? 'unknown' : 'missing' };
  });
}

/**
 * Resolve effective permissions at `chain[0]` from the direct grants + owners of
 * the whole containment chain.
 *
 * @param chain target-first containment chain (see {@link ucSecurableChain}),
 *              each node carrying the grants and owner read from the catalog.
 */
export function resolveEffectivePermissions(
  chain: UcSecurableNode[],
  opts: ResolveEffectiveOptions = {},
): UcEffectiveAssignment[] {
  if (chain.length === 0) return [];
  const target = chain[0];
  const oss = !!opts.oss;
  const applicableList = ucPrivilegesFor(target.type, { oss });
  const applicable = new Set(applicableList);

  const filterPrincipal = (opts.principal || '').trim();
  const closure = filterPrincipal
    ? new Set([...(opts.principalClosure || [filterPrincipal])].map((p) => String(p).toLowerCase()))
    : null;
  if (closure) closure.add(filterPrincipal.toLowerCase());

  // principal (lowercased) → privilege → { best provenance, its rank }
  const byPrincipal = new Map<string, { label: string; privs: Map<string, { p: UcEffectivePrivilege; rank: number }> }>();

  const record = (grantee: string, distance: number, priv: UcEffectivePrivilege) => {
    // When filtering, everything collapses under the queried principal and the
    // grantee (if different) becomes the `via_principal` explanation.
    const bucketFor = filterPrincipal || grantee;
    const key = bucketFor.toLowerCase();
    let bucket = byPrincipal.get(key);
    if (!bucket) { bucket = { label: bucketFor, privs: new Map() }; byPrincipal.set(key, bucket); }
    const rank = provenanceRank(distance, priv);
    const existing = bucket.privs.get(priv.privilege);
    if (!existing || rank < existing.rank) bucket.privs.set(priv.privilege, { p: priv, rank });
  };

  chain.forEach((node, distance) => {
    const inheritedFrom = distance > 0
      ? { inherited_from_type: node.type, inherited_from_name: node.name }
      : {};

    for (const a of node.assignments || []) {
      const grantee = (a.principal || '').trim();
      if (!grantee) continue;
      if (closure && !closure.has(grantee.toLowerCase())) continue;
      const via = filterPrincipal && grantee.toLowerCase() !== filterPrincipal.toLowerCase()
        ? { via_principal: grantee } : {};
      for (const raw of a.privileges || []) {
        const granted = normalizeUcPrivilege(typeof raw === 'string' ? raw : String((raw as { privilege?: unknown })?.privilege ?? ''));
        if (!granted) continue;
        // ALL PRIVILEGES is never a literal effective privilege — it EXPANDS to
        // the target type's applicable set minus MANAGE / EXTERNAL USE * (Learn).
        // Dropping it (the old behaviour) hid the single most powerful grant.
        const isAll = granted === UC_ALL_PRIVILEGES;
        // Expanded at the GRANTING node's type (that is what the grant covers),
        // then narrowed by the target's applicability filter below.
        const names = isAll ? expandAllPrivileges(node.type, { oss }) : [granted];
        for (const privilege of names) {
          // Ancestor grants flow down only for privileges the child type accepts;
          // grants ON the target itself are kept verbatim.
          if (distance > 0 && !applicable.has(privilege)) {
            // An ALL PRIVILEGES expansion narrowing to the child type is
            // expected, not a modelling gap — don't report it as one.
            if (!isAll) opts.onNotApplicable?.(privilege, { type: node.type, name: node.name });
            continue;
          }
          record(grantee, distance, {
            privilege, source: 'GRANT', ...inheritedFrom, ...via, ...(isAll ? { implied_by: UC_ALL_PRIVILEGES } : {}),
          });
        }
      }
    }

    // Ownership. Learn is explicit that this does NOT cascade: the owner of the
    // TARGET holds every applicable privilege here; the owner of an ANCESTOR
    // holds only MANAGE on this descendant, and still needs explicit grants for
    // anything else. Granting an ancestor owner the target's full set (the
    // pre-remediation behaviour) reported SELECT + MODIFY on every table under a
    // catalog with no grant existing anywhere.
    const owner = (node.owner || '').trim();
    if (!owner) return;
    if (closure && !closure.has(owner.toLowerCase())) return;
    const via = filterPrincipal && owner.toLowerCase() !== filterPrincipal.toLowerCase()
      ? { via_principal: owner } : {};
    const impliedByOwnership = distance === 0
      ? applicableList
      : (applicable.has(UC_OWNER_IMPLIED_ON_DESCENDANT) ? [UC_OWNER_IMPLIED_ON_DESCENDANT] : []);
    for (const privilege of impliedByOwnership) {
      record(owner, distance, { privilege, source: 'OWNERSHIP', ...inheritedFrom, ...via });
    }
  });

  const usagePrivileges = new Set(['USE_CATALOG', 'USE_SCHEMA']);

  return [...byPrincipal.values()]
    .map((b) => {
      // The names this bucket answers to: the queried principal's whole closure
      // when filtering, otherwise just this grantee.
      const identities = closure ?? new Set([b.label.toLowerCase()]);
      const usage = evaluateUsage(chain, identities, oss);
      const unmet = usage.filter((u) => u.status === 'missing');
      const blockedBy = unmet.map((u) => `${u.privilege} on ${u.securable_type} ${u.securable_name}`);
      return {
        principal: b.label,
        privileges: [...b.privs.values()]
          .sort((x, y) => x.p.privilege.localeCompare(y.p.privilege))
          .map((v) => {
            const p = v.p;
            // Owners are exempt from usage prerequisites; so are the usage
            // privileges themselves (they ARE the remediation).
            if (!blockedBy.length || p.source === 'OWNERSHIP' || usagePrivileges.has(p.privilege)) return p;
            return { ...p, blocked_by: blockedBy };
          }),
        ...(usage.length ? { usage } : {}),
      };
    })
    .filter((a) => a.privileges.length > 0)
    .sort((a, b) => a.principal.localeCompare(b.principal));
}

// ============================================================
// Presentation
// ============================================================

/**
 * Render one privilege — from EITHER backend — as the annotated string the
 * grants table shows. Databricks returns `{ privilege, inherited_from_type }`
 * objects on its native effective-permissions endpoint and plain strings on the
 * direct-grants endpoint; the Loom resolver returns the richer
 * {@link UcEffectivePrivilege}. One formatter covers all three so the pane
 * cannot drift per backend.
 *
 * This string is for DISPLAY ONLY. The pane's badge tint and its revocability
 * decision read the structured {@link UcEffectivePrivilege} fields the BFF
 * returns alongside it (`detail[]`) — nothing re-parses this text, so a
 * securable literally named `owner` cannot mis-tint a row and a `via <group>`
 * row cannot be mistaken for a locally revocable grant.
 */
export function formatUcPrivilege(v: unknown): string {
  if (typeof v === 'string') return normalizeUcPrivilege(v);
  const p = (v || {}) as UcEffectivePrivilege;
  const name = normalizeUcPrivilege(String(p.privilege ?? ''));
  if (!name) return '';
  const where = p.inherited_from_type
    ? `${p.inherited_from_type}${p.inherited_from_name ? ` ${p.inherited_from_name}` : ''}`
    : '';
  const notes: string[] = [];
  if (p.source === 'OWNERSHIP') {
    notes.push(where ? `inherited: owner of ${where}` : 'owner');
  } else if (where) {
    notes.push(`inherited from ${where}`);
  }
  if (p.implied_by === UC_ALL_PRIVILEGES) notes.push('from ALL PRIVILEGES');
  if (p.via_principal) notes.push(`via ${p.via_principal}`);
  if (p.blocked_by?.length) notes.push(`BLOCKED — needs ${p.blocked_by.join(' + ')}`);
  return notes.length ? `${name} (${notes.join(', ')})` : name;
}

/** True when the privilege is present but NOT exercisable because a usage
 *  prerequisite is missing. Structured — no string parsing. */
export function isUcPrivilegeBlocked(p: UcEffectivePrivilege): boolean {
  return !!p.blocked_by?.length;
}

/** True when the privilege lives on THIS securable and can therefore be revoked
 *  here. Anything inherited from a parent, implied by ownership, or held via a
 *  group must be revoked where it actually lives. Structured — no string
 *  parsing, so a securable named `owner` cannot fool it. */
export function isUcPrivilegeRevocableHere(p: UcEffectivePrivilege): boolean {
  return !p.inherited_from_type && p.source !== 'OWNERSHIP' && !p.via_principal;
}
