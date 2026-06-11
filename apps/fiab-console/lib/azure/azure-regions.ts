/**
 * azure-regions — the supported Azure region list per Loom cloud boundary.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The Setup Wizard's region dropdown used to ship two hard-coded stub arrays
 * (7 Commercial regions, 3 Gov). That is neither the full supported set nor
 * boundary-accurate (GCC-High, IL5 and DoD do NOT share one Gov list). This
 * module is the single source of truth for the region picker — a CLOSED enum
 * per boundary (per loom-no-freeform-config.md) with the authoritative static
 * fallback the wizard renders offline.
 *
 * The wizard ALSO calls `GET /api/setup/regions?subscription=<id>` which returns
 * the live ARM `subscriptions/{id}/locations` set (RBAC-/enablement-trimmed for
 * the chosen subscription) so the picker shows exactly the regions that sub can
 * deploy into. When that call is unavailable (no sub chosen yet, ARM 403, etc.)
 * the wizard falls back to the static list returned by `regionsForBoundary()`.
 *
 * Boundary → cloud mapping mirrors cloud-endpoints.detectLoomCloud():
 *   - Commercial + GCC run on Azure Public endpoints      → public region set
 *   - GCC-High + IL5 run on Azure Government (USGov)       → usgov region set
 *   - DoD runs on the DoD-exclusive Government regions      → usdod region set
 * (Grounded in Microsoft Learn: azure-government documentation-government-welcome
 * "list of regions" and documentation-government-overview-dod for the DoD pair.)
 */

export type RegionBoundary = 'Commercial' | 'GCC' | 'GCC-High' | 'IL5' | 'DoD';

export interface AzureRegion {
  /** ARM region name, e.g. `eastus2` (the value `az deployment sub create -l` takes). */
  name: string;
  /** Human display name, e.g. `East US 2`. */
  display: string;
  /** Geography grouping for optgroup-style ordering. */
  geo: string;
}

/**
 * Azure Public regions (Commercial + GCC). This is the broadly-available set
 * Loom can deploy a Data Landing Zone into; capacity for a specific resource
 * (e.g. ADX / AOAI) may still vary, which is why the live ARM list is preferred
 * when a subscription is chosen. Ordered with the most common deploy targets
 * first within each geography.
 */
export const AZURE_PUBLIC_REGIONS: AzureRegion[] = [
  // United States
  { name: 'eastus2', display: 'East US 2', geo: 'US' },
  { name: 'eastus', display: 'East US', geo: 'US' },
  { name: 'centralus', display: 'Central US', geo: 'US' },
  { name: 'southcentralus', display: 'South Central US', geo: 'US' },
  { name: 'northcentralus', display: 'North Central US', geo: 'US' },
  { name: 'westus', display: 'West US', geo: 'US' },
  { name: 'westus2', display: 'West US 2', geo: 'US' },
  { name: 'westus3', display: 'West US 3', geo: 'US' },
  { name: 'westcentralus', display: 'West Central US', geo: 'US' },
  // Canada
  { name: 'canadacentral', display: 'Canada Central', geo: 'Canada' },
  { name: 'canadaeast', display: 'Canada East', geo: 'Canada' },
  // Europe
  { name: 'westeurope', display: 'West Europe', geo: 'Europe' },
  { name: 'northeurope', display: 'North Europe', geo: 'Europe' },
  { name: 'uksouth', display: 'UK South', geo: 'Europe' },
  { name: 'ukwest', display: 'UK West', geo: 'Europe' },
  { name: 'francecentral', display: 'France Central', geo: 'Europe' },
  { name: 'germanywestcentral', display: 'Germany West Central', geo: 'Europe' },
  { name: 'switzerlandnorth', display: 'Switzerland North', geo: 'Europe' },
  { name: 'norwayeast', display: 'Norway East', geo: 'Europe' },
  { name: 'swedencentral', display: 'Sweden Central', geo: 'Europe' },
  { name: 'polandcentral', display: 'Poland Central', geo: 'Europe' },
  { name: 'italynorth', display: 'Italy North', geo: 'Europe' },
  { name: 'spaincentral', display: 'Spain Central', geo: 'Europe' },
  // Asia Pacific
  { name: 'australiaeast', display: 'Australia East', geo: 'Asia Pacific' },
  { name: 'australiasoutheast', display: 'Australia Southeast', geo: 'Asia Pacific' },
  { name: 'southeastasia', display: 'Southeast Asia', geo: 'Asia Pacific' },
  { name: 'eastasia', display: 'East Asia', geo: 'Asia Pacific' },
  { name: 'japaneast', display: 'Japan East', geo: 'Asia Pacific' },
  { name: 'japanwest', display: 'Japan West', geo: 'Asia Pacific' },
  { name: 'koreacentral', display: 'Korea Central', geo: 'Asia Pacific' },
  { name: 'centralindia', display: 'Central India', geo: 'Asia Pacific' },
  { name: 'southindia', display: 'South India', geo: 'Asia Pacific' },
  // Middle East / Africa / South America
  { name: 'uaenorth', display: 'UAE North', geo: 'Middle East' },
  { name: 'qatarcentral', display: 'Qatar Central', geo: 'Middle East' },
  { name: 'israelcentral', display: 'Israel Central', geo: 'Middle East' },
  { name: 'southafricanorth', display: 'South Africa North', geo: 'Africa' },
  { name: 'brazilsouth', display: 'Brazil South', geo: 'South America' },
];

