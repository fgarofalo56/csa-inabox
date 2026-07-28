/**
 * LU-4 — Unity Catalog **effective-permissions resolver** (inheritance walk).
 *
 * Databricks Unity Catalog exposes `GET /effective-permissions/{securable}/{name}`,
 * which answers "what can this principal actually do here?" after inheritance,
 * ownership and group membership are resolved. The OSS Unity Catalog server
 * (`loom-unity`, the Azure-Government default per `no-fabric-dependency.md`)
 * implements only the *direct* grants surface (`/permissions/...`), so Loom used
 * to gate the feature as Databricks-only. This module removes that gate: the
 * BFF composes the same answer from the direct grants it CAN read, which is
 * exactly the composition Unity Catalog itself specifies.
 *
 * Everything here is PURE — no fetch, no credentials, no env reads — so it is
 * unit-testable and safe to import from a client component (the grants pane
 * shares {@link UC_PRIVILEGES_BY_SECURABLE} with it). The I/O adapter that
 * feeds it real REST responses lives in `unity-catalog-client.ts`
 * ({@link file://./unity-catalog-client.ts} `computeEffectivePermissions`).
 *
 * The three rules that make this correct — each covered by a test in
 * `__tests__/uc-effective-permissions.test.ts`:
 *
 *  1. **Inheritance is resolved at read time, not at grant time.** The walk
 *     starts at the target securable and climbs its containment ancestors, so a
 *     privilege granted on `main` in January is returned for a table created in
 *     March. Nothing is materialized, so nothing can go stale.
 *  2. **Ownership implies the full privilege set** on the owned securable AND on
 *     everything beneath it — the owner of `main` can SELECT `main.sales.orders`
 *     without any grant existing anywhere.
 *  3. **Group membership is transitive**, including nested groups. The closure
 *     walk is breadth-first over a visited set, so a membership CYCLE
 *     (a ∈ b, b ∈ c, c ∈ a — which Entra forbids but a Loom-native or SCIM-fed
 *     group source can still produce) terminates instead of hanging the BFF.
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
 * make it an effective privilege on a table), and it is also the set an OWNER
 * implicitly holds.
 *
 * Single source of truth for the grants pane's checkbox grid too — the pane
 * imports this rather than keeping a second copy.
 */
export const UC_PRIVILEGES_BY_SECURABLE: Record<UCSecurableType, string[]> = {
  METASTORE: ['CREATE_CATALOG', 'CREATE_EXTERNAL_LOCATION', 'CREATE_STORAGE_CREDENTIAL', 'CREATE_CONNECTION', 'CREATE_SHARE', 'CREATE_RECIPIENT', 'CREATE_PROVIDER'],
  CATALOG: ['USE_CATALOG', 'USE_SCHEMA', 'CREATE_SCHEMA', 'CREATE_TABLE', 'CREATE_FUNCTION', 'CREATE_VOLUME', 'CREATE_MODEL', 'SELECT', 'MODIFY', 'EXECUTE', 'READ_VOLUME', 'WRITE_VOLUME', 'BROWSE', 'MANAGE'],
  SCHEMA: ['USE_SCHEMA', 'CREATE_TABLE', 'CREATE_FUNCTION', 'CREATE_VOLUME', 'CREATE_MODEL', 'SELECT', 'MODIFY', 'EXECUTE', 'READ_VOLUME', 'WRITE_VOLUME', 'MANAGE'],
  TABLE: ['SELECT', 'MODIFY', 'MANAGE'],
  VOLUME: ['READ_VOLUME', 'WRITE_VOLUME', 'MANAGE'],
  FUNCTION: ['EXECUTE', 'MANAGE'],
  REGISTERED_MODEL: ['EXECUTE', 'MANAGE'],
  EXTERNAL_LOCATION: ['CREATE_EXTERNAL_TABLE', 'CREATE_EXTERNAL_VOLUME', 'READ_FILES', 'WRITE_FILES', 'CREATE_MANAGED_STORAGE', 'BROWSE', 'MANAGE'],
  STORAGE_CREDENTIAL: ['CREATE_EXTERNAL_LOCATION', 'CREATE_EXTERNAL_TABLE', 'READ_FILES', 'WRITE_FILES', 'MANAGE'],
};

/** Privileges the OSS Unity Catalog 0.5 spec does not define — hidden on that
 *  backend so the pane never offers a grant the server will reject. */
export const UC_DBX_ONLY_PRIVILEGES = new Set([
  'BROWSE', 'MANAGE', 'CREATE_CONNECTION', 'CREATE_SHARE', 'CREATE_RECIPIENT', 'CREATE_PROVIDER', 'CREATE_MANAGED_STORAGE',
]);

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
 * The walk deliberately stops at the catalog. No privilege in
 * {@link UC_PRIVILEGES_BY_SECURABLE}.METASTORE is applicable at any child type
 * (the metastore set is all `CREATE_*` of metastore-level securables), so a
 * metastore node could contribute nothing but a guaranteed round-trip — and OSS
 * Unity Catalog's `metastore_summary` carries no `owner`, so metastore ownership
 * is not knowable on that backend either. METASTORE, EXTERNAL_LOCATION and
 * STORAGE_CREDENTIAL are metastore-level securables with no parent, so each is
 * its own single-element chain.
 *
 * A malformed name yields the best chain the name supports rather than throwing:
 * the caller is a read-only view and a partial answer beats a 500.
 */
