/**
 * R30 fragment - the 'health' (LHDS) domain slice of ENV_CHECKS (W1-7).
 *
 * Four gates guard the Health Data Services tenant surface. ./index.ts merges
 * this array into ENV_CHECKS; lib/gates/registry/health.ts carries the matching
 * GATE_META (surfaces + Fix-it). Import ONLY from './core' here - never
 * './index' (barrel-cycle rule).
 *
 * WHY THESE ARE NOT RED ON AN ESTATE THAT NEVER TURNED HEALTH ON.
 *  - `health-control-plane` is `optIn`: LHDS is a cost-material opt-in
 *    (healthEnabled=false in every *-health.bicepparam; a class-S stamp is
 *    ~$8k/month), so an estate without it reads the neutral opt-in state, not a
 *    misconfiguration. That is the narrow allowance in auto-bind-by-default.md
 *    ("a cost-material opt-in the operator has explicitly chosen to keep
 *    opt-in; it must be listed in the gate registry with that reason").
 *  - The other three use `appliesWhenPresent`: they say nothing until the
 *    component they guard is deployed, then apply in FULL.
 *
 * Every LOOM_HEALTH_* var here is produced by the health deploy
 * (platform/fiab/bicep/health.bicep outputs -> the Console's apps[] env). The
 * admin-plane wiring is owned by the bicep lane; until it lands an operator
 * sets them through the gate's Fix-it (EDITABLE_ENV is derived from these specs).
 */
import { VALUE_HINT, type EnvSpec } from './core';

// VALUE_HINT lives in ./core (not this lane's file). It is a mutable exported
// record, so the placeholders the Fix-it input shows are added here, beside the
// specs that need them, rather than editing the shared file.
Object.assign(VALUE_HINT, {
  LOOM_HEALTH_CP_URL: 'https://<loom-health-cp-fqdn>  (no trailing path)',
  LOOM_HEALTH_CP_AUDIENCE: 'api://<loom-health-cp-app-id>  (an audience loom-health-cp accepts)',
  LOOM_HEALTH_DEFAULT_STAMP_ID: '<stamp-id>  (a registered, healthy stamp)',
  LOOM_HEALTH_GOV_STAMP_ID: '<gov-stamp-id>  (set once a Gov stamp is registered)',
  LOOM_HEALTH_GOV_IMAGE_ATTESTATION: '<workflow-run-id of the Trivy + cosign verification>',
  LOOM_HEALTH_LAKEHOUSE_ISOLATION: 'verified',
} satisfies Record<string, string>);

export const HEALTH_ENV_CHECKS: EnvSpec[] = [
  {
    id: 'health-control-plane', category: 'azure-services',
    title: 'Health control plane (loom-health-cp)', severity: 'recommended',
    required: ['LOOM_HEALTH_CP_URL', 'LOOM_HEALTH_CP_AUDIENCE'],
    // Cost-material opt-in, see the file header.
    optIn: true,
    rejectUnreachableUrls: ['LOOM_HEALTH_CP_URL'],
    remediation: 'Set LOOM_HEALTH_CP_URL (the HTTPS base URL of loom-health-cp) and LOOM_HEALTH_CP_AUDIENCE (an audience it accepts, from LOOM_HEALTH_CP_AUDIENCE on the service). The control plane is deployed by platform/fiab/bicep/health.bicep through .github/workflows/deploy-health.yml (run_mode=full with control_plane_audiences set). The Console managed identity must be listed in LOOM_HEALTH_CP_ALLOWED_CALLER_APP_IDS and hold the HealthCP.Admin app role.',
    provisionedBy: 'platform/fiab/bicep/health.bicep -> modules/health/control-plane.bicep (its own deployment unit; dispatch-only deploy-health.yml)',
    role: 'HealthCP.Admin app role on the loom-health-cp app registration (Console UAMI)',
  },
  {
    id: 'health-stamp-capacity', category: 'azure-services',
    title: 'Health stamp with capacity for a new tenant', severity: 'recommended',
    required: ['LOOM_HEALTH_DEFAULT_STAMP_ID'],
    warnOnMiss: true,
    appliesWhenPresent: { envVar: 'LOOM_HEALTH_CP_URL', notDeployedDetail: 'the health control plane is not deployed, so there are no stamps to place tenants on.' },
    remediation: 'Set LOOM_HEALTH_DEFAULT_STAMP_ID to a stamp that is registered and healthy in the control plane. If none exists, deploy one with .github/workflows/deploy-health.yml (run_mode=full): it creates the stamp resource group, AKS, PostgreSQL, Event Hubs and Key Vault. A tenant is created only on a healthy stamp, and the create is refused with the stamp name and status otherwise.',
    provisionedBy: 'platform/fiab/bicep/health.bicep -> modules/health/stamp.bicep',
  },
  {
    id: 'health-gov-image-gate', category: 'security',
    title: 'Gov health image lane: vulnerability scan + signature verified', severity: 'recommended',
    required: ['LOOM_HEALTH_GOV_IMAGE_ATTESTATION'],
    warnOnMiss: true,
    appliesWhenPresent: { envVar: 'LOOM_HEALTH_GOV_STAMP_ID', notDeployedDetail: 'no Gov health stamp is registered, so the Gov image lane is not in the rollout path.' },
    remediation: 'No operator action produces this value. The Gov image lanes have no Trivy critical-vulnerability scan or cosign verification yet (#4584). Until those steps exist and pass, a Gov health stamp must not be rolled out; when they land, the lane records the verifying workflow run id here.',
    provisionedBy: 'Gov image lanes (gov-build-images / gov-provision-dataplane-images) once #4584 adds the Trivy + cosign steps',
  },
  {
    id: 'health-lakehouse-isolation', category: 'security',
    title: 'Lakehouse isolation prerequisite for the health sink', severity: 'recommended',
    required: ['LOOM_HEALTH_LAKEHOUSE_ISOLATION'],
    warnOnMiss: true,
    // A value that means "not verified" must not satisfy the gate that exists to detect it.
    rejectValues: { LOOM_HEALTH_LAKEHOUSE_ISOLATION: ['false', '0', 'off', 'no', 'unverified'] },
    appliesWhenPresent: { envVar: 'LOOM_HEALTH_CP_URL', notDeployedDetail: 'the health control plane is not deployed, so no health data can reach a lakehouse.' },
    remediation: 'Set LOOM_HEALTH_LAKEHOUSE_ISOLATION=verified only after the lakehouse isolation prerequisite is deployed AND verified on this estate (deployed, not merely merged). Until then the lakehouse sink stays disabled. Tracked as the ADR-016 prerequisite / decision Q7.',
    provisionedBy: 'Loom image roll carrying the lakehouse workspace-isolation fix; confirmed by the operator after a live check',
  },
];
