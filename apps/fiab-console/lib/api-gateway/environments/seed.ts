/** Environment catalog seed (D9): Mosaic's six built-ins + Loom pipeline stage names not already present. */
import type { EnvironmentCatalogDoc, EnvironmentDef } from './types';
import { ENVIRONMENT_CATALOG_ID } from './types';

export const BUILT_IN_ENVIRONMENTS: readonly EnvironmentDef[] = [
  { key: 'development', displayName: 'Development', description: 'Day-to-day build and experimentation.', badgeColor: 'informative', isProductionClass: false, aliases: ['dev', 'develop'], exceptions: [], builtIn: true },
  { key: 'test', displayName: 'Test', description: 'Automated and manual testing.', badgeColor: 'brand', isProductionClass: false, aliases: ['tst', 'testing'], exceptions: [], builtIn: true },
  { key: 'qc', displayName: 'QC', description: 'Quality control and acceptance checks.', badgeColor: 'important', isProductionClass: false, aliases: ['qa'], exceptions: [], builtIn: true },
  { key: 'staging', displayName: 'Staging', description: 'Pre-production rehearsal.', badgeColor: 'warning', isProductionClass: false, aliases: ['stage', 'stg', 'uat', 'preprod'], exceptions: [], builtIn: true },
  { key: 'production', displayName: 'Production', description: 'Live, user-facing workloads.', badgeColor: 'danger', isProductionClass: true, aliases: ['prod', 'prd'], exceptions: [], builtIn: true },
  { key: 'sandbox', displayName: 'Sandbox', description: 'Disposable experiments.', badgeColor: 'subtle', isProductionClass: false, aliases: ['sbx', 'poc'], exceptions: [], builtIn: true },
];

export function slugifyEnvironmentKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

/**
 * Seed catalog. `pipelineStageNames` are Loom deployment-pipeline stage names;
 * a name matching an existing key, display name or alias (case-insensitive) is
 * not added again. Added ones are custom (deletable), not production-class.
 */
export function seedCatalog(tenantId: string, pipelineStageNames: readonly string[] = []): EnvironmentCatalogDoc {
  const environments: EnvironmentDef[] = BUILT_IN_ENVIRONMENTS.map((e) => ({ ...e, aliases: [...e.aliases], exceptions: [...e.exceptions] }));
  const known = new Set<string>();
  for (const env of environments) {
    known.add(env.key);
    known.add(env.displayName.toLowerCase());
    env.aliases.forEach((a) => known.add(a.toLowerCase()));
  }
  for (const raw of pipelineStageNames) {
    const name = raw.trim();
    const slug = slugifyEnvironmentKey(name);
    if (!name || !slug || known.has(name.toLowerCase()) || known.has(slug)) continue;
    known.add(name.toLowerCase());
    known.add(slug);
    environments.push({ key: slug, displayName: name, description: 'From a Loom deployment pipeline stage.', badgeColor: 'informative', isProductionClass: false, aliases: [], exceptions: [], builtIn: false });
  }
  return {
    id: ENVIRONMENT_CATALOG_ID,
    tenantId,
    docType: 'environmentCatalog',
    environments,
    settings: { requireClassification: false },
  };
}
