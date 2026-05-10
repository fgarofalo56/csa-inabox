# Azure Storage Custom Domains Reference

[Home](../../../README.md) > [Reference](../README.md) > [Storage](README.md) > Custom Domains

![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Documentation](https://img.shields.io/badge/Documentation-Complete-blue)

> Comprehensive reference guide for configuring custom domains for Azure Storage accounts, including CDN integration, HTTPS support, and best practices for cloud-scale analytics workloads.

---

## Table of Contents

- [Overview](#overview)
- [Custom Domain Configuration](#custom-domain-configuration)
- [CDN Integration](#cdn-integration)
- [HTTPS and SSL Certificates](#https-and-ssl-certificates)
- [DNS Configuration](#dns-configuration)
- [Domain Validation](#domain-validation)
- [Advanced Scenarios](#advanced-scenarios)
- [Performance Optimization](#performance-optimization)
- [Troubleshooting](#troubleshooting)

---

## Overview

### What is Custom Domain Support?

Custom domains allow you to access Azure Storage resources using your own domain name instead of the default Azure Storage endpoint.

### Supported Services

| Service | Default Endpoint | Custom Domain Support | HTTPS Support |
|---------|------------------|----------------------|---------------|
| **Blob Storage** | `{account}.blob.core.windows.net` | Yes (direct or CDN) | Yes (CDN only) |
| **Static Website** | `{account}.z13.web.core.windows.net` | Yes (CDN recommended) | Yes (CDN only) |
| **Azure Data Lake Gen2** | `{account}.dfs.core.windows.net` | Limited (CDN required) | Yes (CDN only) |
| **File Storage** | `{account}.file.core.windows.net` | No | N/A |
| **Table Storage** | `{account}.table.core.windows.net` | No | N/A |
| **Queue Storage** | `{account}.queue.core.windows.net` | No | N/A |

### Custom Domain Architecture

```text
┌──────────────────────────────────────────────────────────┐
│           Custom Domain Architecture Options             │
├──────────────────────────────────────────────────────────┤
│                                                           │
│  Option 1: Direct Mapping (HTTP only)                    │
│  ┌──────────────┐         ┌─────────────────┐           │
│  │   User       │────────>│ DNS (CNAME)     │           │
│  └──────────────┘         └────────┬────────┘           │
│                                     │                     │
│                                     ▼                     │
│                          ┌──────────────────┐            │
│                          │ Azure Storage    │            │
│                          │ (HTTP only)      │            │
│                          └──────────────────┘            │
│                                                           │
│  Option 2: CDN Integration (HTTP + HTTPS)                │
│  ┌──────────────┐         ┌─────────────────┐           │
│  │   User       │────────>│ DNS (CNAME)     │           │
│  └──────────────┘         └────────┬────────┘           │
│                                     │                     │
│                                     ▼                     │
│                          ┌──────────────────┐            │
│                          │ Azure CDN        │            │
│                          │ (HTTPS support)  │            │
│                          └────────┬─────────┘            │
│                                   │                       │
│                                   ▼                       │
│                          ┌──────────────────┐            │
│                          │ Azure Storage    │            │
│                          └──────────────────┘            │
│                                                           │
└──────────────────────────────────────────────────────────┘
```

---

## Custom Domain Configuration

### Prerequisites

- Azure Storage account (General Purpose v2 or Blob Storage)
- Domain name registered with domain registrar
- Access to domain's DNS settings
- Azure CDN profile (required for HTTPS)

### Direct CNAME Mapping (HTTP Only)

#### Configuration Steps

1. **Verify domain ownership**
2. **Create CNAME record**
3. **Register custom domain with storage account**
4. **Validate configuration**

#### Azure CLI - Direct Mapping

```bash
# Step 1: Create storage account
az storage account create \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --location eastus \
  --sku Standard_GRS \
  --kind StorageV2 \
  --https-only false  # Required for direct custom domain

# Step 2: Get storage account endpoint
BLOB_ENDPOINT=$(az storage account show \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --query primaryEndpoints.blob -o tsv)

echo "Create CNAME record: data.contoso.com -> ${BLOB_ENDPOINT}"

# Step 3: Register custom domain (after CNAME is created)
az storage account update \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --custom-domain "data.contoso.com"

# Verify custom domain
az storage account show \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --query customDomain
```

#### PowerShell - Direct Mapping

```powershell
# Create storage account
New-AzStorageAccount `
  -ResourceGroupName "rg-analytics-prod" `
  -Name "stadatalake001" `
  -Location "eastus" `
  -SkuName "Standard_GRS" `
  -Kind "StorageV2"

# Get blob endpoint
$storageAccount = Get-AzStorageAccount `
  -ResourceGroupName "rg-analytics-prod" `
  -Name "stadatalake001"

$blobEndpoint = $storageAccount.PrimaryEndpoints.Blob
Write-Host "Create CNAME: data.contoso.com -> $blobEndpoint"

# Set custom domain
Set-AzStorageAccount `
  -ResourceGroupName "rg-analytics-prod" `
  -Name "stadatalake001" `
  -CustomDomainName "data.contoso.com" `
  -UseSubDomain $false
```

### Indirect CNAME Mapping (Zero Downtime)

For production environments, use indirect mapping to avoid downtime during validation.

```bash
# Step 1: Create asverify CNAME record
# CNAME: asverify.data.contoso.com -> asverify.stadatalake001.blob.core.windows.net

# Step 2: Register custom domain with UseSubDomain
az storage account update \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --custom-domain "data.contoso.com" \
  --use-subdomain true

# Step 3: Create final CNAME record
# CNAME: data.contoso.com -> stadatalake001.blob.core.windows.net

# Step 4: Update to direct mapping
az storage account update \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --custom-domain "data.contoso.com" \
  --use-subdomain false
```

---

## CDN Integration

### Why Use Azure CDN?

| Feature | Direct Mapping | With CDN |
|---------|---------------|----------|
| **HTTPS Support** | ❌ No | ✅ Yes |
| **Custom SSL Certificates** | ❌ No | ✅ Yes |
| **Global Performance** | Limited | ✅ Yes |
| **Caching** | No | ✅ Yes |
| **DDoS Protection** | Basic | ✅ Enhanced |
| **Cost** | Lower | Higher |

### CDN Configuration Steps

#### Azure CLI - CDN Setup

```bash
# Step 1: Create CDN profile
az cdn profile create \
  --name cdn-analytics-prod \
  --resource-group rg-analytics-prod \
  --sku Standard_Microsoft \
  --location Global

# Step 2: Create CDN endpoint
az cdn endpoint create \
  --name data-contoso \
  --profile-name cdn-analytics-prod \
  --resource-group rg-analytics-prod \
  --origin stadatalake001.blob.core.windows.net \
  --origin-host-header stadatalake001.blob.core.windows.net \
  --enable-compression true \
  --content-types-to-compress "application/json" "text/css" "text/javascript" \
  --query-string-caching-behavior BypassCaching

# Step 3: Add custom domain to CDN endpoint
az cdn custom-domain create \
  --endpoint-name data-contoso \
  --hostname data.contoso.com \
  --name data-contoso-com \
  --profile-name cdn-analytics-prod \
  --resource-group rg-analytics-prod

# Step 4: Enable HTTPS on custom domain
az cdn custom-domain enable-https \
  --endpoint-name data-contoso \
  --name data-contoso-com \
  --profile-name cdn-analytics-prod \
  --resource-group rg-analytics-prod \
  --min-tls-version "1.2"
```

#### Bicep - CDN Configuration

```bicep
// Storage account
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: 'stadatalake001'
  location: location
  sku: {
    name: 'Standard_GRS'
  }
  kind: 'StorageV2'
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: true
  }
}

// CDN profile
resource cdnProfile 'Microsoft.Cdn/profiles@2023-05-01' = {
  name: 'cdn-analytics-prod'
  location: 'Global'
  sku: {
    name: 'Standard_Microsoft'
  }
}

// CDN endpoint
resource cdnEndpoint 'Microsoft.Cdn/profiles/endpoints@2023-05-01' = {
  parent: cdnProfile
  name: 'data-contoso'
  location: 'Global'
  properties: {
    originHostHeader: '${storageAccount.name}.blob.${environment().suffixes.storage}'
    isHttpAllowed: true
    isHttpsAllowed: true
    queryStringCachingBehavior: 'BypassCaching'
    isCompressionEnabled: true
    contentTypesToCompress: [
      'application/json'
      'text/css'
      'text/javascript'
      'text/html'
    ]
    origins: [
      {
        name: 'origin1'
        properties: {
          hostName: '${storageAccount.name}.blob.${environment().suffixes.storage}'
          httpPort: 80
          httpsPort: 443
          originHostHeader: '${storageAccount.name}.blob.${environment().suffixes.storage}'
        }
      }
    ]
  }
}

// Custom domain
resource customDomain 'Microsoft.Cdn/profiles/endpoints/customDomains@2023-05-01' = {
  parent: cdnEndpoint
  name: 'data-contoso-com'
  properties: {
    hostName: 'data.contoso.com'
  }
}
```

---

## HTTPS and SSL Certificates

### CDN-Managed Certificates

Azure CDN provides free, automatically managed SSL certificates.

```bash
# Enable HTTPS with CDN-managed certificate
az cdn custom-domain enable-https \
  --endpoint-name data-contoso \
  --name data-contoso-com \
  --profile-name cdn-analytics-prod \
  --resource-group rg-analytics-prod \
  --min-tls-version "1.2"

# Check HTTPS provisioning status
az cdn custom-domain show \
  --endpoint-name data-contoso \
  --name data-contoso-com \
  --profile-name cdn-analytics-prod \
  --resource-group rg-analytics-prod \
  --query customHttpsProvisioningState
```

### Custom SSL Certificates (Key Vault)

```bash
# Store certificate in Key Vault
az keyvault certificate import \
  --vault-name kv-analytics-prod \
  --name ssl-data-contoso \
  --file certificate.pfx \
  --password "cert-password"

# Enable HTTPS with custom certificate
az cdn custom-domain enable-https \
  --endpoint-name data-contoso \
  --name data-contoso-com \
  --profile-name cdn-analytics-prod \
  --resource-group rg-analytics-prod \
  --user-cert-group-name rg-analytics-prod \
  --user-cert-vault-name kv-analytics-prod \
  --user-cert-secret-name ssl-data-contoso \
  --user-cert-secret-version "latest" \
  --user-cert-protocol-type "sni" \
  --min-tls-version "1.2"
```

### Certificate Requirements

| Requirement | Details |
|-------------|---------|
| **Format** | PFX or PEM |
| **Key Type** | RSA (minimum 2048-bit) |
| **Certificate Type** | Domain Validation (DV) or higher |
| **Valid Period** | Active and not expired |
| **Chain** | Complete certificate chain included |
| **Private Key** | Must be included and not password protected (for PEM) |

---

## DNS Configuration

### CNAME Record Configuration

#### For Direct Mapping

```text
Record Type: CNAME
Name: data (or subdomain of your choice)
Value: stadatalake001.blob.core.windows.net
TTL: 3600 (1 hour)
```

#### For CDN Mapping

```text
Record Type: CNAME
Name: data (or subdomain of your choice)
Value: data-contoso.azureedge.net
TTL: 3600 (1 hour)
```

#### For Zero-Downtime Validation

```text
Step 1: Validation CNAME
Record Type: CNAME
Name: asverify.data
Value: asverify.stadatalake001.blob.core.windows.net
TTL: 3600

Step 2: Final CNAME (after validation)
Record Type: CNAME
Name: data
Value: stadatalake001.blob.core.windows.net
TTL: 3600
```

### DNS Provider Examples

#### Azure DNS

```bash
# Create DNS zone
az network dns zone create \
  --resource-group rg-analytics-prod \
  --name contoso.com

# Create CNAME record
az network dns record-set cname create \
  --resource-group rg-analytics-prod \
  --zone-name contoso.com \
  --name data \
  --ttl 3600

az network dns record-set cname set-record \
  --resource-group rg-analytics-prod \
  --zone-name contoso.com \
  --record-set-name data \
  --cname data-contoso.azureedge.net
```

#### Route 53 (AWS)

```json
{
  "Changes": [{
    "Action": "CREATE",
    "ResourceRecordSet": {
      "Name": "data.contoso.com",
      "Type": "CNAME",
      "TTL": 3600,
      "ResourceRecords": [{
        "Value": "data-contoso.azureedge.net"
      }]
    }
  }]
}
```

#### Cloudflare

```bash
# Using Cloudflare API
curl -X POST "https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records" \
  -H "Authorization: Bearer {api_token}" \
  -H "Content-Type: application/json" \
  --data '{
    "type": "CNAME",
    "name": "data",
    "content": "data-contoso.azureedge.net",
    "ttl": 3600,
    "proxied": false
  }'
```

---

## Domain Validation

### Validation Methods

| Method | Downtime | Complexity | Use Case |
|--------|----------|------------|----------|
| **Direct CNAME** | Yes (minutes) | Low | Development, testing |
| **asverify Method** | No | Medium | Production (recommended) |
| **CDN Custom Domain** | Minimal | Low | Production with HTTPS |

### Validation Scripts

#### PowerShell Validation

```powershell
# Validate CNAME record
function Test-CNameRecord {
    param(
        [string]$CustomDomain,
        [string]$ExpectedTarget
    )

    try {
        $cnameRecord = Resolve-DnsName -Name $CustomDomain -Type CNAME -ErrorAction Stop
        if ($cnameRecord.NameHost -eq $ExpectedTarget) {
            Write-Host "✅ CNAME record configured correctly" -ForegroundColor Green
            Write-Host "   $CustomDomain -> $($cnameRecord.NameHost)"
            return $true
        } else {
            Write-Host "❌ CNAME record mismatch" -ForegroundColor Red
            Write-Host "   Expected: $ExpectedTarget"
            Write-Host "   Actual: $($cnameRecord.NameHost)"
            return $false
        }
    }
    catch {
        Write-Host "❌ CNAME record not found: $CustomDomain" -ForegroundColor Red
        return $false
    }
}

# Test custom domain connectivity
function Test-CustomDomainConnectivity {
    param(
        [string]$CustomDomain,
        [string]$TestPath = ""
    )

    $url = "https://$CustomDomain/$TestPath"

    try {
        $response = Invoke-WebRequest -Uri $url -UseBasicParsing -ErrorAction Stop
        Write-Host "✅ Custom domain accessible via HTTPS" -ForegroundColor Green
        Write-Host "   Status Code: $($response.StatusCode)"
        return $true
    }
    catch {
        Write-Host "❌ Custom domain not accessible: $_" -ForegroundColor Red
        return $false
    }
}

# Run validation
Test-CNameRecord -CustomDomain "data.contoso.com" -ExpectedTarget "data-contoso.azureedge.net"
Test-CustomDomainConnectivity -CustomDomain "data.contoso.com" -TestPath "test.txt"
```

#### Python Validation

```python
import dns.resolver
import requests
import sys

def validate_cname(custom_domain: str, expected_target: str) -> bool:
    """Validate CNAME record configuration."""
    try:
        answers = dns.resolver.resolve(custom_domain, 'CNAME')
        actual_target = str(answers[0].target).rstrip('.')

        if actual_target == expected_target.rstrip('.'):
            print(f"✅ CNAME record configured correctly")
            print(f"   {custom_domain} -> {actual_target}")
            return True
        else:
            print(f"❌ CNAME record mismatch")
            print(f"   Expected: {expected_target}")
            print(f"   Actual: {actual_target}")
            return False
    except Exception as e:
        print(f"❌ CNAME record not found: {e}")
        return False

def validate_https(custom_domain: str, test_path: str = "") -> bool:
    """Validate HTTPS accessibility."""
    url = f"https://{custom_domain}/{test_path}"

    try:
        response = requests.get(url, timeout=10)
        print(f"✅ Custom domain accessible via HTTPS")
        print(f"   Status Code: {response.status_code}")
        return response.status_code < 400
    except Exception as e:
        print(f"❌ Custom domain not accessible: {e}")
        return False

# Run validation
if __name__ == "__main__":
    domain = "data.contoso.com"
    target = "data-contoso.azureedge.net"

    cname_valid = validate_cname(domain, target)
    https_valid = validate_https(domain, "test.txt")

    sys.exit(0 if (cname_valid and https_valid) else 1)
```

---

## Advanced Scenarios

### Multi-Environment Configuration

```yaml
# custom-domains.yaml
environments:
  dev:
    storage_account: "stadevdata001"
    custom_domain: "data-dev.contoso.com"
    cdn_endpoint: "data-dev-contoso"
    ssl_certificate: "CDN-managed"

  staging:
    storage_account: "stastagingdata001"
    custom_domain: "data-staging.contoso.com"
    cdn_endpoint: "data-staging-contoso"
    ssl_certificate: "CDN-managed"

  prod:
    storage_account: "stadatalake001"
    custom_domain: "data.contoso.com"
    cdn_endpoint: "data-contoso"
    ssl_certificate: "Custom (Key Vault)"
    geo_redundancy: true
    cdn_rules:
      - cache_duration: "7d"
      - compression: true
      - https_redirect: true
```

### Subdomain Configuration

```bash
# Configure multiple subdomains for different services
# api.data.contoso.com -> API endpoints
# files.data.contoso.com -> File storage
# cdn.data.contoso.com -> CDN content

# Create multiple CDN endpoints
for subdomain in api files cdn; do
  az cdn endpoint create \
    --name ${subdomain}-data-contoso \
    --profile-name cdn-analytics-prod \
    --resource-group rg-analytics-prod \
    --origin stadatalake001.blob.core.windows.net \
    --origin-path "/${subdomain}"

  az cdn custom-domain create \
    --endpoint-name ${subdomain}-data-contoso \
    --hostname ${subdomain}.data.contoso.com \
    --name ${subdomain}-data-contoso-com \
    --profile-name cdn-analytics-prod \
    --resource-group rg-analytics-prod
done
```

---

## Performance Optimization

### CDN Caching Rules

```bash
# Configure caching rules
az cdn endpoint rule add \
  --name data-contoso \
  --profile-name cdn-analytics-prod \
  --resource-group rg-analytics-prod \
  --order 1 \
  --rule-name "CacheStaticContent" \
  --match-variable RequestUri \
  --operator Contains \
  --match-values ".jpg" ".png" ".css" ".js" \
  --action-name CacheExpiration \
  --cache-behavior OverrideAlways \
  --cache-duration "7.00:00:00"

# Configure compression
az cdn endpoint update \
  --name data-contoso \
  --profile-name cdn-analytics-prod \
  --resource-group rg-analytics-prod \
  --enable-compression true \
  --content-types-to-compress \
    "application/json" \
    "application/javascript" \
    "text/css" \
    "text/html" \
    "text/plain"
```

### Performance Metrics

| Metric | Without CDN | With CDN | Improvement |
|--------|-------------|----------|-------------|
| **Global Latency** | 200-500ms | 20-100ms | 60-90% |
| **Cache Hit Rate** | 0% | 70-95% | Significant |
| **Bandwidth Costs** | High | Lower | 30-60% |
| **Origin Load** | 100% | 5-30% | 70-95% |

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| **Domain not resolving** | CNAME not propagated | Wait for DNS propagation (up to 48h) |
| **HTTPS not working** | Certificate not provisioned | Verify CDN custom domain HTTPS status |
| **404 errors** | Incorrect origin path | Check CDN endpoint origin configuration |
| **Certificate mismatch** | Wrong certificate | Verify custom certificate configuration |
| **Slow performance** | No CDN caching | Configure appropriate caching rules |

### Diagnostic Commands

```bash
# Check DNS propagation
nslookup data.contoso.com
dig data.contoso.com CNAME

# Test HTTPS certificate
openssl s_client -connect data.contoso.com:443 -servername data.contoso.com

# Check CDN endpoint status
az cdn endpoint show \
  --name data-contoso \
  --profile-name cdn-analytics-prod \
  --resource-group rg-analytics-prod \
  --query provisioningState

# Purge CDN cache
az cdn endpoint purge \
  --name data-contoso \
  --profile-name cdn-analytics-prod \
  --resource-group rg-analytics-prod \
  --content-paths '/*'
```

---

## Best Practices

### Configuration Checklist

- [ ] Use CDN for production custom domains requiring HTTPS
- [ ] Implement asverify method for zero-downtime validation
- [ ] Configure minimum TLS 1.2 for all HTTPS connections
- [ ] Enable CDN compression for static content
- [ ] Set appropriate caching rules for different content types
- [ ] Monitor CDN metrics and optimize rules
- [ ] Use managed certificates for automatic renewal
- [ ] Configure geo-redundancy for critical workloads
- [ ] Implement proper DNS TTL values
- [ ] Document all custom domain configurations

---

## Related Resources

- [Azure Storage Custom Domains](https://docs.microsoft.com/azure/storage/blobs/storage-custom-domain-name)
- [Azure CDN Documentation](https://docs.microsoft.com/azure/cdn/)
- [Storage Custom Domain with HTTPS](https://docs.microsoft.com/azure/cdn/cdn-custom-ssl)
- [DNS Configuration Best Practices](https://docs.microsoft.com/azure/dns/dns-overview)
- [Storage Geo-Replication](geo-replication.md)

---

> **Note**: Custom domain configurations may take up to 48 hours to fully propagate globally. Always test thoroughly in non-production environments before implementing in production.
