/**
 * role-grant-client — ARM-PUT of the navigator RBAC role the Console UAMI needs
 * on a brownfield resource that was just attached (brownfield Phase 2, §2.4.1 of
 * docs/fiab/research/brownfield-attach-design.md).
 *
 * On attach, a borrowed customer resource is registered in the Landing-Zone
 * Service Registry but the Console managed identity does NOT yet hold the
 * navigator role on it (Contributor / Storage Blob Data Contributor / … — the
 * exact role per kind lives in `attached-service-kinds.ts`, verbatim from
 * `scripts/csa-loom/grant-navigator-rbac.sh`). This module makes that grant real
 * via ARM `PUT /providers/Microsoft.Authorization/roleAssignments/{guid}`:
 *
 *   - **Auto-grant** when the running UAMI can create the assignment (it holds
 *     User Access Administrator / Owner on the resource's scope). Success → the
 *     service becomes `status:'attached'`.
 *   - **Honest gate** (per no-vaporware.md) when it cannot: an AuthorizationFailed
 *     keeps the service `status:'pending-grants'` and surfaces the EXACT `az role
 *     assignment create` command the operator must run — never a silent failure.
 *
 * The assignment name is a DETERMINISTIC UUID (a v5-shaped hash of
 * scope+role+principal) so a re-attach is idempotent: PUTting the same name is a
 * no-op update, and Azure's `RoleAssignmentExists` (409) for the same
 * principal+role at the scope is treated as success.
 *
 * Cloud-invariant: `armBase()` / `armScope()` + `uamiArmCredential()` so it works
 * in Commercial / GCC / GCC-High / DoD (no hard-coded management host).
 */
import crypto from 'node:crypto';
import { uamiArmCredential } from './arm-credential';
import { armBase, armScope } from './cloud-endpoints';
import { getKindDef, type AttachedServiceKind } from './attached-service-kinds';
import { resolveUamiPrincipalId } from '@/lib/clients/azure-connections-client';

/** ARM role-assignment API version (matches adls-client's grant primitive). */
const ROLE_ASSIGNMENTS_API = '2022-04-01';

export type RoleGrantOutcome =
  | 'granted' // the PUT created the assignment (201/200)
  | 'already-exists' // idempotent — the grant was already present (deterministic name or RoleAssignmentExists)
  | 'pending-grants' // AuthorizationFailed — honest gate, grantScript emitted
  | 'skipped' // no principal / unknown kind — nothing attempted
  | 'error'; // an unexpected failure (still non-fatal to the attach)

export interface RoleGrantResult {
  outcome: RoleGrantOutcome;
  /** Deterministic assignment name used (for traceability / idempotent re-grant). */
  assignmentGuid: string;
  roleName: string;
  roleGuid: string;
  /** The scope the role is (or must be) assigned at — the ARM resource id. */
  scope: string;
  principalId: string | null;
  /** Exact az CLI command to run the grant by hand when auto-grant can't (honest gate). */
  grantScript?: string;
  /** Human detail for the badge tooltip / MessageBar. */
  detail?: string;
  httpStatus?: number;
}

/** Subscription id from an ARM resource id (role definitions are sub-scoped). */
function subFromArmId(armResourceId: string): string | null {
  return /\/subscriptions\/([^/]+)/i.exec(armResourceId || '')?.[1] ?? null;
}

/**
 * A DETERMINISTIC, RFC-4122-shaped UUID derived from scope+role+principal. Same
 * inputs → same assignment name, so a re-attach PUTs the same resource (no dup),
 * and a stale name never collides with a different grant. Not a real v5 (no
 * namespace ceremony) — just a stable, valid GUID Azure accepts as the name.
 */
