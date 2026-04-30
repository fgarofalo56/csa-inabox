# Secrets Migration: Vault KV to Azure Key Vault Secrets

**Status:** Authored 2026-04-30
**Audience:** Platform Engineers, DevOps Engineers, Security Engineers
**Purpose:** Guide for migrating static secrets from HashiCorp Vault KV v1/v2 to Azure Key Vault secrets

---

## Overview

Static secrets -- API keys, connection strings, passwords, tokens, and configuration values -- are the most common workload in HashiCorp Vault. The KV secrets engine (both v1 and v2) stores these values at specified paths with optional versioning, metadata, and soft-delete capabilities.

Azure Key Vault secrets provide equivalent functionality with additional Azure-native capabilities: Entra ID RBAC, managed identity access, Event Grid-triggered rotation, soft-delete with purge protection, and native integration with every Azure service.

This guide covers the complete secrets migration workflow: export from Vault, import to Key Vault, configure access policies, set up rotation, and update application references.

---

## 1. Pre-migration assessment

### Inventory your Vault KV secrets

Before migrating, build a complete inventory:

```bash
# List all KV v2 mounts
vault secrets list -format=json | jq 'to_entries[] | select(.value.type == "kv") | .key'

# For each mount, list all secrets recursively
vault kv list -format=json secret/

# Count total secrets across all paths
vault kv list -format=json -mount=secret / | jq -r '.[]' | wc -l

# Export secret metadata (without values) for inventory
vault kv metadata list -format=json secret/ | jq '.[]'
```

### Categorize secrets by migration strategy

| Secret category                   | Example                                            | Migration strategy                                                                   |
| --------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Azure service credentials**     | SQL connection strings, storage account keys       | Replace with managed identity (Phase 3 -- no migration needed, eliminate the secret) |
| **Third-party API keys**          | Stripe, Twilio, SendGrid API keys                  | Migrate to Key Vault secret with rotation policy                                     |
| **Application configuration**     | Feature flags, endpoint URLs, non-sensitive config | Move to Azure App Configuration (not Key Vault)                                      |
| **Certificates and private keys** | TLS certs, signing keys                            | Migrate to Key Vault certificates (see [PKI Migration](pki-migration.md))            |
| **Encryption keys**               | AES/RSA keys used by Transit engine                | Migrate to Key Vault keys (see [Encryption Migration](encryption-migration.md))      |
| **Static database passwords**     | Legacy database credentials                        | Migrate to Key Vault, then replace with managed identity over time                   |

### Understand Vault KV versioning

**KV v1** stores a single version of each secret. Overwriting a secret destroys the previous value.

**KV v2** stores configurable version history. When you write a new value, the previous version is retained and accessible by version number.

**Key Vault** always stores version history. Each secret write creates a new version with a unique version identifier. Old versions remain accessible until explicitly purged. There is no configurable maximum version count -- versions are retained indefinitely until the secret is deleted and purge protection expires.

---

## 2. Key Vault deployment for secrets

### Bicep deployment

```bicep
@description('Key Vault for migrated secrets from HashiCorp Vault')
param vaultName string = 'kv-secrets-${uniqueString(resourceGroup().id)}'
param location string = resourceGroup().location

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard' // Use 'premium' for HSM-backed secrets
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true // Use RBAC, not access policies
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true // Cannot be disabled once enabled
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
      ipRules: []
      virtualNetworkRules: []
    }
  }
}

// Private endpoint for network isolation
resource privateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = {
  name: 'pe-${vaultName}'
  location: location
  properties: {
    subnet: {
      id: subnetId // Reference your VNet subnet
    }
    privateLinkServiceConnections: [
      {
        name: 'kv-connection'
        properties: {
          privateLinkServiceId: keyVault.id
          groupIds: ['vault']
        }
      }
    ]
  }
}
```

### RBAC vs access policies

Key Vault supports two authorization models. **Use RBAC** (set `enableRbacAuthorization: true`) for all new deployments:

| Criterion          | Access policies (legacy)                 | Azure RBAC (recommended)                        |
| ------------------ | ---------------------------------------- | ----------------------------------------------- |
| Granularity        | Per-vault (all-or-nothing per principal) | Per-secret, per-key, per-certificate            |
| Management         | Key Vault-level configuration            | Azure IAM (consistent with all Azure resources) |
| Entra groups       | Supported                                | Supported                                       |
| PIM integration    | Not supported                            | Supported (just-in-time elevation)              |
| Azure Policy       | Limited                                  | Full policy support                             |
| Maximum principals | 1,024 per vault                          | Unlimited (Azure RBAC limit)                    |
| Conditional Access | Not supported                            | Supported via Entra Conditional Access          |

