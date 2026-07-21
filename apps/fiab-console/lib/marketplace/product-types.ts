/**
 * WS-10.4 Living Marketplace (BTB-11) — the UNIFIED product schema.
 *
 * One Cosmos record shape (`marketplace` container, PK /tenantId) covers ALL
 * five publishable/subscribable product kinds so the exchange lists, certifies,
 * entitles, and bills them through a single pipeline:
 *
 *   data      a governed data product (ADLS/Delta/warehouse output ports)
 *   agent     a published agent-flow (WS-5.1) — subscribe to invoke as MCP/REST
 *   mcp       a deployable MCP server from the MCP library
 *   app       a loom-app (WS-4.x) published for other tenants/workspaces
 *   ontology  an ontology object (WS-6) exposed as a subscribable model + SDK
 *
 * This is a UNIFICATION+EXTENSION: the existing per-kind publish surfaces
 * (data-products marketplace, agent publish-as-MCP, MCP catalog, loom-apps
 * publish, ontology SDK) keep working; this schema is the single exchange record
 * they all project into so Discover/Catalog/subscribe are one code path.
 *
 * Pure data + builders (no Azure SDK import) so it is unit-testable and safe to
 * import from both the BFF route and (types only) the client surface.
 */

/** The five unified product kinds. */
export type ProductKind = 'data' | 'agent' | 'mcp' | 'app' | 'ontology';

export const PRODUCT_KINDS: ProductKind[] = ['data', 'agent', 'mcp', 'app', 'ontology'];

/**
 * Certification state — REAL, never decorative. `certified` is set ONLY by the
 * publish pipeline after the product's required gates all evaluate `configured`
 * (see certification.ts). `failed` means the auto-cert run found a blocked gate;
 * `draft` is the pre-publish / not-yet-certified state.
 */
export type CertificationStatus = 'draft' | 'certified' | 'failed';

/** How subscribing grants access. */
export type AccessModel =
  | 'open'      // immediate zero-touch grant on subscribe (self-serve)
  | 'request';  // subscribe files a request the owner must approve (governed)

export type PublishStatus = 'draft' | 'published' | 'deprecated';

/** The gate-run receipt captured at certification time (no-vaporware: real). */
export interface CertGateResult {
  gateId: string;
  title: string;
  status: 'configured' | 'blocked';
  /** Missing env vars when blocked (the honest remediation). */
  missing: string[];
}

/** Per-kind display + routing + default entitlement/billing metadata. */
export interface ProductKindMeta {
  kind: ProductKind;
  label: string;
  /** Item-type slug for the shared BrandedItemIcon / item-type-visual registry. */
  iconType: string;
  /** Human blurb used in the publish picker. */
  blurb: string;
  /** resourceType stamped on the entitlement ledger row for this kind. */
  grantResourceType: string;
  /** Default logical role a subscriber receives. */
  defaultRole: string;
  /** Default LCU metered per subscription for this kind. */
  defaultLcuPerSubscription: number;
}

export const PRODUCT_KIND_META: Record<ProductKind, ProductKindMeta> = {
  data: {
    kind: 'data',
    label: 'Data product',
    iconType: 'data-product',
    blurb: 'A governed dataset with declared output ports (ADLS / Delta / warehouse).',
    grantResourceType: 'marketplace-data',
    defaultRole: 'Data Reader',
    defaultLcuPerSubscription: 2,
  },
  agent: {
    kind: 'agent',
    label: 'Agent',
    iconType: 'agent-flow',
    blurb: 'A published agent-flow other teams can subscribe to and invoke as MCP/REST.',
    grantResourceType: 'marketplace-agent',
    defaultRole: 'Agent Consumer',
    defaultLcuPerSubscription: 5,
  },
  mcp: {
    kind: 'mcp',
    label: 'MCP server',
    iconType: 'mcp-server',
    blurb: 'A deployable Model Context Protocol server from the MCP library.',
    grantResourceType: 'marketplace-mcp',
    defaultRole: 'MCP Consumer',
    defaultLcuPerSubscription: 3,
  },
  app: {
    kind: 'app',
    label: 'App',
    iconType: 'loom-app',
    blurb: 'A published loom-app installable into another workspace.',
    grantResourceType: 'marketplace-app',
    defaultRole: 'App User',
    defaultLcuPerSubscription: 4,
  },
  ontology: {
    kind: 'ontology',
    label: 'Ontology',
    iconType: 'ontology',
    blurb: 'An ontology object exposed as a subscribable semantic model + SDK.',
    grantResourceType: 'marketplace-ontology',
    defaultRole: 'Ontology Consumer',
    defaultLcuPerSubscription: 2,
  },
};

