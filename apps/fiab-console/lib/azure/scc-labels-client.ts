/**
 * Security & Compliance (SCC) sensitivity-label CRUD client.
 *
 * WHY this exists separately from mip-graph-client.ts:
 *   Microsoft Graph has NO app-only (UAMI) surface to read tenant label
 *   policies, nor any surface at all to create / edit / delete sensitivity
 *   label definitions or label policies. Those operations are exposed ONLY
 *   through Security & Compliance PowerShell:
 *       New-Label / Set-Label / Remove-Label
 *       New-LabelPolicy / Set-LabelPolicy / Remove-LabelPolicy / Get-LabelPolicy
 *   (each documented as "available only in Security & Compliance PowerShell").
 *
 * Because a UAMI Graph token cannot drive SCC PowerShell, Loom runs an
 * out-of-process PowerShell sidecar (azure-functions/scc-labels) that
 * authenticates to the SCC PSWS endpoint with certificate-based app auth
 * (`Connect-IPPSSession -AppId -CertificateThumbprint -Organization`). The
 * app holds the Graph app-role Exchange.ManageAsApp + the directory role
 * Compliance Administrator. This client proxies the sidecar over HTTPS with a
 * function-host key — no SCC credential ever lives in the Console.
 *
 * Honest-gate (no-vaporware): when the sidecar is not wired (LOOM_MIP_ADMIN_ENABLED
 * != 'true' OR LOOM_SCC_LABELS_ENDPOINT unset) every CRUD call throws
 * SccNotConfiguredError → the BFF returns 503 + code 'mip_admin_not_configured'
 * + a structured hint, and the UI renders a NotConfiguredBar naming the exact
 * env var / role / bootstrap step to provision. The READ surface (label
 * definitions) keeps working via mip-graph-client even when admin is unwired.
 *
 * Env vars (wired by admin-plane/main.bicep when loomMipAdminEnabled=true):
 *   LOOM_MIP_ADMIN_ENABLED   — must be 'true' to enable CRUD.
 *   LOOM_SCC_LABELS_ENDPOINT — https base of the scc-labels Function app.
 *   LOOM_SCC_LABELS_KEY      — Function host key (sent as x-functions-key).
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';

// ============================================================
// Errors
// ============================================================

export interface SccNotConfiguredHint {
  missingEnvVar: string;
  bicepModule: string;
  bicepStatus: string;
  rolesRequired: { name: string; appRoleId?: string; scope: string; reason: string }[];
  followUp: string;
}

export class SccNotConfiguredError extends Error {
  hint: SccNotConfiguredHint;
  constructor(hint: SccNotConfiguredHint) {
    super(
      `Sensitivity-label management (create/edit/delete labels & policies) is not wired in this deployment: missing ${hint.missingEnvVar}`,
    );
    this.hint = hint;
  }
}

export class SccError extends Error {
  status: number;
  body: unknown;
  endpoint?: string;
  constructor(status: number, body: unknown, message?: string, endpoint?: string) {
    super(message || `Security & Compliance sidecar call failed (${status})`);
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

function notConfiguredHint(missing: string): SccNotConfiguredHint {
  return {
    missingEnvVar: missing,
    bicepModule: 'platform/fiab/bicep/modules/admin-plane/scc-labels-function.bicep',
    bicepStatus:
      'Deploy the SCC labels sidecar by setting loomMipAdminEnabled=true in main.bicep. ' +
      'That deploys the PowerShell Function app (scc-labels-function.bicep) and wires ' +
      'LOOM_MIP_ADMIN_ENABLED / LOOM_SCC_LABELS_ENDPOINT / LOOM_SCC_LABELS_KEY into the console app env.',
    rolesRequired: [
      {
        name: 'Exchange.ManageAsApp',
        appRoleId: 'dc50a0fb-09a3-484d-be87-e023b12c6440',
        scope: 'Office 365 Exchange Online (app permission, admin-consented)',
        reason:
          'Lets the SCC sidecar app authenticate to Security & Compliance PowerShell unattended (Connect-IPPSSession -AppId -CertificateThumbprint).',
      },
      {
        name: 'Compliance Administrator',
        scope: 'Entra directory role (assigned to the SCC sidecar app service principal)',
        reason:
          'Required to run New-Label / Set-Label / Remove-Label and the *-LabelPolicy cmdlets that create, edit and delete sensitivity labels and their policies.',
      },
    ],
    followUp:
      'Operator action: (1) deploy with loomMipAdminEnabled=true, (2) run the post-deploy bootstrap step "Provision SCC labels sidecar" — it uploads the auth certificate to the admin Key Vault, grants the app Exchange.ManageAsApp (Tenant Admin consents), and assigns the app the Compliance Administrator directory role, (3) set LOOM_SCC_TENANT / LOOM_SCC_APP_ID / cert thumbprint on the sidecar Function app. Until then, label/policy reads still work but create/edit/delete return this gate.',
  };
}

function adminConfig(): { endpoint: string; key: string } {
  if (process.env.LOOM_MIP_ADMIN_ENABLED !== 'true') {
    throw new SccNotConfiguredError(notConfiguredHint('LOOM_MIP_ADMIN_ENABLED'));
  }
  const endpoint = (process.env.LOOM_SCC_LABELS_ENDPOINT || '').replace(/\/+$/, '');
  if (!endpoint) {
    throw new SccNotConfiguredError(notConfiguredHint('LOOM_SCC_LABELS_ENDPOINT'));
  }
  const key = process.env.LOOM_SCC_LABELS_KEY || '';
  if (!key) {
    throw new SccNotConfiguredError(notConfiguredHint('LOOM_SCC_LABELS_KEY'));
  }
  return { endpoint, key };
}

/** True when the SCC admin sidecar is wired (no throw). UI may pre-flight this. */
export function isSccAdminConfigured(): boolean {
  try {
    adminConfig();
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// Types
// ============================================================

export interface SensitivityLabelPolicy {
  /** SCC policy GUID (Guid property). */
  id: string;
  name?: string;
  displayName?: string;
  description?: string;
  isMandatory?: boolean;
  defaultLabelId?: string;
  /** Locations the policy is scoped to (Exchange / SharePoint / OneDrive / etc.). */
  scopes?: string[];
  /** Per-workload scope identities (so the edit wizard can prefill who the policy targets). */
  exchangeLocation?: string[];
  sharePointLocation?: string[];
  oneDriveLocation?: string[];
  modernGroupLocation?: string[];
  /** Labels (GUIDs) published by this policy. */
  labels?: string[];
  enabled?: boolean;
  raw?: unknown;
}

/** Input for create/edit of a sensitivity label definition (guided form — never raw JSON). */
export interface LabelDefinitionInput {
  /** Display name (required on create). */
  displayName: string;
  /** Tooltip shown in apps when the label is selected. */
  tooltip?: string;
  /** Optional admin description (comment). */
  comment?: string;
  /** Hex color, e.g. #cc0000. */
  color?: string;
  /** Parent label GUID for sub-labels. */
  parentId?: string;
  /** Enable content-marking / encryption (protection). When false the label is informational only. */
  encryptionEnabled?: boolean;
}

/** Input for create/edit of a label policy (guided form). */
export interface LabelPolicyInput {
  name: string;
  comment?: string;
  /** Label GUIDs to publish (order = display order). */
  labels: string[];
  /**
   * Scope locations per workload. Each accepts the literal 'All' or specific
   * identities (mailbox / site URL / group). On create these map 1:1 to the
   * New-LabelPolicy -*Location parameters; on edit the sidecar diffs them
   * against the live policy and applies the matching Add/Remove changes, so
   * an empty array clears that workload's scope.
   */
  exchangeLocation?: string[];
  sharePointLocation?: string[];
  oneDriveLocation?: string[];
  modernGroupLocation?: string[];
  /** Make labeling mandatory in scoped apps. */
  mandatory?: boolean;
  /** Default label GUID applied to new content. */
  defaultLabelId?: string;
}

export interface SccResult<T = unknown> {
  ok: boolean;
  data?: T;
  warning?: string;
}

// ============================================================
// Low-level sidecar call
// ============================================================

interface SccCommand {
  action:
    | 'list-policies'
    | 'create-label'
    | 'update-label'
    | 'delete-label'
    | 'create-policy'
    | 'update-policy'
    | 'delete-policy';
  /** Target label/policy GUID (update/delete). */
  id?: string;
  label?: LabelDefinitionInput;
  policy?: LabelPolicyInput;
}

async function callSidecar<T>(cmd: SccCommand): Promise<T> {
  const { endpoint, key } = adminConfig();
  const url = `${endpoint}/api/labels`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-functions-key': key,
        'user-agent': 'CSA-Loom-Console/1.0',
      },
      body: JSON.stringify(cmd),
      // SCC PowerShell cmdlets are slow; give the sidecar room.
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e: any) {
    throw new SccError(502, null, `SCC labels sidecar unreachable: ${e?.message || e}`, url);
  }
  const text = await res.text();
  let parsed: any = undefined;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!res.ok) {
    const msg =
      parsed?.error ||
      parsed?.message ||
      (typeof parsed === 'string' ? parsed : `SCC sidecar ${res.status}`);
    throw new SccError(res.status, parsed, msg, url);
  }
  if (parsed && parsed.ok === false) {
    throw new SccError(400, parsed, parsed.error || 'SCC command failed', url);
  }
  return (parsed?.data ?? parsed) as T;
}

