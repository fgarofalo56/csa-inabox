# AWS-to-Azure Migration Best Practices

**Status:** Authored 2026-04-30
**Audience:** Migration leads, solution architects, and program managers planning or executing an AWS analytics estate migration to csa-inabox on Azure.
**Scope:** Covers the organizational, technical, and operational practices that distinguish successful migrations from failed ones.

---

## Overview

Migrating an AWS analytics estate (Redshift, EMR, Glue, Athena, S3) to Azure is a 30-40 week program for mid-to-large federal tenants. The technical steps are documented in the companion tutorials. This document covers the practices that make or break the migration: assessment, architecture decisions, identity mapping, validation, team structure, and risk mitigation.

---

## 1. Pre-migration assessment checklist

Complete every item before writing a single line of migration code.

### Infrastructure inventory

- [ ] List all AWS accounts in scope (production, staging, dev, sandbox).
- [ ] Inventory every Redshift cluster: node type, node count, database count, total storage used.
- [ ] Inventory every EMR cluster: instance types, job count, average runtime, permanent vs transient.
- [ ] Inventory every Glue job: type (Spark/Python Shell), DPU allocation, schedule, last run status.
- [ ] Inventory every Glue Crawler: databases scanned, table count, schedule.
- [ ] Inventory every Athena workgroup: query volume, average scan size, saved queries.
- [ ] Inventory every S3 bucket: size, object count, access frequency, lifecycle rules, versioning.
- [ ] Inventory Kinesis/MSK streams: shard count, throughput, consumer count.
- [ ] Document all IAM roles with analytics permissions: who uses what, where.
- [ ] Export CloudTrail logs covering 90 days of analytics API calls.

### Dependency mapping

- [ ] Map every cross-service dependency: which Glue jobs write to which Redshift tables, which EMR jobs read which S3 prefixes.
- [ ] Identify external consumers: BI tools, APIs, downstream systems, partner feeds.
- [ ] Document event-driven patterns: S3 notifications to Lambda/SQS, EventBridge rules triggering Glue.
- [ ] Identify shadow consumers: teams or systems accessing S3/Redshift without formal registration.
- [ ] Map data lineage: source to bronze to silver to gold to consumer for each data product.

### Compliance review

- [ ] Confirm target Azure region meets data residency requirements (Azure Government for FedRAMP High/IL4/IL5).
- [ ] Review ITAR constraints: data cannot leave US sovereign boundaries during or after migration.
- [ ] Map AWS compliance evidence (CloudTrail, Config, GuardDuty) to Azure equivalents (Monitor, Policy, Defender for Cloud).
- [ ] Verify that every AWS service in scope has an equivalent at the required compliance tier on Azure Gov (check `docs/GOV_SERVICE_MATRIX.md`).
- [ ] Plan for audit evidence preservation: CloudTrail logs, S3 access logs, Redshift audit logs must be archived before decommission.

### Cost baseline

- [ ] Export 12 months of AWS Cost Explorer data for all analytics services.
- [ ] Document current commitment models: Reserved Instances, Savings Plans, Redshift Reserved Nodes.
- [ ] Calculate current effective $/TB/month for storage across all tiers.
- [ ] Calculate current effective $/query-hour for Redshift and Athena.
- [ ] Run `scripts/deploy/estimate-costs.sh` against the target Azure configuration.

---

## 2. Network architecture

### Recommended network topology for migration

```
AWS VPC (GovCloud)                    Azure VNet (Gov)
+-------------------+                +-------------------+
|  Redshift         |                |  Databricks       |
|  EMR              |  ExpressRoute  |  ADF (SHIR)       |
|  S3 Endpoints     |<-------------->|  ADLS Gen2 (PE)   |
|  Glue             |    or VPN      |  Key Vault (PE)   |
+-------------------+                +-------------------+
```

### ExpressRoute (recommended for production migrations)

- **When:** Data transfer > 5 TB, ongoing hybrid period > 4 weeks, latency-sensitive reads.
- **Setup:** Provision an ExpressRoute circuit with Microsoft peering. Connect to the Azure VNet where ADLS Gen2 and Databricks reside.
- **Bandwidth:** Start with 1 Gbps; upgrade to 10 Gbps if bulk transfer windows are tight.
- **Cost:** $300-3,000/month depending on circuit speed and provider.

### Site-to-site VPN (acceptable for smaller migrations)

