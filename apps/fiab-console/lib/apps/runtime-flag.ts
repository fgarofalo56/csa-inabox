/**
 * Loom App Runtime kill switch (DBX-1).
 *
 * DEFAULT-ON / opt-out posture (WAVES.md global principle): the runtime is
 * enabled by default for any user with workspace access — NO spend gate, NO
 * approval gate. Two opt-out controls remove that running default:
 *   1. LOOM_APPS_RUNTIME_ENABLED env — deployment-wide force-disable. Set to
 *      "false" to hard-off the runtime regardless of tenant settings. Unset /
 *      "true" ⇒ enabled (matches the `_ENABLED$` env-sync allowlist pattern).
 *   2. tenant-settings toggle `apps.runtimeEnabled` (default true) — a
 *      tenant-admin flip in /admin/tenant-settings with no redeploy.
 *
 * When disabled: build/deploy/start are blocked with an honest 403, the editor
 * shows a banner, and running apps are stopped on their next lifecycle action.
 * Read at the top of every state-changing BFF route.
 */

import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import type { TenantSettingsDoc } from '@/lib/types/tenant-settings';

/** True when the env var force-disables the runtime deployment-wide. */
export function appsRuntimeEnvDisabled(): boolean {
  return (process.env.LOOM_APPS_RUNTIME_ENABLED ?? 'true').trim().toLowerCase() === 'false';
}

export interface AppsRuntimeState {
  enabled: boolean;
  /** 'env' when the env var force-disabled it; 'tenant' when the admin toggle is off. */
  disabledBy?: 'env' | 'tenant';
}

/**
 * Resolve the effective runtime state for a tenant. The env force-disable wins;
 * otherwise the tenant-settings `apps.runtimeEnabled` toggle governs (default
 * true — a tenant that never saved settings is enabled). Best-effort: a Cosmos
 * read failure defaults to ENABLED (fail-open to the default-ON posture).
 */
export async function resolveAppsRuntimeState(tenantId: string): Promise<AppsRuntimeState> {
  if (appsRuntimeEnvDisabled()) return { enabled: false, disabledBy: 'env' };
  try {
    const c = await tenantSettingsContainer();
    const { resource } = await c.item(tenantId, tenantId).read<TenantSettingsDoc>();
    // Unset toggle (older doc / never-saved tenant) ⇒ default-on.
    const v = resource?.settings?.['apps.runtimeEnabled'];
    if (v === false) return { enabled: false, disabledBy: 'tenant' };
    return { enabled: true };
  } catch {
    return { enabled: true };
  }
}

/** Human-readable reason for a disabled runtime (surfaced in the honest 403 / banner). */
export function appsRuntimeDisabledReason(state: AppsRuntimeState): string {
  if (state.disabledBy === 'env') {
    return 'The Loom App Runtime is disabled deployment-wide (LOOM_APPS_RUNTIME_ENABLED=false). ' +
      'An administrator must re-enable it in the deployment config.';
  }
  return 'The Loom App Runtime is disabled for this tenant. A tenant administrator can re-enable it under ' +
    'Admin → Tenant settings → Loom App Runtime.';
}
