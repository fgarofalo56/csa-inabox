/**
 * udf-endpoint-policy — the ONE place that decides WHERE a Loom "invoke a
 * function" call goes and WHICH credential (if any) rides with it.
 *
 * THE DEFECT THIS CLOSES (critical)
 *   `POST /api/items/user-data-function/<id>/invoke` read its destination from
 *   the item's `state.azureFunctionUrl` and its credential from the item's
 *   `state.functionKeySecret` — both arbitrary JSON any authenticated user can
 *   write via `PATCH /api/items/user-data-function/<id>`. The Console then read
 *   that named Key Vault secret with its managed identity and sent it, as
 *   `x-functions-key`, to that named host. `invokeFunction()` in
 *   loom-function-runtime.ts had the same shape via a registry row's
 *   `baseUrlOverride` / `functionKeySecret`.
 *
 * WHY PINNING THE HOST ALONE IS NOT A FIX
 *   The deployment default for `LOOM_UDF_FUNCTION_BASE` is the `loom-udf-runtime`
 *   Container App, and that host EXECUTES the same item's `state.source`
 *   (`x-udf-source-b64`). Pinning the destination to config therefore still
 *   delivers the secret into code the caller wrote. The destination has to be
 *   operator-configured AND not a code-execution surface.
 *
 * THE MODEL (structural — the bad state is unrepresentable)
 *   1. Endpoints come from operator config ONLY. A request may SELECT one; the
 *      string that is fetched is the CONFIG value, never the request's.
 *   2. The function key comes from the SELECTED ENDPOINT'S config, never from
 *      item state. Item state may only agree with it.
 *   3. `acceptsPushedSource === !keySecretName`, by construction. A keyed
 *      endpoint never receives caller-authored source; a source-executing
 *      endpoint never receives a credential. One flag, one invariant, no
 *      ordering bug can break it.
 *
 * CONFIG
 *   LOOM_UDF_FUNCTION_BASE            the deployment's function host — the
 *                                     loom-udf-runtime Container App by default
 *                                     (bicep modules/admin-plane/udf-runtime.bicep)
 *   LOOM_UDF_FUNCTION_KEY_SECRET      optional Key Vault secret name holding the
 *                                     host key for the base above. Setting it
 *                                     marks that base as keyed, so Loom stops
 *                                     pushing authored source to it.
 *   LOOM_UDF_ALLOWED_FUNCTION_BASES   optional extra Azure Function App bases an
 *                                     operator approves for per-item overrides.
 *                                     Entry form: `https://host` or
 *                                     `https://host=<keyVaultSecretName>`.
 *   LOOM_FABRIC_UDF_HOST              opt-in Fabric backend host (never default).
 *   LOOM_FABRIC_UDF_ALLOWED_HOSTS     extra approved Fabric hosts.
 *
 * A default deployment is unaffected: with no per-item override the configured
 * base is used exactly as before, and the shared runtime never had a function
 * key to send (udf-runtime/app.py does not read `x-functions-key`).
 */

export interface UdfEndpoint {
  /** Base URL to invoke. ALWAYS a configuration string. */
  base: string;
  /**
   * Key Vault secret holding this host's function key, from operator config.
   * Absent = the endpoint is anonymous and no credential is ever attached.
   */
  keySecretName?: string;
  /**
   * True when Loom may push the item's authored source to this endpoint
   * (`x-udf-source-b64`). Mutually exclusive with `keySecretName`: a host that
   * runs caller-supplied code must never be handed a credential.
   */
  acceptsPushedSource: boolean;
}

export interface UdfEndpointGate {
  missing: string;
  detail: string;
}

/**
 * Normalised comparison key for a base URL: lowercase origin + trimmed path.
 *
 * EXPORTED so the editor's endpoint picker decides "is this saved base the same
 * endpoint as that approved one?" with the EXACT function `resolveUdfEndpoint`
 * uses. A second, look-alike comparison in the UI is how a picker comes to show
 * a saved value as unapproved that the invoke route accepts (or the reverse) —
 * the two answers have to be the same answer, not two implementations of it.
 * This module imports nothing and touches no `process.env` at load, so it is
 * safe in a client bundle.
 */
