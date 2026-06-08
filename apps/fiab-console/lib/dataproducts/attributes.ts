/**
 * Data-product inline attributes — shared, framework-neutral (no 'use client')
 * so both the BFF route (app/api/data-products/[id]/route.ts) and the editor
 * component (lib/editors/components/inline-attribute-panel.tsx) import the same
 * enum + validators. This is the canonical model for the three "right rail"
 * attributes the Purview Unified Catalog data-product details page exposes:
 *
 *   F5  Update frequency  → UpdateFrequencyEnum (REST: updateFrequency)
 *   F11 Terms of use      → CatalogModelExternalLink[] (REST: termsOfUse)
 *   F12 Documentation     → CatalogModelExternalLink[] (REST: documentation)
 *
 * The Loom internal model uses { label, url, assetId? }; the T18 Unified Catalog
 * adapter translates label→name and assetId→dataAssetId before calling the real
 * Purview REST (PUT /datagovernance/catalog/dataProducts/{id}). "Annually" maps
 * to the REST 'Yearly' member; "Ad hoc" / "Real-time" are portal display values.
 */

// Portal-visible display labels for the Update frequency select. The first six
// map 1:1 to the Purview REST UpdateFrequencyEnum (Daily/Weekly/Monthly/
// Quarterly/Yearly[=Annually]); "Ad hoc" and "Real-time" are additional portal
// display values stored verbatim in Cosmos.
export const UPDATE_FREQUENCIES = [
  'Daily',
  'Weekly',
  'Monthly',
  'Quarterly',
  'Annually',
  'Ad hoc',
  'Real-time',
] as const;

export type UpdateFrequency = (typeof UPDATE_FREQUENCIES)[number];

/** Loom internal external-link model (maps to Purview CatalogModelExternalLink). */
export interface ExternalLink {
  /** Friendly name — Purview REST `name`. */
  label: string;
  /** Absolute URL — Purview REST `url`. */
  url: string;
  /** Optional data-asset scope — Purview REST `dataAssetId` (uuid). */
  assetId?: string;
}

export function isUpdateFrequency(v: unknown): v is UpdateFrequency {
  return typeof v === 'string' && (UPDATE_FREQUENCIES as readonly string[]).includes(v);
}

/**
 * Validate + normalise an inbound terms-of-use / documentation array. Returns
 * the cleaned array, or null when the shape is invalid (so the route can 400).
 * Each entry must carry a non-empty label + a parseable absolute URL.
 */
export function sanitizeExternalLinks(input: unknown): ExternalLink[] | null {
  if (!Array.isArray(input)) return null;
  const out: ExternalLink[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const label = typeof o.label === 'string' ? o.label.trim() : '';
    const url = typeof o.url === 'string' ? o.url.trim() : '';
    if (!label || !url) return null;
    try {
      new URL(url);
    } catch {
      return null;
    }
    const assetId = typeof o.assetId === 'string' && o.assetId.trim() ? o.assetId.trim() : undefined;
    out.push(assetId ? { label, url, assetId } : { label, url });
  }
  return out;
}
