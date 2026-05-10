# Azure Storage Troubleshooting Guide

![Status](https://img.shields.io/badge/Status-Active-brightgreen) ![Service](https://img.shields.io/badge/Service-Storage-lightblue)

Troubleshooting guide for Azure Storage including Blob Storage, Data Lake Storage Gen2, File Storage, and Queue Storage.

## Storage Services

| Service | Use Case | Common Issues |
|:--------|:---------|:--------------|
| **Blob Storage** | Object storage | Access denied, throttling, slow uploads |
| **Data Lake Gen2** | Analytics workloads | ACL issues, hierarchical namespace |
| **File Storage** | File shares | SMB connectivity, performance |
| **Queue Storage** | Messaging | Message processing, visibility timeout |
| **Table Storage** | NoSQL key-value | Partition design, query performance |

## Common Issues

### Access and Authentication

**Symptoms:**
- 403 Forbidden errors
- Authentication failures
- SAS token expired

**Resolution:**

```python
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient

def test_storage_access(account_name, container_name):
    """Test storage account access."""

    try:
        # Using Azure AD authentication
        account_url = f"https://{account_name}.blob.core.windows.net"
        credential = DefaultAzureCredential()

        blob_service_client = BlobServiceClient(account_url, credential=credential)
        container_client = blob_service_client.get_container_client(container_name)

        # Test access by listing blobs
        blobs = list(container_client.list_blobs(max_results=5))
        print(f"✅ Access successful. Found {len(blobs)} blobs.")
        return True

    except Exception as e:
        print(f"❌ Access failed: {e}")
        return False
```

### Performance and Throttling

**Symptoms:**
- 503 Server Busy errors
- Slow read/write operations
- Request timeouts

**Check Storage Metrics:**

```bash
# Get storage metrics
az monitor metrics list \
    --resource <storage-account-id> \
    --metric "Transactions" "Availability" "SuccessE2ELatency" \
    --aggregation Average Total \
    --interval PT1H

# Check for throttling
az monitor metrics list \
    --resource <storage-account-id> \
    --metric "Transactions" \
    --filter "ResponseType eq 'ClientThrottlingError' or ResponseType eq 'ServerBusyError'" \
    --aggregation Total
```

### Data Lake Gen2 Specific Issues

**ACL Permissions:**

```python
from azure.storage.filedatalake import DataLakeServiceClient

def check_acl_permissions(account_name, file_system, path):
    """Check ACL permissions on path."""

    service_client = DataLakeServiceClient(
        account_url=f"https://{account_name}.dfs.core.windows.net",
        credential=DefaultAzureCredential()
    )

    file_system_client = service_client.get_file_system_client(file_system)
    directory_client = file_system_client.get_directory_client(path)

    # Get ACL
    acl = directory_client.get_access_control()

    print(f"📋 ACL for {path}:")
    print(f"   Owner: {acl['owner']}")
    print(f"   Group: {acl['group']}")
    print(f"   Permissions: {acl['permissions']}")
    print(f"   ACL: {acl['acl']}")

    return acl
```

## Diagnostic Tools

### Storage Analytics

```kusto
// Query storage logs
StorageBlobLogs
| where TimeGenerated > ago(1h)
| where StatusCode >= 400
| summarize ErrorCount = count() by StatusCode, OperationName, AccountName
| order by ErrorCount desc
```

### Network Diagnostics

```bash
# Test connectivity
Test-NetConnection -ComputerName <storage-account>.blob.core.windows.net -Port 443

# Check DNS resolution
Resolve-DnsName <storage-account>.blob.core.windows.net
```

## Best Practices

### Optimize Performance

1. **Use appropriate redundancy** - LRS, ZRS, GRS, RA-GRS
2. **Enable caching** - Use Azure CDN or local caching
3. **Implement retry logic** - Handle transient failures
4. **Optimize blob size** - 4MB blocks for best performance
5. **Use hot/cool/archive tiers** - Match access patterns

### Security

1. **Use Azure AD authentication** - Avoid shared keys
2. **Implement private endpoints** - Secure network access
3. **Enable encryption** - At rest and in transit
4. **Use SAS tokens with minimal permissions** - Time-limited access
5. **Enable logging and monitoring** - Track access patterns

## Related Resources

| Resource | Link |
|----------|------|
| **Storage Documentation** | [Microsoft Docs](https://docs.microsoft.com/azure/storage/) |
| **Performance Guide** | [Best Practices](https://docs.microsoft.com/azure/storage/blobs/storage-performance-checklist) |
| **Security Baseline** | [Security Guide](https://docs.microsoft.com/azure/storage/common/security-baseline) |

---

**Last Updated:** 2025-12-10
**Version:** 1.0.0
