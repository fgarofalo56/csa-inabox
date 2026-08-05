/**
 * #2642 — Azure Cache for Redis retirement -> Azure Managed Redis.
 *
 * WHAT THE ISSUE GOT WRONG (read before changing these tests)
 * ---------------------------------------------------------------------------
 * The filed issue proposed "add an Azure Managed Redis module and switch
 * hband-shared.bicep / deploy-planner/redis.bicep to it", on the stated premise
 * that *"Managed Redis is listed as a mainstream service in Azure Government,
 * so it is available in both clouds — unlike the Enterprise tiers, which are
 * Public-only."*
 *
 * That premise is FALSE, and acting on it would have broken Azure Government
 * outright — today, not in October. Azure Managed Redis IS the
 * `Microsoft.Cache/redisEnterprise` provider the issue calls "Public-only":
 *
 *   Learn, Azure Managed Redis planning FAQs —
 *     "Can I use Azure Managed Redis with Azure Government Cloud …?
 *      Azure Managed Redis is only available in the global Azure cloud."
 *     https://learn.microsoft.com/azure/redis/planning-faq
 *   Learn, Azure Cache for Redis planning FAQs —
 *     "The Azure Redis Enterprise and Enterprise Flash tiers are available only
 *      in the Public cloud."
 *     https://learn.microsoft.com/azure/azure-cache-for-redis/cache-planning-faq
 *
 * So the fix is a BOUNDARY-DERIVED backend: Commercial moves to Azure Managed
 * Redis; every sovereign boundary stays on the classic provider, because the
 * successor does not exist there. The `gov` tests below are the ones that a
 * naive find-and-replace migration would fail.
 *
 * The issue's second claim — that this "breaks the clean-subscription
 * acceptance test in no-vaporware.md in both clouds this autumn" — is also
 * wrong: `redisEnabled` defaults to false and is set by no shipped
 * .bicepparam, and hband-shared.bicep is an orphan-allowlisted out-of-band
 * entrypoint. A clean-subscription deploy creates no cache at all today. The
 * dated break is real but lands on the two OPT-IN paths, not the default one.
 *
 * These assert INFRASTRUCTURE SOURCE and COMPILED ARM, which — unlike a DOM
 * string — is the real artifact for a bicep change. They are NOT a substitute
 * for actually deploying the module (rule G1); see the PR body for what is and
 * is not proven.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// apps/fiab-console/lib/deploy/__tests__ -> repo root
const REPO = join(__dirname, '..', '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');
/**
 * Read a .bicep with `//` comment lines removed. These modules deliberately
 * QUOTE the classic shape in their doc blocks to explain why the managed shape
 * differs, so a whole-file `not.toMatch` would fire on the explanation rather
 * than on real code.
 */
const readCode = (p: string) =>
  read(p)
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

const AMR = 'platform/fiab/bicep/modules/shared/managed-redis.bicep';
const HBAND = 'platform/fiab/bicep/modules/compute/hband-shared.bicep';
const DP_REDIS = 'platform/fiab/bicep/modules/deploy-planner/redis.bicep';
const MAIN = 'platform/fiab/bicep/main.bicep';
const NETWORK = 'platform/fiab/bicep/modules/admin-plane/network.bicep';
const BUNDLED_ARM = 'apps/fiab-console/deploy-templates/main.json';