- **When:** Data transfer < 5 TB, migration duration < 4 weeks, no ongoing hybrid reads.
- **Setup:** Azure VPN Gateway (VpnGw2) connected to AWS Virtual Private Gateway.
- **Bandwidth:** Up to 1.25 Gbps aggregate (multiple tunnels).
- **Cost:** $150-400/month.

### Public internet with IP restrictions (dev/test only)

- **When:** Non-production environments, initial testing, proof of concept.
- **Setup:** AzCopy over public internet with storage account network rules restricting to source IPs.
- **Risk:** Slower, subject to ISP variability, no SLA.

### DNS considerations

- Configure Azure Private DNS zones for ADLS Gen2 private endpoints.
- If using split-horizon DNS, ensure Databricks clusters resolve ADLS Gen2 to private IPs.
- During hybrid period, AWS workloads need DNS resolution to Azure private endpoints via ExpressRoute/VPN.

---

## 3. Identity mapping: IAM roles to Entra groups

### Mapping strategy

| AWS IAM construct | Azure equivalent | Migration notes |
|------------------|-----------------|----------------|
| IAM User (programmatic) | Service Principal or Managed Identity | Prefer managed identity for Azure-native workloads |
| IAM User (console) | Entra ID user | Federated identity via Entra ID |
| IAM Role (EC2/EMR instance profile) | User-Assigned Managed Identity | Attach to Databricks workspace or VM |
| IAM Role (Glue service role) | ADF Managed Identity | ADF gets a system-assigned MI at creation |
| IAM Role (cross-account) | Cross-tenant service principal | Rare; usually same-tenant in Azure |
| IAM Group | Entra ID Security Group | Map 1:1; use for RBAC assignments |
| IAM Policy (inline) | Azure Role Definition (custom) | Avoid custom roles; use built-in where possible |
| IAM Policy (managed) | Azure Built-in Role | See role mapping table below |
| S3 Bucket Policy | Storage Account RBAC + ACL | RBAC preferred over ACLs on ADLS Gen2 |
| Lake Formation permissions | Unity Catalog grants | `GRANT SELECT ON TABLE ...` |
| KMS Key Policy | Key Vault access policy or RBAC | Key Vault RBAC is the modern approach |

### Common role mappings

| AWS managed policy | Azure built-in role | Scope |
|-------------------|-------------------|-------|
| `AmazonS3ReadOnlyAccess` | `Storage Blob Data Reader` | Storage account or container |
| `AmazonS3FullAccess` | `Storage Blob Data Contributor` | Storage account or container |
| `AmazonRedshiftReadOnlyAccess` | Unity Catalog `SELECT` grant | Catalog/schema/table |
| `AmazonRedshiftFullAccess` | Unity Catalog `ALL PRIVILEGES` + `Storage Blob Data Contributor` | Workspace + storage |
| `AWSGlueServiceRole` | ADF system-assigned managed identity + `Data Factory Contributor` | ADF instance |
| `AmazonAthenaFullAccess` | Databricks SQL Warehouse access + `Storage Blob Data Reader` | Workspace + storage |
| `AmazonEMRFullAccessPolicy_v2` | `Contributor` on Databricks workspace | Resource group |

### Service account migration checklist

1. Export all IAM roles used by analytics services: `aws iam list-roles --query 'Roles[?contains(RoleName, `analytics`) || contains(RoleName, `glue`) || contains(RoleName, `redshift`) || contains(RoleName, `emr`)]'`.
2. For each role, create an Entra ID security group with equivalent membership.
3. Assign Azure RBAC roles at the appropriate scope (resource group, storage account, Databricks workspace).
4. Create managed identities for service-to-service authentication.
5. Test each identity mapping in a dev environment before production cutover.
6. Document the mapping in the migration tracker for audit purposes.

---

## 4. Data migration patterns

### Pattern A: Parallel ingestion (recommended for most migrations)

```
Day 1: OneLake shortcut to S3 (read-only bridge)
       New writes land on ADLS Gen2
       Consumers read from both via Unity Catalog

Day N: Backfill historical data from S3 to ADLS Gen2 (AzCopy)
       Validate parity per dataset

Day N+M: Flip individual datasets from S3-backed to ADLS-native
         Remove OneLake shortcuts one by one

Final: S3 becomes archive; ADLS Gen2 is source-of-truth
```

**Pros:** Zero downtime, gradual cutover, easy rollback per dataset.
**Cons:** Dual-cloud egress cost during bridge period, requires discipline to track shortcut cleanup.

### Pattern B: Big-bang cutover (for small estates or hard deadlines)