---

## 3. Secret export from Vault

### Export using Vault CLI

```bash
# Export all secrets from a KV v2 mount to JSON
# This script exports the latest version of each secret

#!/bin/bash
MOUNT="secret"
OUTPUT_FILE="vault-secrets-export.json"

echo "{}" > "$OUTPUT_FILE"

# Recursive function to list and export secrets
export_secrets() {
  local path="$1"
  local keys=$(vault kv list -format=json -mount="$MOUNT" "$path" 2>/dev/null)

  if [ $? -ne 0 ]; then
    return
  fi

  for key in $(echo "$keys" | jq -r '.[]'); do
    if [[ "$key" == */ ]]; then
      # Directory -- recurse
      export_secrets "${path}${key}"
    else
      # Secret -- export
      local full_path="${path}${key}"
      local secret_data=$(vault kv get -format=json -mount="$MOUNT" "$full_path" | jq '.data.data')
      local metadata=$(vault kv metadata get -format=json -mount="$MOUNT" "$full_path" | jq '.data')

      # Add to output file
      jq --arg path "$full_path" \
         --argjson data "$secret_data" \
         --argjson meta "$metadata" \
         '.[$path] = {"data": $data, "metadata": $meta}' \
         "$OUTPUT_FILE" > tmp.json && mv tmp.json "$OUTPUT_FILE"
    fi
  done
}

export_secrets ""
echo "Exported secrets to $OUTPUT_FILE"
```

### Export using Vault API

```python
import hvac
import json

client = hvac.Client(url='https://vault.example.com:8200', token='s.xxxxx')

def export_all_secrets(mount_point='secret', path=''):
    """Recursively export all secrets from a KV v2 mount."""
    secrets = {}
    try:
        list_response = client.secrets.kv.v2.list_secrets(
            path=path, mount_point=mount_point
        )
        keys = list_response['data']['keys']
    except Exception:
        return secrets

    for key in keys:
        full_path = f"{path}{key}"
        if key.endswith('/'):
            # Directory -- recurse
            secrets.update(export_all_secrets(mount_point, full_path))
        else:
            # Secret -- read
            try:
                response = client.secrets.kv.v2.read_secret_version(
                    path=full_path, mount_point=mount_point
                )
                secrets[full_path] = {
                    'data': response['data']['data'],
                    'metadata': response['data']['metadata']
                }
            except Exception as e:
                print(f"Error reading {full_path}: {e}")

    return secrets

all_secrets = export_all_secrets()
with open('vault-secrets-export.json', 'w') as f:
    json.dump(all_secrets, f, indent=2)
print(f"Exported {len(all_secrets)} secrets")
```

!!! warning "Security: handle export files carefully"
The export file contains plaintext secret values. Encrypt the file at rest (`gpg --symmetric vault-secrets-export.json`), transfer via secure channel, and delete immediately after import. Never commit this file to version control.

---

## 4. Secret import to Key Vault

### Import using Azure CLI

```bash
#!/bin/bash
KEYVAULT_NAME="kv-secrets-prod"
EXPORT_FILE="vault-secrets-export.json"

# Read each secret from the export file and import to Key Vault
for path in $(jq -r 'keys[]' "$EXPORT_FILE"); do
  # Convert Vault path to Key Vault secret name
  # Vault: "app1/database/password" -> Key Vault: "app1-database-password"
  # Key Vault secret names allow alphanumeric and hyphens only
  secret_name=$(echo "$path" | sed 's/\//-/g' | sed 's/[^a-zA-Z0-9-]/-/g')

  # For simple key-value secrets, import the value directly
  # For multi-key secrets, import as JSON string
  key_count=$(jq -r --arg p "$path" '.[$p].data | keys | length' "$EXPORT_FILE")

  if [ "$key_count" -eq 1 ]; then
    # Single value -- import directly
    value=$(jq -r --arg p "$path" '.[$p].data | to_entries[0].value' "$EXPORT_FILE")
    az keyvault secret set \
      --vault-name "$KEYVAULT_NAME" \
      --name "$secret_name" \
      --value "$value" \
      --tags "migrated-from=vault" "vault-path=$path" \
      --output none
  else
    # Multiple keys -- import as JSON string
    value=$(jq -c --arg p "$path" '.[$p].data' "$EXPORT_FILE")
    az keyvault secret set \
      --vault-name "$KEYVAULT_NAME" \
      --name "$secret_name" \
      --value "$value" \
      --content-type "application/json" \
      --tags "migrated-from=vault" "vault-path=$path" \
      --output none
  fi

  echo "Imported: $path -> $secret_name"
done
```

