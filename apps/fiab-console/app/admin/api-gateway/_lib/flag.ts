/**
 * LOOM_APIPLANE_ENABLED read for the legacy-route redirects (W1-5).
 *
 * Same default and parsing as the registry (lib/api-gateway/registry/gateway-service.ts:
 * `(env.LOOM_APIPLANE_ENABLED ?? 'true').toLowerCase() === 'false'` turns the plane OFF):
 * unset means ON, only the literal string "false" (any case) means OFF.
 * Pages that call this must be dynamic (`export const dynamic = 'force-dynamic'`) so the
 * value is read at request time, not frozen at build time.
 */
export const HUB_PATH = '/admin/api-gateway';

export function isApiPlaneEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.LOOM_APIPLANE_ENABLED ?? 'true').toLowerCase() !== 'false';
}

/** Where a legacy admin route sends the browser: the hub when the plane is on, null (stay put) when off. */
export function legacyRedirectTarget(
  hubPath: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  return isApiPlaneEnabled(env) ? hubPath : null;
}
