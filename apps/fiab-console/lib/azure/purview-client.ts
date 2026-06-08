/**
 * Microsoft Purview CLASSIC Data Map data-plane client.
 *
 * ----------------------------------------------------------------------------
 * Why this file targets the CLASSIC Data Map (and not the new unified catalog)
 * ----------------------------------------------------------------------------
 * The account provisioned for CSA Loom (`purview-csa-loom-eastus2`, created via
 * ARM `Microsoft.Purview/accounts`) is a CLASSIC Data Map account. It exposes:
 *
 *   catalog/Atlas : https://{account}.purview.azure.com/datamap/api/atlas/v2/...
 *   discovery     : https://{account}.purview.azure.com/datamap/api/search/query
 *   account dp    : https://{account}.purview.azure.com/collections
 *   scan          : https://{account}.purview.azure.com/scan/datasources/...
 *
 * It does NOT expose the new unified-catalog host `{account}-api.purview.azure.com`
 * nor the `/datagovernance/...` surface (business domains, data products). That
 * host only exists for accounts created in the *new* Purview unified-catalog
 * experience (purview.microsoft.com), which is NOT provisionable via ARM
 * `az purview account create`. Calling the `-api` host against a classic account
 * fails DNS (HTTP 000), which is exactly what broke Loom's governance surfaces.
 *
 * Endpoints (all grounded in Microsoft Learn — see the per-function comments):
 *   - Data Map API versions ...... https://learn.microsoft.com/rest/api/purview/azure.analytics.purview.datamap/versions
 *   - Discovery Query ............ https://learn.microsoft.com/rest/api/purview/datamapdataplane/discovery/query
 *   - Operation groups ........... https://learn.microsoft.com/rest/api/purview/datamapdataplane/operation-groups
 *   - Account/Collections dp ..... https://learn.microsoft.com/rest/api/purview/accountdataplane/collections/list-collections
 *   - Scan data sources .......... https://learn.microsoft.com/rest/api/purview/scanningdataplane/data-sources
 *   - Atlas 2.2 / typedefs ....... https://learn.microsoft.com/purview/data-gov-api-atlas-2-2
 *   - Lineage REST ............... https://learn.microsoft.com/purview/data-gov-api-create-lineage-relationships
 *
 * Token scope: https://purview.azure.net/.default  (the Data Map data-plane
 * audience; confirmed on the Discovery Query reference page's OAuth2 scope).
 *
 * Host: https://{account}.purview.azure.com   (NOT -api).
 *
 * Auth: ChainedTokenCredential — UAMI first (LOOM_UAMI_CLIENT_ID), then
 * DefaultAzureCredential for local `az login` dev.
 *
 * UAMI permissions (classic Data Map data-plane roles, granted via collection
 * metadata policy — NOT ARM RBAC):
 *   - Data Curator           → read/write catalog (Atlas entities, glossary, lineage)
 *   - Data Reader            → read-only catalog
 *   - Data Source Administrator → register sources + run scans
 *   - Collection Admin       → manage collections + assign data-plane roles
 * See scripts/csa-loom/grant-purview-datamap-role.sh.
 *
 * Env vars:
 *   LOOM_PURVIEW_ACCOUNT — short account name (e.g. `purview-csa-loom-eastus2`),
 *                          NOT a full URL. The client appends `.purview.azure.com`.
 *
 * Honest gates (per .claude/rules/no-vaporware.md):
 *   - LOOM_PURVIEW_ACCOUNT unset → PurviewNotConfiguredError (501/503 + hint).
 *   - new-unified-catalog-only concepts (business domains, data products, the
 *     `/datagovernance` surface) → PurviewUnifiedCatalogGateError (a typed
 *     subclass carrying an honest-gate hint). NEVER fabricated data.
 *   - 401/403 from the data plane → PurviewError(status) ("UAMI lacks Data Map role").
 *   - DNS/000 → surfaced by probePurview as 'not_configured' with the actionable hint.
 */
import { randomUUID } from 'node:crypto';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';

const PURVIEW_SCOPE = 'https://purview.azure.net/.default';

/** Data Map data plane (Atlas v2 + Discovery). GA stable version. */
const DATAMAP_API_VERSION = '2023-09-01';
/** Account data plane (collections). */
const ACCOUNT_API_VERSION = '2019-11-01-preview';
/** Scanning data plane (data sources, scans, triggers, runs). */
const SCAN_API_VERSION = '2022-07-01-preview';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

// ============================================================
// Errors
// ============================================================

export interface PurviewNotConfiguredHint {
  missingEnvVar: string;
  bicepModule: string;
  bicepStatus: string;
  rolesRequired: { name: string; scope: string; reason: string }[];
  followUp: string;
}

/**
 * Thrown when LOOM_PURVIEW_ACCOUNT is not set. The BFF translates this into an
 * HTTP 501/503 with the hint payload so the operator sees an actionable next
 * step in the editor MessageBar.
 */
export class PurviewNotConfiguredError extends Error {
  hint: PurviewNotConfiguredHint;
  constructor(hint: PurviewNotConfiguredHint) {
    super(`Microsoft Purview is not provisioned in this deployment: missing ${hint.missingEnvVar}`);
    this.hint = hint;
  }
}

/**
 * Thrown by functions that map to the NEW unified-catalog experience
 * (`/datagovernance` — business domains, data products) when the deployed
 * account is a CLASSIC Data Map account. It is a *subclass* of
 * PurviewNotConfiguredError so every existing BFF catch-block renders it as an
 * honest 501/503 + hint MessageBar with ZERO fabricated data — the full UI
 * surface still renders; only the unified-catalog-only tab shows the gate.
 */
