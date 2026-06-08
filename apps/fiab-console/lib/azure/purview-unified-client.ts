/**
 * Microsoft Purview UNIFIED CATALOG data-plane client (F22).
 *
 * ----------------------------------------------------------------------------
 * Why this file is SEPARATE from purview-client.ts
 * ----------------------------------------------------------------------------
 * `purview-client.ts` targets the CLASSIC Data Map (Atlas v2 + scan +
 * collections) on `{account}.purview.azure.com`. The NEW Unified Catalog
 * (`purview.microsoft.com`) exposes a DIFFERENT data plane:
 *
 *   {endpoint}/datagovernance/catalog/dataProducts/...   (api-version 2026-03-20-preview)
 *
 * served from the well-known global host `https://api.purview-service.microsoft.com`
 * (or a per-tenant `https://{tenantId}-api.purview-service.microsoft.com`). This
 * client speaks ONLY that surface, for the Loom data-product CRUD adapter
 * (lib/dataproducts/purview-unified-store.ts).
 *
 * Grounding (Microsoft Learn — Unified Catalog REST, 2026-03-20-preview):
 *   - API overview ......... https://learn.microsoft.com/rest/api/purview/unified-catalog-api-overview
 *   - Data Products group .. https://learn.microsoft.com/rest/api/purview/purview-unified-catalog/data-products
 *   - Get .................. GET    {endpoint}/datagovernance/catalog/dataProducts/{id}?api-version=2026-03-20-preview
 *   - List ................. GET    {endpoint}/datagovernance/catalog/dataProducts?api-version=...&domainId=...
 *   - Create ............... POST   {endpoint}/datagovernance/catalog/dataProducts?api-version=...
 *   - Update ............... PUT    {endpoint}/datagovernance/catalog/dataProducts/{id}?api-version=...
 *   - Delete ............... DELETE {endpoint}/datagovernance/catalog/dataProducts/{id}?api-version=...
 *   - Auth ................. https://learn.microsoft.com/purview/data-gov-api-rest-data-plane
 *
 * Token scope: https://purview.azure.net/.default (same data-plane audience as
 * the classic Data Map — confirmed on the Get operation's OAuth2 scope).
 *
 * Auth: ChainedTokenCredential — UAMI first (LOOM_UAMI_CLIENT_ID), then
 * DefaultAzureCredential for local `az login` dev. The Console UAMI must hold
 * the Unified Catalog "Catalog Reader" (read) and "Data Product Owner"
 * (create/update/delete) roles in the target governance domain — these are
 * granted in the Purview portal (NOT ARM RBAC). 401/403 surfaces as a typed
 * PurviewError so the BFF renders an honest infra-gate MessageBar.
 *
 * Env vars (resolved by resolveUnifiedEndpoint):
 *   LOOM_PURVIEW_UC_ENDPOINT        — explicit data-plane endpoint (wins).
 *   LOOM_PURVIEW_UNIFIED_ACCOUNT    — UC account name OR tenant-id prefix; when
 *                                     it is a bare name we use the well-known
 *                                     global host api.purview-service.microsoft.com.
 *   LOOM_PURVIEW_UC_API_VERSION     — pin the api-version (default below).
 *
 * Honest gate: when no endpoint can be resolved, throws
 * PurviewNotConfiguredError (a subclass shared with purview-client.ts) so the
 * route returns 501/503 + a structured remediation hint.
 */
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { PurviewError, PurviewNotConfiguredError, type PurviewNotConfiguredHint } from './purview-client';

/** Purview data-plane audience (same for classic Data Map AND Unified Catalog). */
const UC_SCOPE = 'https://purview.azure.net/.default';

/** Latest Unified Catalog data-plane API version (public preview). */
const UC_API_VERSION = process.env.LOOM_PURVIEW_UC_API_VERSION || '2026-03-20-preview';

/** Well-known global Commercial Unified Catalog host (per the Get URI example). */
const UC_WELL_KNOWN_HOST = 'https://api.purview-service.microsoft.com';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

// ============================================================
// Types (mapped 1:1 to the REST DataProduct schema)
// ============================================================

export interface UCContact {
  id: string;
  description?: string;
}

export interface UCContactsMap {
  owner?: UCContact[];
  expert?: UCContact[];
  databaseAdmin?: UCContact[];
}

export interface UCExternalLink {
  url: string;
  name?: string;
  dataAssetId?: string;
}

export interface UCManagedAttribute {
  name: string;
  value: string;
  isRequired?: boolean;
}

