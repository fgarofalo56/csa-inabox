/**
 * Pause-safety guards shared by the orchestrator (plan + act time) and the ARM
 * actuator (defence in depth). Kept in its own module so the actuator can use it
 * without importing the orchestrator.
 */

/** Tag values that mark a Container App as the surface that resumes the estate. */
const RESUME_SURFACE_TAG_VALUES: readonly string[] = ['console', 'resume-surface'];

/**
 * Decide whether a Container App may be scaled to zero. FAILS SAFE: an app is
 * eligible only when it can be POSITIVELY identified as not the console.
 *
 * Held out (left running) when ANY of these holds:
 *   - this process's own app name (`CONTAINER_APP_NAME`, set by the platform)
 *     is unknown - we cannot tell which app is us, so none may be touched;
 *   - the app is named the same as this process (it IS the running console);
 *   - the app's name contains "console" (the deployed name is `loom-console`);
 *   - a `loom-role` or `loom-estate-pause` tag marks it console / resume-surface
 *     / exempt.
 */
export function containerAppPauseGuard(
  app: { name: string; tags: Readonly<Record<string, string>> | null },
  selfAppName: string | undefined,
): { eligible: boolean; reason: string } {
  const self = String(selfAppName ?? '').trim().toLowerCase();
  const name = String(app.name ?? '').trim().toLowerCase();
  if (!self) {
    return {
      eligible: false,
      reason:
        `${app.name} is a Container App and this process could not identify its own app name `
        + '(CONTAINER_APP_NAME unset), so it cannot be established that the app is not the console. Left RUNNING.',
    };
  }
  if (!name) return { eligible: false, reason: 'A Container App with no name cannot be identified. Left RUNNING.' };
  if (name === self) {
    return { eligible: false, reason: `${app.name} is the app running this console; pausing it would strand the resume surface. Left RUNNING.` };
  }
  if (name.includes('console')) {
    return { eligible: false, reason: `${app.name} is named like the Loom console, the surface that resumes the estate. Left RUNNING.` };
  }
  if (!app.tags) {
    return { eligible: false, reason: `The tags of ${app.name} could not be read, so an exempt marker could not be ruled out. Left RUNNING.` };
  }
  for (const [k, v] of Object.entries(app.tags)) {
    const key = k.toLowerCase();
    const val = String(v).trim().toLowerCase();
    if (key === 'loom-role' && RESUME_SURFACE_TAG_VALUES.includes(val)) {
      return { eligible: false, reason: `${app.name} is tagged loom-role=${v}, the resume surface. Left RUNNING.` };
    }
    if (key === 'loom-estate-pause' && val === 'exempt') {
      return { eligible: false, reason: `${app.name} is tagged loom-estate-pause=exempt. Left RUNNING.` };
    }
  }
  return { eligible: true, reason: `${app.name} is positively identified as a non-console Loom app.` };
}
