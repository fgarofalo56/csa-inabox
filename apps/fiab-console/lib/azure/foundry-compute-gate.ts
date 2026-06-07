/**
 * Honest-gate payload for the Compute Instance lifecycle routes
 * (list / start / status).
 *
 * The Console UAMI needs the **AzureML Compute Operator** role on the AML /
 * Foundry workspace to enumerate, start, stop and read compute instances.
 * `AzureML Data Scientist` (already granted) does NOT include
 * `Microsoft.MachineLearningServices/workspaces/computes/*` — so list/start/
 * status come back 403 until the operator role is granted.
 *
 * When ARM returns 403, the routes surface this structured gate so the UI can
 * render a Fluent MessageBar (intent="warning") naming the exact role, role
 * GUID, and resource — and pointing at the bicep module + bootstrap workflow
 * that grant it. See .claude/rules/no-vaporware.md and ui-parity.md.
 */
export const AML_COMPUTE_OPERATOR_ROLE = 'AzureML Compute Operator';
export const AML_COMPUTE_OPERATOR_ROLE_ID =
  'e503ece1-11d0-4e8e-8e2c-7a6c3bf38815';

export interface ComputeRoleGate {
  ok: false;
  roleGate: true;
  error: string;
  requiredRole: string;
  roleId: string;
  resource: string;
  grant: { bicep: string; workflow: string };
}

/**
 * Build the honest-gate body for a 403 on a compute lifecycle action.
 * @param action human-readable verb, e.g. "start compute instances".
 */
export function computeRoleGate(action: string): ComputeRoleGate {
  return {
    ok: false,
    roleGate: true,
    error:
      `Missing role: the Console identity requires the "${AML_COMPUTE_OPERATOR_ROLE}" ` +
      `role on the AML / Foundry workspace to ${action}. Grant it via the bicep ` +
      `module (platform/fiab/bicep/modules/admin-plane/ai-foundry.bicep) or re-run ` +
      `the csa-loom-post-deploy-bootstrap workflow.`,
    requiredRole: AML_COMPUTE_OPERATOR_ROLE,
    roleId: AML_COMPUTE_OPERATOR_ROLE_ID,
    resource:
      'Microsoft.MachineLearningServices/workspaces (AML / AI Foundry hub workspace)',
    grant: {
      bicep: 'platform/fiab/bicep/modules/admin-plane/ai-foundry.bicep',
      workflow: '.github/workflows/csa-loom-post-deploy-bootstrap.yml',
    },
  };
}
