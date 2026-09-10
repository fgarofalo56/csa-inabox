/**
 * Same-origin resolution for URLs that carry a credential — the ONE definition.
 *
 * THE CLASS OF BUG THIS EXISTS TO KILL. Every credentialed client in this
 * codebase resolves its request target with some spelling of:
 *
 *     const url = path.startsWith('http') ? path : `${BASE}${path}`;
 *     fetch(url, { headers: { authorization: `Bearer ${token}` } });
 *
 * The absolute branch is REQUIRED — ARM and Microsoft Graph paginate by handing
 * back an absolute `nextLink` / `@odata.nextLink` that must be fetched verbatim
 * — but as written it accepts ANY host. `nextLink` is read out of a RESPONSE
 * BODY, so whatever can influence that body chooses where the console's
 * management-plane or Graph token is sent.
 *
 * This was found and fixed once before, keyed to a single function
 * (`networking-client.resolveArmUrl`, #2652; then `foundry-cs-client.armListAll`,
 * PR #4443 review). Keying a fix to a function name leaves every sibling
 * unguarded and the next client re-introduces it, which is exactly what
 * happened. This module is keyed to the SHAPE, and
 * `lib/util/__tests__/credential-url-origin-guard.test.ts` derives its
 * population from the filesystem so a newly added client cannot opt out by
 * being new.
 *
 * WHY ORIGIN, NOT A PREFIX. `startsWith(base)` is not a host check. Both of
 * these pass it and both resolve somewhere else entirely:
 *
 *     https://management.azure.com.evil.test/x   → host management.azure.com.evil.test
 *     https://management.azure.com@evil.test/x   → host evil.test  (userinfo)
 *
 * `URL.origin` folds scheme + host + port into one comparable value, so it also
 * rejects an `http://` downgrade and an off-port impostor for free.
 *
 * BOUNDARY-CORRECT BY CONSTRUCTION. The base is always passed IN — `armBase()`,
 * `graphBase()`, a Key Vault URL — never hardcoded here, so Commercial, GCC,
 * GCC-High, IL5 and DoD all compare against their own endpoint
 * (`.claude/rules/cloud-parity.md`).
 *
 * FAILS CLOSED. An unparseable candidate cannot be SHOWN to be inside the
 * boundary, so it is treated as outside: `resolveSameOriginUrl` throws and
 * `sameOriginUrlOrNull` returns null. Neither ever falls through to a fetch,
 * and neither guesses that a malformed absolute URL was "probably a path".
 *
 * NO IMPORTS. Like `host-match.ts`, this is a leaf: it must be reachable from
 * any client, including ones inside the auth stack, with no cycle risk.
 */

/** Why a candidate URL was refused. */
export type OffOriginReason = 'unparseable' | 'off-origin';

/**
 * Thrown when a credential would have travelled to an address that is not the
 * configured service endpoint.
 *
 * The message deliberately does NOT echo the rejected value. It is
 * attacker-chosen; reflecting it puts it into logs and into whatever response
 * the caller builds from the error.
 */
export class OffOriginUrlError extends Error {
  readonly reason: OffOriginReason;
  /** What was about to be sent, e.g. 'the ARM token'. Never the rejected URL. */
  readonly credentialLabel: string;
  constructor(reason: OffOriginReason, credentialLabel = 'a credential') {
    super(
      reason === 'unparseable'
        ? `Refusing to send ${credentialLabel} to an unparseable URL`
        : `Refusing to send ${credentialLabel} to an origin that is not the configured service endpoint`,
    );
    this.name = 'OffOriginUrlError';
    this.reason = reason;
    this.credentialLabel = credentialLabel;
  }
}

/** True when `raw` looks like an absolute http(s) URL rather than a path. */
export function isAbsoluteHttpUrl(raw: string | null | undefined): boolean {
  return /^https?:\/\//i.test((raw || '').trim());
}

