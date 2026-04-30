# Tutorial: Step-by-Step Secret Migration from Vault to Key Vault

**Status:** Authored 2026-04-30
**Audience:** Platform Engineers, DevOps Engineers
**Purpose:** Hands-on tutorial for exporting secrets from HashiCorp Vault and importing them to Azure Key Vault with full RBAC configuration

---

## Prerequisites

Before starting this tutorial, ensure you have:

- **HashiCorp Vault** access with `read` and `list` capabilities on target paths
- **Azure subscription** with Contributor or Owner role
- **Azure CLI** (`az`) version 2.60 or later
- **Python** 3.9 or later with `pip`
- **Network access** from your workstation to both Vault and Azure

### Install required tools

```bash
# Azure CLI
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash

# Python packages
pip install hvac azure-identity azure-keyvault-secrets azure-mgmt-keyvault

# Authenticate to Azure
az login
az account set --subscription "your-subscription-id"

# Authenticate to Vault
export VAULT_ADDR="https://vault.example.com:8200"
export VAULT_TOKEN="s.your-vault-token"
# Or use: vault login -method=oidc
```

---

## Step 1: Inventory Vault secrets

Start by understanding what you are migrating.

### List all KV mounts

```bash
vault secrets list -format=json | \
  jq 'to_entries[] | select(.value.type == "kv") | {mount: .key, version: .value.options.version}'
```

Example output:

```json
{"mount": "secret/", "version": "2"}
{"mount": "app-secrets/", "version": "2"}
{"mount": "infra/", "version": "1"}
```

### Count secrets per mount

```bash
# For KV v2 mounts
count_secrets() {
  local mount=$1
  local path=$2
  local count=0

  local keys=$(vault kv list -format=json -mount="$mount" "$path" 2>/dev/null)
  if [ $? -ne 0 ]; then
    echo 0
    return
  fi

  for key in $(echo "$keys" | jq -r '.[]'); do
    if [[ "$key" == */ ]]; then
      local sub_count=$(count_secrets "$mount" "${path}${key}")
      count=$((count + sub_count))
    else
      count=$((count + 1))
    fi
  done

  echo $count
}

echo "secret/: $(count_secrets secret '') secrets"
echo "app-secrets/: $(count_secrets app-secrets '') secrets"
```

### Generate inventory report

```python
#!/usr/bin/env python3
"""Generate Vault secrets inventory report."""
import hvac
import json
import os
from datetime import datetime

client = hvac.Client(
    url=os.getenv('VAULT_ADDR'),
    token=os.getenv('VAULT_TOKEN')
)

def inventory_mount(mount_point, path=''):
    """Recursively inventory secrets in a KV v2 mount."""
    inventory = []
    try:
        response = client.secrets.kv.v2.list_secrets(
            path=path, mount_point=mount_point
        )
        keys = response['data']['keys']
    except Exception:
        return inventory

    for key in keys:
        full_path = f"{path}{key}"
        if key.endswith('/'):
            inventory.extend(inventory_mount(mount_point, full_path))
        else:
            try:
                metadata = client.secrets.kv.v2.read_secret_metadata(
                    path=full_path, mount_point=mount_point
                )
                meta = metadata['data']
                inventory.append({
                    'mount': mount_point,
                    'path': full_path,
                    'versions': meta['current_version'],
                    'created': meta['created_time'],
                    'updated': meta['updated_time'],
                    'custom_metadata': meta.get('custom_metadata', {}),
                })
            except Exception as e:
                inventory.append({
                    'mount': mount_point,
                    'path': full_path,
                    'error': str(e)
                })
    return inventory

# Inventory all mounts
all_inventory = []
mounts_response = client.sys.list_mounted_secrets_engines()
for mount, config in mounts_response['data'].items():
    if config['type'] == 'kv':
        print(f"Inventorying mount: {mount}")
        mount_name = mount.rstrip('/')
        all_inventory.extend(inventory_mount(mount_name))

# Save report
report = {
    'generated_at': datetime.utcnow().isoformat(),
    'total_secrets': len(all_inventory),
    'secrets': all_inventory
}

with open('vault-inventory.json', 'w') as f:
    json.dump(report, f, indent=2)

print(f"\nInventory complete: {len(all_inventory)} secrets found")
print("Report saved to vault-inventory.json")
```

---

## Step 2: Deploy Key Vault with Bicep

### Create the Bicep template

Save as `key-vault.bicep`:

