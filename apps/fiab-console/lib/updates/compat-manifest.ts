/**
 * Self-update COMPATIBILITY MANIFEST (rel-T41 / blocker B15).
 *
 * The in-product updater (lib/updates/update-apply.ts) rolls the Loom Container
 * Apps to a new release's PUBLIC images via an ARM image PATCH. That PATCH only
 * changes `template.containers[].image` — it re-sends the app's EXISTING env +
 * secrets and does NOT re-run bicep. So an image roll can NEVER:
 *   - add a newly-required LOOM_* env var, or
 *   - grant a newly-required RBAC role / provision new infra.
 * Those only arrive via a real `az deployment` (bicep re-deploy).
 *
 * THE TRAP this manifest closes: a new release's code may read a NEW required
 * env var (or need a new role/resource). If the tenant only image-rolls, the app
 * comes up on the new image but that env var is UNSET — the feature silently
 * gates off or 500s. Worse, LOOM_VERSION follows the rolled image, so the
 * running-version label reports the new version while the underlying infra is
 * stale (this is exactly why we stamp a SEPARATE, bicep-only LOOM_INFRA_VERSION
 * that image rolls do not touch).
 *
 * HOW IT WORKS: each entry declares what a release NEWLY requires — LOOM_* env
 * vars and a minimum infra (bicep) version. The updater pre-flight aggregates
 * the requirements introduced across (currentVersion, targetVersion] and
 * compares them against the RUNNING deployment (process.env + LOOM_INFRA_VERSION,
 * i.e. what bicep actually emitted — the same source of truth as
 * scripts/ci/check-env-sync.mjs). If the running deployment is missing a
 * newly-required env var, or its infra predates the required bicep version, the
 * update is BLOCKED with an honest gate naming the exact remediation
 * ("re-deploy the platform bicep first: set LOOM_X / grant role Y") instead of
 * rolling into a half-broken state (no-vaporware.md).
 *
 * MAINTENANCE: when a release adds a new hard-required env var or a new role /
 * resource that the image roll cannot supply, add an entry (or extend the
 * current one) here keyed to that release's bare semver. Tuning knobs, opt-in
 * backends, and feature toggles (anything with a code default — see the
 * check-env-sync.mjs allowlist categories) are NOT hard requirements and must
 * NOT be listed: listing them would falsely block updates for deployments that
 * legitimately leave them unset.
 */

import { compareVersions, tagToImageVersion } from './update-apply';

/** A single hard requirement a release introduces that an image roll cannot supply. */
export interface RequiredEnv {
  /** The LOOM_* env var that MUST be present on the running deployment. */
  name: string;
  /** Why the release needs it (surfaced to the operator). */
  reason: string;
  /** The exact remediation — which bicep module sets it / which role to grant. */
  remediation: string;
}

/** Per-release compatibility declaration. `version` is the bare semver (e.g. '0.45.0'). */
export interface ReleaseCompat {
  /** Bare semver of the release that INTRODUCES these requirements. */
  version: string;
  /** LOOM_* env vars this release newly requires on the running deployment. */
  requiredEnv?: RequiredEnv[];
  /**
   * Minimum infra/bicep version the running deployment must be at. Compared
   * against LOOM_INFRA_VERSION (stamped by the platform bicep, NOT changed by an
   * image roll). Only enforced when the running infra version is known —
   * deployments that predate LOOM_INFRA_VERSION are carried by the env-var check.
   */
  minInfraVersion?: string;
  /** Optional human note surfaced with the gate. */
  note?: string;
}

/**
 * The manifest. Ordered newest-last is not required — the checker filters by
 * version range regardless of order.
 *
 * The 0.45.0 floor lists the env the Console cannot run WITHOUT (they are all
 * emitted by platform/fiab/bicep/modules/admin-plane/main.bicep and present in
 * every real deployment, so this never false-blocks a healthy tenant) — it
 * documents the baseline and gives the gate a concrete example to enforce as
 * later releases add to it.
 */