export class PurviewUnifiedCatalogGateError extends PurviewNotConfiguredError {
  /** Discriminator so the UI can theme the gate differently from "unset". */
  gate: 'unified-catalog-only' = 'unified-catalog-only';
  constructor(concept: string) {
    super(unifiedCatalogGateHint(concept));
  }
}

export class PurviewError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `Purview Data Map call failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

// ============================================================
// Configuration
// ============================================================

function notConfiguredHint(missing: string): PurviewNotConfiguredHint {
  return {
    missingEnvVar: missing,
    bicepModule: 'platform/fiab/bicep/modules/admin-plane/catalog.bicep',
    bicepStatus:
      'Deploys a CLASSIC Microsoft.Purview/accounts (Data Map) + a UAMI role assignment. ' +
      'Set LOOM_PURVIEW_ACCOUNT to the deployed account name (short name, NOT the -api host).',
    rolesRequired: [
      {
        name: 'Data Curator',
        scope: 'Root collection (Data Map metadata policy — NOT ARM RBAC)',
        reason: 'Read/write the Atlas catalog: entities, glossary, lineage, classifications.',
      },
      {
        name: 'Data Source Administrator',
        scope: 'Root collection (Data Map metadata policy — NOT ARM RBAC)',
        reason: 'Register data sources and trigger/inspect scans under /scan.',
      },
    ],
    followUp:
      'Operator action: (1) deploy platform/fiab/bicep/modules/admin-plane/catalog.bicep (a classic Data Map account), ' +
      '(2) set LOOM_PURVIEW_ACCOUNT in admin-plane/main.bicep apps[] env list to the account short name, ' +
      '(3) grant the Loom UAMI Data Map roles on the root collection via scripts/csa-loom/grant-purview-datamap-role.sh, ' +
      'then redeploy admin-plane. See docs/fiab/purview-setup.md for all three scenarios.',
  };
}

/** Honest-gate hint for new-unified-catalog-only concepts on a classic account. */
function unifiedCatalogGateHint(concept: string): PurviewNotConfiguredHint {
  return {
    missingEnvVar: 'LOOM_PURVIEW_ACCOUNT (unified-catalog account)',
    bicepModule: 'platform/fiab/bicep/modules/admin-plane/catalog.bicep',
    bicepStatus:
      `${concept} require a Purview account in the NEW unified-catalog experience ` +
      '(purview.microsoft.com). The account deployed for CSA Loom is a CLASSIC Data Map ' +
      'account (Microsoft.Purview/accounts via ARM), which does not expose the ' +
      '/datagovernance unified-catalog surface.',
    rolesRequired: [
      {
        name: 'Data Governance roles (unified catalog)',
        scope: 'Governance domain (granted in purview.microsoft.com — not ARM, not classic metadata policy)',
        reason: `Required to manage ${concept} in the unified-catalog data plane.`,
      },
    ],
    followUp:
      `${concept} are not available on a classic Data Map account. Use the Data Map ` +
      'catalog (search, Atlas entities, glossary, collections) and the Scan plane ' +
      '(data sources, scans, runs) on this surface instead. To enable the unified ' +
      'catalog, onboard a Purview account in the new experience and point ' +
      'LOOM_PURVIEW_ACCOUNT at it. See docs/fiab/purview-setup.md (scenario c).',
  };
}

function purviewAccount(): string {
  const raw = process.env.LOOM_PURVIEW_ACCOUNT;
  if (!raw) throw new PurviewNotConfiguredError(notConfiguredHint('LOOM_PURVIEW_ACCOUNT'));
  // Accept either a bare account name or a full URL (tolerate copy/paste of the
  // classic OR the -api host) and normalize down to the short account name.
  return raw
    .replace(/^https?:\/\//, '')
    .replace(/-api\.purview\.azure\.com.*$/, '')
    .replace(/\.purview\.azure\.com.*$/, '')
    .replace(/\/+$/, '');
}

/** Classic Data Map base host — `{account}.purview.azure.com` (NOT -api). */
function purviewBase(): string {
  return `https://${purviewAccount()}.purview.azure.com`;
}

/** True when LOOM_PURVIEW_ACCOUNT is set (does NOT prove reachability). */
export function isPurviewConfigured(): boolean {
  return !!process.env.LOOM_PURVIEW_ACCOUNT;
}

/** Resolved short account name, or null when the env var is unset. */
export function getPurviewAccountName(): string | null {
  return process.env.LOOM_PURVIEW_ACCOUNT ? purviewAccount() : null;
}

export interface PurviewProbeResult {
  configured: boolean;
  account: string | null;
  /** 'live' | 'not_configured' | 'role_missing' | 'upstream_error' */
  reason: 'live' | 'not_configured' | 'role_missing' | 'upstream_error';
  message?: string;
  hint?: PurviewNotConfiguredHint;
}

/**
 * Reachability probe against a CLASSIC Data Map endpoint that the account
 * actually exposes:
 *
 *   GET {base}/datamap/api/atlas/v2/types/typedefs/headers?api-version=2023-09-01
 *
 * Outcomes:
 *   - not_configured → LOOM_PURVIEW_ACCOUNT unset.
 *   - live           → HTTP 200 (host resolves, TLS ok, UAMI has a Data Map role).
 *   - role_missing   → HTTP 401/403 (host reachable, but the UAMI lacks a Data
 *                      Map role on the collection — grant Data Curator/Reader).
 *   - upstream_error → 5xx, OR a DNS/network failure (the account name does not
 *                      resolve as a classic Purview account in this cloud — set
 *                      LOOM_PURVIEW_ACCOUNT to a provisioned classic account).
 *
 * Grounded in: https://learn.microsoft.com/purview/data-gov-api-atlas-2-2
 *              https://learn.microsoft.com/rest/api/purview/datamapdataplane/type
 */
