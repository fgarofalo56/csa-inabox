/**
 * PR #2641 — `svc-synthetic-monitor` DEPLOY-CHAIN INVARIANTS.
 *
 * The round-1 review found the service "wired" in the sense that env vars
 * existed, while the chain that FILLS them did not close on any documented
 * deploy path. These tests lock the actual repairs so they cannot silently
 * regress. They assert the INFRASTRUCTURE SOURCE, which — unlike a DOM string —
 * is the real artifact for a bicep/CI change.
 *
 * ROUND-4 SPLIT. The `svc-loom-trino` half of this PR (a NEW default-ON query
 * engine plus its engine-level Entra authorization posture) was pulled out of
 * this branch; its round-3 invariants moved out with it. See the round-4 PR
 * comment and `preserve/2641-trino-n7e-round3` for why: the Entra chain it
 * asserted is provably unreachable in this repo (no code path registers an
 * Application ID URI, so `api://<clientId>` is not a resolvable resource), and
 * a security posture that has never been executed does not belong in a merge.
 *
 * These are deliberately NOT a substitute for the live E2E receipt (rule G1);
 * see the PR body for what is and is not proven by a deploy.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// apps/fiab-console/lib/deploy/__tests__ -> repo root
const REPO = join(__dirname, '..', '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');

const ADMIN_PLANE = 'platform/fiab/bicep/modules/admin-plane/main.bicep';
const UAT_STORE = 'platform/fiab/bicep/modules/admin-plane/uat-results-storage.bicep';

describe('svc-synthetic-monitor — the results store actually exists', () => {
  it('does NOT source LOOM_UAT_RESULTS_ACCOUNT from the DLZ lake account', () => {
    const src = read(ADMIN_PLANE);
    // The round-1 shape. loomStorageAccount is EMPTY on every shipped
    // bicepparam (all pin topology='tenant'), so this made the gate red on
    // every from-scratch install in both clouds.
    expect(src).not.toMatch(/LOOM_UAT_RESULTS_ACCOUNT', value: loomStorageAccount/);
    expect(src).not.toMatch(/resultsAccount: loomStorageAccount/);
  });

  it('sources both results env vars from the uat-results-storage module outputs', () => {
    const src = read(ADMIN_PLANE);
    expect(src).toMatch(/LOOM_UAT_RESULTS_ACCOUNT', value: uatResultsStoreActive \? uatResultsStore!\.outputs\.accountName/);
    expect(src).toMatch(/LOOM_UAT_RESULTS_CONTAINER', value: uatResultsStoreActive \? uatResultsStore!\.outputs\.resultsContainerName/);
  });

  it('deploys the store independently of deployAppsEnabled so it exists before the app phase', () => {
    const src = read(ADMIN_PLANE);
    // The documented from-scratch path is two-phase: infra with
    // deployAppsEnabled=false, THEN images + apps. A results store gated on
    // deployAppsEnabled would not exist for phase 1.
    expect(src).toMatch(/var uatResultsStoreActive = syntheticMonitorEnabled/);
    expect(src).not.toMatch(/var uatResultsStoreActive = [^\n]*deployAppsEnabled/);
    expect(src).toMatch(/module uatResultsStore 'uat-results-storage\.bicep' = if \(uatResultsStoreActive\)/);
  });

  it('CREATES the container, not just an env var pointing at a name', () => {
    // The round-2 finding: naming `uat-results` is not the same as deploying
    // it. landing-zone/storage.bicep (which held the container) is not
    // deployed in tenant topology at all.
    const store = read(UAT_STORE);
    expect(store).toMatch(/Microsoft\.Storage\/storageAccounts\/blobServices\/containers/);
    expect(store).toMatch(/output resultsContainerName string/);
    expect(store).toMatch(/Microsoft\.Storage\/storageAccounts\/managementPolicies/);
  });

  it('keeps the results store private and key-free', () => {
    const store = read(UAT_STORE);
    expect(store).toMatch(/allowBlobPublicAccess:\s*false/);
    expect(store).toMatch(/allowSharedKeyAccess:\s*false/);
    expect(store).toMatch(/minimumTlsVersion:\s*'TLS1_2'/);
    expect(store).toMatch(/Microsoft\.Network\/privateEndpoints/);
  });

  it('gives the runner a per-cloud blob suffix instead of a commercial literal', () => {
    const store = read(UAT_STORE);
    expect(store).toMatch(/environment\(\)\.suffixes\.storage/);
    expect(read(ADMIN_PLANE)).toMatch(/resultsBlobSuffix: uatResultsStoreActive \? uatResultsStore!\.outputs\.blobSuffix/);

    const runner = read('apps/fiab-console/e2e/run-uat-unattended.mjs');
    expect(runner).toMatch(/LOOM_STORAGE_BLOB_SUFFIX/);
    expect(runner).not.toMatch(/https:\/\/\$\{accountName\}\.blob\.core\.windows\.net/);
  });
});

describe('both clouds — the loom-uat runner image has a producer', () => {
  it('is built by the Commercial from-scratch app phase', () => {
    const full = read('.github/workflows/full-app-deploy-commercial.yml');
    // A second image out of the console context (Dockerfile.uat) — there is no
    // ./apps/loom-uat directory.
    expect(full).toMatch(/- app: loom-uat/);
    expect(full).toMatch(/file: \.\/apps\/fiab-console\/Dockerfile\.uat/);
    // ...and it is deliberately OUTSIDE the roll set.
    //
    // This assertion previously read `APPS=(…)` and required it to contain
    // loom-uat. #3037 (cbed42ad) removed the 18-name build-list array, so the
    // only remaining `APPS=(…)` in that workflow is the ROLL SET — six Container
    // Apps — and loom-uat is correctly absent from it: it is a Container App JOB
    // image (loom-synthetic-monitor), so there is no revision to roll and each
    // scheduled execution pulls :latest itself. Main went red on that mismatch;
    // the WORKFLOW was right and this test was stale.
    //
    // The producer property the suite is named for is already established above
    // (`- app: loom-uat` in the build matrix + its Dockerfile.uat context). What
    // is added here instead is the property that actually needs teeth now: the
    // roll set must NOT silently acquire loom-uat, and it must still carry the
    // console. Deleting the assertion outright would have left the roll set
    // unwatched from this suite.
    const rollSet = full.match(/APPS=\(([^)]*)\)/)?.[1]?.split(/\s+/) ?? [];
    expect(rollSet.length).toBeGreaterThan(0);
    expect(rollSet).toContain('loom-console');
    expect(rollSet).not.toContain('loom-uat');
  });

  it('un-ignores e2e/ + tests/ for that build, or the image ships without the journeys', () => {
    // apps/fiab-console/.dockerignore excludes them to keep the CONSOLE image
    // lean, and ACR Tasks does not honour a per-Dockerfile .dockerignore.
    const full = read('.github/workflows/full-app-deploy-commercial.yml');
    expect(full).toMatch(/grep -vxE 'e2e\|tests' apps\/fiab-console\/\.dockerignore/);
    const gov = read('.github/workflows/gov-build-images.yml');
    expect(gov).toMatch(/grep -vxE 'e2e\|tests'/);
  });

  it('has a Gov image lane that does not require a running console', () => {
    const wf = read('.github/workflows/gov-build-images.yml');
    // Resolves the admin RG by the same convention main.bicep computes, so it
    // runs on a subscription where no app has ever started.
    expect(wf).toMatch(/rg-csa-loom-admin-\$\{LOC\}/);
    expect(wf).toMatch(/loom-console,loom-uat/);
    // Both Gov boundaries.
    expect(wf).toMatch(/- gcc-high/);
    expect(wf).toMatch(/- il5/);
    // SC1 parity with the Commercial matrix.
    expect(wf).toMatch(/aquasecurity\/trivy-action/);
    // The ASSERTION IS "this lane signs", not "this lane contains a literal
    // string". #3240 routed every `cosign sign` through
    // scripts/ci/cosign-sign-retry.sh (cosign's internal retry outlives its OIDC
    // token, so a Sigstore hiccup surfaced as `expired_token`), which REMOVED
    // the token this matched — and the test then failed on a lane that signs
    // MORE reliably than before.
    //
    // That is the guard-keyed-to-the-unsafe-pattern trap: a check keyed to the
    // literal text of the thing being fixed goes red exactly when the fix lands.
    // Match either shape, so the assertion tracks the BEHAVIOUR.
    expect(wf).toMatch(/cosign sign --yes|cosign-sign-retry\.sh/);
  });

  it('can be built on demand from the Commercial ACR-Tasks lane', () => {
    const acr = read('.github/workflows/build-fiab-images-acr-tasks.yml');
    // loom-uat is deliberately NOT in the push-triggered "all" matrix (a ~2 GB
    // Playwright image), but `apps: loom-uat` must resolve to the console
    // context + Dockerfile.uat rather than a nonexistent ./apps/loom-uat.
    expect(acr).not.toMatch(/"name":"loom-uat"/);
    expect(acr).toMatch(/if \[ "\$APP" = "loom-uat" \]; then/);
    expect(acr).toMatch(/FILE="\.\/apps\/fiab-console\/Dockerfile\.uat"/);
  });
});

describe('the Gov image lane pushes the tag the templates PULL', () => {
  it('gov-build-images defaults to v0.1, the tag every Gov bicepparam resolves', () => {
    const wf = read('.github/workflows/gov-build-images.yml');
    // Gov params: readEnvironmentVariable('LOOM_<X>_TAG','v0.1'). A lane that
    // pushed only :<sha>/:latest would leave ARM pointing at a tag that does
    // not exist.
    expect(wf).toMatch(/\[ -n "\$TAG" \] \|\| TAG=v0\.1/);
    // Every app is pushed under the full tag set, built once and reused for
    // each `az acr build` branch (console / uat / generic).
    expect(wf).toMatch(/TAG_LIST="\$TAG \$SHA_TAG latest"/);
    expect(wf).toMatch(/IMG_ARGS="\$IMG_ARGS --image \$APP:\$t"/);
    expect((wf.match(/\$IMG_ARGS/g) || []).length).toBeGreaterThanOrEqual(4);
    // ...and it must PROVE the tag landed rather than trust `az acr build` rc=0.
    expect(wf).toMatch(/Verify the DEPLOY-REFERENCED tag exists in the Gov ACR/);
  });

  it('matches the ACTUAL per-app tag matrix, including IL5 pinning the console at v3.0', () => {
    // loom-uat rides the job module's default, which is :latest...
    expect(read('platform/fiab/bicep/modules/admin-plane/synthetic-monitor-job.bicep'))
      .toMatch(/param image string = '\$\{acrLoginServer\}\/loom-uat:latest'/);
    // ...and the two boundaries DISAGREE on the console tag, which is exactly
    // the kind of mismatch a single-tag build lane would ship broken.
    expect(read('platform/fiab/bicep/params/gcc-high.bicepparam'))
      .toMatch(/readEnvironmentVariable\('LOOM_CONSOLE_TAG', 'v0\.1'\)/);
    expect(read('platform/fiab/bicep/params/il5.bicepparam'))
      .toMatch(/readEnvironmentVariable\('LOOM_CONSOLE_TAG', 'v3\.0'\)/);
    const wf = read('.github/workflows/gov-build-images.yml');
    expect(wf).toMatch(/if \[ "\$APP" = "loom-console" \] && \[ "\$\{\{ inputs\.boundary \}\}" = "il5" \]; then\s*\n\s*TAG_LIST="\$TAG_LIST v3\.0"/);
  });

  it('says plainly that the lane has never been executed', () => {
    // A build lane nobody has run is not evidence of anything, and a green CI
    // on this PR must not be read as proof that it works.
    expect(read('.github/workflows/gov-build-images.yml')).toMatch(/HAS NEVER BEEN EXECUTED/);
  });
});

describe('honest text — the one thing a deploy cannot do', () => {
  it('names the Conditional Access exclusion in the gate a human actually reads', () => {
    const reg = read('apps/fiab-console/lib/gates/registry/observability.ts');
    const note = reg.slice(reg.indexOf("'svc-synthetic-monitor'"), reg.indexOf("'svc-synthetic-login'"));
    expect(note).toMatch(/Conditional Access/);
    expect(note).toMatch(/svc-loom-synthetic@limitlessdata\.ai/);
    expect(note).toMatch(/TENANT ADMIN/);
    // It must not imply the deploy makes results appear.
    expect(note).toMatch(/stays EMPTY|only appear/i);
  });

  it('keeps the same statement in the runbook', () => {
    const doc = read('docs/fiab/runbooks/synthetic-journeys.md');
    expect(doc).toMatch(/Conditional Access/);
    // The account, but NOT the operator's live domain — scripts/ci/check-docs-hygiene.mjs
    // fails the build on a real tenant domain anywhere under docs/.
    expect(doc).toMatch(/svc-loom-synthetic@<your-tenant-domain>/);
    expect(doc).not.toMatch(/limitlessdata\.ai/);
    expect(doc).toMatch(/stays empty/i);
  });
});
