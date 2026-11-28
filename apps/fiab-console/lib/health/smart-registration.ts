/**
 * SMART client registration rules shared by the health-tenant Apps tab and its
 * BFF route (#5151, #5454 A6). Pure: no Next, no Azure, so the dialog and
 * `app/api/health/tenants/_lib/smart-apps.ts` run the SAME checks, and the BFF
 * re-runs them on every POST (the browser is never trusted).
 *
 * The control plane (apps/loom-health-cp/src/auth/server.ts ClientCreateSchema
 * and its POST /api/health/auth/clients handler) is the authority. The lists
 * below mirror it, because the Console image is built from apps/fiab-console
 * alone and cannot import CP source; `__tests__/smart-registration.test.ts`
 * reads the CP files at test time and fails on drift.
 */

/**
 * JWK members that only a PRIVATE key carries. The CP refuses `d p q dp dq qi k`; `oth` (RSA multi-prime private
 * info, RFC 7518 6.3.2.7) is added here so the Console refuses a superset.
 */
export const PRIVATE_JWK_MEMBERS: readonly string[] = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'];

/** The CP's `token_endpoint_auth_signing_alg_values_supported`. A key whose `alg` is outside this can never sign. */
export const ALLOWED_JWK_ALGS: readonly string[] = ['RS384', 'ES384'];

/** The CP's `MIN_RSA_BITS` (apps/loom-health-cp/src/auth/jwks-guard.ts). */
export const MIN_RSA_BITS = 2048;

/** Console caps for a pasted JWKS: serialized size in bytes and key count (the CP allows 20 keys). */
export const JWKS_LIMITS = { maxBytes: 16 * 1024, maxKeys: 10, maxKidLength: 200, maxX5c: 5 } as const;

/**
 * The ONLY members a registered JWK may carry (an allowlist, not a denylist: the CP stores unknown members, so a
 * denylist forwards anything it did not think of, e.g. `D`, `__proto__`, or a private-key DER smuggled in `x5c`).
 * Anything else is refused, and the forwarded object is rebuilt from these members alone.
 */
export const JWK_COMMON_MEMBERS: readonly string[] = ['kty', 'kid', 'alg', 'use', 'key_ops', 'x5c', 'x5t', 'x5t#S256'];
export const JWK_MEMBERS_BY_KTY: Readonly<Record<'RSA' | 'EC', readonly string[]>> = {
  RSA: [...JWK_COMMON_MEMBERS, 'n', 'e'],
  EC: [...JWK_COMMON_MEMBERS, 'crv', 'x', 'y'],
};
/** Size limits on the key parameters themselves, so no parameter can carry arbitrary bytes. */
export const JWK_PARAM_LIMITS = { p384CoordinateBytes: 48, maxRsaExponentBytes: 4, maxRsaBits: 8192 } as const;

/** A verification key's only meaningful operation. `sign` (or anything else) means the key is not a public key's. */
export const ALLOWED_KEY_OPS: readonly string[] = ['verify'];

/**
 * Roles a backend (client_credentials) client may hold: every CP role whose `client_credentials` ceiling is
 * non-empty, with its CP display name (apps/loom-health-cp/src/auth/role-scope-map.v1.json). A role with an empty
 * system ceiling would register and then grant nothing, so it is not offered.
 */
export const BACKEND_ROLE_CHOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'fhir-data-reader', label: 'FHIR Data Reader' },
  { id: 'fhir-data-writer', label: 'FHIR Data Writer' },
  { id: 'fhir-data-contributor', label: 'FHIR Data Contributor' },
  { id: 'fhir-data-exporter', label: 'FHIR Data Exporter' },
  { id: 'fhir-data-importer', label: 'FHIR Data Importer' },
  { id: 'fhir-search-parameter-manager', label: 'FHIR Search Parameter Manager' },
];

/** System scopes a backend client may be registered for, picked from a list (no free text). */
export const SYSTEM_SCOPE_CHOICES: ReadonlyArray<{ scope: string; label: string }> = [
  { scope: 'system/*.rs', label: 'Read all data in the tenant (bulk export, analytics)' },
  { scope: 'system/*.cruds', label: 'Read and write all data in the tenant' },
];

