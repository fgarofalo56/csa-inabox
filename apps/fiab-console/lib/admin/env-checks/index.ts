/**
 * CSA Loom declarative config layer — public entry point (R30 fragment split).
 *
 * Formerly the single lib/admin/env-checks.ts monolith; now a per-domain
 * fragment directory merged here. The PUBLIC API is unchanged — every importer
 * keeps using '@/lib/admin/env-checks' (this index) and receives the exact
 * same exports: ENV_CHECKS, EnvSpec, evalEnv, VALUE_HINT, CTX, envVarFix and
 * all the audit types (./core), plus the per-domain arrays for targeted use.
 *
 * Adding an env var? Edit ONLY your domain fragment (./identity, ./data-plane,
 * …) — that is the whole point of the split: env-adding PRs no longer
 * serialize on one 1,300-line array. Fragments import ONLY from ./core —
 * never from this index (barrel-cycle rule, WS-E1 gotcha).
 */
export * from './core';
import type { EnvSpec } from './core';
import { IDENTITY_ENV_CHECKS } from './identity';
import { DATA_PLANE_ENV_CHECKS } from './data-plane';
import { PERMISSIONS_ENV_CHECKS } from './permissions';
import { AZURE_SERVICES_ENV_CHECKS } from './azure-services';
import { AI_COPILOT_ENV_CHECKS } from './ai-copilot';
import { ENRICHMENT_ENV_CHECKS } from './enrichment';
import { BUILDERS_ENV_CHECKS } from './builders';
import { CATALOG_GOVERNANCE_ENV_CHECKS } from './catalog-governance';
import { SECURITY_ENV_CHECKS } from './security';
import { OBSERVABILITY_ENV_CHECKS } from './observability';

export { IDENTITY_ENV_CHECKS } from './identity';
export { DATA_PLANE_ENV_CHECKS } from './data-plane';
export { PERMISSIONS_ENV_CHECKS } from './permissions';
export { AZURE_SERVICES_ENV_CHECKS } from './azure-services';
export { AI_COPILOT_ENV_CHECKS } from './ai-copilot';
export { ENRICHMENT_ENV_CHECKS } from './enrichment';
export { BUILDERS_ENV_CHECKS } from './builders';
export { CATALOG_GOVERNANCE_ENV_CHECKS } from './catalog-governance';
export { SECURITY_ENV_CHECKS } from './security';
export { OBSERVABILITY_ENV_CHECKS } from './observability';

/** The declarative env-presence checks (the backbone of the audit) — the
 * per-domain fragments merged into the SAME array shape as before the split. */
export const ENV_CHECKS: EnvSpec[] = [
  ...IDENTITY_ENV_CHECKS,
  ...DATA_PLANE_ENV_CHECKS,
  ...PERMISSIONS_ENV_CHECKS,
  ...AZURE_SERVICES_ENV_CHECKS,
  ...AI_COPILOT_ENV_CHECKS,
  ...ENRICHMENT_ENV_CHECKS,
  ...BUILDERS_ENV_CHECKS,
  ...CATALOG_GOVERNANCE_ENV_CHECKS,
  ...SECURITY_ENV_CHECKS,
  ...OBSERVABILITY_ENV_CHECKS,
];
