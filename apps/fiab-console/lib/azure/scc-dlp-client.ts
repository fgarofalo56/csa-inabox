/**
 * Security & Compliance (SCC) DLP compliance-policy CRUD client.
 *
 * WHY this exists (and why it isn't in dlp-graph-client.ts):
 *   Microsoft Graph has NO create/edit/delete API for Purview DLP policies.
 *   The /beta informationProtection/dataLossPreventionPolicies segment is
 *   READ-ONLY (and preview-gated). The ONLY Microsoft-supported authoring
 *   surface is Security & Compliance PowerShell:
 *       Get-DlpCompliancePolicy / New-DlpCompliancePolicy /
 *       Set-DlpCompliancePolicy / Remove-DlpCompliancePolicy
 *       (+ the matching *-DlpComplianceRule cmdlets)
 *   each documented as available only in Security & Compliance PowerShell.
 *
 * A UAMI Graph token cannot drive SCC PowerShell, so DLP authoring runs through
 * the SAME out-of-process PowerShell sidecar as sensitivity-label CRUD
 * (azure-functions/scc-labels — the `dlp/` function), which authenticates to
 * the SCC PSWS endpoint with certificate-based app auth
 * (Connect-IPPSSession -AppId -CertificateThumbprint -Organization). The app
 * holds the Graph app-role Exchange.ManageAsApp + the directory role Compliance
 * Administrator. This client proxies the sidecar over HTTPS with a function-host
 * key — no SCC credential ever lives in the Console.
 *
 * Honest-gate (no-vaporware): when DLP admin is not wired
 * (LOOM_DLP_ADMIN_ENABLED != 'true' OR LOOM_SCC_LABELS_ENDPOINT unset) every
 * CRUD call throws DlpAdminNotConfiguredError → the BFF returns 503 + code
 * 'dlp_admin_not_configured' + a structured hint, and the UI renders a
 * NotConfiguredBar naming the exact env var / role / bootstrap step. The DLP
 * READ surface (Graph policy list, alerts, violations) and the Azure-native
 * Restrict-access enforcement keep working even when admin CRUD is unwired.
 *
 * Env vars (wired by admin-plane/main.bicep when loomDlpAdminEnabled=true):
 *   LOOM_DLP_ADMIN_ENABLED   — must be 'true' to enable CRUD.
 *   LOOM_SCC_LABELS_ENDPOINT — https base of the scc-labels Function app (shared).
 *   LOOM_SCC_LABELS_KEY      — Function host key (sent as x-functions-key).
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';

// ============================================================
// Errors
// ============================================================

export interface DlpAdminNotConfiguredHint {
  missingEnvVar: string;
  bicepModule: string;
  bicepStatus: string;
  rolesRequired: { name: string; appRoleId?: string; scope: string; reason: string }[];
  followUp: string;
}

export class DlpAdminNotConfiguredError extends Error {
  hint: DlpAdminNotConfiguredHint;
  constructor(hint: DlpAdminNotConfiguredHint) {
    super(
      `DLP policy management (create/edit/delete policies & rules) is not wired in this deployment: missing ${hint.missingEnvVar}`,
    );
    this.hint = hint;
  }
}

export class DlpAdminError extends Error {
  status: number;
  body: unknown;
  endpoint?: string;
  constructor(status: number, body: unknown, message?: string, endpoint?: string) {
    super(message || `DLP compliance sidecar call failed (${status})`);
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

function notConfiguredHint(missing: string): DlpAdminNotConfiguredHint {
  return {
    missingEnvVar: missing,
    bicepModule: 'platform/fiab/bicep/modules/admin-plane/scc-labels-function.bicep',
    bicepStatus:
      'Deploy the SCC PowerShell sidecar by setting loomDlpAdminEnabled=true (or loomMipAdminEnabled=true — both deploy the same scc-labels Function app) in main.bicep. ' +
      'That wires LOOM_DLP_ADMIN_ENABLED / LOOM_SCC_LABELS_ENDPOINT / LOOM_SCC_LABELS_KEY into the console app env. ' +
      'Microsoft Graph has no DLP write API, so policy CRUD must run through Security & Compliance PowerShell.',
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
          'Required to run New/Set/Remove-DlpCompliancePolicy and the *-DlpComplianceRule cmdlets that create, edit and delete DLP policies and rules.',
      },
    ],
    followUp:
      'Operator action: (1) deploy with loomDlpAdminEnabled=true, (2) run the post-deploy bootstrap step "Provision SCC labels sidecar" — it uploads the auth certificate to the admin Key Vault, grants the app Exchange.ManageAsApp (Tenant Admin consents), and assigns the app the Compliance Administrator directory role, (3) set SCC_APP_ID / SCC_CERT_THUMBPRINT / SCC_ORGANIZATION on the sidecar Function app. Until then, DLP policy READS (Graph), alerts, violations, and the Azure-native Restrict-access tab keep working; only create/edit/delete returns this gate. You can always author DLP policies in the Microsoft Purview portal (https://purview.microsoft.com → Data loss prevention → Policies) or via Get/New-DlpCompliancePolicy.',
  };
}

function adminConfig(): { endpoint: string; key: string } {
  if (process.env.LOOM_DLP_ADMIN_ENABLED !== 'true') {
    throw new DlpAdminNotConfiguredError(notConfiguredHint('LOOM_DLP_ADMIN_ENABLED'));
  }
  const endpoint = (process.env.LOOM_SCC_LABELS_ENDPOINT || '').replace(/\/+$/, '');
  if (!endpoint) {
    throw new DlpAdminNotConfiguredError(notConfiguredHint('LOOM_SCC_LABELS_ENDPOINT'));
  }
  const key = process.env.LOOM_SCC_LABELS_KEY || '';
  if (!key) {
    throw new DlpAdminNotConfiguredError(notConfiguredHint('LOOM_SCC_LABELS_KEY'));
  }
  return { endpoint, key };
}

/** True when the DLP admin sidecar is wired (no throw). UI may pre-flight this. */
export function isDlpAdminConfigured(): boolean {
  try {
    adminConfig();
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// Types — guided form model (never raw JSON rule authoring)
// ============================================================

export type DlpPolicyMode =
  | 'Enable'
  | 'TestWithNotifications'
  | 'TestWithoutNotifications'
  | 'Disable';

export interface DlpComplianceRuleView {
  id?: string;
  name?: string;
  priority?: number;
  blockAccess?: boolean;
  generateAlert?: boolean;
  disabled?: boolean;
  sensitiveTypes?: string[];
}

export interface DlpCompliancePolicyView {
  id: string;
  name?: string;
  displayName?: string;
  comment?: string;
  mode?: string;
  enabled?: boolean;
  workload?: string;
  locations?: string[];
  ruleCount?: number;
  rules?: DlpComplianceRuleView[];
}

/** Guided rule input — sensitive info types + the enforcement action. */
export interface DlpRuleInput {
  name: string;
  sensitiveTypes: string[];
  blockAccess?: boolean;
  generateAlert?: boolean;
  notifyUser?: string[];
}

/** Guided policy input (create/edit). Workloads are booleans → 'All' scope. */
export interface DlpPolicyInput {
  name: string;
  comment?: string;
  mode?: DlpPolicyMode;
  exchange?: boolean;
  sharePoint?: boolean;
  oneDrive?: boolean;
  teams?: boolean;
  rule?: DlpRuleInput;
}

// ============================================================
// Low-level sidecar call
// ============================================================

interface DlpCommand {
  action: 'list' | 'get' | 'create' | 'update' | 'delete';
  id?: string;
  policy?: DlpPolicyInput;
}

async function callSidecar<T>(cmd: DlpCommand): Promise<T> {
  const { endpoint, key } = adminConfig();
  const url = `${endpoint}/api/dlp`;
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
    throw new DlpAdminError(502, null, `DLP compliance sidecar unreachable: ${e?.message || e}`, url);
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
      (typeof parsed === 'string' ? parsed : `DLP sidecar ${res.status}`);
    throw new DlpAdminError(res.status, parsed, msg, url);
  }
  if (parsed && parsed.ok === false) {
    throw new DlpAdminError(400, parsed, parsed.error || 'DLP command failed', url);
  }
  return (parsed?.data ?? parsed) as T;
}

// ============================================================
// Exports — policy + rule CRUD (Get/New/Set/Remove-DlpCompliancePolicy)
// ============================================================

/** List DLP compliance policies (+ their rules) via the SCC sidecar. */
export async function listDlpCompliancePolicies(): Promise<DlpCompliancePolicyView[]> {
  const rows = await callSidecar<DlpCompliancePolicyView[]>({ action: 'list' });
  return Array.isArray(rows) ? rows : [];
}

/** Get a single DLP compliance policy by name or GUID. */
export async function getDlpCompliancePolicy(id: string): Promise<DlpCompliancePolicyView> {
  if (!id) throw new DlpAdminError(400, null, 'policy id is required');
  return callSidecar<DlpCompliancePolicyView>({ action: 'get', id });
}

/** Create a DLP compliance policy (and, when supplied, its initial rule). */
export async function createDlpCompliancePolicy(input: DlpPolicyInput): Promise<{ id: string; name?: string }> {
  if (!input?.name?.trim()) throw new DlpAdminError(400, null, 'policy name is required');
  if (!input.exchange && !input.sharePoint && !input.oneDrive && !input.teams) {
    throw new DlpAdminError(400, null, 'a policy must scope at least one workload (Exchange / SharePoint / OneDrive / Teams)');
  }
  if (input.rule && (!Array.isArray(input.rule.sensitiveTypes) || input.rule.sensitiveTypes.length === 0)) {
    throw new DlpAdminError(400, null, 'the rule must select at least one sensitive information type');
  }
  return callSidecar<{ id: string; name?: string }>({ action: 'create', policy: input });
}

/** Edit a DLP compliance policy (and optionally upsert its named rule). */
export async function updateDlpCompliancePolicy(id: string, input: Partial<DlpPolicyInput>): Promise<{ id: string }> {
  if (!id) throw new DlpAdminError(400, null, 'policy id is required');
  return callSidecar<{ id: string }>({ action: 'update', id, policy: input as DlpPolicyInput });
}

/** Delete a DLP compliance policy. */
export async function deleteDlpCompliancePolicy(id: string): Promise<{ id: string }> {
  if (!id) throw new DlpAdminError(400, null, 'policy id is required');
  return callSidecar<{ id: string }>({ action: 'delete', id });
}

// Test-only
export const __testing = { notConfiguredHint, adminConfig };
