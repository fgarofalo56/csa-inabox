# LHDS — Operations, SLOs, BCDR, upgrades, autoscaling, cost controls, pause/resume

Every number below is either cited, derived from a cited number in
`CAPACITY-MODEL.md`, or marked **TARGET** (a design objective the waves must
measure against, not an observed value). No SLO here has been measured yet;
W11 produces the first measured values and this file is updated from them.

## 1. Service level objectives (TARGET, per stamp)

| Operation class | Availability (monthly) | p95 latency | p99 latency | Notes |
|---|---|---|---|---|
| FHIR read by id | 99.95 % | 100 ms | 300 ms | Served from the engine's DB; cache-assisted for hot resources |
| FHIR search (indexed params, `_count<=100`) | 99.95 % | 400 ms | 1.5 s | Chained/`_include` searches 2x |
| FHIR create/update (sync) | 99.95 % | 250 ms | 800 ms | Transaction bundles <=500 entries: 2 s p95 |
| `$everything` (patient) | 99.9 % | 3 s first page | — | Async for >10k resources |
| `$export` (group/system) | 99.9 % | n/a | — | **Throughput** target: see `CAPACITY-MODEL.md` section 7 (bulk export); job status within 5 s |
| DICOM STOW-RS (per instance, 512 KB) | 99.95 % | 150 ms | 500 ms | Study-level multipart: proportional to bytes; 1 GB study <= 60 s |
| DICOM WADO-RS retrieve instance / frames | 99.95 % | 200 ms | 600 ms | First byte; large series stream |
| QIDO-RS study search | 99.95 % | 300 ms | 1 s | Indexed tags only |
| Terminology `$validate-code` / `$lookup` | 99.95 % | 50 ms | 150 ms | In-memory index |
| HL7 v2 / C-CDA conversion (sync) | 99.9 % | 500 ms | 2 s | Queue path for floods |
| Ingest lag (HL7 v2 feed to searchable FHIR) | — | 5 s | 30 s | End-to-end, measured by a canary message |
| Lakehouse sink lag (FHIR write to Delta visibility) | — | 15 min | 60 min | Micro-batch; backfill separate |
| Change feed / events delivery | — | 5 s | 30 s | From commit to Event Hubs |

AHDS publishes no RPS quota and documents autoscale on resource pressure
(`research/ahds-feature-inventory.md` section 1), so there is no AHDS
latency figure to copy; the targets above are set so that the clinical viewer
and the FHIR-app experiences feel instantaneous and are checked by the load
tests in `TEST-STRATEGY.md` section 5.

Error budget policy: when a stamp burns >50 % of its monthly budget in 7 days,
feature rollouts to that stamp pause (the same R1 spirit as
`deploy-integrity.md`: a broken path preempts features).

## 2. Observability

- **Metrics** (Azure Monitor managed Prometheus + Grafana where available per
  cloud; Log Analytics workbooks otherwise — `AZURE-GOV-AVAILABILITY.md`):
  per-tenant and per-stamp RED metrics per operation class, DB saturation
  (connections, replication lag, bloat), blob throughput, Event Hubs lag,
  KEDA scaler state, PDP decision latency and deny rate, converter queue
  depth, de-id job durations, sink lag, audit-chain verification result.
- **Traces**: OpenTelemetry from the Loom BFF through the gateway into the
  engines (HAPI and the Microsoft engines both emit OTel/Application Insights
  spans — ADR-001/002 record how); trace ids are the request ids in
  `AuditEvent`. Spans never carry resource bodies.
- **Logs**: scrubbed (`SECURITY-AND-COMPLIANCE.md` section 8.3), retained in a
  per-stamp Log Analytics workspace; audit stream separate (section 6 there).
- **Synthetic canaries** per stamp: read/search/write of a dedicated synthetic
  patient (`ZZCANARY` family, Synthea-generated) every minute; a STOW/WADO of
  a 1 MB synthetic study; a `$validate-code` call. The canary patient is the
  SLO probe and is excluded from exports and the sink by label.
- **Admin surfaces** (W9): `/admin/health-services` shows every stamp with
  live SLO state, capacity headroom, deploy SHA (`/build-marker.txt` pattern),
  pause state and last DR drill. Readiness rows are registered in the Loom
  gate registry (`LOOM-INTEGRATION.md` section 6).

## 3. Capacity autoscaling (KEDA) and noisy-neighbour control

- **Stateless tiers** (FHIR API pods, DICOMweb pods, PDP, converter, viewer BFF)
  scale with KEDA on HTTP concurrency (via the ingress metrics) and CPU; floors
  are per stamp size class (`CAPACITY-MODEL.md` section 8).
- **Queue-driven tiers** (converter workers, de-id jobs, export workers, sink
  writers, reindex) scale on Event Hubs lag / Service Bus queue length with
  per-tenant partitions so one tenant's backlog does not starve another.
