/**
 * Microsoft Purview Unified Catalog Data Plane client.
 *
 * Targets the Loom Console UAMI via ChainedTokenCredential:
 *   1. ManagedIdentityCredential({ clientId: LOOM_UAMI_CLIENT_ID }) — prod path
 *   2. DefaultAzureCredential — local dev / az login fallback
 *
 * Backing API: Purview Unified Catalog (Public Preview)
 *   https://learn.microsoft.com/rest/api/purview/purview-unified-catalog/data-products
 *
 *   POST  https://{account}-api.purview.azure.com/datagovernance/catalog/dataProducts?api-version=2026-03-20-preview
 *   GET   https://{account}-api.purview.azure.com/datagovernance/catalog/dataProducts/{id}?api-version=2026-03-20-preview
 *   GET   https://{account}-api.purview.azure.com/datagovernance/catalog/dataProducts?api-version=2026-03-20-preview
 *
 * Token scope: https://purview.azure.net/.default   (NOT azure.com — the
 * Unified Catalog data plane is a distinct audience from ARM.)
 *
 * UAMI permissions: Loom UAMI needs *both* of the following data-plane roles
 * at the governance-domain level, granted via the Purview portal because
 * these are NOT ARM RBAC:
 *   - Data Curator
 *   - Data Product Owner
 *
 * Env vars:
 *   LOOM_PURVIEW_ACCOUNT  — short Purview account name (e.g. `purview-csa-loom-eastus2`),
 *                            NOT the full https://… URL. The client appends `-api.purview.azure.com`.
 *
 * Configuration gate: if LOOM_PURVIEW_ACCOUNT is missing, every export throws
 * `PurviewNotConfiguredError` carrying a structured `hint` payload the BFF
 * can surface to the operator (bicep module path + missing roles).
 *
 * 404 → returns null on GETs so the route can branch cleanly.
 * Any other non-2xx throws `PurviewError(status, body)`.
 */
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';

const PURVIEW_SCOPE = 'https://purview.azure.net/.default';
const PURVIEW_API_VERSION = '2026-03-20-preview';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
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
 * Thrown when LOOM_PURVIEW_ACCOUNT (or other required infra prerequisites) is
 * not set. The BFF translates this into HTTP 501 with the hint payload so the
 * operator sees an actionable next step in the editor MessageBar.
 */
export class PurviewNotConfiguredError extends Error {
  hint: PurviewNotConfiguredHint;
  constructor(hint: PurviewNotConfiguredHint) {
    super(`Microsoft Purview is not provisioned in this deployment: missing ${hint.missingEnvVar}`);
    this.hint = hint;
  }
}

export class PurviewError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `Purview Unified Catalog call failed (${status})`);
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
    bicepModule: 'platform/fiab/bicep/modules/purview/',
    bicepStatus: 'Not yet deployed. The `purview/` module does not exist in the FiaB bicep tree as of this build — Phase 6 of docs/fiab/data-product-parity-spec.md adds it. Until then, Purview registration is gated.',
    rolesRequired: [
      {
        name: 'Data Curator',
        scope: 'Governance domain (granted in the Purview portal — NOT an ARM RBAC role)',
        reason: 'Required to read business domains, glossary terms, and data assets that back a data product.',
      },
      {
        name: 'Data Product Owner',
        scope: 'Governance domain (granted in the Purview portal — NOT an ARM RBAC role)',
        reason: 'Required to create, update, publish, and unpublish data products via the Unified Catalog data plane.',
      },
    ],
    followUp: 'Operator action: (1) add platform/fiab/bicep/modules/purview/purview.bicep that deploys Microsoft.Purview/accounts + diagnostic settings, (2) set LOOM_PURVIEW_ACCOUNT in admin-plane/main.bicep apps[] env list, (3) grant Loom UAMI both data-plane roles at the governance-domain level via the Purview portal (or scripts/csa-loom/grant-purview-rbac.sh once it lands), then redeploy admin-plane.',
  };
}