```bicep
@description('Name for the Key Vault')
param vaultName string

@description('Azure region')
param location string = resourceGroup().location

@description('Enable HSM backing (Premium tier)')
param enableHsm bool = false

@description('Object ID of the initial admin (your user or group)')
param adminObjectId string

@description('Subnet ID for private endpoint (optional)')
param subnetId string = ''

// Key Vault resource
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: enableHsm ? 'premium' : 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: subnetId != '' ? 'Disabled' : 'Enabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    }
  }
}

// Admin role assignment
resource adminRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, adminObjectId, 'Key Vault Administrator')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '00482a5a-887f-4fb3-b363-3b7fe8e74483' // Key Vault Administrator
    )
    principalId: adminObjectId
    principalType: 'User'
  }
}

// Diagnostic settings
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: '${vaultName}-diagnostics'
  scope: keyVault
  properties: {
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
        retentionPolicy: {
          enabled: true
          days: 365
        }
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
        retentionPolicy: {
          enabled: true
          days: 90
        }
      }
    ]
    // Uncomment and set workspace ID for Log Analytics:
    // workspaceId: logAnalyticsWorkspaceId
  }
}

// Private endpoint (if subnet provided)
resource privateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = if (subnetId != '') {
  name: 'pe-${vaultName}'
  location: location
  properties: {
    subnet: {
      id: subnetId
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

output vaultUri string = keyVault.properties.vaultUri
output vaultId string = keyVault.id
```

### Deploy the Key Vault

```bash
# Create resource group
az group create --name rg-keyvault-migration --location eastus2

# Get your user object ID for admin access
ADMIN_OID=$(az ad signed-in-user show --query id -o tsv)

# Deploy Key Vault
az deployment group create \
  --resource-group rg-keyvault-migration \
  --template-file key-vault.bicep \
  --parameters \
    vaultName=kv-migrated-prod \
    adminObjectId=$ADMIN_OID \
    enableHsm=false

# Verify deployment
az keyvault show --name kv-migrated-prod --query properties.vaultUri
```

---

## Step 3: Export secrets from Vault

### Run the export script

```python
#!/usr/bin/env python3
"""Export secrets from HashiCorp Vault KV v2 to JSON file."""
import hvac
import json
import os
import hashlib
from datetime import datetime

client = hvac.Client(
    url=os.getenv('VAULT_ADDR'),
    token=os.getenv('VAULT_TOKEN')
)

assert client.is_authenticated(), "Vault authentication failed"

def export_secrets(mount_point='secret', path=''):
    """Recursively export all secrets with their values."""
    secrets = {}
    try:
        response = client.secrets.kv.v2.list_secrets(
            path=path, mount_point=mount_point
        )
        keys = response['data']['keys']
    except Exception:
        return secrets

    for key in keys:
        full_path = f"{path}{key}"
        if key.endswith('/'):
            secrets.update(export_secrets(mount_point, full_path))
        else:
            try:
                secret_response = client.secrets.kv.v2.read_secret_version(
                    path=full_path, mount_point=mount_point
                )
                data = secret_response['data']['data']
                metadata = secret_response['data']['metadata']

                # Hash values for verification (never log actual values)
                hashed = {k: hashlib.sha256(str(v).encode()).hexdigest()[:12]
                         for k, v in data.items()}

                secrets[full_path] = {
                    'data': data,
                    'metadata': {
                        'version': metadata['version'],
                        'created_time': metadata['created_time'],
                        'custom_metadata': metadata.get('custom_metadata', {}),
                    },
                    'value_hashes': hashed,
                }
                print(f"  Exported: {full_path} ({len(data)} keys)")

            except Exception as e:
                print(f"  ERROR: {full_path}: {e}")

    return secrets

print("Starting Vault secret export...")
print(f"Vault address: {os.getenv('VAULT_ADDR')}")

all_secrets = {}
mounts = client.sys.list_mounted_secrets_engines()
for mount, config in mounts['data'].items():
    if config['type'] == 'kv':
        mount_name = mount.rstrip('/')
        print(f"\nExporting mount: {mount_name}/")
        mount_secrets = export_secrets(mount_name)
        for path, data in mount_secrets.items():
            all_secrets[f"{mount_name}/{path}"] = data

export = {
    'exported_at': datetime.utcnow().isoformat(),
    'vault_addr': os.getenv('VAULT_ADDR'),
    'total_secrets': len(all_secrets),
    'secrets': all_secrets,
}

output_file = 'vault-export.json'
with open(output_file, 'w') as f:
    json.dump(export, f, indent=2)

print(f"\nExport complete: {len(all_secrets)} secrets written to {output_file}")
print("WARNING: This file contains plaintext secrets. Encrypt or delete after import.")
```