```
Day 0: Freeze all AWS writes
Day 1: AzCopy full transfer S3 → ADLS Gen2
Day 2: Validate parity (row counts, checksums)
Day 3: Redirect all consumers to Azure
Day 4: Decommission AWS
```

**Pros:** Clean cutover, no hybrid complexity, lowest total cost.
**Cons:** Downtime required, high risk if validation fails, no rollback after decommission.

### Pattern C: Hybrid indefinite (for multi-cloud mandates)

```
Day 1: OneLake shortcuts to S3 (permanent bridge)
       Some workloads stay on AWS (IL6, deep SageMaker)
       Analytics workloads move to Azure
       Delta Sharing for cross-cloud data exchange

Ongoing: Two clouds, clear ownership boundaries
```

**Pros:** No forced migration of workloads that work well on AWS.
**Cons:** Ongoing cross-cloud egress, dual operational burden, two sets of governance.

---

## 5. Glue Catalog preservation strategies

The Glue Data Catalog often contains years of accumulated metadata, partitions, and schema evolution history. Do not discard it.

### Strategy 1: Export and replay (recommended)

1. Export all Glue Catalog databases, tables, and partitions via `aws glue get-tables`.
2. Convert Glue table definitions to Unity Catalog `CREATE TABLE` statements.
3. Register each table in Unity Catalog pointing to the migrated ADLS Gen2 location.
4. Purview scans Unity Catalog and inherits the metadata.

### Strategy 2: Federated catalog (for hybrid periods)

1. Keep the Glue Catalog running during migration.
2. Use Databricks Lakehouse Federation to query Glue-backed tables from Databricks.
3. Gradually migrate tables from Glue to Unity Catalog as datasets are validated.
4. Decommission Glue Catalog only after all tables are migrated.

### Strategy 3: Purview S3 connector (for governance continuity)

1. Configure Purview to scan S3 buckets directly (supported via the AWS connector).
2. Purview discovers and classifies data in S3 alongside ADLS Gen2 data.
3. As datasets migrate, Purview lineage automatically updates.
4. This provides a single governance view across both clouds during migration.

---

## 6. Parallel-run approach for validation

### How to run parallel validation

1. **Select validation datasets:** Pick 5-10 representative tables covering different shapes (large fact tables, small dimensions, time-series, CDC).
2. **Run both pipelines:** Execute the AWS pipeline (Glue/EMR/Redshift) and the Azure pipeline (ADF/dbt/Databricks) on the same input data.
3. **Compare outputs:**
   - Row counts (must match exactly).
   - Aggregate checksums (SUM, COUNT DISTINCT on key columns -- must match within 0.01%).
   - Sample row comparison (random sample of 1000 rows, field-by-field comparison).
   - Schema comparison (column names, types, nullability).
4. **Duration:** Run in parallel for at least 5 business days. Extend to 10 days for mission-critical pipelines.
5. **Acceptance criteria:** Zero row-count mismatches, < 0.01% aggregate deviation, zero schema mismatches.

### Automated validation framework

Use dbt tests + a validation notebook (see the companion tutorials for code). Automate the comparison to run daily during the parallel period. Alert on any deviation.

---

## 7. Common pitfalls (and solutions)

### Pitfall 1: Trying to replicate AWS service topology exactly

**What happens:** Teams map every AWS service to an Azure "equivalent" one-to-one, resulting in a complex architecture with too many moving parts.

**Solution:** Consolidate. The five-service AWS analytics estate (Redshift + EMR + Glue + Athena + S3) collapses to three core services in csa-inabox (Databricks + ADF + ADLS Gen2). Let the architecture simplify rather than mirroring complexity.

### Pitfall 2: Ignoring S3 event-driven patterns that need rearchitecting

**What happens:** S3 event notifications trigger Lambda functions, SQS queues, or SNS topics. These patterns do not have a direct lift-and-shift to Azure.

**Solution:** Map each S3 event pattern to its Azure equivalent early in discovery:
- S3 → Lambda: ADLS Gen2 → Event Grid → Azure Functions.
- S3 → SQS → consumer: ADLS Gen2 → Event Grid → Service Bus → consumer.
- S3 → SNS fan-out: ADLS Gen2 → Event Grid → multiple subscribers.

### Pitfall 3: Underestimating Redshift SQL dialect differences

**What happens:** Teams assume Redshift SQL is "just PostgreSQL" and that Databricks SQL is close enough. In practice, there are 25+ dialect differences that cause silent data errors or query failures.

