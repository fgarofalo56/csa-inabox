/**
 * R30 fragment - the 'health' (LHDS) domain slice of GATE_META (W1-7). Entries
 * sit beside their ENV_CHECKS spec in lib/admin/env-checks/health.ts; ./index.ts
 * merges this into the exported GATE_META. Import ONLY from './types' here -
 * never './index' (barrel-cycle rule).
 *
 * The Fix-it kinds are the strongest each gate honestly supports today:
 *  - `env-picker` where the fix IS an env write the Console can apply;
 *  - `wizard` where the fix is a platform deploy or a state this console cannot
 *    produce, with the exact action in `grantNote`.
 * `provision` is deliberately NOT used for the stamp: it needs a real
 * `workflow_dispatch` input that feeds a bicep parameter, and deploy-health.yml
 * has run_mode / control_plane_audiences but no stamp-enable input, so a
 * `provision` descriptor naming one would be the silent no-op
 * provision-check.ts exists to refuse.
 */
import type { GateMeta } from './types';

const TENANT_SURFACES = [
  { path: '/items/health-tenant/*', label: 'Health tenant editor' },
  { path: '/api/health/tenants/*', label: 'Health tenant routes' },
];

export const HEALTH_GATE_META: Record<string, GateMeta> = {
  'health-control-plane': {
    surfaces: TENANT_SURFACES,
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Opt-in by cost: LHDS is not deployed unless an operator runs deploy-health.yml with run_mode=full and control_plane_audiences set. Once deployed, set the two values here.',
  },
  'health-stamp-capacity': {
    surfaces: TENANT_SURFACES,
    fixit: {
      kind: 'wizard',
      grantNote: 'Run .github/workflows/deploy-health.yml (run_mode=full) to deploy a stamp, wait for it to register healthy in the control plane, then set LOOM_HEALTH_DEFAULT_STAMP_ID to its id here. A tenant is never placed on a stamp that is creating, draining, paused or evacuated.',
    },
  },
  'health-gov-image-gate': {
    surfaces: [{ path: '/items/health-tenant/*', label: 'Health tenant editor (Gov stamp rollout)' }],
    fixit: {
      kind: 'wizard',
      grantNote: 'Nothing for an operator to set by hand: the Gov image lanes must first gain a Trivy critical-vulnerability scan and cosign verification (#4584). That lane then records its verifying run id in LOOM_HEALTH_GOV_IMAGE_ATTESTATION. Until then a Gov health stamp is not rolled out.',
    },
  },
  'health-auth-graph-consent': {
    surfaces: [{ path: '/items/health-tenant/*', label: 'Health tenant editor (authorization server group check)' }],
    fixit: {
      kind: 'wizard',
      grantNote: 'A Global Administrator grants admin consent to the authorization server identity for its Microsoft Graph group-membership permission (open the consent URL the control plane returns at /api/health/auth/readiness when graphConsentUrl is set). Then set LOOM_HEALTH_AUTH_GRAPH_CONSENT=granted here. This is tenant-level consent only a Global Administrator can give.',
    },
    autoResolveNote: 'Cannot auto-resolve: Entra admin consent is a tenant-level act only a Global Administrator can perform (the allowed exception in auto-bind-by-default.md).',
  },
  'health-lakehouse-isolation': {
    surfaces: [{ path: '/items/health-tenant/*', label: 'Health tenant editor (lakehouse sink)' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Set to "verified" only after the isolation prerequisite is deployed and checked live on this estate; the sink stays disabled until then.',
  },
};
