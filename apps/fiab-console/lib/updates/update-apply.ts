/**
 * In-product update path — pre-flight + apply orchestration.
 *
 * The no-clone update: a deployed tenant rolls its Loom Container Apps to a new
 * upstream release's PUBLIC images WITHOUT cloning the repo or running CI. The
 * Console UAMI already holds Container Apps Contributor on the admin RG (the
 * same grant the Scale pane uses), so it can PATCH each app's image via ARM.
 *
 * Target images are PUBLIC GitHub Container Registry packages:
 *   ghcr.io/<owner>/<app>:<X.Y.Z>
 * published on each release tag by .github/workflows/publish-ghcr-images.yml.
 * Because they are public, no registry credential is needed on the container
 * app — ACA pulls them anonymously.
 *
 * HONESTY (no-vaporware.md): the apply NEVER fakes success. Pre-flight:
 *   1. Resolve the target = latest non-prerelease GitHub release.
 *   2. Refuse if current >= target (already up to date / ahead).
 *   3. HEAD the ghcr manifest for EVERY app's target image; if any are missing,
 *      return an honest gate naming exactly which images aren't published yet.
 *   4. Verify ARM/UAMI is configured (LOOM_SUBSCRIPTION_ID + RG) — else gate.
 * Apply: PATCH each app sequentially, reporting real per-app ARM status. A
 * single per-app failure is reported verbatim; it does not fabricate success
 * for the others.
 *
 * This module is pure orchestration over injected dependencies (GitHub fetch,
 * ghcr HEAD, ARM image roll) so the pre-flight + gate logic is unit-testable
 * without hitting Azure or the network.
 */

import { checkCompat, type RequiredEnv } from './compat-manifest';

/** The Loom deployable apps, in the order they should be rolled.
 *
 * `acaName`  — the Microsoft.App/containerApps resource name (bicep `app.name`).
 * `image`    — the ghcr image base name (matches the build matrix `app:` key).
 *
 * loom-console is rolled LAST so the operator's session (served by the console)
 * survives long enough to observe the other apps' progress before the console
 * itself briefly restarts.
 */
export interface LoomApp {
  acaName: string;
  image: string;
}

export const LOOM_APPS: LoomApp[] = [
  { acaName: 'loom-mcp', image: 'loom-mcp' },
  { acaName: 'loom-mcp-bridge', image: 'loom-mcp-bridge' },
  { acaName: 'loom-activator', image: 'loom-activator' },
  { acaName: 'loom-mirroring', image: 'loom-mirroring' },
  { acaName: 'loom-direct-lake-shim', image: 'loom-direct-lake-shim' },
  { acaName: 'loom-copilot-maf', image: 'loom-copilot-maf' },
  { acaName: 'loom-setup-orchestrator', image: 'loom-setup-orchestrator' },
  { acaName: 'loom-console', image: 'loom-console' },
];

/** Default ghcr owner. The release workflow publishes under this account. */
export const DEFAULT_GHCR_OWNER =
  process.env.LOOM_GHCR_OWNER || process.env.LOOM_FEEDBACK_REPO_OWNER || 'fgarofalo56';

/** ghcr registry host. Override for a sovereign mirror via LOOM_GHCR_REGISTRY. */
export const GHCR_REGISTRY = process.env.LOOM_GHCR_REGISTRY || 'ghcr.io';

/**
 * Strip the `csa-inabox-` prefix and leading `v` off a release tag to get the
 * bare semver used as the image tag. `csa-inabox-v0.43.1` → `0.43.1`.
 */
export function tagToImageVersion(tag: string): string {
  return tag.replace(/^csa-inabox-/, '').replace(/^v/, '');
}

/** The full public image ref for an app at a given image-version. */
export function imageRef(app: LoomApp, owner: string, imageVersion: string): string {
  return `${GHCR_REGISTRY}/${owner}/${app.image}:${imageVersion}`;
}

