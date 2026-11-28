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
export const JWKS_LIMITS = { maxBytes: 16 * 1024, maxKeys: 10, maxKidLength: 200 } as const;

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

/**
 * Validate a JWKS that may be registered inline. Accepts the parsed object or the pasted text. Returns the parsed
 * object UNCHANGED on success (it is forwarded exactly as given), or an error that names the key and the rule.
 * A private member anywhere is refused outright: a private key is never accepted or forwarded.
 */
export function validatePublicJwks(input: unknown): { jwks: PublicJwks } | { error: string } {
  let v: unknown = input;
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).length > JWKS_LIMITS.maxBytes) return { error: `jwks: larger than ${JWKS_LIMITS.maxBytes / 1024} KB` };
    try { v = JSON.parse(input); } catch { return { error: 'jwks: not valid JSON' }; }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'jwks: must be a JSON object with a "keys" array' };
  let size: number;
  try { size = new TextEncoder().encode(JSON.stringify(v)).length; } catch { return { error: 'jwks: not serializable' }; }
  if (size > JWKS_LIMITS.maxBytes) return { error: `jwks: larger than ${JWKS_LIMITS.maxBytes / 1024} KB` };
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== 'keys');
  if (extra.length) return { error: `jwks: only "keys" is allowed at the top level (found ${extra.slice(0, 3).join(', ')})` };
  if (!Array.isArray(o.keys) || o.keys.length === 0) return { error: 'jwks: "keys" must be a non-empty array' };
  if (o.keys.length > JWKS_LIMITS.maxKeys) return { error: `jwks: at most ${JWKS_LIMITS.maxKeys} keys` };
  const kids = new Set<string>();
  for (let i = 0; i < o.keys.length; i++) {
    const k = o.keys[i] as Record<string, unknown>;
    const at = `jwks: key ${i + 1}`;
    if (!k || typeof k !== 'object' || Array.isArray(k)) return { error: `${at} is not an object` };
    const priv = PRIVATE_JWK_MEMBERS.filter((m) => m in k);
    if (priv.length) return { error: `${at} contains private key material (${priv.join(', ')}). Paste the PUBLIC keys only; nothing was sent.` };
    if (k.kty !== 'RSA' && k.kty !== 'EC') return { error: `${at}: kty must be RSA or EC` };
    if (typeof k.kid !== 'string' || !k.kid || k.kid.length > JWKS_LIMITS.maxKidLength) return { error: `${at}: kid is required (1 to ${JWKS_LIMITS.maxKidLength} characters)` };
    if (kids.has(k.kid)) return { error: `${at}: kid ${k.kid} is used twice` };
    kids.add(k.kid);
    if (k.alg !== undefined && !ALLOWED_JWK_ALGS.includes(k.alg as string)) return { error: `${at}: alg must be ${ALLOWED_JWK_ALGS.join(' or ')}` };
    if (k.use !== undefined && k.use !== 'sig') return { error: `${at}: use must be sig` };
    if (k.kty === 'RSA') {
      if (typeof k.e !== 'string' || !b64urlBytes(k.e)) return { error: `${at}: RSA key needs e` };
      if (rsaModulusBits(k.n) < MIN_RSA_BITS) return { error: `${at}: RSA keys must be at least ${MIN_RSA_BITS} bits` };
      if (k.alg === 'ES384') return { error: `${at}: alg ES384 needs an EC key` };
    } else {
      if (k.crv !== 'P-384') return { error: `${at}: EC key must use crv P-384 (ES384)` };
      if (typeof k.x !== 'string' || typeof k.y !== 'string' || !b64urlBytes(k.x) || !b64urlBytes(k.y)) return { error: `${at}: EC key needs x and y` };
      if (k.alg === 'RS384') return { error: `${at}: alg RS384 needs an RSA key` };
    }
  }
  return { jwks: o as unknown as PublicJwks };
}

/** What the apps table may show about an inline JWKS: the count and the kids. Never a modulus or a coordinate. */
export function jwksSummary(jwks: unknown): { keyCount: number; kids: string[] } {
  const keys = (jwks as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) return { keyCount: 0, kids: [] };
  return { keyCount: keys.length, kids: keys.map((k) => (typeof k?.kid === 'string' ? k.kid.slice(0, JWKS_LIMITS.maxKidLength) : '')).filter(Boolean) };
}
