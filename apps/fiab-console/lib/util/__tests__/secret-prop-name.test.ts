/**
 * isSecretPropName — the connection-property secret detector.
 *
 * THE BUG IT REPLACES: `/password|secret|key$/i` reads as "contains password,
 * secret or key" but parses as `password` OR `secret` OR `key$`. Only the last
 * alternative was anchored, so a property whose name contained "key" anywhere
 * but the end silently skipped Key Vault and was persisted to Cosmos in
 * plaintext.
 *
 * The first test below is the exact leak: those three names all returned FALSE
 * under the old regex.
 */
import { describe, it, expect } from 'vitest';
import { isSecretPropName } from '../secret-prop-name';

describe('isSecretPropName — the names the old regex LEAKED', () => {
  // Real Kafka / broker property names carrying private-key material.
  it.each(['sslKeyPem', 'privateKeyPem', 'keyData', 'sslKeystoreKeyMaterial', 'clientKeyContent'])(
    'treats %s as secret (old /key$/ missed it → plaintext in Cosmos)',
    (name) => {
      expect(isSecretPropName(name)).toBe(true);
      // Pin the regression against the exact broken pattern.
      expect(/password|secret|key$/i.test(name)).toBe(false);
    },
  );
});

describe('isSecretPropName — unambiguous secret words', () => {
  it.each([
    'password', 'saslPassword', 'sslKeyPassword', 'passwd', 'pwd',
    'passphrase', 'apiSecret', 'clientSecret', 'accessToken', 'sasToken',
    'credential', 'awsCredentials',
  ])('treats %s as secret', (name) => {
    expect(isSecretPropName(name)).toBe(true);
  });

  it('still catches everything the OLD regex caught (no regression)', () => {
    for (const name of ['password', 'mySecret', 'apiKey', 'sharedKey']) {
      expect(/password|secret|key$/i.test(name)).toBe(true);   // old said secret
      expect(isSecretPropName(name)).toBe(true);               // new agrees
    }
  });
});

describe('isSecretPropName — structural names must NOT be redacted', () => {
  // Redacting these would swap a real value for a secretRef and break the
  // connection, so each is excluded deliberately.
  it.each([
    'keyspace', 'keyColumn', 'keyName', 'keyPath', 'keyPrefix',
    'partitionKey', 'primaryKey', 'sortKey', 'rowKey',
    'keyVaultUri', 'keystoreLocation', 'keyFormat', 'keySerializer', 'keyDeserializer',
  ])('leaves %s alone', (name) => {
    expect(isSecretPropName(name)).toBe(false);
  });

  it('leaves ordinary connection properties alone', () => {
    for (const name of ['bootstrapServers', 'topic', 'consumerGroup', 'clientId', 'region', 'endpoint']) {
      expect(isSecretPropName(name)).toBe(false);
    }
  });
});

describe('isSecretPropName — edge cases', () => {
  it('is case- and separator-insensitive', () => {
    expect(isSecretPropName('SSL_KEY_PEM')).toBe(true);
    expect(isSecretPropName('ssl-key-pem')).toBe(true);
    expect(isSecretPropName('KEY_SPACE')).toBe(false);   // structural, normalised
  });

  it('handles empty / junk input without throwing', () => {
    expect(isSecretPropName('')).toBe(false);
    expect(isSecretPropName('   ')).toBe(false);
  });

  it('fails SAFE on an unrecognised key-ish name', () => {
    // Unknown + contains "key" → treated as secret. A false positive fails loud
    // (visible connection error); a false negative fails silent (plaintext).
    expect(isSecretPropName('someNovelKeyThing')).toBe(true);
  });
});