// ============================================================
// Policy reads (the honest replacement for the broken Graph 400 call)
// ============================================================

/**
 * List sensitivity label policies via the SCC sidecar (Get-LabelPolicy).
 *
 * Replaces the old, broken Graph call
 * `GET /beta/security/informationProtection/policy/labels` (HTTP 400 app-only).
 */
export async function listLabelPolicies(): Promise<SensitivityLabelPolicy[]> {
  const rows = await callSidecar<any[]>({ action: 'list-policies' });
  const arr = (v: any): string[] | undefined =>
    Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : undefined;
  return (rows || []).map((raw): SensitivityLabelPolicy => {
    const exchangeLocation = arr(raw?.exchangeLocation) ?? arr(raw?.ExchangeLocation);
    const sharePointLocation = arr(raw?.sharePointLocation) ?? arr(raw?.SharePointLocation);
    const oneDriveLocation = arr(raw?.oneDriveLocation) ?? arr(raw?.OneDriveLocation);
    const modernGroupLocation = arr(raw?.modernGroupLocation) ?? arr(raw?.ModernGroupLocation);
    const scopes = Array.isArray(raw?.scopes) && raw.scopes.length
      ? raw.scopes.map((x: any) => String(x))
      : [
          ...(exchangeLocation?.length ? ['Exchange'] : []),
          ...(sharePointLocation?.length ? ['SharePoint'] : []),
          ...(oneDriveLocation?.length ? ['OneDrive'] : []),
          ...(modernGroupLocation?.length ? ['Microsoft 365 Groups'] : []),
        ];
    return {
      id: raw?.id || raw?.Guid || raw?.ImmutableId,
      name: raw?.name || raw?.Name,
      displayName: raw?.displayName || raw?.Name,
      description: raw?.description || raw?.Comment,
      isMandatory: raw?.isMandatory ?? raw?.Mandatory,
      defaultLabelId: raw?.defaultLabelId ?? raw?.DefaultLabel,
      scopes: scopes.length ? scopes : undefined,
      exchangeLocation,
      sharePointLocation,
      oneDriveLocation,
      modernGroupLocation,
      labels: Array.isArray(raw?.labels) ? raw.labels : (Array.isArray(raw?.Labels) ? raw.Labels : undefined),
      enabled: raw?.enabled ?? raw?.Enabled,
      raw,
    };
  });
}

