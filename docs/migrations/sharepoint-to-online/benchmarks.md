# SharePoint Migration Benchmarks and Performance

**Status:** Authored 2026-04-30
**Audience:** Migration leads, infrastructure architects, and project managers estimating migration timelines and resource requirements.
**Methodology:** Benchmarks use publicly documented Microsoft guidance, community-reported metrics, and representative workload patterns. Actual throughput varies by network bandwidth, source farm performance, SPO throttling, and content characteristics.

---

## How to read this document

Every benchmark section includes the metric measured, typical values, and factors that influence performance. Use these numbers for planning estimates, not guarantees. Run a pilot migration to establish baseline throughput for your specific environment.

---

## 1. Migration throughput: SPMT vs Migration Manager

### Single-agent throughput

| Metric                                        | SPMT (single workstation)            | Migration Manager (single agent)     |
| --------------------------------------------- | ------------------------------------ | ------------------------------------ |
| **Document migration (small files < 10 MB)**  | 1-2 GB/hour                          | 1-2 GB/hour                          |
| **Document migration (mixed file sizes)**     | 2-5 GB/hour                          | 2-5 GB/hour                          |
| **Document migration (large files > 100 MB)** | 5-10 GB/hour                         | 5-10 GB/hour                         |
| **List item migration**                       | 5,000-10,000 items/hour              | 5,000-10,000 items/hour              |
| **Metadata-heavy content**                    | 1-3 GB/hour                          | 1-3 GB/hour                          |
| **Content with versions (10 versions/file)**  | 0.5-2 GB/hour (current content rate) | 0.5-2 GB/hour (current content rate) |

### Multi-agent throughput (Migration Manager)

| Agents    | Typical throughput | Max observed | Notes                                   |
| --------- | ------------------ | ------------ | --------------------------------------- |
| 1 agent   | 2-5 GB/hour        | 10 GB/hour   | Single workstation, good network        |
| 3 agents  | 6-15 GB/hour       | 25 GB/hour   | Near-linear scaling                     |
| 5 agents  | 10-20 GB/hour      | 40 GB/hour   | SPO throttling may begin                |
| 10 agents | 15-30 GB/hour      | 60 GB/hour   | Diminishing returns from throttling     |
| 20 agents | 20-40 GB/hour      | 80 GB/hour   | Heavy throttling; off-hours recommended |

!!! note "Throughput is not linear with agents"
SPO applies adaptive throttling that reduces per-agent throughput as total tenant migration volume increases. Adding agents beyond 10 provides diminishing returns unless migrations run during off-hours (evenings and weekends).

### Throughput by content type

| Content type                | Throughput factor | Notes                                   |
| --------------------------- | ----------------- | --------------------------------------- |
| Large files (> 100 MB)      | 1.0x (baseline)   | Best throughput per GB                  |
| Medium files (10-100 MB)    | 0.8x              | Good throughput                         |
| Small files (1-10 MB)       | 0.5x              | Per-file overhead reduces throughput    |
| Very small files (< 1 MB)   | 0.2-0.3x          | API call overhead dominates             |
| List items (no attachments) | N/A               | 5,000-10,000 items/hour                 |
| List items with attachments | 0.3x              | Attachment download/upload adds latency |
| Files with 10+ versions     | 0.3-0.5x          | Each version is a separate transfer     |

---

## 2. Migration timeline estimates

### By environment size

| Environment    | Content size  | Sites     | Estimated migration time | Notes                              |
| -------------- | ------------- | --------- | ------------------------ | ---------------------------------- |
| **Small**      | < 500 GB      | < 50      | 1-2 weeks                | Single SPMT workstation sufficient |
| **Medium**     | 500 GB - 5 TB | 50-500    | 4-8 weeks                | 3-5 Migration Manager agents       |
| **Large**      | 5 TB - 50 TB  | 500-5,000 | 8-16 weeks               | 10-20 Migration Manager agents     |
| **Enterprise** | > 50 TB       | > 5,000   | 16-30 weeks              | 20+ agents; FastTrack recommended  |

### Migration window calculation

```
Migration time (hours) = Total content (GB) / Throughput (GB/hour)

Example:
- Total content: 10 TB (10,240 GB)
- Current content (no versions): 6 TB
- Versions: 4 TB
- Agents: 5
- Throughput per agent: 3 GB/hour (mixed content)
- Total throughput: 15 GB/hour
- Migration time: 10,240 / 15 = 683 hours = ~28.5 days continuous

With weekend-only migration windows (48 hours/week):
- 683 / 48 = ~14 weekends = ~14 weeks
```