### Import using Python SDK

```python
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
import json
from datetime import datetime, timedelta, timezone

credential = DefaultAzureCredential()
vault_url = "https://kv-secrets-prod.vault.azure.net"
client = SecretClient(vault_url=vault_url, credential=credential)

with open('vault-secrets-export.json', 'r') as f:
    secrets = json.load(f)

for vault_path, secret_info in secrets.items():
    # Convert Vault path to Key Vault name
    kv_name = vault_path.replace('/', '-').strip('-')
    # Key Vault names: alphanumeric and hyphens, 1-127 chars
    kv_name = ''.join(c if c.isalnum() or c == '-' else '-' for c in kv_name)[:127]

    data = secret_info['data']

    if len(data) == 1:
        value = str(list(data.values())[0])
        content_type = "text/plain"
    else:
        value = json.dumps(data)
        content_type = "application/json"

    # Set expiration (optional -- 1 year default for migrated secrets)
    expires_on = datetime.now(timezone.utc) + timedelta(days=365)

    client.set_secret(
        name=kv_name,
        value=value,
        content_type=content_type,
        expires_on=expires_on,
        tags={
            "migrated-from": "vault",
            "vault-path": vault_path,
            "migration-date": datetime.now(timezone.utc).isoformat()
        }
    )
    print(f"Imported: {vault_path} -> {kv_name}")

print(f"Migration complete: {len(secrets)} secrets imported")
```

---

## 5. Secret naming conventions

Vault uses path-based naming with `/` separators: `secret/app1/database/password`. Key Vault uses flat naming with hyphens: `app1-database-password`.

### Recommended naming convention

```
{application}-{environment}-{purpose}

Examples:
  webapp-prod-sql-connection-string
  api-staging-stripe-api-key
  batch-prod-storage-account-key
  databricks-prod-adls-sas-token
```

### Name mapping table

| Vault path                                 | Key Vault name                               | Content type       |
| ------------------------------------------ | -------------------------------------------- | ------------------ |
| `secret/webapp/prod/db-password`           | `webapp-prod-db-password`                    | `text/plain`       |
| `secret/webapp/prod/db-config` (multi-key) | `webapp-prod-db-config`                      | `application/json` |
| `secret/shared/stripe-api-key`             | `shared-stripe-api-key`                      | `text/plain`       |
| `secret/infra/tls/cert-private-key`        | Migrate to Key Vault certificate, not secret | N/A                |

---

## 6. Secret rotation policies

Vault relies on TTLs for KV v2 secrets. Key Vault uses Event Grid-triggered rotation workflows.

### Configure rotation with Event Grid

```bicep
// Event Grid subscription for secret near-expiry events
resource eventSubscription 'Microsoft.EventGrid/eventSubscriptions@2023-12-15-preview' = {
  name: 'secret-rotation-trigger'
  scope: keyVault
  properties: {
    destination: {
      endpointType: 'AzureFunction'
      properties: {
        resourceId: rotationFunction.id
      }
    }
    filter: {
      includedEventTypes: [
        'Microsoft.KeyVault.SecretNearExpiry'
        'Microsoft.KeyVault.SecretExpired'
      ]
    }
  }
}
```

### Rotation pattern with Azure Function

```python
import azure.functions as func
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
import json

def main(event: func.EventGridEvent):
    """Rotate a secret when near-expiry event fires."""
    data = event.get_json()
    secret_name = data['ObjectName']
    vault_uri = data['VaultName']

    credential = DefaultAzureCredential()
    client = SecretClient(vault_url=f"https://{vault_uri}.vault.azure.net",
                          credential=credential)

    # Read current secret to determine rotation logic
    current = client.get_secret(secret_name)
    secret_type = current.properties.tags.get('rotation-type', 'manual')

    if secret_type == 'api-key':
        new_value = rotate_api_key(current.value)
    elif secret_type == 'database-password':
        new_value = rotate_database_password(current.value)
    else:
        # Manual rotation -- send alert
        send_rotation_alert(secret_name, vault_uri)
        return

    # Set new secret version with updated expiration
    from datetime import datetime, timedelta, timezone
    client.set_secret(
        name=secret_name,
        value=new_value,
        expires_on=datetime.now(timezone.utc) + timedelta(days=90),
        tags=current.properties.tags
    )
```

---

## 7. Soft-delete and purge protection

### Vault vs Key Vault comparison