---

## Step 4: Import secrets to Key Vault

### Run the import script

```python
#!/usr/bin/env python3
"""Import secrets from Vault export to Azure Key Vault."""
import json
import re
import os
from datetime import datetime, timedelta, timezone
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

# Configuration
VAULT_NAME = os.getenv('KEY_VAULT_NAME', 'kv-migrated-prod')
EXPORT_FILE = os.getenv('EXPORT_FILE', 'vault-export.json')
DEFAULT_EXPIRY_DAYS = int(os.getenv('DEFAULT_EXPIRY_DAYS', '365'))

credential = DefaultAzureCredential()
client = SecretClient(
    vault_url=f"https://{VAULT_NAME}.vault.azure.net",
    credential=credential
)

def sanitize_name(vault_path: str) -> str:
    """Convert Vault path to valid Key Vault secret name.

    Key Vault names: alphanumeric and hyphens, 1-127 chars.
    Vault paths: alphanumeric, slashes, hyphens, underscores.
    """
    name = vault_path.replace('/', '-').replace('_', '-')
    name = re.sub(r'[^a-zA-Z0-9-]', '-', name)
    name = re.sub(r'-+', '-', name)  # Collapse multiple hyphens
    name = name.strip('-')[:127]
    return name

def import_secret(vault_path: str, secret_data: dict):
    """Import a single secret to Key Vault."""
    kv_name = sanitize_name(vault_path)
    data = secret_data['data']
    metadata = secret_data.get('metadata', {})

    # Determine value and content type
    if len(data) == 1:
        value = str(list(data.values())[0])
        content_type = 'text/plain'
    else:
        value = json.dumps(data)
        content_type = 'application/json'

    # Set expiration
    expires_on = datetime.now(timezone.utc) + timedelta(days=DEFAULT_EXPIRY_DAYS)

    # Build tags
    tags = {
        'migrated-from': 'hashicorp-vault',
        'vault-path': vault_path,
        'migration-date': datetime.now(timezone.utc).strftime('%Y-%m-%d'),
        'original-version': str(metadata.get('version', 'unknown')),
    }

    # Add custom metadata as tags
    custom_meta = metadata.get('custom_metadata', {})
    for k, v in (custom_meta or {}).items():
        tag_key = f"vault-{k}"[:256]
        tags[tag_key] = str(v)[:256]

    try:
        client.set_secret(
            name=kv_name,
            value=value,
            content_type=content_type,
            expires_on=expires_on,
            tags=tags,
        )
        return True, kv_name
    except Exception as e:
        return False, str(e)

# Load export file
with open(EXPORT_FILE, 'r') as f:
    export = json.load(f)

print(f"Key Vault: {VAULT_NAME}")
print(f"Secrets to import: {export['total_secrets']}")
print(f"Default expiry: {DEFAULT_EXPIRY_DAYS} days")
print()

# Import each secret
success_count = 0
error_count = 0
mapping = []

for vault_path, secret_data in export['secrets'].items():
    ok, result = import_secret(vault_path, secret_data)
    if ok:
        success_count += 1
        mapping.append({
            'vault_path': vault_path,
            'kv_name': result,
            'status': 'imported'
        })
        print(f"  OK: {vault_path} -> {result}")
    else:
        error_count += 1
        mapping.append({
            'vault_path': vault_path,
            'error': result,
            'status': 'failed'
        })
        print(f"  FAIL: {vault_path}: {result}")

# Save mapping report
mapping_report = {
    'imported_at': datetime.now(timezone.utc).isoformat(),
    'key_vault': VAULT_NAME,
    'total': len(mapping),
    'success': success_count,
    'errors': error_count,
    'mapping': mapping,
}
with open('migration-mapping.json', 'w') as f:
    json.dump(mapping_report, f, indent=2)

print(f"\nImport complete: {success_count} imported, {error_count} errors")
print("Mapping saved to migration-mapping.json")
```

---

## Step 5: Configure RBAC for applications

### Create managed identities and assign roles

```bash
# Example: grant a web app's managed identity read access to secrets
WEBAPP_MI_OID=$(az webapp identity show \
  --name webapp-prod \
  --resource-group rg-app \
  --query principalId -o tsv)

az role assignment create \
  --role "Key Vault Secrets User" \
  --assignee-object-id $WEBAPP_MI_OID \
  --assignee-principal-type ServicePrincipal \
  --scope $(az keyvault show --name kv-migrated-prod --query id -o tsv)

echo "Granted Key Vault Secrets User to webapp-prod managed identity"
```

