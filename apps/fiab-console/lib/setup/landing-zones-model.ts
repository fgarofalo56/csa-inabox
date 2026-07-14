/**
 * Data Landing Zone overview model (item-3).
 *
 * Pure mapping from the two real Azure sources into the shape the DLZ overview
 * page (`/admin/landing-zones`) renders + visualizes:
 *
 *   - hub coordinates           ← Cosmos tenant-topology doc / Console env
 *                                 (getTenantTopologySafe)
 *   - attached DLZ resource grps ← Azure Resource Graph
 *                                 (`rg-csa-loom-dlz-<domain>-<region>`)
 *
 * No mock data (no-vaporware): when Resource Graph returns no DLZ RGs the list
 * is genuinely empty and the page says so. No Fabric handles anywhere
 * (no-fabric-dependency) — every coordinate is an Azure resource id.
 *
 * The mapping is pure (no I/O) so it is unit-testable without a live
 * subscription; the route does the ARM/Cosmos reads and feeds this.
 */

/** A DLZ resource-group row as Resource Graph returns it. */
export interface DlzRgRow {
  name: string; // rg-csa-loom-dlz-<domain>-<region>
  subscriptionId: string;
  location?: string;
}

/** Hub coordinates the overview needs (subset of TenantTopology). */
export interface HubCoords {
  hubSubscriptionId?: string;
  location?: string;
  boundary?: string;
  hubAdxClusterRgName?: string;
  hubCatalogEndpoint?: string;
}

/**
 * Attach state of a discovered DLZ relative to the hub:
 *   - 'attached'  : the Console can read the DLZ RG AND it is wired (we infer
 *                   "wired" from the RG being discoverable in a sub the Console
 *                   has at least Reader on — Resource Graph honours RBAC, so a
 *                   returned RG means the Console can see it).
 *   - 'detached'  : the RG exists but the Console can only READ it (Reader-only
 *                   at BOTH the RG scope and the subscription scope) — it may
 *                   need re-attach / RBAC repair before navigators can manage
 *                   it. (Determined by the route from the deploy pre-flight
 *                   permission check.)
 *   - 'unknown'   : permission could not be determined.
 *
 * IMPORTANT (multi-sub least-privilege): the Console UAMI is granted Contributor
 * scoped to the **DLZ resource group**, NOT subscription-wide (the DLZ sub holds
 * many non-Loom workloads). So a DLZ is 'attached' when the UAMI can write at
 * EITHER the RG scope (the normal multi-sub case) OR the subscription scope
 * (single-sub / hub-sub). Requiring sub-scope write would false-flag every
 * correctly-secured RG-scoped DLZ as needing repair.
 */
export type DlzAttachState = 'attached' | 'detached' | 'unknown';

/** One DLZ as the overview page renders it. */
export interface LandingZone {
  id: string; // stable key: `${subscriptionId}/${rg}`
  domainName: string;
  region: string;
  subscriptionId: string;
  rg: string;
  /** true when the DLZ is in a different subscription than the hub. */
  crossSubscription: boolean;
  attachState: DlzAttachState;
  /**
   * true when this row is a LOGICAL landing zone from the landing-zones store
   * (a lightweight brownfield-attach target) rather than a Resource-Graph-
   * discovered Loom-convention DLZ resource group. Logical zones can carry
   * attached brownfield services without a greenfield DLZ deploy.
   */
  logical?: boolean;
}

/**
 * A logical landing zone (from the `landing-zones` store) projected into the
 * overview. The overview unions these with the Resource-Graph DLZ RGs so a
 * brownfield LZ — created just to hang attached services on — still appears.
 */
export interface LogicalLandingZoneRow {
  id: string; // the store's stable slug id (NOT a `${sub}/${rg}` DLZ id)
  name: string;
  region?: string;
  subscriptionId?: string;
  /** Primary resource group (first of the store doc's resourceGroups[]), if any. */
  rg?: string;
}

/** The full overview payload. */
export interface LandingZonesOverview {
  hub: HubCoords | null;
  hubExists: boolean;
  landingZones: LandingZone[];
}

/** Parse `rg-csa-loom-dlz-<domain>-<region>` → { domainName, region }.
 *
 * Relaxed (dlz-brownfield): the strict form captures a trailing `-<region>`
 * token, but a logical / brownfield landing zone's resource group may NOT follow
 * the `-<region>` suffix convention (an operator can attach existing services to
 * an RG named anything). So when the strict `<domain>-<region>` split fails we
 * fall back to the prefix-only form — any `rg-csa-loom-dlz-<rest>` still yields a
 * domain (region empty, filled from the row's `location` by the caller) instead
 * of being dropped. This keeps a logical LZ from vanishing off the overview. */
export function parseDlzRgName(rg: string): { domainName: string; region: string } | null {
  const strict = /^rg-csa-loom-dlz-(.+)-([a-z0-9]+)$/i.exec(rg);
  if (strict) return { domainName: strict[1], region: strict[2] };
  const loose = /^rg-csa-loom-dlz-(.+)$/i.exec(rg);
  if (loose) return { domainName: loose[1], region: '' };
  return null;
}

