/**
 * M5 `loom-admin` tools — the ESCALATION surface (PRP §4.2, §5.4). These grant
 * access and resolve deployment gates: the highest-blast-radius operations in
 * the toolkit. Security is layered and deny-by-default:
 *
 *   • Server master-switch — default-OFF (`LOOM_MCP_ADMIN_ENABLED`), §5.4.1.
 *   • No PAT — an API token never reaches an admin tool, §5.1 (server policy
 *     `rejectPat:true`, extending `patCannotMint`).
 *   • Admin scope required — the core scope-floor (`minScope:'admin'`) AND an
 *     explicit server-wide admin check (`requireAdmin:true`), §5.4(a).
 *   • Dry-run by default — `apply` (default false) returns the PLAN without
 *     mutating; `apply:true` performs the real write, §5.4(b).
 *   • Mandatory audit with the TARGET principal — every call records who/what it
 *     would affect (§5.4(d), threaded via `audit.target`).
 *   • Authoritative escalation boundary is the BFF. Each tool calls a REAL
 *     server-guarded route that re-checks `isTenantAdmin`/`enforceCapability`/PDP
 *     and caps the grant to the caller's own rights — this MCP layer does NOT
 *     re-implement that check (§5.1), it adds a stricter LOCAL floor on top.
 *
 * Denylist (§5.4(c)): no tool lists/reads/mints a PAT secret, reads a connection
 * string, or writes an arbitrary env var/secret. `gate.resolve` is allow-listed
 * server-side to the gate's own registered settings; `grant`/`role.assign` are
 * capped by the caller's own admin rights server-side. When in doubt, DENY.
 *
 * | tool                      | SDK call                                   | endpoint (via SDK)                          |
 * |---------------------------|--------------------------------------------|---------------------------------------------|
 * | loom.admin.role.assign   | admin.assignWorkspaceRole(wsId, input)     | POST /api/workspaces/{id}/role-assignments  |
 * | loom.admin.grant         | admin.grantCapability(input)               | POST /api/admin/permissions/grants          |
 * | loom.admin.gate.resolve  | admin.resolveGate(gateId, values)          | POST /api/admin/gates/{id}/resolve          |
 */
import { z } from 'zod';
import type { ToolSpec } from '../../core/types.js';

/** `apply` arg — every admin action is dry-run unless `apply === true`. */
const applyArg = z
  .boolean()
  .optional()
  .describe('Execute the admin action. Default false = DRY-RUN: returns the plan WITHOUT mutating. Set true to apply.');

function shouldApply(args: Record<string, unknown>): boolean {
  return args.apply === true;
}