/** Compare two semver-ish strings (handles `v` prefixes + the tag prefix). -1/0/1. */
export function compareVersions(a: string, b: string): number {
  const na = tagToImageVersion(a).split('.').map((x) => Number(x) || 0);
  const nb = tagToImageVersion(b).split('.').map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(na.length, nb.length); i += 1) {
    const x = na[i] ?? 0;
    const y = nb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export interface GhRelease {
  tag_name: string;
  name: string;
  published_at: string;
  html_url: string;
  prerelease: boolean;
  draft?: boolean;
}

/** A per-app image-existence probe result. */
export interface ImageProbe {
  app: string;
  ref: string;
  exists: boolean;
  /** HTTP status the HEAD returned (for diagnostics), or 0 on network error. */
  status: number;
}

/** A per-app apply result. */
export interface AppApplyResult {
  app: string;
  fromImage: string;
  toImage: string;
  /** 'succeeded' | 'updating' (async 202 accepted) | 'failed' | 'skipped'. */
  status: 'succeeded' | 'updating' | 'failed' | 'skipped';
  /** ARM provisioningState verbatim when available. */
  provisioningState?: string;
  /** Error message when status === 'failed'. */
  error?: string;
}

export type GateReason =
  | 'already-up-to-date'
  | 'no-upstream-release'
  | 'images-not-published'
  | 'arm-not-configured'
  | 'requires-infra-redeploy';

export interface PreflightGate {
  ok: false;
  reason: GateReason;
  message: string;
  /** For 'images-not-published': the apps whose target image is missing. */
  missingImages?: ImageProbe[];
  /** For 'arm-not-configured': the env vars to set. */
  missingEnv?: string[];
  /**
   * For 'requires-infra-redeploy': the newly-required env vars the running
   * deployment is missing (each with why + the exact bicep remediation).
   */
  missingRequiredEnv?: RequiredEnv[];
  /** For 'requires-infra-redeploy': running infra version is older than required. */
  infraTooOld?: { required: string; actual: string };
}

export interface PreflightOk {
  ok: true;
  current: string;
  target: GhRelease;
  /** The bare image version (e.g. '0.43.1') the apps will be rolled to. */
  imageVersion: string;
  owner: string;
  /** The resolved per-app target image refs (all confirmed to exist). */
  plan: { app: string; acaName: string; toImage: string }[];
  probes: ImageProbe[];
}

export type PreflightResult = PreflightGate | PreflightOk;

/** Injected dependencies — real implementations live in the BFF route. */
export interface UpdateDeps {
  /** Fetch upstream releases (most-recent first). */
  listReleases: () => Promise<GhRelease[]>;
  /** HEAD a ghcr manifest. Resolves to the HTTP status (200 = exists). */
  headImage: (ref: string) => Promise<number>;
  /** True when ARM is configured (returns the missing env list otherwise). */
  armConfig: () => { configured: boolean; missing: string[] };
  /** The currently-running version (bare or tagged). */
  currentVersion: string;
  /**
   * True when a LOOM_* env var is present (non-empty) on the running console.
   * Used to compare the compat manifest's newly-required env against what bicep
   * actually deployed (process.env). Optional so existing callers/tests keep
   * working — when absent, the compat gate is skipped.
   */
  envPresent?: (name: string) => boolean;
  /** LOOM_INFRA_VERSION — the version the platform bicep last deployed at ('' if unknown). */
  infraVersion?: string;
}

/**
 * Resolve the target release + verify every app's public image exists.
 * Returns a typed gate (with the precise remediation) or a green-light plan.
 */
export async function preflight(deps: UpdateDeps, owner = DEFAULT_GHCR_OWNER): Promise<PreflightResult> {
  // (a) ARM must be configured to roll anything.
  const arm = deps.armConfig();
  if (!arm.configured) {
    return {
      ok: false,
      reason: 'arm-not-configured',
      message:
        'The in-product updater needs the Console UAMI + admin resource group configured to roll Container Apps. ' +
        `Set ${arm.missing.join(', ')} on loom-console (admin-plane/main.bicep wires these by default).`,
      missingEnv: arm.missing,
    };
  }

  // Resolve target = latest non-prerelease, non-draft release.
  const releases = await deps.listReleases();
  const stable = releases.filter((r) => !r.prerelease && !r.draft);
  const target = stable[0];
  if (!target) {
    return {
      ok: false,
      reason: 'no-upstream-release',
      message: 'No stable upstream release found to update to.',
    };
  }

  // (b) Refuse if current >= target.
  if (compareVersions(deps.currentVersion, target.tag_name) >= 0) {
    return {
      ok: false,
      reason: 'already-up-to-date',
      message: `Already running ${deps.currentVersion} (>= latest release ${target.tag_name}). Nothing to update.`,
    };
  }

  const imageVersion = tagToImageVersion(target.tag_name);

  // (b2) Compatibility manifest: an image roll only changes the container image
  // (it re-sends the existing env + does NOT re-run bicep), so it cannot supply
  // a newly-required env var, role, or resource. If the target (or any release
  // skipped over to reach it) newly requires env the running deployment doesn't
  // have — or the running infra predates the required bicep version — BLOCK with
  // the exact remediation instead of rolling into a half-broken state. Only
  // enforced when the route wired the running-deployment facts (envPresent).
  if (deps.envPresent) {
    const compat = checkCompat(
      { envPresent: deps.envPresent, infraVersion: deps.infraVersion ?? '' },
      deps.currentVersion,
      target.tag_name,
    );
    if (!compat.ok) {
      const envList = compat.missingEnv.map((e) => e.name).join(', ');
      const parts: string[] = [];
      if (compat.missingEnv.length > 0) {
        parts.push(
          `it newly requires ${compat.missingEnv.length} env var(s) not set on this deployment (${envList})`,
        );
      }
      if (compat.infraTooOld) {
        parts.push(
          `its infrastructure predates the required bicep version (running ${compat.infraTooOld.actual}, needs ${compat.infraTooOld.required})`,
        );
      }
      return {
        ok: false,
        reason: 'requires-infra-redeploy',
        message:
          `Update to ${target.tag_name} needs an infrastructure re-deploy first: ${parts.join('; ')}. ` +
          'The in-product image roll only changes the app image — it cannot add env vars, grant roles, or ' +
          'provision resources. Re-deploy platform/fiab/bicep (az deployment sub create) to apply the new ' +
          'requirements, then retry this update.',
        missingRequiredEnv: compat.missingEnv,
        infraTooOld: compat.infraTooOld,
      };
    }
  }

  // (c) HEAD every app's target image — refuse if any are missing.
  const probes: ImageProbe[] = [];
  for (const app of LOOM_APPS) {
    const ref = imageRef(app, owner, imageVersion);
    let status = 0;
    try {
      status = await deps.headImage(ref);
    } catch {
      status = 0;
    }
    probes.push({ app: app.acaName, ref, exists: status === 200, status });
  }
  const missingImages = probes.filter((p) => !p.exists);
  if (missingImages.length > 0) {
    return {
      ok: false,
      reason: 'images-not-published',
      message:
        `Target release ${target.tag_name} images are not all published to ${GHCR_REGISTRY}/${owner} yet ` +
        `(${missingImages.length}/${LOOM_APPS.length} missing). ` +
        'The release CI (.github/workflows/publish-ghcr-images.yml) must finish publishing the public images ' +
        'before this update can roll. Re-check shortly.',
      missingImages,
    };
  }

  return {
    ok: true,
    current: deps.currentVersion,
    target,
    imageVersion,
    owner,
    plan: LOOM_APPS.map((app) => ({
      app: app.image,
      acaName: app.acaName,
      toImage: imageRef(app, owner, imageVersion),
    })),
    probes,
  };
}

/**
 * Roll each app to its target image, sequentially, reporting real per-app
 * status. `rollImage` is the injected ARM image-roll (the route passes
 * updateContainerAppImage). A per-app failure is captured verbatim and the loop
 * CONTINUES so the operator sees the full picture — but `allSucceeded` is false.
 *
 * `existsAcaName` lets the route skip apps that aren't deployed on this boundary
 * (e.g. loom-copilot-maf only exists on Gov; loom-setup-orchestrator may be
 * GitOps-managed on AKS). A skipped app is reported `status:'skipped'`, not
 * faked as succeeded.
 */
export async function applyRoll(
  plan: PreflightOk['plan'],
  rollImage: (acaName: string, image: string) => Promise<{ fromImage: string; toImage: string; provisioningState: string }>,
  opts?: { appExists?: (acaName: string) => Promise<boolean> },
): Promise<{ results: AppApplyResult[]; allSucceeded: boolean }> {
  const results: AppApplyResult[] = [];
  for (const step of plan) {
    if (opts?.appExists) {
      let present = true;
      try { present = await opts.appExists(step.acaName); } catch { present = true; }
      if (!present) {
        results.push({ app: step.acaName, fromImage: '', toImage: step.toImage, status: 'skipped' });
        continue;
      }
    }
    try {
      const r = await rollImage(step.acaName, step.toImage);
      const ps = (r.provisioningState || '').toLowerCase();
      results.push({
        app: step.acaName,
        fromImage: r.fromImage,
        toImage: r.toImage,
        status: ps === 'succeeded' ? 'succeeded' : 'updating',
        provisioningState: r.provisioningState,
      });
    } catch (e: any) {
      results.push({
        app: step.acaName,
        fromImage: '',
        toImage: step.toImage,
        status: 'failed',
        error: e?.message || String(e),
      });
    }
  }
  const allSucceeded = results.every((r) => r.status === 'succeeded' || r.status === 'updating' || r.status === 'skipped');
  return { results, allSucceeded };
}
