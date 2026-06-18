/**
 * domain-registry — the AUTHORITATIVE tenant topology store (audit-t158).
 *
 * A Loom "domain" is the governance-scoped grouping the /admin/domains surface
 * and the workspace-create wizard both read. As of t158 the SAME Cosmos doc
 * (`tenant-settings` id=`domains:<tenantId>`, partition `/tenantId`) is also the
 * authoritative tenant TOPOLOGY: each domain may carry the Data Landing Zone it
 * is bound to — its subscription(s), resource group, region, capacity sizing,
 * the Entra admin/member groups that back the domain-admin tier, and the
 * chargeback/cost-center tags. `dlz-attach` (orchestrator) registers/updates a
 * domain here automatically via the token-gated internal API
 * (`/api/internal/topology/register-domain`); the /admin/domains UI lets a
 * tenant admin do the same by hand ("attach existing subscription").
 *
 * This module is the single source of truth for the domain types, the starter
 * seed, the load-or-seed read path, and the topology-field validators so the
 * admin route, the internal register route, and the workspace-create routes all
 * agree. NO Fabric dependency — pure Cosmos + Azure-native (no-fabric-dependency.md).
 */
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';

/** Lifecycle of a domain's DLZ binding. */
export type DomainStatus =
  | 'registered' // created in the registry, no live DLZ attached yet
  | 'attaching' // dlz-attach deployment in flight
  | 'active' // DLZ deployed + bound (subscription + RG present)
  | 'detached' // DLZ removed / unbound
  | 'error'; // last attach/register failed

export const DOMAIN_STATUSES: DomainStatus[] = [
  'registered',
  'attaching',
  'active',
  'detached',
  'error',
];

/**
 * Capacity F-SKU set — identical to the Setup Wizard's CAPACITY_OPTIONS and the
 * orchestrator DeployRequest.capacity_sku Literal, so the topology binding can't
 * drift from what dlz-attach actually deploys.
 */
export const VALID_CAPACITY_SKUS = ['F2', 'F4', 'F8', 'F32', 'F64', 'F128', 'F512'] as const;
export type CapacitySku = (typeof VALID_CAPACITY_SKUS)[number];

/** The chargeback tag KEY stamped on every DLZ resource (ARG inventory + Cost Management key off it). */
export const DOMAIN_TAG_KEY = 'loom-domain';

/** Build the canonical chargeback tag value (`loom-domain:<id>`) for a domain. */
export function domainChargebackTag(domainId: string): string {
  return `${DOMAIN_TAG_KEY}:${domainId}`;
}

export interface DomainContributors {
  scope: 'AllTenant' | 'AdminsOnly' | 'SpecificUsersAndGroups';
  users?: string[];
}

export interface DomainDelegatedSettings {
  defaultSensitivityLabelId?: string;
  defaultSensitivityLabelName?: string;
  /** Whether the label id refers to a Loom-native label (vs an M365/MIP label). */
  defaultSensitivityLabelSource?: 'mip' | 'loom';
  certificationEnabled?: boolean;
  certificationUrl?: string;
  certifiers?: string[];
}

export interface DomainItem {
  id: string;
  name: string;
  description?: string;
  color?: string;
  /**
   * Fluent icon NAME representing this domain (see lib/domains/domain-icons
   * DOMAIN_ICONS). Rendered as a white glyph on a `themeColor` chip. Optional
   * with a safe default ('building') so legacy domains keep rendering.
   */
  icon?: string;
  /** Brand-ish theme color (hex) for the domain glyph chip. Defaults to brand blue. */
  themeColor?: string;
  owners?: string[];
  /** Domain admins (UPNs / group names) — can change domain settings. */
  admins?: string[];
  /** Who may assign workspaces to this domain. */
  contributors?: DomainContributors;
  /** Users/groups for default-domain auto-assign. */
  defaultDomainUsers?: string[];
  /** Tenant-setting overrides delegated to the domain level. */
  delegatedSettings?: DomainDelegatedSettings;
  /** Image picker selection: "color::#0078d4" | "icon::finance" | "blob::<name>". */
  imageKey?: string;
  /** Parent domain id when this is a subdomain. */
  parentId?: string;
  /** Mirror link ids written by the unified mapper. */
  purviewDomainId?: string;
  unityCatalogName?: string;
  unitySchemaName?: string;

  // ── DLZ binding / tenant topology (t158) ─────────────────────────────────
  /** Attached DLZ subscription(s). subscriptionIds[0] is the deploy target (t159). */
  subscriptionIds?: string[];
  /** The DLZ resource group, e.g. rg-csa-loom-dlz-<id>-<location>. */
  dlzRg?: string;
  /** Azure region the DLZ lives in (ARM region name, e.g. eastus2 / usgovvirginia). */
  location?: string;
  /** Capacity sizing the DLZ was deployed at (F-SKU equivalence). */
  capacitySku?: CapacitySku;
  /** Entra group object-id of the domain ADMINS tier (backs domain-admin RBAC, t160). */
  adminGroupId?: string;
  /** Entra group object-id of the domain MEMBERS/contributors tier (t160). */
  memberGroupId?: string;
  /** Chargeback cost center (free-text accounting code; D4). */
  costCenter?: string;
  /** Chargeback tag value stamped on DLZ resources (`loom-domain:<id>`). */
  chargebackTag?: string;
  /** DLZ binding lifecycle status. */
  status?: DomainStatus;

