/**
 * function-endpoint-policy — the ONE place that decides where a Loom "invoke a
 * function" call may go.
 *
 * THE DEFECT THIS CLOSES (critical, multi-tenant):
 *   `POST /api/items/user-data-function/<id>/invoke` read its destination from
 *   the item's own `state.azureFunctionUrl` and its credential from the item's
 *   own `state.functionKeySecret` — both arbitrary JSON any authenticated user
 *   can write through `PATCH /api/items/user-data-function/<id>`. A user could
 *   therefore make the Console read ANY secret out of the Loom Key Vault (the
 *   MSAL client secret, git PATs, connection strings) and POST it, as the
 *   `x-functions-key` header, to a host they control. `invokeFunction()` in
 *   loom-function-runtime.ts had the identical shape via `baseUrlOverride`.
 *
 * THE FIX (structural, not sanitisation):
 *   A request may only SELECT among endpoints an operator configured. The base
 *   that is actually fetched is the CONFIG string — a request value is compared
 *   against config and then discarded — so the destination cannot diverge from
 *   an approved one by construction. Nothing is stripped, escaped or rewritten.
 *
 * CONFIG
 *   LOOM_UDF_FUNCTION_BASE          the Loom UDF runtime / Function App base
 *                                   (bicep: modules/admin-plane/udf-runtime.bicep)
 *   LOOM_UDF_ALLOWED_FUNCTION_BASES optional comma-separated EXTRA bases an
 *                                   operator approves for per-item overrides
 *
 * Default deployments are unaffected: with no override the configured base is
 * used exactly as before. An override that is not configured returns an honest
 * gate naming the env var to extend (no-vaporware.md).
 */
import {
  parseBaseList,
  resolveConfiguredBase,
  type ConfiguredBaseGate,
} from '@/lib/azure/trusted-egress';

/** Every function-host base this deployment approves, config order preserved. */
export function allowedFunctionBases(): string[] {
  return [
    ...parseBaseList(process.env.LOOM_UDF_FUNCTION_BASE),
    ...parseBaseList(process.env.LOOM_UDF_ALLOWED_FUNCTION_BASES),
  ];
}

export const FUNCTION_BASE_GATE: ConfiguredBaseGate = {
  missing: 'LOOM_UDF_ALLOWED_FUNCTION_BASES',
  detail:
    'No function execution endpoint is configured for this deployment. Deploy ' +
    'platform/fiab/bicep/modules/admin-plane/udf-runtime.bicep (udfRuntimeEnabled, default on) so ' +
    'LOOM_UDF_FUNCTION_BASE is set on the Console Container App, or add an approved Azure Function ' +
    'App base URL to LOOM_UDF_ALLOWED_FUNCTION_BASES.',
};

/**
 * Resolve the base URL to invoke on. `requested` is the untrusted, user-writable
 * override (item `state.azureFunctionUrl` / registry `baseUrlOverride`).
 * Returns the CONFIGURED base on success, or an honest gate.
 */
export function resolveFunctionBase(
  requested?: string | null,
): { base: string } | { gate: ConfiguredBaseGate } {
  return resolveConfiguredBase(requested, allowedFunctionBases(), FUNCTION_BASE_GATE);
}

/**
 * Every Fabric UDF host base this deployment approves. Fabric is opt-in only
 * (no-fabric-dependency.md); `state.fabricEndpoint` is user-writable, so it too
 * may only select among configured hosts — otherwise a UAMI Fabric-scoped
 * bearer token goes wherever an item says.
 */
export function allowedFabricFunctionBases(): string[] {
  return [
    ...parseBaseList(process.env.LOOM_FABRIC_UDF_HOST),
    ...parseBaseList(process.env.LOOM_FABRIC_UDF_ALLOWED_HOSTS),
  ];
}

/**
 * True when `endpoint` is under one of the configured Fabric UDF hosts. Used to
 * accept a per-item `state.fabricEndpoint` that names a workspace/item path
 * beneath an approved host (the shape the opt-in Fabric backend publishes).
 */
export function isAllowedFabricEndpoint(endpoint: string): boolean {
  const want = String(endpoint || '').trim();
  if (!want) return false;
  let wantUrl: URL;
  try {
    wantUrl = new URL(want);
  } catch {
    return false;
  }
  if (wantUrl.protocol !== 'https:') return false;
  return allowedFabricFunctionBases().some((h) => {
    try {
      const base = new URL(String(h).trim().replace(/\/+$/, ''));
      if (base.origin.toLowerCase() !== wantUrl.origin.toLowerCase()) return false;
      const basePath = base.pathname.replace(/\/+$/, '');
      const wantPath = wantUrl.pathname.replace(/\/+$/, '');
      return wantPath === basePath || wantPath.startsWith(`${basePath}/`);
    } catch {
      return false;
    }
  });
}
