/**
 * #5368 - THE DEPLOY-SP GOVERNANCE SEED GRANTS, asserted against the COMPILED ARM.
 *
 * `scripts/csa-loom/seed-governance.sh` upserts into `tenant-settings` and
 * `governance-domains`. `loom-console-cosmos.bicep` grants the deploy principal
 * Built-in Data Contributor on THOSE TWO CONTAINERS ONLY, reusing #5367's
 * metadata-only role. Same reading method as feature-grant-seed-bicep.test.ts:
 * the emitted ARM in deploy-templates/main.json (kept byte-identical to a fresh
 * build by the guardrails deploy-template-sync check).
 *
 * Each `it` names the value that breaks it (assertion-design.md).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');
const ARM_PATH =
  process.env.GOVERNANCE_SEED_ARM_PATH ??
  resolve(REPO_ROOT, 'apps/fiab-console/deploy-templates/main.json');

const BUILT_IN_DATA_CONTRIBUTOR = '00000000-0000-0000-0000-000000000002';
const DEPLOYER = "[parameters('deployerServicePrincipalId')]";
const ACCOUNT_SCOPE =
  "[resourceId('Microsoft.DocumentDB/databaseAccounts', parameters('accountName'))]";
const scopeFor = (container: string) =>
  `[format('{0}/dbs/{1}/colls/{2}', resourceId('Microsoft.DocumentDB/databaseAccounts', parameters('accountName')), variables('loomDatabase'), '${container}')]`;
const CONTAINERS = ['tenant-settings', 'governance-domains'];

interface Arm {
  type?: string;
  name?: string;
  condition?: string;
  copy?: { name?: string; count?: string };
  properties?: Record<string, unknown>;
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function* walk(node: unknown): Generator<Arm> {
  const res = rec(node).resources;
  const list: unknown[] = Array.isArray(res) ? res : typeof res === 'object' && res !== null ? Object.values(res) : [];
  for (const r of list) {
    if (typeof r !== 'object' || r === null) continue;
    yield r as Arm;
    const t = rec(rec(r).properties).template;
    if (t) yield* walk(t);
  }
}

const raw = readFileSync(ARM_PATH, 'utf8');
const all = [...walk(JSON.parse(raw))];
const assignments = all.filter((r) => r.type?.endsWith('databaseAccounts/sqlRoleAssignments'));
const roleDefs = all.filter((r) => r.type?.endsWith('sqlRoleDefinitions'));
const scopeOf = (r: Arm) => String(r.properties?.scope ?? '');
const govLoop = assignments.find((r) => r.copy?.name === 'governanceSeedDataAssignments');

describe('#5368 deploy-SP governance seed grants (compiled ARM)', () => {
  it('CONTROL: the walker sees a real population incl. the #5367 grant it must not disturb', () => {
    // A walker that found nothing would pass everything below vacuously.
    expect(all.length).toBeGreaterThan(100);
    expect(assignments.some((r) => scopeOf(r) === scopeFor('feature-permissions'))).toBe(true);
    expect(govLoop, 'governanceSeedDataAssignments loop').toBeDefined();
  });

  it('the grant is a 2-iteration loop whose scope is CONTAINER level for each declared name', () => {
    // Breaks if the scope becomes the account / `dbs/loom` (no `/colls/`), or if a
    // third container joins the list (count != 2) - checked via the variable's value.
    expect(raw).toMatch(/"governanceSeedContainers":\s*\[\s*"tenant-settings",\s*"governance-domains"\s*\]/);
    expect(govLoop!.copy?.count).toBe("[length(variables('governanceSeedContainers'))]");
    expect(scopeOf(govLoop!)).toBe(
      "[format('{0}/dbs/{1}/colls/{2}', resourceId('Microsoft.DocumentDB/databaseAccounts', parameters('accountName')), variables('loomDatabase'), variables('governanceSeedContainers')[copyIndex()])]",
    );
  });

  it('principal is the DEPLOYER param, role is Built-in Data Contributor, gate is the #5367 gate', () => {
    // Breaks if principal becomes a GUID literal (public repo: no oids), the role
    // becomes Data Reader (...0001) or a custom one, or the gate drops skipRoleGrants.
    expect(govLoop!.properties?.principalId).toBe(DEPLOYER);
    expect(String(govLoop!.properties?.roleDefinitionId)).toContain(
      `sqlRoleDefinitions/${BUILT_IN_DATA_CONTRIBUTOR}`,
    );
    expect(govLoop!.condition).toBe("[variables('grantDeployFeatureGrantSeed')]");
  });

  it('no second metadata role was minted: exactly ONE custom role holds readMetadata for the deploy seed', () => {
    // Breaks if a governance-specific metadata role/assignment is added (#5367's is reused).
    const seedRoles = roleDefs.filter((r) => /loom-feature-grant-seed-metadata-reader/.test(String(r.name)));
    expect(seedRoles.length).toBe(1);
    expect(roleDefs.some((r) => /governance/i.test(String(r.name)))).toBe(false);
  });

  it('deployer-principal grants are EXACTLY the known set (no widening, no extra container)', () => {
    // Population: brain loop, #5367 seed, #5367 metadata, brain metadata, governance loop.
    // Breaks on any additional assignment for the deployer param, e.g. account scope.
    const names = assignments
      .filter((r) => r.properties?.principalId === DEPLOYER)
      .map((r) =>
        r.copy?.name === 'brainScanDataAssignments'
          ? 'brain-loop'
          : r.copy?.name === 'governanceSeedDataAssignments'
            ? 'governance-loop'
            : scopeOf(r) === scopeFor('feature-permissions')
              ? 'feature-seed'
              : scopeOf(r) === ACCOUNT_SCOPE
                ? 'metadata:' + (String(r.name).includes('feature-grant-seed') ? 'feature' : 'brain')
                : 'UNEXPECTED:' + scopeOf(r),
      );
    expect(names.sort()).toEqual(['brain-loop', 'feature-seed', 'governance-loop', 'metadata:brain', 'metadata:feature']);
  });

  it.each(CONTAINERS)('container %s is DECLARED, partitioned /tenantId, default indexing, no TTL', (name) => {
    // The live containers (read 2026-11-19) are /tenantId Hash, consistent+automatic,
    // ttl null. Breaks if the key drifts or a TTL/unique key is added (data-affecting PUT).
    const decl = all.find((r) => r.type?.endsWith('sqlDatabases/containers') && r.copy?.name === 'governanceSeedContainerDecls');
    expect(decl, 'governanceSeedContainerDecls loop').toBeDefined();
    const res = rec(decl!.properties?.resource);
    expect(res.id).toBe("[variables('governanceSeedContainers')[copyIndex()]]");
    expect(JSON.stringify(res.partitionKey)).toBe('{"paths":["/tenantId"],"kind":"Hash"}');
    expect(JSON.stringify(res.indexingPolicy)).toBe('{"indexingMode":"consistent","automatic":true}');
    expect(res.defaultTtl).toBeUndefined();
    expect(res.uniqueKeyPolicy).toBeUndefined();
    expect(raw).toContain(`"${name}"`);
  });
});