export function udfEndpointKey(raw: string): string | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  // Credentials or a query/fragment in a base URL are never legitimate config
  // and are the classic way to smuggle an approved host into a different one.
  if (u.username || u.password || u.search || u.hash) return null;
  return `${u.origin.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
}

/** Internal alias kept so the call sites below read as they always have. */
const endpointKey = udfEndpointKey;

/** Split a comma / whitespace separated config list. */
function splitList(raw?: string | null): string[] {
  return String(raw || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Every function endpoint this deployment approves, config order preserved. The
 * FIRST entry is the default used when an item names no override.
 */
export function configuredUdfEndpoints(): UdfEndpoint[] {
  const out: UdfEndpoint[] = [];
  const seen = new Set<string>();

  const push = (rawBase: string, rawKey?: string) => {
    const base = rawBase.replace(/\/+$/, '');
    const key = endpointKey(base);
    if (!key || seen.has(key)) return;
    seen.add(key);
    const keySecretName = (rawKey || '').trim() || undefined;
    out.push({ base, keySecretName, acceptsPushedSource: !keySecretName });
  };

  for (const b of splitList(process.env.LOOM_UDF_FUNCTION_BASE)) {
    push(b, process.env.LOOM_UDF_FUNCTION_KEY_SECRET);
  }
  for (const entry of splitList(process.env.LOOM_UDF_ALLOWED_FUNCTION_BASES)) {
    // `https://host` or `https://host=<kv-secret-name>`. Split on the LAST '='
    // so a base URL can never eat the separator (a base URL with a query string
    // is rejected by endpointKey anyway).
    const eq = entry.lastIndexOf('=');
    if (eq > 0) push(entry.slice(0, eq), entry.slice(eq + 1));
    else push(entry);
  }
  return out;
}

export function udfEndpointGate(requestedOverride?: string | null): UdfEndpointGate {
  if (requestedOverride) {
    return {
      missing: 'LOOM_UDF_ALLOWED_FUNCTION_BASES',
      detail:
        'This item names a function endpoint that this deployment has not approved. Loom will not send ' +
        'a Key Vault credential or a managed-identity token to a host chosen by item configuration. An ' +
        'operator can approve an Azure Function App by adding it to LOOM_UDF_ALLOWED_FUNCTION_BASES on ' +
        'the Console Container App (entry form: https://my-fn.azurewebsites.net=<key-vault-secret-name>).',
    };
  }
  return {
    missing: 'LOOM_UDF_FUNCTION_BASE',
    detail:
      'No function execution endpoint is configured for this deployment. Deploy ' +
      'platform/fiab/bicep/modules/admin-plane/udf-runtime.bicep (udfRuntimeEnabled, default on) so ' +
      'LOOM_UDF_FUNCTION_BASE is set on the Console Container App, or add an approved Azure Function ' +
      'App base URL to LOOM_UDF_ALLOWED_FUNCTION_BASES.',
  };
}

/**
 * Resolve the endpoint to invoke on.
 *
 * @param requestedBase       untrusted, user-writable override (item
 *                            `state.azureFunctionUrl` / registry
 *                            `baseUrlOverride`). It may only SELECT a
 *                            configured endpoint.
 * @param requestedKeySecret  untrusted, user-writable key-secret name (item
 *                            `state.functionKeySecret`). It may only AGREE with
 *                            the selected endpoint's configured key.
 */
/**
 * Does an item's requested key-secret name DISAGREE with the endpoint's
 * configured one? An EMPTY request is not a disagreement — item state that
 * names no key is the normal, compliant case, and the endpoint's own configured
 * key is used.
 *
 * EXPORTED for the same reason `udfEndpointKey` is, and this one was learned
 * the hard way: the editor hand-rolled this comparison and dropped the
 * empty-request clause, so it warned "Run returns 409" on every keyed endpoint
 * whose item named no key — a 409 `resolveUdfEndpoint` does not raise, on a
 * brand-new untouched item, contradicting the old UI's own "Optional. Blank =
 * anonymous / Entra-protected". A UI that answers a policy question with a
 * second implementation of the policy is the defect this whole change set
 * exists to remove, so there is now exactly one implementation and both callers
 * use it.
 */
export function udfKeySecretDisagrees(
  requestedKeySecret: string | null | undefined,
  endpointKeySecretName?: string,
): boolean {
  const askedKey = String(requestedKeySecret || '').trim();
  return !!askedKey && askedKey.toLowerCase() !== (endpointKeySecretName || '').toLowerCase();
}

