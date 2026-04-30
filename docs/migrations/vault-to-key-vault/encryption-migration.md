# Encryption Migration: Vault Transit Engine to Azure Key Vault Keys

**Status:** Authored 2026-04-30
**Audience:** Security Engineers, Application Developers, Platform Engineers
**Purpose:** Guide for migrating encryption, decryption, signing, and key management operations from Vault Transit engine to Azure Key Vault keys

---

## Overview

The HashiCorp Vault Transit engine provides encryption-as-a-service: applications send plaintext to Vault, Vault encrypts it with a managed key, and returns ciphertext. The application never handles raw key material. The Transit engine supports encryption, decryption, signing, verification, key rotation, and rewrapping.

Azure Key Vault keys provide equivalent encryption-as-a-service capabilities. Applications use the Key Vault REST API or Azure SDK to perform encrypt, decrypt, sign, verify, wrap, and unwrap operations. HSM-backed keys (Premium/Managed HSM) provide FIPS 140-3 Level 3 protection. Key rotation policies automate key versioning.

This guide covers the migration of encryption keys, API call patterns, key rotation strategies, envelope encryption workflows, and BYOK import.

---

## 1. Key type mapping

### Vault Transit to Key Vault key types

| Vault key type               | Key Vault equivalent        | Notes                                                          |
| ---------------------------- | --------------------------- | -------------------------------------------------------------- |
| `aes128-gcm96`               | Managed HSM AES-128         | Standard/Premium Key Vault does not support symmetric AES keys |
| `aes256-gcm96`               | Managed HSM AES-256         | Standard/Premium Key Vault does not support symmetric AES keys |
| `chacha20-poly1305`          | No equivalent               | Use AES-256-GCM via Managed HSM or client-side                 |
| `rsa-2048`                   | Key Vault RSA-2048          | Software-backed (Standard) or HSM-backed (Premium/Managed HSM) |
| `rsa-3072`                   | Key Vault RSA-3072          | Software-backed or HSM-backed                                  |
| `rsa-4096`                   | Key Vault RSA-4096          | Software-backed or HSM-backed                                  |
| `ecdsa-p256`                 | Key Vault EC P-256          | For signing operations                                         |
| `ecdsa-p384`                 | Key Vault EC P-384          | For signing operations                                         |
| `ecdsa-p521`                 | Key Vault EC P-521          | For signing operations                                         |
| `ed25519`                    | No equivalent               | Use EC P-256 as alternative for signing                        |
| `managed_key` (external HSM) | Managed HSM (dedicated HSM) | Full HSM sovereignty                                           |

### Important: symmetric key considerations

Vault Transit primarily uses **symmetric keys** (AES-256-GCM) for encryption because symmetric encryption is faster and more efficient for data encryption workloads.

Key Vault Standard and Premium **do not support symmetric key operations**. Symmetric AES keys are only available in **Managed HSM**.

For organizations that cannot use Managed HSM, the migration path uses **envelope encryption**:

1. Store a **RSA key** in Key Vault (Standard/Premium)
2. Generate a **data encryption key (DEK)** locally (AES-256)
3. Encrypt data with the DEK (client-side)
4. Wrap (encrypt) the DEK with the RSA key in Key Vault
5. Store the wrapped DEK alongside the ciphertext
6. To decrypt: unwrap the DEK with Key Vault, then decrypt data locally

This pattern is used by Azure Storage, Azure SQL TDE, and Azure Disk Encryption.

---

## 2. API migration patterns

### Encrypt operation

**Vault Transit:**

```bash
vault write transit/encrypt/my-key plaintext=$(echo -n "sensitive data" | base64)
# Response: ciphertext = "vault:v1:abcdef..."
```

```python
# Python with hvac
import hvac, base64

client = hvac.Client(url='https://vault:8200', token='s.xxxx')
response = client.secrets.transit.encrypt_data(
    name='my-key',
    plaintext=base64.b64encode(b'sensitive data').decode()
)
ciphertext = response['data']['ciphertext']  # "vault:v1:abcdef..."
```

**Key Vault:**

```python
from azure.identity import DefaultAzureCredential
from azure.keyvault.keys.crypto import CryptographyClient, EncryptionAlgorithm

credential = DefaultAzureCredential()
crypto_client = CryptographyClient(
    key_id="https://kv-keys-prod.vault.azure.net/keys/my-key",
    credential=credential
)

result = crypto_client.encrypt(
    algorithm=EncryptionAlgorithm.rsa_oaep_256,
    plaintext=b'sensitive data'
)
ciphertext = result.ciphertext  # bytes
```

