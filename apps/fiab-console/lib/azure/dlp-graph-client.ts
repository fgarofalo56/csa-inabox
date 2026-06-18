/**
 * Microsoft Purview Data Loss Prevention (DLP) — Graph client.
 *
 * Provides read access to Purview DLP policies and recent DLP-source alerts
 * via Microsoft Graph. Auth follows the same UAMI ChainedTokenCredential
 * pattern as mip-graph-client.ts / purview-client.ts.
 *
 * IMPORTANT — endpoint reality check (2026-05):
 *   The "manage Purview DLP policies via Graph" surface area is partially
 *   in beta + partially still PowerShell-only. Specifically:
 *
 *   - Listing DLP policies via Graph:
 *       GET https://graph.microsoft.com/beta/informationProtection/dataLossPreventionPolicies
 *     This is the `dataLossPreventionPolicies` navigation property under
 *     `informationProtection` (backing cmdlet
 *     Get-MgBetaInformationProtectionDataLossPreventionPolicy, module
 *     Microsoft.Graph.Beta.Identity.SignIns). It exists in /beta and returns a
 *     paged collection. It is read-only and gated by `Policy.Read.All`.
 *     (The older `security/dataLossPreventionPolicies` path returned
 *     "Resource not found for the segment" — it was never a real Graph route.)
 *
 *   - Listing DLP rules per policy:
 *       GET https://graph.microsoft.com/beta/informationProtection/dataLossPreventionPolicies/{id}/policyRules
 *     Also read-only on /beta.
 *
 *   - Recent DLP alerts:
 *       GET https://graph.microsoft.com/v1.0/security/alerts_v2
 *       ?$filter=detectionSource eq 'microsoftDataLossPrevention'
 *     Standard v1.0 surface. Requires `SecurityAlert.Read.All`.
 *
 *   - Policy simulation:
 *       POST https://graph.microsoft.com/beta/security/dataLossPrevention/evaluatePolicies
 *     Not GA yet. Some tenants do not have this endpoint exposed at all —
 *     we surface a structured 503 + remediation, rather than fake the
 *     response.
 *
 * App permissions required (granted via post-deploy bootstrap):
 *   - Policy.Read.All       (246dd0d5-5bd0-4def-940b-0421030a5b68)  — DLP policy reads
 *   - SecurityAlert.Read.All (bf394140-e372-4bf9-a898-299cfc7564e5) — DLP alert reads
 *
 * National clouds (per cloud-endpoints.graphBase()): Commercial/GCC use
 * graph.microsoft.com; GCC-High uses graph.microsoft.us; IL5/DoD uses
 * dod-graph.microsoft.us. The /beta DLP *policy* segment is NOT exposed in the
 * Gov Graph roots (graphDlpPolicyApiAvailable() === false) — listDlpPolicies()
 * surfaces an honest gate there, while DLP alerts/violations (alerts_v2) and
 * restrict-access RBAC still work in every cloud.
 *
 * Env vars:
 *   LOOM_UAMI_CLIENT_ID — UAMI client id (already wired by main bicep).
 *   LOOM_DLP_GRAPH_BASE — optional override (else cloud-aware graphBase()).
 *   LOOM_DLP_ENABLED    — must be "true" to call live Graph DLP endpoints.
 *   LOOM_CLOUD_BOUNDARY — Commercial / GCC / GCC-High / IL5 (drives the gate).
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import {
  getGraphHost,
  getGraphScope,
  graphDlpPolicyApiAvailable,
  cloudBoundaryLabel,
} from './cloud-endpoints';

/**
 * Graph host + AAD scope are resolved at CALL time (not import time) so the
 * sovereign-cloud signal (`LOOM_CLOUD` / `AZURE_CLOUD`) is honoured even when
 * env is mutated after module load (e.g. vitest). `LOOM_DLP_GRAPH_BASE`
 * overrides the host outright for private-link / unenumerated clouds.
 */
