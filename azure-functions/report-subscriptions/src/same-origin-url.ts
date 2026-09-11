/**
 * Same-origin resolution for URLs that carry a credential (advisory
 * GHSA-4gvx-9p49-p43g) — the report-subscriptions runtime's copy.
 *
 * WHY THIS IS A COPY AND NOT AN IMPORT. The console's definition lives at
 * `apps/fiab-console/lib/util/same-origin-url.ts`. This Container App Job is a
 * SEPARATE npm package with its own `tsconfig.json` whose `rootDir` is this
 * directory and whose `include` is `src/**\/*.ts`; nothing outside the package
 * is compilable from here, and it ships its own image. So the choice was a copy
 * or nothing, and "nothing" is what left the literal advisory construction in
 * `insights-engine.armGet()` after the console-side fix.
 *
 * The drift risk that a copy carries is real, and it is answered by the guard
 * (`apps/fiab-console/lib/util/__tests__/credential-url-origin-guard.test.ts`)
 * scanning the WHOLE REPOSITORY rather than the console's two directories —
 * this file is inside the population it polices, and so is every future one.
 * `src/__tests__/same-origin-url.test.ts` re-runs the hostile-candidate table
 * against THIS implementation rather than trusting the console's receipt.
 *
 * The shape it exists to kill:
 *
 *     const url = path.startsWith('http') ? path : `${BASE}${path}`;
 *     fetch(url, { headers: { authorization: `Bearer ${tok}` } });
 *
 * The absolute branch is required — ARM paginates by handing back an absolute
 * `nextLink` — but as written it accepts ANY host, and `nextLink` (like the
 * `id` this engine reads out of an ARM list) comes from a RESPONSE BODY. So
 * whatever influences that body chooses where the ARM token is sent.
 *
 * WHY ORIGIN, NOT A PREFIX: `startsWith(base)` is not a host check.
 * `https://management.azure.com.evil.test/x` and
 * `https://management.azure.com@evil.test/x` both pass it and both resolve
 * elsewhere. `URL.origin` folds scheme + host + port into one comparable value,
 * so it also rejects an `http://` downgrade and an off-port impostor.
 *
 * FAILS CLOSED: a candidate that cannot be SHOWN to be inside the boundary is
 * treated as outside. Nothing here ever falls through to a fetch.
 */

/** Why a candidate URL was refused. */
export type OffOriginReason = 'unparseable' | 'off-origin';

/**
 * Thrown when a credential would have travelled to an address that is not the
 * configured service endpoint. The message deliberately does NOT echo the
 * rejected value: it is attacker-chosen, and reflecting it puts it into the
 * run log.
 */
export class OffOriginUrlError extends Error {
  readonly reason: OffOriginReason;
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
 * `URL.origin` is the STRING `'null'` for an opaque origin (a `data:` or
 * `blob:` URL), which would compare equal to another opaque origin. Those are
 * never a service endpoint, so they are refused rather than allowed to match.
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
 * True when `candidate` parses AND shares an origin with `base`. False — never
 * a throw — when either side fails to parse: a base that cannot be parsed
 * admits nothing, which is the fail-closed direction.
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
 * - A RELATIVE path is concatenated onto `base` verbatim (no re-encoding, so it
 *   is a drop-in for the `` `${BASE}${path}` `` it replaces) and the RESULT is
 *   origin-checked, which closes the path-shaped escapes too.
 * - An ABSOLUTE URL is permitted only when its origin equals `base`'s, and is
 *   returned normalized via `URL.toString()`.
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
    // The raw concatenation, not URL.toString(): normalizing here would
    // re-encode paths and query strings that already work today.
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
