// data-product/types.ts — DataProductEditor's private types + constants,
// extracted verbatim from data-product-editor.tsx (WS-E1 / R8 decomposition,
// pure move — no behavior change).
import type { DataProductAccessPolicy } from '@/lib/types/access-policy';
import type { ExternalLink } from '@/lib/dataproducts/attributes';
import type { OwnerRef } from '@/lib/dataproducts/owner-picker';

export interface DataProductDataset { name: string; typeName: string; qualifiedName: string; classifications: string[]; guid?: string; }
export interface DataProductGlossaryLink { name: string; guid?: string; }
/** F9 — physical Data Map asset attached to the product (persisted refs only). */
export interface PersistedAssetRef { guid: string; name: string; qualifiedName?: string; entityType?: string; addedAt?: string; }
export interface DataProductState {
  displayName: string;
  description: string;
  domain: string;
  /** Legacy single free-text owner (retired in DP-17 into `owners[]`; kept as a
   *  mirror of owners[0] for back-compat + the marketplace/AI-Search facet). */
  owner: string;
  /** DP-17 — rich owner records bound by the shared people-picker. */
  owners?: OwnerRef[];
  certified: boolean;
  /**
   * F7 — marketplace "Endorsed by governance" flag, distinct from the
   * Purview-only `certified` concept. Toggled in the Data Product Edit dialog
   * (Basic step) which PATCHes the Cosmos `dataproducts` doc; the badge below
   * mirrors the saved value via the dialog's onSaved callback.
   */
  endorsed?: boolean;
  sla: string;
  bundle: string[];
  // Lifecycle state — mirrors Purview Unified Catalog data-product states
  // (Draft → Published → Expired). Delete (F13) requires Draft or Expired.
  // NOTE: two vocabularies coexist — the Purview-mirror dropdown uses TitleCase
  // ('Draft'/'Published'/'Expired') while the F6 publish/expire status API uses
  // UPPERCASE ('DRAFT'/'PUBLISHED'/'EXPIRED'). The union keeps both working.
  lifecycleStatus?: 'Draft' | 'Published' | 'Expired' | 'PUBLISHED' | 'DRAFT' | 'EXPIRED';
  /** DP-5 — persisted certification state (managed via the Certification tab /
   *  the /certify route); drives the header endorsement-ladder badge. */
  certificationState?: 'draft' | 'validated' | 'certified';
  // Phase 2 parity surfaces — datasets/assets, linked glossary terms.
  datasets?: DataProductDataset[];
  glossaryLinks?: DataProductGlossaryLink[];
  // F9 — curated physical Data Map assets this product wraps (the T6 publish
  // guard counts these). Persisted under state.dataAssets; runtime deleted /
  // dqRunning flags live only in the Data assets tab, never in Cosmos.
  dataAssets?: PersistedAssetRef[];
  // Phase 1 Purview Unified Catalog wiring — populated by
  // POST /api/items/data-product/[id]/register-purview on success.
  purviewDataProductId?: string;
  lastRegisteredAt?: string;
  // F8 access-policy state. `apimPublished` is stamped by publishApimMirror and
  // gates the Manage-policies dialog (Purview only allows managing access
  // policies on an unpublished product). `accessPolicy` is the saved policy.
  apimPublished?: boolean;
  accessPolicy?: DataProductAccessPolicy;
  // F6 — Publish/Unpublish/Expire lifecycle. Cosmos is the source of truth;
  // managed via POST /api/data-products/[id]/status. Unset == Draft.
  // (lifecycleStatus declared above as a union of both casings.)
  lifecycleStatusAt?: string;
  // F21 Publish-as-API edge — populated by
  // POST /api/items/data-product/[id]/publish-api on success. The subscription
  // KEY is deliberately NOT stored here (ephemeral, shown once in the receipt).
  apimApiId?: string;
  apimProductId?: string;
  apimSubscriptionId?: string;
  apimGatewayUrl?: string;
  apimServiceUrl?: string;
  apimApiPath?: string;
  apimPublishedAt?: string;
  // Inline right-rail attributes — 1:1 with the Purview Unified Catalog
  // data-product details page (F5 / F11 / F12). Persisted to Cosmos state via
  // the partial-merge PATCH /api/data-products/[id].
  updateFrequency?: string;
  termsOfUse?: ExternalLink[];
  documentation?: ExternalLink[];
}

export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DP_EMPTY: DataProductState = {
  displayName: '',
  description: '',
  domain: '',
  owner: '',
  certified: false,
  endorsed: false,
  sla: '',
  bundle: [],
  lifecycleStatus: 'DRAFT',
  termsOfUse: [],
  documentation: [],
};

// Hint payload returned with HTTP 501 from /register-purview when the
// LOOM_PURVIEW_ACCOUNT env var is not set. Mirrors PurviewNotConfiguredHint
// in lib/azure/purview-client.ts.
export interface PurviewNotConfiguredHint {
  missingEnvVar: string;
  bicepModule: string;
  bicepStatus: string;
  rolesRequired: { name: string; scope: string; reason: string }[];
  followUp: string;
}