function graphBase(): string {
  return process.env.LOOM_DLP_GRAPH_BASE || getGraphHost();
}
function graphScope(): string {
  return getGraphScope();
}

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: TokenCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

// ============================================================
// Errors
// ============================================================

export interface DlpNotConfiguredHint {
  missingEnvVar: string;
  bicepModule: string;
  bicepStatus: string;
  rolesRequired: { name: string; appRoleId: string; scope: string; reason: string }[];
  followUp: string;
}

export class DlpNotConfiguredError extends Error {
  hint: DlpNotConfiguredHint;
  constructor(hint: DlpNotConfiguredHint) {
    super(`Microsoft DLP is not wired in this deployment: missing ${hint.missingEnvVar}`);
    this.hint = hint;
  }
}

export class DlpError extends Error {
  status: number;
  body: unknown;
  endpoint?: string;
  constructor(status: number, body: unknown, message?: string, endpoint?: string) {
    super(message || `Microsoft Graph DLP call failed (${status})`);
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

function notConfiguredHint(missing: string): DlpNotConfiguredHint {
  return {
    missingEnvVar: missing,
    bicepModule: 'platform/fiab/bicep/modules/admin-plane/main.bicep',
    bicepStatus: 'Wire LOOM_DLP_ENABLED=true into apps[].env in admin-plane/main.bicep. The same Container App env block already supports LOOM_MIP_ENABLED — add LOOM_DLP_ENABLED as a sibling.',
    rolesRequired: [
      {
        name: 'Policy.Read.All',
        appRoleId: '246dd0d5-5bd0-4def-940b-0421030a5b68',
        scope: 'Microsoft Graph (app permission, admin-consented)',
        reason: 'Required to list Purview DLP policies + per-policy rules.',
      },
      {
        name: 'SecurityAlert.Read.All',
        appRoleId: 'bf394140-e372-4bf9-a898-299cfc7564e5',
        scope: 'Microsoft Graph (app permission, admin-consented)',
        reason: 'Required to surface recent DLP alerts under the Alerts tab.',
      },
    ],
    followUp: 'Operator action: (1) set LOOM_DLP_ENABLED=true on the loom-console Container App, (2) run scripts/csa-loom/grant-graph-approles.sh — it grants both AppRoles to the Console UAMI in one shot, (3) Tenant Admin issues admin consent at https://portal.azure.com → Entra ID → Enterprise applications → Console UAMI → Permissions. Note: the policy simulation endpoint is /beta-only and may return 404 in tenants that haven\'t opted into the Graph DLP preview — the BFF route surfaces that gap explicitly instead of faking results.',
  };
}

function assertEnabled() {
  if (process.env.LOOM_DLP_ENABLED !== 'true') {
    throw new DlpNotConfiguredError(notConfiguredHint('LOOM_DLP_ENABLED'));
  }
}

/**
 * Honest gate for the (common) case where Microsoft Graph does not expose a
 * DLP policy/rules segment for this tenant + Graph version. Live tenants
 * return HTTP 400 "Resource not found for the segment
 * 'dataLossPreventionPolicies'" (NOT a 404), because the `dataLossPrevention`
 * read surface is still PowerShell/Purview-portal-only outside the preview.
 * We surface this as a configured-but-unavailable gate naming the exact
 * operator action, instead of leaking a raw 400 or faking an empty list.
 */
function graphDlpUnavailableHint(): DlpNotConfiguredHint {
  const h = notConfiguredHint('LOOM_DLP_ENABLED');
  h.bicepStatus =
    'LOOM_DLP_ENABLED=true and the Console UAMI holds Policy.Read.All, but Microsoft Graph does not expose a readable DLP policy segment for this tenant — the /beta/informationProtection/dataLossPreventionPolicies endpoint returns "Resource not found for the segment". DLP policy authoring/reads are still Purview-compliance-portal + Security & Compliance PowerShell only outside the Graph DLP preview.';
  h.followUp =
    'Manage DLP policies in the Microsoft Purview portal (https://purview.microsoft.com → Data loss prevention → Policies) or via Security & Compliance PowerShell (Get-DlpCompliancePolicy). Loom will list them here automatically once Microsoft Graph exposes the dataLossPreventionPolicies segment to this tenant (request enrollment in the Graph DLP preview via a Microsoft support ticket referencing /beta/informationProtection/dataLossPreventionPolicies). DLP alerts (Alerts tab), the Restrict-access tab, and label-based MIP reads work today.';
  return h;
}

/**
 * Honest gate for US Government / DoD clouds, where Microsoft Graph's
 * /beta DLP *policy* segment is not exposed at all (graph.microsoft.us /
 * dod-graph.microsoft.us). DLP alerts/violations (alerts_v2) and
 * restrict-access RBAC still function — only policy authoring/reads route
 * through the Purview compliance portal in these clouds.
 */
function graphDlpGovUnavailableHint(): DlpNotConfiguredHint {
  const label = cloudBoundaryLabel();
  const h = notConfiguredHint('LOOM_DLP_ENABLED');
  h.bicepStatus =
    `LOOM_DLP_ENABLED=true, but this deployment runs in ${label}. Microsoft Graph's ` +
    '/beta/informationProtection/dataLossPreventionPolicies segment is not available in the US ' +
    'Government (graph.microsoft.us) or DoD (dod-graph.microsoft.us) roots as of 2026. ' +
    'DLP violations (alerts_v2) and restrict-access enforcement remain fully operational.';
  h.followUp =
    `Manage DLP policies for ${label} in the Microsoft Purview compliance portal ` +
    '(https://compliance.microsoft.us → Data loss prevention → Policies) or via ' +
    'Security & Compliance PowerShell (Get-DlpCompliancePolicy). Violations and ' +
    'restrict-access continue to work in this console.';
  return h;
}

/** True when Graph rejected the call because the DLP segment doesn't exist for this tenant. */
function isDlpSegmentUnavailable(e: unknown): boolean {  if (!(e instanceof DlpError)) return false;
  if (e.status === 404) return true;
  const msg = (e.message || '') + ' ' + JSON.stringify(e.body || '');
  return e.status === 400 && /Resource not found for the segment|dataLossPrevention/i.test(msg);
}

/**
 * Honest gate for the Graph Security app-role gap on the alerts_v2 path. When
 * the Console UAMI holds LOOM_DLP_ENABLED but the SecurityAlert.Read.All /
 * SecurityIncident.Read.All AppRoles are NOT granted+consented, Graph rejects
 * /v1.0/security/alerts_v2 with 401/403 and a body that reads
 * "Missing application roles: SecurityAlert.Read.All, SecurityAlert.ReadWrite.All,
 *  SecurityIncident.Read.All, SecurityIncident.ReadWrite.All". We surface that as
 * a configured-but-unconsented gate naming the exact roles + the bootstrap step
 * that grants them, instead of leaking the raw 403 as "Could not load violations".
 */
function graphSecurityRoleHint(status: number): DlpNotConfiguredHint {
  const h = notConfiguredHint('LOOM_DLP_ENABLED');
  h.rolesRequired = [
    {
      name: 'SecurityAlert.Read.All',
      appRoleId: 'bf394140-e372-4bf9-a898-299cfc7564e5',
      scope: 'Microsoft Graph (app permission, admin-consented)',
      reason: 'Required to read DLP alerts/violations via /v1.0/security/alerts_v2.',
    },
    {
      name: 'SecurityIncident.Read.All',
      appRoleId: '45cc0394-e837-488b-a098-1918f48d186c',
      scope: 'Microsoft Graph (app permission, admin-consented)',
      reason: 'Graph names this role alongside SecurityAlert on the alerts_v2 403; both are needed to clear the gate.',
    },
  ];
  h.bicepStatus =
    `LOOM_DLP_ENABLED=true, but Microsoft Graph answered ${status} on /v1.0/security/alerts_v2 — ` +
    'the Console UAMI is missing the Graph Security application roles SecurityAlert.Read.All and ' +
    'SecurityIncident.Read.All (or admin consent has not been issued for them).';
  h.followUp =
    'Run scripts/csa-loom/grant-graph-approles.sh (the csa-loom-post-deploy-bootstrap "Grant MIP+DLP Graph AppRoles" step grants both roles), ' +
    'then have a Tenant Administrator click Entra ID → Enterprise applications → Console UAMI → Permissions → ' +
    '"Grant admin consent for <tenant>". DLP violations load automatically once consent lands. Read-only roles ' +
    '(Read.All) are sufficient — the panel performs no write/remediation against Graph Security.';
  return h;
}

/** True when a Graph alerts_v2 error is an authorization/role-consent failure. */
function isGraphSecurityRoleMissing(e: unknown): boolean {
  if (!(e instanceof DlpError)) return false;
  if (e.status !== 401 && e.status !== 403) return false;
  const msg = (e.message || '') + ' ' + JSON.stringify(e.body || '');
  return /Missing application roles|SecurityAlert|SecurityIncident|Authorization_RequestDenied|insufficient privileges/i.test(msg);
}

// ============================================================
// Low-level fetch
// ============================================================

async function graphFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await credential.getToken(graphScope());
  if (!token?.token) throw new DlpError(500, null, 'Failed to acquire Microsoft Graph token');
  const url = `${graphBase()}${path}`;
  return fetchWithTimeout(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      authorization: `Bearer ${token.token}`,
      'content-type': 'application/json',
      'user-agent': 'CSA-Loom-Console/1.0',
    },
  });
}

