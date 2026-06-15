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
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { randomUUID } from 'node:crypto';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { isGovCloud } from './cloud-endpoints';

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

export function notConfiguredHint(missing: string): PurviewNotConfiguredHint {
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
  // Handles both the Commercial (.purview.azure.com) and US Gov (.purview.azure.us)
  // hosts so a Gov account name copy/pasted as a URL still resolves cleanly.
  return raw
    .replace(/^https?:\/\//, '')
    .replace(/-api\.purview\.azure\.(com|us).*$/, '')
    .replace(/\.purview\.azure\.(com|us).*$/, '')
    .replace(/\/+$/, '');
}

/**
 * Classic Data Map base host — `{account}.purview.azure.{com|us}` (NOT -api).
 * The TLD follows the cloud: `.us` in the US Government clouds (where the
 * Purview data plane is `*.purview.azure.us`), `.com` everywhere else.
 */
function purviewBase(): string {
  return `https://${purviewAccount()}.purview.azure.${isGovCloud() ? 'us' : 'com'}`;
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
    const res = await fetchWithTimeout(url, { headers: { authorization: `Bearer ${token.token}` } });
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
  return fetchWithTimeout(url, {
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

export interface DataMapSearchOpts {
  q: string;
  /** Purview collection referenceName (the classic mirror of a domain). Unset = all collections. */
  collectionName?: string;
  /** Atlas typeName list for type-chip filtering. Empty/unset = all types. */
  entityTypes?: string[];
  limit?: number;
  offset?: number;
}

/**
 * Domain-scoped + type-filtered asset search for the F9 "Add data assets"
 * panel. Same Discovery endpoint as searchPurview, but builds the structured
 * `filter` the Data Map search supports so results can be constrained to a
 * single collection (the classic equivalent of a governance domain) and to a
 * set of Atlas entity types (the Table/View/File chips).
 *
 *   POST {base}/datamap/api/search/query?api-version=2023-09-01
 *   body: {
 *     keywords, limit, offset,
 *     filter: { and: [ { collectionId: "<ref>" }, { or: [ { entityType: "azure_sql_table" }, ... ] } ] }
 *   }
 *
 * The `filter` grammar is the recursive Data Map search filter: leaf terms
 * `{ collectionId }` / `{ entityType }` combined with `and` / `or` / `not`.
 *   https://learn.microsoft.com/rest/api/purview/datamapdataplane/discovery/query
 *
 * The Loom UAMI needs at minimum a Data Map READ role (Data Reader or Data
 * Curator) on the target collection — see consolePurviewRoleGrant in
 * platform/fiab/bicep/modules/admin-plane/catalog.bicep, applied by
 * scripts/csa-loom/grant-purview-datamap-role.sh.
 */
export async function searchDataMapAssets(opts: DataMapSearchOpts): Promise<PurviewAssetHit[]> {
  purviewAccount();
  const { q, collectionName, entityTypes, limit = 20, offset = 0 } = opts;
  const andClauses: Record<string, unknown>[] = [];
  if (collectionName) andClauses.push({ collectionId: collectionName });
  if (entityTypes && entityTypes.length > 0) {
    andClauses.push(
      entityTypes.length === 1
        ? { entityType: entityTypes[0] }
        : { or: entityTypes.map((t) => ({ entityType: t })) },
    );
  }
  const body: Record<string, unknown> = {
    keywords: q && q.trim() ? q.trim() : '*',
    limit,
    offset,
  };
  if (andClauses.length === 1) body.filter = andClauses[0];
  else if (andClauses.length > 1) body.filter = { and: andClauses };

  const res = await purviewFetch('/datamap/api/search/query', {
    method: 'POST',
    body: JSON.stringify(body),
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
 * Extract Critical-Data-Element (CDE) classifications from a Purview Atlas
 * entity. The classic Data Map has no first-class "CDE" object (that lives in
 * the unified-catalog `/datagovernance` plane), so on the Azure-native default
 * path CDEs are modeled as Atlas classifications whose typeName starts with
 * `CDE.` — the convention used when assets are registered/scanned with their
 * critical-data labels. Returns [] when the entity carries no CDE
 * classification. Throws PurviewNotConfiguredError (via purviewAccount) when
 * LOOM_PURVIEW_ACCOUNT is unset — callers translate that into an honest gate.
 *
 * https://learn.microsoft.com/rest/api/purview/datamapdataplane/entity/get
 */
export async function getAssetCdeClassifications(
  guid: string,
): Promise<{ typeName: string; displayName: string; entityGuid: string }[]> {
  if (!guid) return [];
  const detail = await getAssetDetail(guid);
  const classifications = detail?.entity?.classifications;
  if (!Array.isArray(classifications)) return [];
  return classifications
    .filter((c: any) => typeof c?.typeName === 'string' && c.typeName.startsWith('CDE.'))
    .map((c: any) => ({
      typeName: c.typeName as string,
      // Human-friendly name = the portion after the `CDE.` prefix.
      displayName: (c.typeName as string).slice('CDE.'.length) || c.typeName,
      entityGuid: guid,
    }));
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

/**
 * Add one or more classifications to a catalog asset (Atlas entity) by GUID.
 *   POST /datamap/api/atlas/v2/entity/guid/{guid}/classifications
 *   body: [{ typeName }]
 *
 * Used by batch labeling to stamp a sensitivity-label name onto the matching
 * Purview asset. The classification typedefs must already exist (call
 * ensureClassificationDefs first). Atlas returns 204 on success and 409 when
 * the classification is already assigned — both are treated as success
 * (idempotent). Any other non-2xx surfaces verbatim as a PurviewError.
 *
 * Docs: https://learn.microsoft.com/purview/data-gov-api-atlas-2-2
 */
export async function addAssetClassification(guid: string, classificationNames: string[]): Promise<void> {
  purviewAccount();
  if (!guid) throw new PurviewError(400, null, 'guid is required');
  const names = [...new Set((classificationNames || []).map((n) => (n || '').trim()).filter(Boolean))];
  if (!names.length) return;
  const res = await purviewFetch(`/datamap/api/atlas/v2/entity/guid/${encodeURIComponent(guid)}/classifications`, {
    method: 'POST',
    body: JSON.stringify(names.map((n) => ({ typeName: n }))),
  });
  // Atlas returns 204 No Content on success; 409 means already assigned.
  if (res.ok || res.status === 204 || res.status === 409) return;
  const t = await res.text();
  throw new PurviewError(res.status, t, `addAssetClassification failed: ${t || res.statusText}`);
}

// ------------------------------------------------------------
// MIP sensitivity labels — Data Map (Atlas) classification typedefs
// ------------------------------------------------------------

export interface DataMapSensitivityLabel {
  /** Full Atlas classification typedef name, e.g. 'MICROSOFT.GOVERNANCE.LABELS.<labelGuid>'. */
  typedefName: string;
  /** The label GUID (suffix of typedefName) when it is a GUID, else the full typedef name. */
  id: string;
  /** Best-effort human-readable name (typedef description, else the GUID/slug). */
  displayName: string;
  raw?: unknown;
}

/**
 * Atlas classification-typedef name prefix used by the Purview Data Map
 * MIP + sensitivity-labels integration. When a Purview account is connected to
 * Microsoft Purview Information Protection and assets are scanned, each MIP
 * sensitivity label is registered in the Data Map as a classification typedef
 * named `MICROSOFT.GOVERNANCE.LABELS.<labelGuid>`. Loom uses this same naming
 * convention when it stamps a label onto an asset (ensureClassificationDefs +
 * addAssetClassification), so the round-trip stays inside the classic Data Map
 * and requires NO Microsoft Fabric / Power BI / Graph dependency.
 *
 * Grounded in:
 *   https://learn.microsoft.com/purview/how-to-automatically-label-your-content
 *   https://learn.microsoft.com/purview/data-gov-api-atlas-2-2 (typedefs)
 */
export const SENSITIVITY_LABEL_TYPEDEF_PREFIX = 'MICROSOFT.GOVERNANCE.LABELS.';

const LABEL_GUID_RE = GUID_RE;

/**
 * List MIP sensitivity labels registered in the CLASSIC Data Map.
 *
 * Reads Atlas classification-typedef headers
 *   GET {base}/datamap/api/atlas/v2/types/typedefs/headers?api-version=2023-09-01
 * and keeps the ones whose name starts with SENSITIVITY_LABEL_TYPEDEF_PREFIX —
 * the typedefs Purview creates for MIP labels (and the ones Loom creates when
 * applying a label). The GUID suffix is the label id.
 *
 * Returns [] (HONEST — not a mock list) when the integration is not yet enabled
 * or no labels have been scanned/applied. Throws PurviewNotConfiguredError when
 * LOOM_PURVIEW_ACCOUNT is unset so the BFF renders the named MessageBar gate.
 *
 * https://learn.microsoft.com/rest/api/purview/datamapdataplane/type/list-type-def-headers
 */
export async function listSensitivityLabels(): Promise<DataMapSensitivityLabel[]> {
  purviewAccount(); // throws PurviewNotConfiguredError when LOOM_PURVIEW_ACCOUNT is unset
  const res = await purviewFetch('/datamap/api/atlas/v2/types/typedefs/headers');
  const headers = await readJson<Array<{ name?: string; category?: string; guid?: string }>>(res);
  if (!Array.isArray(headers)) return [];
  return headers
    .filter((h) => typeof h?.name === 'string' && h.name.startsWith(SENSITIVITY_LABEL_TYPEDEF_PREFIX))
    .map((h): DataMapSensitivityLabel => {
      const name = h.name as string;
      const suffix = name.slice(SENSITIVITY_LABEL_TYPEDEF_PREFIX.length);
      const isGuid = LABEL_GUID_RE.test(suffix);
      return {
        typedefName: name,
        id: isGuid ? suffix : name,
        // Headers carry no friendly name; surface the GUID (honest) or a
        // de-slugged suffix when the typedef uses a readable name.
        displayName: isGuid ? suffix : suffix.replace(/[._-]+/g, ' ').trim() || name,
        raw: h,
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
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

/**
 * List glossaries in the account.
 *   GET /datamap/api/atlas/v2/glossary  → AtlasGlossary[]
 *
 * Used by the data-product "Linked resources" surface to populate the domain
 * (glossary) filter Dropdown. Live-verified: the SINGULAR `/glossary` path
 * lists glossaries (the plural `/glossaries` 404s).
 * https://learn.microsoft.com/rest/api/purview/datamapdataplane/glossary/list-glossaries
 */
export async function listGlossaries(): Promise<{ guid: string; name: string }[]> {
  purviewAccount();
  const gRes = await purviewFetch('/datamap/api/atlas/v2/glossary');
  if (gRes.status === 404) return [];
  const gj = await readJson<any[]>(gRes);
  if (!Array.isArray(gj)) return [];
  return gj
    .filter((g: any) => g?.guid)
    .map((g: any) => ({ guid: g.guid as string, name: (g.name as string) || g.qualifiedName || g.guid }));
}

/**
 * Keyword search across glossary terms within a glossary (or the first
 * glossary when none is given). Reuses the proven listGlossaryTerms GET path
 * (up to 200 terms) and filters on name/qualifiedName client-side — real
 * Purview entries, no mock list. For accounts with >200 terms per glossary a
 * Discovery query with { entityType: 'AtlasGlossaryTerm' } would replace this.
 */
export async function searchGlossaryTermsByKeyword(
  keyword: string,
  glossaryGuid?: string,
  limit = 50,
): Promise<PurviewGlossaryTerm[]> {
  const terms = await listGlossaryTerms(glossaryGuid);
  const q = (keyword || '').trim().toLowerCase();
  if (!q) return terms.slice(0, limit);
  return terms
    .filter((t) =>
      (t.name || '').toLowerCase().includes(q) ||
      (t.qualifiedName || '').toLowerCase().includes(q),
    )
    .slice(0, limit);
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

/**
 * Register an Azure Databricks **Unity Catalog** source on the classic Data Map
 * scan plane. The portal "Register sources (Azure Databricks Unity Catalog)"
 * flow takes a Name + Metastore ID + collection; the REST shape is the same
 * with `kind: 'AzureDatabricksUnityCatalog'`.
 *
 *   https://learn.microsoft.com/purview/register-scan-azure-databricks-unity-catalog#register
 *
 * The collection defaults to the account root collection so the scanned assets
 * land somewhere queryable; pass `collectionName` to scope to a sub-collection
 * (the classic mirror of a governance domain).
 */
export async function registerDatabricksUnityCatalogSource(opts: {
  name: string;
  metastoreId: string;
  collectionName?: string;
}): Promise<PurviewDataSource> {
  purviewAccount();
  if (!opts?.name) throw new PurviewError(400, null, 'name is required');
  if (!opts?.metastoreId) throw new PurviewError(400, null, 'metastoreId is required');
  const collection = opts.collectionName || (await rootCollectionName());
  const properties: Record<string, unknown> = { metastoreId: opts.metastoreId };
  if (collection) properties.collection = { referenceName: collection, type: 'CollectionReference' };
  return registerDataSource({ name: opts.name, kind: 'AzureDatabricksUnityCatalog', properties });
}

/**
 * Scan-config for a Databricks UC scan.
 *
 * Per Microsoft Learn (register-scan-azure-databricks-unity-catalog#authentication-for-a-scan)
 * a Databricks Unity Catalog scan supports THREE auth methods — listed in this
 * order: **system-assigned managed identity**, **personal access token** (PAT,
 * stored in Key Vault), and **service principal**. (NOTE: this differs from the
 * older Hive-metastore Databricks connector and from this code's previous
 * comment, which claimed MI "isn't available" — that is no longer accurate for
 * the Unity Catalog connector.)
 *
 * Loom defaults to the **managed-identity** path (MI-first, per .claude/rules):
 * the Purview account's system-assigned MI (catalog.bicep gives the account
 * `identity:{type:'SystemAssigned'}`) is registered as a Databricks service
 * principal — using Purview's Application ID — and granted UC SELECT/USE
 * privileges. That path needs **no Key Vault and no PAT** — only a running SQL
 * Warehouse + its HTTP path. The 'access-token' path remains available for
 * operators who prefer a Key-Vault-backed PAT credential.
 *
 * Regardless of auth method the scan also needs a running SQL Warehouse and its
 * HTTP path; these can't be inferred from the Console UAMI, so the
 * scan-define/trigger step gates honestly when the operator hasn't supplied the
 * HTTP path. (Source registration is fully automatic; only the scan needs this.)
 *
 * LINEAGE: table/column lineage extraction requires the **system.access** schema
 * to be enabled in the Unity Catalog metastore (lineage lives in UC system
 * tables). Without it the source still scans and catalogs assets, but lineage is
 * empty. See register-scan-azure-databricks-unity-catalog#prerequisites (step 6).
 */
export interface DatabricksScanConfig {
  /** Workspace URL to scan (https://adb-….azuredatabricks.net). */
  workspaceUrl: string;
  /** SQL Warehouse HTTP path, e.g. /sql/1.0/warehouses/abc123. */
  httpPath: string;
  /**
   * Scan auth method. Defaults to 'managed-identity' (MI-first, no Key Vault)
   * unless a `credentialName` is supplied, in which case 'access-token' is used.
   */
  auth?: 'managed-identity' | 'access-token';
  /** Required ONLY for auth==='access-token': name of a Purview credential
   *  (Key-Vault-backed Access Token) created in the account. */
  credentialName?: string;
  /** Integration runtime name (Azure IR / Managed VNet IR / SHIR). Defaults to the managed Azure IR. */
  integrationRuntimeName?: string;
  collectionName?: string;
}

/**
 * Define + return a Databricks UC scan (does NOT trigger it — call
 * {@link triggerScanRun} after). The scan body carries the Databricks-specific
 * properties (workspaceUrl + serverHttpPath + connectedVia [+ credential for the
 * access-token path]) so it cannot reuse the generic ruleset-only
 * {@link upsertScan} — the PUT is issued directly. The scan uses the system
 * default Databricks UC scan ruleset for classification.
 *
 * The scan `kind` encodes the auth method (the convention every Purview scan
 * connector uses — e.g. `AdlsGen2Msi`):
 *   - managed-identity → `AzureDatabricksUnityCatalogMsi` (no credential block;
 *     uses the Purview account's system-assigned MI)
 *   - access-token     → `AzureDatabricksUnityCatalogAccessToken` (+ credential)
 *
 * NOTE (portal-derived): the exact `kind` strings + property casing
 * (`serverHttpPath`) are derived from the Purview portal's scan-create network
 * call, not the public scanningdataplane REST reference — confirm against a live
 * classic account when smoke-testing. `triggerScanRun` / `registerDataSource`
 * are reference-confirmed.
 *   https://learn.microsoft.com/purview/register-scan-azure-databricks-unity-catalog#scan
 */
export async function defineDatabricksUnityCatalogScan(
  sourceName: string,
  scanName: string,
  cfg: DatabricksScanConfig,
): Promise<PurviewScan> {
  purviewAccount();
  if (!sourceName) throw new PurviewError(400, null, 'sourceName is required');
  if (!scanName) throw new PurviewError(400, null, 'scanName is required');
  if (!cfg?.workspaceUrl) throw new PurviewError(400, null, 'workspaceUrl is required');
  if (!cfg?.httpPath) throw new PurviewError(400, null, 'httpPath is required (SQL Warehouse HTTP path)');
  // MI-first: default to managed-identity unless a credential name is supplied.
  const auth: 'managed-identity' | 'access-token' =
    cfg.auth || (cfg.credentialName ? 'access-token' : 'managed-identity');
  if (auth === 'access-token' && !cfg.credentialName) {
    throw new PurviewError(400, null, "credentialName is required for auth='access-token' (Key-Vault Access Token)");
  }
  const collection = cfg.collectionName || (await rootCollectionName());
  const properties: Record<string, unknown> = {
    workspaceUrl: cfg.workspaceUrl.replace(/\/$/, ''),
    serverHttpPath: cfg.httpPath,
    connectedVia: { referenceName: cfg.integrationRuntimeName || 'AzureAutoResolveIntegrationRuntime' },
    scanRulesetName: 'AzureDatabricksUnityCatalog',
    scanRulesetType: 'System',
    ...(auth === 'access-token'
      ? { credential: { referenceName: cfg.credentialName, credentialType: 'AccessToken' } }
      : {}),
    ...(collection ? { collection: { referenceName: collection, type: 'CollectionReference' } } : {}),
  };
  const kind =
    auth === 'access-token'
      ? 'AzureDatabricksUnityCatalogAccessToken'
      : 'AzureDatabricksUnityCatalogMsi';
  const res = await purviewFetch(
    `/scan/datasources/${encodeURIComponent(sourceName)}/scans/${encodeURIComponent(scanName)}`,
    { method: 'PUT', apiVersion: SCAN_API_VERSION, body: JSON.stringify({ kind, properties }) },
  );
  const raw = await readJson<any>(res);
  if (!raw) throw new PurviewError(500, null, 'Purview returned empty body on defineDatabricksUnityCatalogScan');
  return { id: raw?.id || raw?.name || scanName, name: raw?.name || scanName, kind: raw?.kind, schedule: raw?.properties?.schedule, raw };
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

/**
 * Detect whether a Purview scan executes on a SELF-HOSTED integration runtime —
 * the signal that the shared admin-zone Purview SHIR VMSS must be scaled up
 * before triggering the scan.
 *
 * A Purview scan definition references its IR via `properties.connectedVia
 * .referenceName` (the scanning data plane's IR reference). When present, we
 * read that IR (GET /scan/integrationruntimes/{name}) and treat it as
 * self-hosted when its kind/type is "SelfHosted" (managed/Azure-auto IRs are
 * "Managed"/absent). Fail-open: any read failure returns false so a scan is
 * never blocked by detection.
 *
 *   GET /scan/datasources/{src}/scans/{scan}?api-version=2022-07-01-preview
 *   GET /scan/integrationruntimes/{name}?api-version=2022-07-01-preview
 * https://learn.microsoft.com/rest/api/purview/scanningdataplane/scans/get
 * https://learn.microsoft.com/rest/api/purview/scanningdataplane/integration-runtimes/get
 */
export async function scanUsesSelfHostedIr(sourceName: string, scanName: string): Promise<boolean> {
  try {
    if (!sourceName || !scanName) return false;
    const sRes = await purviewFetch(
      `/scan/datasources/${encodeURIComponent(sourceName)}/scans/${encodeURIComponent(scanName)}`,
      { apiVersion: SCAN_API_VERSION },
    );
    if (sRes.status === 404) return false;
    const scan = await readJson<any>(sRes);
    const irName: string | undefined =
      scan?.properties?.connectedVia?.referenceName ??
      scan?.properties?.integrationRuntimeReference?.referenceName;
    if (!irName || typeof irName !== 'string') return false; // managed/AutoResolve IR — no SHIR
    const irRes = await purviewFetch(
      `/scan/integrationruntimes/${encodeURIComponent(irName)}`,
      { apiVersion: SCAN_API_VERSION },
    );
    if (irRes.status === 404) return false;
    const ir = await readJson<any>(irRes);
    const kind = (ir?.kind || ir?.properties?.type || ir?.type || '').toString().toLowerCase();
    return kind === 'selfhosted';
  } catch {
    return false;
  }
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
// Scan plane (cont.) — custom classification rules + scan rule sets + scans.
//
// These are the writes that make Loom's classification taxonomy ACTUALLY
// classify data on a scan (vs. only living in Cosmos). Grounded in:
//   - Custom classification rules:
//       PUT {base}/scan/classificationrules/{name}?api-version=2022-07-01-preview
//       https://learn.microsoft.com/purview/data-map-classification-custom
//       https://learn.microsoft.com/rest/api/purview/scanningdataplane/classification-rules
//       (Az.Purview: New-AzPurviewClassificationRule)
//   - Scan rule sets (bind custom rules into a scan):
//       PUT {base}/scan/scanrulesets/{name}?api-version=2022-07-01-preview
//       https://learn.microsoft.com/purview/data-map-scan-rule-set
//       (Az.Purview: New-AzPurviewScanRuleset)
//   - Scan definitions (so a Loom-created scan can be triggered):
//       PUT {base}/scan/datasources/{ds}/scans/{scan}?api-version=2022-07-01-preview
//       https://learn.microsoft.com/purview/register-scan-synapse-workspace#scan
//
// NOTE: per Purview classification best-practice, custom classifications are
// NOT included in any default (System) scan rule set — to auto-assign a custom
// classification a scan must use a CUSTOM scan rule set that includes the rule.
// Custom classification rules are also ENGLISH-only; non-Latin patterns are
// passed through and Purview validates them (its error surfaces verbatim via
// PurviewError — never silently dropped).
// ============================================================

/** A regex classification rule pattern (the only pattern kind the scan plane exposes). */
export interface PurviewRegexPattern {
  kind: 'Regex';
  pattern: string;
}

export interface PurviewClassificationRule {
  name: string;
  classificationName?: string;
  ruleStatus?: string;
  description?: string;
  columnPatterns?: PurviewRegexPattern[];
  dataPatterns?: PurviewRegexPattern[];
  minimumPercentageMatch?: number;
  raw?: unknown;
}

export interface PurviewScanRuleset {
  name: string;
  kind?: string;
  includedCustomClassificationRuleNames?: string[];
  excludedSystemClassifications?: string[];
  raw?: unknown;
}

/**
 * Create-or-replace a CUSTOM classification rule (idempotent — PUT).
 *   PUT /scan/classificationrules/{name}
 *   body: { kind:'Custom', properties:{ classificationName, ruleStatus:'Enabled',
 *           description?, columnPatterns?, dataPatterns?, minimumPercentageMatch? } }
 *
 * `classificationName` is the (namespaced) classification the rule applies to a
 * matching column/data value during a scan — e.g. `LOOM.<TENANT>.PII`. Column
 * and data patterns are supplied as plain regex strings and wrapped as
 * `{kind:'Regex', pattern}` here. Needs the Loom UAMI "Data Source
 * Administrator" on the root collection (classic Data Map metadata policy —
 * granted by scripts/csa-loom/grant-purview-datamap-role.sh ROLE=data-source-administrator).
 */
export async function upsertCustomClassificationRule(rule: {
  name: string;
  classificationName: string;
  description?: string;
  columnPatterns?: string[];
  dataPatterns?: string[];
  minimumPercentageMatch?: number;
}): Promise<PurviewClassificationRule> {
  purviewAccount();
  if (!rule?.name) throw new PurviewError(400, null, 'name is required');
  if (!rule?.classificationName) throw new PurviewError(400, null, 'classificationName is required');
  const properties: Record<string, unknown> = {
    classificationName: rule.classificationName,
    ruleStatus: 'Enabled',
    ...(rule.description ? { description: rule.description } : {}),
  };
  const cols = (rule.columnPatterns || []).map((p) => (p || '').trim()).filter(Boolean);
  const data = (rule.dataPatterns || []).map((p) => (p || '').trim()).filter(Boolean);
  if (cols.length) properties.columnPatterns = cols.map((pattern): PurviewRegexPattern => ({ kind: 'Regex', pattern }));
  if (data.length) properties.dataPatterns = data.map((pattern): PurviewRegexPattern => ({ kind: 'Regex', pattern }));
  if (typeof rule.minimumPercentageMatch === 'number') properties.minimumPercentageMatch = rule.minimumPercentageMatch;
  const res = await purviewFetch(`/scan/classificationrules/${encodeURIComponent(rule.name)}`, {
    method: 'PUT',
    apiVersion: SCAN_API_VERSION,
    body: JSON.stringify({ kind: 'Custom', properties }),
  });
  const raw = await readJson<any>(res);
  return {
    name: raw?.name || rule.name,
    classificationName: raw?.properties?.classificationName ?? rule.classificationName,
    ruleStatus: raw?.properties?.ruleStatus,
    description: raw?.properties?.description,
    columnPatterns: raw?.properties?.columnPatterns,
    dataPatterns: raw?.properties?.dataPatterns,
    minimumPercentageMatch: raw?.properties?.minimumPercentageMatch,
    raw,
  };
}

/** GET /scan/classificationrules — all classification rules (System + Custom). */
export async function listClassificationRules(): Promise<PurviewClassificationRule[]> {
  purviewAccount();
  const res = await purviewFetch('/scan/classificationrules', { apiVersion: SCAN_API_VERSION });
  if (res.status === 404) return [];
  const j = await readJson<{ value?: any[] }>(res);
  return (j?.value || []).map((raw): PurviewClassificationRule => ({
    name: raw?.name,
    classificationName: raw?.properties?.classificationName,
    ruleStatus: raw?.properties?.ruleStatus,
    description: raw?.properties?.description,
    columnPatterns: raw?.properties?.columnPatterns,
    dataPatterns: raw?.properties?.dataPatterns,
    minimumPercentageMatch: raw?.properties?.minimumPercentageMatch,
    raw,
  }));
}

/** DELETE /scan/classificationrules/{name}. Returns false on 404. */
export async function deleteCustomClassificationRule(name: string): Promise<boolean> {
  purviewAccount();
  if (!name) throw new PurviewError(400, null, 'name is required');
  const res = await purviewFetch(`/scan/classificationrules/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    apiVersion: SCAN_API_VERSION,
  });
  if (res.status === 404) return false;
  await readJson<unknown>(res);
  return true;
}

/**
 * Create-or-replace a CUSTOM scan rule set that includes the given custom
 * classification rules (idempotent — PUT).
 *   PUT /scan/scanrulesets/{name}
 *   body: { kind:'<AdlsGen2|AzureSqlDatabase|...>',
 *           properties:{ includedCustomClassificationRuleNames:[...],
 *                        excludedSystemClassifications?:[...] } }
 *
 * `kind` is the data-source kind the rule set applies to (a rule set is
 * source-kind-scoped in Purview). Required so the scan that references it can
 * auto-assign the custom classifications during a scan run.
 */
export async function upsertScanRuleset(ruleset: {
  name: string;
  kind: string;
  description?: string;
  includedCustomClassificationRuleNames?: string[];
  excludedSystemClassifications?: string[];
}): Promise<PurviewScanRuleset> {
  purviewAccount();
  if (!ruleset?.name) throw new PurviewError(400, null, 'name is required');
  if (!ruleset?.kind) throw new PurviewError(400, null, 'kind is required');
  const included = [...new Set((ruleset.includedCustomClassificationRuleNames || []).filter(Boolean))];
  const properties: Record<string, unknown> = {
    ...(ruleset.description ? { description: ruleset.description } : {}),
    ...(included.length ? { includedCustomClassificationRuleNames: included } : {}),
    ...(ruleset.excludedSystemClassifications?.length
      ? { excludedSystemClassifications: ruleset.excludedSystemClassifications }
      : {}),
  };
  const res = await purviewFetch(`/scan/scanrulesets/${encodeURIComponent(ruleset.name)}`, {
    method: 'PUT',
    apiVersion: SCAN_API_VERSION,
    body: JSON.stringify({ kind: ruleset.kind, properties }),
  });
  const raw = await readJson<any>(res);
  return {
    name: raw?.name || ruleset.name,
    kind: raw?.kind || ruleset.kind,
    includedCustomClassificationRuleNames: raw?.properties?.includedCustomClassificationRuleNames ?? included,
    excludedSystemClassifications: raw?.properties?.excludedSystemClassifications,
    raw,
  };
}

/** GET /scan/scanrulesets — custom scan rule sets defined on the account. */
export async function listScanRulesets(): Promise<PurviewScanRuleset[]> {
  purviewAccount();
  const res = await purviewFetch('/scan/scanrulesets', { apiVersion: SCAN_API_VERSION });
  if (res.status === 404) return [];
  const j = await readJson<{ value?: any[] }>(res);
  return (j?.value || []).map((raw): PurviewScanRuleset => ({
    name: raw?.name,
    kind: raw?.kind,
    includedCustomClassificationRuleNames: raw?.properties?.includedCustomClassificationRuleNames,
    excludedSystemClassifications: raw?.properties?.excludedSystemClassifications,
    raw,
  }));
}

/**
 * Create-or-replace a scan definition on a registered data source (idempotent —
 * PUT). A scan must exist before a run can be triggered (triggerScanRun).
 *   PUT /scan/datasources/{ds}/scans/{scan}
 *   body: { kind:'<AdlsGen2Msi|AzureSqlDatabaseCredential|...>',
 *           properties:{ scanRulesetName, scanRulesetType:'System'|'Custom',
 *                        collection?:{ referenceName, type:'CollectionReference' } } }
 *
 * Use scanRulesetType:'Custom' with a Loom-built scan rule set (upsertScanRuleset)
 * to make the taxonomy's custom classification rules apply on the scan; use
 * 'System' for the built-in classifications only.
 */
export async function upsertScan(payload: {
  sourceName: string;
  scanName: string;
  kind: string;
  scanRulesetName: string;
  scanRulesetType?: 'System' | 'Custom';
  collectionRef?: string;
}): Promise<PurviewScan> {
  purviewAccount();
  if (!payload?.sourceName) throw new PurviewError(400, null, 'sourceName is required');
  if (!payload?.scanName) throw new PurviewError(400, null, 'scanName is required');
  if (!payload?.kind) throw new PurviewError(400, null, 'kind is required');
  if (!payload?.scanRulesetName) throw new PurviewError(400, null, 'scanRulesetName is required');
  const properties: Record<string, unknown> = {
    scanRulesetName: payload.scanRulesetName,
    scanRulesetType: payload.scanRulesetType || 'System',
    ...(payload.collectionRef
      ? { collection: { referenceName: payload.collectionRef, type: 'CollectionReference' } }
      : {}),
  };
  const res = await purviewFetch(
    `/scan/datasources/${encodeURIComponent(payload.sourceName)}/scans/${encodeURIComponent(payload.scanName)}`,
    { method: 'PUT', apiVersion: SCAN_API_VERSION, body: JSON.stringify({ kind: payload.kind, properties }) },
  );
  const raw = await readJson<any>(res);
  if (!raw) throw new PurviewError(500, null, 'Purview returned empty body on upsertScan');
  return {
    id: raw?.id || raw?.name || payload.scanName,
    name: raw?.name || payload.scanName,
    kind: raw?.kind || payload.kind,
    schedule: raw?.properties?.schedule,
    raw,
  };
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
 * Data-product CRUD — delegates to the DataProductStore adapter selected by
 * LOOM_DATAPRODUCTS_BACKEND:
 *   unset / 'cosmos'   → CosmosDataProductStore (Azure-native DEFAULT — real
 *                        Cosmos CRUD, NO Microsoft Fabric / unified-catalog dep).
 *   'unified-catalog'  → UnifiedCatalogGateAdapter (opt-in honest gate; throws
 *                        PurviewUnifiedCatalogGateError, a subclass of
 *                        PurviewNotConfiguredError, so every existing BFF catch
 *                        still renders a 501/503 + hint MessageBar).
 *
 * NOTE: the classic `purviewAccount()` gate is NOT on the default Cosmos path —
 * data products live in Loom's own Cosmos catalog and never require a Purview
 * account. The store is imported lazily so this module has no static dependency
 * on the Cosmos client (keeps the classic Data Map surface independently usable).
 */
export async function registerDataProduct(payload: PurviewDataProductPayload): Promise<PurviewDataProduct> {
  const { getDataProductStore } = await import('@/lib/dataproducts/store');
  return (await getDataProductStore()).register(payload);
}

export async function getDataProduct(id: string): Promise<PurviewDataProduct | null> {
  const { getDataProductStore } = await import('@/lib/dataproducts/store');
  return (await getDataProductStore()).get(id);
}

export async function listDataProducts(domain?: string): Promise<PurviewDataProduct[]> {
  const { getDataProductStore } = await import('@/lib/dataproducts/store');
  return (await getDataProductStore()).list(domain);
}

/**
 * Push a Publish/Unpublish/Expire lifecycle transition to the unified-catalog
 * data product (PUT {endpoint}/datagovernance/catalog/dataProducts/{id} with
 * `status: DRAFT | PUBLISHED | EXPIRED`, the CatalogModelStatus enum from the
 * 2026-03-20-preview REST API).
 *
 * Honest gate: data-product lifecycle is a unified-catalog concept that the
 * deployed CLASSIC Data Map account does not expose. This throws
 * PurviewUnifiedCatalogGateError so the BFF renders the MessageBar hint while
 * Cosmos remains the authoritative status store (the lifecycle still fully
 * works without Purview). When a new-experience unified-catalog account is
 * onboarded (LOOM_PURVIEW_ACCOUNT pointing at it), this becomes the real PUT.
 */
export async function updateDataProductStatus(
  _id: string,
  _status: 'DRAFT' | 'PUBLISHED' | 'EXPIRED',
): Promise<PurviewDataProduct> {
  purviewAccount();
  throw new PurviewUnifiedCatalogGateError('Data product lifecycle');
}

/**
 * Best-effort delete from the Purview Unified Catalog.
 *
 * On the deployed CLASSIC Data Map account this always throws
 * PurviewUnifiedCatalogGateError — the `-api` host and the `/datagovernance`
 * surface do not exist. The DELETE /api/data-products/[id] route catches this
 * and logs it WITHOUT failing the authoritative Cosmos delete (per
 * .claude/rules/no-vaporware.md — honest gate, no fabricated success).
 *
 * On a future new-experience unified-catalog account this is where the real
 * call lands:
 *   DELETE {account}-api.purview.azure.com/datagovernance/catalog/dataProducts/{id}
 *       ?api-version=2026-03-20-preview
 * See https://learn.microsoft.com/purview/unified-catalog-data-products-create-manage#delete-data-products
 */
export async function deleteDataProductBestEffort(
  _purviewDataProductId: string,
): Promise<{ deleted: boolean; note?: string }> {
  // Touch the env var so an unset account yields the precise "not configured"
  // gate before the unified-catalog gate.
  purviewAccount();
  throw new PurviewUnifiedCatalogGateError('Data products (delete)');
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
export function domainCollectionName(idOrName: string): string {
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
  body: { name?: string; description?: string; parentId?: string },
): Promise<PurviewBusinessDomain> {
  purviewAccount();
  const colName = domainCollectionName(id);
  // Preserve the collection hierarchy: a subdomain's mirror keeps its parent
  // collection (passed by the caller); a root domain re-asserts the account
  // root collection. PUT /collections is create-or-update, so omitting the
  // parent would otherwise re-parent the collection to root.
  const parent = body.parentId || (await rootCollectionName());
  const res = await purviewFetch(`/collections/${encodeURIComponent(colName)}`, {
    method: 'PUT',
    apiVersion: ACCOUNT_API_VERSION,
    body: JSON.stringify({
      ...(body.name ? { friendlyName: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(parent ? { parentCollection: { referenceName: parent } } : {}),
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
  const res = await fetchWithTimeout(
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

// ============================================================
// F19 — general-purpose audit-log query (Audit logs surface)
// ============================================================

export const PURVIEW_AUDIT_API_VERSION = '2023-10-01-preview';

export interface PurviewAuditQueryOpts {
  startTime?: string;     // ISO — API "startTime"
  endTime?: string;       // ISO — API "endTime"
  userId?: string;        // UPN filter — API "userId"
  operationType?: string; // e.g. 'ClassificationAdded' — API "operationType"
  guid?: string;          // asset GUID — API "guid"
  keywords?: string;      // free-text — API "keywords"
  pageSize?: number;      // default 200, max 1000
  continuationToken?: string;
}

export interface PurviewAuditEvent {
  id: string;
  at: string;      // timestamp (ISO)
  who: string;     // userId from the event
  kind: string;    // operationType
  itemId: string;  // guid / resourceId
  category: string;
  source: 'purview';
  raw?: unknown;
}

export interface PurviewAuditPage {
  events: PurviewAuditEvent[];
  continuationToken?: string;
  lastPage: boolean;
}

/**
 * Query the Purview Data Map audit log (general-purpose; F19 Audit logs).
 *
 * POST {base}/datamap/api/audit/query?api-version=2023-10-01-preview
 * Body params documented at https://learn.microsoft.com/purview/data-map-history
 *
 * Unlike `queryDomainAuditLog` (Asset category + domain filter), this exposes
 * all the API filter params (time / userId / operationType / guid / keywords)
 * and returns normalized rows for the audit grid.
 *
 * Requires the Loom UAMI to hold at minimum a "Data Reader" role on the root
 * collection (classic Data Map metadata policy — NOT ARM RBAC). Same scope /
 * token as every other purview-client function.
 *
 * Honest gates:
 *   LOOM_PURVIEW_ACCOUNT unset → PurviewNotConfiguredError (501/503 + hint)
 *   401/403 from the plane → PurviewError (role missing)
 */
export async function queryAuditLog(opts: PurviewAuditQueryOpts): Promise<PurviewAuditPage> {
  purviewAccount(); // throws PurviewNotConfiguredError when env var unset
  const token = await credential.getToken(PURVIEW_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire Purview data-plane token');

  const payload: Record<string, unknown> = {
    sortBy: 'CreationTime',
    sortOrder: 'Descending',
    pageSize: Math.min(1000, Math.max(1, opts.pageSize ?? 200)),
  };
  if (opts.startTime)         payload.startTime         = opts.startTime;
  if (opts.endTime)           payload.endTime           = opts.endTime;
  if (opts.userId)            payload.userId            = opts.userId;
  if (opts.operationType)     payload.operationType     = opts.operationType;
  if (opts.guid)              payload.guid              = opts.guid;
  if (opts.keywords)          payload.keywords          = opts.keywords;
  if (opts.continuationToken) payload.continuationToken = opts.continuationToken;

  const url = `${purviewBase()}/datamap/api/audit/query?api-version=${PURVIEW_AUDIT_API_VERSION}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const j = await readJson<any>(res);
    throw new PurviewError(res.status, j, `Purview audit query failed: ${res.status}`);
  }

  const j = await readJson<{ value?: any[]; continuationToken?: string; lastPage?: boolean }>(res);
  const events: PurviewAuditEvent[] = (j?.value || []).map((v: any): PurviewAuditEvent => ({
    id:       v.id ?? String(v.timestamp ?? v.creationTime ?? Math.random()),
    at:       v.timestamp ?? v.creationTime ?? '',
    who:      v.userId ?? v.user ?? '',
    kind:     v.operationType ?? v.operation ?? v.category ?? '',
    itemId:   v.guid ?? v.resourceId ?? '',
    category: v.category ?? '',
    source:   'purview',
    raw:      v,
  }));

  return {
    events,
    continuationToken: j?.continuationToken ?? undefined,
    lastPage: j?.lastPage ?? true,
  };
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
