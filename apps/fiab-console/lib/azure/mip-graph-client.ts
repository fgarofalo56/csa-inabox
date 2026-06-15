/**
 * Microsoft Information Protection (MIP) — Graph client.
 *
 * Provides read access to sensitivity labels and label policies via
 * Microsoft Graph. Token acquisition uses the Console UAMI via
 * ChainedTokenCredential (same pattern as purview-client.ts):
 *   1. ManagedIdentityCredential({ clientId: LOOM_UAMI_CLIENT_ID }) — prod path
 *   2. DefaultAzureCredential — local dev / az login fallback
 *
 * Backing endpoints (Microsoft Graph beta — these endpoints are still in
 * /beta because v1.0 only ships the read-only `dataSecurityAndGovernance`
 * surface; tenant-scope label management lives under /beta until further
 * notice):
 *
 *   GET  https://graph.microsoft.com/beta/security/informationProtection/sensitivityLabels
 *   GET  https://graph.microsoft.com/beta/security/informationProtection/sensitivityLabels/{id}
 *   POST https://graph.microsoft.com/beta/security/informationProtection/sensitivityLabels/evaluateApplication
 *
 * NOTE on label POLICIES and label CRUD: Microsoft Graph exposes NO app-only
 * (UAMI) surface to read or manage tenant label *policies* at all, and only a
 * thin, low-fidelity create surface for label *definitions* — under the
 * separate `/beta/security/dataSecurityAndGovernance/sensitivityLabels`
 * navigation property (New-MgBetaSecurityDataSecurityAndGovernanceSensitivityLabel).
 * That Graph create path cannot publish a label policy, cannot scope a label
 * to workloads, and does not expose the full color/encryption/marking fidelity
 * the admin surface needs, so Loom does NOT use it. The previous implementation
 * called `GET /beta/security/informationProtection/policy/labels` — that path
 * does NOT exist app-only and returned HTTP 400. Full label + policy lifecycle
 * lives in Security & Compliance PowerShell (New-Label / Set-Label /
 * Remove-Label, New-LabelPolicy / Set-LabelPolicy / Remove-LabelPolicy). Those
 * flows are handled by the SCC PowerShell sidecar — see `scc-labels-client.ts`.
 * This client owns only the Graph-backed READ of label definitions (under
 * `informationProtection/sensitivityLabels`) plus the evaluate (recommendation)
 * call.
 *
 * App permissions (admin-consent required, granted in post-deploy bootstrap):
 *   - InformationProtectionPolicy.Read.All  (19da66cb-0fb0-4390-b071-ebc76a349482)
 *   - SensitivityLabel.Evaluate              (57f0b71b-a759-45a0-9a0f-cc099fbd9a44)
 *
 * Env vars:
 *   LOOM_UAMI_CLIENT_ID — UAMI client id (already wired by main bicep).
 *   LOOM_MIP_GRAPH_BASE — optional override, defaults to https://graph.microsoft.com.
 *   LOOM_MIP_ENABLED    — must be "true" to call live Graph. When unset, the
 *                          BFF should surface the "not configured" hint so
 *                          operators see the exact env var + AppRole grant
 *                          needed to unblock.
 *
 * Errors:
 *   - MipNotConfiguredError (status 503) — env not set; carries hint with
 *     remediation steps (env var, AppRole grant, link to bootstrap script).
 *   - MipError (status N)   — Graph returned non-2xx (typically 403 when
 *     the AppRole grant is missing).
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
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
 * env is mutated after module load (e.g. vitest). `LOOM_MIP_GRAPH_BASE`
 * overrides the host outright for private-link / unenumerated clouds.
 */