async function readJson<T>(res: Response, endpoint: string): Promise<T | null> {
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
      (typeof parsed === 'string' ? parsed : `Microsoft Graph DLP ${res.status}`);
    throw new DlpError(res.status, parsed, msg, endpoint);
  }
  return (parsed as T) ?? ({} as T);
}

// ============================================================
// Types
// ============================================================

export interface DlpPolicy {
  id: string;
  name?: string;
  displayName?: string;
  description?: string;
  mode?: string;
  status?: string;
  locations?: string[];
  ruleCount?: number;
  lastModifiedDateTime?: string;
  raw?: unknown;
}

export interface DlpRule {
  id: string;
  name?: string;
  description?: string;
  priority?: number;
  isEnabled?: boolean;
  conditions?: unknown;
  actions?: unknown;
  exceptions?: unknown;
  raw?: unknown;
}

export interface DlpAlert {
  id: string;
  title?: string;
  severity?: string;
  status?: string;
  createdDateTime?: string;
  detectionSource?: string;
  category?: string;
  description?: string;
  raw?: unknown;
}

/**
 * A per-item DLP violation, shaped from a Graph security alert. The richer
 * fields (item path/type, policy, user) are extracted best-effort from the
 * alert's `evidence[]` + `additionalData` — Graph's alerts_v2 DLP evidence
 * schema is loosely documented, so any field may be undefined. We never
 * fabricate: an undefined field is simply omitted.
 */
