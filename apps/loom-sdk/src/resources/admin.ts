import { HttpTransport, enc } from '../http.js';
import type { AssignWorkspaceRoleInput, GrantCapabilityInput, AdminResult } from '../types.js';

/**
 * Admin (escalation) operations — the surface M5 `loom-admin` builds on. Each
 * method wraps a REAL Console route that performs its OWN server-side admin
 * authorization; the SDK never re-implements that check. The BFF is the
 * authoritative escalation boundary:
 *
 *   • `assignWorkspaceRole` → POST /api/workspaces/{id}/role-assignments
 *       route requires workspace owner / Admin / domain-admin / tenant-admin.
 *   • `grantCapability`     → POST /api/admin/permissions/grants
 *       route enforces the `admin.permissions` capability at Contributor+, and
 *       emits a SIEM audit event for the privilege change.
 *   • `resolveGate`         → POST /api/admin/gates/{id}/resolve
 *       route enforces `admin.env-config` Admin + PDP, and ALLOW-LISTS the keys
 *       to that gate's registered settings (no side-channel env writes).
 *
 * Because these grant access, the recommended credential is an interactive
 * Entra session (cookie), not a PAT — and M5 refuses a PAT unconditionally.
 */
export class AdminResource {
  constructor(private readonly http: HttpTransport) {}

  /** Assign a workspace RBAC role to a principal. */
  async assignWorkspaceRole(workspaceId: string, input: AssignWorkspaceRoleInput): Promise<AdminResult> {
    return this.http.request<AdminResult>('POST', `/api/workspaces/${enc(workspaceId)}/role-assignments`, {
      principalId: input.principalId,
      principalType: input.principalType,
      displayName: input.displayName,
      role: input.role,
    });
  }

  /** Grant (upsert) a feature-capability role to a principal. */
  async grantCapability(input: GrantCapabilityInput): Promise<AdminResult> {
    return this.http.request<AdminResult>('POST', '/api/admin/permissions/grants', {
      capabilityId: input.capabilityId,
      principalId: input.principalId,
      principalType: input.principalType ?? 'user',
      role: input.role,
      principalDisplayName: input.principalDisplayName,
      principalUpn: input.principalUpn,
    });
  }

  /**
   * Resolve (fix) a deployment gate by supplying its required env values. The
   * route rejects any key not registered for the gate, so this can only set the
   * gate's own settings — never an arbitrary env var or secret.
   */
  async resolveGate(gateId: string, values: Record<string, string>): Promise<AdminResult> {
    return this.http.request<AdminResult>('POST', `/api/admin/gates/${enc(gateId)}/resolve`, { values });
  }
}
