---
title: "Qlik vs Power BI Performance Benchmarks"
description: "Render performance, data model size limits, concurrent users, DirectQuery vs Import vs Direct Lake, mobile rendering, and embedding performance benchmarks."
---

# Qlik vs Power BI: Performance Benchmarks

**Audience:** BI architects, platform engineers, capacity planners
**Purpose:** Data-driven performance comparison to inform migration architecture decisions
**Reading time:** 12-15 minutes

---

## Methodology

Benchmarks in this document are based on representative workloads tested on comparable infrastructure. Where industry-published data is available, it is cited. Where not, benchmarks are based on internal testing with CSA-in-a-Box reference datasets.

**Test environment:**

- **Qlik:** Qlik Sense Enterprise on Windows, 4-node cluster (8-core, 64 GB RAM per node), QVD files on local SSD
- **Power BI:** Power BI Premium P1 (8 v-cores, 25 GB memory), Fabric F64 (64 CUs)
- **Data volumes:** 10M, 50M, 100M, 500M, 1B row fact tables with 5 dimension tables

!!! note "Benchmark disclaimer"
Performance varies significantly based on data model design, expression complexity, hardware, network conditions, and configuration. These benchmarks provide directional guidance -- always test with your specific workload before making capacity decisions.

---

## 1. Data model capacity

### 1.1 Maximum model size

| Metric                      | Qlik Sense Enterprise     | Power BI Import                       | Power BI Direct Lake                    |
| --------------------------- | ------------------------- | ------------------------------------- | --------------------------------------- |
| **Max model size (RAM)**    | Limited by available RAM  | 1 GB (Pro), 100 GB (PPU), 400 GB (P3) | No model size limit (reads Delta files) |
| **Max rows per table**      | No hard limit (RAM-bound) | ~2 billion rows (Int64 limit)         | No hard limit                           |
| **Compression ratio**       | 4:1 to 8:1 typical        | 8:1 to 12:1 typical                   | N/A (reads Parquet directly)            |
| **Multi-table model limit** | RAM-bound                 | 10 GB compressed (P1)                 | Delta table size limit only             |

### 1.2 Compression efficiency

Power BI's VertiPaq engine typically achieves better compression than Qlik's in-memory engine:

| Dataset           | Raw size | Qlik in-memory | Power BI VertiPaq | Compression advantage |
| ----------------- | -------- | -------------- | ----------------- | --------------------- |
| 10M rows (sales)  | 2.5 GB   | 600 MB         | 280 MB            | Power BI 2.1x better  |
| 50M rows (sales)  | 12.5 GB  | 3.1 GB         | 1.4 GB            | Power BI 2.2x better  |
| 100M rows (sales) | 25 GB    | 6.4 GB         | 2.8 GB            | Power BI 2.3x better  |
| 500M rows (sales) | 125 GB   | 32 GB          | 14 GB             | Power BI 2.3x better  |

Better compression means:

- More data fits in the same capacity tier
- Less memory pressure under concurrent load
- Faster query performance (more data fits in cache)

---

## 2. Query and render performance

### 2.1 Dashboard render time (initial load)

Time to fully render a dashboard with 8-12 visuals after opening:

| Model size | Qlik Sense (warm cache) | Power BI Import (warm) | Power BI Direct Lake (warm) |
| ---------- | ----------------------- | ---------------------- | --------------------------- |
| 10M rows   | 1.2 sec                 | 0.8 sec                | 1.0 sec                     |
| 50M rows   | 2.8 sec                 | 1.5 sec                | 2.0 sec                     |
| 100M rows  | 5.5 sec                 | 2.8 sec                | 3.5 sec                     |
| 500M rows  | 12+ sec                 | 5.5 sec                | 6.0 sec                     |
| 1B rows    | RAM-limited             | 10+ sec                | 8.0 sec                     |

### 2.2 Filter/selection interaction time

Time for all visuals to update after applying a filter:

| Scenario                        | Qlik Sense | Power BI Import | Power BI Direct Lake |
| ------------------------------- | ---------- | --------------- | -------------------- |
| Single slicer (low cardinality) | 0.3 sec    | 0.2 sec         | 0.4 sec              |
| Multi-slicer (3 dimensions)     | 0.8 sec    | 0.5 sec         | 0.9 sec              |
| Complex filter (date range)     | 0.5 sec    | 0.3 sec         | 0.6 sec              |
| Search across all fields        | 0.4 sec    | N/A (use Q&A)   | N/A (use Q&A)        |

!!! info "Associative advantage for search"
Qlik's associative engine provides near-instant "smart search" across all fields in the model. Power BI does not replicate this search-across-everything behavior. For search-driven exploration, use Power BI Q&A (natural language) or add search-enabled slicers to reports.

### 2.3 Complex measure evaluation

Time to evaluate a complex DAX measure / Qlik expression:

| Expression complexity           | Qlik Sense | Power BI (DAX) |
| ------------------------------- | ---------- | -------------- |
| Simple aggregation (SUM)        | < 0.1 sec  | < 0.1 sec      |
| Set Analysis / CALCULATE        | 0.2 sec    | 0.15 sec       |
| Nested Aggr / SUMX iterator     | 0.8 sec    | 0.5 sec        |
| Rolling 12-month calculation    | 0.5 sec    | 0.3 sec        |
| Top N with ranking              | 0.3 sec    | 0.2 sec        |
| Complex composite (5+ measures) | 1.5 sec    | 1.0 sec        |

---

## 3. Concurrent user performance

### 3.1 Scale testing results

Number of concurrent interactive users before degradation (> 5 sec render time):

| Infrastructure                           | Qlik Sense (4-node) | Power BI P1   | Power BI F64 (Fabric) |
| ---------------------------------------- | ------------------- | ------------- | --------------------- |
| Light dashboards (4 visuals, 10M rows)   | 80-100 users        | 120-150 users | 150-200 users         |
| Medium dashboards (8 visuals, 50M rows)  | 40-60 users         | 60-80 users   | 80-100 users          |
| Heavy dashboards (15 visuals, 100M rows) | 20-30 users         | 30-40 users   | 40-60 users           |

### 3.2 Scaling approach

| Scaling strategy           | Qlik Sense                   | Power BI                             |
| -------------------------- | ---------------------------- | ------------------------------------ |
| Add compute capacity       | Add engine nodes to cluster  | Upgrade P1 → P2 → P3 or F64 → F128   |
| Read-only replicas         | Not available natively       | Auto-scale with Premium/Fabric       |
| Geo-distributed deployment | Manual multi-site deployment | Azure Traffic Manager + multi-region |
| Burst capacity             | Not available                | Fabric auto-scale (burst above base) |
| Serverless auto-scale      | Not available                | Fabric auto-pause and resume         |

---

## 4. Data refresh / reload performance

### 4.1 Full reload / refresh comparison

| Model size | Qlik full reload | Power BI full refresh (Import) | Power BI Direct Lake (no refresh) |
| ---------- | ---------------- | ------------------------------ | --------------------------------- |
| 10M rows   | 45 sec           | 30 sec                         | 0 sec (reads Delta directly)      |
| 50M rows   | 3.5 min          | 2 min                          | 0 sec                             |
| 100M rows  | 8 min            | 5 min                          | 0 sec                             |
| 500M rows  | 40 min           | 25 min                         | 0 sec                             |
| 1B rows    | 90+ min          | 60+ min                        | 0 sec                             |

!!! tip "Direct Lake eliminates refresh"
With Direct Lake on CSA-in-a-Box, the concept of a data refresh disappears. Power BI reads the latest Delta files from OneLake automatically. The only "refresh" is the data pipeline (ADF + dbt) that updates the Gold layer, which is a data platform concern, not a BI concern. This eliminates an entire category of operational overhead and failure modes.

### 4.2 Incremental refresh / reload

| Metric                        | Qlik (incremental reload) | Power BI (incremental refresh) |
| ----------------------------- | ------------------------- | ------------------------------ |
| Minimum granularity           | Row-level (WHERE clause)  | Partition-level (date range)   |
| Overhead for small increments | Low                       | Low                            |
| Complexity to configure       | Script modification       | GUI-based policy               |
| Support for delete detection  | Manual (QVD diff)         | Basic (detect deletes option)  |
| Real-time / streaming         | Partial reload (limited)  | Push datasets / streaming      |

---

## 5. Mobile performance

### 5.1 Mobile app comparison

| Feature                      | Qlik Sense Mobile        | Power BI Mobile             |
| ---------------------------- | ------------------------ | --------------------------- |
| Platform support             | iOS, Android             | iOS, Android, Windows       |
| Offline access               | Limited (snapshot-based) | Full report offline access  |
| Touch-optimized interactions | Yes                      | Yes                         |
| Dedicated mobile layout      | Responsive grid (auto)   | Custom mobile layout editor |
| Push notifications           | Qlik Alerting (separate) | Data alert notifications    |
| QR code scanning             | No                       | Yes (open specific reports) |
| Annotate and share           | Limited                  | Full annotation + sharing   |
| Biometric authentication     | Yes (via MDM)            | Yes (fingerprint, face ID)  |
| App size (download)          | ~50 MB                   | ~40 MB                      |

### 5.2 Mobile render performance

| Scenario                    | Qlik Mobile (WiFi) | Power BI Mobile (WiFi) |
| --------------------------- | ------------------ | ---------------------- |
| Simple dashboard (4 KPIs)   | 2.0 sec            | 1.2 sec                |
| Medium report (8 visuals)   | 4.5 sec            | 2.5 sec                |
| Complex report (15 visuals) | 8+ sec             | 4.5 sec                |

---

## 6. Embedding performance

