/**
 * PR #2641 round-2 — DEPLOY-CHAIN INVARIANTS.
 *
 * The round-1 review found the two services "wired" in the sense that env vars
 * existed, while the chain that FILLS them did not close on any documented
 * deploy path. These tests lock the actual repairs so they cannot silently
 * regress. They assert the INFRASTRUCTURE SOURCE, which — unlike a DOM string —
 * is the real artifact for a bicep/CI change.
 *
 * They are deliberately NOT a substitute for the live E2E receipt (rule G1);
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
const TRINO_APP = 'platform/fiab/bicep/modules/data-plane/loom-trino-aca.bicep';
const TRINO_RBAC = 'platform/fiab/bicep/modules/data-plane/loom-trino-lake-rbac.bicep';

describe('svc-synthetic-monitor — the results store actually exists', () => {
  it('does NOT source LOOM_UAT_RESULTS_ACCOUNT from the DLZ lake account', () => {
    const src = read(ADMIN_PLANE);
    // The round-1 shape. loomStorageAccount is EMPTY on every shipped
    // bicepparam (all pin topology='tenant'), so this made the gate red on
    // every from-scratch install in both clouds.
    expect(src).not.toMatch(/LOOM_UAT_RESULTS_ACCOUNT',\s*value:\s*loomStorageAccount/);
  });

  it('sources both results env vars from the uat-results-storage module outputs', () => {
    const src = read(ADMIN_PLANE);
    expect(src).toMatch(/LOOM_UAT_RESULTS_ACCOUNT',\s*value:\s*uatResultsStoreActive\s*\?\s*uatResultsStore!\.outputs\.accountName/);
    expect(src).toMatch(/LOOM_UAT_RESULTS_CONTAINER',\s*value:\s*uatResultsStoreActive\s*\?\s*uatResultsStore!\.outputs\.resultsContainerName/);
  });

  it('deploys the store independently of deployAppsEnabled so it exists before the app phase', () => {
    const src = read(ADMIN_PLANE);
    // The two-phase image path runs phase 1 with deployAppsEnabled=false. If the
    // store were gated on it, the container would not exist when phase 2's app
    // starts reading.
    expect(src).toMatch(/var uatResultsStoreActive = syntheticMonitorEnabled\s*$/m);
    expect(src).toMatch(/module uatResultsStore 'uat-results-storage\.bicep' = if \(uatResultsStoreActive\)/);
  });

  it('CREATES the container, not just an env var pointing at a name', () => {
    const src = read(UAT_STORE);
    expect(src).toMatch(/resource results 'Microsoft\.Storage\/storageAccounts\/blobServices\/containers@/);
    expect(src).toMatch(/name:\s*containerName/);
    // The container-name output is derived FROM the container resource, so the
    // env var cannot be emitted without the container being deployed.
    expect(src).toMatch(/output resultsContainerName string = last\(split\(results\.name, '\/'\)\)/);
  });

  it('keeps the results store private and key-free', () => {
    const src = read(UAT_STORE);
    expect(src).toMatch(/publicNetworkAccess:\s*'Disabled'/);
    expect(src).toMatch(/allowSharedKeyAccess:\s*false/);
    expect(src).toMatch(/allowBlobPublicAccess:\s*false/);
    expect(src).toMatch(/groupIds:\s*\['blob'\]/);
  });

  it('gives the runner a per-cloud blob suffix instead of a commercial literal', () => {
    // The uploader used to hard-code blob.core.windows.net, so every Gov upload
    // silently no-op'd through its best-effort catch and the Journeys tab could
    // never populate in GCC-High / IL5.
    const job = read('platform/fiab/bicep/modules/admin-plane/synthetic-monitor-job.bicep');
    expect(job).toMatch(/LOOM_STORAGE_BLOB_SUFFIX/);
    expect(job).toMatch(/environment\(\)\.suffixes\.storage/);

    const runner = read('apps/fiab-console/e2e/run-uat-unattended.mjs');
    expect(runner).toMatch(/LOOM_STORAGE_BLOB_SUFFIX/);
    expect(runner).not.toMatch(/https:\/\/\$\{accountName\}\.blob\.core\.windows\.net/);
  });
});

describe('svc-loom-trino — cost + scope invariants', () => {
  it('really implements scale-to-zero (the claim the review told us to re-verify)', () => {
    const src = read(TRINO_APP);
    expect(src).toMatch(/param minReplicas int = 0/);
    expect(src).toMatch(/minReplicas:\s*minReplicas/);
    // No workload profile pinned => the app lands on the CAE's Consumption
    // profile, which is where a scaled-to-zero app genuinely bills nothing.
    expect(src).not.toMatch(/workloadProfileName/);
    // ...and the orchestrator must not override the zero.
    expect(read(ADMIN_PLANE)).not.toMatch(/module trinoEngine[\s\S]{0,1200}?minReplicas:/);
  });

  it('creates NO role assignment in the admin-RG-scoped app module', () => {
    // Round-1 bug: an `existing` storage account + a roleAssignment with no
    // scope resolved in the ADMIN RG while the lake lives in loomDlzRg —
    // a guaranteed ResourceNotFound the moment a real account name is passed.
    const src = read(TRINO_APP);
    expect(src).not.toMatch(/Microsoft\.Authorization\/roleAssignments/);
    expect(src).not.toMatch(/resource lake 'Microsoft\.Storage\/storageAccounts/);
  });

  it('grants the lake read at the LAKE resource group scope', () => {
    const rbac = read(TRINO_RBAC);
    // Storage Blob Data Reader — read-only by construction.
    expect(rbac).toMatch(/2a2b9908-6ea1-4ae2-8e65-a410df84e7d1/);
    expect(rbac).not.toMatch(/ba92f5b4-2d11-453d-a403-e96b0029c9fe/); // not Contributor

    const admin = read(ADMIN_PLANE);
    expect(admin).toMatch(/module trinoLakeRbac '\.\.\/data-plane\/loom-trino-lake-rbac\.bicep'[\s\S]{0,200}?scope:\s*resourceGroup\(loomDlzRg\)/);
  });

  it('exposes an in-template path for federation catalogs', () => {
    // Otherwise adding the external source that is the whole point of Trino
    // requires an out-of-band `az containerapp update --set-env-vars` that the
    // next deploy reverts.
    const src = read(TRINO_APP);
    expect(src).toMatch(/param extraEnv object/);
    expect(src).toMatch(/param keyVaultEnv object/);
    expect(read(ADMIN_PLANE)).toMatch(/trinoCatalogs/);
    expect(read(ADMIN_PLANE)).toMatch(/trinoCatalogSecrets/);
  });

  it('carries the JVM flags the current Trino release documents as required', () => {
    const jvm = read('apps/loom-trino/etc/jvm.config');
    // The vectorized execution paths NoClassDefFoundError mid-query without
    // this — a failure mode that keeps /v1/info green, which is worse than a
    // boot failure.
    expect(jvm).toMatch(/^--add-modules=jdk\.incubator\.vector$/m);
    expect(jvm).toMatch(/^-XX:G1HeapRegionSize=32M$/m);
    expect(jvm).toMatch(/^-XX:PerMethodRecompilationCutoff=10000$/m);
    expect(jvm).toMatch(/^-XX:PerBytecodeRecompilationCutoff=10000$/m);
    expect(jvm).toMatch(/^-Djdk\.nio\.maxCachedBufferSize=2000000$/m);
  });
});

describe('both clouds — every referenced image has a Gov producer', () => {
  it('has a Gov image lane that does not require a running console', () => {
    const wf = read('.github/workflows/gov-build-images.yml');
    // Resolves the admin RG by the same convention main.bicep computes, so it
    // runs on a subscription where no app has ever started.
    expect(wf).toMatch(/rg-csa-loom-admin-\$\{LOC\}/);
    expect(wf).toMatch(/loom-console,loom-trino,loom-uat/);
    // Both Gov boundaries.
    expect(wf).toMatch(/- gcc-high/);
    expect(wf).toMatch(/- il5/);
    // SC1 parity with the Commercial matrix.
    expect(wf).toMatch(/aquasecurity\/trivy-action/);
    expect(wf).toMatch(/cosign sign --yes/);
  });

  it('no longer hardcodes the GCC-High estate in the incremental provisioner', () => {
    const wf = read('.github/workflows/gov-provision-trino.yml');
    expect(wf).not.toMatch(/^\s*RG:\s*rg-csa-loom-admin-usgovvirginia\s*$/m);
    expect(wf).not.toMatch(/^\s*ACR:\s*acrloomdcmt6cqoezlgs\s*$/m);
    expect(wf).toMatch(/- il5/);
    expect(wf).toMatch(/aquasecurity\/trivy-action/);
  });

  it('keeps loom-trino in the Commercial roll list and its push-trigger paths', () => {
    const full = read('.github/workflows/full-app-deploy-commercial.yml');
    expect(full).toMatch(/APPS=\(loom-console[^)]*loom-trino\)/);
    const acr = read('.github/workflows/build-fiab-images-acr-tasks.yml');
    expect(acr).toMatch(/'apps\/loom-trino\/\*\*'/);
    expect(acr).toMatch(/"name":"loom-trino"/);
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
    expect(doc).toMatch(/svc-loom-synthetic@limitlessdata\.ai/);
  });
});