export interface UCSystemData {
  createdAt?: string;
  createdBy?: string;
  lastModifiedAt?: string;
  lastModifiedBy?: string;
  expiredAt?: string;
  expiredBy?: string;
}

export interface UCDataProduct {
  id: string;
  name: string;
  domain: string;
  type?: string;
  description?: string;
  businessUse?: string;
  status?: 'DRAFT' | 'PUBLISHED' | 'EXPIRED';
  endorsed?: boolean;
  updateFrequency?: string;
  contacts?: UCContactsMap;
  documentation?: UCExternalLink[];
  termsOfUse?: UCExternalLink[];
  sensitivityLabel?: string;
  managedAttributes?: UCManagedAttribute[];
  additionalProperties?: { assetCount?: number };
  systemData?: UCSystemData;
}

/** Create/update payload. `name` + `domain` are required by the REST surface. */
export interface UCDataProductPayload extends Partial<UCDataProduct> {
  name: string;
  domain: string;
}

// ============================================================
// Configuration / endpoint resolution
// ============================================================

function unifiedNotConfiguredHint(): PurviewNotConfiguredHint {
  return {
    missingEnvVar: 'LOOM_PURVIEW_UNIFIED_ACCOUNT (or LOOM_PURVIEW_UC_ENDPOINT)',
    bicepModule: 'platform/fiab/bicep/modules/admin-plane/main.bicep',
    bicepStatus:
      'Set loomPurviewUnifiedAccount (=> LOOM_PURVIEW_UNIFIED_ACCOUNT) to your Purview ' +
      'Unified Catalog account name and loomDataproductsBackend="unified-catalog" on a ' +
      'Commercial deployment. The Unified Catalog REST surface is reached at ' +
      'https://api.purview-service.microsoft.com (or a per-tenant ' +
      'https://{tenantId}-api.purview-service.microsoft.com via LOOM_PURVIEW_UC_ENDPOINT).',
    rolesRequired: [
      {
        name: 'Catalog Reader',
        scope: 'Governance domain (granted in purview.microsoft.com — NOT ARM RBAC)',
        reason: 'Read data products (list / get) in the Unified Catalog.',
      },
      {
        name: 'Data Product Owner',
        scope: 'Governance domain (granted in purview.microsoft.com — NOT ARM RBAC)',
        reason: 'Create / update / delete data products in the Unified Catalog.',
      },
    ],
    followUp:
      'Operator action: (1) set loomDataproductsBackend="unified-catalog" + ' +
      'loomPurviewUnifiedAccount in admin-plane/main.bicep (Commercial only — ' +
      'GCC/GCC-High/IL5 fall through to Cosmos), (2) grant the Loom Console UAMI ' +
      'Catalog Reader + Data Product Owner in the target governance domain via ' +
      'the Purview portal (Unified Catalog > Catalog management > Governance ' +
      'domains > <domain> > Roles), then redeploy. See ' +
      'scripts/csa-loom/grant-purview-uc-role.sh.',
  };
}

/**
 * Resolve the Unified Catalog data-plane endpoint (no trailing slash).
 *   1. LOOM_PURVIEW_UC_ENDPOINT — explicit, wins (full URL or host).
 *   2. LOOM_PURVIEW_UNIFIED_ACCOUNT — when it is itself a host/URL, use it;
 *      otherwise resolve to the well-known global Commercial host. The account
 *      name confirms a UC account exists; the REST host is the tenant-agnostic
 *      api.purview-service.microsoft.com endpoint, NOT {account}.purview.azure.com.
 * Throws PurviewNotConfiguredError when neither is set.
 */