// ============================================================
// Label CRUD (New-Label / Set-Label / Remove-Label)
// ============================================================

export async function createLabel(input: LabelDefinitionInput): Promise<{ id: string; raw: unknown }> {
  if (!input?.displayName?.trim()) throw new SccError(400, null, 'displayName is required');
  return callSidecar<{ id: string; raw: unknown }>({ action: 'create-label', label: input });
}

export async function updateLabel(id: string, input: Partial<LabelDefinitionInput>): Promise<{ id: string; raw: unknown }> {
  if (!id) throw new SccError(400, null, 'label id is required');
  return callSidecar<{ id: string; raw: unknown }>({
    action: 'update-label',
    id,
    label: input as LabelDefinitionInput,
  });
}

export async function deleteLabel(id: string): Promise<{ id: string }> {
  if (!id) throw new SccError(400, null, 'label id is required');
  return callSidecar<{ id: string }>({ action: 'delete-label', id });
}

// ============================================================
// Policy CRUD (New-LabelPolicy / Set-LabelPolicy / Remove-LabelPolicy)
// ============================================================

export async function createLabelPolicy(input: LabelPolicyInput): Promise<{ id: string; raw: unknown }> {
  if (!input?.name?.trim()) throw new SccError(400, null, 'policy name is required');
  if (!Array.isArray(input.labels) || input.labels.length === 0) {
    throw new SccError(400, null, 'a policy must publish at least one label');
  }
  return callSidecar<{ id: string; raw: unknown }>({ action: 'create-policy', policy: input });
}

export async function updateLabelPolicy(id: string, input: Partial<LabelPolicyInput>): Promise<{ id: string; raw: unknown }> {
  if (!id) throw new SccError(400, null, 'policy id is required');
  return callSidecar<{ id: string; raw: unknown }>({
    action: 'update-policy',
    id,
    policy: input as LabelPolicyInput,
  });
}

export async function deleteLabelPolicy(id: string): Promise<{ id: string }> {
  if (!id) throw new SccError(400, null, 'policy id is required');
  return callSidecar<{ id: string }>({ action: 'delete-policy', id });
}

// Test-only
export const __testing = { notConfiguredHint, adminConfig };
