/**
 * #5360 - THE DEPLOY-SP FEATURE-GRANT SEED GRANT, asserted against the COMPILED ARM.
 *
 * `csa-loom-post-deploy-bootstrap.yml` job `seed-automation-grant` writes ONE doc
 * into the `feature-permissions` Cosmos container as the deploy service principal.
 * `loom-console-cosmos.bicep` grants that principal Built-in Data Contributor on
 * THAT CONTAINER ONLY. Widening it (account / `dbs/loom` scope), pinning the
 * principal to a literal object id, or adding a grant on any other container are
 * the three defects this file exists to catch, and all three are invisible to
 * `az bicep build` (RC=0, zero diagnostics) - so the assertions read the emitted
 * ARM in `apps/fiab-console/deploy-templates/main.json`, which the guardrails
 * `deploy-template-sync` check keeps byte-identical to a fresh build.
 *
 * Each `it` names the value that breaks it (assertion-design.md).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');
const ARM_PATH =
  process.env.FEATURE_GRANT_ARM_PATH ??
  resolve(REPO_ROOT, 'apps/fiab-console/deploy-templates/main.json');

const BUILT_IN_DATA_CONTRIBUTOR = '00000000-0000-0000-0000-000000000002';
// The exact ARM expression the compiled scope must carry: account id + the
// `loom` database variable + the literal container name. Account scope would be
// the bare resourceId(...); dbs/loom scope would lack `/colls/`.
const EXPECTED_SCOPE =
  "[format('{0}/dbs/{1}/colls/{2}', resourceId('Microsoft.DocumentDB/databaseAccounts', parameters('accountName')), variables('loomDatabase'), 'feature-permissions')]";
const ACCOUNT_SCOPE =
  "[resourceId('Microsoft.DocumentDB/databaseAccounts', parameters('accountName'))]";

interface Arm {
  type?: string;
  name?: string;
  condition?: string;
  copy?: { name?: string };
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
const scopeOf = (r: Arm) => String(r.properties?.scope ?? '');
const isFeatureSeed = (r: Arm) => /feature-permissions/.test(scopeOf(r));

describe('#5360 deploy-SP feature-permissions grant (compiled ARM)', () => {
  it('CONTROL: the walker sees a real population, incl. the brain loop it must not touch', () => {
    // A walker that found nothing would pass everything below vacuously.
    expect(all.length).toBeGreaterThan(100);
    expect(assignments.some((r) => r.copy?.name === 'brainScanDataAssignments')).toBe(true);
  });

  it('exactly ONE data assignment is scoped to feature-permissions, at CONTAINER scope', () => {
    // Breaks if scope widens to the account or `dbs/loom` (EXPECTED_SCOPE needs
    // `/colls/feature-permissions`), or if a second assignment is added.
    const seeds = assignments.filter(isFeatureSeed);
    expect(seeds.length).toBe(1);
    expect(scopeOf(seeds[0]!)).toBe(EXPECTED_SCOPE);
  });

  it('that assignment is Built-in Data Contributor for the DEPLOYER PARAM, not a literal', () => {
    const seed = assignments.find(isFeatureSeed)!;
    // Breaks if the principal becomes a GUID literal (public repo: no oids) or
    // another param.
    expect(seed.properties?.principalId).toBe("[parameters('deployerServicePrincipalId')]");
    // Breaks if the role becomes Data Reader (...0001) or a custom role.
    expect(String(seed.properties?.roleDefinitionId)).toContain(`sqlRoleDefinitions/${BUILT_IN_DATA_CONTRIBUTOR}`);
    // Breaks if the grant ignores skipRoleGrants or an empty deployer.
    expect(seed.condition).toBe("[variables('grantDeployFeatureGrantSeed')]");
    expect(raw).toContain(
      `"grantDeployFeatureGrantSeed": "[and(not(empty(parameters('deployerServicePrincipalId'))), not(parameters('skipRoleGrants')))]"`,
    );
  });

  it('the deployer param is fed by deployer().objectId, only for a non-interactive deployer', () => {
    // Breaks if the module input becomes a literal id or a configured param.
    expect(raw).toContain(
      `"deployerServicePrincipalId": "[if(variables('deployerIsInteractiveUser'), createObject('value', ''), createObject('value', deployer().objectId))]"`,
    );
  });

  it('the metadata companion is account-scoped, uses readMetadata ONLY, and is not a data role', () => {
    const meta = assignments.find(
      (r) => scopeOf(r) === ACCOUNT_SCOPE && String(r.name).includes('loom-feature-grant-seed-metadata-reader'),
    );
    expect(meta, 'metadata assignment').toBeDefined();
    const role = all.find(
      (r) => r.type?.endsWith('sqlRoleDefinitions') && String(r.name).includes('loom-feature-grant-seed-metadata-reader'),
    );
    // Breaks if any document action (items/read, executeQuery, ...) is added.
    expect(JSON.stringify(rec(role?.properties).permissions)).toBe(
      '[{"dataActions":["Microsoft.DocumentDB/databaseAccounts/readMetadata"]}]',
    );
  });

  it('NO NEW assignment targets any other container or a wider scope', () => {
    // Population of deployer-principal data grants: brain loop (copy), the seed
    // grant, the metadata companion, and (#5368, asserted in governance-seed-bicep.test.ts)
    // the governance-seed loop. Anything else on deployerServicePrincipalId is a
    // widening. Breaks on a 6th assignment for the deployer param.
    const deployerGrants = assignments.filter(
      (r) => r.properties?.principalId === "[parameters('deployerServicePrincipalId')]",
    );
    const names = deployerGrants.map((r) =>
      r.copy?.name === 'brainScanDataAssignments'
        ? 'brain-loop'
        : r.copy?.name === 'governanceSeedDataAssignments'
          ? 'governance-loop'
          : isFeatureSeed(r)
          ? 'feature-seed'
          : scopeOf(r) === ACCOUNT_SCOPE
            ? 'metadata:' + (String(r.name).includes('feature-grant-seed') ? 'feature' : 'brain')
            : 'UNEXPECTED:' + scopeOf(r),
    );
    expect(names.sort()).toEqual([
      'brain-loop',
      'feature-seed',
      'governance-loop',
      'metadata:brain',
      'metadata:feature',
    ]);
  });

  it('the container the grant scopes to is DECLARED, partitioned /tenantId', () => {
    const c = all.find(
      (r) =>
        r.type?.endsWith('sqlDatabases/containers') &&
        rec(rec(r.properties).resource).id === 'feature-permissions',
    );
    expect(c, 'feature-permissions container').toBeDefined();
    // Breaks if the key drifts from the console's mk('feature-permissions','/tenantId').
    expect(JSON.stringify(rec(rec(c!.properties).resource).partitionKey)).toContain('"/tenantId"');
  });
});