export interface DlpViolation {
  alertId: string;
  policyId?: string;
  policyName?: string;
  ruleName?: string;
  severity?: string;
  status?: string;
  user?: string;
  itemPath?: string;
  itemType?: string;
  workload?: string;
  action?: string;
  detectedAt?: string;
  raw?: unknown;
}

/** Honest, structured status of the Purview Information Protection scanner. */
export interface DlpScanStatus {
  available: false;
  reason: string;
  portalLink: string;
  powershellCmd: string;
}

// ============================================================
// Exports
// ============================================================

/**
 * List Purview DLP policies. Returns the raw policy list shaped down to
 * the fields the /admin/security panel renders.
 *
 * Backing call: GET /beta/informationProtection/dataLossPreventionPolicies
 *
 * If the tenant hasn't opted into the DLP-via-Graph preview, the endpoint
 * returns 404 / 400 "Resource not found for the segment" and this function
 * surfaces an honest configured-but-unavailable gate (graphDlpUnavailableHint).
 */
export async function listDlpPolicies(): Promise<DlpPolicy[]> {
  assertEnabled();
  // Gov/DoD Graph roots don't expose the /beta DLP policy segment — gate
  // honestly before even calling Graph (alerts/violations still work).
  if (!graphDlpPolicyApiAvailable()) throw new DlpNotConfiguredError(graphDlpGovUnavailableHint());
  const endpoint = '/beta/informationProtection/dataLossPreventionPolicies';
  const res = await graphFetch(endpoint);
  if (res.status === 404) throw new DlpNotConfiguredError(graphDlpUnavailableHint());
  let j: { value?: any[] } | null;
  try {
    j = await readJson<{ value?: any[] }>(res, endpoint);
  } catch (e) {
    if (isDlpSegmentUnavailable(e)) throw new DlpNotConfiguredError(graphDlpUnavailableHint());
    throw e;
  }
  return (j?.value || []).map((raw): DlpPolicy => ({
    id: raw?.id,
    name: raw?.name || raw?.displayName,
    displayName: raw?.displayName,
    description: raw?.description,
    mode: raw?.mode,
    status: raw?.status,
    locations: Array.isArray(raw?.locations) ? raw.locations : undefined,
    ruleCount: Array.isArray(raw?.rules) ? raw.rules.length : raw?.ruleCount,
    lastModifiedDateTime: raw?.lastModifiedDateTime,
    raw,
  }));
}