### Decrypt operation

**Vault Transit:**

```python
response = client.secrets.transit.decrypt_data(
    name='my-key',
    ciphertext='vault:v1:abcdef...'
)
plaintext = base64.b64decode(response['data']['plaintext'])
```

**Key Vault:**

```python
result = crypto_client.decrypt(
    algorithm=EncryptionAlgorithm.rsa_oaep_256,
    ciphertext=ciphertext
)
plaintext = result.plaintext  # bytes
```

### Sign operation

**Vault Transit:**

```python
import hashlib, base64

digest = hashlib.sha256(b'data to sign').digest()
response = client.secrets.transit.sign_data(
    name='my-signing-key',
    hash_input=base64.b64encode(digest).decode(),
    hash_algorithm='sha2-256',
    prehashed=True
)
signature = response['data']['signature']  # "vault:v1:..."
```

**Key Vault:**

```python
from azure.keyvault.keys.crypto import SignatureAlgorithm

result = crypto_client.sign(
    algorithm=SignatureAlgorithm.rs256,
    digest=hashlib.sha256(b'data to sign').digest()
)
signature = result.signature  # bytes
```

### Verify operation

**Vault Transit:**

```python
response = client.secrets.transit.verify_signed_data(
    name='my-signing-key',
    hash_input=base64.b64encode(digest).decode(),
    signature='vault:v1:...',
    hash_algorithm='sha2-256',
    prehashed=True
)
is_valid = response['data']['valid']
```

**Key Vault:**

```python
result = crypto_client.verify(
    algorithm=SignatureAlgorithm.rs256,
    digest=hashlib.sha256(b'data to sign').digest(),
    signature=signature
)
is_valid = result.is_valid
```

---

## 3. Key rotation migration

### Vault Transit key rotation

Vault Transit supports automatic key rotation on a schedule. When a key is rotated, the new version is used for encryption but all previous versions remain available for decryption. The `min_decryption_version` setting controls which versions can decrypt.

### Key Vault key rotation policy

```bash
# Configure automatic key rotation (every 90 days)
az keyvault key rotation-policy update \
  --vault-name kv-keys-prod \
  --name my-key \
  --value @rotation-policy.json
```

Rotation policy (`rotation-policy.json`):

```json
{
    "lifetimeActions": [
        {
            "trigger": {
                "timeAfterCreate": "P90D"
            },
            "action": {
                "type": "Rotate"
            }
        },
        {
            "trigger": {
                "timeBeforeExpiry": "P30D"
            },
            "action": {
                "type": "Notify"
            }
        }
    ],
    "attributes": {
        "expiryTime": "P1Y"
    }
}
```

### Handling multiple key versions

Key Vault retains all key versions. When using a specific key version for decryption, reference the version ID:

```python
# Encrypt with latest version (no version specified)
crypto_client = CryptographyClient(
    key_id="https://kv-keys-prod.vault.azure.net/keys/my-key",
    credential=credential
)
result = crypto_client.encrypt(EncryptionAlgorithm.rsa_oaep_256, plaintext)

# Decrypt with specific version
crypto_client_v1 = CryptographyClient(
    key_id="https://kv-keys-prod.vault.azure.net/keys/my-key/abc123version",
    credential=credential
)
result = crypto_client_v1.decrypt(EncryptionAlgorithm.rsa_oaep_256, ciphertext)
```

### Rewrap equivalent

Vault Transit supports `rewrap` to re-encrypt ciphertext with the latest key version without exposing plaintext. Key Vault does not have a native rewrap operation. Implement as decrypt-then-encrypt:

```python
def rewrap_ciphertext(old_key_version, new_key_id, ciphertext):
    """Re-encrypt data with the latest key version."""
    # Decrypt with old key version
    old_client = CryptographyClient(key_id=old_key_version, credential=credential)
    plaintext = old_client.decrypt(EncryptionAlgorithm.rsa_oaep_256, ciphertext).plaintext

    # Encrypt with latest key version
    new_client = CryptographyClient(key_id=new_key_id, credential=credential)
    new_ciphertext = new_client.encrypt(EncryptionAlgorithm.rsa_oaep_256, plaintext).ciphertext

    return new_ciphertext
```

---

## 4. Envelope encryption pattern

For symmetric encryption workloads (the most common Transit engine use case), implement envelope encryption with Key Vault:

```python
from azure.identity import DefaultAzureCredential
from azure.keyvault.keys.crypto import CryptographyClient, KeyWrapAlgorithm
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import os

credential = DefaultAzureCredential()
kek_client = CryptographyClient(
    key_id="https://kv-keys-prod.vault.azure.net/keys/my-kek",
    credential=credential
)

def encrypt_data(plaintext: bytes) -> dict:
    """Encrypt data using envelope encryption."""
    # 1. Generate a random data encryption key (DEK)
    dek = AESGCM.generate_key(bit_length=256)
    nonce = os.urandom(12)

    # 2. Encrypt the data with the DEK (client-side, fast)
    aesgcm = AESGCM(dek)
    ciphertext = aesgcm.encrypt(nonce, plaintext, None)

    # 3. Wrap (encrypt) the DEK with Key Vault KEK (server-side, secure)
    wrapped = kek_client.wrap_key(KeyWrapAlgorithm.rsa_oaep_256, dek)

    return {
        'ciphertext': ciphertext,
        'nonce': nonce,
        'wrapped_dek': wrapped.encrypted_key,
        'kek_version': wrapped.key_id
    }

def decrypt_data(envelope: dict) -> bytes:
    """Decrypt data using envelope encryption."""
    # 1. Unwrap the DEK using Key Vault
    unwrapped = kek_client.unwrap_key(
        KeyWrapAlgorithm.rsa_oaep_256,
        envelope['wrapped_dek']
    )

    # 2. Decrypt the data with the DEK (client-side, fast)
    aesgcm = AESGCM(unwrapped.key)
    plaintext = aesgcm.decrypt(envelope['nonce'], envelope['ciphertext'], None)

    return plaintext
```

This pattern provides:

- **AES-256-GCM encryption** performance (client-side symmetric encryption)
- **RSA key protection** for the DEK (Key Vault HSM-backed)
- **Separation of concerns** -- Key Vault never sees the data, only the DEK
- **Unlimited data size** (not constrained by RSA block size)

---

## 5. BYOK (Bring Your Own Key) import

If you need to import existing Vault Transit keys to Key Vault (rather than generating new keys):

### Export from Vault (if allowed by policy)

```bash
# Vault Transit supports key export if the key was created with allow_plaintext_backup=true
vault read transit/export/encryption-key/my-key
```

### Import to Key Vault

```python
from azure.keyvault.keys import KeyClient
from azure.identity import DefaultAzureCredential

credential = DefaultAzureCredential()
key_client = KeyClient(
    vault_url="https://kv-keys-prod.vault.azure.net",
    credential=credential
)

# Import RSA key (PEM format)
with open('exported-key.pem', 'rb') as f:
    key_data = f.read()

imported_key = key_client.import_key(
    name='my-imported-key',
    key=JsonWebKey(
        kty='RSA',
        # ... key material
    ),
    hsm=True  # Import as HSM-backed (Premium/Managed HSM)
)
```

### BYOK for Managed HSM

For Managed HSM, use the secure key transfer protocol:

```bash
# 1. Download the security domain exchange key
az keyvault key download \
  --hsm-name mhsm-prod \
  --name transferkey \
  --file transfer-key.pem

# 2. Wrap your key material with the transfer key (using provided tooling)
# 3. Upload the wrapped key
az keyvault key import \
  --hsm-name mhsm-prod \
  --name my-imported-key \
  --byok-file wrapped-key.byok
```

---

## 6. Azure service integration for encryption

Key Vault keys integrate natively with Azure service encryption. This replaces scenarios where Vault Transit was used for data-at-rest encryption:

### Azure Storage (customer-managed key)

```bicep
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'stprod'
  location: resourceGroup().location
  properties: {
    encryption: {
      keySource: 'Microsoft.Keyvault'
      keyvaultproperties: {
        keyname: 'storage-encryption-key'
        keyvaulturi: 'https://kv-keys-prod.vault.azure.net'
      }
      services: {
        blob: { enabled: true, keyType: 'Account' }
        file: { enabled: true, keyType: 'Account' }
        table: { enabled: true, keyType: 'Account' }
        queue: { enabled: true, keyType: 'Account' }
      }
    }
  }
}
```

### Azure SQL TDE (customer-managed key)

```bicep
resource sqlServer 'Microsoft.Sql/servers@2023-08-01-preview' = {
  name: 'sql-prod'
  properties: {
    keyId: 'https://kv-keys-prod.vault.azure.net/keys/sql-tde-key'
  }
}

resource tdeProtector 'Microsoft.Sql/servers/encryptionProtector@2023-08-01-preview' = {
  parent: sqlServer
  name: 'current'
  properties: {
    serverKeyType: 'AzureKeyVault'
    serverKeyName: '${keyVaultName}_sql-tde-key_${keyVersion}'
    autoRotationEnabled: true
  }
}
```

