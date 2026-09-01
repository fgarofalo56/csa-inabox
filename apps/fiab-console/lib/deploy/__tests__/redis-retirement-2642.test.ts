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
const OSS = 'platform/fiab/bicep/modules/shared/redis-oss-aca.bicep';
const ADMIN = 'platform/fiab/bicep/modules/admin-plane/main.bicep';
const KEYVAULT = 'platform/fiab/bicep/modules/admin-plane/keyvault.bicep';
const IMAGE_MANIFEST = 'platform/fiab/images/upstream-images.json';

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

describe('#2642 — SOVEREIGN FORWARD PATH: OSS Redis (Valkey) on Container Apps', () => {
  // The residual half of #2642. Commercial's answer is Azure Managed Redis;
  // sovereign boundaries have no AMR and no announced ETA, and their only
  // Azure-managed option is a provider Microsoft turns off on 2028-10-01. Under
  // cloud-parity.md §3 the answer is the Azure-native/OSS equivalent, deployed
  // now rather than waiting on a date that does not exist.
  it('deploys a Container App, not another Microsoft.Cache resource', () => {
    const code = readCode(OSS);
    expect(code).toMatch(/resource app 'Microsoft\.App\/containerApps@2025-02-02-preview'/);
    // The whole point is to stop creating the retiring provider in sovereign
    // estates — this module must never reach for either Azure Redis provider.
    expect(code).not.toMatch(/Microsoft\.Cache\/redis/);
  });

  it('runs VALKEY, not the relicensed Redis image', () => {
    // Redis moved to RSALv2/SSPL in 2024 and AGPLv3 in Redis 8; both are on the
    // LIC0 forbidden list. Valkey is the Linux Foundation fork under BSD-3-Clause.
    const code = readCode(OSS);
    expect(code).toMatch(/'valkey\/valkey:[\d.]+-alpine'/);
    expect(code).not.toMatch(/'redis:[\d.]/);
  });

  it('pulls ONLY from the estate ACR mirror — no public-registry branch exists', () => {
    // #2682: `acrLoginServer` is required with no '' default and the ref is
    // COMPOSED from it, so a caller that forgets the coordinate fails template
    // validation instead of silently egressing to Docker Hub (the exact shape
    // that withdrew the s3-gateway in PR #2640 round 4).
    const code = readCode(OSS);
    expect(code).toMatch(/var acrLoginServer = redisConfig\.acrLoginServer/);
    expect(code).toMatch(/var image = '\$\{acrLoginServer\}\/\$\{valkeyImage\}'/);
    // Belt-and-braces only — the STRUCTURAL guarantee is the two assertions
    // above (the ref is composed from a required, defaultless coordinate, so
    // there is no branch a public registry could be reached through). This line
    // just catches a literal someone pastes in later.
    //
    // DELIBERATELY UNANCHORED, and it must stay that way. This is a `not.toMatch`
    // SUBSTRING SEARCH over a whole multi-line file, not host validation. Anchor
    // it (^…$) and it can never match a multi-line string, so the negative
    // assertion would pass unconditionally — a control that cannot fail. The
    // CodeQL `js/regex/missing-regexp-anchor` hit here is a false positive for
    // exactly that reason.
    //
    // `index.docker.io` is dropped: `docker\.io` already matches it as a
    // substring. `gcr.io`, `registry.k8s.io` and `public.ecr.aws` added — they
    // are the public registries a Valkey/Redis image is most plausibly pasted
    // from after Docker Hub.
    expect(code).not.toMatch(/docker\.io|ghcr\.io|quay\.io|gcr\.io|registry\.k8s\.io|public\.ecr\.aws/);
  });

  it('is digest-pinned in the upstream-image mirror manifest', () => {
    // A bicep ref with no manifest entry means nothing imports that tag into the
    // estate ACR and the revision can never activate. MIR0 enforces this
    // generally; this pins THIS image specifically.
    const manifest = JSON.parse(read(IMAGE_MANIFEST)) as {
      images: { acrRepo: string; tag: string; digest: string; spdx: string }[];
    };
    const entry = manifest.images.find((i) => i.acrRepo === 'valkey/valkey');
    expect(entry).toBeDefined();
    expect(entry!.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry!.spdx).toBe('BSD-3-Clause');
    // The bicep-pinned tag and the manifest tag must be the same string — the
    // module composes `${acr}/${repo}:${tag}`.
    expect(readCode(OSS)).toContain(`'valkey/valkey:${entry!.tag}'`);
  });

  it('FAILS CLOSED without a password instead of serving an open cache', () => {
    // Valkey ships with NO authentication, and every app in a Container Apps
    // environment draws a pod IP from the SAME infrastructure subnet — so
    // loom-script-runner and loom-udf-runtime, which execute user-supplied code,
    // are one TCP connect away. That is precisely how loom-risingwave shipped an
    // unauthenticated root superuser (2026-07-29) and loom-unity an anonymously
    // writable catalog (#2643). The guard must live in the ENTRYPOINT, so an
    // empty Key Vault resolution fails too — not only a missing bicep param.
    const src = read(OSS);
    expect(src).toMatch(/if \[ -z "\$LOOM_REDIS_PASSWORD" \]; then/);
    expect(src).toMatch(/FAIL CLOSED/);
    expect(src).toMatch(/exit 1/);
    expect(src).toMatch(/requirepass \$LOOM_REDIS_PASSWORD/);
  });

  it('binds the credential as a secretRef and never as an env literal or output', () => {
    const code = readCode(OSS);
    expect(code).toMatch(/keyVaultUrl: passwordSecretUri, identity: uamiId/);
    expect(code).toMatch(/\{ name: 'LOOM_REDIS_PASSWORD', secretRef: 'redis-password' \}/);
    // No `value:` binding of the password onto the container env, and no output
    // can carry it — an output lands in deployment history and CI logs.
    expect(code).not.toMatch(/name: 'LOOM_REDIS_PASSWORD', value:/);
    expect(code).not.toMatch(/^output .*(password|Password)[^A-Za-z]*string = (password|redisConfig)/m);
  });

  it('never exposes the cache publicly and speaks TCP, not HTTP', () => {
    const code = readCode(OSS);
    expect(code).toMatch(/external: false/);
    expect(code).toMatch(/transport: 'tcp'/);
    expect(code).not.toMatch(/external: true/);
  });

  it('FORCES maxReplicas to 1 — two replicas would be two different caches', () => {
    // ACA ingress load-balances across replicas, and two Valkey processes behind
    // one ingress are two INDEPENDENT, non-replicating datasets: a client's GET
    // hits whichever process its connection landed on. A "shared" cache that
    // answers differently per connection, with no error anywhere. The cap must
    // be a literal, NOT a config-bag key that an operator can raise.
    const code = readCode(OSS);
    expect(code).toMatch(/minReplicas: 1\s*\n\s*maxReplicas: 1/);
    expect(code).not.toMatch(/maxReplicas: (int\(|maxReplicas)/);
  });

  it('states its durability posture honestly instead of implying persistence', () => {
    // The recorded amnesiac-service shape: a stateful tier on an ephemeral ACA
    // filesystem that loses everything on a roll while the deploy reads green.
    // The default here IS ephemeral — that is correct for a cache — but it must
    // be DECLARED, and RDB must be off so nothing half-promises durability.
    const code = readCode(OSS);
    expect(code).toMatch(/output dataDurable bool = useAof/);
    expect(code).toMatch(/output persistenceMode string = persistence/);
    expect(code).toMatch(/var persistence = string\(redisConfig\.\?persistence \?\? 'none'\)/);
    expect(read(OSS)).toMatch(/echo 'save ""'/);
    // And the ephemeral consequence is spelled out in the output description a
    // deploy receipt actually prints, not only in a header comment.
    expect(read(OSS)).toMatch(/DROPS EVERY KEY/);
  });

  it('bounds memory so an unbounded cache cannot OOM-kill its own container', () => {
    const code = readCode(OSS);
    expect(code).toMatch(/var maxmemoryMb = int\(redisConfig\.\?maxmemoryMb \?\? \d+\)/);
    expect(read(OSS)).toMatch(/maxmemory \$\{LOOM_REDIS_MAXMEMORY_MB\}mb/);
    expect(read(OSS)).toMatch(/maxmemory-policy \$LOOM_REDIS_MAXMEMORY_POLICY/);
  });
});

describe("#2642 — the persistence: 'aof' BRANCH (opt-in, and unexercised by any deploy)", () => {
  // #4265 review F7: this branch had NO fixture at all. It creates four Azure
  // resources, mounts an SMB share into the cache container, and changes where
  // the AOF is written — and not one line of it was pinned, while the only
  // shipped call site (admin-plane/main.bicep) passes `persistence: 'none'`.
  //
  // So nothing deploys it today and nothing tested it. These assertions pin the
  // shape so the branch cannot rot silently between now and the first estate
  // that turns it on. They are STATIC-SHAPE assertions over the bicep, not a
  // deploy receipt: per deploy-integrity.md R2 this branch remains UNPROVEN
  // until an estate actually stands it up. The fixture makes it *reviewable*,
  // not *verified*.

  it('is genuinely opt-in: the default is ephemeral and no call site opts in', () => {
    const code = readCode(OSS);
    expect(code).toMatch(/var persistence = string\(redisConfig\.\?persistence \?\? 'none'\)/);
    expect(code).toMatch(/var useAof = persistence == 'aof'/);
    // The single shipped consumer passes 'none' explicitly. If this assertion
    // ever fails it means an estate started deploying the AOF path — at which
    // point the private-endpoint gap recorded in the module header stops being
    // theoretical and must be closed before the change ships.
    expect(readCode(ADMIN)).toMatch(/persistence: 'none'/);
    expect(readCode(ADMIN)).not.toMatch(/persistence: 'aof'/);
  });

  it('gates ALL FOUR AOF resources on useAof, so the default deploys none of them', () => {
    // Population completeness, not spot-check: an unconditional member of this
    // quartet would create (and bill) a storage account on every ephemeral
    // sovereign deploy, and `aofCaeStorage` would additionally fail because it
    // calls listKeys() on an account the ephemeral path has no reason to have.
    const code = readCode(OSS);
    const gated = [
      /resource aofStorage 'Microsoft\.Storage\/storageAccounts@[\d-]+' = if \(useAof\)/,
      /resource aofFileSvc 'Microsoft\.Storage\/storageAccounts\/fileServices@[\d-]+' = if \(useAof\)/,
      /resource aofShare 'Microsoft\.Storage\/storageAccounts\/fileServices\/shares@[\d-]+' = if \(useAof\)/,
      /resource aofCaeStorage 'Microsoft\.App\/managedEnvironments\/storages@[\d-]+' = if \(useAof\)/,
    ];
    for (const re of gated) expect(code).toMatch(re);
    // And the count is the guard against a fifth AOF resource being added
    // later without a condition: every `resource aof*` line must carry one.
    const aofResourceLines = code
      .split('\n')
      .filter((l) => /^resource aof\w+ '/.test(l));
    expect(aofResourceLines.length).toBe(gated.length);
    for (const l of aofResourceLines) expect(l).toMatch(/= if \(useAof\)/);
  });

  it('actually writes the AOF to the mount — the share is not mounted and ignored', () => {
    // The hollow shape this catches: share created, volume mounted, and valkey
    // still writing its append file to the container's own /tmp, so the deploy
    // looks durable and loses every key on the next revision anyway.
    const code = readCode(OSS);
    expect(code).toMatch(/var aofMountPath = '\/data'/);
    expect(code).toMatch(/var dataDir = useAof \? aofMountPath : '\/tmp\/loom-redis'/);
    expect(code).toMatch(/\{ name: 'LOOM_REDIS_DIR', value: dataDir \}/);
    // appendonly follows the same switch, both directions: 'yes' only on the
    // AOF path, and provably 'no' on the default (an appendonly cache writing
    // to ephemeral /tmp is the worst of both).
    expect(code).toMatch(/\{ name: 'LOOM_REDIS_APPENDONLY', value: useAof \? 'yes' : 'no' \}/);
    expect(read(OSS)).toMatch(/echo "appendonly \$LOOM_REDIS_APPENDONLY"/);
    expect(read(OSS)).toMatch(/echo "dir \$LOOM_REDIS_DIR"/);
  });

  it('wires the volume end-to-end: share -> env storage link -> volume -> mount', () => {
    // Four names have to agree across three resources and the container spec.
    // A mismatch in any one of them is a deploy-time failure at best and a
    // silently unmounted volume at worst, so they are pinned as a chain.
    const code = readCode(OSS);
    expect(code).toMatch(/var aofShareName = 'loom-redis-aof'/);
    expect(code).toMatch(/var aofStorageLink = 'loom-redis-aof'/);
    expect(code).toMatch(/name: aofShareName/);
    expect(code).toMatch(/shareName: aofShareName/);
    expect(code).toMatch(/name: aofStorageLink/);
    expect(code).toMatch(/accountName: aofStorage\.name/);
    expect(code).toMatch(
      /volumeMounts: useAof \? \[\s*\{ volumeName: 'redis-aof', mountPath: aofMountPath \}\s*\] : \[\]/,
    );
    expect(code).toMatch(
      /volumes: useAof \? \[\s*\{ name: 'redis-aof', storageType: 'AzureFile', storageName: aofStorageLink \}\s*\] : \[\]/,
    );
  });

  it('declares a network posture on the account that holds cached query results', () => {
    // #4265 review F7: this account holds the AOF journal — i.e. real query
    // results at rest — and previously declared NO networkAcls at all.
    const code = readCode(OSS);
    expect(code).toMatch(/minimumTlsVersion: 'TLS1_2'/);
    expect(code).toMatch(/allowBlobPublicAccess: false/);
    expect(code).toMatch(/supportsHttpsTrafficOnly: true/);
    expect(code).toMatch(/allowCrossTenantReplication: false/);
    expect(code).toMatch(/networkAcls: \{\s*defaultAction: 'Allow'\s*bypass: 'AzureServices'\s*\}/);
    // publicNetworkAccess is deliberately NOT written here, matching
    // admin-plane/main.bicep's loom-mcp SMB account: the platform policy
    // assignment performs the seal, and this module has no subnet parameter
    // with which to add the `file` private endpoint that would survive it.
    // That residual gap is disclosed in-source rather than papered over, and
    // the disclosure is part of the contract — if someone deletes it, this
    // fails.
    expect(read(OSS)).toMatch(/NO `file` private endpoint/);
    expect(code).not.toMatch(/publicNetworkAccess: 'Disabled'/);
    // Shared-key access cannot be turned off: ACA's SMB mount authenticates
    // with the account key. It is true, it is load-bearing, and it is why the
    // AOF path is opt-in — so the reason must stay next to the property.
    expect(code).toMatch(/allowSharedKeyAccess: true/);
    expect(read(OSS)).toMatch(/authenticates with the account/);
  });
});

describe('#2642 — AUTO-BIND: the deploy produces the value, the operator does not', () => {
  // auto-bind-by-default.md §5. Before this change LOOM_RESULT_CACHE_REDIS was
  // emitted by NO bicep, and the env-check told the operator to take the
  // endpoint from compute/hband-shared.bicep — a module with ZERO invocations
  // repo-wide, so the instruction was not even followable.
  it('the orchestrator DEPLOYS the module (it is not another out-of-band entrypoint)', () => {
    const src = read(ADMIN);
    expect(src).toMatch(/module redisOss '\.\.\/shared\/redis-oss-aca\.bicep' = if \(redisOssActive\)/);
    expect(src).toMatch(/var redisOssActive = redisOssEnabled && boundary != 'Commercial' && containerPlatform == 'containerApps' && deployAppsEnabled/);
  });

  it('emits all three client vars on the Console — endpoint, password, TLS flag', () => {
    const src = read(ADMIN);
    expect(src).toMatch(/name: 'LOOM_RESULT_CACHE_REDIS', value: redisOssActive \?/);
    expect(src).toMatch(/name: 'LOOM_RESULT_CACHE_REDIS_PASSWORD', secretRef: 'loom-redis-oss-password'/);
    expect(src).toMatch(/name: 'LOOM_RESULT_CACHE_REDIS_TLS', value: redisOssActive \? '0' : ''/);
  });

  it('sets TLS OFF, because ACA tcp ingress does not terminate TLS', () => {
    // THE SILENT-DEGRADATION TRAP, and the sibling of the OSSCluster one above.
    // redis-cache-client.ts defaults TLS ON (the classic :6380 case). Left at the
    // default it would attempt a TLS handshake against a plaintext listener,
    // fail, trip its circuit breaker, and fall back to the local tiers — a cache
    // that is configured, green, and never used.
    const client = read('apps/fiab-console/lib/azure/redis-cache-client.ts');
    expect(client).toMatch(/LOOM_RESULT_CACHE_REDIS_TLS \?\? '1'\) !== '0'/);
    expect(read(ADMIN)).toMatch(/LOOM_RESULT_CACHE_REDIS_TLS', value: redisOssActive \? '0'/);
    // …and the module says so in an output rather than leaving it implicit.
    expect(readCode(OSS)).toMatch(/output tlsOnTheWire bool = false/);
  });

  it('selects the client\'s access-key AUTH branch, which Valkey can actually serve', () => {
    // Valkey has no Entra data plane. redis-cache-client.ts prefers Entra
    // (`AUTH <oid> <token>`) and only takes the password branch when
    // LOOM_RESULT_CACHE_REDIS_PASSWORD is set — so emitting that var is not a
    // convenience, it is what makes the tier authenticate at all.
    const client = read('apps/fiab-console/lib/azure/redis-cache-client.ts');
    expect(client).toMatch(/const password = \(process\.env\.LOOM_RESULT_CACHE_REDIS_PASSWORD \?\? ''\)\.trim\(\);/);
    expect(client).toMatch(/if \(password\) \{[\s\S]{0,200}send\(\['AUTH', password\]\)/);
  });

  it('mints the credential into Key Vault and grants ONLY the two identities that need it', () => {
    const kv = read(KEYVAULT);
    expect(kv).toMatch(/resource redisOssPasswordSecret 'Microsoft\.KeyVault\/vaults\/secrets@/);
    expect(kv).toMatch(/resource redisOssKvSecretsUserRole 'Microsoft\.Authorization\/roleAssignments@/);
    // 4633458b-… = Key Vault Secrets User (read values), a global built-in GUID.
    expect(kv).toMatch(/4633458b-17de-408a-b874-0445c86b69e6/);
    const src = read(ADMIN);
    // UNPREDICTABLE: seeded from newGuid(), never guid(rg.id, <public-const>) —
    // a public-constant salt is recomputable by anyone holding Reader on the RG.
    expect(src).toMatch(/var redisOssPassword = 'Rd7\$\{uniqueString\(loomGeneratedSecretSeed, 'loom-redis-oss-v1'\)\}!Qz'/);
    // The Console resolves the SAME Key Vault secret, so the two cannot drift.
    expect(src).toMatch(/name: 'loom-redis-oss-password', keyVaultUrl: redisOssPasswordSecretUri/);
  });

  it('gives the cache a dedicated least-privilege identity, not the Console UAMI', () => {
    const src = read(ADMIN);
    expect(src).toMatch(/resource redisOssUami 'Microsoft\.ManagedIdentity\/userAssignedIdentities@[\d-]+' = if \(redisOssActive\)/);
    expect(src).toMatch(/resource redisOssAcrPull 'Microsoft\.Authorization\/roleAssignments@[\d-]+' = if \(redisOssActive && !skipRoleGrants\)/);
  });

  it('COMMERCIAL is deliberately excluded — its path is the AMR cutover', () => {
    // deploy-integrity.md R5 forbids "just deploy new alongside it". Commercial
    // already has a live classic cache; standing up a second, OSS one next to it
    // instead of migrating would be exactly that shape. Its migration is a
    // scheduled operator action with a documented runbook.
    const src = read(ADMIN);
    expect(src).toMatch(/boundary != 'Commercial'/);
    expect(src).toMatch(/docs\/fiab\/runbooks\/redis-amr-cutover\.md/);
  });

  it('the SHIPPED ARM artifact carries the sovereign wiring, not just the bicep', () => {
    // The #2945 inert-fix class: deploy-templates/main.json is COPY'd into the
    // production image and submitted INLINE to ARM by lib/setup/user-arm-deploy.ts.
    const bundled = read(BUNDLED_ARM);
    expect(bundled).toContain('loom-redis-oss');
    expect(bundled).toContain('LOOM_RESULT_CACHE_REDIS');
    expect(bundled).toContain('valkey/valkey:8.1.10-alpine');
    // Compiled, not asserted from a comment: the boundary exclusion and the
    // KV-backed secret must exist in the artifact that actually deploys. The
    // variable lives in the NESTED admin-plane template (main.bicep invokes it as
    // a module), so this reads the emitted expression out of the raw bytes rather
    // than off `tpl.variables`, where it does not appear.
    expect(bundled).toContain(
      "[and(and(and(variables('redisOssEnabled'), not(equals(parameters('boundary'), 'Commercial'))), equals(parameters('containerPlatform'), 'containerApps')), parameters('deployAppsEnabled'))]",
    );
    expect(bundled).toContain('loom-redis-oss-password');
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

describe('#4265 nit 1 — the result-cache endpoint is DERIVED, never hand-composed', () => {
  // The three Redis backends listen on three DIFFERENT ports (OSS 6379,
  // classic 6380, Azure Managed Redis 10000). main.bicep used to pass
  // `targetPort: 6379` into redis-oss-aca.bicep AND separately hand-compose
  // `loom-redis-oss.internal.<domain>:6379` into LOOM_RESULT_CACHE_REDIS. Two
  // copies of one fact: move the param and the env var still advertises the old
  // port, the result cache silently falls back to its per-replica in-process
  // LRU, and the estate looks healthy while the shared cache is unreachable.
  //
  // Measured consequence of the old form, beyond the coupling: because nothing
  // in appDeployments REFERENCED the redisOss module, ARM emitted no dependency
  // edge — appDeployments.dependsOn was 46 entries and did not contain
  // redisOss. Consuming the module's own output raises it to 47 and adds the
  // edge, so the Console can no longer be created pointing at a Valkey app that
  // has not been deployed yet.

  // Capture to end-of-LINE, not to the first `}`. A `[^}]*}` capture looks
  // right and is hollow: the likeliest reintroduction of a hand-composed
  // endpoint is an interpolated `'...${module.outputs.domain}:6379'`, whose
  // FIRST `}` closes the interpolation — so the capture would stop before the
  // port and the negative assertion below would pass unconditionally. Caught by
  // running the positive control, which is why it is here.
  const envLine = (src: string) =>
    src.split('\n').find((l) => l.includes("name: 'LOOM_RESULT_CACHE_REDIS'")) ?? '';

  it('binds LOOM_RESULT_CACHE_REDIS to the module output, with no literal port', () => {
    const line = envLine(readCode(ADMIN));
    expect(line).not.toBe(''); // the env var must still exist at all
    expect(line).toMatch(/redisOss\.outputs\.endpoint/);
    // Unanchored is correct here and is NOT the hollow shape: the subject is a
    // single captured line, not a multi-line file, so a negative substring
    // search over it genuinely can fail. The positive control below proves it.
    expect(line).not.toMatch(/:\d{4,5}/);
  });

  it('POSITIVE CONTROL: the same assertion rejects the old hand-composed form', () => {
    // Single-quoted on purpose — `${...}` must stay literal, not interpolate.
    const oldForm =
      "{ name: 'LOOM_RESULT_CACHE_REDIS', value: redisOssActive ? 'loom-redis-oss.internal.${containerPlatformModule.outputs.caeDefaultDomain}:6379' : '' }";
    expect(envLine(oldForm)).not.toBe('');
    expect(envLine(oldForm)).toMatch(/:\d{4,5}/); // would FAIL the test above
    expect(envLine(oldForm)).not.toMatch(/redisOss\.outputs\.endpoint/);
  });

  it('redis-oss-aca.bicep is the single producer of the <host>:<port> contract', () => {
    const code = readCode(OSS);
    // The output must compose the port from the SAME var the ingress uses, so
    // the two cannot diverge inside the module either.
    expect(code).toMatch(
      /output endpoint string = '\$\{app\.properties\.configuration\.ingress\.fqdn\}:\$\{targetPort\}'/,
    );
    expect(code).toMatch(/var targetPort = int\(redisConfig\.\?targetPort \?\? 6379\)/);
  });

  it('POPULATION: main.bicep declares the Valkey port exactly ONCE', () => {
    // One declaration (the module param), zero re-compositions. This is the
    // guard that actually catches a future hand-composed endpoint anywhere in
    // the file, not just on the line the test above happens to look at.
    const lines = readCode(ADMIN)
      .split('\n')
      .filter((l) => l.includes('6379'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\s*targetPort: 6379$/);
  });
});