**Solution:** Use the [SQL dialect conversion table](tutorial-redshift-to-fabric.md#step-5-convert-redshift-sql-to-sparksql--databricks-sql) to systematically convert every query. Run automated regression tests comparing Redshift and Databricks results for every converted query.

### Pitfall 4: Not leveraging OneLake shortcuts for hybrid periods

**What happens:** Teams try to migrate all S3 data before starting any Azure workloads, creating a multi-month delay before Azure shows value.

**Solution:** Day 1: set up OneLake shortcuts to S3. Databricks reads S3 through the shortcut while new writes land on ADLS Gen2. This lets Azure workloads start immediately without waiting for data transfer to complete.

### Pitfall 5: Migrating Glue Crawlers without rethinking the pattern

**What happens:** Teams build Purview scan jobs that replicate every Glue Crawler's behavior, including crawling raw data on a schedule.

**Solution:** Glue Crawlers serve two purposes: schema discovery and partition registration. In Azure, Databricks Auto Loader handles schema inference and evolution at read time, and Delta Lake manages partitions natively. You only need Purview scans for governance (classification, lineage) -- not for runtime schema discovery.

### Pitfall 6: Under-provisioning the migration network

**What happens:** Teams try to migrate 20+ TB over a 100 Mbps VPN, resulting in weeks-long transfer times and missed deadlines.

**Solution:** Calculate transfer time before starting. At 100 Mbps, 20 TB takes approximately 18 days of continuous transfer. Budget for ExpressRoute (1 Gbps or 10 Gbps) or Azure Data Box for large migrations.

### Pitfall 7: Forgetting to migrate Redshift user permissions

**What happens:** Data is migrated but access controls are not. Users either cannot access data or have excessive permissions on Azure.

**Solution:** Export Redshift permissions (`SELECT * FROM svl_user_grants`) and map them to Unity Catalog grants before cutover. Test with actual user accounts in a staging environment.

### Pitfall 8: Not planning for Glue job bookmark state

**What happens:** Glue jobs use bookmarks for incremental processing. After migration, dbt incremental models need equivalent state initialization.

**Solution:** For each Glue job with bookmarks enabled, determine the bookmark state (last processed timestamp or file). Initialize the dbt incremental model with a full refresh, then switch to incremental mode. The `{% if is_incremental() %}` block handles ongoing incremental runs.

### Pitfall 9: Skipping performance testing before cutover

**What happens:** Data and logic are migrated correctly, but Databricks SQL query performance is worse than expected because tables are not optimized.

**Solution:** After loading Delta tables, run `OPTIMIZE ... ZORDER BY` on every table. Verify that partition column choices align with query filter patterns. Run the top 20 most expensive queries (from Redshift profiling) on Databricks SQL and compare latency.

### Pitfall 10: Decommissioning AWS before archiving audit evidence

**What happens:** AWS accounts are shut down before CloudTrail logs, S3 access logs, and Redshift audit logs are preserved, creating compliance gaps.

**Solution:** Before decommissioning any AWS resource, archive all audit logs to a long-term retention location (S3 Glacier or ADLS Gen2 Archive tier). Federal compliance frameworks (FedRAMP, CMMC) require audit log retention for 1-3 years minimum.

---

## 8. Team structure recommendations

### Recommended migration team composition

| Role | Count | Responsibilities |
|------|-------|-----------------|
| Migration lead / architect | 1 | Overall architecture, decision-making, risk management |
| Data engineer (AWS-focused) | 2-3 | Redshift profiling, Glue job analysis, S3 inventory, UNLOAD operations |
| Data engineer (Azure-focused) | 2-3 | ADF pipelines, dbt models, Databricks configuration, Delta Lake optimization |
| Platform engineer | 1-2 | Networking (ExpressRoute/VPN), identity (Entra ID), Bicep deployments |
| Security / compliance lead | 1 | IAM mapping, compliance evidence, audit log preservation |
| BI developer | 1 | Power BI semantic models, QuickSight-to-Power BI report conversion |
| QA / validation engineer | 1 | Data parity validation, regression testing, parallel-run monitoring |
| Program manager | 1 | Timeline, risk register, stakeholder communication |

### Scaling guidance

- **Small estate (< 10 Glue jobs, < 5 Redshift schemas):** 4-6 people, 12-16 weeks.
- **Medium estate (10-50 Glue jobs, 5-20 Redshift schemas):** 8-12 people, 20-28 weeks.
- **Large estate (50+ Glue jobs, 20+ Redshift schemas, streaming):** 12-18 people, 30-40 weeks.

---

## 9. Timeline estimation by deployment size

### Small migration (< 5 TB data, < 10 pipelines)

| Phase | Duration | Activities |
|-------|----------|-----------|
| Discovery | 1 week | Inventory, dependency mapping |
| Landing zone | 2 weeks | Bicep deployment, networking, identity |
| Data migration | 1 week | AzCopy transfer, Delta conversion |
| Pipeline migration | 2-3 weeks | Glue to ADF+dbt, Athena to Databricks SQL |
| Validation | 1 week | Parallel run, parity checks |
| Cutover | 1 week | Consumer redirect, decommission |
| **Total** | **8-10 weeks** | |

### Medium migration (5-50 TB, 10-50 pipelines)

| Phase | Duration | Activities |
|-------|----------|-----------|
| Discovery | 2-3 weeks | Full inventory, wave planning |
| Landing zone | 3-4 weeks | Bicep, ExpressRoute, identity mapping |
| Pilot domain | 4-6 weeks | One end-to-end domain migrated |
| Redshift migration | 6-8 weeks | Schema, data, SQL conversion (overlaps) |
| Pipeline migration | 4-6 weeks | All Glue jobs converted (overlaps) |
| Streaming migration | 2-3 weeks | Kinesis to Event Hubs (if applicable) |
| Validation | 2-3 weeks | Parallel run, regression testing |
| Cutover + decommission | 2-3 weeks | Staged cutover, audit log archive |
| **Total** | **20-28 weeks** | |

### Large migration (50+ TB, 50+ pipelines, streaming, ML)

Follow the phased plan in the [main playbook](../aws-to-azure.md#5-migration-sequence-phased-project-plan): 30-40 weeks across 6 phases.

---

## 10. Risk mitigation

### Risk register template

| # | Risk | Likelihood | Impact | Mitigation | Owner |
|---|------|-----------|--------|-----------|-------|
| 1 | Data loss during S3-to-ADLS transfer | Low | Critical | Checksum validation per dataset; S3 versioning preserved; rollback to S3 source | Data engineer |
| 2 | Redshift SQL conversion introduces silent errors | Medium | High | Automated regression test suite comparing Redshift and Databricks results for all converted queries | QA engineer |
| 3 | ExpressRoute provisioning delay | Medium | Medium | Order circuit 4-6 weeks before data transfer phase; fall back to VPN for small datasets | Platform engineer |
| 4 | Glue Catalog metadata loss | Low | High | Export full catalog before migration; validate Unity Catalog table count matches Glue table count | Data engineer |
| 5 | Compliance evidence gap during migration | Medium | Critical | Archive all AWS audit logs before decommission; run Purview scans on day 1; maintain dual-cloud evidence | Security lead |
| 6 | Consumer disruption during cutover | Medium | High | Staged cutover with OneLake shortcuts; 2-week parallel run; rollback plan per dataset | Migration lead |
| 7 | Databricks SQL performance regression | Low | Medium | Run top-20 queries on Databricks SQL in staging; OPTIMIZE+ZORDER before cutover; right-size SQL Warehouses | Data engineer |
| 8 | Budget overrun from cross-cloud egress | Medium | Medium | Budget $90/TB for S3 egress; use ExpressRoute to reduce cost; migrate hot data first, leave cold data on S3 via shortcuts | Program manager |
| 9 | Team skill gap on Azure/Databricks | High | Medium | 2-week training sprint before migration starts; pair AWS-skilled and Azure-skilled engineers | Migration lead |
| 10 | Shadow consumers discovered mid-migration | High | Medium | CloudTrail analysis for S3 GetObject callers; Redshift query log analysis for all connecting applications | Data engineer |

---

## Related resources

- [AWS-to-Azure migration playbook](../aws-to-azure.md) -- full capability mapping and phased plan
- [S3 to ADLS tutorial](tutorial-s3-to-adls.md) -- storage migration step-by-step
- [Redshift to Fabric tutorial](tutorial-redshift-to-fabric.md) -- warehouse migration step-by-step
- [Glue to ADF + dbt tutorial](tutorial-glue-to-adf-dbt.md) -- ETL pipeline migration step-by-step
- [Benchmarks](benchmarks.md) -- performance and cost comparisons
- `docs/COST_MANAGEMENT.md` -- Azure cost optimization
- `docs/GOV_SERVICE_MATRIX.md` -- Azure Government service availability
- `docs/adr/0004-bicep-over-terraform.md` -- IaC choice rationale
- `csa_platform/multi_synapse/rbac_templates/` -- RBAC template patterns

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
