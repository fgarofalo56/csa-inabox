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

/**
 * Slice ONE `- name: <name>` step out of a workflow, up to the next sibling
 * step, so an assertion can be scoped to that step's own YAML keys and `run:`
 * body instead of matching anywhere in a 590-line file. Returns '' when the
 * step is absent, which is itself the thing worth failing on.
 *
 * Every regex applied to the result must tolerate BOTH line endings: .gitattributes
 * pins `platform/fiab/bicep/**` and `sdk/**` to LF but NOT `.github/workflows/**`,
 * so with core.autocrlf=true these files read as CRLF on a Windows checkout and as
 * LF on the Linux CI runner. A needle spelled `\n` that silently no-ops against
 * `\r\n` is a gate that passes locally and measures nothing where it counts.
 */
function ghStep(wf: string, name: string): string {
  const marker = `- name: ${name}`;
  const start = wf.indexOf(marker);
  if (start < 0) return '';
  const body = wf.slice(start + marker.length);
  const end = body.search(/\n {6}- name: /);
  return end < 0 ? body : body.slice(0, end);
}

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
    // `$BOUNDARY`, NOT `${{ inputs.boundary }}` — and the distinction is the
    // assertion, not an incidental reflow (#3781).
    //
    // #3745 gave this lane a `schedule:` trigger, and a `workflow_dispatch`
    // `default:` DOES NOT APPLY on a schedule event. So on the nightly run
    // `${{ inputs.boundary }}` interpolates to the EMPTY STRING, the test
    // becomes `[ "" = "il5" ]`, and the IL5 console would silently stop being
    // pushed as :v3.0 — while the lane still exited 0. The workflow-level
    // `env:` block (`BOUNDARY: ${{ inputs.boundary || 'gcc-high' }}`) is the
    // single defaults table that makes all three triggers agree, and `$BOUNDARY`
    // is how the shell reads it.
    //
    // This is therefore deliberately NOT written to accept both shapes, unlike
    // the cosign assertion above. There the two spellings were equally correct;
    // here the old one is the regression, so matching it would license exactly
    // the silent failure #3730 was filed off.
    expect(wf).toMatch(/if \[ "\$APP" = "loom-console" \] && \[ "\$BOUNDARY" = "il5" \]; then\s*\n\s*TAG_LIST="\$TAG_LIST v3\.0"/);
  });

  it('refuses to pass on a tag it has not PROVEN landed, on every tag, with no valve', () => {
    // WHAT THIS REPLACED, AND WHY (#3781).
    //
    // This test used to require the literal banner `HAS NEVER BEEN EXECUTED` in
    // the workflow header, under the name "says plainly that the lane has never
    // been executed". #3745 removed that banner CORRECTLY: the lane has since
    // run for real (header records last success 2026-08-08) and now carries
    // `schedule` + `workflow_call` triggers, so a header claiming nobody had
    // ever run it had become FALSE. The workflow was right and this gate was
    // stale — the same trap the two comments above already record twice.
    //
    // The INTENT is kept, because it is still valid: a build lane's own exit
    // code is not evidence that it produced anything, so nothing downstream may
    // assume it worked. What changed is the FACT that intent was pinned to. A
    // banner is a narrative whose truth value moves with history; the step that
    // REFUSES to pass on an unproven tag is behaviour, and it cannot go stale
    // the same way. The workflow header points here itself: "Everything
    // downstream of the build is still written to fail LOUDLY rather than assume
    // it worked: see the … step below."
    const wf = read('.github/workflows/gov-build-images.yml');
    const verify = ghStep(wf, 'Verify the DEPLOY-REFERENCED tag exists in the Gov ACR');
    expect(verify, 'the tag-existence verification step is GONE from the Gov build lane').not.toBe('');

    // It runs on EVERY build. `skip_supply_chain` is the loud emergency valve
    // for Trivy + cosign; it must not also switch off the proof that the tag ARM
    // will pull exists. So this step carries no `if:` and no `continue-on-error:`.
    // Anchored at 8 spaces = the step-key column, so a shell `if [ … ]` inside
    // the `run:` body (deeper, and with no colon) cannot be mistaken for one.
    expect(verify).not.toMatch(/^ {8}if:/m);
    expect(verify).not.toMatch(/^ {8}continue-on-error:/m);

    // Every tag the build pushed, not just the first — the per-boundary matrix
    // above is the whole reason a single-tag check would ship broken.
    expect(verify).toMatch(/for T in \$\{TAG_LIST:-/);

    // ...and BOTH outcomes are fail-closed, which is the property with teeth:
    //   1. the tag is genuinely absent          -> exit 1
    //   2. the registry could not be READ AT ALL -> exit 1, because UNPROVEN is
    //      not disproven (deploy-integrity.md R7). It classifies the captured
    //      stderr through deploy-classify.mjs rather than collapsing a denial,
    //      a throttle and a real 404 into one empty string and then stating the
    //      404 as fact — the exact false claim that cost two investigations.
    //
    // Two separate needles rather than one spanning regex ON PURPOSE: in the
    // workflow those tokens sit either side of a shell line-continuation
    // (`--text "$SHOW_OUT" \` / newline / `--assert-signal …`). Where the author
    // chose to wrap the line is formatting, and a gate keyed to it would go red
    // on a reflow that changed nothing — which is the fragility class this whole
    // test exists to stop repeating.
    expect(verify).toMatch(/node scripts\/ci\/deploy-classify\.mjs/);
    expect(verify).toMatch(/--assert-signal config\.image-tag-absent/);
    expect((verify.match(/exit 1\b/g) || []).length).toBeGreaterThanOrEqual(2);

    // A verification whose result is discarded is not a verification.
    expect(verify).not.toMatch(/\|\| true/);
  });
});