/**
 * List rules attached to a given DLP policy.
 *
 * Backing call: GET /beta/informationProtection/dataLossPreventionPolicies/{id}/policyRules
 */
export async function listDlpRules(policyId: string): Promise<DlpRule[]> {
  assertEnabled();
  if (!graphDlpPolicyApiAvailable()) throw new DlpNotConfiguredError(graphDlpGovUnavailableHint());
  if (!policyId) throw new DlpError(400, null, 'policyId is required');
  const endpoint = `/beta/informationProtection/dataLossPreventionPolicies/${encodeURIComponent(policyId)}/policyRules`;
  const res = await graphFetch(endpoint);
  if (res.status === 404) throw new DlpNotConfiguredError(graphDlpUnavailableHint());
  let j: { value?: any[] } | null;
  try {
    j = await readJson<{ value?: any[] }>(res, endpoint);
  } catch (e) {
    if (isDlpSegmentUnavailable(e)) throw new DlpNotConfiguredError(graphDlpUnavailableHint());
    throw e;
  }
  return (j?.value || []).map((raw): DlpRule => ({
    id: raw?.id,
    name: raw?.name || raw?.displayName,
    description: raw?.description,
    priority: raw?.priority,
    isEnabled: raw?.isEnabled,
    conditions: raw?.conditions,
    actions: raw?.actions,
    exceptions: raw?.exceptions,
    raw,
  }));
}

/**
 * List recent DLP alerts (last 30 days by default).
 *
 * Backing call: GET /v1.0/security/alerts_v2 with detectionSource filter.
 * Falls back to /beta if v1.0 isn't available for the tenant.
 */