/** The three M5 admin tools. All dry-run-default, admin-scoped, audited with a target. */
export function adminTools(): ToolSpec[] {
  return [
    {
      name: 'loom.admin.role.assign',
      title: 'Assign a workspace role',
      description:
        'Grant a principal a workspace RBAC role (Admin | Member | Contributor | Viewer) — ' +
        'POST /api/workspaces/{id}/role-assignments. The route enforces workspace/tenant admin server-side. ' +
        'DRY-RUN by default; pass apply:true to assign.',
      inputSchema: {
        workspaceId: z.string().describe('Workspace id (GUID).'),
        principalId: z.string().describe('Object id (GUID) of the User / Group / ServicePrincipal to grant.'),
        principalType: z.enum(['User', 'Group', 'ServicePrincipal']).describe('Principal type.'),
        displayName: z.string().min(1).describe('Display name for the assignment.'),
        role: z.enum(['Admin', 'Member', 'Contributor', 'Viewer']).describe('Workspace role to assign.'),
        apply: applyArg,
      },
      readOnly: false,
      minScope: 'admin',
      async run({ auth, args }) {
        const workspaceId = args.workspaceId as string;
        const input = {
          principalId: args.principalId as string,
          principalType: args.principalType as 'User' | 'Group' | 'ServicePrincipal',
          displayName: args.displayName as string,
          role: args.role as 'Admin' | 'Member' | 'Contributor' | 'Viewer',
        };
        const plan = {
          action: 'role.assign',
          method: 'POST',
          endpoint: `/api/workspaces/${workspaceId}/role-assignments`,
          body: input,
        };
        if (!shouldApply(args)) {
          return {
            data: { mode: 'dry-run', wouldMutate: true, plan, note: 'Re-invoke with apply:true to assign this role.' },
            audit: { mutation: 'planned', target: input.principalId },
          };
        }
        const result = await auth.client.admin.assignWorkspaceRole(workspaceId, input);
        return {
          data: { mode: 'applied', action: 'role.assign', result },
          audit: { mutation: 'applied', target: input.principalId },
        };
      },
    },
    {
      name: 'loom.admin.grant',
      title: 'Grant a feature capability',
      description:
        'Grant a principal a feature-capability role (Reader | Contributor | Admin) — ' +
        'POST /api/admin/permissions/grants. The route enforces the admin.permissions capability server-side and ' +
        'emits a SIEM audit event. DRY-RUN by default; pass apply:true to grant.',
      inputSchema: {
        capabilityId: z.string().describe('Capability id, e.g. admin.permissions, or workspace.<id>.'),
        principalId: z.string().describe('Object id (GUID) of the user/group to grant.'),
        principalType: z.enum(['user', 'group']).optional().describe('Principal type (default user).'),
        role: z.enum(['Reader', 'Contributor', 'Admin']).describe('Capability role to grant.'),
        principalDisplayName: z.string().optional().describe('Optional display name.'),
        principalUpn: z.string().optional().describe('Optional UPN.'),
        apply: applyArg,
      },
      readOnly: false,
      minScope: 'admin',
      async run({ auth, args }) {
        const input = {
          capabilityId: args.capabilityId as string,
          principalId: args.principalId as string,
          principalType: args.principalType as 'user' | 'group' | undefined,
          role: args.role as 'Reader' | 'Contributor' | 'Admin',
          principalDisplayName: args.principalDisplayName as string | undefined,
          principalUpn: args.principalUpn as string | undefined,
        };
        const plan = { action: 'grant', method: 'POST', endpoint: '/api/admin/permissions/grants', body: input };
        if (!shouldApply(args)) {
          return {
            data: { mode: 'dry-run', wouldMutate: true, plan, note: 'Re-invoke with apply:true to grant this capability.' },
            audit: { mutation: 'planned', target: input.principalId },
          };
        }
        const result = await auth.client.admin.grantCapability(input);
        return {
          data: { mode: 'applied', action: 'grant', result },
          audit: { mutation: 'applied', target: input.principalId },
        };
      },
    },
    {
      name: 'loom.admin.gate.resolve',
      title: 'Resolve a deployment gate',
      description:
        "Fix a deployment gate by supplying its required env values — POST /api/admin/gates/{id}/resolve. " +
        "The route ALLOW-LISTS keys to that gate's registered settings (no arbitrary env/secret writes) and audits " +
        'the change. DRY-RUN by default; pass apply:true to apply (a new revision rolls in ~1-2 min).',
      inputSchema: {
        gateId: z.string().describe('Gate id from the gate registry (GET /api/admin/gates).'),
        values: z
          .record(z.string())
          .describe("envVar -> value map; every key must be one of the gate's own registered settings."),
        apply: applyArg,
      },
      readOnly: false,
      minScope: 'admin',
      async run({ auth, args }) {
        const gateId = args.gateId as string;
        const values = args.values as Record<string, string>;
        // Do NOT echo the submitted values verbatim in the plan — they may be
        // secret-bearing (the core scrub is the backstop, but only surface the
        // KEYS here). The real values still flow to the route on apply.
        const plan = {
          action: 'gate.resolve',
          method: 'POST',
          endpoint: `/api/admin/gates/${gateId}/resolve`,
          keys: Object.keys(values),
        };
        if (!shouldApply(args)) {
          return {
            data: { mode: 'dry-run', wouldMutate: true, plan, note: 'Re-invoke with apply:true to resolve this gate.' },
            audit: { mutation: 'planned', target: gateId },
          };
        }
        const result = await auth.client.admin.resolveGate(gateId, values);
        return {
          data: { mode: 'applied', action: 'gate.resolve', result },
          audit: { mutation: 'applied', target: gateId },
        };
      },
    },
  ];
}