export async function probePurview(): Promise<PurviewProbeResult> {
  if (!process.env.LOOM_PURVIEW_ACCOUNT) {
    return {
      configured: false,
      account: null,
      reason: 'not_configured',
      hint: notConfiguredHint('LOOM_PURVIEW_ACCOUNT'),
    };
  }
  const account = purviewAccount();
  try {
    const token = await credential.getToken(PURVIEW_SCOPE);
    if (!token?.token) {
      return { configured: true, account, reason: 'upstream_error', message: 'Failed to acquire a Purview data-plane token.' };
    }
    const url = `${purviewBase()}/datamap/api/atlas/v2/types/typedefs/headers?api-version=${DATAMAP_API_VERSION}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token.token}` } });
    if (res.status === 200) {
      return { configured: true, account, reason: 'live' };
    }
    if (res.status === 401 || res.status === 403) {
      const hint = notConfiguredHint('LOOM_PURVIEW_ACCOUNT');
      hint.followUp =
        `The Data Map host resolved and answered ${res.status} — the Loom UAMI lacks a Data Map ` +
        'data-plane role on this account. Grant Data Curator (read/write) or Data Reader ' +
        '(read-only) on the root collection via scripts/csa-loom/grant-purview-datamap-role.sh, ' +
        'then retry.';
      return { configured: true, account, reason: 'role_missing', message: `Purview answered ${res.status} (UAMI lacks a Data Map role).`, hint };
    }
    return { configured: true, account, reason: 'upstream_error', message: `Purview answered ${res.status}.` };
  } catch (e: any) {
    // fetch throws on DNS / connection failures.
    const msg = e?.message || String(e);
    const networkish = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|getaddrinfo|fetch failed|network|certificate/i.test(msg);
    if (networkish) {
      const hint = notConfiguredHint('LOOM_PURVIEW_ACCOUNT');
      hint.followUp =
        `The account name "${account}" did not resolve as a classic Purview Data Map host ` +
        `(${account}.purview.azure.com): ${msg}. Set LOOM_PURVIEW_ACCOUNT to a provisioned ` +
        'classic Purview account (Microsoft.Purview/accounts) in this cloud, then restart the Console. ' +
        'See docs/fiab/purview-setup.md.';
      return { configured: true, account, reason: 'not_configured', message: msg, hint };
    }
    return { configured: true, account, reason: 'upstream_error', message: msg };
  }
}

// ============================================================
// Low-level fetch
// ============================================================

/**
 * Issues a Data Map / scan / account-dp request. `apiVersion` is required per
 * call because the three planes use different versions:
 *   - Atlas + Discovery → 2023-09-01
 *   - Scan              → 2022-07-01-preview
 *   - Account (collections) → 2019-11-01-preview
 */