function purviewAccount(): string {
  const raw = process.env.LOOM_PURVIEW_ACCOUNT;
  if (!raw) throw new PurviewNotConfiguredError(notConfiguredHint('LOOM_PURVIEW_ACCOUNT'));
  // Defensive: accept either bare account name or full URL — store the short
  // name in env, but tolerate copy/paste of a full URL.
  return raw
    .replace(/^https?:\/\//, '')
    .replace(/-api\.purview\.azure\.com.*$/, '')
    .replace(/\.purview\.azure\.com.*$/, '')
    .replace(/\/+$/, '');
}

function purviewBase(): string {
  return `https://${purviewAccount()}-api.purview.azure.com`;
}

// ============================================================
// Low-level fetch
// ============================================================

async function purviewFetch(
  path: string,
  init: RequestInit & { query?: Record<string, string> } = {},
): Promise<Response> {
  const token = await credential.getToken(PURVIEW_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire Purview data-plane token');
  const sep = path.includes('?') ? '&' : '?';
  const query = init.query
    ? '&' + new URLSearchParams(init.query).toString()
    : '';
  const url = `${purviewBase()}${path}${sep}api-version=${PURVIEW_API_VERSION}${query}`;
  const { query: _q, ...rest } = init;
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
      (parsed as any)?.message ||
      (typeof parsed === 'string' ? parsed : `Purview ${res.status}`);
    throw new PurviewError(res.status, parsed, msg);
  }
  return (parsed as T) ?? ({} as T);
}

// ============================================================
// Data product types (Phase 1 — subset of the Unified Catalog schema)
// ============================================================

/**
 * Loom-side payload for register/upsert. We keep this narrow on purpose —
 * Phase 1 wires the create/get/list happy path. Subsequent phases extend it
 * with type/audience/terms/customAttributes/owners[]/dataAssets[] per the
 * parity spec.
 */
export interface PurviewDataProductPayload {
  /** Display name. Maps to Unified Catalog `name`. */
  displayName: string;
  /** Long-form description / business narrative. Maps to `description`. */
  description?: string;
  /**
   * Governance domain GUID. REQUIRED by Purview. This MUST be the actual
   * Purview `businessDomainId` — not a free-text label. The BFF route is
   * responsible for translating Loom's stored `state.domain` to a real
   * domain id before calling here, or returning 422.
   */
  domain: string;
  /** Primary owner UPN/email. Mapped to the first entry of Purview `contacts`. */
  owner?: string;
  /** Optional SLA narrative — surfaced as a `termsOfUse` line in Phase 2. */
  sla?: string;
  /** Free-text bundle entries from the Loom editor. Stored as `documentation[]`. */
  bundle?: string[];
  /** Optional product type. Defaults to `Operational` if not supplied. */
  type?: string;
  /** Whether to mark Endorsed. Default false (drafts publish unendorsed). */
  endorsed?: boolean;
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

function shape(raw: any): PurviewDataProduct {
  return {
    id: raw?.id || raw?.dataProductId,
    name: raw?.name || raw?.displayName,
    description: raw?.description,
    domain: raw?.domain || raw?.businessDomainId,
    status: raw?.status,
    type: raw?.type,
    endorsed: raw?.endorsed,
    contacts: raw?.contacts,
    documentation: raw?.documentation,
    updatedAt: raw?.updatedAt || raw?.modifiedAt || raw?.systemData?.lastModifiedAt,
    raw,
  };
}

function toPurviewBody(p: PurviewDataProductPayload): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: p.displayName,
    description: p.description || '',
    domain: p.domain,
    type: p.type || 'Operational',
    status: 'Draft',
    endorsed: !!p.endorsed,
  };
  if (p.owner) {
    body.contacts = [{ id: p.owner, role: 'Owner', description: 'Primary owner' }];
  }
  if (p.bundle && p.bundle.length > 0) {
    body.documentation = p.bundle.map((line) => ({ name: line, type: 'Note' }));
  }
  if (p.sla) {
    body.termsOfUse = [{ name: 'SLA', description: p.sla, type: 'Note' }];
  }
  return body;
}