---

## 3. SharePoint Online performance benchmarks

### Search performance

| Metric                                     | SPO value    | Notes                                   |
| ------------------------------------------ | ------------ | --------------------------------------- |
| Search indexing latency (new content)      | 5-15 minutes | Continuous crawl; varies by tenant load |
| Search indexing latency (modified content) | 5-15 minutes | Near real-time for most changes         |
| Full re-index after migration              | 24-48 hours  | Large tenants may take longer           |
| Search query latency (simple)              | 200-500 ms   | Varies by result count and complexity   |
| Search query latency (complex)             | 500-2,000 ms | Managed property filters, refiners      |
| Maximum results per query                  | 500          | Paging required for larger result sets  |
| Maximum crawled items per tenant           | Unlimited    | No practical limit                      |
| Managed properties per tenant              | 500,000      | Auto-created from site columns          |

### Page performance

| Metric                                  | SPO target            | Notes                                   |
| --------------------------------------- | --------------------- | --------------------------------------- |
| Modern page load time                   | < 3 seconds           | First contentful paint                  |
| Classic page load time                  | 3-8 seconds           | Significantly slower than modern        |
| Document library load time              | < 2 seconds           | For libraries < 5,000 items             |
| Large library load time (> 5,000 items) | 2-5 seconds           | Modern views with automatic indexing    |
| List view threshold                     | 5,000 items (classic) | Modern views handle larger lists better |
| Modern list view performance            | < 3 seconds           | Up to 30,000 items with indexing        |

---

## 4. Storage limits and quotas

### Tenant storage

| Metric                          | Value                           | Notes                                         |
| ------------------------------- | ------------------------------- | --------------------------------------------- |
| Base tenant storage             | 1 TB                            | Included with any M365 plan                   |
| Per-user storage                | 10 GB per licensed user         | Added to tenant pool                          |
| Maximum site collection storage | 25 TB                           | Configurable by admin                         |
| Maximum file size               | 250 GB                          | Per individual file                           |
| Maximum files per library       | 30 million                      | Including all folders                         |
| Maximum items per list          | 30 million                      | Performance degrades above 100K               |
| OneDrive per-user storage       | 1 TB (E3) / 5 TB (E5, 5+ users) | Separate from SPO pool                        |
| Recycle bin retention           | 93 days                         | First-stage: 93 days; second-stage: remaining |
| Version history limit           | 50,000 major versions           | Default is 500; configurable                  |

### Storage calculation for migration planning

```
Required SPO storage = Current content + Versions to migrate + Growth buffer

Example:
- Current content: 10 TB
- Versions (10 per file, avg 20% of current): 2 TB
- 12-month growth buffer (10%): 1.2 TB
- Total required: 13.2 TB

Tenant storage calculation:
- Base: 1 TB
- Per-user (5,000 users x 10 GB): 50 TB
- Total available: 51 TB
- Headroom: 51 - 13.2 = 37.8 TB (sufficient)
```

---

## 5. API throttling thresholds

### SharePoint Online REST API limits

| Limit                           | Value    | Scope              | Notes                               |
| ------------------------------- | -------- | ------------------ | ----------------------------------- |
| Requests per minute (per app)   | 1,200    | Application level  | 429 response when exceeded          |
| Requests per minute (per user)  | 600      | User level         | Applies to delegated permissions    |
| Concurrent requests             | 25       | Per application    | Beyond this, requests are queued    |
| Batch request items             | 20       | Per $batch request | OData $batch maximum                |
| File upload (single request)    | 250 MB   | Per request        | Use chunked upload for larger files |
| Chunked upload session duration | 24 hours | Per upload session | Session expires if not completed    |

### Migration-specific throttling

| Throttling behavior                | Trigger                   | Impact                               | Mitigation                             |
| ---------------------------------- | ------------------------- | ------------------------------------ | -------------------------------------- |
| **HTTP 429 (Too Many Requests)**   | Rate limit exceeded       | Request rejected; retry after header | Implement exponential backoff          |
| **HTTP 503 (Service Unavailable)** | Tenant-level throttle     | All requests blocked temporarily     | Wait and retry; reduce concurrent load |
| **Reduced throughput**             | High migration volume     | Per-agent speed decreases            | Add more agents; use off-hours         |
| **Priority-based throttling**      | User interactive vs batch | Migration requests deprioritized     | Schedule during low-usage periods      |

### Throttling mitigation strategies