export function resolveUnifiedEndpoint(): string {
  const explicit = process.env.LOOM_PURVIEW_UC_ENDPOINT;
  if (explicit) return normalizeHost(explicit);
  const account = process.env.LOOM_PURVIEW_UNIFIED_ACCOUNT;
  if (account) {
    // If the value already looks like a host/URL, honor it; else use the
    // well-known global host (the account name alone is not part of the host).
    if (/\./.test(account) || /^https?:\/\//i.test(account)) return normalizeHost(account);
    return UC_WELL_KNOWN_HOST;
  }
  throw new PurviewNotConfiguredError(unifiedNotConfiguredHint());
}

function normalizeHost(raw: string): string {
  let v = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  return v;
}

/** True when an explicit UC endpoint OR account is configured. */
export function isUnifiedConfigured(): boolean {
  return !!(process.env.LOOM_PURVIEW_UC_ENDPOINT || process.env.LOOM_PURVIEW_UNIFIED_ACCOUNT);
}

// ============================================================
// Low-level fetch
// ============================================================

async function ucFetch(
  path: string,
  init: RequestInit & { query?: Record<string, string> } = {},
): Promise<Response> {
  const token = await credential.getToken(UC_SCOPE);
  if (!token?.token) throw new PurviewError(401, null, 'Failed to acquire Purview Unified Catalog data-plane token');
  const base = resolveUnifiedEndpoint();
  const sep = path.includes('?') ? '&' : '?';
  const extra = init.query ? '&' + new URLSearchParams(init.query).toString() : '';
  const url = `${base}${path}${sep}api-version=${UC_API_VERSION}${extra}`;
  const { query: _q, ...rest } = init;
  return fetch(url, {
    ...rest,
    cache: 'no-store',
    headers: {
      ...(rest.headers || {}),
      authorization: `Bearer ${token.token}`,
      'content-type': 'application/json',
    },
  });
}

async function readJson<T>(res: Response): Promise<T | null> {
  if (res.status === 404) return null;
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!res.ok) {
    const msg =
      (parsed as any)?.error?.message ||
      (parsed as any)?.message ||
      (typeof parsed === 'string' ? parsed : `Purview Unified Catalog ${res.status}`);
    throw new PurviewError(res.status, parsed, msg);
  }
  return (parsed as T) ?? ({} as T);
}

const UC_BASE_PATH = '/datagovernance/catalog/dataProducts';

// ============================================================
// Data Products CRUD
// ============================================================

/** GET {endpoint}/datagovernance/catalog/dataProducts/{id} — returns null on 404. */
export async function ucGet(dataProductId: string): Promise<UCDataProduct | null> {
  if (!dataProductId) throw new PurviewError(400, null, 'dataProductId is required');
  const res = await ucFetch(`${UC_BASE_PATH}/${encodeURIComponent(dataProductId)}`);
  return readJson<UCDataProduct>(res);
}

/**
 * GET {endpoint}/datagovernance/catalog/dataProducts — list with optional
 * domain filter + pagination. The REST surface returns a paged envelope
 * (`{ value: [...] }`); we tolerate a bare array too.
 */
export async function ucList(
  opts: { domainId?: string; top?: number; skip?: number } = {},
): Promise<UCDataProduct[]> {
  const query: Record<string, string> = {};
  if (opts.domainId) query.domainId = opts.domainId;
  if (typeof opts.top === 'number') query.top = String(opts.top);
  if (typeof opts.skip === 'number') query.skip = String(opts.skip);
  const res = await ucFetch(UC_BASE_PATH, { query });
  const j = await readJson<{ value?: UCDataProduct[] } | UCDataProduct[]>(res);
  if (!j) return [];
  return Array.isArray(j) ? j : (j.value || []);
}

/** POST {endpoint}/datagovernance/catalog/dataProducts — create a data product. */
export async function ucCreate(body: UCDataProductPayload): Promise<UCDataProduct> {
  if (!body?.name) throw new PurviewError(400, null, 'name is required');
  if (!body?.domain) throw new PurviewError(400, null, 'domain is required');
  const res = await ucFetch(UC_BASE_PATH, { method: 'POST', body: JSON.stringify(body) });
  const j = await readJson<UCDataProduct>(res);
  if (!j) throw new PurviewError(500, null, 'Purview Unified Catalog returned empty body on create');
  return j;
}

/** PUT {endpoint}/datagovernance/catalog/dataProducts/{id} — update a data product. */
export async function ucUpdate(
  dataProductId: string,
  patch: Partial<UCDataProductPayload>,
): Promise<UCDataProduct> {
  if (!dataProductId) throw new PurviewError(400, null, 'dataProductId is required');
  const res = await ucFetch(`${UC_BASE_PATH}/${encodeURIComponent(dataProductId)}`, {
    method: 'PUT',
    body: JSON.stringify({ id: dataProductId, ...patch }),
  });
  const j = await readJson<UCDataProduct>(res);
  if (!j) throw new PurviewError(500, null, 'Purview Unified Catalog returned empty body on update');
  return j;
}

/** DELETE {endpoint}/datagovernance/catalog/dataProducts/{id}. Returns false on 404. */
export async function ucRemove(dataProductId: string): Promise<boolean> {
  if (!dataProductId) throw new PurviewError(400, null, 'dataProductId is required');
  const res = await ucFetch(`${UC_BASE_PATH}/${encodeURIComponent(dataProductId)}`, { method: 'DELETE' });
  if (res.status === 404) return false;
  if (!res.ok && res.status !== 204) {
    await readJson<unknown>(res); // throws PurviewError with the upstream message
  }
  return true;
}