function graphBase(): string {
  return process.env.LOOM_MIP_GRAPH_BASE || getGraphHost();
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

export interface MipNotConfiguredHint {
  missingEnvVar: string;
  bicepModule: string;
  bicepStatus: string;
  rolesRequired: { name: string; appRoleId: string; scope: string; reason: string }[];
  followUp: string;
}

export class MipNotConfiguredError extends Error {
  hint: MipNotConfiguredHint;
  constructor(hint: MipNotConfiguredHint) {
    super(`Microsoft Information Protection is not wired in this deployment: missing ${hint.missingEnvVar}`);
    this.hint = hint;
  }
}

export class MipError extends Error {
  status: number;
  body: unknown;
  endpoint?: string;
  constructor(status: number, body: unknown, message?: string, endpoint?: string) {
    super(message || `Microsoft Graph MIP call failed (${status})`);
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

function notConfiguredHint(missing: string): MipNotConfiguredHint {
  return {
    missingEnvVar: missing,
    bicepModule: 'platform/fiab/bicep/modules/admin-plane/main.bicep',
    bicepStatus: `Wire LOOM_MIP_ENABLED=true into apps[].env in admin-plane/main.bicep alongside the existing LOOM_UAMI_CLIENT_ID. The Container App env block already supports it once added.`,
    rolesRequired: [
      {
        name: 'InformationProtectionPolicy.Read.All',
        appRoleId: '19da66cb-0fb0-4390-b071-ebc76a349482',
        scope: 'Microsoft Graph (app permission, admin-consented)',
        reason: 'Required to list tenant-wide sensitivity labels and label policies.',
      },
      {
        name: 'SensitivityLabel.Evaluate',
        appRoleId: '57f0b71b-a759-45a0-9a0f-cc099fbd9a44',
        scope: 'Microsoft Graph (app permission, admin-consented)',
        reason: 'Required for the "apply label to a Loom item" action.',
      },
    ],
    followUp: 'Operator action: (1) set LOOM_MIP_ENABLED=true on the loom-console Container App, (2) run scripts/csa-loom/grant-graph-approles.sh (or the post-deploy-bootstrap.yml job "Grant MIP+DLP Graph AppRoles") to grant the Console UAMI both Graph AppRoles, (3) Tenant Admin issues admin consent at https://portal.azure.com → Entra ID → Enterprise applications → Console UAMI → Permissions. Until consented, every call returns 403.',
  };
}

function assertEnabled() {
  if (process.env.LOOM_MIP_ENABLED !== 'true') {
    throw new MipNotConfiguredError(notConfiguredHint('LOOM_MIP_ENABLED'));
  }
}

// ============================================================
// Low-level fetch
// ============================================================

async function graphFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await credential.getToken(graphScope());
  if (!token?.token) throw new MipError(500, null, 'Failed to acquire Microsoft Graph token');
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
      (typeof parsed === 'string' ? parsed : `Microsoft Graph ${res.status}`);
    throw new MipError(res.status, parsed, msg, endpoint);
  }
  return (parsed as T) ?? ({} as T);
}

// ============================================================
// Types
// ============================================================

export interface SensitivityLabel {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  tooltip?: string;
  color?: string;
  sensitivity?: number;
  isActive?: boolean;
  isAppliable?: boolean;
  parentId?: string | null;
  applicableTo?: string;
  /** True when the label carries an AIP/RMS encryption policy (Graph beta `hasProtection`). */
  hasProtection?: boolean;
  raw?: unknown;
}

/**
 * Per-user usage rights for a protected (encrypted) sensitivity label.
 * Mirrors the Graph beta `usageRightsInfo` sub-object returned when the
 * sensitivityLabels list is queried with the `ownerEmail` filter.
 */
export interface SensitivityLabelUsageRights {
  allowView: boolean;
  allowEdit: boolean;
  allowExport: boolean;
  allowCopy: boolean;
  allowPrint: boolean;
}

// ============================================================
// Exports
// ============================================================

/**
 * List tenant-wide sensitivity labels.
 *
 * Backing call: GET /beta/security/informationProtection/sensitivityLabels
 */
export async function listSensitivityLabels(): Promise<SensitivityLabel[]> {
  assertEnabled();
  const endpoint = '/beta/security/informationProtection/sensitivityLabels';
  const res = await graphFetch(endpoint);
  const j = await readJson<{ value?: any[] }>(res, endpoint);
  return (j?.value || []).map((raw): SensitivityLabel => ({
    id: raw?.id,
    name: raw?.name || raw?.displayName,
    displayName: raw?.displayName,
    description: raw?.description,
    tooltip: raw?.tooltip,
    color: raw?.color,
    sensitivity: raw?.sensitivity,
    isActive: raw?.isActive,
    isAppliable: raw?.isAppliable,
    parentId: raw?.parent?.id ?? null,
    applicableTo: raw?.applicableTo,
    hasProtection: raw?.hasProtection ?? false,
    raw,
  }));
}

/**
 * Get a single sensitivity label by id.
 *
 * Returns null if the label doesn't exist (404).
 */
export async function getSensitivityLabel(id: string): Promise<SensitivityLabel | null> {
  assertEnabled();
  if (!id) throw new MipError(400, null, 'id is required');
  const endpoint = `/beta/security/informationProtection/sensitivityLabels/${encodeURIComponent(id)}`;
  const res = await graphFetch(endpoint);
  const raw = await readJson<any>(res, endpoint);
  if (!raw) return null;
  return {
    id: raw.id,
    name: raw.name || raw.displayName,
    displayName: raw.displayName,
    description: raw.description,
    tooltip: raw.tooltip,
    color: raw.color,
    sensitivity: raw.sensitivity,
    isActive: raw.isActive,
    isAppliable: raw.isAppliable,
    parentId: raw.parent?.id ?? null,
    applicableTo: raw.applicableTo,
    hasProtection: raw.hasProtection ?? false,
    raw,
  };
}

/**
 * Evaluate which labels would apply to a given piece of content. Used by
 * the "Apply label to a Loom item" inline action — the BFF sends the
 * item's metadata + a few hundred chars of preview text to MIP, and MIP
 * returns the recommended label.
 *
 * Backing call (app-only / service-principal variant — NOT the delegated
 * `/me/...policy/labels/...` path, which 400s under a UAMI):
 *   POST /beta/security/informationProtection/sensitivityLabels/evaluateApplication
 *
 * Returns the raw evaluation response. Caller is responsible for mapping
 * the recommended label id back to a sensitivity label in the UI.
 */
export async function evaluateLabel(payload: {
  contentInfo: {
    format?: 'default' | 'email' | 'file';
    identifier?: string;
    metadata?: { key: string; value: string }[];
  };
  contentToProcess: {
    contentEntries?: { id: string; content: string }[];
  };
}): Promise<unknown> {
  assertEnabled();
  const endpoint = '/beta/security/informationProtection/sensitivityLabels/evaluateApplication';
  const res = await graphFetch(endpoint, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return readJson<unknown>(res, endpoint);
}

/**
 * Get the sensitivity label with the calling user's per-user usage rights.
 *
 * Backing call (Graph beta), filtered to one label + one owner:
 *   GET /beta/security/informationProtection/sensitivityLabels
 *       ?$filter=(id eq '{guid}' and ownerEmail eq '{upn}')
 *
 * The matching label carries a `usageRightsInfo` sub-object (allowView /
 * allowEdit / allowExport / allowCopy / allowPrint) describing what the
 * `ownerEmail` user may do with content protected by this label. This is the
 * Azure-native, Fabric-free source of truth for the F19/F20 rights gates.
 *
 * Returns `null` (the honest-gate signal) when:
 *   - the filter matches no label (404 / empty value array);
 *   - the response carries no usageRightsInfo;
 *   - the ownerEmail rights filter is not available for this cloud boundary
 *     (GCC-High / IL5 / DoD return a non-2xx that we catch and degrade).
 *
 * Callers MUST treat `null` as "rights unavailable" and fall back to a
 * conservative gate (e.g. require an admin) rather than implicitly allowing.
 */
export async function getSensitivityLabelWithRights(
  labelId: string,
  ownerEmail: string,
): Promise<SensitivityLabelUsageRights | null> {
  assertEnabled();
  if (!labelId || !ownerEmail) return null;
  const filter = `(id eq '${labelId.replace(/'/g, "''")}' and ownerEmail eq '${ownerEmail.replace(/'/g, "''")}')`;
  const endpoint = `/beta/security/informationProtection/sensitivityLabels?$filter=${encodeURIComponent(filter)}`;
  let res: Response;
  try {
    res = await graphFetch(endpoint);
  } catch {
    return null;
  }
  if (!res.ok) return null; // 400/403/404 → rights filter unavailable (Gov clouds)
  let j: { value?: any[] } | null;
  try {
    const text = await res.text();
    j = text ? (JSON.parse(text) as { value?: any[] }) : null;
  } catch {
    return null;
  }
  if (!j?.value?.length) return null;
  const raw = j.value[0];
  const ri = raw?.rights?.usageRightsInfo || raw?.usageRightsInfo;
  if (!ri) return null;
  return {
    allowView: !!ri.allowView,
    allowEdit: !!ri.allowEdit,
    allowExport: !!ri.allowExport,
    allowCopy: !!ri.allowCopy,
    allowPrint: !!ri.allowPrint,
  };
}

// Test-only: expose internal helpers for unit tests
export const __testing = {
  notConfiguredHint,
  assertEnabled,
};