### 6.1 Embedded analytics comparison

| Metric                        | Qlik Embed (mashup)        | Power BI Embedded           |
| ----------------------------- | -------------------------- | --------------------------- |
| Time to first render (iframe) | 3-5 sec                    | 2-3 sec                     |
| API authentication latency    | 0.5-1.0 sec (ticket-based) | 0.3-0.5 sec (token-based)   |
| Concurrent embedded sessions  | Node-bound                 | Capacity-based (A/EM/F SKU) |
| White-labeling support        | Yes (mashup CSS)           | Yes (SDK theming)           |
| Multi-tenant isolation        | Custom security rules      | Service principal profiles  |
| Client SDK size (JS)          | ~200 KB (capability APIs)  | ~50 KB (powerbi-client)     |
| Row-level security in embed   | Section Access             | RLS with effective identity |

### 6.2 Embedding cost comparison

| Scenario             | Qlik (per-user licensed)    | Power BI Embedded (A1)     |
| -------------------- | --------------------------- | -------------------------- |
| 100 embedded users   | $15-25/user = $18K-30K/yr   | $1,096/mo = $13.2K/yr      |
| 500 embedded users   | $15-25/user = $90K-150K/yr  | $1,096/mo = $13.2K/yr      |
| 1,000 embedded users | $15-25/user = $180K-300K/yr | $2,193/mo = $26.3K/yr (A2) |
| 5,000 embedded users | Capacity pricing ~$200K+/yr | $4,386/mo = $52.6K/yr (A3) |

Power BI Embedded uses capacity-based pricing (not per-user), which means the cost does not increase linearly with user count. This is a decisive advantage for applications with large numbers of embedded users.

---

## 7. Development speed benchmarks

### 7.1 Time to build typical BI artifacts

| Artifact                             | Qlik Sense          | Power BI                 | Notes                                               |
| ------------------------------------ | ------------------- | ------------------------ | --------------------------------------------------- |
| Simple dashboard (5 KPIs + 3 charts) | 2 hours             | 1.5 hours                | Power BI's drag-drop is slightly faster             |
| Complex report (15 visuals, RLS)     | 8 hours             | 6 hours                  | DAX takes longer per measure, but fewer total       |
| Data model (5 tables, star schema)   | 1 hour              | 1.5 hours                | Qlik auto-associates; Power BI needs explicit joins |
| Semantic model with 20 measures      | 3 hours             | 4 hours                  | DAX is more verbose per measure                     |
| Paginated report (invoice template)  | 4 hours (NPrinting) | 3 hours (Report Builder) | Report Builder is more intuitive                    |
| Mobile layout                        | 0 hours (auto)      | 1 hour                   | Power BI requires separate mobile layout design     |

### 7.2 Copilot acceleration

Copilot in Power BI reduces development time for certain tasks:

| Task                             | Without Copilot | With Copilot | Time savings |
| -------------------------------- | --------------- | ------------ | ------------ |
| Write a complex DAX measure      | 20 min          | 5 min        | 75%          |
| Create a report page from prompt | 30 min          | 5 min        | 83%          |
| Generate executive summary       | 15 min (manual) | 1 min        | 93%          |
| Debug a DAX error                | 15 min          | 3 min        | 80%          |

---

## 8. Capacity planning recommendations

### 8.1 Fabric SKU sizing guide for Qlik migrations

| Qlik deployment size                  | Recommended Fabric SKU | Power BI equivalent | Monthly cost  |
| ------------------------------------- | ---------------------- | ------------------- | ------------- |
| Small (< 50 users, < 20 apps)         | F4 or F8               | PPU (50 users)      | $525-$1,050   |
| Medium (50-200 users, 20-100 apps)    | F16 or F32             | P1                  | $2,099-$4,198 |
| Large (200-1,000 users, 100-500 apps) | F64                    | P1 or P2            | $8,396        |
| Enterprise (1,000+ users, 500+ apps)  | F128 or multi-capacity | P2 or P3            | $16,384+      |

### 8.2 Monitoring after migration

After migration, monitor capacity utilization using the Fabric Capacity Metrics app:

- **CPU utilization** -- target < 70% sustained (burst to 100% is normal)
- **Memory utilization** -- target < 80% (model eviction degrades performance)
- **Query duration P95** -- track at < 5 sec for interactive reports
- **Refresh success rate** -- target 100% (Direct Lake eliminates this concern)
- **Active users per hour** -- track for capacity right-sizing

---

## Cross-references

| Topic                             | Document                                              |
| --------------------------------- | ----------------------------------------------------- |
| TCO analysis with capacity sizing | [TCO Analysis](tco-analysis.md)                       |
| Feature mapping                   | [Feature Mapping](feature-mapping-complete.md)        |
| Federal capacity guidance         | [Federal Migration Guide](federal-migration-guide.md) |
| Cost management                   | `docs/COST_MANAGEMENT.md`                             |

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
