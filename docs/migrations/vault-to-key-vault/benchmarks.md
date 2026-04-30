# Benchmarks -- HashiCorp Vault vs Azure Key Vault

**Status:** Authored 2026-04-30
**Audience:** Platform Engineers, Security Architects, DevOps Teams
**Purpose:** Performance and operational benchmarks comparing HashiCorp Vault and Azure Key Vault

---

## Overview

This document provides benchmark data comparing HashiCorp Vault (OSS and Enterprise) against Azure Key Vault (Standard, Premium, and Managed HSM) across secret operations, cryptographic throughput, certificate management, scalability, availability, migration performance, operational overhead, and cost-performance ratio. Data is sourced from vendor documentation, published SLAs, and publicly available performance testing.

!!! note "Benchmark methodology"
Performance benchmarks are derived from vendor-published specifications, controlled lab testing, and publicly reported metrics. Actual performance varies by network topology, tenant configuration, hardware provisioning (Vault), Key Vault tier selection, and concurrent load. Organizations should validate benchmarks in their own environments during the migration pilot phase.

---

## 1. Secret operations performance

### Read and write latency

| Metric                      | Vault OSS | Vault Enterprise | Key Vault Standard | Key Vault Premium | Key Vault Managed HSM |
| --------------------------- | --------- | ---------------- | ------------------ | ----------------- | --------------------- |
| **Secret read (single)**    | 1-5 ms    | 1-3 ms           | 5-15 ms            | 5-15 ms           | 3-10 ms               |
| **Secret write (single)**   | 2-8 ms    | 2-5 ms           | 10-30 ms           | 10-30 ms          | 5-15 ms               |
| **Secret list (100 items)** | 5-15 ms   | 3-10 ms          | 20-60 ms           | 20-60 ms          | 15-40 ms              |
| **Secret version read**     | 2-6 ms    | 1-4 ms           | 5-15 ms            | 5-15 ms           | 3-10 ms               |

!!! tip "Latency context"
Vault latency figures assume co-located clients on the same network as the Vault cluster. Key Vault latency includes network round-trip to the Azure regional endpoint. For applications running in Azure, Key Vault latency is typically 5-15 ms via private endpoint, which is well within acceptable thresholds for secrets retrieval at application startup.

### Throughput for secret retrieval

| Metric                        | Vault OSS (3-node) | Vault Enterprise (5-node) | Key Vault Standard   | Key Vault Premium    | Key Vault Managed HSM |
| ----------------------------- | ------------------ | ------------------------- | -------------------- | -------------------- | --------------------- |
| **Reads/second (sustained)**  | 2,000-5,000        | 5,000-15,000              | 4,000 (per vault)    | 4,000 (per vault)    | 5,000 (per HSM pool)  |
| **Writes/second (sustained)** | 500-1,500          | 1,500-5,000               | 4,000 (per vault)    | 4,000 (per vault)    | 5,000 (per HSM pool)  |
| **Burst capacity**            | CPU/memory bound   | CPU/memory bound          | Auto-scaled by Azure | Auto-scaled by Azure | Auto-scaled by Azure  |

### Bulk operations

| Metric                           | Vault OSS                 | Vault Enterprise          | Key Vault                                                    |
| -------------------------------- | ------------------------- | ------------------------- | ------------------------------------------------------------ |
| **Batch secret read**            | Custom scripting required | Custom scripting required | REST API supports individual calls; no native batch endpoint |
| **Bulk import (1,000 secrets)**  | 2-5 minutes (API loop)    | 1-3 minutes (API loop)    | 3-8 minutes (API loop with throttle backoff)                 |
| **Bulk import (10,000 secrets)** | 15-30 minutes             | 10-20 minutes             | 25-45 minutes (with rate limit management)                   |
| **Bulk export**                  | API + `jq` scripting      | API + `jq` scripting      | No native export; API-based extraction required              |

---

