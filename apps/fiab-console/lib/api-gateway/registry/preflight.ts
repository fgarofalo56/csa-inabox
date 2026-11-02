/**
 * API Gateway Plane — gateway preflight (W1-2).
 *
 * Answers, for the host identity (Console UAMI) and one APIM service scope:
 * can it read, can it write, and if not which built-in role is missing and the
 * exact `az` command that grants it.
 *
 *   1. Effective permissions at the service scope
 *      (GET {scope}/providers/Microsoft.Authorization/permissions) evaluated
 *      against the actions/notActions wildcards.
 *   2. Probe fallback when the permissions call itself is refused or fails:
 *      GET the service. A 200 proves read; write cannot be proven without
 *      writing, so it stays false and no write remediation is claimed (R7:
 *      never assert what was not established).
 *
 * The principal named in the remediation is the `oid` claim of the ARM token
 * that was actually used - never a guess.
 */
import type { GatewayAccess, MissingRole, ParsedApimResourceId } from './types';

/** Built-in role definition ids (same in every cloud). */
export const ROLE_READER = { id: 'acdd72a7-3385-48ef-bd42-f606fba81ae7', name: 'Reader' } as const;
export const ROLE_APIM_CONTRIBUTOR = {
  id: '312a565d-c81f-4fd8-895a-4e21e48d571c',
  name: 'API Management Service Contributor',
} as const;
export const ROLE_MONITORING_READER = { id: '43d0d8ad-25c7-4714-9337-8ba259a9fe05', name: 'Monitoring Reader' } as const;

export const ACTION_READ = 'Microsoft.ApiManagement/service/read';
export const ACTION_WRITE = 'Microsoft.ApiManagement/service/write';

const PERMISSIONS_API = '2022-04-01';
const APIM_API = '2024-06-01-preview';

/** Minimal ARM seam; tests inject a double, production uses arm-port.ts. */
export interface ArmPort {
  getToken(): Promise<string>;
  get(url: string, token: string): Promise<{ status: number; body: unknown }>;
  armBase(): string;
}

interface PermissionEntry {
  actions?: string[];
  notActions?: string[];
}

function wildcardToRegExp(pattern: string): RegExp {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc}$`, 'i');
}

/** True when `action` is granted by at least one entry's actions minus that entry's notActions. */
export function actionAllowed(entries: PermissionEntry[], action: string): boolean {
  return entries.some((e) => {
    const granted = (e.actions ?? []).some((a) => wildcardToRegExp(a).test(action));
    if (!granted) return false;
    return !(e.notActions ?? []).some((a) => wildcardToRegExp(a).test(action));
  });
}

/** Decode the `oid` claim from a JWT without verifying it (we only name the principal). */
export function oidFromToken(token: string): string | undefined {
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const oid = (JSON.parse(json) as { oid?: unknown }).oid;
    return typeof oid === 'string' && oid ? oid : undefined;
  } catch {
    return undefined;
  }
}

export function buildMissingRole(
  role: { id: string; name: string },
  scope: string,
  principalId: string | undefined,
): MissingRole {
  const assignee = principalId ?? '<principal-object-id>';
  return {
    roleDefinitionId: role.id,
    roleName: role.name,
    scope,
    azCommand:
      `az role assignment create --assignee-object-id ${assignee} ` +
      `--assignee-principal-type ServicePrincipal --role ${role.id} --scope ${scope}`,
  };
}

export async function preflightGateway(
  target: ParsedApimResourceId,
  arm: ArmPort,
  now: () => Date = () => new Date(),
): Promise<GatewayAccess> {
  const scope = target.resourceId;
  const base = arm.armBase();
  const token = await arm.getToken();
  const principalId = oidFromToken(token);

  let entries: PermissionEntry[] | undefined;
  try {
    const r = await arm.get(
      `${base}${scope}/providers/Microsoft.Authorization/permissions?api-version=${PERMISSIONS_API}`,
      token,
    );
    const value = (r.body as { value?: unknown } | null)?.value;
    if (r.status === 200 && Array.isArray(value)) entries = value as PermissionEntry[];
  } catch {
    entries = undefined;
  }

  const checkedAt = now().toISOString();
  if (entries) {
    const canRead = actionAllowed(entries, ACTION_READ);
    const canWrite = actionAllowed(entries, ACTION_WRITE);
    const missing = !canRead
      ? buildMissingRole(ROLE_READER, scope, principalId)
      : !canWrite
        ? buildMissingRole(ROLE_APIM_CONTRIBUTOR, scope, principalId)
        : undefined;
    return { canRead, canWrite, ...(missing ? { missingRole: missing } : {}), checkedAt, source: 'permissions', principalId };
  }

  // Probe fallback: the permissions call did not answer, so read the service itself.
  let probeOk = false;
  try {
    const r = await arm.get(`${base}${scope}?api-version=${APIM_API}`, token);
    probeOk = r.status === 200;
  } catch {
    probeOk = false;
  }
  return {
    canRead: probeOk,
    canWrite: false,
    ...(probeOk ? {} : { missingRole: buildMissingRole(ROLE_READER, scope, principalId) }),
    checkedAt,
    source: 'probe',
    principalId,
  };
}