/** Options carrying the permission signals the route probed from live ARM. */
export interface AttachStateInputs {
  /** Subscription ids the Console can WRITE to (sub-scoped Contributor/Owner). */
  writableSubs?: Set<string>;
  /**
   * Resource-group ids (`<subscriptionId>/<rgName>`, lowercased) the Console can
   * MANAGE in place (RG-scoped Contributor/Owner). This is the normal multi-sub
   * signal — the UAMI gets RG-scoped, not sub-scoped, Contributor.
   */
  writableRgs?: Set<string>;
  /**
   * Resource-group ids (`<subscriptionId>/<rgName>`, lowercased) whose permission
   * check could NOT be determined (the ARM permissions read itself errored —
   * token/network/403). These resolve to 'unknown' rather than 'detached' so a
   * transient or cross-sub read failure is never mis-reported as Reader-only
   * (no-vaporware: an undeterminable state is honest, a false "needs repair" is not).
   */
  unknownRgs?: Set<string>;
}

/** Stable `<subscriptionId>/<rgName>` key (lowercased) for an RG. */
export function rgKey(subscriptionId: string, rg: string): string {
  return `${subscriptionId}/${rg}`.toLowerCase();
}

/**
 * PURE: map the hub + DLZ RG rows into the overview. A DLZ is 'attached' when
 * the Console can write at EITHER the RG scope (`writableRgs`, the normal
 * least-privilege multi-sub grant) OR the subscription scope (`writableSubs`,
 * single-sub / hub-sub). Same-sub-as-hub DLZs are always attached. When NEITHER
 * signal is supplied the attach state is 'unknown' (permission not probed)
 * rather than guessed.
 *
 * Back-compat: the 4th arg may be a bare `Set<string>` of writable sub ids (the
 * original signature) or the richer {@link AttachStateInputs}.
 */
export function buildLandingZonesOverview(
  hub: HubCoords | null,
  hubExists: boolean,
  dlzRgRows: DlzRgRow[],
  perms?: Set<string> | AttachStateInputs,
  logicalZones?: LogicalLandingZoneRow[],
): LandingZonesOverview {
  const inputs: AttachStateInputs =
    perms instanceof Set ? { writableSubs: perms } : perms ?? {};
  const { writableSubs, writableRgs, unknownRgs } = inputs;
  const probed = !!writableSubs || !!writableRgs || !!unknownRgs;
  const hubSub = hub?.hubSubscriptionId;
  const landingZones: LandingZone[] = [];
  const seen = new Set<string>();
  for (const row of dlzRgRows) {
    const parsed = parseDlzRgName(row.name);
    if (!parsed) continue;
    const crossSubscription = !!hubSub && row.subscriptionId !== hubSub;
    let attachState: DlzAttachState = 'unknown';
    if (probed) {
      const key = rgKey(row.subscriptionId, row.name);
      const subWritable = !!writableSubs?.has(row.subscriptionId);
      const rgWritable = !!writableRgs?.has(key);
      const rgUnknown = !!unknownRgs?.has(key);
      // Same-sub-as-hub DLZs are always manageable; otherwise RG- OR sub-scope
      // write is enough (RG-scope is the normal least-privilege grant). When the
      // RG permission read itself could not be determined we report 'unknown'
      // (not 'detached') so an undeterminable read never false-flags Reader-only.
      attachState =
        !crossSubscription || subWritable || rgWritable
          ? 'attached'
          : rgUnknown
            ? 'unknown'
            : 'detached';
    }
    const id = `${row.subscriptionId}/${row.name}`;
    seen.add(id.toLowerCase());
    landingZones.push({
      id,
      domainName: parsed.domainName,
      region: parsed.region || row.location || '',
      subscriptionId: row.subscriptionId,
      rg: row.name,
      crossSubscription,
      attachState,
    });
  }
  // UNION the logical landing zones from the store (brownfield attach targets).
  // A logical LZ that also happens to have a discovered Loom-convention DLZ RG
  // (same `${sub}/${rg}` id) is already listed above — skip the duplicate. A
  // logical LZ is always 'attached' from the overview's perspective: it exists
  // as a durable registry doc the Console owns, not an RG whose RBAC is probed.
  for (const lz of logicalZones ?? []) {
    if (!lz?.id) continue;
    // Prefer the concrete `${sub}/${rg}` key when the store recorded one so a
    // logical LZ that mirrors a real DLZ RG dedupes against the row above.
    const concreteKey =
      lz.subscriptionId && lz.rg ? `${lz.subscriptionId}/${lz.rg}` : lz.id;
    if (seen.has(concreteKey.toLowerCase()) || seen.has(lz.id.toLowerCase())) continue;
    seen.add(concreteKey.toLowerCase());
    seen.add(lz.id.toLowerCase());
    landingZones.push({
      id: lz.id,
      domainName: lz.name || lz.id,
      region: lz.region || '',
      subscriptionId: lz.subscriptionId || hubSub || '',
      rg: lz.rg || '',
      crossSubscription: !!hubSub && !!lz.subscriptionId && lz.subscriptionId !== hubSub,
      attachState: 'attached',
      logical: true,
    });
  }
  // Stable order: hub-sub DLZs first, then by domain.
  landingZones.sort((a, b) => {
    if (a.crossSubscription !== b.crossSubscription) return a.crossSubscription ? 1 : -1;
    return a.domainName.localeCompare(b.domainName);
  });
  return { hub: hub ?? null, hubExists, landingZones };
}
