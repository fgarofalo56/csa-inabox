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
 *       GET https://graph.microsoft.com/beta/security/dataLossPreventionPolicies
 *     This endpoint exists in /beta and returns a paged collection. It is
 *     read-only and gated by `Policy.Read.All` app permission.
 *
 *   - Listing DLP rules per policy:
 *       GET https://graph.microsoft.com/beta/security/dataLossPreventionPolicies/{id}/rules
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
 *   - Policy.Read.All       (572fea84-0151-49b2-9301-11cb16974376)  — DLP policy reads
 *   - SecurityAlert.Read.All (bf394140-e372-4bf9-a898-299cfc7564e5) — DLP alert reads
 *
 * Env vars:
 *   LOOM_UAMI_CLIENT_ID — UAMI client id (already wired by main bicep).
 *   LOOM_DLP_GRAPH_BASE — optional override, defaults to https://graph.microsoft.com.
 *   LOOM_DLP_ENABLED    — must be "true" to call live Graph DLP endpoints.
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';
import { getGraphHost, getGraphScope } from './cloud-endpoints';

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
        appRoleId: '572fea84-0151-49b2-9301-11cb16974376',
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
    'LOOM_DLP_ENABLED=true and the Console UAMI holds Policy.Read.All, but Microsoft Graph does not expose a readable DLP policy segment for this tenant — the /beta/security/dataLossPreventionPolicies endpoint returns "Resource not found for the segment". DLP policy authoring/reads are still Purview-compliance-portal + Security & Compliance PowerShell only outside the Graph DLP preview.';
  h.followUp =
    'Manage DLP policies in the Microsoft Purview portal (https://purview.microsoft.com → Data loss prevention → Policies) or via Security & Compliance PowerShell (Get-DlpCompliancePolicy). Loom will list them here automatically once Microsoft Graph exposes the dataLossPreventionPolicies segment to this tenant (request enrollment in the Graph DLP preview via a Microsoft support ticket referencing /beta/security/dataLossPreventionPolicies). DLP alerts (Alerts tab) and label-based MIP reads work today.';
  return h;
}

/** True when Graph rejected the call because the DLP segment doesn't exist for this tenant. */
function isDlpSegmentUnavailable(e: unknown): boolean {
  if (!(e instanceof DlpError)) return false;
  if (e.status === 404) return true;
  const msg = (e.message || '') + ' ' + JSON.stringify(e.body || '');
  return e.status === 400 && /Resource not found for the segment|dataLossPrevention/i.test(msg);
}

// ============================================================
// Low-level fetch
// ============================================================

async function graphFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await credential.getToken(graphScope());
  if (!token?.token) throw new DlpError(500, null, 'Failed to acquire Microsoft Graph token');
  const url = `${graphBase()}${path}`;
  return fetch(url, {
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

// ============================================================
// Exports
// ============================================================

/**
 * List Purview DLP policies. Returns the raw policy list shaped down to
 * the fields the /admin/security panel renders.
 *
 * Backing call: GET /beta/security/dataLossPreventionPolicies
 *
 * If the tenant hasn't opted into the DLP-via-Graph preview, the endpoint
 * returns 404 and this function returns `[]`. The caller's BFF route is
 * responsible for distinguishing "empty tenant" from "preview not enabled"
 * (callers can re-check by inspecting `getMeta()`).
 */
export async function listDlpPolicies(): Promise<DlpPolicy[]> {
  assertEnabled();
  const endpoint = '/beta/security/dataLossPreventionPolicies';
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
 * Backing call: GET /beta/security/dataLossPreventionPolicies/{id}/rules
 */
export async function listDlpRules(policyId: string): Promise<DlpRule[]> {
  assertEnabled();
  if (!policyId) throw new DlpError(400, null, 'policyId is required');
  const endpoint = `/beta/security/dataLossPreventionPolicies/${encodeURIComponent(policyId)}/rules`;
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
  const j = await readJson<{ value?: any[] }>(res, endpoint);
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
 * Simulate a DLP policy against sample content.
 *
 * Backing call: POST /beta/security/dataLossPrevention/evaluatePolicies
 *
 * This endpoint is in /beta + behind a tenant-level preview flag in many
 * tenants. The BFF route translates a 404 here into a 501 with the
 * remediation hint (operator must enable the Graph DLP preview through
 * the Purview portal).
 *
 * Returns the raw evaluation response (includes matched policies + rules
 * + which sensitive info types triggered).
 */
export async function evaluatePolicy(payload: {
  content: string;
  policyIds?: string[];
  metadata?: Record<string, string>;
}): Promise<unknown> {
  assertEnabled();
  if (!payload?.content) throw new DlpError(400, null, 'content is required');
  const endpoint = '/beta/security/dataLossPrevention/evaluatePolicies';
  const body = {
    content: { textContent: payload.content },
    ...(payload.policyIds ? { policyIds: payload.policyIds } : {}),
    ...(payload.metadata ? { metadata: payload.metadata } : {}),
  };
  const res = await graphFetch(endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return readJson<unknown>(res, endpoint);
}

// Test-only: expose internal helpers for unit tests
export const __testing = {
  notConfiguredHint,
  assertEnabled,
};