export async function listDlpAlerts(opts: { top?: number; sinceIso?: string } = {}): Promise<DlpAlert[]> {
  assertEnabled();
  const top = Math.min(100, Math.max(1, opts.top || 25));
  const since = opts.sinceIso || new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  const filter = `(detectionSource eq 'microsoftDataLossPrevention' or category eq 'DataLossPrevention') and createdDateTime ge ${since}`;
  const qs = new URLSearchParams({ $top: String(top), $filter: filter, $orderby: 'createdDateTime desc' });
  const endpoint = `/v1.0/security/alerts_v2?${qs.toString()}`;
  const res = await graphFetch(endpoint);
  let j: { value?: any[] } | null;
  try {
    j = await readJson<{ value?: any[] }>(res, endpoint);
  } catch (e) {
    if (isGraphSecurityRoleMissing(e)) {
      throw new DlpNotConfiguredError(graphSecurityRoleHint((e as DlpError).status));
    }
    throw e;
  }
  return (j?.value || []).map((raw): DlpAlert => ({
    id: raw?.id,
    title: raw?.title,
    severity: raw?.severity,
    status: raw?.status,
    createdDateTime: raw?.createdDateTime,
    detectionSource: raw?.detectionSource,
    category: raw?.category,
    description: raw?.description,
    raw,
  }));
}

/**
 * List per-item DLP violations (last 30 days by default).
 *
 * Backing call: GET /v1.0/security/alerts_v2 (same surface as listDlpAlerts),
 * but each raw alert is parsed into a per-item violation shape — extracting
 * item path/type, policy, user, and action from the alert evidence/additional
 * data. Works in every cloud (alerts_v2 is GA on graph.microsoft.us /
 * dod-graph.microsoft.us). When `policyId` is supplied, results are filtered
 * to violations whose extracted policyId matches (best-effort).
 */
export async function listDlpViolations(
  opts: { top?: number; sinceIso?: string; policyId?: string } = {},
): Promise<DlpViolation[]> {
  assertEnabled();
  const top = Math.min(200, Math.max(1, opts.top || 50));
  const since = opts.sinceIso || new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  const filter = `(detectionSource eq 'microsoftDataLossPrevention' or category eq 'DataLossPrevention') and createdDateTime ge ${since}`;
  // NOTE (audit B12): do NOT request $expand=evidence — alerts_v2 rejects it with
  // HTTP 400 "invalid $expand". Evidence is already returned inline on each alert
  // (raw.evidence[]), so the per-item extraction below works without the expand.
  const qs = new URLSearchParams({
    $top: String(top),
    $filter: filter,
    $orderby: 'createdDateTime desc',
  });
  const endpoint = `/v1.0/security/alerts_v2?${qs.toString()}`;
  const res = await graphFetch(endpoint);
  let j: { value?: any[] } | null;
  try {
    j = await readJson<{ value?: any[] }>(res, endpoint);
  } catch (e) {
    if (isGraphSecurityRoleMissing(e)) {
      throw new DlpNotConfiguredError(graphSecurityRoleHint((e as DlpError).status));
    }
    throw e;
  }
  const out = (j?.value || []).map((raw): DlpViolation => {
    const ev: any[] = Array.isArray(raw?.evidences) ? raw.evidences : (Array.isArray(raw?.evidence) ? raw.evidence : []);
    const add = raw?.additionalData || raw?.additionalDetails || {};
    // Best-effort field extraction — only real values, never synthesized.
    let itemPath: string | undefined;
    let itemType: string | undefined;
    let user: string | undefined;
    for (const e of ev) {
      itemPath = itemPath || e?.filePath || e?.fileName || e?.url || e?.messageUri || e?.subject;
      if (!itemType && typeof e?.['@odata.type'] === 'string') {
        itemType = String(e['@odata.type']).split('.').pop()?.replace(/Evidence$/, '') || undefined;
      }
      user = user || e?.userAccount?.userPrincipalName || e?.userAccount?.displayName || e?.recipient;
    }
    const policyName = add?.policyName || add?.PolicyName ||
      // Some DLP alert titles read "DLP policy '<name>' matched…"
      (typeof raw?.title === 'string' ? (raw.title.match(/['"]([^'"]+)['"]/)?.[1]) : undefined);
    return {
      alertId: raw?.id,
      policyId: add?.policyId || add?.PolicyId,
      policyName,
      ruleName: add?.ruleName || add?.RuleName,
      severity: raw?.severity,
      status: raw?.status,
      user: user || raw?.actorDisplayName,
      itemPath,
      itemType,
      workload: add?.workload || raw?.serviceSource,
      action: add?.dlpAction || add?.action,
      detectedAt: raw?.createdDateTime,
      raw,
    };
  });
  const wantPolicy = (opts.policyId || '').trim();
  return wantPolicy ? out.filter((v) => v.policyId && v.policyId === wantPolicy) : out;
}