```powershell
# Best practices for avoiding throttling during migration:

# 1. Run migrations during off-hours (6 PM - 6 AM, weekends)
# 2. Reduce concurrent agents if 429 errors increase
# 3. Use SPMT/Migration Manager (they handle throttling automatically)
# 4. For custom scripts, implement retry with exponential backoff:

function Invoke-SPOWithRetry {
    param(
        [scriptblock]$ScriptBlock,
        [int]$MaxRetries = 5
    )

    $retryCount = 0
    $delay = 1  # seconds

    while ($retryCount -lt $MaxRetries) {
        try {
            return & $ScriptBlock
        }
        catch {
            if ($_.Exception.Response.StatusCode -eq 429) {
                $retryAfter = $_.Exception.Response.Headers["Retry-After"]
                $waitTime = if ($retryAfter) { [int]$retryAfter } else { $delay }
                Write-Warning "Throttled. Waiting $waitTime seconds (attempt $($retryCount + 1)/$MaxRetries)"
                Start-Sleep -Seconds $waitTime
                $delay = $delay * 2  # Exponential backoff
                $retryCount++
            }
            else {
                throw
            }
        }
    }
    throw "Max retries exceeded"
}
```

---

## 6. Network bandwidth requirements

### Bandwidth planning

| Migration throughput target | Required bandwidth | Notes                             |
| --------------------------- | ------------------ | --------------------------------- |
| 1 GB/hour                   | 3 Mbps sustained   | Minimum for small migrations      |
| 5 GB/hour                   | 15 Mbps sustained  | Single agent, typical             |
| 10 GB/hour                  | 30 Mbps sustained  | Single agent, optimized           |
| 25 GB/hour                  | 75 Mbps sustained  | Multi-agent                       |
| 50 GB/hour                  | 150 Mbps sustained | Multi-agent, dedicated bandwidth  |
| 100 GB/hour                 | 300 Mbps sustained | Large-scale, dedicated connection |

### Network optimization

- **Express Route:** Dedicated Azure connectivity bypasses internet congestion (recommended for > 10 TB migrations)
- **Agent placement:** Co-locate agents near source SharePoint servers to minimize source-side latency
- **WAN optimization:** Disable WAN optimization/proxy inspection for migration traffic to avoid interference
- **DNS resolution:** Ensure agent machines resolve SPO endpoints to nearest Azure data center

---

## 7. Third-party tool benchmarks

### Sharegate

| Metric                | Typical value                 | Notes                                     |
| --------------------- | ----------------------------- | ----------------------------------------- |
| Document throughput   | 3-8 GB/hour per thread        | Depends on file size distribution         |
| Concurrent threads    | Up to 10 per license          | Configurable                              |
| Permission migration  | 1-2x slower than content-only | Granular permission mapping adds overhead |
| Incremental migration | Supported                     | Change detection is efficient             |

### AvePoint

| Metric                   | Typical value             | Notes                          |
| ------------------------ | ------------------------- | ------------------------------ |
| Document throughput      | 2-6 GB/hour per agent     | Enterprise agents              |
| Pre-migration assessment | 1-4 hours per TB          | Depends on metadata complexity |
| Parallel migration       | Up to 20 concurrent tasks | License-dependent              |

!!! note "Third-party benchmarks are vendor-reported"
Throughput numbers for third-party tools are based on vendor documentation and community reports. Actual performance depends on environment, licensing, and configuration.

---

## 8. Performance optimization checklist

- [ ] Run pilot migration to establish baseline throughput
- [ ] Deploy agents near source SharePoint servers
- [ ] Schedule migrations during off-hours (6 PM - 6 AM, weekends)
- [ ] Reduce version count to minimize data volume
- [ ] Exclude large media files (migrate separately)
- [ ] Ensure 100+ Mbps bandwidth per agent
- [ ] Disable WAN optimization for migration traffic
- [ ] Monitor SPO throttling (429 errors) and adjust agent count
- [ ] Use incremental migration for final sync (minimize cutover window)
- [ ] Plan for 24-48 hour search indexing delay after migration

---

## References

- [SPMT performance guidance](https://learn.microsoft.com/sharepointmigration/spmt-performance-guidance)
- [Migration Manager performance](https://learn.microsoft.com/sharepointmigration/mm-performance-guidance)
- [SharePoint Online limits](https://learn.microsoft.com/office365/servicedescriptions/sharepoint-online-service-description/sharepoint-online-limits)
- [SharePoint Online throttling](https://learn.microsoft.com/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online)
- [SharePoint Online API limits](https://learn.microsoft.com/sharepoint/dev/general-development/sharepoint-online-throttling-overview)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