export function ucSecurableChain(type: UCSecurableType, fullName: string): UcSecurableRef[] {
  const name = (fullName || '').trim();
  if (type === 'METASTORE') return [{ type: 'METASTORE', name: '' }];
  if (type === 'EXTERNAL_LOCATION' || type === 'STORAGE_CREDENTIAL') return [{ type, name }];
  const parts = name.split('.').filter(Boolean);
  const chain: UcSecurableRef[] = [{ type, name }];
  if (type === 'CATALOG') return chain;
  if (type === 'SCHEMA') {
    if (parts.length >= 2) chain.push({ type: 'CATALOG', name: parts[0] });
    return chain;
  }
  // TABLE | VOLUME | FUNCTION | REGISTERED_MODEL — catalog.schema.object
  if (parts.length >= 3) chain.push({ type: 'SCHEMA', name: `${parts[0]}.${parts[1]}` });
  if (parts.length >= 2) chain.push({ type: 'CATALOG', name: parts[0] });
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
  /** True when the walk hit `maxPrincipals` / `maxDepth` and stopped early — the
   *  result is then a SUBSET and the caller must say so rather than imply it is
   *  the complete answer. */
  truncated: boolean;
}

/**
 * Breadth-first closure over group membership. Nested groups are followed to
 * `maxDepth`; a principal already visited is never expanded twice, which is what
 * makes a membership **cycle** (a ∈ b ∈ c ∈ a) terminate rather than recurse
 * forever. Bounded by `maxPrincipals` so a pathological directory cannot pin the
 * BFF either.
 *
 * `directGroups` failures are contained: a principal whose parents cannot be
 * read contributes nothing, and the closure returned is still valid (just
 * smaller). The caller surfaces the reason — never a silent "no access".
 */
export async function expandPrincipalClosure(
  principal: string,
  directGroups: UcDirectGroupsResolver,
  opts?: { maxDepth?: number; maxPrincipals?: number; onError?: (principal: string, err: unknown) => void },
): Promise<UcPrincipalClosure> {
  const maxDepth = opts?.maxDepth ?? 10;
  const maxPrincipals = opts?.maxPrincipals ?? 200;
  const root = (principal || '').trim();
  if (!root) return { closure: [], groups: [], truncated: false };

  const seen = new Map<string, string>([[root.toLowerCase(), root]]);
  let frontier = [root];
  let truncated = false;

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
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
  /** The securable's owner, when the backend reports one. An owner holds the
   *  full applicable privilege set here and on every descendant. */
  owner?: string;
  /** DIRECT grants recorded on this securable (`/permissions/...`). */
  assignments: UCPermissionAssignment[];
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
   *  the securable or one of its ancestors). Databricks omits it; treat
   *  undefined as GRANT. */
  source?: UcPrivilegeSource;
}

export interface UcEffectiveAssignment {
  principal: string;
  privileges: UcEffectivePrivilege[];
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
}

export interface ResolveEffectiveOptions {
  /** Answer only for this principal ("what can Ada do here?"). Omit to return
   *  the effective set for every principal that appears anywhere on the chain. */
  principal?: string;
  /** The principal's transitive group closure from {@link expandPrincipalClosure}.
   *  Ignored unless `principal` is set; when omitted only the principal's own
   *  grants count. */
  principalClosure?: Iterable<string>;
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
  const applicable = new Set(UC_PRIVILEGES_BY_SECURABLE[target.type] || []);

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
    const owner = filterPrincipal || grantee;
    const key = owner.toLowerCase();
    let bucket = byPrincipal.get(key);
    if (!bucket) { bucket = { label: owner, privs: new Map() }; byPrincipal.set(key, bucket); }
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
        const privilege = normalizeUcPrivilege(typeof raw === 'string' ? raw : String((raw as any)?.privilege ?? ''));
        if (!privilege) continue;
        // Ancestor grants flow down only for privileges the child type accepts;
        // grants ON the target itself are kept verbatim.
        if (distance > 0 && !applicable.has(privilege)) continue;
        record(grantee, distance, { privilege, source: 'GRANT', ...inheritedFrom, ...via });
      }
    }

    // Ownership — full applicable privilege set on the owned securable and on
    // every securable beneath it.
    const owner = (node.owner || '').trim();
    if (!owner) return;
    if (closure && !closure.has(owner.toLowerCase())) return;
    const via = filterPrincipal && owner.toLowerCase() !== filterPrincipal.toLowerCase()
      ? { via_principal: owner } : {};
    for (const privilege of applicable) {
      record(owner, distance, { privilege, source: 'OWNERSHIP', ...inheritedFrom, ...via });
    }
  });

  return [...byPrincipal.values()]
    .map((b) => ({
      principal: b.label,
      privileges: [...b.privs.values()]
        .sort((x, y) => x.p.privilege.localeCompare(y.p.privilege))
        .map((v) => v.p),
    }))
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
 * The word "inherited" is load-bearing: the pane tints those badges and excludes
 * them from "Revoke all" (you cannot revoke a grant that lives on a parent).
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
    // Ownership of an ANCESTOR is inheritance too — keep the keyword so the pane
    // tints it and excludes it from "Revoke all" (nothing to revoke here).
    notes.push(where ? `inherited: owner of ${where}` : 'owner');
  } else if (where) {
    notes.push(`inherited from ${where}`);
  }
  if (p.via_principal) notes.push(`via ${p.via_principal}`);
  return notes.length ? `${name} (${notes.join(', ')})` : name;
}