  createdAt: string;
  createdBy: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface DomainsDoc {
  id: string;
  tenantId: string;
  kind: 'domains';
  items: DomainItem[];
  updatedAt: string;
}

/**
 * Starter domain set seeded into a tenant's domains doc the first time it is
 * created — so the Domains surface (and the REQUIRED workspace→domain binding)
 * is never empty in a fresh environment. These are REAL, fully-editable Cosmos
 * domains, not hard-coded UI placeholders.
 *
 * The `default` domain is the guaranteed binding target for legacy / single-
 * domain tenants: the workspace wizard preselects it so "domain is required"
 * never strands a tenant that hasn't attached a DLZ yet.
 */
export function starterDomains(who: string): DomainItem[] {
  const now = new Date().toISOString();
  const base = (
    id: string,
    name: string,
    description: string,
    icon: string,
    themeColor: string,
    parentId?: string,
  ): DomainItem => ({
    id,
    name,
    description,
    icon,
    themeColor,
    parentId,
    status: 'registered',
    createdAt: now,
    createdBy: who,
  });
  // Each starter ships with a themed Fluent icon + color so the Domains surface
  // renders icon-in-colored-chip out of the box (never plain colored squares):
  //   Default → building/home · Finance → money · Sales & Marketing → megaphone
  //   Operations → gear · People & HR → people.
  return [
    base('default', 'Default', 'Default domain — the fallback binding for workspaces until a Data Landing Zone is attached.', 'building', '#0078d4'),
    base('finance', 'Finance', 'Financial planning, reporting, and chargeback data products.', 'money', '#107c10'),
    base('sales-marketing', 'Sales & Marketing', 'Pipeline, campaign, and customer-360 data products.', 'megaphone', '#e3008c'),
    base('operations', 'Operations', 'Supply-chain, logistics, and operational telemetry.', 'gear', '#5c2d91'),
    base('people', 'People & HR', 'Workforce, recruiting, and people-analytics data products.', 'people', '#bd7800', 'operations'),
  ];
}

/** The id of the guaranteed fallback domain (used by the workspace binding default). */
export const DEFAULT_DOMAIN_ID = 'default';

function domainsDocId(tenantId: string): string {
  return `domains:${tenantId}`;
}

/**
 * Read the tenant's domains doc, seeding the starter set on first access. This is
 * the single read path shared by the admin route, the internal register route,
 * and the workspace-create domain validator so they can never disagree about
 * what domains exist.
 */
export async function loadOrSeedDomains(tenantId: string, who: string): Promise<DomainsDoc> {
  const c = await tenantSettingsContainer();
  const docId = domainsDocId(tenantId);
  try {
    const { resource } = await c.item(docId, tenantId).read<DomainsDoc>();
    if (resource) return resource;
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  const seed: DomainsDoc = {
    id: docId,
    tenantId,
    kind: 'domains',
    items: starterDomains(who),
    updatedAt: new Date().toISOString(),
  };
  await c.items.create(seed);
  return seed;
}

/** Does a domain id exist in this tenant's registry? (Seeds the starter set if absent.) */
export async function domainExists(tenantId: string, domainId: string): Promise<boolean> {
  const doc = await loadOrSeedDomains(tenantId, tenantId);
  return doc.items.some((d) => d.id === domainId);
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Normalize a subscription-id list to deduped, lower-cased GUIDs. */
export function normalizeSubscriptionIds(raw: unknown): string[] | undefined {
  const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const out = Array.from(
    new Set(
      arr
        .map((s) => String(s).trim().toLowerCase())
        .filter((s) => GUID_RE.test(s)),
    ),
  );
  return out.length ? out : undefined;
}

export function isValidGuid(v: unknown): v is string {
  return typeof v === 'string' && GUID_RE.test(v.trim());
}

export function isValidCapacitySku(v: unknown): v is CapacitySku {
  return typeof v === 'string' && (VALID_CAPACITY_SKUS as readonly string[]).includes(v);
}

export function isValidDomainStatus(v: unknown): v is DomainStatus {
  return typeof v === 'string' && DOMAIN_STATUSES.includes(v as DomainStatus);
}

/**
 * The DLZ binding fields a tenant admin (or the dlz-attach callback) may set on a
 * domain. Parsed + validated from a request body into a partial DomainItem.
 * Returns `{ patch }` on success or `{ error }` (a 400-worthy message) on the
 * first invalid field. An empty body yields an empty patch (no-op).
 */
export function parseTopologyPatch(
  body: any,
): { patch: Partial<DomainItem> } | { error: string } {
  const patch: Partial<DomainItem> = {};

  if (body?.subscriptionIds !== undefined) {
    if (body.subscriptionIds === null) {
      patch.subscriptionIds = undefined;
    } else {
      const subs = normalizeSubscriptionIds(body.subscriptionIds);
      if (Array.isArray(body.subscriptionIds) && body.subscriptionIds.length && !subs) {
        return { error: 'subscriptionIds must be valid Azure subscription GUIDs' };
      }
      patch.subscriptionIds = subs;
    }
  }
  if (body?.dlzRg !== undefined) {
    patch.dlzRg = String(body.dlzRg || '').trim() || undefined;
  }
  if (body?.location !== undefined) {
    patch.location = String(body.location || '').trim() || undefined;
  }
  if (body?.capacitySku !== undefined) {
    if (body.capacitySku && !isValidCapacitySku(body.capacitySku)) {
      return { error: `capacitySku must be one of ${VALID_CAPACITY_SKUS.join(', ')}` };
    }
    patch.capacitySku = body.capacitySku || undefined;
  }
  if (body?.adminGroupId !== undefined) {
    const v = String(body.adminGroupId || '').trim();
    if (v && !isValidGuid(v)) return { error: 'adminGroupId must be an Entra group object-id (GUID)' };
    patch.adminGroupId = v || undefined;
  }
  if (body?.memberGroupId !== undefined) {
    const v = String(body.memberGroupId || '').trim();
    if (v && !isValidGuid(v)) return { error: 'memberGroupId must be an Entra group object-id (GUID)' };
    patch.memberGroupId = v || undefined;
  }
  if (body?.costCenter !== undefined) {
    patch.costCenter = String(body.costCenter || '').trim().slice(0, 128) || undefined;
  }
  if (body?.chargebackTag !== undefined) {
    patch.chargebackTag = String(body.chargebackTag || '').trim().slice(0, 256) || undefined;
  }
  if (body?.status !== undefined) {
    if (!isValidDomainStatus(body.status)) {
      return { error: `status must be one of ${DOMAIN_STATUSES.join(', ')}` };
    }
    patch.status = body.status;
  }
  return { patch };
}

/** Input to the orchestrator → console domain-registration callback (t157 dlz-attach). */
export interface DomainBindingInput {
  domainId: string;
  name?: string;
  description?: string;
  subscriptionId?: string;
  subscriptionIds?: string[];
  dlzRg?: string;
  location?: string;
  capacitySku?: string;
  adminGroupId?: string;
  memberGroupId?: string;
  costCenter?: string;
  chargebackTag?: string;
  status?: DomainStatus;
}

/**
 * Upsert a DLZ binding onto the tenant's domain registry — the write the internal
 * register-domain route performs on behalf of dlz-attach. Creates the domain if
 * absent, merges the binding fields when it exists, stamps the canonical
 * chargeback tag, and (unless told otherwise) flips status to `active` once a
 * subscription is bound. Returns the resulting domain item.
 */
export async function upsertDomainBinding(
  tenantId: string,
  who: string,
  input: DomainBindingInput,
): Promise<DomainItem> {
  const id = String(input.domainId || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
  if (!id) throw new Error('domainId is required');

  const c = await tenantSettingsContainer();
  const docId = domainsDocId(tenantId);
  const doc = await loadOrSeedDomains(tenantId, who);

  const subs = normalizeSubscriptionIds(
    input.subscriptionIds && input.subscriptionIds.length
      ? input.subscriptionIds
      : input.subscriptionId
        ? [input.subscriptionId]
        : undefined,
  );

  const now = new Date().toISOString();
  const idx = doc.items.findIndex((d) => d.id === id);
  const existing = idx >= 0 ? doc.items[idx] : undefined;

  // Merge subscription ids (union — a domain may have >1 attached sub).
  const mergedSubs = subs
    ? Array.from(new Set([...(existing?.subscriptionIds || []), ...subs]))
    : existing?.subscriptionIds;

  const hasSub = !!(mergedSubs && mergedSubs.length);
  const status: DomainStatus = isValidDomainStatus(input.status)
    ? input.status
    : hasSub
      ? 'active'
      : existing?.status || 'registered';

  const next: DomainItem = {
    ...existing,
    id,
    name: (input.name || existing?.name || id).toString().trim(),
    description: input.description ?? existing?.description,
    parentId: existing?.parentId,
    subscriptionIds: mergedSubs,
    dlzRg: input.dlzRg?.trim() || existing?.dlzRg,
    location: input.location?.trim() || existing?.location,
    capacitySku: isValidCapacitySku(input.capacitySku)
      ? input.capacitySku
      : existing?.capacitySku,
    adminGroupId: isValidGuid(input.adminGroupId) ? input.adminGroupId : existing?.adminGroupId,
    memberGroupId: isValidGuid(input.memberGroupId) ? input.memberGroupId : existing?.memberGroupId,
    costCenter: input.costCenter?.trim() || existing?.costCenter,
    chargebackTag: input.chargebackTag?.trim() || existing?.chargebackTag || domainChargebackTag(id),
    status,
    createdAt: existing?.createdAt || now,
    createdBy: existing?.createdBy || who,
    updatedAt: now,
    updatedBy: who,
  };

  if (idx >= 0) doc.items[idx] = next;
  else doc.items.push(next);
  doc.updatedAt = now;
  await c.item(docId, tenantId).replace(doc);
  return next;
}
