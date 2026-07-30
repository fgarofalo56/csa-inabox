/**
 * lib/util/random-id.ts — the one place Loom generates random identifiers.
 *
 * WHY THIS EXISTS (#2656, CodeQL js/insecure-randomness — 25 reported alerts,
 * 40+ actual sites).
 *
 * `Math.random()` is not a CSPRNG. V8 implements it with xorshift128+, whose
 * internal state is recoverable from a handful of observed outputs — so given a
 * few identifiers, an attacker can predict subsequent ones.
 *
 * Reviewed every site, and **none of the current ones mints a secret**: they are
 * audit-row ids, notebook cell ids, run ids, temp resource names, and canvas node
 * positions. So this is not an exploitable finding today, and the honest framing
 * is not "40 vulnerabilities".
 *
 * The risk is the 41st site. In a codebase where `Math.random()` is the house
 * style for identifiers, someone eventually copies an ID generator into a place
 * that mints a share link, an invite code, a reset nonce, or an idempotency key
 * that must be unguessable — and it looks exactly like the surrounding code, so
 * it survives review. Making the crypto path the DEFAULT removes that failure
 * mode instead of relying on each future author classifying their own use.
 *
 * The cost is nil: `crypto.getRandomValues` is a few hundred nanoseconds, and
 * every one of these sites already calls `Date.now()`.
 *
 * WHAT DOES *NOT* BELONG HERE. Two current uses of `Math.random()` are correct
 * and must stay:
 *
 *   lib/telemetry/rum.ts        `Math.random() * 100 < sampleRate`  — sampling
 *   lib/clients/cost-client.ts  retry backoff jitter
 *
 * Those are STATISTICAL, not identity. Nothing is guessed, nothing is
 * authenticated, and swapping in a CSPRNG would add cost for no security gain.
 * They are documented as deliberate exclusions in the guard, not oversights.
 */

/**
 * WebCrypto refuses a single request larger than this (QuotaExceededError). Found
 * by the uniformity test in this module's suite, which asks for 36k symbols —
 * without chunking, `randomSuffix` threw for any length above ~32k.
 */
const MAX_GETRANDOMVALUES_BYTES = 65_536;

/** Crypto-safe bytes, working in both Node and the browser/edge. */
function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // `globalThis.crypto` is present in Node 19+, the edge runtime, and browsers.
  const c = globalThis.crypto;
  if (!c?.getRandomValues) {
    // Deliberately THROWS rather than falling back to Math.random(). A silent
    // downgrade is how an "unguessable" id quietly becomes guessable — the whole
    // defect this module removes. Every runtime Loom targets has WebCrypto.
    throw new Error('No CSPRNG available (globalThis.crypto.getRandomValues) — refusing to generate a weak identifier.');
  }
  // Fill in chunks so a large request cannot exceed the per-call quota.
  for (let off = 0; off < n; off += MAX_GETRANDOMVALUES_BYTES) {
    c.getRandomValues(out.subarray(off, Math.min(off + MAX_GETRANDOMVALUES_BYTES, n)));
  }
  return out;
}

/**
 * A crypto-random base36 suffix of `len` characters.
 *
 * Drop-in replacement for the `Math.random().toString(36).slice(2, N)` idiom this
 * repo used ~40 times, with the same shape (lowercase alphanumeric) so ids stay
 * readable in logs and valid in Azure resource names.
 *
 * Rejection-sampled to stay UNIFORM: taking `byte % 36` would make the first four
 * symbols ~1.4x likelier than the rest, which quietly costs entropy. 252 is the
 * largest multiple of 36 below 256, so bytes above it are discarded.
 */
export function randomSuffix(len = 8): string {
  const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
  let out = '';
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b >= 252) continue; // reject to keep the distribution flat
      out += ALPHABET[b % 36];
      if (out.length === len) break;
    }
  }
  return out;
}

/**
 * `<prefix>-<base36 timestamp>-<crypto suffix>` — the canonical Loom identifier.
 *
 * The timestamp is kept because it makes ids sort roughly chronologically and is
 * genuinely useful when reading an audit table; it is NOT relied on for
 * uniqueness or unguessability. The suffix supplies both.
 */
export function randomId(prefix: string, suffixLen = 8): string {
  return `${prefix}-${Date.now().toString(36)}-${randomSuffix(suffixLen)}`;
}

/**
 * A full RFC-4122 v4 UUID from the platform CSPRNG.
 *
 * Prefer this when the value is an opaque handle rather than something a human
 * reads. Falls back to assembling one from {@link randomBytes} on a runtime
 * without `randomUUID` — still crypto-random, never `Math.random()`.
 */
export function randomUuid(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