// ============================================================
// Exports — Phase 1 surface area
// ============================================================

/**
 * Create a data product in Purview Unified Catalog.
 *
 * Phase 1 always POSTs (idempotent upsert by name is a Phase 2 task once we
 * have a GET-by-name endpoint and a reliable id round-trip). Caller is
 * responsible for persisting the returned `id` back to Cosmos so subsequent
 * edits route through `updateDataProduct` (Phase 2).
 */
export async function registerDataProduct(payload: PurviewDataProductPayload): Promise<PurviewDataProduct> {
  // Touch the env var early so a NotConfigured throw beats the body build.
  purviewAccount();
  if (!payload?.displayName) throw new PurviewError(400, null, 'displayName is required');
  if (!payload?.domain) throw new PurviewError(400, null, 'domain (Purview businessDomainId GUID) is required');

  const res = await purviewFetch('/datagovernance/catalog/dataProducts', {
    method: 'POST',
    body: JSON.stringify(toPurviewBody(payload)),
  });
  const j = await readJson<any>(res);
  if (!j) throw new PurviewError(500, null, 'Purview returned an empty body on create');
  return shape(j);
}

export async function getDataProduct(id: string): Promise<PurviewDataProduct | null> {
  purviewAccount();
  if (!id) throw new PurviewError(400, null, 'id is required');
  const res = await purviewFetch(`/datagovernance/catalog/dataProducts/${encodeURIComponent(id)}`);
  const j = await readJson<any>(res);
  return j ? shape(j) : null;
}

export async function listDataProducts(domain?: string): Promise<PurviewDataProduct[]> {
  purviewAccount();
  const init: { query?: Record<string, string> } = {};
  if (domain) init.query = { domain };
  const res = await purviewFetch('/datagovernance/catalog/dataProducts', init);
  const j = await readJson<{ value?: any[] }>(res);
  return (j?.value || []).map(shape);
}

// ============================================================
// Phase-2 surface area — registered data sources, scans, glossary,
// business domains, data-quality rules.
//
// These call the Purview "scan" (legacy Atlas catalog) data plane plus
// the newer Unified Catalog endpoints. Both share the same auth scope
// (https://purview.azure.net/.default) and the same `-api.purview.azure.com`
// host, so the existing purviewFetch / readJson helpers are reused.
//
// Tenant requirements:
//   - Loom UAMI granted "Data Source Administrator" (for scans/sources)
//   - Loom UAMI granted "Data Curator" (for glossary/domains/DQ)
//   Both are governance-domain-scoped RBAC granted in the Purview portal.
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
  raw?: unknown;
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