export interface PublicJwks { keys: Array<Record<string, unknown>> }

function b64urlBytes(v: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(v)) return null;
  const pad = v.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch { return null; }
}

/** Bit length of a base64url RSA modulus, leading zero bytes ignored; 0 when unreadable (same as the CP's). */
export function rsaModulusBits(n: unknown): number {
  if (typeof n !== 'string' || n.length === 0) return 0;
  const buf = b64urlBytes(n);
  if (!buf) return 0;
  let i = 0;
  while (i < buf.length && buf[i] === 0) i++;
  if (i === buf.length) return 0;
  return (buf.length - i - 1) * 8 + (32 - Math.clz32(buf[i] as number));
}

const B64_STD = /^[A-Za-z0-9+/]+={0,2}$/;
const shown = (m: string) => JSON.stringify(m.slice(0, 40));

/**
 * Validate a JWKS that may be registered inline. Accepts the parsed object or the pasted text. On success returns a
 * NEW object rebuilt from the allowlisted members only (never the input object); otherwise an error that names the
 * key and the rule. A private member anywhere is refused outright: a private key is never accepted or forwarded.
 *
 * This is the structural check the browser can run. The BFF then NORMALIZES the result with node:crypto
 * (lib/health/x5c-verify.ts normalizePublicJwks): the key is re-derived with createPublicKey, each x5c entry must be
 * exactly a certificate's DER, and only re-derived data is forwarded to the CP.
 */
