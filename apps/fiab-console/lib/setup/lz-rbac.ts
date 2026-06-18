/**
 * Landing-zone RBAC auto-grant (Wave 1 — attach-new-LZ end-to-end).
 *
 * When an admin attaches (or repairs) a Data Landing Zone, the Console UAMI must
 * be able to SEE, ATTACH, CREATE, and DEPLOY into that DLZ. The least-privilege
 * model (per .claude/rules + the multi-sub security notes) is:
 *
 *   - Contributor scoped to the **DLZ resource group** — NOT subscription-wide.
 *     The DLZ subscription holds many non-Loom workloads, so a sub-scope grant
 *     is an over-reach we never do. RG-scoped Contributor lets the UAMI run
 *     RG-scoped deployments + create/manage every resource inside the DLZ RG.
 *   - The minimal data-plane roles the navigators need to actually read/write
 *     the lake + ADX once provisioned: Storage Blob Data Contributor (ADLS Gen2
 *     medallion) and Azure Event Hubs Data Owner (eventstream ingest), also
 *     scoped to the **DLZ resource group**. These ride on the RG scope so they
 *     cover every storage account / EH namespace the DLZ provisions without a
 *     per-resource grant.
 *
 * The grant is performed as real ARM `PUT .../roleAssignments/{guid}` calls in
 * the DLZ's OWN subscription (no-vaporware: real ARM, never a mock). When the
 * caller (Console UAMI) lacks `Microsoft.Authorization/roleAssignments/write`
 * at the RG scope — i.e. it is not a User Access Administrator / Owner on that
 * RG/sub — ARM returns 403; the route turns that into an honest MessageBar with
 * the exact RG-scoped `az role assignment create` an operator with rights runs.
 *
 * The pure helpers ({@link RG_SCOPED_LZ_ROLES}, {@link buildRgScopedGrantCommands},
 * {@link resourceGroupScope}) are exported separately from the ARM I/O so they
 * are unit-testable without a live subscription.
 */

import { armBase, armScope, detectLoomCloud } from '@/lib/azure/cloud-endpoints';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';

/**
 * The role set auto-granted to the Console UAMI when a DLZ is attached/repaired.
 * Every GUID is a built-in Azure role (global across all sovereign clouds). All
 * are applied at the DLZ **resource-group** scope (least-privilege).
 */
export const RG_SCOPED_LZ_ROLES: Array<{ name: string; guid: string; why: string }> = [
  {
    name: 'Contributor',
    guid: 'b24988ac-6180-42a0-bb6f-b91a8f3d3d0e',
    why: 'Run RG-scoped deployments + create/manage every resource in the DLZ RG.',
  },
  {
    name: 'Storage Blob Data Contributor',
    guid: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe',
    why: 'Read/write the ADLS Gen2 medallion lake (data plane) the DLZ provisions.',
  },
  {
    name: 'Azure Event Hubs Data Owner',
    guid: 'f526a384-b230-433a-b45c-95f59c4a2dec',
    why: 'Send/receive on the eventstream Event Hubs (data plane) the DLZ provisions.',
  },
] as const;

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RG_NAME_RE = /^[\w.()-]{1,90}$/;

export type PrincipalType = 'ServicePrincipal' | 'User' | 'Group';

/** PURE: the ARM resource-group scope string for a sub + RG. */
export function resourceGroupScope(subscriptionId: string, resourceGroup: string): string {
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
}

/**
 * PURE: the exact `az role assignment create` lines an operator with
 * `Microsoft.Authorization/roleAssignments/write` runs to grant the role set,
 * scoped to the DLZ resource group (least-privilege — never subscription-wide),
 * in the DLZ's own subscription. Returned when the Console UAMI itself cannot
 * write role assignments (the honest gate).
 */
export function buildRgScopedGrantCommands(opts: {
  subscriptionId: string;
  resourceGroup: string;
  principalObjectId?: string;
  principalType?: PrincipalType;
  isGov?: boolean;
}): string[] {
  const assignee = opts.principalObjectId || '<console-uami-object-id>';
  const ptype = opts.principalType || 'ServicePrincipal';
  const scope = resourceGroupScope(opts.subscriptionId, opts.resourceGroup);
  const lines: string[] = [];
  if (opts.isGov) lines.push('az cloud set --name AzureUSGovernment');
  lines.push(`az account set --subscription ${opts.subscriptionId}`);
  for (const role of RG_SCOPED_LZ_ROLES) {
    lines.push(
      'az role assignment create \\',
      `  --assignee-object-id ${assignee} \\`,
      `  --assignee-principal-type ${ptype} \\`,
      `  --role "${role.name}" \\`,
      `  --scope ${scope}`,
    );
  }
  return lines;
}

/** Outcome of granting one role. */
export interface RoleGrantOutcome {
  role: string;
  /** 'granted' (PUT 201), 'already' (409/existing), or 'failed'. */
  status: 'granted' | 'already' | 'failed';
  roleAssignmentId?: string;
  error?: string;
  /** HTTP status of the underlying ARM call when it failed. */
  httpStatus?: number;
}

