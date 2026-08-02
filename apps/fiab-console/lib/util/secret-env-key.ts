/**
 * Secret detection for ENVIRONMENT-VARIABLE names (SCREAMING_SNAKE, repo-defined).
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * The same question — "does this env var hold secret material?" — was answered
 * by TWO hand-rolled regexes that DISAGREED:
 *
 *   lib/admin/env-config.ts      …|_KEY$|_KEYS$|_PWD$|_WEBHOOK_URL$/i
 *   lib/components/shared/honest-gate.tsx
 *                                …|_KEY$|_KEYS$|_PWD$|TOKEN$/i
 *
 * So `LOOM_TEAMS_WEBHOOK_URL` was masked in the support bundle but typed into a
 * PLAINTEXT input in the Fix-it wizard, and anything ending `TOKEN` was the
 * exact reverse — rendered as a password field, then written verbatim into the
 * support bundle. Two copies of a security predicate always drift; the only
 * question is which direction each one leaks.
 *
 * ── AND BOTH CARRIED THE #2772 PARSE TRAP ──────────────────────────────────
 *
 * `/SECRET|PASSWORD|_KEY$/i` reads as "contains SECRET, PASSWORD or _KEY". It
 * does not. Alternation binds looser than the anchor, so it parses as `SECRET`
 * OR `PASSWORD` OR `_KEY$` — only the LAST alternative is end-anchored. That is
 * the identical shape that put connection-property secrets into Cosmos in
 * plaintext (#2772), and it reads correctly to every reviewer, which is why
 * `scripts/ci/check-regex-anchor.mjs` now enforces this module instead.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 * SCREAMING_SNAKE names have explicit word boundaries, so ask an exact question
 * rather than a fuzzy one:
 *
 *   MATERIAL ANYWHERE   SECRET / PASSWORD / CONNECTION_STRING / CREDENTIAL
 *                       are never part of a locator name; if the word appears,
 *                       the value is the material.
 *   MATERIAL BY SUFFIX  the LAST word says what the value IS.
 *                       LOOM_ADX_API_KEY -> KEY -> secret
 *                       LOOM_KEY_VAULT_NAME -> NAME -> a locator, not secret
 *
 * The suffix rule is why `_KEY$` was anchored in the first place; this keeps
 * that intent and applies it to EVERY alternative rather than to whichever one
 * happened to be written last.
 *
 * NOTE this is a different domain from `isSecretPropName` in
 * lib/util/secret-prop-name.ts, which matches camelCase, OPERATOR-supplied
 * connection-property names. Two conventions, two rules — deliberately not
 * merged, because the word lists and the failure directions differ.
 */

/** Words that mean "this IS credential material" wherever they appear. */
const MATERIAL_ANYWHERE = /(SECRET|PASSWORD|PASSPHRASE|CONNECTION_?STRING|CREDENTIALS?)/;

/**
 * Trailing words that make the value itself secret. Matched against the LAST
 * word, and against the last TWO words joined, so `_WEBHOOK_URL` is caught
 * without treating a bare `URL` suffix as secret.
 *
 * `WEBHOOK_URL`: incoming-webhook URLs (Teams workflow / PagerDuty / on-call
 * bridge) embed a bearer token in the path, so the URL *is* the credential.
 */
const MATERIAL_SUFFIX = new Set([
  'KEY', 'KEYS', 'APIKEY', 'ACCESSKEY',
  'PWD', 'PASS',
  'TOKEN',
  'SAS', 'SASTOKEN',
  'WEBHOOK_URL',
]);

/**
 * Trailing words that make the name describe a QUANTITY or POLICY ABOUT the
 * credential rather than the credential itself. Any of these demotes.
 *
 * This is the lesson of the over-correction documented in secret-prop-name.ts
 * (`tokenEndpoint` is a URL, not a token), measured rather than guessed: a
 * suffix rule without it masks `LOOM_COPILOT_MEMORY_RECALL_MAX_TOKENS` and
 * `LOOM_SHARING_CREDENTIAL_VALIDITY_SECONDS`, which are an integer and a
 * duration. Rendering '***' for those hides real diagnostics from a support
 * bundle and puts a number behind a password field.
 *
 * Note `TOKENS` (plural) is absent from MATERIAL_SUFFIX for the same reason:
 * in SCREAMING_SNAKE it means a COUNT (`MAX_TOKENS`), never key material.
 */
const QUANTITY_SUFFIX = new Set([
  'SECONDS', 'MINUTES', 'HOURS', 'DAYS', 'MS', 'TTL', 'TIMEOUT', 'VALIDITY',
  'COUNT', 'LIMIT', 'MAX', 'MIN', 'SIZE', 'BYTES', 'LENGTH', 'INTERVAL',
  'ENABLED', 'DISABLED', 'MODE', 'STRATEGY', 'VERSION',
]);

/**
 * True when an env-var NAME denotes secret material — it must be masked in any
 * echo (support bundle, audit line) and typed into a password field, never a
 * plain input.
 *
 * Direction of failure, stated because it decides the word lists above:
 *   MISS        -> a credential is echoed into a support bundle or rendered in
 *                  cleartext on screen (silent).
 *   FALSE MATCH -> an operator sees '***' instead of a harmless value (loud,
 *                  recoverable, and never a disclosure).
 * So an ambiguous name is treated as secret.
 */
export function isSecretEnvKey(key: string): boolean {
  const k = (key || '').trim().toUpperCase();
  if (!k) return false;

  const words = k.split(/[^A-Z0-9]+/).filter(Boolean);
  if (!words.length) return false;
  const last = words[words.length - 1];
  // A quantity/policy suffix demotes even an unambiguous material word: the
  // name is ABOUT the credential, it does not hold one.
  if (QUANTITY_SUFFIX.has(last)) return false;

  if (MATERIAL_ANYWHERE.test(k)) return true;

  const lastTwo = words.slice(-2).join('_');
  return MATERIAL_SUFFIX.has(last) || MATERIAL_SUFFIX.has(lastTwo);
}