describe('#2642 — an Azure Managed Redis module exists at all', () => {
  it('creates the redisEnterprise cluster + its mandatory default database', () => {
    const src = read(AMR);
    expect(src).toMatch(/resource cluster 'Microsoft\.Cache\/redisEnterprise@2025-07-01'/);
    // AMR is non-functional without the child database (Learn: "requires a
    // Microsoft.Cache/redisEnterprise/databases child resource to function").
    expect(src).toMatch(/resource database 'Microsoft\.Cache\/redisEnterprise\/databases@2025-07-01'/);
    expect(src).toMatch(/name: 'default'/);
  });

  it('uses an api-version that is not itself deprecated in Oct 2026', () => {
    // Learn (AMR private-link, "API changes"): api-versions before 2025-07-01
    // are deprecated in October 2026 — an older one recreates this same dated
    // problem, and publicNetworkAccess does not exist before it.
    const src = read(AMR);
    expect(src).not.toMatch(/redisEnterprise[^']*@20(2[0-4]|25-0[1-5])/);
  });
});

describe('#2642 — the AMR shape is NOT a find-and-replace of the classic one', () => {
  it('parents access-policy assignments to the DATABASE with the user.objectId shape', () => {
    const src = read(AMR);
    expect(src).toMatch(
      /resource accessPolicyAssignments 'Microsoft\.Cache\/redisEnterprise\/databases\/accessPolicyAssignments@2025-07-01'/,
    );
    expect(src).toMatch(/parent: database/);
    expect(src).toMatch(/user: \{\s*objectId: a\.objectId/);
    // The classic flat shape would be silently accepted by nobody: `objectId`
    // at the top of `properties`, plus `objectIdAlias`, do not exist on AMR.
    // 'default' is the only accepted policy name on AMR; Data Owner /
    // Data Contributor / Data Reader are classic-only. Comment lines are
    // stripped because the doc block quotes the classic shape on purpose.
    const code = readCode(AMR);
    expect(code).not.toMatch(/objectIdAlias:/);
    expect(code).not.toMatch(/accessPolicyName: 'Data (Owner|Contributor|Reader)'/);
    expect(code).toMatch(/accessPolicyName: 'default'/);
  });

  it('uses the redisEnterprise private-link sub-resource, not redisCache', () => {
    const code = readCode(AMR);
    expect(code).toMatch(/groupIds: \['redisEnterprise'\]/);
    expect(code).not.toMatch(/groupIds: \['redisCache'\]/);
  });

  it('does NOT default to OSSCluster, which Loom\'s client cannot speak', () => {
    // THE SILENT-FAILURE TRAP. OSSCluster is the ARM default and requires a
    // cluster-aware client (MOVED redirects, per-shard 85xx connections).
    // lib/azure/redis-cache-client.ts is a hand-rolled RESP2 socket client with
    // no cluster support that degrades SILENTLY on any error — so under
    // OSSCluster the cache would deploy green, the env var would be set, and
    // every GET would fail invisibly.
    const src = read(AMR);
    expect(src).toMatch(/param clusteringPolicy string = 'EnterpriseCluster'/);

    // And the client really is non-cluster-aware — if that ever changes this
    // constraint can be revisited, but not before.
    const client = read('apps/fiab-console/lib/azure/redis-cache-client.ts');
    expect(client).not.toMatch(/CLUSTER NODES|MOVED|clusterSlots/);
  });

  it('publishes the AMR port (10000) as an output instead of assuming 6380', () => {
    const src = read(AMR);
    expect(src).toMatch(/port: 10000/);
    expect(src).toMatch(/output endpoint string = '\$\{cluster\.properties\.hostName\}:\$\{database\.properties\.port\}'/);
  });

  it('is Entra-only by default (no access key to leak)', () => {
    expect(read(AMR)).toMatch(/param accessKeysAuthentication string = 'Disabled'/);
  });
});

describe('#2642 — both call sites can actually deploy the managed backend', () => {
  it('hband-shared invokes the module and makes the classic cache conditional', () => {
    const src = read(HBAND);
    expect(src).toMatch(/module managedRedis '\.\.\/shared\/managed-redis\.bicep' = if \(useManagedRedis\)/);
    expect(src).toMatch(/param redisBackend string = 'managed'/);
    // The retiring resource must no longer be created unconditionally.
    expect(readCode(HBAND)).not.toMatch(/resource redis 'Microsoft\.Cache\/redis@[\d-]+' = \{/);
    expect(src).toMatch(/resource redis 'Microsoft\.Cache\/redis@[\d-]+' = if \(!useManagedRedis\)/);
  });

  it('deploy-planner/redis invokes the module and makes the classic cache conditional', () => {
    const src = read(DP_REDIS);
    expect(src).toMatch(/module managedRedis '\.\.\/shared\/managed-redis\.bicep' = if \(useManagedRedis\)/);
    expect(src).toMatch(/param redisBackend string = 'managed'/);
    expect(readCode(DP_REDIS)).not.toMatch(/resource redis 'Microsoft\.Cache\/redis@[\d-]+' = \{/);
    expect(src).toMatch(/resource redis 'Microsoft\.Cache\/redis@[\d-]+' = if \(!useManagedRedis\)/);
  });

  it('both call sites emit a host:port endpoint rather than a bare host', () => {
    // The two backends listen on DIFFERENT ports, so any consumer that appends
    // a hard-coded :6380 to the host output is wrong on the managed backend.
    for (const f of [HBAND, DP_REDIS]) {
      expect(read(f)).toMatch(/output (redisEndpoint|endpoint) string = useManagedRedis/);
    }
  });

  it('hband passes the AMR private DNS zone, not the classic redis zone', () => {
    const src = read(HBAND);
    expect(src).toMatch(/param privateDnsZoneRedisManagedId string = ''/);
    expect(src).toMatch(/privateDnsZoneId: privateDnsZoneRedisManagedId/);
  });
});

describe('#2642 — GOV SAFETY: sovereign boundaries must NOT be sent to AMR', () => {
  // Azure Managed Redis does not exist in Azure Government. A migration that
  // pointed Gov at redisEnterprise would replace a service that stops taking
  // new caches in Oct 2026 with one that has never existed there.
  it('main.bicep derives the backend from boundary, Commercial-only for managed', () => {
    const src = read(MAIN);
    expect(src).toMatch(/var redisBackend = boundary == 'Commercial' \? 'managed' : 'classic'/);
    expect(src).toMatch(/redisBackend: redisBackend/);
  });

  it('is written as an allowlist of one, so an unknown boundary falls back to classic', () => {
    // A denylist (`boundary == 'GCC' || … ? 'classic' : 'managed'`) would hand a
    // future/unrecognised sovereign boundary a Public-cloud-only provider.
    expect(readCode(MAIN)).not.toMatch(/var redisBackend = \([^)]*boundary == 'GCC'[^)]*\)\s*\?\s*'classic'/);
  });

  it('records in-source WHY Gov cannot use the managed backend', () => {
    // The next agent to read this must not "fix" Gov by flipping the ternary.
    // Grounded in Learn, not in memory.
    const src = read(MAIN);
    expect(src).toMatch(/only available in the global Azure cloud/);
    expect(src).toMatch(/learn\.microsoft\.com\/azure\/redis\/planning-faq/);
  });

  it('keeps the classic Redis private DNS zone for the sovereign path', () => {
    const src = read(NETWORK);
    expect(src).toMatch(/privatelink\.redis\.cache\.\$\{boundary == 'GCC-High' \|\| boundary == 'IL5' \? 'usgovcloudapi\.net' : 'windows\.net'\}/);
  });

  it('adds the AMR zone WITHOUT inventing a sovereign suffix for it', () => {
    const src = read(NETWORK);
    expect(src).toMatch(/'privatelink\.redis\.azure\.net'/);
    expect(src).toMatch(/redisManaged: privateDnsZones\[25\]\.id/);
    // Learn's Government private-endpoint-dns table lists no AMR zone, because
    // AMR is not a Gov service. A boundary-templated `redis.azure.us` (etc.)
    // would be a guess.
    expect(readCode(NETWORK)).not.toMatch(/privatelink\.redis\.azure\.\$\{/);
  });
});

describe('#2642 — the SHIPPED artifact carries the change, not just the source', () => {
  // deploy-templates/main.json is COPY'd into the production image and
  // submitted INLINE to ARM by lib/setup/user-arm-deploy.ts. A .bicep-only fix
  // is INERT on that path (cf. #2729, where CVE floors never reached the
  // shipped image).
  //
  // These assertions predate the gate. As of #2945,
  // `scripts/ci/check-deploy-template-sync.mjs` (merge-blocking `guardrails`
  // lane, no path filter) recompiles the bicep and byte-compares the committed
  // artifact, so staleness is now caught GENERALLY rather than one asserted
  // fact at a time. They are kept because they are cheap and they pin THIS
  // change specifically — but note they run in a vitest job gated on
  // `^apps/fiab-console/`, i.e. on the ARTIFACT's directory and not on the
  // bicep SOURCE's, which is exactly why they could never have caught #2945.
  const bundled = read(BUNDLED_ARM);

  it('contains the redisEnterprise provider', () => {
    expect(bundled).toContain('Microsoft.Cache/redisEnterprise');
  });

  it('carries the boundary-derived backend variable', () => {
    const tpl = JSON.parse(bundled) as { variables: Record<string, unknown> };
    expect(tpl.variables.redisBackend).toBe(
      "[if(equals(parameters('boundary'), 'Commercial'), 'managed', 'classic')]",
    );
  });

  it('creates the classic cache only when the managed backend is off', () => {
    // Proven in COMPILED ARM, not in a bicep comment.
    const tpl = JSON.parse(bundled) as Record<string, unknown>;
    const asList = (r: unknown): Record<string, unknown>[] =>
      Array.isArray(r) ? r : Object.values((r ?? {}) as Record<string, Record<string, unknown>>);
    let classicCondition: string | undefined;
    let sawManagedCluster = false;
    const walk = (resources: unknown): void => {
      for (const r of asList(resources)) {
        if (r.type === 'Microsoft.Cache/redis') classicCondition = r.condition as string;
        if (r.type === 'Microsoft.Cache/redisEnterprise') sawManagedCluster = true;
        const props = r.properties as { template?: { resources?: unknown } } | undefined;
        if (props?.template?.resources) walk(props.template.resources);
      }
    };
    walk(tpl.resources);
    expect(classicCondition).toBe("[not(variables('useManagedRedis'))]");
    expect(sawManagedCluster).toBe(true);
  });

  it('stays under ARM\'s 4 MB inline-template limit', () => {
    // CONTROL: this passes both before and after the fix. It is here because
    // the inline submit path in user-arm-deploy.ts breaks hard above 4 MB, and
    // growing the template is exactly what this PR does.
    expect(Buffer.byteLength(bundled)).toBeLessThan(4 * 1024 * 1024);
  });
});

describe('#2642 — CONTROL: things that must NOT change', () => {
  // These pass on BOTH sides of the fix. If an over-broad edit trips one of
  // them, the migration went further than it should have.
  it('leaves the deploy-planner catalog entry and its bicep flag alone', () => {
    const catalog = read('apps/fiab-console/lib/components/deploy-planner/service-catalog.ts');
    expect(catalog).toMatch(/bicepFlag: 'redisEnabled'/);
    expect(read(MAIN)).toMatch(/param redisEnabled bool = false/);
  });

  it('keeps the client env-var contract as <host>[:<port>], parsed generically', () => {
    // The migration changes the PORT VALUE, not the contract. The client must
    // keep parsing an arbitrary port out of the env var.
    const client = read('apps/fiab-console/lib/azure/redis-cache-client.ts');
    expect(client).toMatch(/export function parseRedisEndpoint/);
    expect(client).toMatch(/process\.env\.LOOM_RESULT_CACHE_REDIS/);
  });

  it('keeps the classic Redis resource available for the sovereign path', () => {
    // Deleting it outright would be the over-broad version of this fix and
    // would strand Azure Government with no cache provider at all.
    expect(read(DP_REDIS)).toMatch(/Microsoft\.Cache\/redis@/);
    expect(read(HBAND)).toMatch(/Microsoft\.Cache\/redis@/);
  });
});