export function validatePublicJwks(input: unknown): { jwks: PublicJwks } | { error: string } {
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else {
    try { text = JSON.stringify(input) ?? ''; } catch { return { error: 'jwks: not serializable' }; }
  }
  if (new TextEncoder().encode(text).length > JWKS_LIMITS.maxBytes) return { error: `jwks: larger than ${JWKS_LIMITS.maxBytes / 1024} KB` };
  // A JSON round-trip is the working copy: plain data only, and every member (including a "__proto__" key, which
  // JSON.parse makes an OWN property) is visible to Object.keys. Membership is never tested with `in`.
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { error: 'jwks: not valid JSON' }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'jwks: must be a JSON object with a "keys" array' };
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== 'keys');
  if (extra.length) return { error: `jwks: only "keys" is allowed at the top level (found ${extra.slice(0, 3).map(shown).join(', ')})` };
  if (!Array.isArray(o.keys) || o.keys.length === 0) return { error: 'jwks: "keys" must be a non-empty array' };
  if (o.keys.length > JWKS_LIMITS.maxKeys) return { error: `jwks: at most ${JWKS_LIMITS.maxKeys} keys` };
  const kids = new Set<string>();
  const clean: Array<Record<string, unknown>> = [];
  for (let i = 0; i < o.keys.length; i++) {
    const k = o.keys[i] as Record<string, unknown>;
    const at = `jwks: key ${i + 1}`;
    if (!k || typeof k !== 'object' || Array.isArray(k)) return { error: `${at} is not an object` };
    const own = Object.keys(k);
    const priv = PRIVATE_JWK_MEMBERS.filter((m) => own.includes(m));
    if (priv.length) return { error: `${at} contains private key material (${priv.join(', ')}). Paste the PUBLIC keys only; nothing was sent.` };
    if (k.kty !== 'RSA' && k.kty !== 'EC') return { error: `${at}: kty must be RSA or EC` };
    const allowed = JWK_MEMBERS_BY_KTY[k.kty];
    const unknown = own.filter((m) => !allowed.includes(m));
    if (unknown.length) {
      return { error: `${at}: member ${unknown.slice(0, 3).map(shown).join(', ')} is not allowed on an ${k.kty} public key (allowed: ${allowed.join(', ')}); nothing was sent.` };
    }
    if (k.key_ops !== undefined) {
      // Exactly ["verify"]: one element, so a repeated or padded array is not a place to carry bytes either.
      if (!Array.isArray(k.key_ops) || k.key_ops.length !== 1 || !ALLOWED_KEY_OPS.includes(k.key_ops[0] as string)) {
        return { error: `${at}: key_ops may only be ["verify"] (a key with "sign" is a private key's)` };
      }
    }
    if (k.x5c !== undefined) {
      if (!Array.isArray(k.x5c) || k.x5c.length === 0 || k.x5c.length > JWKS_LIMITS.maxX5c || k.x5c.some((c) => typeof c !== 'string' || !B64_STD.test(c))) {
        return { error: `${at}: x5c must be 1 to ${JWKS_LIMITS.maxX5c} base64 DER certificates` };
      }
    }
    if (k.x5t !== undefined && (typeof k.x5t !== 'string' || !/^[A-Za-z0-9_-]{27}$/.test(k.x5t))) return { error: `${at}: x5t must be a base64url SHA-1 thumbprint` };
    if (k['x5t#S256'] !== undefined && (typeof k['x5t#S256'] !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(k['x5t#S256'] as string))) {
      return { error: `${at}: x5t#S256 must be a base64url SHA-256 thumbprint` };
    }
    if (typeof k.kid !== 'string' || !k.kid || k.kid.length > JWKS_LIMITS.maxKidLength) return { error: `${at}: kid is required (1 to ${JWKS_LIMITS.maxKidLength} characters)` };
    if (kids.has(k.kid)) return { error: `${at}: kid ${k.kid} is used twice` };
    kids.add(k.kid);
    if (k.alg !== undefined && !ALLOWED_JWK_ALGS.includes(k.alg as string)) return { error: `${at}: alg must be ${ALLOWED_JWK_ALGS.join(' or ')}` };
    if (k.use !== undefined && k.use !== 'sig') return { error: `${at}: use must be sig` };
    if (k.kty === 'RSA') {
      const e = typeof k.e === 'string' ? b64urlBytes(k.e) : null;
      if (!e || e.length === 0) return { error: `${at}: RSA key needs e` };
      if (e.length > JWK_PARAM_LIMITS.maxRsaExponentBytes) return { error: `${at}: RSA e is at most ${JWK_PARAM_LIMITS.maxRsaExponentBytes} bytes` };
      const bits = rsaModulusBits(k.n);
      if (bits < MIN_RSA_BITS) return { error: `${at}: RSA keys must be at least ${MIN_RSA_BITS} bits` };
      if (bits > JWK_PARAM_LIMITS.maxRsaBits) return { error: `${at}: RSA keys are at most ${JWK_PARAM_LIMITS.maxRsaBits} bits` };
      if (k.alg === 'ES384') return { error: `${at}: alg ES384 needs an EC key` };
    } else {
      if (k.crv !== 'P-384') return { error: `${at}: EC key must use crv P-384 (ES384)` };
      if (typeof k.x !== 'string' || typeof k.y !== 'string' || !b64urlBytes(k.x) || !b64urlBytes(k.y)) return { error: `${at}: EC key needs x and y` };
      // A P-384 coordinate is exactly 48 bytes (RFC 7518 6.2.1.2), so neither can carry a DER blob or anything else.
      if (b64urlBytes(k.x)?.length !== JWK_PARAM_LIMITS.p384CoordinateBytes || b64urlBytes(k.y)?.length !== JWK_PARAM_LIMITS.p384CoordinateBytes) {
        return { error: `${at}: EC P-384 x and y must each be ${JWK_PARAM_LIMITS.p384CoordinateBytes} bytes` };
      }
      if (k.alg === 'RS384') return { error: `${at}: alg RS384 needs an RSA key` };
    }
    // Rebuild from the allowlist, in a fixed order. Every value was type-checked above.
    const out: Record<string, unknown> = {};
    for (const m of allowed) {
      if (k[m] === undefined) continue;
      out[m] = Array.isArray(k[m]) ? [...(k[m] as string[])] : k[m];
    }
    clean.push(out);
  }
  return { jwks: { keys: clean } };
}

/** What the apps table may show about an inline JWKS: the count and the kids. Never a modulus or a coordinate. */
export function jwksSummary(jwks: unknown): { keyCount: number; kids: string[] } {
  const keys = (jwks as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) return { keyCount: 0, kids: [] };
  return { keyCount: keys.length, kids: keys.map((k) => (typeof k?.kid === 'string' ? k.kid.slice(0, JWKS_LIMITS.maxKidLength) : '')).filter(Boolean) };
}