describe('the Gov image lane still runs on a SCHEDULE (#3730/#3745)', () => {
  /**
   * WHY THIS IS HERE AT ALL.
   *
   * `gov-build-images` is the only thing that moves the `:v0.1` tag every Gov
   * .bicepparam resolves. Before #3730 nothing but a human dispatch could start
   * it, and the measured consequence was `deploy-gov` reporting SUCCESS on
   * 2026-08-16 while the live Gov console still served an image built on
   * 2026-08-11. #3730/#3745 gave the lane a nightly `schedule:`. NOTHING
   * asserted that the trigger survives.
   *
   * Deleting three lines from `on:` returns Gov to dispatch-only and every check
   * in this repo stays green — the same shape as the issue this block is being
   * added under (#3783): not a gate that is missing, a state nothing watches.
   *
   * The three tests below are ONE property in three parts. A `schedule:` that
   * fires and builds nothing is not better than no `schedule:` — it is worse,
   * because it also produces a green run every morning.
   *
   * `.gitattributes` does not pin `.github/workflows/**`, so every regex here
   * must survive CRLF on a Windows checkout and LF on the runner (see `ghStep`).
   */
  const GOV = '.github/workflows/gov-build-images.yml';

  it('keeps the `schedule:` trigger, with a well-formed cron', () => {
    const wf = read(GOV);

    // Anchored at the `on:` mapping's own indent. This file discusses the
    // schedule at length in comments, and every one of those lines starts with
    // `  #` — so the word cannot satisfy this. The TRIGGER has to.
    expect(
      wf,
      'gov-build-images lost its schedule: trigger — the Gov lane is back to dispatch-only (#3730)',
    ).toMatch(/^ {2}schedule:/m);

    const cron = wf.match(/^ {4}- cron: *'([^']+)'/m);
    expect(cron, 'the schedule: block carries no `- cron:` entry').not.toBeNull();

    // The HOUR is deliberately NOT pinned. 07:37 UTC was chosen from measured
    // merge traffic (see the trigger's own comment) and a re-measurement should
    // be free. What must hold is that the expression is a well-formed 5-field
    // cron: GitHub silently declines to schedule a malformed one, so an emptied
    // or mangled value fails HERE rather than by never firing at 07:37.
    expect(
      cron![1].trim().split(/\s+/),
      `'${cron![1]}' is not a 5-field cron expression`,
    ).toHaveLength(5);
  });

  it('carries the workflow-level `env:` defaults a schedule event needs', () => {
    const wf = read(GOV);
    const start = wf.search(/^env:/m);
    const end = wf.search(/^jobs:/m);
    expect(start, 'no workflow-level env: block').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const env = wf.slice(start, end);

    // `inputs` EXISTS on a schedule event but carries NOTHING, and a
    // `workflow_dispatch` `default:` does not apply to any other trigger — the
    // trap that froze deploy-fiab-commercial's nightly reconcile for weeks.
    // Without this defaults table the nightly run resolves an empty app list,
    // the build matrix is `[]`, `build` is skipped, and the workflow concludes
    // SUCCESS having produced no image.
    expect(env).toMatch(/BOUNDARY: \$\{\{ inputs\.boundary \|\| '[^']+' \}\}/);
    expect(env).toMatch(/APPS_IN: \$\{\{ inputs\.apps \|\| '[^']+' \}\}/);
    expect(env).toMatch(/TAG_IN: \$\{\{ inputs\.tag \|\| '[^']+' \}\}/);
  });

  it('refuses to conclude success having resolved zero apps', () => {
    const wf = read(GOV);
    // `ghStep` keys on `- name:`; this step is spelled `- id: r` then `name:`,
    // so slice it by hand rather than asserting against the whole 590-line file.
    const marker = 'name: Resolve coordinates';
    const at = wf.indexOf(marker);
    expect(at, 'the Resolve coordinates step is GONE from the Gov build lane').toBeGreaterThan(-1);
    const rest = wf.slice(at + marker.length);
    const next = rest.search(/\n {6}- (?:name|id): /);
    const resolve = next < 0 ? rest : rest.slice(0, next);

    // An empty matrix does not error on its own: `build` is simply skipped and
    // the run goes green having produced nothing — deploy-integrity R1 verbatim,
    // and the single most likely way the schedule path goes quietly wrong.
    expect(resolve, 'the empty-matrix guard is gone — a scheduled run could build zero images and still pass')
      .toMatch(/if \[ "\$MATRIX" = "\[\]" \] \|\| \[ -z "\$MATRIX" \]; then[\s\S]*?exit 1/);

    // ...and it must stay fail-closed. A valve here would restore the exact
    // silent-success this guard exists to prevent.
    expect(resolve).not.toMatch(/\|\| true/);
    expect(resolve).not.toMatch(/^ {8}continue-on-error:/m);
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