- **Stateful tiers** do not autoscale; they are sized per stamp class and
  grown by a control-plane operation (storage autogrow on PostgreSQL, vCore
  resize in a maintenance window, read replicas added for read QPS). Adding a
  stamp is the horizontal path (`ARCHITECTURE.md` section 3.6).
- **Per-tenant quotas** at the gateway (APIM policy or the stamp ingress):
  requests/s, concurrent async jobs, STOW bytes/min, export bytes/day; defaults
  per tenant size class; exceeding returns 429 with `Retry-After`. Quotas are
  part of the tenant record and editable in the Health admin surface; every
  change audited.
- **Priority classes**: interactive reads > writes > exports/sink/de-id >
  reindex. Kubernetes PriorityClasses plus DB connection-pool partitions.

## 4. Backup and restore (per stamp)

| Store | Mechanism | RPO | RTO | Retention |
|---|---|---|---|---|
| FHIR PostgreSQL (per tenant DB) | Flexible Server automated backups + PITR; geo-redundant backup where the region supports it (`research/terminology-conformance-ops-facts.md` section C for the Learn-stated ranges) | <= 5 min (PITR granularity; **UNVERIFIED** exact, see research) | **TARGET** 1 h for a 1 TB server | 35 days backups; plus weekly logical export to immutable Blob for 7 years (D17) |
| DICOM metadata DB | Same as above | same | same | same |
| DICOM pixel data (Blob) | Blob soft delete + versioning; vaulted backup / cross-region copy per tier (section 5) | 0 for soft-delete; cross-region copy lag **TARGET** <= 15 min | Minutes (same region) / hours (region loss) | Versions 30 days; legal-hold support per tenant |
| Audit store | Immutable Blob (WORM) + Log Analytics | 0 | n/a (read-only recovery) | 6 years minimum, locked |
| Terminology packages | Rebuildable from the package feed mirrored into Blob | 0 | 30 min | n/a |
| Control plane (Cosmos) | Continuous backup (existing Loom pattern) | seconds | 1 h | 30 days |
| Lakehouse sink | Rebuildable by backfill from the FHIR store | n/a | backfill rate (`CAPACITY-MODEL.md`) | n/a |

Restore drills are mandatory and measured: monthly PITR of one tenant DB to a
scratch server with a row-count and hash comparison; quarterly full-stamp
restore to a scratch stamp. The drill receipts go on the admin surface and in
the evidence pack (`SECURITY-AND-COMPLIANCE.md` section 16 item 7).

## 5. Disaster recovery tiers and paired regions

| Tier | Scope | RPO | RTO | Mechanism |
|---|---|---|---|---|
| Zone loss | AZ within a region | 0 | minutes | Zone-redundant PostgreSQL HA (where available in the region — US Gov Virginia per research), ZRS storage, AKS node pools across zones |
| Stamp loss (software or cluster) | One stamp | PITR | **TARGET** 4 h | Rebuild the stamp from bicep + restore (section 4); tenants re-routed by the control plane once healthy |
| Region loss | All stamps in a region | **TARGET** <= 15 min (async replication) | **TARGET** 8 h | Standby stamp in the paired/alternate region with cross-region PostgreSQL read replica promoted and Blob cross-region copy; control plane is multi-region already (Loom console) |

Azure Government region pairing is **UNVERIFIED** from Learn (the paired-regions
page lists public regions only — `research/azure-gov-availability.md` note on
pairing); the design therefore does not depend on Azure's pairing and names the
alternate region explicitly in the stamp record (default: US Gov Virginia <->
US Gov Texas, to be confirmed with `az account list-locations` in a Gov Actions
run during W0). Cross-region copy for ADLS Gen2 (hierarchical namespace)
accounts is a known limitation for Blob object replication — see the research
file; DICOM pixel storage therefore uses flat-namespace Blob accounts with
object replication, while the lakehouse sink (ADLS Gen2) is rebuildable and
is not replicated (ADR-004, ADR-016).

## 6. Stamp evacuation (planned) and the drill

Evacuating a stamp moves its tenants to another stamp without data loss:
1. Control plane marks the source stamp `draining`; the router keeps reads on
   the source, writes are accepted but mirrored to the outbox.
2. Target stamp provisions the tenant (bicep tenant module: DB, containers,
   keys — the same path as a new tenant).
3. Bulk copy: PostgreSQL logical replication of the tenant DB (or
   dump/restore for small tenants) and Blob copy per tenant container; the
   outbox replays writes that occurred during the copy; a final short write
   freeze (TARGET <= 60 s) cuts over.
4. Verification: row counts, resource-version hashes, study/instance counts and
   a sampled pixel hash comparison must match; the assertion that would break
   is a single mismatched count or hash.
5. Router flips the tenant to the target; the source tenant is kept read-only
   for a retention window then crypto-shredded.
