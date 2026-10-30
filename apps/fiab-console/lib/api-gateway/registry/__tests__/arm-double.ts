/** Test double for the registry ArmPort + a JWT builder (the preflight reads `oid` from the token). */
import type { ArmPort } from '../preflight';

export const OID = '9f1c3a52-77d0-4b0e-8a64-0d6a5a1c2e11';

export function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

export type Permissions = Array<{ actions?: string[]; notActions?: string[] }>;

export interface ArmDoubleOpts {
  /** undefined => the permissions call answers 403 (forces the probe fallback). */
  permissions?: Permissions;
  /** Status the direct service GET (probe) answers with. */
  probeStatus?: number;
  token?: string;
}

export function armDouble(o: ArmDoubleOpts = {}): ArmPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    armBase: () => 'https://management.azure.com',
    async getToken() {
      return o.token ?? fakeJwt({ oid: OID });
    },
    async get(url) {
      calls.push(url);
      if (url.includes('/providers/Microsoft.Authorization/permissions')) {
        return o.permissions
          ? { status: 200, body: { value: o.permissions } }
          : { status: 403, body: { error: { code: 'AuthorizationFailed' } } };
      }
      return { status: o.probeStatus ?? 404, body: {} };
    },
  };
}

export const SUB = '11111111-2222-3333-4444-555555555555';
export const GW_ID = `/subscriptions/${SUB}/resourceGroups/rg-csa-loom-admin/providers/Microsoft.ApiManagement/service/apim-csa-loom-eastus2`;

export const READER_PERMS: Permissions = [{ actions: ['*/read'], notActions: [] }];
export const CONTRIBUTOR_PERMS: Permissions = [{ actions: ['Microsoft.ApiManagement/service/*'], notActions: [] }];
