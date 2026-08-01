/**
 * Secret detection for CONNECTION-PROPERTY names (camelCase, operator-supplied).
 *
 * TWO BUGS SHAPED THIS FILE. Both were "the rule reads correctly and does the
 * wrong thing", in opposite directions.
 *
 * 1. THE ORIGINAL LEAK (#2772). `/password|secret|key$/i` reads as "contains
 *    password, secret, or key", but alternation binds looser than the anchor, so
 *    it parses as `password` OR `secret` OR `key$`. Only the LAST alternative was
 *    end-anchored, so `sslKeyPem`, `privateKeyPem` and `keyData` failed the test
 *    and their values were persisted to Cosmos in PLAINTEXT.
 *
 * 2. THE OVER-CORRECTION (this change). The replacement matched those words as
 *    SUBSTRINGS of the whole flattened name. That vaults things that are not
 *    secrets at all:
 *
 *      tokenEndpoint   -> a URL saying WHERE to get a token
 *      tokenUrl        -> same
 *      keyboardLayout  -> contains "key"
 *      turkeyMode      -> contains "key"
 *
 *    A false match is not harmless: the route deletes the value and substitutes
 *    `<name>SecretRef`, so a connector configured with a real `tokenEndpoint`
 *    silently loses its URL. The repo already KNEW this — a test asserted
 *    "tokenEndpoint: a URL — vaulting it would break the connector" — but that
 *    test pinned a private copy of the old regex instead of importing this
 *    module, so it stayed green while the shipped behaviour inverted.
 *
 * THE RULE NOW: match WORDS, not substrings.
 *
 * Property names are camelCase / snake_case, so they carry real word boundaries.
 * Splitting on them turns a fuzzy substring question into an exact one:
 *
 *      sslKeyPem      -> ssl, key, pem          -> key      -> SECRET
 *      turkeyMode     -> turkey, mode           -> no match -> plain
 *      keyboardLayout -> keyboard, layout       -> no match -> plain
 *      tokenEndpoint  -> token, endpoint        -> token, but "endpoint" says
 *                                                  this NAMES a location
 *                                                  rather than holding material
 *
 * A LOCATOR word demotes an otherwise-secret name. `keyVaultUri`, `partitionKey`
 * and `tokenEndpoint` all describe where something lives or how it is addressed;
 * `apiKey`, `clientSecret` and `privateKeyPem` are the material itself.
 *
 * NOTE this is a different domain from `isSecretKey` in lib/admin/env-config.ts,
 * whose `_KEY$` anchor IS correct: that matches SCREAMING_SNAKE env-var names
 * (LOOM_FOO_KEY) where the suffix is a real convention. Two rules, two domains —
 * deliberately not merged.
 */

/**
 * Split a property name into lowercase words on camelCase humps, digits, and any
 * non-alphanumeric separator.
 *
 * `ABCKey` -> ['abc','key'] (an acronym run followed by a capitalised word splits
 * before the last capital, which is the conventional reading).
 */
export function propNameWords(name: string): string[] {
  return (name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')      // fooBar   -> foo Bar
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')   // ABCKey   -> ABC Key
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2')      // key2     -> key 2
    .split(/[^a-zA-Z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

/**
 * Words that denote secret MATERIAL. Matched as whole words only.
 *
 * `key` is here despite being the noisiest: a bare `key` word in a connection
 * property overwhelmingly means key material (`apiKey`, `sslKey`, `keyPem`), and
 * the locator list below carries the exceptions.
 */
const SECRET_WORDS = new Set([
  'password', 'passwd', 'pwd', 'passphrase',
  'secret', 'token', 'credential', 'credentials',
  'key', 'keys', 'keydata', 'keymaterial',
  'sas', 'apikey', 'accesskey', 'privatekey',
]);

/**
 * Words that make a name a LOCATOR or a piece of STRUCTURE rather than the
 * material — a name, an address, a shape, a policy. Reviewable list; add with a
 * reason.
 *
 * Presence of any of these demotes an otherwise-secret name, which is what keeps
 * `tokenEndpoint` (a URL) and `partitionKey` (a shape) out of Key Vault.
 */
const LOCATOR_WORDS = new Set([
  // addresses / locations
  'endpoint', 'url', 'uri', 'host', 'hostname', 'port', 'path', 'location', 'vault', 'server',
  // identity / naming
  'name', 'id', 'identifier', 'prefix', 'suffix', 'label', 'alias',
  // shape / structure
  'column', 'field', 'space', 'partition', 'primary', 'sort', 'row', 'index', 'table', 'schema',
  'format', 'serializer', 'deserializer', 'store', 'storelocation', 'type', 'kind', 'version',
  // lifecycle / policy — describe a token, do not contain one
  'audience', 'scope', 'issuer', 'expiry', 'expires', 'ttl', 'lifetime', 'refreshinterval',
  'enabled', 'mode', 'strategy', 'policy',
]);

/**
 * True when a connection-property NAME denotes secret material that must go to
 * Key Vault rather than into persisted item state.
 *
 * Direction of failure, stated because both directions have bitten:
 *   MISS        -> a credential is persisted to Cosmos in plaintext (silent)
 *   FALSE MATCH -> the value is replaced by `<name>SecretRef` and the connector
 *                  breaks (loud, but still a real outage)
 * The word-boundary rule exists to shrink BOTH, rather than trading one for the
 * other as the previous two versions did.
 */
export function isSecretPropName(name: string): boolean {
  const words = propNameWords(name);
  if (!words.length) return false;
  const joined = words.join('');

  // A compound secret word written as one token, e.g. "apikey" / "privatekey".
  const hasSecretWord = words.some((w) => SECRET_WORDS.has(w))
    || SECRET_WORDS.has(joined);
  if (!hasSecretWord) return false;

  // An unambiguous material word is never demoted: `clientSecretUrl` would be a
  // bizarre name, but if it appears we still protect it.
  const HARD = ['password', 'passwd', 'pwd', 'passphrase', 'secret', 'credential', 'credentials'];
  if (words.some((w) => HARD.includes(w))) return true;

  return !words.some((w) => LOCATOR_WORDS.has(w));
}