/** Aggregate result of granting the full role set at the DLZ RG scope. */
export interface GrantRgScopedRolesResult {
  ok: boolean;
  /** true when EVERY role is granted or already present. */
  allGranted: boolean;
  /** true when ARM denied the role-assignment write (caller lacks UAA/Owner). */
  forbidden: boolean;
  scope: string;
  outcomes: RoleGrantOutcome[];
}

// MI-FIRST credential chain (matches landing-zones/route.ts + adls-client.ts):
// never a bare DefaultAzureCredential when a UAMI client id is wired.
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const grantCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

async function defaultArmToken(): Promise<string> {
  const t = await grantCredential.getToken(armScope());
  if (!t?.token) throw new Error('Failed to acquire ARM token for LZ RBAC grant');
  return t.token;
}

function newRoleAssignmentGuid(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

/**
 * LIVE: grant the full least-privilege LZ role set ({@link RG_SCOPED_LZ_ROLES})
 * to `principalObjectId` at the DLZ **resource-group** scope, in the DLZ's own
 * subscription. Each role is a separate ARM `PUT roleAssignments/{guid}` —
 * a 409 (RoleAssignmentExists) is treated as success ('already'), a 403/401 as
 * `forbidden` (the route surfaces the honest copy-paste gate). `getToken` is
 * injected so the route passes its own credential and tests pass a stub.
 *
 * `principalType: 'ServicePrincipal'` is always set so a freshly-created UAMI
 * (replication lag) does not 400 with PrincipalNotFound (per Microsoft Learn:
 * specify principalType for new principals).
 */
export async function grantRgScopedRoles(opts: {
  subscriptionId: string;
  resourceGroup: string;
  principalObjectId: string;
  principalType?: PrincipalType;
  getToken?: () => Promise<string>;
}): Promise<GrantRgScopedRolesResult> {
  const scope = resourceGroupScope(opts.subscriptionId, opts.resourceGroup);
  const base: Omit<GrantRgScopedRolesResult, 'outcomes'> = {
    ok: false,
    allGranted: false,
    forbidden: false,
    scope,
  };
  if (!GUID_RE.test(opts.subscriptionId)) {
    return { ...base, outcomes: [{ role: '*', status: 'failed', error: `invalid subscriptionId: ${opts.subscriptionId}` }] };
  }
  if (!RG_NAME_RE.test(opts.resourceGroup)) {
    return { ...base, outcomes: [{ role: '*', status: 'failed', error: `invalid resourceGroup: ${opts.resourceGroup}` }] };
  }
  if (!GUID_RE.test(opts.principalObjectId)) {
    return { ...base, outcomes: [{ role: '*', status: 'failed', error: `invalid principalObjectId: ${opts.principalObjectId}` }] };
  }

  const getToken = opts.getToken ?? defaultArmToken;
  let token: string;
  try {
    token = await getToken();
  } catch (e: any) {
    return { ...base, outcomes: [{ role: '*', status: 'failed', error: `token: ${e?.message ?? String(e)}` }] };
  }

  const principalType = opts.principalType ?? 'ServicePrincipal';
  const outcomes: RoleGrantOutcome[] = [];
  let forbidden = false;

  for (const role of RG_SCOPED_LZ_ROLES) {
    const roleDefinitionId = `/subscriptions/${opts.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${role.guid}`;
    const url = `${armBase()}${scope}/providers/Microsoft.Authorization/roleAssignments/${newRoleAssignmentGuid()}?api-version=2022-04-01`;
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ properties: { roleDefinitionId, principalId: opts.principalObjectId, principalType } }),
      });
      if (res.ok) {
        const j: any = await res.json().catch(() => ({}));
        outcomes.push({ role: role.name, status: 'granted', roleAssignmentId: j?.id });
        continue;
      }
      const text = await res.text().catch(() => '');
      if (res.status === 409 || /already exists|RoleAssignmentExists/i.test(text)) {
        outcomes.push({ role: role.name, status: 'already' });
        continue;
      }
      if (res.status === 403 || res.status === 401) forbidden = true;
      outcomes.push({ role: role.name, status: 'failed', httpStatus: res.status, error: text.slice(0, 200) || `ARM ${res.status}` });
    } catch (e: any) {
      outcomes.push({ role: role.name, status: 'failed', error: e?.message ?? String(e) });
    }
  }

  const allGranted = outcomes.every((o) => o.status === 'granted' || o.status === 'already');
  return { ok: allGranted, allGranted, forbidden, scope, outcomes };
}

/** Whether the active boundary is a sovereign (Gov) cloud (for `az cloud set`). */
export function isGovBoundary(boundary?: string): boolean {
  if (boundary) return boundary === 'GCC-High' || boundary === 'IL5';
  const c = detectLoomCloud();
  return c === 'GCC-High' || c === 'DoD';
}
