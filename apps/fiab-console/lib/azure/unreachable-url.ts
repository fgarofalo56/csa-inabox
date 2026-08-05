/**
 * Pure, dependency-free URL-shape predicate shared by the runtime clients and
 * the health/readiness env-checks.
 *
 * WHY THIS IS A LEAF MODULE. The identical logic already lived inside
 * `lib/azure/iceberg-catalog-client.ts`, which is SERVER-ONLY (it imports the
 * Azure credential chain and Cosmos for the audit trail). `lib/admin/env-checks`
 * therefore could not reuse it, and the two sides disagreed about what
 * "configured" means:
 *
 *   - the RUNTIME correctly rejected `https://0.0.0.0:3000/api/catalog/iceberg`
 *     (the value observed live on the Commercial Console) and returned the
 *     honest 503 not-configured gate, while
 *   - the ENV-CHECK used presence-only `has()` and reported the very same
 *     estate as **Ready**.
 *
 * That is the "gate that cannot fail" class: the health surface scored the
 * capability green while every request against it 503'd. One implementation,
 * imported by both, is the fix — not a second copy.
 *
 * ZERO imports on purpose: this must be safe to pull into an env-check, a
 * client component, or a unit test without dragging server-only modules in.
 */

/**
 * True when `raw` CANNOT be a reachable remote service endpoint, so it must be
 * treated exactly like an unset value (→ the honest not-configured gate) rather
 * than being fetched into an ugly "unreachable at …" error or, worse, counted
 * as configured.
 *
 * Rejects:
 *   - anything `new URL()` cannot parse (an env var holding a hostname, a
 *     shell-expansion leftover, an empty string);
 *   - the unspecified / bind-all addresses `0.0.0.0` and `::`. These are valid
 *     to LISTEN on and are never a valid CONNECT target, so a value carrying one
 *     is a copied listen address, i.e. a placeholder.
 *
 * Deliberately does NOT reject loopback (`localhost` / `127.0.0.1`): a sidecar
 * on the same Container App is a legitimate, reachable target.
 *
 * @param raw the raw env value (untrimmed is fine)
 * @param selfProxyPattern optional caller-specific pattern matching this app's
 *   OWN BFF proxy path — a value pointing back at it is circular, not a service.
 */
export function isUnreachableServiceUrl(raw: string, selfProxyPattern?: RegExp): boolean {
  const value = (raw || '').trim();
  if (!value) return true;
  let host = '';
  try {
    host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return true; // unparseable → cannot be reached
  }
  // Bind-all / unspecified addresses — valid to LISTEN on, never to connect to.
  if (host === '0.0.0.0' || host === '::' || host === '0:0:0:0:0:0:0:0') return true;
  if (selfProxyPattern && selfProxyPattern.test(value)) return true;
  return false;
}