| Feature                   | Vault KV v2                                                                   | Key Vault                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Soft-delete**           | Delete retains versions; undelete restores                                    | Soft-delete enabled by default; retains deleted secrets for 7-90 days                     |
| **Purge protection**      | destroy command permanently deletes versions                                  | Purge protection prevents permanent deletion during retention period                      |
| **Mandatory soft-delete** | Optional                                                                      | Mandatory for all vaults created after Feb 2025                                           |
| **Recovery**              | `vault kv undelete` restores to previous version                              | `az keyvault secret recover` restores deleted secret                                      |
| **Permanent deletion**    | `vault kv destroy` (per-version) or `vault kv metadata delete` (all versions) | `az keyvault secret purge` (only after retention period, only if purge protection allows) |

### Enable purge protection (mandatory for production)

```bash
az keyvault update \
  --name kv-secrets-prod \
  --enable-purge-protection true \
  --retention-days 90
```

!!! warning "Purge protection is irreversible"
Once enabled, purge protection cannot be disabled. Deleted secrets cannot be permanently removed until the retention period expires. This is by design for compliance and data protection -- plan retention days carefully.

---

## 8. Access control migration

### Map Vault policies to Key Vault RBAC

| Vault policy                                                                        | Key Vault RBAC role       | Scope                                             |
| ----------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------- |
| `path "secret/data/app1/*" { capabilities = ["read"] }`                             | Key Vault Secrets User    | Scope to individual secrets or Key Vault instance |
| `path "secret/data/*" { capabilities = ["create", "read", "update", "delete"] }`    | Key Vault Secrets Officer | Key Vault instance                                |
| `path "secret/metadata/*" { capabilities = ["list", "read"] }`                      | Key Vault Reader          | Key Vault instance                                |
| `path "secret/*" { capabilities = ["read", "list", "create", "update", "delete"] }` | Key Vault Administrator   | Key Vault instance                                |

### Assign RBAC roles

```bash
# Grant Key Vault Secrets User to an application managed identity
az role assignment create \
  --role "Key Vault Secrets User" \
  --assignee-object-id <managed-identity-principal-id> \
  --scope /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.KeyVault/vaults/<vault-name>

# Grant Key Vault Secrets Officer to a security admin group
az role assignment create \
  --role "Key Vault Secrets Officer" \
  --assignee-object-id <entra-group-id> \
  --scope /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.KeyVault/vaults/<vault-name>
```

---

## 9. Update application references

### Before (Vault SDK)

```python
# Python application reading from Vault
import hvac

client = hvac.Client(url='https://vault.example.com:8200')
# Auth via AppRole
client.auth.approle.login(role_id='xxx', secret_id='yyy')

secret = client.secrets.kv.v2.read_secret_version(path='app1/db-password')
db_password = secret['data']['data']['password']
```

### After (Key Vault SDK)

```python
# Python application reading from Key Vault
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

credential = DefaultAzureCredential()  # Uses managed identity automatically
client = SecretClient(
    vault_url="https://kv-secrets-prod.vault.azure.net",
    credential=credential
)

secret = client.get_secret("app1-db-password")
db_password = secret.value
```

### AKS workload with CSI Secret Store Driver

```yaml
# SecretProviderClass for AKS (replaces Vault Agent Injector)
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
    name: azure-kv-secrets
spec:
    provider: azure
    parameters:
        usePodIdentity: "false"
        useVMManagedIdentity: "true"
        userAssignedIdentityID: "<managed-identity-client-id>"
        keyvaultName: "kv-secrets-prod"
        objects: |
            array:
              - |
                objectName: app1-db-password
                objectType: secret
              - |
                objectName: app1-api-key
                objectType: secret
        tenantId: "<tenant-id>"
```

---

## 10. Post-migration validation

### Validation checklist

- [ ] All secrets from Vault inventory are present in Key Vault
- [ ] Secret values match between Vault and Key Vault (compare hashes, not plaintext)
- [ ] Application can read secrets from Key Vault using managed identity
- [ ] Secret tags contain migration metadata (source path, migration date)
- [ ] Soft-delete and purge protection are enabled
- [ ] RBAC roles are assigned with least-privilege
- [ ] Diagnostic logging is enabled to Log Analytics workspace
- [ ] Secret rotation policies are configured for secrets that require rotation
- [ ] Private endpoints are configured for network isolation
- [ ] Azure Policy compliance reports show no violations

---

## Related resources

- **Tutorial:** [Step-by-Step Secret Migration](tutorial-secret-migration.md)
- **Feature mapping:** [Complete Feature Mapping](feature-mapping-complete.md)
- **Policy migration:** [Policy Migration Guide](policy-migration.md)
- **Best practices:** [Best Practices](best-practices.md)
- **Microsoft Learn:** [Key Vault secrets documentation](https://learn.microsoft.com/azure/key-vault/secrets/)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
