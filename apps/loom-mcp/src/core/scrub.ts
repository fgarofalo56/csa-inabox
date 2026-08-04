/**
 * Secret-scrubbing — PRP §5.2 "What must never be exposed by any MCP tool".
 *
 * Every value a tool is about to return passes through {@link scrub} first. The
 * policy is **fail-closed**: it over-redacts rather than risk leaking. It strips
 *
 *   - values under secret-ish keys (password/secret/connectionString/accountKey/
 *     sasToken/apiKey/token/cookie/authorization/subscriptionId/…);
 *   - embedded secrets in string values regardless of key: `loom_pat_<id>_<secret>`
 *     PATs, `loom_session=` cookies, `Bearer …` headers, storage/SQL connection
 *     strings (`AccountKey=`/`SharedAccessKey=`/`Password=`), SAS `sig=` signatures,
 *     full ARM resource ids (`/subscriptions/<guid>/resourceGroups/…`), and Key
 *     Vault references.
 *
 * Legitimate catalog output — workspace ids, item ids (GUIDs), display names,
 * item types, descriptions — is preserved: bare GUIDs are NOT redacted (only
 * GUIDs inside an ARM path or under a `subscriptionId` key are), so a workspace
 * id survives while a subscription id does not.
 *
 * Reverting this module to a passthrough is caught by `test/scrub.test.ts`
 * (the mutation-proof): the test then sees the token and goes RED.
 */

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 40;

/**
 * Property names whose value is redacted wholesale. Compared against the key
 * lower-cased with non-alphanumerics stripped, so `connection-string`,
 * `connectionString`, and `connection_string` all match `connectionstring`.
 */
const SECRET_KEY_SUBSTRINGS = [
  'secret',
  'password',
  'passwd',
  'connectionstring',
  'sastoken',
  'accountkey',
  'accesskey',
  'primarykey',
  'secondarykey',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
  'privatekey',
  'sharedaccesskey',
  'credential',
  'authorization',
  'bearer',
  'cookie',
  'subscriptionid',
];

/** Short, ambiguous key names redacted only on an exact (normalized) match. */
const SECRET_KEY_EXACT = new Set(['key', 'token', 'sig', 'signature', 'sas', 'pat', 'auth', 'pwd', 'password']);

function normalizeKey(key: string): string {
  let out = '';
  for (const ch of key.toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) out += ch;
  }
  return out;
}

/** Is this property name secret-bearing? */
export function isSecretKey(key: string): boolean {
  const n = normalizeKey(key);
  if (!n) return false;
  if (SECRET_KEY_EXACT.has(n)) return true;
  return SECRET_KEY_SUBSTRINGS.some((s) => n.includes(s));
}

/**
 * Value-level scrubbers. Order matters: the most specific (ARM ids, connection
 * strings) run before the broadest (bearer, PAT).
 */
const VALUE_PATTERNS: Array<{ re: RegExp; replace: string }> = [
  // Full ARM resource id (subscription + resource group, optional trailing path).
  { re: /\/subscriptions\/[0-9a-fA-F-]{36}\/resourceGroups\/[^\s"'`]*/g, replace: '[REDACTED_ARM_ID]' },
  // Bare `/subscriptions/<guid>` even without a resource group.
  { re: /\/subscriptions\/[0-9a-fA-F-]{36}/g, replace: '[REDACTED_SUBSCRIPTION]' },
  // Loom PAT: loom_pat_<id>_<secret>.
  { re: /loom_pat_[A-Za-z0-9]+_[A-Za-z0-9._~+/=-]+/g, replace: '[REDACTED_PAT]' },
  // Loom session cookie value.
  { re: /loom_session=[^;\s"'`]+/g, replace: 'loom_session=[REDACTED_COOKIE]' },
  // Authorization: Bearer <token>.
  { re: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: 'Bearer [REDACTED]' },
  // Storage / SQL connection-string secret segments.
  { re: /(AccountKey|SharedAccessKey|Password|Pwd|AccessKey)=([^;"'`\s]+)/gi, replace: '$1=[REDACTED]' },
  // SAS signature.
  { re: /([?&]sig)=([^&"'`\s]+)/gi, replace: '$1=[REDACTED]' },
  // Key Vault reference / URL.
  { re: /@Microsoft\.KeyVault\([^)]*\)/gi, replace: '[REDACTED_KEYVAULT]' },
  { re: /https?:\/\/[^\s"'`]*\.vault\.azure\.net[^\s"'`]*/gi, replace: '[REDACTED_KEYVAULT]' },
];

/** Scrub embedded secrets from a single string value. Safe on any input. */
export function scrubString(s: string): string {
  let out = s;
  for (const { re, replace } of VALUE_PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

/**
 * Deep-clone `value`, redacting secrets. Never mutates the input. Cycles are
 * broken (`[Circular]`) and depth is capped so a hostile/looping payload cannot
 * hang the process.
 */
export function scrub<T>(value: T): T {
  return walk(value, 0, new WeakSet<object>()) as T;
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return '[MaxDepth]';

  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);

  try {
    if (Array.isArray(value)) {
      return value.map((v) => walk(v, depth + 1, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = walk(v, depth + 1, seen);
      }
    }
    return out;
  } finally {
    seen.delete(value as object);
  }
}
