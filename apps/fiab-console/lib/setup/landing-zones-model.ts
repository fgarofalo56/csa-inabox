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
 *   - 'detached'  : the RG exists but is in a subscription the Console cannot
 *                   write to (Reader-only) — it may need re-attach / RBAC repair
 *                   before navigators can manage it. (Determined by the route
 *                   from the deploy pre-flight permission check.)
 *   - 'unknown'   : permission could not be determined.
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
}

/** The full overview payload. */
export interface LandingZonesOverview {
  hub: HubCoords | null;
  hubExists: boolean;
  landingZones: LandingZone[];
}

/** Parse `rg-csa-loom-dlz-<domain>-<region>` → { domainName, region }. */
export function parseDlzRgName(rg: string): { domainName: string; region: string } | null {
  const m = /^rg-csa-loom-dlz-(.+)-([a-z0-9]+)$/i.exec(rg);
  if (!m) return null;
  return { domainName: m[1], region: m[2] };
}

/**
 * PURE: map the hub + DLZ RG rows into the overview. `writableSubs` is the set
 * of subscription ids the Console can WRITE to (Contributor+) — used to mark a
 * cross-sub DLZ in a Reader-only sub as 'detached' (needs RBAC repair before it
 * can be managed). When `writableSubs` is undefined the attach state is
 * 'unknown' (permission not probed) rather than guessed.
 */
export function buildLandingZonesOverview(
  hub: HubCoords | null,
  hubExists: boolean,
  dlzRgRows: DlzRgRow[],
  writableSubs?: Set<string>,
): LandingZonesOverview {
  const hubSub = hub?.hubSubscriptionId;
  const landingZones: LandingZone[] = [];
  for (const row of dlzRgRows) {
    const parsed = parseDlzRgName(row.name);
    if (!parsed) continue;
    const crossSubscription = !!hubSub && row.subscriptionId !== hubSub;
    let attachState: DlzAttachState = 'unknown';
    if (writableSubs) {
      // Same-sub-as-hub DLZs are always manageable; cross-sub depends on write rights.
      attachState =
        !crossSubscription || writableSubs.has(row.subscriptionId) ? 'attached' : 'detached';
    }
    landingZones.push({
      id: `${row.subscriptionId}/${row.name}`,
      domainName: parsed.domainName,
      region: parsed.region || row.location || '',
      subscriptionId: row.subscriptionId,
      rg: row.name,
      crossSubscription,
      attachState,
    });
  }
  // Stable order: hub-sub DLZs first, then by domain.
  landingZones.sort((a, b) => {
    if (a.crossSubscription !== b.crossSubscription) return a.crossSubscription ? 1 : -1;
    return a.domainName.localeCompare(b.domainName);
  });
  return { hub: hub ?? null, hubExists, landingZones };
}