## 2. Cryptographic operations

### Encryption and decryption throughput

| Metric                      | Vault Transit (OSS) | Vault Transit (Enterprise) | Key Vault Keys (Software)  | Key Vault Keys (HSM) | Managed HSM          |
| --------------------------- | ------------------- | -------------------------- | -------------------------- | -------------------- | -------------------- |
| **AES-256-GCM encrypt/sec** | 5,000-10,000        | 10,000-25,000              | N/A (RSA/EC only for keys) | N/A                  | 5,000-10,000         |
| **RSA-2048 encrypt/sec**    | 1,000-3,000         | 2,000-6,000                | 2,000 (per vault)          | 2,000 (per vault)    | 3,000 (per HSM pool) |
| **RSA-4096 encrypt/sec**    | 300-800             | 600-1,500                  | 2,000 (per vault)          | 2,000 (per vault)    | 3,000 (per HSM pool) |
| **EC-P256 sign/sec**        | 2,000-5,000         | 4,000-10,000               | 2,000 (per vault)          | 2,000 (per vault)    | 3,000 (per HSM pool) |

!!! note "AES symmetric encryption"
Vault Transit supports server-side AES symmetric encryption. Key Vault keys are asymmetric (RSA/EC) unless using Managed HSM, which supports AES key operations. For envelope encryption patterns, Key Vault wraps a data encryption key (DEK) with an asymmetric key -- the symmetric encryption happens client-side.

### Signing operations

| Metric            | Vault Transit   | Key Vault Keys (Software) | Key Vault Keys (HSM) | Managed HSM |
| ----------------- | --------------- | ------------------------- | -------------------- | ----------- |
| **RSA-2048 sign** | 1,000-2,500/sec | 2,000/sec                 | 2,000/sec            | 3,000/sec   |
| **RSA-4096 sign** | 200-600/sec     | 2,000/sec                 | 2,000/sec            | 3,000/sec   |
| **EC-P256 sign**  | 2,000-5,000/sec | 2,000/sec                 | 2,000/sec            | 3,000/sec   |
| **EC-P384 sign**  | 1,500-3,500/sec | 2,000/sec                 | 2,000/sec            | 3,000/sec   |

### Key generation

| Metric                  | Vault Transit | Key Vault Standard    | Key Vault Premium | Managed HSM  |
| ----------------------- | ------------- | --------------------- | ----------------- | ------------ |
| **RSA-2048 generation** | 50-200 ms     | 200-500 ms            | 200-500 ms        | 100-300 ms   |
| **RSA-4096 generation** | 200-1,000 ms  | 500-2,000 ms          | 500-2,000 ms      | 300-1,000 ms |
| **EC-P256 generation**  | 10-50 ms      | 50-200 ms             | 50-200 ms         | 30-100 ms    |
| **AES-256 generation**  | 5-20 ms       | N/A (asymmetric only) | N/A               | 10-50 ms     |

---

## 3. Certificate operations

### Issuance throughput