export function resolveUdfEndpoint(
  requestedBase?: string | null,
  requestedKeySecret?: string | null,
): { endpoint: UdfEndpoint } | { gate: UdfEndpointGate } {
  const endpoints = configuredUdfEndpoints();
  if (!endpoints.length) return { gate: udfEndpointGate(null) };

  const want = String(requestedBase || '').trim();
  let endpoint: UdfEndpoint | undefined;
  if (!want) {
    endpoint = endpoints[0];
  } else {
    const key = endpointKey(want);
    endpoint = key ? endpoints.find((e) => endpointKey(e.base) === key) : undefined;
    if (!endpoint) return { gate: udfEndpointGate(want) };
  }

  const askedKey = String(requestedKeySecret || '').trim();
  if (udfKeySecretDisagrees(askedKey, endpoint.keySecretName)) {
    // The item named a Key Vault secret this endpoint is not configured to use.
    // Refusing (rather than ignoring) keeps the failure honest: the operator is
    // told exactly which env var turns the item's intent into approved config.
    return {
      gate: {
        missing: 'LOOM_UDF_FUNCTION_KEY_SECRET',
        detail:
          `This item asks Loom to send the Key Vault secret "${askedKey}" to ${endpoint.base}, but this ` +
          'deployment has not configured a function key for that endpoint. The key a function host ' +
          'receives is deployment configuration, never item configuration — set ' +
          'LOOM_UDF_FUNCTION_KEY_SECRET (for the default base) or approve the host with ' +
          '`<base>=<key-vault-secret-name>` in LOOM_UDF_ALLOWED_FUNCTION_BASES.',
      },
    };
  }
  return { endpoint };
}

// ── Opt-in Fabric backend (never the default path) ──────────────────────────

/** Every Fabric UDF host this deployment approves. */
export function configuredFabricUdfHosts(): string[] {
  return [
    ...splitList(process.env.LOOM_FABRIC_UDF_HOST),
    ...splitList(process.env.LOOM_FABRIC_UDF_ALLOWED_HOSTS),
  ].map((h) => h.replace(/\/+$/, ''));
}

/**
 * Resolve the opt-in Fabric endpoint. This branch attaches a UAMI Fabric-scoped
 * bearer token, so — exactly as above — the host comes from config and the
 * per-item workspace/item path is REBUILT beneath it rather than passed through.
 */
export function resolveFabricUdfEndpoint(
  requestedEndpoint?: string | null,
  workspaceId?: string | null,
  itemId?: string | null,
): { base: string } | { gate: UdfEndpointGate } | null {
  const hosts = configuredFabricUdfHosts();
  const gate: UdfEndpointGate = {
    missing: 'LOOM_FABRIC_UDF_HOST',
    detail:
      'The opt-in Fabric backend is selected but this item names a Fabric endpoint the deployment has ' +
      'not approved. Set LOOM_FABRIC_UDF_HOST (or add the host to LOOM_FABRIC_UDF_ALLOWED_HOSTS) on the ' +
      'Console Container App. Loom will not send a managed-identity token to an endpoint chosen by item ' +
      'configuration.',
  };

  const requested = String(requestedEndpoint || '').trim();
  if (requested) {
    if (!hosts.length) return { gate };
    const wantKey = endpointKey(requested);
    if (!wantKey) return { gate };
    for (const host of hosts) {
      const hostKey = endpointKey(host);
      if (!hostKey) continue;
      if (wantKey === hostKey) return { base: host };
      if (wantKey.startsWith(`${hostKey}/`)) {
        // Rebuild from the CONFIG root + the validated relative segments.
        const rel = wantKey.slice(hostKey.length + 1);
        const segments = rel.split('/').filter(Boolean).map((s) => encodeURIComponent(decodeURIComponent(s)));
        return { base: `${host}/${segments.join('/')}` };
      }
    }
    return { gate };
  }

  // No explicit endpoint: compose from config + the item's Fabric ids.
  const ws = String(workspaceId || '').trim();
  const it = String(itemId || '').trim();
  if (!ws || !it) return null;
  const host = hosts[0];
  if (!host) return { gate };
  return { base: `${host}/${encodeURIComponent(ws)}/${encodeURIComponent(it)}` };
}