/**
 * The unified marketplace product record (Cosmos `marketplace`, PK /tenantId).
 * One shape for all five kinds — discriminated by `productKind`.
 */
export interface MarketplaceProduct {
  /** `mp-<kind>-<slug>` — deterministic within a tenant. */
  id: string;
  /** Cosmos doc discriminator (all rows in this container). */
  docType: 'marketplace-product';
  /** Partition key. */
  tenantId: string;
  productKind: ProductKind;

  name: string;               // machine slug
  displayName: string;
  description?: string;
  domain?: string;
  tags?: string[];

  owner?: string;             // owner UPN
  ownerOid?: string;          // owner Entra object id (grantedBy / approver)

  /** The concrete backing item this product wraps (agent-flow id, ontology id…). */
  sourceItemId?: string;
  sourceItemType?: string;
  sourceWorkspaceId?: string;

  // --- certification (auto-cert via gate registry) ---------------------------
  certification: CertificationStatus;
  certifiedAt?: string;
  /** The gate ids the pipeline evaluated for this kind. */
  requiredGateIds: string[];
  /** The gate-run receipt (real evaluation, not a claim). */
  certGates: CertGateResult[];

  // --- entitlement (access-governance) ---------------------------------------
  accessModel: AccessModel;
  grantResourceType: string;
  grantRole: string;

  // --- billing (LCU chargeback) ----------------------------------------------
  /** LCU metered to the subscriber's tenant on each subscribe. */
  lcuPerSubscription: number;

  publishStatus: PublishStatus;
  subscriberCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Slugify a display name into a stable machine name. */
export function slugify(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60) || 'product';
}

/** Deterministic product id within a tenant. */
export function productId(kind: ProductKind, name: string): string {
  return `mp-${kind}-${slugify(name)}`;
}

export interface BuildProductInput {
  tenantId: string;
  productKind: ProductKind;
  displayName: string;
  description?: string;
  domain?: string;
  tags?: string[];
  owner?: string;
  ownerOid?: string;
  sourceItemId?: string;
  sourceItemType?: string;
  sourceWorkspaceId?: string;
  accessModel?: AccessModel;
  lcuPerSubscription?: number;
  grantRole?: string;
}

/**
 * Build a fresh product record (pre-certification). PURE — the publish route
 * then runs auto-cert and persists. `certification` starts `draft`; the pipeline
 * flips it to `certified`/`failed` from a real gate run.
 */
export function buildProduct(input: BuildProductInput, now = new Date().toISOString()): MarketplaceProduct {
  const meta = PRODUCT_KIND_META[input.productKind];
  const name = slugify(input.displayName);
  return {
    id: productId(input.productKind, input.displayName),
    docType: 'marketplace-product',
    tenantId: input.tenantId,
    productKind: input.productKind,
    name,
    displayName: input.displayName,
    description: input.description,
    domain: input.domain,
    tags: input.tags,
    owner: input.owner,
    ownerOid: input.ownerOid,
    sourceItemId: input.sourceItemId,
    sourceItemType: input.sourceItemType,
    sourceWorkspaceId: input.sourceWorkspaceId,
    certification: 'draft',
    requiredGateIds: [],
    certGates: [],
    accessModel: input.accessModel || 'open',
    grantResourceType: meta.grantResourceType,
    grantRole: input.grantRole || meta.defaultRole,
    lcuPerSubscription:
      typeof input.lcuPerSubscription === 'number' && input.lcuPerSubscription >= 0
        ? input.lcuPerSubscription
        : meta.defaultLcuPerSubscription,
    publishStatus: 'draft',
    subscriberCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}