### Azure Disk Encryption

```bash
# Enable disk encryption with Key Vault key
az vm encryption enable \
  --resource-group rg-prod \
  --name vm-prod \
  --disk-encryption-keyvault kv-keys-prod \
  --key-encryption-key sql-tde-key
```

---

## 7. Performance considerations

### Vault Transit vs Key Vault throughput

| Operation               | Vault Transit (5-node cluster) | Key Vault Standard/Premium    | Managed HSM                  |
| ----------------------- | ------------------------------ | ----------------------------- | ---------------------------- |
| **RSA-2048 encrypt**    | ~5,000 ops/sec (cluster total) | 4,000 ops/sec (per vault)     | 5,000 ops/sec (per HSM unit) |
| **RSA-4096 encrypt**    | ~1,000 ops/sec                 | 4,000 ops/sec                 | 2,000 ops/sec                |
| **AES-256-GCM encrypt** | ~50,000 ops/sec                | N/A (use envelope encryption) | 5,000 ops/sec                |
| **EC-P256 sign**        | ~10,000 ops/sec                | 4,000 ops/sec                 | 5,000 ops/sec                |
| **Latency (p50)**       | 1-5ms (same-region)            | 5-15ms (same-region)          | 5-10ms (same-region)         |

For high-throughput scenarios:

1. **Envelope encryption** -- perform AES encryption client-side, use Key Vault only for key wrapping (reduces Key Vault calls by 99%+)
2. **Multiple vaults** -- distribute load across multiple Key Vault instances
3. **Caching** -- cache data encryption keys locally with TTL (Key Vault unwrap only on cache miss)
4. **Managed HSM** -- higher throughput limits per HSM unit, scale with additional units

---

## 8. Data re-encryption strategy

When migrating from Vault Transit keys to Key Vault keys, existing ciphertext encrypted with Vault keys must be re-encrypted with Key Vault keys.

### Option 1: Rolling re-encryption (recommended)

```python
def rolling_reencrypt(records, vault_client, kv_crypto_client):
    """Re-encrypt records incrementally during migration."""
    for record in records:
        if record.encryption_provider == 'vault':
            # Decrypt with Vault Transit
            plaintext = vault_decrypt(vault_client, record.ciphertext)
            # Re-encrypt with Key Vault
            new_ciphertext = kv_encrypt(kv_crypto_client, plaintext)
            # Update record
            record.ciphertext = new_ciphertext
            record.encryption_provider = 'keyvault'
            record.key_id = kv_crypto_client.key_id
            record.save()
```

### Option 2: Dual-read during transition

```python
def decrypt_any(record, vault_client, kv_crypto_client):
    """Decrypt from either provider during migration."""
    if record.encryption_provider == 'vault':
        return vault_decrypt(vault_client, record.ciphertext)
    elif record.encryption_provider == 'keyvault':
        return kv_decrypt(kv_crypto_client, record.ciphertext)
```

---

## 9. Post-migration validation

### Validation checklist

- [ ] All Key Vault keys are created with correct types and sizes matching Vault Transit keys
- [ ] Key rotation policies are configured
- [ ] Encrypt/decrypt round-trip produces correct results
- [ ] Sign/verify operations produce valid signatures
- [ ] Envelope encryption pattern is implemented for symmetric encryption workloads
- [ ] Azure service integrations (Storage CMK, SQL TDE) reference Key Vault keys
- [ ] Performance benchmarks meet requirements (latency, throughput)
- [ ] Existing ciphertext re-encryption plan is in progress
- [ ] RBAC roles (Key Vault Crypto Officer, Crypto User) are assigned appropriately
- [ ] Diagnostic logging captures all key operations

---

## Related resources

- **Secrets migration:** [Secrets Migration Guide](secrets-migration.md)
- **PKI migration:** [PKI Migration Guide](pki-migration.md)
- **Feature mapping:** [Complete Feature Mapping](feature-mapping-complete.md)
- **Best practices:** [Best Practices](best-practices.md)
- **Microsoft Learn:**
    - [Key Vault keys overview](https://learn.microsoft.com/azure/key-vault/keys/about-keys)
    - [Managed HSM overview](https://learn.microsoft.com/azure/key-vault/managed-hsm/overview)
    - [Envelope encryption pattern](https://learn.microsoft.com/azure/security/fundamentals/encryption-atrest)
    - [BYOK for Key Vault](https://learn.microsoft.com/azure/key-vault/keys/byok-specification)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