The drill runs quarterly on a synthetic tenant in each cloud; its receipt is a
GitHub Actions run id for Gov.

## 7. Upgrade strategy for the engines and the stamp

- Engine versions are pinned per stamp in the stamp record and in bicep
  (`image.tag`); upstream releases are tracked by a weekly job that files an
  issue with the changelog and CVE delta.
- **Blue/green per stamp**: a new engine version is deployed as a second
  Deployment against the same database only when the upstream migration is
  backward-compatible (both engines in scope, ADR-001/002, document schema
  migration behaviour; where a migration is not backward-compatible the upgrade
  is a maintenance-window event with a PITR restore point taken first and a
  rehearsal on the restored copy).
- Canary tenants (synthetic) on each stamp take the new version first; SLO
  canaries and the conformance smoke suite gate promotion.
- Terminology content upgrades (new LOINC/RxNorm releases) are versioned
  packages loaded side-by-side; a tenant pins a version and opts in.
- Kubernetes/AKS upgrades follow the existing Loom AKS practice; node image
  auto-upgrade with maintenance windows; one stamp at a time.
- Rollback = flip the Service selector back to the previous Deployment (minutes)
  or PITR restore for non-backward-compatible schema (hours, announced).

## 8. Incident response and runbooks

Runbooks (W11 deliverable, `docs/fiab/health/runbooks/`): stamp unhealthy,
PostgreSQL saturation, blob throttling (503/`ServerBusy`), Event Hubs lag,
PDP down (fail closed: deny, with the break-glass path still available via the
cached policy bundle), converter queue flood, audit-chain mismatch, suspected
cross-tenant exposure (isolation incident: immediate stamp freeze, evidence
capture, notification data from the audit store), key compromise (rotate,
re-wrap, re-verify). Each runbook names the alert that triggers it and the
measurement that closes it.

## 9. Cost controls

- Per-stamp and per-tenant cost attribution via resource tags
  (`loom-health-stamp`, `loom-health-tenant`) and the existing Loom program
  budget module (`platform/fiab/bicep/modules/admin-plane/program-budget.bicep`).
- Storage tiering policy for DICOM: hot (0-90 days) -> cool (90 days-2 years)
  -> cold/archive (older), per tenant policy, with rehydration SLAs shown in the
  viewer (an archived study shows an honest "retrieving from archive, ~X h"
  state rather than a timeout). Lifecycle rules are bicep.
- Budget alerts per stamp; anomaly detection reusing
  `cost-anomaly-monitor-job.bicep`.
- Order-of-magnitude costs and the first bottleneck at each 10x:
  `CAPACITY-MODEL.md` sections 9-10.

## 10. Pause / resume — integration with Loom estate power

Loom's estate pause framework (`apps/fiab-console/lib/estate/*`,
`ESTATE_PAUSE_TIER` in `pause-tier.ts`) already includes
`microsoft.containerservice/managedclusters` and `microsoft.app/containerapps`
with a per-app guard. Health stamps integrate, with these rules, because pausing
a health data store is **data-loss adjacent**:

| Resource | May pause? | How | Guard |
|---|---|---|---|
| Stamp AKS cluster (stateless tiers) | Yes (non-production / idle tenants) | AKS stop/start (Learn page in `research/terminology-conformance-ops-facts.md` section C) | Never while an async job (export, de-id, conversion, evacuation) is running: the control plane checks the job registry first |
| PostgreSQL Flexible Server | Yes, bounded | Server stop; Learn documents an automatic restart after 7 days stopped (see research, re-verified in W0) — the control plane schedules a restart before that limit and records that the pause is bounded | Never for a tenant with an active HL7 v2 feed (ingest would backlog beyond the queue retention) |
| Blob storage (pixel data, audit) | **Never** | n/a | Storage has no pause; lifecycle tiering is the cost lever |
| Event Hubs | No | n/a | Retention window is the backlog budget; pausing consumers while producers run risks loss past retention, so a paused stamp must also pause its feeds at the source (documented to the tenant) |
| Terminology, PDP, viewer | Yes (with the cluster) | — | — |
| Control plane | Never | — | It is the resume surface (same reasoning as the console guard, `pause-guards.ts`) |

A paused stamp is shown as paused on `/admin/health-services` and on every
item editor bound to it (the existing paused banner pattern,
`estate-paused-banner.ts`); the FHIR/DICOM endpoints return 503 with a truthful
`Retry-After` and the reason, not a generic error (`deploy-integrity.md` R7).
Auto-pause (`estate-autopause.ts`) is **off by default for production stamps**
and on for sandbox stamps — Decision D18 in `RISKS-AND-OPEN-DECISIONS.md`.

## Related

`CAPACITY-MODEL.md`, `ARCHITECTURE.md` sections 3 and 6, `SECURITY-AND-COMPLIANCE.md`,
`TEST-STRATEGY.md` section 5-6, `W11-hardening-dr-scale-out.md`.