export const COMPAT_MANIFEST: ReleaseCompat[] = [
  {
    version: '0.45.0',
    minInfraVersion: '0.45.0',
    requiredEnv: [
      {
        name: 'LOOM_SUBSCRIPTION_ID',
        reason: 'ARM target for the in-product updater and every control-plane navigator.',
        remediation:
          'Re-deploy platform/fiab/bicep (admin-plane/main.bicep wires it from subscription().subscriptionId).',
      },
      {
        name: 'LOOM_ADMIN_RG',
        reason: 'ARM target resource group for Container App image rolls + scaling.',
        remediation:
          'Re-deploy platform/fiab/bicep (admin-plane/main.bicep wires it from resourceGroup().name).',
      },
      {
        name: 'LOOM_COSMOS_ACCOUNT',
        reason:
          'Console metadata store (workspaces, items, configs). Without it every item/config CRUD fails.',
        remediation:
          'Re-deploy platform/fiab/bicep (admin-plane/loom-console-cosmos.bicep provisions it + wires LOOM_COSMOS_ACCOUNT).',
      },
    ],
    note: 'Baseline requirements — present in every bicep-deployed tenant.',
  },
];

/** The running-deployment facts the compat check reads. */
export interface DeploymentEnv {
  /** True when a LOOM_* env var is present (non-empty) on the running console. */
  envPresent: (name: string) => boolean;
  /** LOOM_INFRA_VERSION — the version the platform bicep last deployed at ('' if unknown). */
  infraVersion: string;
}

/** The aggregated compatibility verdict for an update. */
export interface CompatResult {
  /** Env vars a newer release requires that the running deployment is missing. */
  missingEnv: RequiredEnv[];
  /** Set when the running infra version predates a required minimum. */
  infraTooOld?: { required: string; actual: string };
  /** Convenience: true when nothing blocks the update. */
  ok: boolean;
}

/**
 * Aggregate the requirements introduced across (current, target] — i.e. every
 * manifest entry for a release strictly newer than what's running, up to and
 * including the target. A skipped-over release's requirements still apply.
 */
export function requirementsForUpdate(
  current: string,
  target: string,
  manifest: ReleaseCompat[] = COMPAT_MANIFEST,
): ReleaseCompat[] {
  return manifest.filter(
    (e) =>
      compareVersions(e.version, current) > 0 && compareVersions(e.version, target) <= 0,
  );
}

/**
 * Compare the running deployment against everything the update would require.
 * Returns the missing env vars (deduped) + whether the infra version is too old.
 */
export function checkCompat(
  dep: DeploymentEnv,
  current: string,
  target: string,
  manifest: ReleaseCompat[] = COMPAT_MANIFEST,
): CompatResult {
  const entries = requirementsForUpdate(current, target, manifest);

  // Missing required env — dedupe by name (an env may be required by >1 release).
  const seen = new Set<string>();
  const missingEnv: RequiredEnv[] = [];
  for (const e of entries) {
    for (const req of e.requiredEnv ?? []) {
      if (seen.has(req.name)) continue;
      if (!dep.envPresent(req.name)) {
        seen.add(req.name);
        missingEnv.push(req);
      }
    }
  }

  // Highest required infra version across the range.
  let required = '';
  for (const e of entries) {
    if (e.minInfraVersion && (!required || compareVersions(e.minInfraVersion, required) > 0)) {
      required = e.minInfraVersion;
    }
  }
  let infraTooOld: CompatResult['infraTooOld'];
  // Only enforce infra-version when the running version is KNOWN. Deployments
  // that predate LOOM_INFRA_VERSION report '' and are carried by the env check.
  if (required && dep.infraVersion) {
    if (compareVersions(tagToImageVersion(dep.infraVersion), required) < 0) {
      infraTooOld = { required, actual: tagToImageVersion(dep.infraVersion) };
    }
  }

  return { missingEnv, infraTooOld, ok: missingEnv.length === 0 && !infraTooOld };
}
