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
 *   GET  https://graph.microsoft.com/beta/security/informationProtection/policy/labels      (label policies)
 *   POST https://graph.microsoft.com/beta/me/informationProtection/policy/labels/evaluateApplication
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

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';

const GRAPH_BASE = process.env.LOOM_MIP_GRAPH_BASE || 'https://graph.microsoft.com';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
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
  const token = await credential.getToken(GRAPH_SCOPE);
  if (!token?.token) throw new MipError(500, null, 'Failed to acquire Microsoft Graph token');
  const url = `${GRAPH_BASE}${path}`;
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
  raw?: unknown;
}

export interface SensitivityLabelPolicy {
  id: string;
  name?: string;
  displayName?: string;
  description?: string;
  isMandatory?: boolean;
  defaultLabelId?: string;
  scopes?: string[];
  raw?: unknown;
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
    raw,
  };
}

/**
 * List sensitivity label policies (which labels are published to which
 * users / groups / locations).
 *
 * Backing call: GET /beta/security/informationProtection/policy/labels
 *
 * Note: this is the "policy" view of labels (scope + default + mandatory),
 * distinct from the "definition" view above.
 */
export async function listLabelPolicies(): Promise<SensitivityLabelPolicy[]> {
  assertEnabled();
  const endpoint = '/beta/security/informationProtection/policy/labels';
  const res = await graphFetch(endpoint);
  const j = await readJson<{ value?: any[] }>(res, endpoint);
  return (j?.value || []).map((raw): SensitivityLabelPolicy => ({
    id: raw?.id,
    name: raw?.name || raw?.displayName,
    displayName: raw?.displayName,
    description: raw?.description,
    isMandatory: raw?.isMandatory,
    defaultLabelId: raw?.defaultLabelId,
    scopes: Array.isArray(raw?.scopes) ? raw.scopes : undefined,
    raw,
  }));
}

/**
 * Evaluate which labels would apply to a given piece of content. Used by
 * the "Apply label to a Loom item" inline action — the BFF sends the
 * item's metadata + a few hundred chars of preview text to MIP, and MIP
 * returns the recommended label.
 *
 * Backing call: POST /beta/me/informationProtection/policy/labels/evaluateApplication
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
  const endpoint = '/beta/me/informationProtection/policy/labels/evaluateApplication';
  const res = await graphFetch(endpoint, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return readJson<unknown>(res, endpoint);
}

// Test-only: expose internal helpers for unit tests
export const __testing = {
  notConfiguredHint,
  assertEnabled,
};