/**
 * Honest gate: the Purview Information Protection scanner exposes its status
 * only through the `Get-ScanStatus` cmdlet (PurviewInformationProtection
 * PowerShell module) / internal portal REST. No public Microsoft Graph REST
 * endpoint returns scanner status, so we return a structured, non-faked gate
 * rather than invent a timestamp.
 */
export async function getScanStatus(): Promise<DlpScanStatus> {
  assertEnabled();
  return {
    available: false,
    reason:
      'Purview Information Protection scanner status is only available via Get-ScanStatus ' +
      '(PurviewInformationProtection PowerShell module) or the Purview portal. No Microsoft ' +
      'Graph REST endpoint exposes scanner status. Loom records the timestamp of operator-' +
      'triggered violation refreshes as "last checked" instead.',
    portalLink: 'https://purview.microsoft.com/informationprotection/scanner/contentscanjobs',
    powershellCmd: 'Get-ScanStatus',
  };
}

/**
 * Honest gate: there is no public Microsoft Graph REST API to trigger the
 * Purview Information Protection scanner. The only real mechanisms are the
 * `Start-Scan` cmdlet or the Purview portal "Scan now" action. We throw a
 * typed 501 DlpError carrying the remediation so the BFF route surfaces a
 * MessageBar with a direct portal link (no faked "scan started" response).
 */
export async function triggerScan(): Promise<never> {
  assertEnabled();
  throw new DlpError(
    501,
    {
      portalLink: 'https://purview.microsoft.com/informationprotection/scanner/contentscanjobs',
      powershellCmd: 'Start-Scan',
    },
    'No Microsoft Graph REST API exists to trigger the Purview Information Protection scanner. ' +
      'Run Start-Scan (PurviewInformationProtection module) or use the Purview portal ' +
      '(Information protection → Scanner → Content scan jobs → Scan now).',
    'triggerScan',
  );
}

/**
 * Simulate a DLP policy against sample content.
 *
 * HONEST GATE (audit B12): there is NO public Microsoft Graph REST endpoint for
 * DLP policy simulation. The previously-coded
 * `POST /beta/security/dataLossPrevention/evaluatePolicies` does not exist —
 * live tenants reject it with HTTP 400 "Resource not found for the segment
 * 'dataLossPrevention'". Rather than call a non-existent segment (and leak a raw
 * 400) or fake an evaluation, this throws a typed 501 DlpError carrying the only
 * real mechanisms (the Purview portal "Test policy" action / Security &
 * Compliance PowerShell). The BFF route renders that as an honest MessageBar.
 *
 * If/when Microsoft ships a GA Graph simulate endpoint, repoint this to it.
 */
export async function evaluatePolicy(payload: {
  content: string;
  policyIds?: string[];
  metadata?: Record<string, string>;
}): Promise<never> {
  assertEnabled();
  if (!payload?.content) throw new DlpError(400, null, 'content is required');
  throw new DlpError(
    501,
    {
      portalLink: 'https://purview.microsoft.com',
      powershellCmd: 'Test-DlpPolicies',
    },
    'No public Microsoft Graph REST API exists to simulate Purview DLP policies. ' +
      'Test a policy in the Microsoft Purview portal (Data loss prevention → Policies → "Test policy") ' +
      'or via Security & Compliance PowerShell. Loom does not fabricate simulation results.',
    'evaluatePolicy',
  );
}

// Test-only: expose internal helpers for unit tests
export const __testing = {
  notConfiguredHint,
  assertEnabled,
};