/** GET /scan/datasources — registered data sources. */
export async function listDataSources(): Promise<PurviewDataSource[]> {
  purviewAccount();
  const res = await purviewFetch('/scan/datasources');
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

/**
 * Register a new data source.
 *
 * PUT /scan/datasources/{name}
 *
 * Caller supplies `{ name, kind, properties }`. We forward as-is.
 */
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
  const res = await purviewFetch(`/scan/datasources/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (res.status === 404) return false;
  await readJson<unknown>(res);
  return true;
}

/** GET /scan/datasources/{name}/scans — scans defined on a source. */
export async function listScansForSource(sourceName: string): Promise<PurviewScan[]> {
  purviewAccount();
  if (!sourceName) throw new PurviewError(400, null, 'sourceName is required');
  const res = await purviewFetch(`/scan/datasources/${encodeURIComponent(sourceName)}/scans`);
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

/** PUT /scan/datasources/{name}/scans/{scan}/run — trigger a scan run. */
export async function triggerScanRun(sourceName: string, scanName: string): Promise<{ runId?: string; raw: unknown }> {
  purviewAccount();
  if (!sourceName || !scanName) throw new PurviewError(400, null, 'sourceName + scanName required');
  const runId = `loom-${Date.now()}`;
  const res = await purviewFetch(
    `/scan/datasources/${encodeURIComponent(sourceName)}/scans/${encodeURIComponent(scanName)}/runs/${runId}`,
    { method: 'PUT' },
  );
  const raw = await readJson<any>(res);
  return { runId: raw?.runId || runId, raw };
}

/** GET /scan/datasources/{name}/scans/{scan}/runs — last N scan runs. */
export async function listScanRuns(sourceName: string, scanName: string): Promise<PurviewScanRun[]> {
  purviewAccount();
  const res = await purviewFetch(
    `/scan/datasources/${encodeURIComponent(sourceName)}/scans/${encodeURIComponent(scanName)}/runs`,
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

/**
 * GET /catalog/api/atlas/v2/glossaries — list glossaries, then for the
 * first glossary, list its terms via /glossary/{guid}/terms.
 *
 * Limited to the first 200 terms — UI is paged below this.
 */
export async function listGlossaryTerms(glossaryGuid?: string): Promise<PurviewGlossaryTerm[]> {
  purviewAccount();

  let targetGuid = glossaryGuid;
  if (!targetGuid) {
    const gRes = await purviewFetch('/catalog/api/atlas/v2/glossaries');
    const gj = await readJson<any[]>(gRes);
    if (!Array.isArray(gj) || gj.length === 0) return [];
    targetGuid = gj[0]?.guid;
  }
  if (!targetGuid) return [];

  const tRes = await purviewFetch(
    `/catalog/api/atlas/v2/glossary/${encodeURIComponent(targetGuid)}/terms?limit=200`,
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

/** POST /catalog/api/atlas/v2/glossary/term — create a glossary term. */
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
  const res = await purviewFetch('/catalog/api/atlas/v2/glossary/term', {
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

/** GET /datagovernance/catalog/businessdomains — business / governance domains. */
export async function listBusinessDomains(): Promise<PurviewBusinessDomain[]> {
  purviewAccount();
  const res = await purviewFetch('/datagovernance/catalog/businessdomains');
  if (res.status === 404) return [];
  const j = await readJson<{ value?: any[] }>(res);
  return (j?.value || []).map((raw): PurviewBusinessDomain => ({
    id: raw?.id,
    name: raw?.name || raw?.displayName,
    description: raw?.description,
    type: raw?.type,
    raw,
  }));
}

/** POST /datagovernance/catalog/businessdomains — create a domain. */
export async function createBusinessDomain(payload: {
  name: string;
  description?: string;
  type?: string;
}): Promise<PurviewBusinessDomain> {
  purviewAccount();
  if (!payload?.name) throw new PurviewError(400, null, 'name is required');
  const body = {
    name: payload.name,
    displayName: payload.name,
    description: payload.description || '',
    type: payload.type || 'Functional',
  };
  const res = await purviewFetch('/datagovernance/catalog/businessdomains', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const raw = await readJson<any>(res);
  if (!raw) throw new PurviewError(500, null, 'Purview returned empty body on createBusinessDomain');
  return {
    id: raw?.id,
    name: raw?.name || raw?.displayName,
    description: raw?.description,
    type: raw?.type,
    raw,
  };
}

/** GET /datagovernance/dataquality/rules — list configured DQ rules (preview). */
export async function listDataQualityRules(): Promise<PurviewDataQualityRule[]> {
  purviewAccount();
  // Endpoint is still in preview; some Purview tenants 404 this entirely.
  // Treat 404 as "no rules / preview not enabled" rather than an error.
  const res = await purviewFetch('/datagovernance/dataquality/rules');
  if (res.status === 404) return [];
  const j = await readJson<{ value?: any[] }>(res);
  return (j?.value || []).map((raw): PurviewDataQualityRule => ({
    id: raw?.id,
    name: raw?.name || raw?.displayName,
    description: raw?.description,
    expression: raw?.expression || raw?.ruleExpression,
    scope: raw?.scope || raw?.target,
    enabled: raw?.enabled,
    raw,
  }));
}
