/**
 * Loom function-on-objects runtime client (WS-4.2) — the REAL callable endpoint a
 * registered function executes on. Azure-native by DEFAULT (per
 * .claude/rules/no-fabric-dependency.md): the Loom UDF runtime (an ACA container
 * app) OR any Azure Function App, reached at `POST {base}/api/<functionPath>`.
 * This is the SAME invoke shape the user-data-function editor uses — WS-4.2
 * reuses that runtime rather than standing up a new one.
 *
 * Used by:
 *   - a `function`-kind derived property (object-view route) — compute a value, and
 *   - an ontology action's `validationFunction` (run-action route) — validate a
 *     write before it commits (403/422 on fail).
 *
 * Honest-gate (no-vaporware.md): when `LOOM_UDF_FUNCTION_BASE` is unset and the
 * function has no explicit base URL, `functionRuntimeGate()` returns the exact
 * remediation and callers surface it (the surface still renders — a derived prop
 * shows "runtime not configured", an action validation fails-open only when the
 * action does not require validation). No mocks, ever.
 */
import { getKeyVaultSecretValue, vaultUrl } from '@/lib/azure/kv-secrets-client';
import { resolveUdfEndpoint } from '@/lib/azure/udf-endpoint-policy';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import type { RegisteredFunction } from '@/lib/foundry/function-registry-model';

/** Base URL of the Loom UDF runtime / an Azure Function App host. */
export function functionRuntimeBase(): string {
  return (process.env.LOOM_UDF_FUNCTION_BASE || '').trim();
}

export interface FunctionRuntimeGate {
  missing: string;
  detail: string;
  remediation: string;
}

/**
 * Honest config gate for the function runtime. Returns null when a base URL is
 * available (either the shared runtime env var or the function's own override),
 * else a structured gate the route surfaces verbatim.
 */
export function functionRuntimeGate(fn?: Pick<RegisteredFunction, 'baseUrlOverride'>): FunctionRuntimeGate | null {
  // A `baseUrlOverride` no longer satisfies the gate on its own: an override that
  // the deployment has not approved is exactly the endpoint we refuse to invoke.
  const resolved = resolveUdfEndpoint(fn?.baseUrlOverride);
  if ('endpoint' in resolved) return null;
  if (fn?.baseUrlOverride) {
    return {
      missing: resolved.gate.missing,
      detail: resolved.gate.detail,
      remediation:
        'Approve this Azure Function App by adding it to LOOM_UDF_ALLOWED_FUNCTION_BASES on the Console ' +
        'Container App (entry form: https://my-fn.azurewebsites.net=<key-vault-secret-name>), or clear the ' +
        "function's base-URL override to use the deployment's shared runtime.",
    };
  }
  return {
    missing: 'LOOM_UDF_FUNCTION_BASE',
    detail:
      'Set LOOM_UDF_FUNCTION_BASE to the shared Loom UDF runtime (or an Azure Function App) base ' +
      'URL — the Azure-native backend that executes registered functions-on-objects.',
    remediation:
      'Deploy platform/fiab/bicep/modules/admin-plane/udf-runtime.bicep (udfRuntimeEnabled, default ' +
      'on → the loom-udf-runtime Container App); admin-plane/main.bicep then emits ' +
      'LOOM_UDF_FUNCTION_BASE onto the Console app. A dedicated Function App can override it per ' +
      'function via baseUrlOverride. No Microsoft Fabric is required.',
  };
}

export interface FunctionInvokeResult {
  ok: boolean;
  status: number;
  /** The parsed JSON return value when the body is JSON, else the raw text. */
  value: unknown;
  /** The raw response text (bounded). */
  body: string;
  error?: string;
}

/**
 * Invoke a registered function on the runtime: `POST {base}/api/<functionPath>`
 * with the JSON payload. Optional Key-Vault-sourced function key becomes the
 * `x-functions-key` header. Returns the parsed value + raw body + HTTP status —
 * never throws for a non-2xx (the caller decides how to interpret it).
 */
export async function invokeFunction(
  fn: RegisteredFunction,
  payload: unknown,
): Promise<FunctionInvokeResult> {
  // SECURITY (same defect as the user-data-function invoke route): a registry
  // row's `baseUrlOverride` / `functionKeySecret` are tenant-writable config, and
  // this call reads a named Key Vault secret with the Console's managed identity.
  // Both the destination and the key are therefore resolved from DEPLOYMENT
  // configuration — the row may only select/agree. See udf-endpoint-policy.ts.
  const resolved = resolveUdfEndpoint(fn.baseUrlOverride, fn.functionKeySecret);
  if ('gate' in resolved) {
    return { ok: false, status: 409, value: null, body: '', error: resolved.gate.detail };
  }
  const endpoint = resolved.endpoint;
  const base = endpoint.base.replace(/\/+$/, '');
  const path = fn.functionPath || fn.name;
  const url = `${base}/api/${encodeURIComponent(path)}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (endpoint.keySecretName) {
    if (!vaultUrl()) {
      return {
        ok: false, status: 409, value: null, body: '',
        error: 'A function key is configured for this endpoint but no Key Vault is available (set LOOM_KEY_VAULT_URI).',
      };
    }
    try {
      headers['x-functions-key'] = await getKeyVaultSecretValue(endpoint.keySecretName, 'udf-function-key');
    } catch (e) {
      return { ok: false, status: 502, value: null, body: '', error: `key vault: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  try {
    const res = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(payload ?? {}) });
    const text = (await res.text()).slice(0, 64 * 1024);
    let value: unknown = text;
    try { value = JSON.parse(text); } catch { /* non-JSON body → raw text */ }
    return { ok: res.ok, status: res.status, value, body: text };
  } catch (e) {
    return { ok: false, status: 502, value: null, body: '', error: e instanceof Error ? e.message : String(e) };
  }
}

/** The verdict shape a validation function is expected to return. */
export interface ValidationVerdict {
  valid: boolean;
  message?: string;
}

/**
 * Interpret a function's return value as a validation verdict. Accepts:
 *   - `{ valid: boolean, message? }`   (canonical)
 *   - `{ ok: boolean, error? }`         (BFF-envelope style)
 *   - a bare boolean                    (true = valid)
 * Anything else is treated as INVALID (fail-closed) with a diagnostic message —
 * a validation function that returns garbage must not silently pass a write.
 */
export function interpretVerdict(value: unknown): ValidationVerdict {
  if (typeof value === 'boolean') return { valid: value };
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.valid === 'boolean') {
      return { valid: o.valid, ...(typeof o.message === 'string' ? { message: o.message } : {}) };
    }
    if (typeof o.ok === 'boolean') {
      return { valid: o.ok, ...(typeof o.error === 'string' ? { message: o.error } : {}) };
    }
  }
  return { valid: false, message: 'validation function did not return a { valid: boolean } verdict' };
}