### Verify access

```bash
# Test that the managed identity can read secrets
az keyvault secret list --vault-name kv-migrated-prod --query "[].name" -o tsv
az keyvault secret show --vault-name kv-migrated-prod --name webapp-prod-db-password --query value
```

---

## Step 6: Update application configuration

### App Service: Key Vault references

```bash
# Reference Key Vault secret in App Service app settings
az webapp config appsettings set \
  --name webapp-prod \
  --resource-group rg-app \
  --settings DB_PASSWORD="@Microsoft.KeyVault(VaultName=kv-migrated-prod;SecretName=webapp-prod-db-password)"
```

### Application code update

```python
# Before: reading from Vault
import hvac
client = hvac.Client(url='https://vault:8200')
client.auth.approle.login(role_id='xxx', secret_id='yyy')
secret = client.secrets.kv.v2.read_secret_version(path='webapp/db-password')
password = secret['data']['data']['password']

# After: reading from Key Vault
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

credential = DefaultAzureCredential()
client = SecretClient(vault_url="https://kv-migrated-prod.vault.azure.net",
                      credential=credential)
password = client.get_secret("webapp-prod-db-password").value
```

---

## Step 7: Validate the migration

### Validation script

```python
#!/usr/bin/env python3
"""Validate migration: compare Vault secrets with Key Vault secrets."""
import json
import hashlib
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

VAULT_NAME = 'kv-migrated-prod'
MAPPING_FILE = 'migration-mapping.json'

credential = DefaultAzureCredential()
client = SecretClient(
    vault_url=f"https://{VAULT_NAME}.vault.azure.net",
    credential=credential
)

with open(MAPPING_FILE, 'r') as f:
    mapping = json.load(f)

print("Validating migration...")
valid = 0
invalid = 0

for entry in mapping['mapping']:
    if entry['status'] != 'imported':
        continue

    kv_name = entry['kv_name']
    try:
        secret = client.get_secret(kv_name)
        assert secret.value is not None, "Secret value is None"
        assert secret.properties.expires_on is not None, "No expiration set"
        assert 'migrated-from' in (secret.properties.tags or {}), "Missing migration tag"

        valid += 1
        print(f"  VALID: {kv_name}")
    except Exception as e:
        invalid += 1
        print(f"  INVALID: {kv_name}: {e}")

print(f"\nValidation complete: {valid} valid, {invalid} invalid")
```

---

## Step 8: Clean up

### Secure the export files

```bash
# Encrypt the export file (if keeping for records)
gpg --symmetric --cipher-algo AES256 vault-export.json
# Enter passphrase when prompted

# Securely delete the plaintext export
shred -vfz -n 5 vault-export.json
rm vault-export.json

# Keep the mapping report (no secrets, just path mappings)
# migration-mapping.json is safe to retain
```

### Document the migration

Record the migration in your change management system:

- Date of migration
- Number of secrets migrated
- Applications updated
- Vault policies mapped to RBAC assignments
- Any secrets that were eliminated (replaced by managed identity)
- Vault decommission timeline

---

## Troubleshooting

| Issue                                        | Solution                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| `SecretNotFound` when reading from Key Vault | Verify the secret name mapping; Key Vault names use hyphens, not slashes |
| `ForbiddenByPolicy` when creating secrets    | Check RBAC: ensure your identity has Key Vault Secrets Officer role      |
| `NetworkError` connecting to Key Vault       | Check private endpoint configuration and DNS resolution                  |
| Application cannot read secrets              | Verify managed identity is assigned Key Vault Secrets User role          |
| Secret value truncated                       | Key Vault has a 25 KB limit per secret; split large secrets              |
| Import script rate-limited                   | Key Vault allows 4,000 ops/sec; add `time.sleep(0.01)` between imports   |

---

## Next steps

1. **Migrate dynamic secrets** to managed identity: [Dynamic Secrets Migration](dynamic-secrets-migration.md)
2. **Migrate encryption keys**: [Encryption Migration](encryption-migration.md)
3. **Configure rotation policies**: [Best Practices](best-practices.md)
4. **Set up governance**: [Policy Migration](policy-migration.md)

---

## Related resources

- **Secrets migration guide:** [Secrets Migration](secrets-migration.md)
- **Feature mapping:** [Complete Feature Mapping](feature-mapping-complete.md)
- **Microsoft Learn:** [Key Vault quickstart (Python)](https://learn.microsoft.com/azure/key-vault/secrets/quick-create-python)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
