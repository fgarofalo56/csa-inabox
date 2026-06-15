/**
 * Shared, pure (no fetch / no React) option lists + validators for the
 * cost-estimate currency and pricing-region pickers. Imported by BOTH the BFF
 * route (server-side input validation) and the planner UI (Dropdown options) so
 * there is exactly one source of truth — no drift between what the UI offers and
 * what the route accepts (per .claude/rules/loom-no-freeform-config: the user
 * picks from a fixed catalog, never types a raw value).
 *
 * The currency set is the list the public Azure Retail Prices API
 * (https://prices.azure.com/api/retail/prices?currencyCode='XXX') supports; the
 * region set is the common Commercial `armRegionName`s that API prices against
 * (the API only knows Commercial regions — Gov boundaries price against a chosen
 * Commercial reference region, disclosed in the report).
 */

/** A currency the Azure Retail Prices API can return rates in. */
export interface CurrencyOption {
  code: string;
  label: string;
}

/**
 * Currencies supported by the Azure Retail Prices API `currencyCode` parameter.
 * USD is the default (and what the offline fallback list prices are quoted in).
 */
export const RETAIL_CURRENCIES: ReadonlyArray<CurrencyOption> = [
  { code: 'USD', label: 'USD — US Dollar' },
  { code: 'EUR', label: 'EUR — Euro' },
  { code: 'GBP', label: 'GBP — British Pound' },
  { code: 'AUD', label: 'AUD — Australian Dollar' },
  { code: 'BRL', label: 'BRL — Brazilian Real' },
  { code: 'CAD', label: 'CAD — Canadian Dollar' },
  { code: 'CHF', label: 'CHF — Swiss Franc' },
  { code: 'DKK', label: 'DKK — Danish Krone' },
  { code: 'INR', label: 'INR — Indian Rupee' },
  { code: 'JPY', label: 'JPY — Japanese Yen' },
  { code: 'KRW', label: 'KRW — South Korean Won' },
  { code: 'NOK', label: 'NOK — Norwegian Krone' },
  { code: 'NZD', label: 'NZD — New Zealand Dollar' },
  { code: 'SEK', label: 'SEK — Swedish Krona' },
  { code: 'TWD', label: 'TWD — Taiwan Dollar' },
];

export const DEFAULT_CURRENCY = 'USD';

const CURRENCY_SET = new Set(RETAIL_CURRENCIES.map((c) => c.code));

/** True when `code` is an exact, API-supported currency code (case-sensitive). */
export function isSupportedCurrency(code: string | undefined | null): boolean {
  return !!code && CURRENCY_SET.has(code);
}

/** Coerce arbitrary input to a supported currency, else the USD default. */
export function normalizeCurrency(code: string | undefined | null): string {
  const c = (code || '').trim().toUpperCase();
  return CURRENCY_SET.has(c) ? c : DEFAULT_CURRENCY;
}

/** A Commercial Azure region the Retail Prices API can price against. */
export interface RegionOption {
  name: string;
  label: string;
}

/**
 * Common Commercial `armRegionName`s offered in the pricing-region picker.
 * Not exhaustive (the API knows ~60+ regions) — these are the high-traffic ones
 * an architect typically compares; any other valid armRegionName still works if
 * supplied via the plan's own region. The default Commercial reference region
 * used for Gov boundaries (eastus2) is included.
 */
export const COMMERCIAL_REGIONS: ReadonlyArray<RegionOption> = [
  { name: 'eastus', label: 'East US' },
  { name: 'eastus2', label: 'East US 2' },
  { name: 'westus', label: 'West US' },
  { name: 'westus2', label: 'West US 2' },
  { name: 'westus3', label: 'West US 3' },
  { name: 'centralus', label: 'Central US' },
  { name: 'southcentralus', label: 'South Central US' },
  { name: 'northcentralus', label: 'North Central US' },
  { name: 'westcentralus', label: 'West Central US' },
  { name: 'canadacentral', label: 'Canada Central' },
  { name: 'brazilsouth', label: 'Brazil South' },
  { name: 'northeurope', label: 'North Europe' },
  { name: 'westeurope', label: 'West Europe' },
  { name: 'uksouth', label: 'UK South' },
  { name: 'francecentral', label: 'France Central' },
  { name: 'germanywestcentral', label: 'Germany West Central' },
  { name: 'switzerlandnorth', label: 'Switzerland North' },
  { name: 'swedencentral', label: 'Sweden Central' },
  { name: 'norwayeast', label: 'Norway East' },
  { name: 'australiaeast', label: 'Australia East' },
  { name: 'southeastasia', label: 'Southeast Asia' },
  { name: 'eastasia', label: 'East Asia' },
  { name: 'japaneast', label: 'Japan East' },
  { name: 'koreacentral', label: 'Korea Central' },
  { name: 'centralindia', label: 'Central India' },
  { name: 'southafricanorth', label: 'South Africa North' },
  { name: 'uaenorth', label: 'UAE North' },
];

/** Lower-cased, alnum-only armRegionName (empty when input is unusable). */
export function normalizeRegion(raw: string | undefined | null): string {
  return (raw || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
}

/** Human label for a region name, falling back to the raw name. */
export function regionLabel(name: string): string {
  return COMMERCIAL_REGIONS.find((r) => r.name === name)?.label || name;
}