/** Azure Government (GCC-High / IL5) regions — both run on `AzureUSGovernment`. */
export const AZURE_USGOV_REGIONS: AzureRegion[] = [
  { name: 'usgovvirginia', display: 'US Gov Virginia', geo: 'US Gov' },
  { name: 'usgovtexas', display: 'US Gov Texas', geo: 'US Gov' },
  { name: 'usgovarizona', display: 'US Gov Arizona', geo: 'US Gov' },
];

/**
 * DoD-exclusive Azure Government regions. These are reserved for DoD workloads
 * under a separate IL5 Provisional Authorization (Learn:
 * documentation-government-overview-dod) and are NOT the standard IL5 path —
 * IL5 normally deploys into the US Gov regions above. Surfaced only for the DoD
 * boundary.
 */
export const AZURE_USDOD_REGIONS: AzureRegion[] = [
  { name: 'usdodcentral', display: 'US DoD Central', geo: 'US DoD' },
  { name: 'usdodeast', display: 'US DoD East', geo: 'US DoD' },
];

/** Default region per boundary — the first/most-common deploy target. */
export function defaultRegion(boundary: RegionBoundary): string {
  switch (boundary) {
    case 'GCC-High':
    case 'IL5':
      return 'usgovvirginia';
    case 'DoD':
      return 'usdodcentral';
    default:
      return 'eastus2';
  }
}

/** The static supported-region list for a boundary (fallback when ARM is unavailable). */
export function regionsForBoundary(boundary: RegionBoundary): AzureRegion[] {
  switch (boundary) {
    case 'GCC-High':
    case 'IL5':
      return AZURE_USGOV_REGIONS;
    case 'DoD':
      return AZURE_USDOD_REGIONS;
    default:
      // Commercial + GCC both run on Azure Public.
      return AZURE_PUBLIC_REGIONS;
  }
}

/** Convenience: the bare ARM region names for a boundary. */
export function regionNamesForBoundary(boundary: RegionBoundary): string[] {
  return regionsForBoundary(boundary).map((r) => r.name);
}

/** Title-case an ARM region name when ARM gives no displayName (e.g. `eastus2` → `East US 2`). */
export function regionDisplayName(name: string): string {
  const known = [...AZURE_PUBLIC_REGIONS, ...AZURE_USGOV_REGIONS, ...AZURE_USDOD_REGIONS].find(
    (r) => r.name === name,
  );
  if (known) return known.display;
  // Heuristic title-casing: usgovvirginia → US Gov Virginia is best-effort only.
  return name
    .replace(/^usgov/, 'usgov ')
    .replace(/^usdod/, 'usdod ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
