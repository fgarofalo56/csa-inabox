/**
 * Secret detection for CONNECTION-PROPERTY names (camelCase, operator-supplied).
 *
 * THE BUG THIS REPLACES: `/password|secret|key$/i` looks like "name contains
 * password, secret, or key" but JavaScript alternation binds looser than the
 * anchor, so it parses as `password` OR `secret` OR `key$`. Only the LAST
 * alternative was end-anchored — meaning `sslKeyPem`, `privateKeyPem` and
 * `keyData` all failed the test and their values were persisted to item state /
 * Cosmos in PLAINTEXT instead of being written to Key Vault.
 *
 * NOTE this is a different domain from `isSecretKey` in lib/admin/env-config.ts,
 * whose `_KEY$` anchor IS correct: that one matches SCREAMING_SNAKE env-var names
 * (LOOM_FOO_KEY), where the suffix is a real convention. Connection properties
 * are camelCase and put "key" in the middle, so the same rule does not transfer.
 * Two rules, two domains — deliberately not merged.
 */

/**
 * Names that contain "key" but denote STRUCTURE, not key material. Redacting
 * these would swap a real value for a secretRef and break the connection, so
 * they are excluded explicitly. Reviewable list — add with a reason.
 */
const STRUCTURAL_KEY_NAMES = [
  'keyspace',            // Cassandra/Scylla namespace
  'keycolumn', 'keyfield', 'keyname', 'keypath', 'keyprefix',
  'partitionkey', 'primarykey', 'sortkey', 'rowkey',
  'keyvault',            // a Key Vault URI/name is a locator, not the secret
  'keystorelocation',    // a path
  'keyformat', 'keyserializer', 'keydeserializer',
];

/**
 * True when a connection-property NAME denotes secret material that must go to
 * Key Vault rather than into persisted item state.
 *
 * FAILS SAFE on "key": an unrecognised key-ish name is treated as SECRET. A
 * false positive fails LOUD (the operator sees the connection reject a value it
 * expected verbatim and can rename the property); a false negative fails SILENT
 * (a private key sitting in Cosmos in plaintext, indefinitely).
 */
export function isSecretPropName(name: string): boolean {
  const n = (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  // Unambiguous secret words — anywhere in the name.
  if (/password|passwd|pwd|passphrase|secret|token|credential/.test(n)) return true;
  if (!n.includes('key')) return false;
  return !STRUCTURAL_KEY_NAMES.some((s) => n.includes(s));
}