async function purviewFetch(
  path: string,
  init: RequestInit & { query?: Record<string, string>; apiVersion?: string } = {},
): Promise<Response> {
  const token = await credential.getToken(PURVIEW_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire Purview data-plane token');
  const apiVersion = init.apiVersion || DATAMAP_API_VERSION;
  const sep = path.includes('?') ? '&' : '?';
  const query = init.query
    ? '&' + new URLSearchParams(init.query).toString()
    : '';
  const url = `${purviewBase()}${path}${sep}api-version=${apiVersion}${query}`;
  const { query: _q, apiVersion: _v, ...rest } = init;
  return fetch(url, {
    ...rest,
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
      (parsed as any)?.errorMessage ||
      (parsed as any)?.message ||
      (typeof parsed === 'string' ? parsed : `Purview ${res.status}`);
    throw new PurviewError(res.status, parsed, msg);
  }
  return (parsed as T) ?? ({} as T);
}

// ============================================================
// Shared types
// ============================================================

export interface PurviewDataSource {
  id: string;
  name: string;
  kind?: string;          // AzureSqlDatabase, AzureDataLakeStorageGen2, etc.
  endpoint?: string;
  collectionId?: string;
  raw?: unknown;
}

export interface PurviewScan {
  id: string;
  name: string;
  kind?: string;
  schedule?: unknown;
  raw?: unknown;
}

export interface PurviewScanRun {
  runId: string;
  status?: string;
  startTime?: string;
  endTime?: string;
  errorMessage?: string;
  raw?: unknown;
}

export interface PurviewGlossaryTerm {
  guid: string;
  name?: string;
  qualifiedName?: string;
  longDescription?: string;
  status?: string;
  glossaryGuid?: string;
  raw?: unknown;
}

export interface PurviewBusinessDomain {
  id: string;
  name: string;
  description?: string;
  type?: string;
  parentId?: string;
  createdAt?: string;
  updatedAt?: string;
  raw?: unknown;
}

export interface PurviewCollection {
  name: string;
  friendlyName?: string;
  description?: string;
  parentCollection?: string;
  raw?: unknown;
}

export interface PurviewAssetHit {
  source: 'purview';
  id: string;
  name: string;
  qualifiedName?: string;
  entityType?: string;
  classification?: string[];
  description?: string;
  owner?: string;
  domain?: string;
  updatedAt?: string;
}

export interface PurviewLineageNode {
  guid: string;
  displayText?: string;
  typeName?: string;
}

export interface PurviewLineageEdge {
  fromEntityId: string;
  toEntityId: string;
  relationshipType?: string;
}

export interface PurviewLineageGraph {
  baseEntityGuid: string;
  guidEntityMap: Record<string, PurviewLineageNode>;
  relations: PurviewLineageEdge[];
}

export interface PurviewDataQualityRule {
  id: string;
  name?: string;
  description?: string;
  expression?: string;
  scope?: string;
  enabled?: boolean;
  raw?: unknown;
}

// ============================================================
// Discovery (search) — Data Map data plane
//   POST {base}/datamap/api/search/query?api-version=2023-09-01
//   body: { keywords, limit, offset? }
//   https://learn.microsoft.com/rest/api/purview/datamapdataplane/discovery/query
// ============================================================

export async function searchPurview(q: string, limit = 50): Promise<PurviewAssetHit[]> {
  purviewAccount();
  const res = await purviewFetch('/datamap/api/search/query', {
    method: 'POST',
    body: JSON.stringify({ keywords: q || '*', limit, offset: 0 }),
  });
  const j = await readJson<{ value?: any[] }>(res);
  return (j?.value || []).map((v: any) => ({
    source: 'purview' as const,
    id: v.id || v.guid,
    name: v.name || v.qualifiedName || v.id,
    qualifiedName: v.qualifiedName,
    entityType: v.entityType || v.typeName,
    classification: v.classification || v.classifications,
    description: v.description,
    owner: v.owner || (Array.isArray(v.contact) ? v.contact[0]?.id : undefined),
    domain: v.domain,
    updatedAt: v.updateTime || v.modifiedTime,
  }));
}

// ============================================================
// Collections — Account data plane
//   GET {base}/collections?api-version=2019-11-01-preview
//   https://learn.microsoft.com/rest/api/purview/accountdataplane/collections/list-collections
// ============================================================

export async function listCollections(): Promise<PurviewCollection[]> {
  purviewAccount();
  const res = await purviewFetch('/collections', { apiVersion: ACCOUNT_API_VERSION });
  const j = await readJson<{ value?: any[] }>(res);
  return (j?.value || []).map((raw: any): PurviewCollection => ({
    name: raw?.name,
    friendlyName: raw?.friendlyName,
    description: raw?.description,
    parentCollection: raw?.parentCollection?.referenceName,
    raw,
  }));
}

// ============================================================
// Atlas v2 — entities, lineage, glossary, classifications.
//   {base}/datamap/api/atlas/v2/...?api-version=2023-09-01
//   https://learn.microsoft.com/purview/data-gov-api-atlas-2-2
//   https://learn.microsoft.com/purview/data-gov-api-create-lineage-relationships
// ============================================================

/**
 * Lineage subgraph — GET /datamap/api/atlas/v2/lineage/{guid}?direction=BOTH&depth=3
 */
export async function getLineageSubgraph(guid: string, depth = 3): Promise<PurviewLineageGraph> {
  purviewAccount();
  if (!guid) throw new PurviewError(400, null, 'guid is required');
  const res = await purviewFetch(`/datamap/api/atlas/v2/lineage/${encodeURIComponent(guid)}`, {
    query: { direction: 'BOTH', depth: String(depth) },
  });
  const j = await readJson<any>(res);
  if (!j) return { baseEntityGuid: guid, guidEntityMap: {}, relations: [] };
  const guidEntityMap: Record<string, PurviewLineageNode> = {};
  for (const [k, v] of Object.entries(j.guidEntityMap || {})) {
    const e: any = v;
    guidEntityMap[k] = {
      guid: k,
      displayText: e.displayText || e.attributes?.qualifiedName || e.attributes?.name,
      typeName: e.typeName,
    };
  }
  const relations: PurviewLineageEdge[] = (j.relations || []).map((r: any) => ({
    fromEntityId: r.fromEntityId,
    toEntityId: r.toEntityId,
    relationshipType: r.relationshipId,
  }));
  return { baseEntityGuid: j.baseEntityGuid || guid, guidEntityMap, relations };
}

/** Asset detail — GET /datamap/api/atlas/v2/entity/guid/{guid} */
export async function getAssetDetail(guid: string): Promise<any | null> {
  purviewAccount();
  const res = await purviewFetch(`/datamap/api/atlas/v2/entity/guid/${encodeURIComponent(guid)}`);
  return readJson<any>(res);
}

/**
 * Look up an Atlas entity by its (typeName, qualifiedName) unique attribute.
 *   GET /datamap/api/atlas/v2/entity/uniqueAttribute/type/{typeName}
 *       ?attr:qualifiedName=<qualifiedName>
 *
 * Used by purview-mip-client to find the sensitivity label scanned onto a
 * concrete ADLS Gen2 path. Returns the AtlasEntityWithExtInfo (with `.entity`)
 * or null when the asset isn't in the catalog (404 — e.g. not scanned yet).
 *
 * https://learn.microsoft.com/rest/api/purview/datamapdataplane/entity/get-by-unique-attributes
 */
export async function getEntityByQualifiedName(
  typeName: string,
  qualifiedName: string,
): Promise<any | null> {
  purviewAccount();
  if (!typeName) throw new PurviewError(400, null, 'typeName is required');
  if (!qualifiedName) throw new PurviewError(400, null, 'qualifiedName is required');
  const res = await purviewFetch(
    `/datamap/api/atlas/v2/entity/uniqueAttribute/type/${encodeURIComponent(typeName)}`,
    { query: { 'attr:qualifiedName': qualifiedName } },
  );
  return readJson<any>(res);
}

// ------------------------------------------------------------
// Cross-source registration — Atlas entity upsert
// ------------------------------------------------------------

/**
 * Payload to register a Unity Catalog table (or OneLake item / Azure DB) as a
 * Purview Atlas entity.
 *   UC table   →  typeName = "databricks_table"
 *   OneLake LH →  typeName = "fabric_lakehouse"
 *
 * Atlas dedupes on qualifiedName (subsequent upserts merge).
 */
export interface RegisterAtlasEntityPayload {
  typeName: string;
  qualifiedName: string;
  displayName: string;
  comment?: string;
  owner?: string;
  classifications?: string[];
  /** Optional Atlas attributes. */
  attributes?: Record<string, unknown>;
  /**
   * @deprecated `businessDomainId` is a unified-catalog concept and is ignored
   * on a classic Data Map account. Kept for caller compatibility.
   */
  domain?: string;
}

export interface AtlasUpsertResponse {
  guidAssignments?: Record<string, string>;
  mutatedEntities?: unknown;
  partialUpdatedEntities?: unknown;
  /** First created/updated entity guid for convenient round-trip. */
  primaryGuid?: string;
}

/**
 * POST /datamap/api/atlas/v2/entity — upserts a single entity. Returns the
 * GUID Atlas assigned (or matched against an existing qualifiedName).
 */
export async function registerAtlasEntity(p: RegisterAtlasEntityPayload): Promise<AtlasUpsertResponse> {
  purviewAccount();
  if (!p?.typeName) throw new PurviewError(400, null, 'typeName is required');
  if (!p?.qualifiedName) throw new PurviewError(400, null, 'qualifiedName is required');
  if (!p?.displayName) throw new PurviewError(400, null, 'displayName is required');

  const attributes: Record<string, unknown> = {
    qualifiedName: p.qualifiedName,
    name: p.displayName,
    ...(p.comment ? { comment: p.comment, description: p.comment } : {}),
    ...(p.attributes || {}),
  };
  const body: Record<string, unknown> = {
    entity: {
      typeName: p.typeName,
      attributes,
      ...(p.classifications && p.classifications.length
        ? { classifications: p.classifications.map((c) => ({ typeName: c })) }
        : {}),
      ...(p.owner ? { contacts: { Expert: [{ id: p.owner, info: 'Owner' }] } } : {}),
    },
  };
  const res = await purviewFetch('/datamap/api/atlas/v2/entity', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const j = await readJson<any>(res);
  const guidAssignments = j?.guidAssignments || {};
  const primaryGuid = Object.values(guidAssignments)[0] as string | undefined;
  return { ...j, primaryGuid };
}

/**
 * Ensure the given classification names exist as Atlas classification typedefs
 * so they can be attached to entities. Idempotent: lists existing type headers
 * and only POSTs the missing ones (POST /datamap/api/atlas/v2/types/typedefs
 * with classificationDefs). Lets Loom's classification taxonomy flow into
 * Purview without a manual type-creation step. Swallows 409 (already exists).
 *
 * Docs: https://learn.microsoft.com/purview/data-gov-api-atlas-2-2
 */
export async function ensureClassificationDefs(names: string[]): Promise<void> {
  const want = [...new Set((names || []).map((n) => (n || '').trim()).filter(Boolean))];
  if (!want.length) return;
  let existing = new Set<string>();
  try {
    const res = await purviewFetch('/datamap/api/atlas/v2/types/typedefs/headers');
    const headers = (await readJson<Array<{ name: string }>>(res)) || [];
    existing = new Set(headers.map((h) => h.name));
  } catch { /* if listing fails, attempt create + swallow conflicts below */ }
  const missing = want.filter((n) => !existing.has(n));
  if (!missing.length) return;
  const body = {
    classificationDefs: missing.map((n) => ({ category: 'CLASSIFICATION', name: n, typeVersion: '1.0', superTypes: [] as string[] })),
  };
  try {
    const res = await purviewFetch('/datamap/api/atlas/v2/types/typedefs', { method: 'POST', body: JSON.stringify(body) });
    await readJson(res);
  } catch (e: any) {
    if (e instanceof PurviewError && e.status === 409) return; // already exist
    throw e;
  }
}

// ------------------------------------------------------------
// Atlas glossary surface (low-level — /datamap/api/atlas/v2/glossary)
// ------------------------------------------------------------

export interface AtlasGlossaryTermPayload {
  name: string;
  longDescription?: string;
  glossaryGuid?: string;
}

/**
 * POST /datamap/api/atlas/v2/glossary/term — create a glossary term.
 * The term name must be unique in the glossary.
 */
export async function createAtlasGlossaryTerm(term: AtlasGlossaryTermPayload): Promise<{ guid: string; name: string }> {
  purviewAccount();
  if (!term?.name) throw new PurviewError(400, null, 'term name is required');
  const res = await purviewFetch('/datamap/api/atlas/v2/glossary/term', {
    method: 'POST',
    body: JSON.stringify({
      name: term.name,
      longDescription: term.longDescription || '',
      ...(term.glossaryGuid ? { anchor: { glossaryGuid: term.glossaryGuid } } : {}),
    }),
  });
  const j = await readJson<any>(res);
  return { guid: j?.guid || j?.id, name: j?.name || term.name };
}

/**
 * Assign a glossary term to an entity.
 * POST /datamap/api/atlas/v2/glossary/terms/{termGuid}/assignedEntities
 */
export async function applyGlossaryTerm(termGuid: string, entityGuid: string): Promise<void> {
  purviewAccount();
  if (!termGuid) throw new PurviewError(400, null, 'termGuid is required');
  if (!entityGuid) throw new PurviewError(400, null, 'entityGuid is required');
  const res = await purviewFetch(`/datamap/api/atlas/v2/glossary/terms/${encodeURIComponent(termGuid)}/assignedEntities`, {
    method: 'POST',
    body: JSON.stringify([{ guid: entityGuid }]),
  });
  // Atlas returns 204 No Content on success.
  if (!res.ok && res.status !== 204) {
    const t = await res.text();
    throw new PurviewError(res.status, t, `applyGlossaryTerm failed: ${t || res.statusText}`);
  }
}

/**
 * List glossary terms via Atlas v2.
 *   GET /datamap/api/atlas/v2/glossary        → list glossaries (pick the first)
 *   GET /datamap/api/atlas/v2/glossary/{guid}/terms?limit=200
 *
 * Live-verified on purview-csa-loom-eastus2: the glossaries-list endpoint is
 * the SINGULAR `/glossary` (200); the plural `/glossaries` 404s.
 * https://learn.microsoft.com/rest/api/purview/datamapdataplane/glossary
 */
export async function listGlossaryTerms(glossaryGuid?: string): Promise<PurviewGlossaryTerm[]> {
  purviewAccount();

  let targetGuid = glossaryGuid;
  if (!targetGuid) {
    const gRes = await purviewFetch('/datamap/api/atlas/v2/glossary');
    const gj = await readJson<any[]>(gRes);
    if (!Array.isArray(gj) || gj.length === 0) return [];
    targetGuid = gj[0]?.guid;
  }
  if (!targetGuid) return [];

  const tRes = await purviewFetch(
    `/datamap/api/atlas/v2/glossary/${encodeURIComponent(targetGuid)}/terms`,
    { query: { limit: '200' } },
  );
  if (tRes.status === 404) return [];
  const tj = await readJson<any[]>(tRes);
  if (!Array.isArray(tj)) return [];
  return tj.map((raw): PurviewGlossaryTerm => ({
    guid: raw?.guid,
    name: raw?.name,
    qualifiedName: raw?.qualifiedName,
    longDescription: raw?.longDescription,
    status: raw?.status,
    glossaryGuid: targetGuid,
    raw,
  }));
}

/** POST /datamap/api/atlas/v2/glossary/term — create an Atlas glossary term. */
export async function createGlossaryTerm(payload: {
  name: string;
  glossaryGuid: string;
  shortDescription?: string;
  longDescription?: string;
}): Promise<PurviewGlossaryTerm> {
  purviewAccount();
  if (!payload?.name || !payload?.glossaryGuid) {
    throw new PurviewError(400, null, 'name + glossaryGuid are required');
  }
  const body = {
    name: payload.name,
    anchor: { glossaryGuid: payload.glossaryGuid },
    shortDescription: payload.shortDescription || '',
    longDescription: payload.longDescription || '',
    status: 'Draft',
  };
  const res = await purviewFetch('/datamap/api/atlas/v2/glossary/term', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const raw = await readJson<any>(res);
  if (!raw) throw new PurviewError(500, null, 'Purview returned empty body on createGlossaryTerm');
  return {
    guid: raw?.guid,
    name: raw?.name,
    qualifiedName: raw?.qualifiedName,
    longDescription: raw?.longDescription,
    status: raw?.status,
    glossaryGuid: payload.glossaryGuid,
    raw,
  };
}

// ============================================================
// Scan plane — data sources, scans, runs.
//   {base}/scan/datasources/...?api-version=2022-07-01-preview
//   https://learn.microsoft.com/rest/api/purview/scanningdataplane/data-sources
//   https://learn.microsoft.com/purview/register-scan-synapse-workspace#scan
// ============================================================

/** GET /scan/datasources — registered data sources. */
export async function listDataSources(): Promise<PurviewDataSource[]> {
  purviewAccount();
  const res = await purviewFetch('/scan/datasources', { apiVersion: SCAN_API_VERSION });
  const j = await readJson<{ value?: any[] }>(res);
  return (j?.value || []).map((raw): PurviewDataSource => ({
    id: raw?.id || raw?.name,
    name: raw?.name,
    kind: raw?.kind || raw?.properties?.kind,
    endpoint: raw?.properties?.endpoint || raw?.properties?.serverEndpoint,
    collectionId: raw?.properties?.collection?.referenceName,
    raw,
  }));
}

/** PUT /scan/datasources/{name} — register/update a data source. */
export async function registerDataSource(payload: {
  name: string;
  kind: string;
  properties: Record<string, unknown>;
}): Promise<PurviewDataSource> {
  purviewAccount();
  if (!payload?.name) throw new PurviewError(400, null, 'name is required');
  if (!payload?.kind) throw new PurviewError(400, null, 'kind is required');
  const res = await purviewFetch(`/scan/datasources/${encodeURIComponent(payload.name)}`, {
    method: 'PUT',
    apiVersion: SCAN_API_VERSION,
    body: JSON.stringify({ kind: payload.kind, properties: payload.properties }),
  });
  const raw = await readJson<any>(res);
  if (!raw) throw new PurviewError(500, null, 'Purview returned empty body on registerDataSource');
  return {
    id: raw?.id || raw?.name,
    name: raw?.name,
    kind: raw?.kind,
    endpoint: raw?.properties?.endpoint,
    collectionId: raw?.properties?.collection?.referenceName,
    raw,
  };
}

/** DELETE /scan/datasources/{name} */
export async function deleteDataSource(name: string): Promise<boolean> {
  purviewAccount();
  if (!name) throw new PurviewError(400, null, 'name is required');
  const res = await purviewFetch(`/scan/datasources/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    apiVersion: SCAN_API_VERSION,
  });
  if (res.status === 404) return false;
  await readJson<unknown>(res);
  return true;
}

/** GET /scan/datasources/{name}/scans — scans defined on a source. */
export async function listScansForSource(sourceName: string): Promise<PurviewScan[]> {
  purviewAccount();
  if (!sourceName) throw new PurviewError(400, null, 'sourceName is required');
  const res = await purviewFetch(`/scan/datasources/${encodeURIComponent(sourceName)}/scans`, { apiVersion: SCAN_API_VERSION });
  if (res.status === 404) return [];
  const j = await readJson<{ value?: any[] }>(res);
  return (j?.value || []).map((raw): PurviewScan => ({
    id: raw?.id || raw?.name,
    name: raw?.name,
    kind: raw?.kind,
    schedule: raw?.properties?.schedule,
    raw,
  }));
}

/** PUT /scan/datasources/{name}/scans/{scan}/runs/{runId} — trigger a scan run. */
export async function triggerScanRun(sourceName: string, scanName: string): Promise<{ runId?: string; raw: unknown }> {
  purviewAccount();
  if (!sourceName || !scanName) throw new PurviewError(400, null, 'sourceName + scanName required');
  const runId = `loom-${Date.now()}`;
  const res = await purviewFetch(
    `/scan/datasources/${encodeURIComponent(sourceName)}/scans/${encodeURIComponent(scanName)}/runs/${runId}`,
    { method: 'PUT', apiVersion: SCAN_API_VERSION },
  );
  const raw = await readJson<any>(res);
  return { runId: raw?.runId || runId, raw };
}

/** GET /scan/datasources/{name}/scans/{scan}/runs — last N scan runs. */
export async function listScanRuns(sourceName: string, scanName: string): Promise<PurviewScanRun[]> {
  purviewAccount();
  const res = await purviewFetch(
    `/scan/datasources/${encodeURIComponent(sourceName)}/scans/${encodeURIComponent(scanName)}/runs`,
    { apiVersion: SCAN_API_VERSION },
  );
  if (res.status === 404) return [];
  const j = await readJson<{ value?: any[] }>(res);
  return (j?.value || []).slice(0, 10).map((raw): PurviewScanRun => ({
    runId: raw?.id || raw?.runId,
    status: raw?.status,
    startTime: raw?.startTime,
    endTime: raw?.endTime,
    errorMessage: raw?.errorMessage,
    raw,
  }));
}

// ============================================================
// NEW unified-catalog-only concepts — HONEST GATE.
//
// Business domains, data products, and unified-catalog data-quality rules live
// behind the `/datagovernance` surface on a NEW unified-catalog account, which
// the deployed CLASSIC Data Map account does not expose. Per no-vaporware.md we
// keep the signatures and surface a typed honest-gate (NOT fabricated data,
// NOT a generic 500). PurviewUnifiedCatalogGateError is a subclass of
// PurviewNotConfiguredError so every existing BFF catch renders a 501/503 +
// hint MessageBar while the full UI surface still renders.
// ============================================================

export interface PurviewDataProductPayload {
  id?: string;
  displayName?: string;
  /** Compatibility: workspace-bindings passes `name`. */
  name?: string;
  description?: string;
  domain?: string;
  owner?: string;
  sla?: string;
  bundle?: string[];
  type?: string;
  endorsed?: boolean;
  [k: string]: unknown;
}

export interface PurviewDataProduct {
  id: string;
  name: string;
  description?: string;
  domain?: string;
  status?: string;
  type?: string;
  endorsed?: boolean;
  contacts?: unknown;
  documentation?: unknown;
  updatedAt?: string;
  raw?: unknown;
}

/**
 * Honest gate: data products are a unified-catalog concept. On the classic Data
 * Map account this throws PurviewUnifiedCatalogGateError so callers render the
 * MessageBar. Use `registerAtlasEntity` to catalog physical assets instead.
 */
export async function registerDataProduct(_payload: PurviewDataProductPayload): Promise<PurviewDataProduct> {
  // Touch the env var so an unset account still yields the precise "not
  // configured" gate before the unified-catalog gate.
  purviewAccount();
  throw new PurviewUnifiedCatalogGateError('Data products');
}

export async function getDataProduct(_id: string): Promise<PurviewDataProduct | null> {
  purviewAccount();
  throw new PurviewUnifiedCatalogGateError('Data products');
}

export async function listDataProducts(_domain?: string): Promise<PurviewDataProduct[]> {
  purviewAccount();
  throw new PurviewUnifiedCatalogGateError('Data products');
}

/**
 * Business-domain mirror on CLASSIC Data Map.
 *
 * The unified-catalog `/datagovernance` business-domains surface does NOT exist
 * on the deployed classic Purview Data Map account. Rather than honest-gate the
 * whole feature, Loom mirrors each domain to the closest 1:1 governance grouping
 * the classic account DOES expose: a Purview **collection** (Account data-plane,
 * api-version 2019-11-01-preview). A Loom domain ⇄ a Purview collection under the
 * root collection. This keeps the mirror REAL (no-vaporware) without requiring a
 * new-experience unified-catalog account or any Microsoft Fabric.
 *
 * Reads need the Loom UAMI a Data Map "Data Reader" role on the root collection;
 * writes need "Collection Admin" — both are classic Data Map metadata-policy
 * roles (NOT ARM RBAC), granted via scripts/csa-loom/grant-purview-datamap-role.sh.
 * A 401/403 surfaces as the honest infra-gate, not a Fabric dependency.
 */
async function rootCollectionName(): Promise<string | undefined> {
  const cols = await listCollections();
  // The root collection is the one with no parent (its name === the account's
  // root collection referenceName, usually the account name).
  return cols.find((c) => !c.parentCollection)?.name;
}

/** Stable Purview collection referenceName for a Loom domain (≤ 36 chars). */
function domainCollectionName(idOrName: string): string {
  return (idOrName || 'domain')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'domain';
}

export async function listBusinessDomains(): Promise<PurviewBusinessDomain[]> {
  purviewAccount();
  const cols = await listCollections();
  const root = cols.find((c) => !c.parentCollection);
  // Surface every non-root collection as a mirrored business domain.
  return cols
    .filter((c) => c.name !== root?.name)
    .map((c): PurviewBusinessDomain => ({
      id: c.name,
      name: c.friendlyName || c.name,
      description: c.description,
      parentId: c.parentCollection,
      raw: c.raw,
    }));
}

export async function createBusinessDomain(body: { name: string; description?: string; type?: string; parentId?: string; id?: string }): Promise<PurviewBusinessDomain> {
  purviewAccount();
  const colName = domainCollectionName(body.id || body.name);
  const root = body.parentId || (await rootCollectionName());
  const res = await purviewFetch(`/collections/${encodeURIComponent(colName)}`, {
    method: 'PUT',
    apiVersion: ACCOUNT_API_VERSION,
    body: JSON.stringify({
      friendlyName: body.name,
      description: body.description || undefined,
      ...(root ? { parentCollection: { referenceName: root } } : {}),
    }),
  });
  const j = await readJson<any>(res);
  if (!res.ok) throw new PurviewError(res.status, j, `Create Purview collection (domain mirror) failed: ${res.status}`);
  return {
    id: j?.name || colName,
    name: j?.friendlyName || body.name,
    description: j?.description,
    parentId: j?.parentCollection?.referenceName,
    raw: j,
  };
}

export async function deleteBusinessDomain(id: string): Promise<void> {
  purviewAccount();
  const res = await purviewFetch(`/collections/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    apiVersion: ACCOUNT_API_VERSION,
  });
  if (!res.ok && res.status !== 404) {
    const j = await readJson<any>(res);
    throw new PurviewError(res.status, j, `Delete Purview collection (domain mirror) failed: ${res.status}`);
  }
}

/**
 * Update the Purview classic collection that mirrors a Loom domain.
 *
 * Classic Data Map `PUT /collections/{referenceName}` (api-version
 * 2019-11-01-preview) is an idempotent create-or-update — there is no PATCH
 * for collections — so this mirrors `createBusinessDomain` and re-uses the
 * same ≤36-char `domainCollectionName(id)` slug as the referenceName.
 *
 * Requires the UAMI to hold "Collection Admin" on the root collection (classic
 * Data Map metadata-policy role, NOT ARM RBAC; granted via
 * scripts/csa-loom/grant-purview-datamap-role.sh). A 401/403 surfaces as the
 * honest infra-gate, not a Fabric dependency.
 */
export async function updateBusinessDomain(
  id: string,
  body: { name?: string; description?: string },
): Promise<PurviewBusinessDomain> {
  purviewAccount();
  const colName = domainCollectionName(id);
  const root = await rootCollectionName();
  const res = await purviewFetch(`/collections/${encodeURIComponent(colName)}`, {
    method: 'PUT',
    apiVersion: ACCOUNT_API_VERSION,
    body: JSON.stringify({
      ...(body.name ? { friendlyName: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(root ? { parentCollection: { referenceName: root } } : {}),
    }),
  });
  const j = await readJson<any>(res);
  if (!res.ok)
    throw new PurviewError(res.status, j, `Update Purview collection (domain mirror) failed: ${res.status}`);
  return {
    id: j?.name || colName,
    name: j?.friendlyName || body.name || colName,
    description: j?.description,
    parentId: j?.parentCollection?.referenceName,
    raw: j,
  };
}

export interface DomainAuditEvent {
  id?: string;
  timestamp?: string;
  operation?: string;
  userId?: string;
  resourceId?: string;
  category?: string;
  raw?: unknown;
}

/**
 * Query Purview Audit for Asset-level governance events associated with a
 * domain.
 *
 * Real endpoint: POST {base}/datamap/api/audit/query?api-version=2023-10-01-preview
 * Ref: https://learn.microsoft.com/rest/api/purview/datamapdataplane/audit/query
 *
 * NOTE: Purview Audit categories (Asset / GlossaryTerm / ClassificationDef) do
 * NOT include Purview collection CRUD. Domain CRUD audit is therefore written
 * by the BFF routes to the Cosmos audit-log container. This function surfaces
 * Asset-level governance events (e.g. label change, scan result) scoped to a
 * domain when the account exposes the Audit data plane.
 */
export async function queryDomainAuditLog(opts: {
  domainId?: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
}): Promise<DomainAuditEvent[]> {
  purviewAccount();
  const token = await credential.getToken(PURVIEW_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire Purview data-plane token');
  const payload: Record<string, unknown> = {
    category: 'Asset',
    ...(opts.startTime ? { startTime: opts.startTime } : {}),
    ...(opts.endTime ? { endTime: opts.endTime } : {}),
    ...(opts.limit ? { limit: opts.limit } : {}),
    ...(opts.domainId
      ? { filters: [{ attributeName: 'domainId', attributeValue: opts.domainId }] }
      : {}),
  };
  const res = await fetch(
    `${purviewBase()}/datamap/api/audit/query?api-version=2023-10-01-preview`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    const j = await readJson<any>(res);
    throw new PurviewError(res.status, j, `Domain audit query failed: ${res.status}`);
  }
  const j = await readJson<{ value?: DomainAuditEvent[] }>(res);
  return j?.value || [];
}

/**
 * `/datagovernance/dataquality` on a new-experience account. Returns the gate
 * via throw so the panel renders the MessageBar (classic Data Map has no
 * equivalent rules surface).
 */
export async function listDataQualityRules(): Promise<PurviewDataQualityRule[]> {
  purviewAccount();
  throw new PurviewUnifiedCatalogGateError('Unified-catalog data-quality rules');
}