export function deterministicAssignmentGuid(
  scope: string,
  roleGuid: string,
  principalId: string,
): string {
  const h = crypto
    .createHash('sha256')
    .update(`${(scope || '').toLowerCase()}|${(roleGuid || '').toLowerCase()}|${(principalId || '').toLowerCase()}`)
    .digest('hex');
  const b = h.slice(0, 32).split('');
  b[12] = '5'; // version nibble
  b[16] = ((parseInt(b[16], 16) & 0x3) | 0x8).toString(16); // RFC-4122 variant
  const s = b.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** Build the honest `az role assignment create` command for a pending grant. */
export function grantScriptFor(
  roleGuid: string,
  principalId: string | null,
  scope: string,
): string {
  const assignee = principalId || '<console-uami-principal-id>';
  return (
    `az role assignment create --assignee-object-id ${assignee} ` +
    `--assignee-principal-type ServicePrincipal --role ${roleGuid} --scope "${scope}"`
  );
}

export interface GrantNavigatorRoleInput {
  /** The attached resource's ARM id — the grant scope. */
  armResourceId: string;
  kind: AttachedServiceKind;
  /** Console UAMI principal (object) id; resolved from env/token when omitted. */
  principalId?: string | null;
}

/**
 * Attempt to grant the Console UAMI the navigator role for `kind` at the
 * resource scope. Never throws — every failure becomes a `RoleGrantResult` the
 * attach hook records on the service doc. `fetchImpl` is injectable for tests.
 */
export async function grantNavigatorRole(
  input: GrantNavigatorRoleInput,
  fetchImpl: typeof fetch = fetch,
): Promise<RoleGrantResult> {
  const def = getKindDef(input.kind);
  const scope = (input.armResourceId || '').trim();
  const roleGuid = def?.roleGuid || '';
  const roleName = def?.roleName || input.kind;

  if (!def || !roleGuid || !scope) {
    return {
      outcome: 'skipped', assignmentGuid: '', roleName, roleGuid, scope, principalId: null,
      detail: 'No navigator role is defined for this service kind, or the ARM id is missing.',
    };
  }

  const principalId = (input.principalId ?? (await resolveUamiPrincipalId())) || null;
  if (!principalId) {
    // Cannot even form the grant without the principal — honest gate.
    return {
      outcome: 'pending-grants', assignmentGuid: '', roleName, roleGuid, scope, principalId: null,
      grantScript: grantScriptFor(roleGuid, null, scope),
      detail:
        'Could not resolve the Console UAMI principal id. Set LOOM_UAMI_PRINCIPAL_ID on the Console app ' +
        '(wired by admin-plane/main.bicep), then re-attach or run the grant command.',
    };
  }

  const sub = subFromArmId(scope);
  if (!sub) {
    return {
      outcome: 'error', assignmentGuid: '', roleName, roleGuid, scope, principalId,
      detail: 'Could not derive the subscription from the ARM resource id.',
    };
  }

  const assignmentGuid = deterministicAssignmentGuid(scope, roleGuid, principalId);
  const roleDefinitionId = `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/${roleGuid}`;
  const url = `${armBase()}${scope}/providers/Microsoft.Authorization/roleAssignments/${assignmentGuid}?api-version=${ROLE_ASSIGNMENTS_API}`;

  let token: string | undefined;
  try {
    token = (await uamiArmCredential().getToken(armScope()))?.token;
  } catch (e: any) {
    return {
      outcome: 'error', assignmentGuid, roleName, roleGuid, scope, principalId,
      detail: `Could not acquire an ARM token: ${e?.message || String(e)}`,
    };
  }
  if (!token) {
    return {
      outcome: 'error', assignmentGuid, roleName, roleGuid, scope, principalId,
      detail: 'Could not acquire an ARM token for the Console UAMI.',
    };
  }

  try {
    const res = await fetchImpl(url, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        properties: { roleDefinitionId, principalId, principalType: 'ServicePrincipal' },
      }),
    });

    if (res.ok) {
      return {
        outcome: 'granted', assignmentGuid, roleName, roleGuid, scope, principalId,
        httpStatus: res.status,
        detail: `Granted "${roleName}" to the Console UAMI at ${scope}.`,
      };
    }

    // Parse the ARM error code for the idempotent + authz-failure branches.
    const body: any = await res.json().catch(() => ({}));
    const code: string = body?.error?.code || body?.code || '';
    const message: string = body?.error?.message || body?.message || `HTTP ${res.status}`;

    // Already granted (same deterministic name, or a different name but same
    // principal+role at the scope) → treat as success. Re-attach is idempotent.
    if (res.status === 409 || /RoleAssignmentExists/i.test(code) || /already exists/i.test(message)) {
      return {
        outcome: 'already-exists', assignmentGuid, roleName, roleGuid, scope, principalId,
        httpStatus: res.status,
        detail: `The Console UAMI already holds "${roleName}" at ${scope}.`,
      };
    }

    // The UAMI lacks User Access Administrator / Owner on the scope → honest gate.
    if (res.status === 403 || /AuthorizationFailed/i.test(code)) {
      return {
        outcome: 'pending-grants', assignmentGuid, roleName, roleGuid, scope, principalId,
        httpStatus: res.status,
        grantScript: grantScriptFor(roleGuid, principalId, scope),
        detail:
          `The Console UAMI cannot grant itself "${roleName}" here (needs User Access Administrator / ` +
          `Owner on the resource). Run the grant command as an owner of the resource, then Refresh.`,
      };
    }

    return {
      outcome: 'error', assignmentGuid, roleName, roleGuid, scope, principalId,
      httpStatus: res.status,
      grantScript: grantScriptFor(roleGuid, principalId, scope),
      detail: `Role grant failed: ${message}`,
    };
  } catch (e: any) {
    return {
      outcome: 'error', assignmentGuid, roleName, roleGuid, scope, principalId,
      grantScript: grantScriptFor(roleGuid, principalId, scope),
      detail: `Role grant request failed: ${e?.message || String(e)}`,
    };
  }
}