/**
 * The parsed origin of `raw`, or null when it does not parse.
 *
 * `URL.origin` is `'null'` (the STRING) for opaque origins — a `data:` or
 * `blob:` URL — which would compare equal to another opaque origin. Those are
 * never a service endpoint, so they are refused here rather than allowed to
 * match each other.
 */
function originOf(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!u.origin || u.origin === 'null') return null;
  return u.origin;
}

/**
 * True when `candidate` parses AND shares an origin with `base`.
 *
 * False — never a throw — when either side fails to parse. A base that cannot
 * be parsed admits nothing, which is the fail-closed direction: a misconfigured
 * endpoint stops the call rather than opening it up.
 */
export function isSameOrigin(candidate: string | null | undefined, base: string | null | undefined): boolean {
  const c = originOf((candidate || '').trim());
  const b = originOf((base || '').trim());
  if (!c || !b) return false;
  return c === b;
}

/**
 * Resolve a path-or-absolute-URL against `base`, refusing anything off-origin.
 *
 * - A RELATIVE path is concatenated onto `base` verbatim (no re-encoding, so
 *   this is a drop-in for the `` `${BASE}${path}` `` it replaces) and the RESULT
 *   is then origin-checked, which closes the path-shaped escapes too.
 * - An ABSOLUTE URL is permitted only when its origin equals `base`'s, and is
 *   returned normalized via `URL.toString()`.
 *
 * Throws {@link OffOriginUrlError} on anything else. It never returns a URL the
 * caller may fetch with a credential unless the origin was actually checked.
 */
export function resolveSameOriginUrl(
  pathOrUrl: string,
  base: string,
  credentialLabel = 'a credential',
): string {
  const raw = pathOrUrl ?? '';
  const baseOrigin = originOf((base || '').trim());
  if (!baseOrigin) throw new OffOriginUrlError('unparseable', credentialLabel);

  if (!isAbsoluteHttpUrl(raw)) {
    const joined = `${base}${raw}`;
    const joinedOrigin = originOf(joined);
    if (!joinedOrigin) throw new OffOriginUrlError('unparseable', credentialLabel);
    if (joinedOrigin !== baseOrigin) throw new OffOriginUrlError('off-origin', credentialLabel);
    // Return the raw concatenation, not URL.toString(): normalizing here would
    // silently re-encode paths and query strings that already work today.
    return joined;
  }

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw new OffOriginUrlError('unparseable', credentialLabel);
  }
  if (target.origin !== baseOrigin) throw new OffOriginUrlError('off-origin', credentialLabel);
  return target.toString();
}

/**
 * {@link resolveSameOriginUrl} for a paging walk: returns null instead of
 * throwing, so the loop STOPS on a bad continuation link and keeps the rows it
 * already collected.
 *
 * Stopping is the fail-closed outcome for a walker — the alternative, letting
 * the exception out, is re-read by callers as "the resource does not exist"
 * (the failure mode `paging-budget.ts` documents at length). Nothing is
 * fetched either way.
 */
export function sameOriginUrlOrNull(
  pathOrUrl: string | null | undefined,
  base: string,
): string | null {
  if (pathOrUrl === null || pathOrUrl === undefined || pathOrUrl === '') return null;
  try {
    return resolveSameOriginUrl(pathOrUrl, base);
  } catch {
    return null;
  }
}

/**
 * Assert `candidate` is on `base`'s origin, returning it unchanged.
 *
 * For call sites that already hold a complete absolute URL (a `nextLink` about
 * to be fetched) and want the check without rebuilding the string.
 */
export function assertSameOrigin(
  candidate: string,
  base: string,
  credentialLabel = 'a credential',
): string {
  if (!isSameOrigin(candidate, base)) {
    throw new OffOriginUrlError(
      originOf((candidate || '').trim()) ? 'off-origin' : 'unparseable',
      credentialLabel,
    );
  }
  return candidate;
}