| Metric                        | Vault PKI Engine          | Key Vault Certificates                            |
| ----------------------------- | ------------------------- | ------------------------------------------------- |
| **Self-signed cert issuance** | 500-2,000/sec             | 10-20/sec (throttled)                             |
| **CA-signed cert issuance**   | 100-500/sec (internal CA) | Dependent on CA integration (DigiCert/GlobalSign) |
| **Wildcard cert issuance**    | Same as standard          | Same as standard                                  |
| **ACME protocol support**     | Not native                | Supported (Let's Encrypt integration)             |

### Renewal and lifecycle

| Metric                      | Vault PKI Engine             | Key Vault Certificates                                    |
| --------------------------- | ---------------------------- | --------------------------------------------------------- |
| **Auto-renewal trigger**    | Manual or custom automation  | Built-in auto-renewal at configurable lifetime percentage |
| **Renewal processing time** | 50-200 ms (internal CA)      | 1-5 minutes (including CA communication)                  |
| **CRL generation**          | 100-500 ms (per 1,000 certs) | Managed by integrated CA                                  |
| **OCSP response time**      | 5-20 ms (self-hosted)        | Managed by integrated CA                                  |
| **Certificate import**      | API-based                    | API or portal; supports PFX and PEM                       |

!!! tip "Certificate management trade-off"
Vault PKI excels at high-volume, short-lived certificate issuance (service mesh, mTLS). Key Vault certificates focus on lifecycle management with CA integration. For Kubernetes service mesh scenarios, consider cert-manager with Key Vault integration rather than direct replacement of Vault PKI high-throughput issuance.

---

## 4. Scalability

### Concurrent client support

| Metric                       | Vault OSS (3-node)        | Vault Enterprise (5-node) | Key Vault                                          |
| ---------------------------- | ------------------------- | ------------------------- | -------------------------------------------------- |
| **Concurrent connections**   | 500-2,000                 | 2,000-10,000              | No published limit (auto-scaled)                   |
| **Concurrent TLS sessions**  | Bounded by node resources | Bounded by node resources | Managed by Azure infrastructure                    |
| **Max secrets per instance** | Unlimited (storage bound) | Unlimited (storage bound) | 300 access policy entries; unlimited secrets count |

### Operations per second at scale

| Scale tier                      | Vault OSS                | Vault Enterprise                        | Key Vault (per vault)                          |
| ------------------------------- | ------------------------ | --------------------------------------- | ---------------------------------------------- |
| **Low (< 100 ops/sec)**         | Single node sufficient   | Single node sufficient                  | Standard tier                                  |
| **Medium (100-1,000 ops/sec)**  | 3-node cluster           | 3-node cluster                          | Standard or Premium tier                       |
| **High (1,000-4,000 ops/sec)**  | 5-node cluster, tuned    | 5-node cluster, performance replication | Single vault (at throttle limit)               |
| **Very high (> 4,000 ops/sec)** | Custom sharding required | Performance replication standby nodes   | Multiple vaults with application-level routing |

### Auto-scaling behavior

| Metric                     | Vault                                         | Key Vault                                                |
| -------------------------- | --------------------------------------------- | -------------------------------------------------------- |
| **Horizontal scaling**     | Manual node addition, Consul cluster resizing | Automatic (Azure-managed)                                |
| **Scale-up time**          | 30-60 minutes (provision, join, unseal)       | Transparent (no user action)                             |
| **Scale-down**             | Manual node removal with drain                | Automatic                                                |
| **Geographic replication** | Enterprise only (performance/DR replication)  | Geo-replication (Premium tier), multi-region Managed HSM |

---

## 5. Availability and recovery

### Failover times

| Metric                         | Vault OSS                              | Vault Enterprise                | Key Vault                                         |
| ------------------------------ | -------------------------------------- | ------------------------------- | ------------------------------------------------- |
| **Leader election (failover)** | 10-30 seconds                          | 10-30 seconds                   | N/A (no leader concept; fully managed)            |
| **Cross-region failover**      | Not supported                          | 30-120 seconds (DR replication) | Automatic (geo-redundant; typically < 10 seconds) |
| **Unseal after restart**       | Manual (unless auto-unseal configured) | Auto-unseal with HSM/cloud KMS  | N/A (no seal/unseal concept)                      |
| **Published SLA**              | None (self-managed)                    | None (self-managed)             | 99.99%                                            |

### Backup and restore

| Metric                            | Vault                            | Key Vault                                                                     |
| --------------------------------- | -------------------------------- | ----------------------------------------------------------------------------- |
| **Backup method**                 | Raft snapshot or Consul snapshot | Per-secret/key/certificate backup via API; or full vault backup (Managed HSM) |
| **Backup frequency**              | Custom (typically hourly/daily)  | On-demand or automated via scripting                                          |
| **Restore time (100 secrets)**    | 1-5 minutes                      | 1-5 minutes                                                                   |
| **Restore time (10,000 secrets)** | 10-30 minutes                    | 15-45 minutes                                                                 |
| **Point-in-time recovery**        | Raft snapshot restore            | Soft-delete recovery (per secret, 7-90 day retention)                         |

### Disaster recovery RTO/RPO

| Metric              | Vault OSS                         | Vault Enterprise            | Key Vault (Premium/Managed HSM)  |
| ------------------- | --------------------------------- | --------------------------- | -------------------------------- |
| **RPO**             | Last snapshot interval            | Near-zero (DR replication)  | Near-zero (geo-replication)      |
| **RTO**             | 30-120 minutes (restore + unseal) | 5-30 minutes (DR promotion) | < 5 minutes (automatic failover) |
| **Cross-region DR** | Manual restore from snapshot      | Automated DR replication    | Built-in geo-redundancy          |

---

## 6. Migration performance

### Secret migration throughput

| Migration scenario                | Estimated throughput   | Notes                                                            |
| --------------------------------- | ---------------------- | ---------------------------------------------------------------- |
| **KV secrets (simple key-value)** | 100-300 secrets/minute | Vault API export + Key Vault API import with throttle management |
| **KV secrets with versions**      | 50-150 secrets/minute  | Each version migrated as a separate Key Vault secret version     |
| **Secrets with metadata/tags**    | 80-200 secrets/minute  | Tags and content types mapped during import                      |
| **10,000 secret migration**       | 1-3 hours              | Including validation and verification passes                     |
| **50,000 secret migration**       | 4-12 hours             | Parallelized across multiple Key Vault instances                 |

### PKI migration timelines

| Migration step                    | Estimated duration           | Notes                                                          |
| --------------------------------- | ---------------------------- | -------------------------------------------------------------- |
| **Root CA export and import**     | 30-60 minutes                | Manual process with chain validation                           |
| **Intermediate CA migration**     | 1-2 hours per CA             | Includes chain rebuilding and trust validation                 |
| **Certificate policy recreation** | 2-4 hours                    | Policy mapping from Vault roles to Key Vault issuance policies |
| **Issued certificate inventory**  | 1-4 hours (per 10,000 certs) | Export, catalog, and plan renewal timing                       |
| **Full PKI cutover**              | 2-4 weeks                    | Overlapping validity periods for zero-downtime transition      |

### Policy conversion rates

| Policy migration task              | Estimated rate      | Notes                                                 |
| ---------------------------------- | ------------------- | ----------------------------------------------------- |
| **Simple path policies**           | 20-40 policies/hour | Direct mapping to Azure RBAC role assignments         |
| **Complex glob path policies**     | 5-15 policies/hour  | Requires decomposition into multiple RBAC assignments |
| **Sentinel policies (Enterprise)** | 3-8 policies/hour   | Conversion to Azure Policy definitions                |
| **Namespace-scoped policies**      | 10-20 policies/hour | Mapping to per-vault RBAC structure                   |

---

## 7. Operational overhead

### Infrastructure management

| Task                                   | Vault (self-managed)                          | Key Vault (fully managed)             |
| -------------------------------------- | --------------------------------------------- | ------------------------------------- |
| **Initial cluster deployment**         | 4-8 hours (3-5 nodes + Consul + TLS + unseal) | 5-15 minutes (Bicep/Terraform + RBAC) |
| **OS patching (per cycle)**            | 2-4 hours (rolling restart, unseal)           | 0 hours (managed by Azure)            |
| **Vault software upgrades**            | 2-6 hours (rolling upgrade, test, unseal)     | 0 hours (managed by Azure)            |
| **Consul backend maintenance**         | 1-3 hours/month                               | N/A (no backend infrastructure)       |
| **HSM appliance maintenance**          | 2-4 hours/quarter                             | N/A (HSM managed by Azure)            |
| **TLS certificate rotation (cluster)** | 1-2 hours/quarter                             | N/A (managed TLS)                     |
| **Capacity planning**                  | Ongoing (CPU, memory, storage monitoring)     | N/A (auto-scaled)                     |

### Monitoring setup time

| Task                        | Vault                                  | Key Vault                                                  |
| --------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| **Audit log configuration** | 1-2 hours (syslog/file/socket backend) | 15 minutes (diagnostic settings to Log Analytics)          |
| **Alerting rules**          | 2-4 hours (custom Prometheus/Grafana)  | 30-60 minutes (Azure Monitor alert rules)                  |
| **Dashboard creation**      | 2-4 hours (Grafana dashboards)         | 30-60 minutes (Azure Workbooks or portal dashboards)       |
| **Compliance reporting**    | Custom development required            | Built-in (Azure Policy compliance, Defender for Key Vault) |

!!! tip "Operational savings"
Organizations typically report 60-80% reduction in secrets management operational overhead after migrating from self-managed Vault to Key Vault. The primary savings come from eliminating cluster operations, Consul management, unseal procedures, and HSM appliance maintenance.

---

## 8. Cost-performance ratio

### Cost per million operations

| Tier                   | Monthly base cost                                 | Cost per 1M secret operations      | Cost per 1M key operations         | Notes                                          |
| ---------------------- | ------------------------------------------------- | ---------------------------------- | ---------------------------------- | ---------------------------------------------- |
| **Vault OSS**          | $0 (software) + $500-1,500/month (infrastructure) | Infrastructure-amortized           | Infrastructure-amortized           | 3-node cluster on D4s_v5 VMs with Consul       |
| **Vault Enterprise**   | $25,000-75,000/year (license) + infrastructure    | License + infrastructure amortized | License + infrastructure amortized | Per-node licensing; price varies by contract   |
| **Key Vault Standard** | $0 (no base cost)                                 | $3.00                              | $3.00                              | Pure pay-per-use                               |
| **Key Vault Premium**  | $1.00/key/month (HSM keys)                        | $3.00                              | $15.00 (HSM operations)            | HSM-backed keys have higher per-operation cost |
| **Managed HSM**        | ~$2,300/month (per HSM pool)                      | Included                           | Included (up to throughput limits) | Flat rate; cost-effective at high volume       |

### Infrastructure cost comparison (annual)

| Component                          | Vault Enterprise (typical)    | Key Vault Premium (typical)    |
| ---------------------------------- | ----------------------------- | ------------------------------ |
| **Compute (cluster nodes)**        | $18,000-36,000 (3-5 VMs)      | $0                             |
| **Consul cluster**                 | $7,000-14,000 (3 VMs)         | $0                             |
| **HSM appliance (if required)**    | $15,000-40,000 (annual lease) | $0 (built-in HSM)              |
| **Software license**               | $25,000-75,000                | $0                             |
| **Operations staff (partial FTE)** | $30,000-60,000 (0.25-0.5 FTE) | $5,000-10,000 (minimal ops)    |
| **Monitoring infrastructure**      | $3,000-8,000                  | $0 (included in Azure Monitor) |
| **Total estimated annual cost**    | **$98,000-233,000**           | **$5,000-30,000**              |

!!! note "Cost assumptions"
Vault Enterprise costs assume a mid-size deployment (3-5 nodes, 10,000-50,000 secrets, moderate transaction volume). Key Vault costs assume Premium tier with HSM-backed keys and moderate operation volume (1-5 million operations/month). Actual costs vary significantly by scale, contract terms, and organizational requirements.

---

## 9. Summary comparison

| Category                         | Vault OSS            | Vault Enterprise     | Key Vault Standard | Key Vault Premium | Key Vault Managed HSM     |
| -------------------------------- | -------------------- | -------------------- | ------------------ | ----------------- | ------------------------- |
| **Secret read latency**          | 1-5 ms               | 1-3 ms               | 5-15 ms            | 5-15 ms           | 3-10 ms                   |
| **Secret write throughput**      | 500-1,500/sec        | 1,500-5,000/sec      | 4,000/sec          | 4,000/sec         | 5,000/sec                 |
| **Crypto operations/sec**        | 1,000-5,000          | 2,000-10,000         | 2,000/vault        | 2,000/vault       | 3,000/pool                |
| **HSM backing**                  | External appliance   | External appliance   | Software           | FIPS 140-3 L3     | FIPS 140-3 L3 (dedicated) |
| **Auto-scaling**                 | Manual               | Manual               | Automatic          | Automatic         | Automatic                 |
| **Published SLA**                | None                 | None                 | 99.99%             | 99.99%            | 99.99%                    |
| **DR failover time**             | 30-120 min           | 5-30 min             | < 5 min            | < 5 min           | < 5 min                   |
| **Infra management**             | High                 | High                 | None               | None              | None                      |
| **Typical annual cost**          | $25,000-65,000       | $98,000-233,000      | $1,000-10,000      | $5,000-30,000     | $28,000-50,000            |
| **Managed identity integration** | Limited (via plugin) | Limited (via plugin) | Native             | Native            | Native                    |
| **Federal compliance**           | Self-attested        | Self-attested        | FedRAMP Moderate   | FedRAMP High      | FedRAMP High, IL4/IL5     |

---

## Methodology

### Test conditions

- **Vault cluster:** 3-node and 5-node Raft-backend clusters on Azure D4s_v5 VMs (4 vCPU, 16 GB RAM), Ubuntu 22.04, Vault 1.15+
- **Key Vault:** Standard and Premium tier vaults in East US 2 region, accessed via private endpoint from co-located VMs
- **Managed HSM:** Single-region HSM pool in East US 2
- **Network:** All tests conducted within the same Azure region to minimize network variability; private endpoints used for Key Vault access
- **Client:** `vault` CLI and `az keyvault` CLI for functional tests; custom Go and Python load generators for throughput tests
- **Load pattern:** Sustained throughput tests ran for 5-minute intervals with 1-minute warm-up; latency tests used single-threaded sequential requests
- **Secret size:** 256-byte secret values (typical for API keys and connection strings)
- **Key sizes:** RSA-2048 and EC-P256 for cryptographic benchmarks unless otherwise noted

### Measurement methodology

- Latency figures represent P50 (median) values; P99 values are typically 2-3x the stated figures
- Throughput figures represent sustained operations per second after warm-up, measured over 5-minute windows
- Cost figures use published Azure pricing as of 2026-04-30 and representative Vault Enterprise contract terms
- Infrastructure costs assume Azure East US 2 region pricing

!!! note "Reproduce these benchmarks"
Organizations should conduct their own benchmark validation during the migration pilot phase. Key Vault throttle limits are published and deterministic; Vault throughput depends heavily on hardware provisioning, storage backend, and network topology. Use the CSA-in-a-Box migration toolkit for automated benchmark scripting.

---

## Related

- [Vault to Key Vault Migration Overview](../vault-to-key-vault.md) -- full migration playbook
- [Vault to Key Vault Migration Center](index.md) -- expanded guides and tutorials
- [Total Cost of Ownership Analysis](tco-analysis.md) -- detailed cost modeling
- [Feature Mapping (40+ features)](feature-mapping-complete.md) -- comprehensive feature comparison
- [Secrets Migration Guide](secrets-migration.md) -- step-by-step secret migration
- [PKI Migration Guide](pki-migration.md) -- certificate authority migration
- [Encryption Migration Guide](encryption-migration.md) -- Transit engine to Key Vault keys
- [Best Practices](best-practices.md) -- post-migration operational guidance
- [Why Key Vault over Vault](why-key-vault-over-vault.md) -- executive decision brief

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
