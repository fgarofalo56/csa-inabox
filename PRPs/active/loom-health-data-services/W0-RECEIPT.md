# LHDS W0 receipt — measurement and decision spike

**Status: PARTIAL (2026-10-22).** The sandbox is now provisioned on a **DEV
profile** ($750/month; see the Sandbox section) and smoke-tested in-cluster. No
engine has been measured on it yet, so every sandbox cell below still reads "not
measured". DEV numbers will prove function, not the pass bars, which need class
S. **No ADR status line moves on this receipt.** W0-7, the decision pass, has not
started.

- Plan: `W00-measurement-spike.md`. Branch `feat/lhds-w0-no-cost`, stacked on
  the PRD/PRP docs PR #5091. Integration facts were measured at `origin/main`
  `b192f05ea347086c772af1cb876d94fc845083c8`.
- Operator decisions, 2026-10-22: run the no-cost items first; then approve the
  sandbox in "Limitlessdata - DLZ" (not the Loom estate subscription) on a DEV
  profile at $750/month. The first pass created nothing in Azure. The sandbox and
  the Gov probe dispatches came after those approvals (see the Sandbox section
  and section 4).
- LOCAL SMOKE numbers come from laptop Docker on cohorts of 30–45 patients. They
  show that the scripts run end to end, and they are **not pass-bar evidence**.
  Each section labels them that way.

## Item status

| Item | State | Evidence |
|---|---|---|
| W0-1 FHIR engines | Scripts written and smoke-run locally (HAPI 8.12.0, Medplum 5.2.7). Sandbox not measured. | Sections 1-2 |
| W0-2 DICOM engine | Scripts written and smoke-run locally (dcm4chee-arc-light 5.35.2, filesystem storage). Sandbox and Blob not measured. | Section 3 |
| W0-3 Gov closure | **Done for usgovvirginia.** #5092 merged and dispatched; run 39887825372 succeeded (11 steps, 15/15 probes rc 0). Arizona and Texas PostgreSQL not probed. | Section 4 |
| W0-4 Egress | Scripts written. The report's exit codes were tested on fixtures. Capture not executed, because there is no cluster. | Section 5 |
| W0-5 Synthea | Scripts written and smoke-run locally. Pool throughput and the 48 h cohort size not measured. | Section 6 |
| W0-6 Loom integration | **Done.** All 7 facts measured at `b192f05ea`, each with `file:line`. | Section 7 |
| W0-7 Decision | Not started. Needs W0-1..W0-5 sandbox numbers. | Section 8 |

## Findings so far (all subject to the sandbox run)

1. **The IL5 control-plane premise was wrong (measured, already corrected).**
   `containerPlatform` is `containerApps` in all 7 param files, including
   `il5.bicepparam:121`. The PRP set said IL5 AKS came "via the existing switch".
   Corrected in #5091 by `0b9b106de`.
   - `il5.bicepparam:121` justifies Container Apps at IL5 as "ACA GA in USGov
     regions". Regional GA is not IL5 audit scope, and this PRP set's own Gov
     table marks Container Apps "no" at IL5.
   - That is a pre-existing Loom IL5 question outside LHDS. It is not filed yet.
2. **dcm4chee on Azure Blob is unverified.** dcm4che documents jclouds object
   storage for S3 only. A Blob descriptor would mean shared-key or SAS auth, not
   managed identity. This is ADR-002's first sandbox test; gaps G1-G3 are in
   `dicom-engine-deploy.sh`.
3. **Bytes per resource came out above the 6 KB bar locally.** HAPI was about 9.9 KB
   and Medplum about 7.9 KB, against ADR-001's 6 KB reversal bar and the 4.5 KB
   capacity assumption.
   - The cohort was tiny and ran on default config, so this does not establish
     anything.
   - The benchmark ADR-001 cites works out to about 11 KB per resource for HAPI.
     The 4.5 KB assumption is the number most at risk.
4. **Medplum needs non-default config for bulk loads.** It rejected large bundles
   at its 1 MB default size limit, and its default rate limit throttled the load
   with per-entry 429s inside an HTTP 200 response.
   - A failed transaction looks partially committed on Medplum, so its atomicity
     is unproven. That needs a targeted W2 test.
5. **HAPI's `ImagingStudy?patient=` p95 was about 10x its other query patterns
   locally.** It reproduced across two runs, and the cause is not diagnosed.
6. **The load drivers need Linux pods in the sandbox.** The Git Bash DICOM
   driver reached about 14 of 60 requested senders in flight.
7. **A fixed Synthea seed is not byte-reproducible.** One CarePlan differed
   between two runs, so the manifest hash, not the seed, identifies a cohort.
8. **PostgreSQL is not available to the Gov subscription in usgovvirginia (Q1),
   measured.** The API offers zero SKUs, `OfferRestricted` is on, and the reason
   is "open a support request". Every LHDS engine sits on PostgreSQL, so the Gov
   primary moves to **usgovarizona**, which run 2 found open with zone-redundant
   HA (usgovtexas is open without it). Gov offers only E-series v3/v4, not v5,
   and no SSD v2 was seen (section 4.1b).
9. **Azure Load Testing does not exist in Gov.** The resource type is absent,
   so Gov load tests must use in-cluster drivers.
10. **GHSA-g7m7 (Q7) is only partly answered.** Commercial is established; Gov is
   not. Details are in section 7.6, deliberately neutral.


## Sandbox: DEV profile (provisioned 2026-10-22)

Operator decisions on 2026-10-22:

- Approve the sandbox in subscription "Limitlessdata - DLZ".
- Then cut it to a **DEV profile with a $750/month budget**, to prove the
  pipeline works before spending class-S money.

**Numbers measured on the DEV profile prove function, not the W0 pass bars.**
Class S (about $4k) is the same script with env overrides, and needs the
operator's approval again.

| Item | Value (from `scripts/measure/health/sandbox.sh status`, 2026-10-22 ~03:20Z) |
|---|---|
| Resource group | `rg-lhds-w0-sandbox-cus`, centralus, tags `delete-by=2026-11-05`, `budget-usd-month=750` |
| Budget | RG-scope `lhds-w0`, $750 monthly; alerts to subscription Owners at 25/50/80 % actual and 100 % forecast. Current spend $0.00 |
| AKS | `aks-lhds-w0`, Kubernetes 1.36. `nodepool1`: 1x Standard_D8s_v5. `egressprobe`: 0x Standard_D4s_v5, labelled and tainted, scaled to 1 only for W0-4 |
| PostgreSQL | `pg-lhdsw0-83072b`, Standard_D2ds_v5 GeneralPurpose, 128 GB, v16, no HA. Private access through the delegated subnet and zone `lhdsw0.private.postgres.database.azure.com`. Databases `hapi`, `medplum`, `dcm4chee` |
| Key Vault | `kv-lhdsw0-83072b`. RBAC, purge protection, **public network access disabled**, private endpoint in `snet-pe` (10.240.17.4). CMK key `lhds-w0-cmk` with identity `id-lhds-w0-cmk` |
| Credential handling | The PostgreSQL admin password is generated by the script and stored in Key Vault (written via ARM) and in the Kubernetes secret `lhds-w0/lhds-pg-admin`. It has never been printed |

**In-cluster smoke test** (pod `lhds-w0-pg-smoke`, `postgres:16`, credential
from the Kubernetes secret, `sslmode=require`), output:

```
server=PostgreSQL 16.15 on x86_64-pc-linux-gnu, compiled by gcc (GCC) 13.2.0, 64-bit
dbs=dcm4chee,hapi,medplum
kv-resolves=10.240.17.4     kv-lhdsw0-83072b.privatelink.vaultcore.azure.net kv-lhdsw0-83072b.vault.azure.net
```

### Commercial finding: PostgreSQL offer restrictions in DLZ

PostgreSQL Flexible Server is **`OfferRestricted`** (0 SKUs) for DLZ in
eastus2, eastus, westus2 and southcentralus. It is open in centralus (109
SKUs), westus3, northcentralus and canadacentral (`list-skus`, 2026-10-22).

- The first attempt in eastus2 failed with "The location is restricted from
  performing this operation".
- That RG was deleted and verified gone, and the sandbox moved to centralus.
- Regional restrictions are per subscription offer, so a customer deployment has
  to probe before it picks a region. That belongs in the W1 deploy preflight.

### az CLI 2.91 behaviour met while provisioning

- `--high-availability` is now `--zonal-resiliency`.
- `--private-dns-zone` must name an *existing* zone. A missing zone produces the
  misleading error "PrivateDnsZoneNameNotValid ... server name plus zone suffix".
- `db show/create` take `-n`.
- A budget's time grain cannot be updated in place.
- A deleted PostgreSQL server's name stays reserved for a while.

## 1. FHIR engine comparison (W0-1: HAPI FHIR JPA vs Medplum)

Scripts: `scripts/measure/health/fhir-engine-{lib,load,bytes,query,export,report}.sh`, authored on the
`feat/lhds-w0-no-cost` worktree stacked on `7da37991c` (scripts untracked at measurement time; the
orchestrator's commit SHA is the ref for the script text).

### 1.1 Sandbox measurement (the pass-bar evidence): NOT MEASURED

| Metric (unit) | HAPI FHIR JPA | Medplum | ADR-001 bar / assumption |
|---|---|---|---|
| Disk bytes per stored resource, Synthea 100 k cohort, 1 M-patient projection (bytes/resource) | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending | reversal bar > 6 KB; assumption 4.5 KB |
| Import throughput, 100 k cohort (resources/s) | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending | none stated |
| L1 mix req/s and p95 at 1 M patients, class-M database | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending | search p95 > 1 s reverses |
| ADR-008 pattern p95 at 1 M patients | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending | search p95 > 1 s reverses |
| `$export` res/s, single path | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending | baseline for the 23 k res/s target |

Consequence: ADR-001's W0 pass bar is **not evaluated**. Nothing below can move the ADR status line.

### 1.2 LOCAL SMOKE (NOT pass-bar evidence)

**These numbers are NOT pass-bar evidence.** They come from a laptop Docker Desktop (8 CPUs, 37.4 GiB
shared with ~20 unrelated containers, Windows host, loopback port-forwards), a tiny cohort, and a single
run per cell. They prove only that the scripts execute end to end against both engines and produce
non-empty, distinct cells. Do not compare them to the 6 KB / 1 s bars.

What was run (2026-10-22 evening local time):
- Cohort: Synthea `master-branch-latest` jar (sha256 `20098ec70c24c715ea874b19140983634711cc4986196105b5b0a9ca72a4b644`),
  `-s 42 -p 30` in `eclipse-temurin:17-jre`. Output: 47 transaction-bundle files (2 shared
  hospital/practitioner + 45 patient bundles; Synthea adds replacement patients for the deceased), 303 MB.
  The single failing bundle (below) is why 102,507 resources, not the file total, were loaded.
- HAPI: `hapiproject/hapi@sha256:0ff86aac...a04e` (server 8.12.0, FHIR 4.0.1) + `postgres:16` (16.15,
  `postgres@sha256:9e2cf628...`), default config except `HAPI_FHIR_BULK_EXPORT_ENABLED=true` and
  `HAPI_FHIR_ALLOW_EXTERNAL_REFERENCES=true`. No JVM or PostgreSQL tuning.
- Medplum: `medplum/medplum-server@sha256:7ccb89e5...74d` (5.2.7) + `postgres:16` + `redis:7`. **Non-default
  config was required**, which is itself an observation: `MEDPLUM_MAX_JSON_SIZE=100mb` (default 1 mb returned
  HTTP 413 on 41 of 47 bundles) and rate limiting disabled (the default FHIR quota of 50,000 returned
  per-entry 429s inside an HTTP 200 transaction response; the first Medplum load "succeeded" at 5,123 res/s
  while only 4,640 resources were stored; the loader's SQL cross-check caught it and the loader now counts
  per-entry statuses). Medplum client auth used a throwaway local user/project and bearer token (not recorded).
- Both engines loaded with 2 parallel POST threads, in the same order (shared bundles first).
- Raw files: `temp/lhds-w0/l1/results/{hapi,medplum}.tsv` (not committed).

Receipt table (`fhir-engine-report.sh`, exit 0; context `local-smoke` for both engines):

| Metric | Counts / measured where | HAPI | Medplum |
|---|---|---|---|
| resources_posted | resources acknowledged 2xx per-entry, 46 of 47 bundles | 102,507 | 102,507 |
| bytes_per_resource (net) | (`pg_total_relation_size` of all tables in schema `public` after load minus same before load) / live resources (HAPI: `hfj_resource` not deleted; Medplum: per-type tables, not deleted, excluding the built-in R4 project's ~4.3 k seeded definitions) | 9,903.3 B | 7,854.3 B |
| bytes_per_resource (gross, includes empty-schema floor) | total bytes / live resources | 9,922.8 B | 8,817.7 B |
| load_res_s | resources_posted / wall seconds, 2 threads, includes HTTP + JSON parse in a Python client | 660.74 res/s (155.1 s) | 148.70 res/s (689.4 s) |
| mix_req_s | L1 mix (section 2), 60 s, 8 threads, Python client | 128.3 req/s | 327.5 req/s |
| mix_p95_ms | client-observed p95 over the whole mix | 90.7 ms | 47.6 ms |
| export_res_s | system `$export` kickoff to last ndjson file downloaded, single path | 3,848.68 res/s (103,477 res, 26.9 s) | 15,938.24 res/s (103,971 res, 6.5 s) |

Run-to-run variance is large and is the main reason these are not evidence. HAPI was measured twice
for query and export on the same loaded database: mix 184.6 req/s / p95 115.5 ms (11,137 requests, 0
errors) then 128.3 req/s / p95 90.7 ms (8,613 requests, 1 error, cause not diagnosed); export 2,832.5
res/s (103,060 res) then 3,848.7 res/s (103,477 res). The table shows the second run. Medplum was run
once.

Observations worth carrying forward (each is a local-smoke observation, to be confirmed or refuted by the
sandbox run):
1. Both engines stored more than 6 KB per resource on this cohort (HAPI 9.9 KB, Medplum 7.9 KB net). If
   the ratio held at scale it would exceed ADR-001's 6 KB reversal bar and CAPACITY-MODEL 1.3's 4.5 KB
   assumption. It is not established that it holds: the cohort is 45 patients / about 1 GB, HAPI ran with
   every standard search parameter indexed, and Postgres had default settings. For reference the benchmark
   ADR-001 cites (~22.6 GB per ~2 M resources) works out to ~11 KB per resource for HAPI, which is
   closer to this local figure than to the 4.5 KB assumption.
2. This cohort is heavier than the CAPACITY-MODEL figure (about 2,280 resources per patient bundle vs
   1,123 cited), so per-patient storage is not comparable either.
3. One Synthea bundle (`Lindsay928_Zieme486_...json`) fails on both engines: it carries a conditional
   reference `Location?identifier=...|null`. HAPI rejected it with HTTP 404 (HAPI-1091) and the stored
   count equals resources_posted exactly (102,507), consistent with nothing being committed. Medplum
   returned HTTP 200 with 486 of 496 entries acknowledged; Medplum's live count (103,061) is 554 above
   resources_posted, consistent with the failed transaction committing its 486 acknowledged entries
   (the remaining ~68 are not attributed; not verified). Atomicity of a failed transaction on Medplum is
   unproven by this run and worth a targeted W2 test.
4. The loader's cross-check (SQL stored count >= 90 % of acknowledged) fired once during development
   (4,640 vs 103,003) and the report script's controls were exercised (below).

Control runs (assertion-design). Mutations were applied to sandbox copies of the result files under
`temp/lhds-w0/l1/report-mutation/`; the tracked tree was not touched.

| Mutation | Value that should break it | Result |
|---|---|---|
| medplum.tsv = byte copy of hapi.tsv | identical core metrics | exit 2, "bytes_per_resource has identical values" |
| medplum `export_res_s` line deleted | missing cell | exit 1, "EMPTY CELL: engine=medplum metric=export_res_s" |
| medplum `p95_P7_imagingstudy` blanked | empty value | exit 1, names the cell |
| medplum `load_res_s` set equal to HAPI's, everything else real | one identical core cell | exit 2 |
| unmutated results | none | exit 0 |

Script defects found and fixed during the smoke run (so the scripts at hand are the fixed versions):
Windows Python emitted CRLF into the last TSV field so cells silently failed to match (fixed with
`lib_py`); `set -e` did not propagate out of command substitution so a failed per-table count was
swallowed (fixed with `inherit_errexit` plus a single atomic SQL count); an HTTP-2xx transaction with
failed entries was counted as loaded (fixed). The HAPI load ran on the version of `fhir-engine-load.sh`
before the per-entry check; its SQL cross-check (stored 102,507 = posted 102,507) corroborates it, but it
was not re-run on the final script (re-loading would duplicate data).

Not executed locally: 100 k cohort; 1 M-patient projection; class-M database; Inferno US Core run;
CVE-process criterion of the ADR-001 bar; k6 (a documented Python-stdlib timer is used instead; its
req/s is a lower bound on the engine).

### 1.3 DEV run (2026-10-23)

Every number in sections 1.3 and 2.4 is labelled **DEV (1x D8s_v5, PG D2ds_v5): function proof, not pass bar.** The 1.1
and 2.2 class-S cells above are unchanged and still read "not measured". `fhir-engine-report.sh` exits 0 on these files
and prints `ADR-001 pass bar: NOT PASS-BAR EVIDENCE (context=sandbox-dev; only context sandbox-classS counts)`.

**Environment.** Sandbox in "Limitlessdata - DLZ", centralus, Commercial only; Gov not exercised. AKS 1.36, one D8s_v5
node shared by the engine, Redis (Medplum) and the load client pod; PostgreSQL 16 D2ds_v5 (2 vCore), one database per
engine, `sslmode=require`, credential from the k8s secret. HAPI `hapiproject/hapi@sha256:0ff86aac...` (8.12.0, JVM
`-Xmx4g`), Medplum `medplum/medplum-server@sha256:7ccb89e5...` (5.2.7) + `redis:7`: the digests the local smoke ran.
**One engine at a time**: HAPI fully measured and scaled to 0, then Medplum. The load client is a `python:3.12-bookworm` pod
on the same node (so client and engine share the 8 vCPU) with `psql` 15 from apt. Raw files:
`temp/lhds-w0/fhir/results/` (not committed).

**Cohort.** A SUBSET of the section 6.3 Synthea cohort: the 2 shared bundles plus the first 50 patient bundles in C-locale
file-name order (254 MB, 92,551 resources acknowledged 2xx per entry, 0 failed bundles), identical for both engines. This
is about the size of the local smoke (102,507 resources), not the 100 k-patient cohort.

| Metric (DEV: function proof, not pass bar) | HAPI 8.12.0 | Medplum 5.2.7 | Notes |
|---|---|---|---|
| resources acknowledged (per-entry 2xx) | 92,551 | 92,551 | same bundles, same order, 2 POST threads |
| resources stored per SQL | 92,551 | 92,620 | Medplum +69 are non-Synthea rows (below) |
| bytes per resource, net | 9,952.7 B | 7,705.3 B | (PG total relation size after minus before) / live resources |
| bytes per resource, gross | 9,978.6 B | 9,025.5 B | includes the empty-schema floor; PG total 923.5 MB vs 835.9 MB |
| import | 529.27 res/s (174.9 s) | 146.97 res/s (629.7 s) | Medplum run 1 on a first load: 153.02 res/s (604.8 s) |
| L1 mix, 60 s, 8 threads | 303.4 req/s, p95 63.3 ms, 18,208 req, 0 errors | 567.8 req/s, p95 26.8 ms, 34,076 req, 0 errors | Python client, so a lower bound |
| `$export` system level | 2,629.76 res/s (93,434 res, 35.5 s) | 18,946.95 res/s (94,255 res, 5.0 s) | export counts include the mix's Observation writes |

Compared with the ADR-001 6 KB reversal bar (**not a bar result**: wrong profile, 92 k resources not 1 M patients): both
engines are above 6 KB net on this cohort, HAPI at 9.95 KB and Medplum at 7.71 KB. The local smoke gave 9.90 KB and 7.85 KB on a
different Synthea build (`master-branch-latest`) and cohort slice; the near-identical figures say the per-resource size here
tracks the data shape more than the host. Medplum's two loads (run 1 and the reload) differ by 0.02 % in bytes per resource.

Observations:
1. **Medplum stored 69 more rows than were posted** (run 1: 68). They are not Synthea data: outside Medplum's built-in
   project the non-Synthea tables held AsyncJob 52, AccessPolicy 8, ProjectMembership 5, Project 3, User 3, Login 2,
   ClientApplication 2, JsonWebKey 1 (sampled after a second throwaway project had been created, so that sum, 76, is 8 above
   the 68 at count time). 52 equals the bundle count, which suggests one AsyncJob per transaction bundle; that is a
   hypothesis, not checked. This resolves the local smoke's "remaining ~68 not attributed" as engine bookkeeping, not
   partial commits of the failing bundle.
2. **HAPI's slow `ImagingStudy?patient=` (394 ms locally, section 2.3) did not reproduce**: p95 16.7 ms here (section 2.4).
3. **Medplum on Azure Database for PostgreSQL did not start out of the box, twice, and both are W1 deploy-preflight items.**
   (a) The image CMD is a config file path that is absent in the image (CrashLoopBackOff); `args: [env]` selects
   configuration from `MEDPLUM_*` variables, as the local smoke did. (b) Its schema migration runs `CREATE EXTENSION` for
   `btree_gin`, `pg_trgm`, `btree_gist` and `unaccent`; Azure refuses every extension not in the server parameter
   `azure.extensions` (default empty): `extension "btree_gin" is not allow-listed for users in Azure Database for
   PostgreSQL`. `fhir-engine-deploy.sh` now sets the parameter additively. HAPI needed neither.
4. **A Medplum token only sees its own project.** The first token script minted a new project per run, so a refreshed token
   returned an empty project (`no Patient resources found`) while the data sat in the old one. That cost one Medplum
   reload (database dropped and recreated; the table above is the reload; run 1 is kept in
   `medplum-run1-first-project.tsv`). The script now stores the throwaway credential in the pod (mode 600) and re-enters the
   same project. The token is a project admin's, from a user created in-cluster (a `ClientApplication` was not used).
5. The first HAPI query run aborted at P6 with 5 of 200 requests failed. The failure body was not captured and the
   cause is **not established**; the sampled names hold no spaces or apostrophes. The rerun (identical script apart from
   URL-encoding the sampled values and printing the first failure on abort) had 0 errors.
6. AKS `resume` returned `Running`, but the first `kubectl` call failed for a few minutes with a connection timeout; the
   API answered about 4 minutes after the node was Ready. Scripts that follow `resume` need a bounded wait.

What was not done: 100 k cohort, 1 M-patient projection, class-M database, Inferno US Core, the CVE criterion, and more
than one run per cell on HAPI (Medplum has two loads). Bundles were posted over the in-cluster Service, not through
an ingress, so no TLS or gateway cost is included.

### 1.4 Atomicity of a failed transaction bundle (DEV run, 2026-10-23)

Question from the local smoke: does a failed transaction bundle roll back fully on Medplum? `fhir-engine-atomicity.sh`
posts four transaction bundles per engine, tags every entry, and counts what persisted by walking
`Patient?_tag=<marker>` pages. Each case is 5 valid Patients followed by ONE bad last entry; the control has 6 valid
Patients and must be counted as 6 or the script records nothing (so "0 persisted" cannot be a blind counter).

DEV (1x D8s_v5, PG D2ds_v5): function proof, not pass bar:

| Case (bad last entry) | HAPI: HTTP, entries 2xx, persisted | Medplum: HTTP, entries 2xx, persisted |
|---|---|---|
| control (none, 6 valid) | 200, 6 of 6, 6 | 200, 6 of 6, 6 |
| Observation without the required `status` | 200, 6 of 6, 5 Patients (the Observation was **accepted**) | 200, 5 of 6, **5** |
| Observation whose subject is a conditional reference matching nothing (the Synthea failure shape) | **404**, 0 of 6, **0** (HAPI-1091) | 200, 5 of 6, **5** |
| resource of an unknown `resourceType` | **400**, 0 of 6, **0** (HAPI-1684) | 200, 5 of 6, **5** |

**Verdict, observed not inferred: Medplum 5.2.7 does not roll back.** For all three bad bundles it returned HTTP 200 with a
`transaction-response` in which the bad entry carries status 400 and the other five entries 2xx, and the five valid Patients
were found persisted. That is batch semantics under a transaction label. HAPI 8.12.0 failed the whole transaction (404 or
400) and persisted nothing, for the two bad entries it rejects; for the missing-`status` Observation it rejected nothing
(HAPI validates required elements only with a validation interceptor, which is not configured), so that row is a control
for HAPI's leniency, not an atomicity result. A client that treats HTTP 200 as success on Medplum will silently lose the bad
entry and keep the rest; that is consistent with the local smoke's 486-of-496 bundle (not re-run here). Whether Medplum rolls back on
database-level failures (a constraint violation mid-transaction) was not tested: only validation and reference
failures were. The HAPI row ran on the script revision before the per-entry-status detail was added (counts and verdicts are
the same code path); the Medplum rows are from the final revision, whose detail is `entry-statuses #5:400` in all three cases.

Control runs on sandbox copies of the DEV result files (tracked tree untouched), `fhir-engine-report.sh`:

| Mutation | Value that should break it | Result |
|---|---|---|
| medplum.tsv = byte copy of hapi.tsv | identical core metrics | exit 2, "bytes_per_resource has identical values" |
| medplum `export_res_s` line deleted | missing cell | exit 1, "EMPTY CELL: engine=medplum metric=export_res_s" |
| medplum labelled `local-smoke`, hapi `sandbox-dev` | context mismatch | exit 3 |
| both files relabelled `sandbox-classS` | the verdict guard's other branch | exit 0 and the bar lines print (HAPI 9,953 B > 6,144, FAIL; Medplum 7,705 B > 6,144, FAIL; worst p95 60 / 20 ms); proves the DEV run is held back by its label, not by the numbers |
| unmutated DEV files | none | exit 0, `NOT PASS-BAR EVIDENCE` |

The atomicity classifier was not mutation-tested against a deliberately wrong engine; its discrimination is shown by the
engines returning different verdicts on the same bundles, and its blind-probe guard by construction only.

## 2. Query and export patterns (W0-1, ADR-008 patterns and the L1 mix)

Script: `scripts/measure/health/fhir-engine-query.sh` (patterns and mix), `fhir-engine-export.sh` (`$export`).

### 2.1 Definitions

Patterns are the ranked list in `CAPACITY-MODEL.md` section 4 (which ADR-008 adopts as its curated set),
with parameters drawn at random (fixed seed 42, same draw order for both engines) from the loaded data:

| ID | Request |
|---|---|
| P1 | `Patient?identifier=<value>` |
| P2 | `Observation?patient=&category=vital-signs&date=ge2000-01-01&_sort=-date&_count=100` |
| P3 | `Condition?patient=`, `MedicationRequest?patient=`, `AllergyIntolerance?patient=` (three separate rows) |
| P4 | `Encounter?patient=&date=ge2000-01-01`; `Encounter?location=&date=ge2000-01-01` |
| P5 | `DocumentReference?patient=&date=ge2000-01-01&type=<sampled system|code>` |
| P6 | `Patient?name=<family>&birthdate=<date>` |
| P7 | `ImagingStudy?patient=` |
| P9 | `Observation?_lastUpdated=ge2000-01-01&_count=100` |

Not measured: P8 (`Group/{id}/$export`: the smoke cohort has no Group), P10 (full-text, out of v1 per
D20), and ADR-008 behaviours that are not requests (cursor pagination caps, `_include` depth caps,
`$everything` async switch).

**L1 mix** (defined here because CAPACITY-MODEL s11 names the mix without a weight table): for 60 s, 8
threads, each request is a write with probability 5 % (an `Observation` create for a sampled patient;
CAPACITY-MODEL 1.3 assumes 20 reads per write, 4.8 %), otherwise a read drawn by weight from:
P1 30, P2 20, P3 (three rows) 5 each, P4-patient 8, P4-location 2, P5 8, P6 6, P7 3, P9 2. The weights
are the CAPACITY-MODEL s4 frequency ranking converted to numbers by this script; they are an assumption,
not a measurement (W7 replaces them).

Per-pattern p95 is measured separately: 200 sequential requests per pattern at concurrency 1 (latency,
not queueing), client-observed (includes loopback and Docker port-forward hops).

### 2.2 Sandbox measurement: NOT MEASURED

| Cell | Result |
|---|---|
| p95 per pattern at 1 M patients, class-M database, HAPI | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending |
| p95 per pattern at 1 M patients, class-M database, Medplum | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending |
| L1 mix req/s and p95 per engine, single pod | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending |
| `$export` res/s per engine at 100 k-patient cohort | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending |

### 2.3 LOCAL SMOKE (NOT pass-bar evidence)

**These numbers are NOT pass-bar evidence.** Same environment, cohort and caveats as section 1.2
(laptop Docker, 45 patients / ~102 k resources, one run per cell for Medplum, two for HAPI, Python
client). Do not compare them to the ADR-001 "search p95 > 1 s at 1 M patients" bar: a 1 M-patient
database is about 10,000x this one in resource count, and no query here approaches the 1 s bar for the
reason that the table is small.

p95 per pattern, ms, 200 requests each, concurrency 1, context `local-smoke`:

| Pattern | HAPI p95 | Medplum p95 | Mean entries per page (HAPI / Medplum) |
|---|---|---|---|
| P1 Patient?identifier | 35.0 | 33.3 | 1.0 / 1.0 |
| P2 Observation vitals sorted | 90.7 | 35.2 | 69.5 / 68.9 |
| P3 Condition | 43.5 | 30.6 | 18.4 / 18.4 |
| P3 MedicationRequest | 42.0 | 36.6 | 13.4 / 14.0 |
| P3 AllergyIntolerance | 32.0 | 31.6 | 1.0 / 1.0 |
| P4 Encounter patient+date | 43.8 | 32.1 | 15.9 / 15.9 |
| P4 Encounter location+date | 40.7 | 30.2 | 19.0 / 19.0 |
| P5 DocumentReference | 45.0 | 32.4 | 16.0 / 15.6 |
| P6 Patient name+birthdate | 34.5 | 31.7 | 0.1 / 0.1 (almost always an empty result) |
| P7 ImagingStudy | 393.6 | 31.7 | 5.4 / 4.8 |
| P9 `_lastUpdated` scan | 96.1 | 31.0 | 100.0 / 100.0 |

Near-identical mean page sizes across engines show the two engines answer the same questions with the
same semantics on the same data, so the latency columns compare like with like (the small differences in
P3 MedicationRequest and P5 come from the random draws interleaving with writes, not verified).

L1 mix, 60 s, 8 threads: HAPI 128.3 req/s, p95 90.7 ms, 8,613 requests, 1 error (not diagnosed, below the
1 % abort threshold); Medplum 327.5 req/s, p95 47.6 ms, 19,656 requests, 0 errors. HAPI's first mix run
on the same database was 184.6 req/s, p95 115.5 ms (11,137 requests, 0 errors): a 44 % swing between two
runs of the same script, which bounds how much any single cell here can be trusted.

`$export` (system level, `Prefer: respond-async`, ndjson downloaded and counted): HAPI 103,477 resources
in 26.9 s (server-complete at 20.3 s) = 3,848.68 res/s; Medplum 103,971 resources in 6.5 s (server-complete
at 5.2 s) = 15,938.24 res/s. HAPI's earlier run: 103,060 resources, 36.4 s = 2,832.5 res/s. Export counts
exceed the load count because the mixes wrote Observations (about 5 % of requests) before each export; the
Medplum export count was not reconciled against its own live count plus mix writes. CAPACITY-MODEL s7 target is about 23 k res/s per stamp; these are
single-path, single-pod, laptop figures and say nothing about whether the parallel-worker design is needed
beyond the unsurprising fact that 3.8 k and 15.9 k are both below 23 k.

Observations to confirm in the sandbox: (a) HAPI's P7 p95 (394 to 402 ms in both runs) is 10x its other
patterns and 12x Medplum's on the same query, reproducibly; the cause is not diagnosed (candidates:
missing/unused index on `ImagingStudy.patient`, or result-cache behaviour on a pattern whose result
differs per patient). (b) P6 returned almost no hits, so its latency is a miss latency; the sandbox run
must sample names that exist. (c) The reported Medplum numbers are with rate limiting disabled; at
default settings Medplum throttled bulk loading (section 1.2), which matters for the W6 export/sink
design.

Controls: every pattern aborts the script if more than 1 % of its requests are non-2xx (a failing query
must not publish a latency), and the mix aborts on more than 1 % errors; `mean_hits_*` is recorded so an
empty-result pattern is visible. The abort thresholds were not mutation-tested (no failing engine was
available); they are asserted by construction only.

### 2.4 DEV run (2026-10-23)

Same environment, cohort subset and caveats as section 1.3 (92,551 resources, one engine at a time, client pod on the
same node, Python client). Labelled **DEV (1x D8s_v5, PG D2ds_v5): function proof, not pass bar.** The ADR-001 and ADR-008
bar is p95 > 1 s at 1 M patients on a class-M database; this database is about 1/10 of a 100 k-patient cohort and 2 vCore, so
no row below says anything about the bar either way.

p95 per pattern, ms, 200 requests each at concurrency 1, fixed draw seed 42, context `sandbox-dev`:

| Pattern | HAPI p95 | Medplum p95 | Mean entries per page (both engines, identical) |
|---|---|---|---|
| P1 Patient?identifier | 19.1 | 3.9 | 1.0 |
| P2 Observation vitals sorted | 56.1 | 19.9 | 68.3 |
| P3 Condition | 27.7 | 4.1 | 19.1 |
| P3 MedicationRequest | 26.1 | 5.0 | 11.4 |
| P3 AllergyIntolerance | 14.8 | 3.6 | 1.1 |
| P4 Encounter patient+date | 29.1 | 4.7 | 18.7 |
| P4 Encounter location+date | 9.7 | 4.3 | 1.0 |
| P5 DocumentReference | 32.6 | 5.2 | 19.0 |
| P6 Patient name+birthdate | 13.1 | 3.3 | **0.0** |
| P7 ImagingStudy | 16.7 | 4.0 | 1.3 |
| P9 `_lastUpdated` scan | 59.6 | 5.8 | 100.0 |

The mean page sizes are identical to one decimal on both engines for all eleven patterns: both answered the same
questions on the same data, so the latency columns compare like with like. Value that would break that reading: a
different mean on any row (none).

- **P6 is still a miss latency, not a lookup**: mean hits 0.0 on both engines. Local-smoke observation (b) asked for the
  sandbox run to sample names that exist; `fhir-engine-query.sh` still draws family name and birthdate independently, so
  almost every pair matches nobody. Not fixed in this run. Its 13.1 ms and 3.3 ms are the cost of an empty result.
- HAPI's P7 outlier (394 to 402 ms locally) is gone: 16.7 ms. Local observation (a) is **not reproduced**; the cause
  stays undiagnosed, and the local result may have been the Docker host or a cold result cache.
- Medplum is faster than HAPI on every pattern (3.9 to 19.9 ms against 9.7 to 59.6 ms) and on the mix and `$export`;
  HAPI imported 3.6x faster. All of this is one run per cell at 92 k resources, and the local smoke's run-to-run swing on
  HAPI was 44 %.
- `$export`, mix and import are in the section 1.3 table. HAPI had `HAPI_FHIR_BULK_EXPORT_ENABLED=true` and
  worked first time; Medplum's export worked with the project admin's token. Both are single-path figures against the
  23 k res/s CAPACITY-MODEL target (HAPI 2.6 k, Medplum 18.9 k res/s), which says nothing about the W6 parallel design.

## 3. DICOM engine: dcm4chee-arc-light (W0-2, ADR-002 / ADR-004)

Scripts (authored at base `7da37991c`, branch `feat/lhds-w0-no-cost`; uncommitted at the time of writing):
`scripts/measure/health/dicom-engine-{deploy,load,ops,report}.sh`, plus `dicom-engine-lib.sh` and
`dicom-engine-gen.py` (synthetic DICOM generator; its instances are generated, never real images).

**Status: the W0-2 sandbox measurement was NOT performed.** When this section was written no Azure resource
existed. The DEV sandbox now exists (see the Sandbox section), but `dicom-engine-deploy.sh` has still never been
run against a subscription; it was only
executed to prove its guards (refuses with no `LHDS_SANDBOX_SUBSCRIPTION`/`LHDS_SANDBOX_RG`; with both set and
`LHDS_DEPLOY_CONFIRM` unset it writes the values/manifests under `temp/` and prints a plan, touching nothing).
`dicom-engine-ops.sh blob` was never run against Blob.
**Superseded for the DEV profile: the deploy script and the ops probes were run on 2026-10-23, see 3.3.** The
class-S cells in 3.1 are unchanged: the DEV run is function proof, not pass-bar evidence.

### 3.1 Sandbox table (class-M stamp, AKS + PostgreSQL + Azure Blob, CMK, private endpoint)

| Cell | Value |
|---|---|
| STOW p95 at 100 concurrent senders, 512 KiB instance (ADR-002 bar: <= 300 ms) | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending |
| STOW throughput (req/s, MiB/s) per pod | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending |
| QIDO p95 / req/s | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending |
| WADO p95 / req/s / MiB/s | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending |
| Azure Blob descriptor works (Commercial endpoint) | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending |
| Azure Blob descriptor with CMK | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending |
| Azure Blob descriptor via private endpoint | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending |
| Azure Blob descriptor against a Gov endpoint (`*.blob.core.usgovcloudapi.net`) | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending; a Gov receipt must come from a GitHub Actions run |
| LDAP restart / backup on AKS (StatefulSet) | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending |
| Blob 503 onset (first concurrency step returning HTTP 503) | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending |
| Orthanc same probe (only if dcm4chee fails its bar) | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending; not triggered, since dcm4chee has no sandbox result |

ADR-002 status stays **Proposed**: no pass-bar value was measured.

Open gap found while authoring (not a measurement): the dcm4che wiki documents jclouds object storage only for S3
(identity / credential / container). The Azure Blob descriptor (`jclouds:azureblob:https://<acct>.blob.core.windows.net`,
shared key or SAS in `credential`) comes from ADR-002's reading of `dcm4chee-arc-storage-cloud` and is **unverified
against a running archive**. Shared-key/SAS auth also means no managed identity for pixel storage. The sandbox run
must settle both before ADR-002 and ADR-004 can be closed.

### 3.2 LOCAL SMOKE (NOT pass-bar evidence)

These numbers only show that the scripts run end to end and that the report fails when it should. They are **not**
evidence for any ADR-002 or ADR-004 bar: Windows 11 laptop, Docker Desktop (8 CPUs, ~37 GiB), **local filesystem
storage, not Blob**, no AKS, no CMK, no private endpoint, a Git Bash load driver, a single archive container, and the
other W0 lanes' containers sharing the machine. Measured 2026-10-22 at base `7da37991c` (scripts uncommitted).

Stack: the documented minimum set from the dcm4che wiki ("Run minimum set of archive services on a single host"):
`dcm4che/slapd-dcm4chee:2.6.15-35.2`, `dcm4che/postgres-dcm4chee:17.9-35`, `dcm4che/dcm4chee-arc-psql:5.35.2`
(containers `lhds-w0-l2-{ldap,db,arc}` on network `lhds-w0-l2-net`, all removed afterwards).

Run: `dicom-engine-load.sh` with `LHDS_DICOM_ENV_LABEL=local-smoke`, 200 synthetic CT instances (524,942 bytes each as
files, random pixel data = incompressible worst case, fabricated names, seeded UIDs, seed 43), 100 requested concurrent
`curl` senders, then the same count for QIDO (study lookup by StudyInstanceUID) and WADO (whole-instance retrieve),
then 3 more instances through the real `dcm4che/dcm4che-tools:5.35.1` `stowrs` client.

| Cell (local smoke, filesystem storage) | Value |
|---|---|
| STOW requests ok / sent | 200 / 200 (0 failed) |
| Archive instance count delta vs 200 acknowledged STOWs | +200 (before 40, after 240): persisted == acknowledged |
| STOW p50 / p95 / p99 | 32.4 ms / 696.4 ms / 1016.5 ms |
| STOW throughput | 31.9 req/s, 16.0 MiB/s |
| QIDO ok / sent; p95; throughput | 200 / 200; 923.9 ms; 26.2 req/s |
| WADO ok / sent (body >= 524,942 B each); p95; throughput | 200 / 200; 24.3 ms; 33.2 req/s, 16.6 MiB/s |
| Real-tool `stowrs` (dcm4che-tools 5.35.1), 3 instances | exit 0, archive count +3 |
| LDAP backup (`slapcat` -n 0 and -n 1) and restore into a fresh container of the same image | 1,599 data entries dumped, 1,599 restored (config: 14 entries) |
| LDAP restart (`docker restart`) to rootDSE answering | 0.8 s |
| First HTTP 200 STOW after the LDAP restart began | 1.0 s, no manual step |
| Blob 503 onset | not measured: filesystem storage locally, no Blob |

Report run: `dicom-engine-report.sh` over this result set **exited 1** with exactly one cell EMPTY (Blob 503 onset)
and printed `ADR-002 STOW bar: NOT PASS-BAR EVIDENCE (env=local-smoke ...)`. That is the guard working, not a defect
in the smoke.

Caveats that change how to read the numbers:
- **The Git Bash driver cannot deliver the requested concurrency.** Each request spawns bash + awk + curl. A
  positive-control run of the Blob ramp against a local fake endpoint (503 above 3 in-flight PUTs) asked for 60
  concurrent senders and the fake server observed a maximum of **14** in flight. The "100 senders" label above is the
  requested count, not the achieved one; the STOW/QIDO p95 values include spawn-storm contention. The sandbox run must
  use a Linux driver pod (the scripts run unchanged there) and the report's `stow_concurrency` cell records the
  request, so achieved concurrency should be logged server-side.
- LDAP restart and "archive recovered" only prove the archive keeps serving STOW across a 0.8 s slapd restart. They do not
  prove the archive re-reads configuration from LDAP, and they say nothing about a StatefulSet restart on AKS.
- Controls run: Blob-probe 503 detection against the fake endpoint (onset found at the 10-sender step, 26 of 30 PUTs
  returned 503); the report script returned 0 only on a result set where every cell was populated (a copy of the smoke
  metrics plus the fake-endpoint Blob cell, labelled local-smoke). The fake-endpoint value is a script control, not a
  measurement of Blob.
- The synthetic instance is a minimal CT with no overlay or multi-frame structure; real modality mix and sizes (the
  VA/IHS evidence in `research/scale-evidence-va-ihs-dicom-pricing.md`) are not represented.

### 3.3 DEV run (2026-10-23)

Every number below is labelled **DEV (1x D8s_v5, PG D2ds_v5): function proof, not pass bar.** Environment: the
sandbox in "Limitlessdata - DLZ", centralus, Commercial only. dcm4chee-arc-light 5.35.2 (WildFly 41, Java 21, jclouds
2.7.0), slapd-dcm4chee 2.6.15-35.2, schema from postgres-dcm4chee 17.9-35, PostgreSQL 16 `dcm4chee` database over the
private subnet. Archive heap 4 GB (the image default is 512 MB). The load driver is a Linux pod (`python:3.12`) on the
same single node as the archive, so driver and archive compete for the same 8 vCPU. "Senders" is the requested
`xargs -P` count; achieved concurrency was not measured server-side. Instances are the generated 512 KiB synthetic CT
(random pixel data), 1,000 per step, a fresh seed per step. Raw metric files: `temp/lhds-w0/l2/raw/` (not committed).

**What ran:** `dicom-engine-deploy.sh` (after fixes, commit `4cd495b22`), `dicom-engine-load.sh` at six steps,
`dicom-engine-ops.sh ldap` with `LHDS_RUNTIME=k8s`, `dicom-engine-ops.sh blob`, `dicom-engine-report.sh` (exit 0,
19/19 cells populated, verdict `NOT PASS-BAR EVIDENCE (profile=dev)`). The `stowrs` real-client pass was skipped: it
needs docker and the driver pod has none.

#### Load, DEV (1x D8s_v5, PG D2ds_v5): function proof, not pass bar

Storage was Azure Blob (Entra bearer descriptor, see the findings table), private endpoint only, CMK on. All STOW and
WADO requests returned 200 at every step, and the archive instance count rose by exactly the number of 200s.

| Senders | STOW p50 / p95 / p99 (ms) | STOW req/s, MiB/s | QIDO p95 (ms), req/s, failed | WADO p95 (ms), req/s, MiB/s |
|---|---|---|---|---|
| 10 | 76 / 782 / 1,075 | 61.0, 30.6 | 1,000, 90.7, 0 | 128, 120.9, 60.5 |
| 25 | 91 / 940 / 1,092 | 104.8, 52.5 | 1,528, 103.0, 0 | 169, 179.4, 89.8 |
| 50 | 153 / 1,175 / 3,647 | 100.8, 50.4 | 1,870, 94.0, 0 | 302, 178.0, 89.1 |
| 100 | 450 / 1,041 / 1,294 | 136.6, 68.4 | 1,666, 169.6, 0 | 377, 179.9, 90.1 |
| 150 | 666 / 1,466 / 1,852 | 134.7, 67.4 | 93,482, 9.5, 45 (of 1,000) | 401, 178.2, 89.2 |
| 200 | 1,109 / 3,280 / 3,664 | 109.6, 54.9 | 94,716, 9.3, 60 (of 1,000) | 324, 185.1, 92.7 |

Where it saturates on this node:
- **QIDO between 100 and 150 senders.** From 150 the failures are HTTP 500s and p95 jumps to about 93 s. `server.log`
  holds 1,916 `IJ000453: Unable to get managed connection for java:/PacsDS` lines (the JDBC pool, across the 150/200/300
  runs), on a 2 vCPU database. The pool size was not tuned.
- **STOW throughput plateaus at about 100 to 137 req/s from 25 senders up** (68 MiB/s at the best step), while p95 climbs
  from 0.9 s to 3.3 s at 200.
- One earlier run at 300 senders (before the request-count fix below, otherwise the same): STOW 1,000/1,000 ok, p95
  6,940 ms; QIDO 630 of 1,000 HTTP 500, p50 217 s. Not repeated.
- WADO did not saturate in this range (about 180 req/s, 90 MiB/s, zero failures).
- The ADR-002 STOW bar is p95 <= 300 ms at 100 senders. The DEV value is 1,041 ms. That is **not** a bar result (wrong
  profile, shared node, small database), and it is not evidence that the bar fails at class S either.
- `server.log` also carries about 2,000 `duplicate key value violates unique constraint` errors
  (`study_study_iuid_key` 345, `series_study_fk_series_iuid_key` 462, `study_query_attrs_view_id_study_fk_key` 1,151)
  under concurrent STOW into the same study, while every STOW still returned 200. Needs triage before class S: either
  harmless retry noise or a hot spot.
- A 300-instance run after the archive was pointed back at filesystem (PVC) storage and restarted, 25 senders: STOW
  p50 826 / p95 3,724 ms, 20.3 req/s. That archive had just restarted (cold JVM), so it is not a Blob-versus-PVC
  comparison.

#### Operational probes, DEV (1x D8s_v5, PG D2ds_v5): function proof, not pass bar

| Probe | Result |
|---|---|
| LDAP backup (`slapcat -n 0` and `-n 1`) | 1,595 data entries, 14 config entries |
| Restore into a throwaway pod of the same image (`slapadd`, then `slapcat`) | 1,595 restored = 1,595 dumped (`ldap_backup_ok=1`) |
| LDAP StatefulSet restart (`rollout restart`) to rootDSE answering | 12.2 s (an earlier identical run recorded 8.9 s) |
| First HTTP 200 STOW after the restart began | 13.6 s, no manual step (`ldap_restart_ok=1`) |
| Blob 503 onset (direct 512 KiB PUTs from the cluster over the private endpoint, Entra bearer) | none up to 400 requested senders: 250, 500, 1,000, 2,000 and 4,000 PUTs per step, 7,750 of 7,750 returned 201. Achieved concurrency not measured; the 503 detection was only positive-controlled against a local fake (3.2) |

The LDAP dumps contain the Blob descriptor's `credential` property in clear text. Anyone who can run `slapcat` or has
LDAP admin can read the storage credential. Keep dumps out of the repo, and treat this as an ADR-004 input.

#### Azure Blob descriptor findings (the ADR-004 question)

| Question | Result | Evidence |
|---|---|---|
| Does dcm4chee-arc accept a jclouds `azureblob` descriptor? | **Yes** | The `dcmStorage` LDAP entry (`dcmURI: jclouds:azureblob:https://<acct>.blob.core.windows.net`, properties `container`, `identity`, `credential`, `containerExists`) loaded, and the archive's `PurgeStorageScheduler` logged `Storage[id=azure1, uri=jclouds:azureblob:...]`. `azureblob-2.7.0.jar` and `oauth-2.7.0.jar` ship in the image. `CloudStorage` passes every descriptor property that starts with `jclouds.` to the jclouds `ContextBuilder` overrides (bytecode read, `javap`) |
| Account key (SharedKey, the jclouds default) | **Refused in this subscription. "Key works" was never observed.** | STOW failed with `HTTP/1.1 403 Key based authentication is not permitted on this storage account` on the blob `HEAD`. The account reports `allowSharedKeyAccess=false`: `az policy state list` shows tenant policy assignment `MCAPSGovDeployPolicies` / `StorageAccount_DisableLocalAuth_Modify` (effect `modify`). `az storage account update --allow-shared-key-access true` returned success and the property stayed `false`. No policy exemption was sought. jclouds 2.7.0 `AuthType` has only `AZURE_KEY`, `AZURE_AD`, `AZURE_SHARED_KEY`, so there is no SAS mode, and an account SAS needs the key anyway |
| Private endpoint | **Yes, and it was the only path** | `publicNetworkAccess=Disabled` (forced by `StorageAccount_PublicNetwork_Modify`), so a workstation cannot reach the data plane at all. The first try failed with `UnknownHostException` because the DNS zone group was missing; after the fix the pod resolved the account to the private-endpoint address 10.240.17.5 and requests reached the service. Every successful run used it |
| CMK | **Yes** | `encryption.keySource=Microsoft.Keyvault`, key `lhds-w0-cmk`, identity `id-lhds-w0-cmk` (assigned to the account at creation), against a Key Vault with public access disabled. The update succeeded and all data was written and read with it on |
| Entra ID via jclouds (`azureAd`) with a static bearer token | **Yes, as a probe. Not operable as is** | Properties: `jclouds.azureblob.auth=azureAd` (the value `azureAD` fails with `No enum constant AuthType.AZURE_A_D`), `jclouds.azureblob.account`, `jclouds.azureblob.tenantId`, `jclouds.oauth.credential-type=bearerTokenCredentials`, `jclouds.oauth.resource=https://storage.azure.com`, `credential=<token>`. STOW returned 200 and a listing from an in-cluster pod showed the blob (Content-Length 524,974). All load, QIDO/WADO and the Blob PUT probe ran on it. The token's lifetime is 89 minutes (JWT `exp - iat`, token not printed) and a static bearer has no refresh, so a descriptor like this stops working when the token expires. It needed the operator's identity to hold `Storage Blob Data Contributor` on the account (assigned for the test, removed afterwards) |
| Entra ID with a service principal (client secret or certificate) | **Not tried** | `CredentialType` in the shipped oauth jar lists `CLIENT_CREDENTIALS_SECRET` and `CLIENT_CREDENTIALS_P12_AND_CERTIFICATE`. That needs an app registration, which is outside the sandbox resource group. It would still put a long-lived secret in the descriptor |
| Managed identity | **Not established** | Not tested at runtime. A string search of the jclouds oauth jar for the IMDS address, `IDENTITY_ENDPOINT` and "managed identity" found nothing, and the shipped credential types are the four above. That is static evidence of no managed-identity flow in jclouds 2.7.0, not a failed attempt |
| Gov endpoint (`*.blob.core.usgovcloudapi.net`) | **Not measured** | A Gov receipt must come from a GitHub Actions run |

What this means for ADR-004 (input, not a decision): the Azure-native Blob path works end to end with CMK and a private
endpoint, **but only with a bearer credential that jclouds cannot refresh**, because this tenant's guardrails (shared
key off, public network off) are the same ones a regulated customer will have. Using the archive on Blob as shipped
needs one of: a descriptor refresher (a sidecar or CronJob that rewrites the LDAP property before expiry), a patched
or newer jclouds with a managed-identity flow, or a service-principal secret with its rotation burden. The filesystem
(PVC) path works as the fallback and was used to leave the sandbox in a working state.

#### Deploy script and probe defects found and fixed by running them

- The script's PostgreSQL step assumed a password env and a `pacsdb` database. It now takes an existing secret and a
  database name, and loads the schema with a one-shot Job (the arc image does not carry the SQL).
- The storage account was created without the CMK identity, the container was created over the data plane (impossible
  once public access is off), and nothing created the `privatelink.blob` zone or zone group.
- az 2.91 `private-endpoint dns-zone-group show` prints `{}` and exits 0 for a group that does not exist. The script's
  existence check believed it, so the group was never created. It now counts through `list` and asserts an A record.
- The arc Deployment had no readiness probe, so `rollout status` returned before the archive could serve.
- Registering the descriptor needs `ldapmodify` inside the LDAP pod (root password read by the pod, never by the script).
  An LDIF line wrapped at 78 characters, which put the tail of a storage key into an agent transcript during a
  debugging query. Both account keys were renewed straight afterwards; with shared key off they authorise nothing.
- Load driver: `curl -w` already prints a result line (code 000) when a connection fails, so the `|| printf` fallback
  printed a second line (measured: 1,006 WADO lines for 1,000 requests). Fixed, and `summarise` now dies when the line
  count differs from the requests sent. Mutation check: the old shape printed 2 lines for a refused connection, the new
  `emit` prints 1.
- A DEV run could have printed `ADR-002 STOW bar: PASS` because the report only looked at `env=sandbox`. The load
  script now records `profile=` and the report calls a run pass-bar evidence only when it is `class-s`. Mutation check:
  the same metrics rewritten to `profile=class-s` print `FAIL (p95=1041.38 ms > 300 ms ...)`, with `profile=dev` they
  print `NOT PASS-BAR EVIDENCE`.
- k8s LDAP restore check: busybox turns `sh -c 'cat > file'` into a bare `cat` that is killed when `kubectl exec` closes
  stdin, leaving a 0-byte file (`Copying stdin failed ... websocket: close sent`), which `slapadd` then reported as
  `Database number selected via -n is out of range`. The script now verifies the byte count of each pushed dump
  (a trailing `sync` keeps the shell alive). Before the fix the 0-byte transfer tripped the new byte-count check
  (`0 of 328977 bytes arrived`, three tries), and the earlier truncated config tripped the `slapadd` failure path.
  The `restored != dumped` comparison itself was never mutated, so it has not been shown to go red.

#### Sandbox state after the run

Archive pointed back at `fs1` (PVC), the `azure1` / `azure-ad1` descriptors and the `lhds-blob` secret deleted,
driver pod removed, role assignment removed, storage account keys renewed. Still present and billing while paused:
storage account `lhdsw0dicom83072b` (about 8 GB of test blobs, estimated from the instance and PUT counts, private endpoint, `privatelink.blob` zone and link), and
the PVCs `arc-storage` (32 Gi), `data-ldap-0`, `conf-ldap-0`.

## 4. Gov availability closure (W0-3)

**Receipt:** GitHub Actions run
[39887825372](https://github.com/fgarofalo56/csa-inabox/actions/runs/39887825372).

- Workflow `.github/workflows/health-w0-gov-probe.yml`, dispatched from `main`
  at `79141929f` (PR #5092, merged on the operator's approval 2026-10-22).
- Conclusion `success`. The job "Probe Azure Government availability
  (read-only)" executed 11 steps, so the run counts as a receipt.
- All 15 probes returned rc 0, per `status.tsv` in the run artifact.
- Identity: the existing Gov workflow identity, read-only calls only.
- Facts below come from the artifact, parsed locally on 2026-10-22.

### 4.1 PostgreSQL Flexible Server, usgovvirginia (Q1): NOT AVAILABLE to this subscription

`az postgres flexible-server list-skus --location usgovvirginia` returned one
capabilities record with:

- **zero** `supportedServerEditions`, **zero** `supportedServerVersions`, and
  **zero** storage editions;
- feature `OfferRestricted: Enabled`;
- `reason`: "Provisioning is restricted in this region. Please choose a
  different region. For exceptions to this rule please open a support request
  with Issue type of 'Service and subscription limits'."
- Zone-redundant HA is `Disabled`, as is zone-redundant HA with geo-backup.
  `GeoBackup` is `Enabled`.

Consequences:

- This contradicts `AZURE-GOV-AVAILABILITY.md`, whose PostgreSQL row reads
  "zone-redundant HA and geo-backup in Virginia only". For this subscription,
  Virginia offers no PostgreSQL at all until a support request lifts the
  restriction.
- E-series and SSD v2 cannot be assessed while zero SKUs are offered.
- Every LHDS engine (FHIR, DICOM metadata, terminology, MPI, audit index) sits
  on PostgreSQL. The Gov stamp is blocked on either (a) a support request for
  usgovvirginia, or (b) a region where this subscription is not restricted.

### 4.1b Run 2: all three Gov regions

Second run: [39892056208](https://github.com/fgarofalo56/csa-inabox/actions/runs/39892056208),
after #5094 added Arizona and Texas. Conclusion `success`, 11 steps, all 17
probes rc 0.

| Region | SKUs offered | E-series offered | `OfferRestricted` | Zone-redundant HA |
|---|---|---|---|---|
| usgovvirginia | 0 | none | **Enabled** (support request needed) | Disabled |
| usgovarizona | 31 | 15, all **v3/v4** | Disabled | **Enabled** |
| usgovtexas | 31 | 15, all **v3/v4** | Disabled | Disabled |

Consequences:

- The Gov stamp can run in **usgovarizona** today. Its zone-redundant HA makes
  it the better primary, and usgovtexas is its pair.
- Virginia needs a support request first.
- Gov offers no E-series v5, so class sizes must map to `Standard_E*ds_v4` in
  Gov (for example E8ds_v5 becomes E8ds_v4).
- Neither run showed `premiumv2` or `ssdv2` anywhere in the raw output. SSD v2
  for PostgreSQL is therefore not evidenced in Gov, and the design should plan
  on Premium SSD (R4).

### 4.2 Resource providers (all `Registered`), Gov locations per resource type

| Resource type | Gov/DoD locations listed |
|---|---|
| ContainerService/managedClusters | USGov Arizona, Texas, Virginia |
| DBforPostgreSQL/flexibleServers | USGov Virginia, Arizona, Texas (listed, but see 4.1: Virginia is restricted for this subscription) |
| Storage/storageAccounts | USGov Virginia, Texas, Arizona; USDoD East, Central |
| EventHub/namespaces, EventHub/clusters | USDoD Central, East; USGov Arizona, Texas, Virginia |
| ApiManagement/service | USDoD Central, East; USGov Arizona, Texas, Virginia |
| KeyVault/vaults | USGov Virginia, Texas, Arizona; USDoD Central, East |
| KeyVault/managedHSMs | USGov Virginia, Arizona, Texas; USDoD East |
| Cdn/profiles | `global` |
| Network/frontDoors (classic) | resource type absent |
| Network/privateEndpoints, Network/azureFirewalls | all five Gov/DoD regions |
| LoadTestService/loadTests | **resource type absent**: Azure Load Testing is not offered, so Gov load tests need in-cluster drivers |
| App/managedEnvironments, App/containerApps | USGov Virginia, Arizona, Texas (region listing only; this is not IL5 audit scope) |

### 4.3 Region pairing (`az account list-locations`)

usgovvirginia pairs with usgovtexas, usgovarizona with usgovtexas, and
usdodcentral with usdodeast.

### 4.4 AKS (`az aks get-versions`)

Kubernetes 1.31 through 1.37 are offered in usgovvirginia, usgovarizona and
usgovtexas alike.

### 4.5 Still open (not establishable read-only; stated in the workflow)

- **Event Hubs Premium orderability:** only the resource-type locations were
  read. That a namespace can be listed there does not prove the Premium SKU can
  be ordered.
- **KEDA add-on:** availability is not established, because there is no
  per-cloud read API for it.

## 5. No-calls-home / egress check (W0-4)

Scripts: `scripts/measure/health/egress-capture.sh`, `egress-report.sh` (authored on the
`feat/lhds-w0-no-cost` worktree, base `7da37991c`).

### 5.1 Status: 24 h pass-bar capture NOT EXECUTED (a bounded DEV capture is in 5.5)

The 24-hour capture, per candidate engine image, needs the class-S AKS sandbox with an isolated node
pool. **not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending.** No Azure resource was
created and no `az` command was run. The local Docker run did not attempt an egress capture: a
laptop's Docker Desktop network has no isolated pool, no CoreDNS under our control and a host stack
generating unrelated traffic, so any list from it would not be a result for this question.

| Engine image | FQDNs observed over 24 h | Classification |
|---|---|---|
| HAPI FHIR JPA | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending | not measured |
| Medplum server | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending | not measured |
| DICOM engine candidates (W0-2 images) | not measured yet: sandbox provisioned 2026-10-22 (DEV profile), engine run pending | not measured |

### 5.2 Method (what the scripts do when run against the sandbox)

Two independent witnesses, because each has a blind spot:
1. **CoreDNS query log.** `egress-capture.sh start` applies the AKS `coredns-custom` ConfigMap with
   `log.override: log`, restarts CoreDNS, and `stop` filters the log by the client IPs of pods in the
   engine namespace (pod IPs are snapshotted at start, after every restart via `snapshot`, and at stop,
   because DNS rows are keyed by pod IP). Catches every name resolved; blind to IP literals.
2. **Packet witness.** A `hostNetwork` netshoot pod on the isolated node runs tcpdump keeping only new
   outbound TCP SYNs and UDP to non-RFC1918/link-local destinations. Catches IP literals and non-CoreDNS
   resolution; yields IPs, not names.

Isolation premise: the engine namespace is scheduled only onto a node pool labelled
`loom.io/pool=egress-probe` and tainted `loom.io/egress-probe=true:NoSchedule`. `egress-capture.sh`
refuses to run if the named node does not carry that label.

`egress-report.sh` classifies each FQDN as `in-cluster` (`*.svc`, `*.cluster.local`), `azure` (a fixed
suffix list covering Commercial and Gov: `azure.com`, `azure.us`, `windows.net`, `microsoftonline.com`,
`microsoftonline.us`, `azurecr.io`, `azurecr.us`, `usgovcloudapi.net`, `azmk8s.io`, and a few others) or
`non-azure`. Any `non-azure` FQDN is a finding (W0-4 verify rule).

### 5.3 Controls (assertion-design) and what was actually run

Exit codes of `egress-report.sh`, each named by the input that produces it, exercised on **hand-written
fixture lists in `temp/lhds-w0/l1/egress-fixtures/`. These are tests of the report script, not
measurements of any engine.**

| Fixture input | Expected | Observed |
|---|---|---|
| empty file | exit 2 (logging not wired, not a clean result) | exit 2 |
| only a `#` comment line | exit 2 | exit 2 |
| in-cluster + two Azure Gov names | exit 0 | exit 0 |
| in-cluster + Azure + `sentry.io` | exit 10 (finding) | exit 10, `sentry.io` classed non-azure |
| two Azure names, no in-cluster name | exit 3 (positive control fails) | exit 3 |
| nonexistent file | exit 1 | exit 1 |

`egress-capture.sh stop` additionally fails if 0 DNS rows come from engine pod IPs, so an unwired
capture cannot reach the report as an empty-but-clean list. `bash -n` and `shellcheck -x` are clean on
both scripts. `egress-capture.sh` itself was NOT executed (no cluster), so the `coredns-custom` log
format regex, the tcpdump filter and the `log.override` behaviour are **untested**; the DNS log-line
format used by the parser is CoreDNS's documented default and has not been checked against a real AKS
CoreDNS log.

### 5.4 Gaps to close at execution time

- The PRP asks for a positive control of "the Azure FQDNs every pod must reach". The report enforces an
  in-cluster name instead (every engine pod resolves its database service). Azure FQDNs reached by the
  node (ACR image pull, AKS control plane) are kubelet-level and do not appear in pod DNS, so a
  pod-keyed Azure positive control may legitimately be empty; the operator should decide whether to add
  Workload Identity token endpoint (`login.microsoftonline.*`) as a required entry once the pods use it.
- Azure Firewall / NSG flow logs were considered as an alternative witness and not scripted: they need a
  firewall or Log Analytics workspace in the sandbox (extra cost) and add no information over DNS plus
  tcpdump for a 24 h single-node capture.
- tcpdump packet output lists destination IPs only; mapping them back to names (for IP-literal calls) is a
  manual step in `packets-nonprivate.txt` and is not automated.

### 5.5 DEV run (2026-10-23)

**DEV: function proof, bounded window, not the 24 h pass-bar capture.** Sandbox `rg-lhds-w0-sandbox-cus` (centralus,
Commercial only; Gov not measured). Isolated pool `egressprobe` (1x D4s_v5, scaled 0 to 1 with `az aks nodepool scale`
because `sandbox.sh up` would also rewrite the budget, PostgreSQL and Key Vault settings; scaled back to 0 and read back
as 0). Each engine ran alone, pinned to the pool with `LHDS_EGRESS_PROBE=yes` (additive flag in both deploy scripts; the
dcm4chee manifests rendered with it differ from Lane 1's applied manifest by exactly two scheduling lines per pod spec).
Raw logs, pcap text and per-engine reports are under `temp/lhds-w0/egress/` (not committed).

**Windows (UTC).** Each engine: startup, a short load burst, then at least 30 minutes with no traffic from us.

| Engine | Capture | Ready | Burst | Idle (no traffic from us) |
|---|---|---|---|---|
| HAPI 8.12.0 | 22:02:18 to 22:36:00 (33 m 42 s) | 22:03:31 | 22:03:34 to 22:04:10: 8 bundles, 5,039 resources, 2 threads, then 6 reads (all 200) | 22:04:13 to 22:35:53 (31 m 40 s) |
| Medplum 5.2.7 + Redis 7 | 22:36:46 to 23:10:17 (33 m 31 s) | 22:37:24 | 22:37:26 to 22:38:28: same 8 bundles, 2 threads, 6 reads (all 200) | 22:38:29 to 23:10:09 (31 m 40 s) |
| dcm4chee-arc 5.35.2 + slapd | 23:10:28 to 23:44:18 (33 m 50 s) | 23:11:39 | see below | 23:14:00 to 23:44:11 (30 m 12 s) |

dcm4chee burst: phase A (default `fs1` storage) 100 STOWs at 5 senders, 100/100 returned 200, then the load script's
own check stopped it ("instance count rose by 99 but 100 STOWs returned 200", not investigated; probably a seed-42
instance that already existed, unconfirmed), so its QIDO/WADO steps did not run. Phase B registered an `azureblob`
descriptor with a **placeholder credential** (not a secret; it exists only to make the archive dial the Blob private
endpoint), restarted the archive, and sent 20 STOWs: 0/20 succeeded, as expected. Then a manual read burst at 23:13:59:
QIDO studies/series/count 200 x3, WADO metadata and retrieve of one study 500 x2 (probably that study's recorded
location is the Lane 1 Blob descriptor, now placeholder-credentialed; not verified). The AE was set back to `fs1` and
the descriptor deleted after the capture.

**Disclosure: a window this short can miss periodic check-ins.** A daily or hourly update check, license ping or
telemetry flush on a timer will not fire inside about 31 minutes of idle. A clean row below means "nothing in this
window", not "never". That gap is the reason the class-S 24 h run exists, and this run does not close it.

**Result per engine** (full FQDN and IP tables in the per-engine `report.txt`):

| Engine | Real FQDNs resolved by the pods (search-path noise excluded) | Non-Azure FQDN | Engine-sourced external IPs | Positive control |
|---|---|---|---|---|
| HAPI | `pg-lhdsw0-83072b.postgres.database.azure.com` only | 0 | 0 | required PG FQDN present; report exit 0 |
| Medplum + Redis | PG FQDN; `redis.lhds-w0.svc.cluster.local`; **`meta.medplum.com`**; **`api.pwnedpasswords.com`** | **2** | **2** (`3.169.149.32` for meta.medplum.com, `104.17.175.230` for api.pwnedpasswords.com, 1 SYN each) | PG FQDN present; report exit 10 (finding) |
| dcm4chee-arc + slapd | PG FQDN; `lhdsw0dicom83072b.blob.core.windows.net`; `ldap.lhds-w0.svc.cluster.local` | 0 | 0 | both required FQDNs present; report exit 0 |

**Findings (non-Azure first).**
1. **Medplum -> `meta.medplum.com`**, one A+AAAA lookup and one TCP 443 connection at 22:37:20, before the server
   reported Ready (22:37:24). Cause is inferred from timing (a startup version or metadata check); the Medplum source was
   not read. No second connection in the idle window.
2. **Medplum -> `api.pwnedpasswords.com`**, one lookup and one connection at 22:37:29, seconds into the load step, when
   `fhir-engine-medplum-token.py` registered a throwaway project and user. Cause is inferred from that timing (a
   breached-password check on user registration); the code was not read. It is therefore triggered by our own harness
   registering a user, but any Medplum deployment that lets a user set a password would make the same call. Whether
   Medplum fails open or closed when this host is unreachable (the Gov and IL5 case) was **not tested**.
3. HAPI and dcm4chee-arc/slapd made no non-Azure call in their windows. dcm4chee's `blob.core.windows.net` lookup is
   Azure-required and appears only because of the placeholder descriptor in phase B.

**Kubelet, CNI and DaemonSet destinations (listed apart, never merged into the engine rows):** 28 flows on the HAPI
capture, 30 on Medplum, 31 on dcm4chee. Identified: image pulls from `registry-1.docker.io` and `auth.docker.io`
(HAPI, Medplum, Redis and dcm4che images are all Docker Hub), `mcr.microsoft.com`, Azure Monitor, Azure Front Door, the
node's `168.63.129.16` wire server and unnamed `AzureCloud.centralus` addresses. Many CDN IPs are unnamed because the name was resolved after the
capture and the CDN had rotated, so they are not attributed to any process. Note the node-level rows are not an engine
finding, but a Gov or IL5 boundary without a Docker Hub path needs the images in ACR first.

**Controls and what would break them.**
- *Canary:* before any engine, a pod on the probe pool fetched `example.com` and `login.microsoftonline.com`. Both
  witnesses saw it: CoreDNS logged both names (`example.com` classed non-azure), tcpdump showed `104.20.23.154` and
  `172.66.147.243` as NON-AZURE and `20.190.155.1` as `AzureCloud.centralus`. The report on that canary-only capture
  exited 3 (no required name, no in-cluster name), so the control bites an empty-of-engine capture. Value that would
  break the capture: a filter that dropped the pod IP, as happened with the namespace-wide snapshot (below).
- *Required FQDN list (new, exit 4):* the PG FQDN, plus the Blob FQDN for dcm4chee. A list missing either fails instead
  of reporting "no calls home". Fixtures: required name absent -> 4, present -> 0.
- *Report fixtures* (`temp/lhds-w0/egress/fixtures/`, tests of the scripts): 9 cases for `egress-report.sh` (empty 2,
  comment-only 2, clean 0, finding 10, no in-cluster name 3, expansion-only 3, required missing 4, missing file 1) and 6
  for `egress-ips.py` (banner-only capture 2, engine to non-Azure 11, engine to Azure 0, node-level non-Azure 0, no
  service-tag file 11, missing file 1). All 15 as expected.
- *Mutation, on a sandbox copy* (tracked file hash unchanged afterwards): with the search-expansion rule disabled the
  expansion-only fixture returns 10 instead of 3 (RED); with the required-FQDN check disabled the missing-Blob fixture
  returns 0 instead of 4 (RED). Neither mutant is blind. The IP script's classification was not mutated.

**Limits of the witnesses.** tcpdump keeps only non-RFC1918 destinations, so PostgreSQL and the Blob private endpoint
are visible through DNS only. IPv6 is not captured. The in-cluster control is now a fallback used only when no required
FQDN is given: HAPI resolves no in-cluster name, so the old "must contain an in-cluster name" control failed on a good
HAPI capture. A search-path expansion whose bare name is missing from the list would still count as in-cluster
(fixture-tested boundary).

**Defects found in the scripts by running them (all fixed in this commit).**
- `logs deployment/coredns` read ONE of two CoreDNS replicas, so half the queries would be missing; it now reads every
  replica since the capture start.
- Pod IPs were snapshotted for the whole namespace, which would include the load client's apt and pip lookups; it is now
  pods of the namespace that run on the probe node.
- CoreDNS search-path expansions (`<name>.<ns>.svc.cluster.local`, `.cluster.local`, `.internal.cloudapp.net`) satisfied
  the in-cluster control: on the canary capture all three "in-cluster" names were expansions of `example.com` and
  `login.microsoftonline.com`. Expansions are now a separate class, recognised by the bare name being in the list.
- Windows Python wrote CRLF into `fqdns.txt`, so the later `dig` name-to-IP map came out empty without any error;
  fixed with `newline="\n"`.
- `coredns-custom` already exists on AKS (applied over it; `cleanup` now removes only our key, never the ConfigMap).
- The scripts had no analysis of the packet witness at all; `egress-ips.py` now classifies destination IPs against the
  Azure service tags (`az network list-service-tags`) and splits engine, node and other-pod sources.

**Sandbox state after the run.** Engines, Redis and LDAP at 0 replicas, driver and client pods removed, `coredns-custom`
log key removed, `egressprobe` read back as 0, AKS and PostgreSQL stopped (status quoted in the lane report).

## 6. Synthea generation throughput and cohort manifests (W0-5)

Scripts (base `7da37991c`, branch `feat/lhds-w0-no-cost`; uncommitted at the time of writing):
`scripts/measure/health/synthea-{generate,manifest,upload}.sh`.

**Status: the in-pool measurement was NOT performed** (no Azure spend, operator decision 2026-10-22; no AKS pool exists).
Everything below is a laptop smoke and is **not** pool evidence.

| Cell | Value |
|---|---|
| Synthea throughput in the pool (patients/hour) | not measured: no pool |
| Largest cohort reachable in 48 h | not measured: no pool |
| Cohort manifests stored in Blob | not performed: `synthea-upload.sh` is a separate explicit opt-in step that needs a storage account and subscription env var (no default) and was not run |

### 6.1 Laptop smoke (NOT pool)

Environment: Windows 11 laptop, Docker Desktop (8 CPUs, ~37 GiB), `eclipse-temurin:17-jre` container
`lhds-w0-l2-synthea`, the dcm4chee smoke stack idling alongside. Synthea release **v4.0.0**
(`synthea-with-dependencies.jar`, sha256 `ed43c20ad40ba5c3bc724503a5af032715fe3c491620b766148e7c2361e6ecc1`, pinned and
checked by the script), seed 20261022 (`-s` and `-cs`), reference date 20261022 (`-r`), state Massachusetts,
FHIR R4 export, default thread count. Measured 2026-10-22.

| Cell (laptop, NOT a pool) | Run A | Run B |
|---|---|---|
| Patients requested (`-p`) | 30 | 30 |
| Patient bundles produced (files that are not hospital/practitioner) | 31 | 31 |
| Wall time, including JVM start and module load | 39.0 s | 25.4 s |
| Patients/hour (patient bundles / wall time x 3600) | 2,862 | 4,394 |
| FHIR resources (textual `resourceType` count, incl. 33 Bundle wrappers) | 34,568 | 34,568 |

Reading these: a 30-patient run is dominated by fixed JVM/module startup, so patients/hour here **understates**
steady-state throughput, and the 1.5x spread between two identical runs (the only difference is the machine's
background load) shows the figure is not stable at this size (cause not isolated; laptop background load is the suspect, unmeasured). 31 bundles for 30 requested is Synthea counting only
living patients against `-p` while also exporting the deceased. Neither number supports a 100 M-patient
extrapolation, and none is made.

Resource counts by type (run B): Observation 12,068; Procedure 3,122; DiagnosticReport 2,858; Claim, Coverage,
ExplanationOfBenefit and ServiceRequest 2,379 each; Condition 991; MedicationRequest 909; Encounter and
DocumentReference 1,470 each; Immunization 452; Patient 31; the rest are below 400 (full list in the manifest).

### 6.2 Manifest and its checks

`synthea-manifest.sh` wrote `manifest.json` (seed, Synthea version, jar sha256, host label, counts by type, one
sha256 per file; 33 files) and `manifest.sha256` (hash over the sorted per-file sha256 values) beside each cohort.
Controls run, each exiting 1: a cohort whose only bundle has no Patient (count 0); an empty `fhir/` directory; a
cohort whose Patient count (1) differs from the generation record (31 bundles).

Findings:
- **A fixed seed did not give byte-identical cohorts.** Runs A and B: the hospital and practitioner files hash
  identically and 30 of 31 patient bundles are byte-identical; one bundle differs (CarePlan content). Their
  manifest hashes differ for that reason. Cohort identity is therefore the **manifest hash**, not the seed. (File
  names also differ: hospital/practitioner files carry a wall-clock timestamp, so the manifest hash deliberately
  excludes file names.)
- The first draft of the generator wrote a record that the manifest step could not source when the host label held
  spaces or parentheses; found by running it and fixed (values are now shell-quoted).

### 6.3 DEV run (2026-10-23)

Labelled **DEV (1x D8s_v5, PG D2ds_v5): function proof, not pass bar.** The in-pool cells of section 6 (throughput in the
pool, largest cohort in 48 h) remain **not measured**: generation ran on the laptop, not on the AKS node, because the node
was the engine and database host for W0-1 and the brief allowed the local docker runner.

| Cell | Value |
|---|---|
| Host (`SYNTHEA_HOST_LABEL`) | `laptop-docker (Docker Desktop 8 CPU, eclipse-temurin:17-jre, NOT the AKS pool)`, `-Xmx6g`, default thread count |
| Synthea | v4.0.0 `synthea-with-dependencies.jar`, sha256 `ed43c20ad40ba5c3bc724503a5af032715fe3c491620b766148e7c2361e6ecc1` (downloaded to a clean directory and verified against the pin before use) |
| Seed / reference date / state | 20261022 (`-s` and `-cs`) / 20261022 / Massachusetts, FHIR R4, 10 years of history |
| Requested (`-p`) / patient bundles produced | 1,000 / 1,129 (Synthea exports the deceased on top of the 1,000 living) |
| Wall time (JVM start included) | 136.0 s |
| Throughput | **29,885 patient bundles/hour** (1,129 / 136.0 s); 26,471 living patients/hour (1,000 / 136.0 s). Laptop figure |
| Output | 1,131 files (2 shared + 1,129 patient bundles), 4.0 GB, 1,682,303 textual `resourceType` occurrences including 1,131 `Bundle` wrappers (about 1,490 per patient bundle); Patient 1,129, Observation 605,235, DiagnosticReport 135,889, Procedure 145,228, Claim 122,108, Encounter 68,925 |
| Manifest hash (sha256 of the sorted per-file sha256 list) | `8599c65c7ee33fc761485c0eed5cf8567b6c2d6185c808b2e13051c1fdc26065` |
| Manifest in Blob | `lhdsw0dicom83072b/lhds-w0-cohorts/8599c65c.../manifest.json` and `manifest.sha256`: both PUT returned 201 and the read-back sha256 equals the local file's. The 4 GB of bundles were NOT uploaded |

`synthea-upload.sh` as written (`az storage blob upload-batch` from a workstation) **cannot reach this account**: public
network access is policy-disabled and shared-key access is off, so the manifest went up in-cluster, from the `fhir-client`
pod with `curl` PUT and an Entra bearer token fed over stdin (never printed, not stored). That path is ad hoc, not a script in
the repo; the upload script needs an in-cluster mode before class S.

Cohort selection for the engines: the two shared bundles and the first 50 patient bundles by C-locale name (254 MB). The
1,000-patient cohort itself was not loaded into either engine; at the measured Medplum import rate of about 147 res/s the 1.68 M
resources would take about 3.2 hours, and about 53 minutes on HAPI at 529 res/s, on this DEV node.

Reading these: one generation run, so no run-to-run spread and no reproducibility check at this size (the section 6.1 finding
that a fixed seed is not byte-identical was not re-tested). 1,000 patients amortise JVM start better than the 30-patient smoke
(2,862 to 4,394 patients/hour) and this figure is 7x to 10x higher; amortised start-up is the likely reason, not isolated
(a different Synthea heap setting and laptop background load also differ). No 100 M-patient extrapolation is made.

## 7. Loom integration measurements (W0-6)

Measured 2026-10-22 at `origin/main` = `b192f05ea347086c772af1cb876d94fc845083c8`
(confirmed with `git fetch` + `git rev-parse origin/main`), read with
`git grep -n <pat> b192f05ea... -- <paths>` and `git show b192f05ea:<path>` run
from the repo root `E:/Repos/GitHub/csa-inabox-lhds-w0` (not the working tree,
which is the docs branch). No Azure resource touched, no `az` run, no workflow
dispatched. Paths below are repo-relative and refer to that SHA.

### 7.1 Summary

| # | Fact | Measured at b192f05ea | PRP assumption | Verdict |
|---|---|---|---|---|
| 1 | `backingStore` field exists in code | No. 0 hits in `apps/fiab-console/lib/catalog`; only a comment mentioning it as future work at `apps/fiab-console/lib/governance/backing-resolver.ts:85` | `LOOM-INTEGRATION.md:19-20`: "populated once the governance-autopilot W2 field lands (that PRP adds `backingStore`)" | CONFIRMED (not yet landed; W2 still ahead) |
| 2 | `ESTATE_PAUSE_TIER` entries | 10 entries, `apps/fiab-console/lib/estate/pause-tier.ts:27-41` | `LOOM-INTEGRATION.md:102` and `OPERATIONS-AND-BCDR.md:182`: AKS managed clusters and Container Apps are in the tier | CONFIRMED |
| 3 | `apimSku` usage | Required param (no default) `platform/fiab/bicep/main.bicep:64`; see 7.4 | `AZURE-GOV-AVAILABILITY.md:37,67`, `RISKS-AND-OPEN-DECISIONS.md:15`: Loom parameterises `apimSku`; classic Premium in Gov | CONFIRMED |
| 4 | `boundary` enum | `@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])` at `platform/fiab/bicep/main.bicep:20` (param at :21); no `DoD` | `ARCHITECTURE.md:174`, `RISKS-AND-OPEN-DECISIONS.md:12`: enum lacks DoD at `main.bicep:20` | CONFIRMED |
| 5 | `containerPlatform` per param file | All 7 param files set `'containerApps'`; none sets `'aks'`; see 7.5 | `adr/ADR-009-compute-platform-aks.md:7-8`: ContainerApps in every boundary file incl. IL5 (`il5.bicepparam:121`). BUT `ARCHITECTURE.md:88-90` and `AZURE-GOV-AVAILABILITY.md:23`: "AKS at IL5/DoD (existing `containerPlatform` switch)" | CONTRADICTED within the PRP set, see 7.5 |
| 6 | GHSA-g7m7 existence and deploy state | Advisory exists, state `draft` (private, unpublished). Fix deploy: see 7.6 | `RISKS-AND-OPEN-DECISIONS.md:48` (Q7) and `OPERATOR-DECISIONS-2026-10-22.md:38`: "not yet verified" | Q7 partly established, see 7.6 |
| 7 | #4584 state | OPEN, closedAt null | `LOOM-INTEGRATION.md:76`, `RISKS-AND-OPEN-DECISIONS.md:59`: Gov image lanes lack Trivy/cosign | CONFIRMED |

### 7.2 Fact 1 - `backingStore` (governance-autopilot W2)

- `git grep -n "backingStore" b192f05ea` over the whole repo returns 6 lines:
  5 are in `PRPs/active/governance-autopilot/PRP.md` (lines 96, 121, 249, 397;
  line 96 says the catalog "has **no `backingStore` field**") and 1 is
  `apps/fiab-console/lib/governance/backing-resolver.ts:85` (a doc comment: "W2
  adds the key (the `backingStore` field on the item catalog)").
- `git grep -n backingStore b192f05ea -- apps/fiab-console/lib/catalog` returns 0 hits.
  Positive control (same two files where W2 would add the field,
  `lib/catalog/fabric-item-types.ts` and `lib/catalog/item-types/types.ts`):
  `git grep -c "FabricItemType"` finds 6 and 2 matches respectively, so the
  pathspec resolves and the zero is real.
- Conclusion: the field does not exist in code at main; it is planned work
  (governance-autopilot W2, `PRPs/active/governance-autopilot/PRP.md:397`). LHDS
  must not read `backingStore` before that PRP's W2 merges. Related existing
  seam: `BACKED_WITHOUT_DOCUMENTED_KEY` in `backing-resolver.ts:87`.

### 7.3 Fact 2 - `ESTATE_PAUSE_TIER`

`apps/fiab-console/lib/estate/pause-tier.ts:27-41` at b192f05ea, 10 entries
(lower-cased ARM types):

1. `microsoft.synapse/workspaces/sqlpools` (:28)
2. `microsoft.kusto/clusters` (:29)
3. `microsoft.analysisservices/servers` (:30)
4. `microsoft.compute/virtualmachinescalesets` (:31)
5. `microsoft.compute/virtualmachines` (:35)
6. `microsoft.containerservice/managedclusters` (:36)
7. `microsoft.app/containerapps` (:37)
8. `microsoft.streamanalytics/streamingjobs` (:38)
9. `microsoft.web/sites` (:39)
10. `microsoft.databricks/workspaces` (:40)

(Lines 28-31 hold 4, lines 35-40 hold 6.) `OUT_OF_TIER_REASONS` is an
empty record (:48). Consequences for LHDS: AKS clusters and Container Apps are
already in the tier, as the PRP assumes. PostgreSQL Flexible Server
(`microsoft.dbforpostgresql/flexibleservers`) and Event Hubs namespaces are NOT
in the tier, so only the AKS cluster of a stamp would be touched by idle
auto-pause; the PRP's `health-stamp` guard is needed for exactly that reason.
Test pin: `lib/estate/__tests__/pause-orchestrator.test.ts:679`.

### 7.4 Fact 3 - `apimSku`

At b192f05ea, `git grep -n apimSku -- platform/`:

| Where | file:line | Value |
|---|---|---|
| Declaration, required, no default, `@allowed(['PremiumV2', 'Premium'])` | `platform/fiab/bicep/main.bicep:62-64` | n/a |
| Passed to admin-plane | `platform/fiab/bicep/main.bicep:1306` | n/a |
| Admin-plane param | `platform/fiab/bicep/modules/admin-plane/main.bicep:42` | n/a |
| Used as APIM `sku` | `platform/fiab/bicep/modules/admin-plane/main.bicep:3797` | n/a |
| `params/commercial-full.bicepparam:17` | | `PremiumV2` |
| `params/commercial.bicepparam:107` | | `PremiumV2` |
| `params/gcc.bicepparam:131` | | `PremiumV2` |
| `params/tenant-dmlz.bicepparam:54` | | `PremiumV2` |
| `params/gcc-high.bicepparam:125` | | `Premium` |
| `params/il5.bicepparam:123` | | `Premium` |
| `params/dlz-attach.bicepparam` | no `apimSku` line | not set (DLZ-attach topology) |

Separate, unrelated param `apimSkuName` (default `'Developer'`) at
`main.bicep:934`; do not confuse. Matches the PRP's "classic Premium in Gov".

### 7.5 Fact 4 and 5 - `boundary` enum and `containerPlatform` per param file

`boundary`: `platform/fiab/bicep/main.bicep:20` is
`@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])`, param at :21. The same
four-value list is repeated as a single-line decorator in 18 module files under `platform/fiab/bicep/modules/` (`git grep -l` gave 19 files including `main.bicep`), plus a multi-line list in `modules/copilot/copilot-chat-function.bicep` and a narrower `['GCC-High', 'IL5']` in `modules/copilot/maf.bicep:49`
(for example `admin-plane/main.bicep:10`, `landing-zone/main.bicep:10`), so
adding `DoD` (decision D3) is an edit in every one of those decorators, not only
`main.bicep`. Zero-hit control: `git grep -n "'DoD'" -- platform/fiab/bicep/main.bicep`
returns 0, and `git ls-tree` for `params/dod.bicepparam` returns 0 entries, while
the same `main.bicep` line :20 contains `'IL5'` and `params/il5.bicepparam`
exists, so the pathspec is valid and DoD is genuinely absent.

`containerPlatform`: declared at `platform/fiab/bicep/main.bicep:54-56`,
`@allowed(['containerApps', 'aks'])`, **no default** (a param file must set it).
Population: `git ls-tree -r --name-only b192f05ea -- platform/fiab/bicep/params/`
lists exactly 7 files; all 7 set it, so no default applies to any of them.

| Param file | `boundary` | `containerPlatform` | file:line |
|---|---|---|---|
| `commercial-full.bicepparam` | Commercial | `containerApps` | :15 (boundary :9) |
| `commercial.bicepparam` | Commercial | `containerApps` | :100 (boundary :94) |
| `gcc.bicepparam` | GCC | `containerApps` | :108 (boundary :102) |
| `gcc-high.bicepparam` | GCC-High | `containerApps` | :123 (boundary :110) |
| `il5.bicepparam` | IL5 | `containerApps` | :121 (boundary :107) |
| `tenant-dmlz.bicepparam` | Commercial | `containerApps` | :52 (boundary :34) |
| `dlz-attach.bicepparam` | Commercial | `containerApps` | :44 (boundary :37) |

Count: 7 of 7 files `containerApps`, 0 of 7 `aks`, 0 of 7 unset. (The
`main.bicep:55` description text, "AKS (GCC-H/IL5)", is a comment and is
contradicted by the params; the `il5.bicepparam:121` and `gcc-high.bicepparam:123`
comments say ACA is GA in USGov.)

**PRP assumption check - CONTRADICTED inside the PRP set.**
- Assumes AKS at IL5 via the existing switch: `ARCHITECTURE.md:88-90` ("an AKS
  Deployment at IL5, via the existing `containerPlatform` switch"),
  `AZURE-GOV-AVAILABILITY.md:23` ("AKS at IL5/DoD (existing `containerPlatform`
  switch)"), `LOOM-INTEGRATION.md` (W1-3 row in `W01-control-plane-identity-stamp.md:29`
  "AKS Deployment at IL5 via `containerPlatform`").
- Measured: `params/il5.bicepparam:121` is `containerApps`. The switch exists but
  no shipped boundary file selects `aks`.
- The PRP set already knows part of this: `adr/ADR-009-compute-platform-aks.md:6-8`
  cites `il5.bicepparam:121` and `gcc-high.bicepparam:123` as `containerApps`. So
  ADR-009 is consistent with the measurement; ARCHITECTURE.md, AZURE-GOV-AVAILABILITY.md
  and W1-3 are not. Implication for W1-3: running the control plane on AKS at IL5
  means either an `il5.bicepparam` flip of `containerPlatform` (which changes the
  whole Loom admin plane, not only LHDS) or a separate health-only AKS path; the
  wording "via the existing switch" understates that. Left for the W0-7 decision
  pass; not edited here.

### 7.6 Fact 6 - GHSA-g7m7 existence and deploy state (existence only)

Public repo: this section deliberately carries no advisory body, no fix PR
number, no commit and no affected-component description (operator convention:
public surfaces stay neutral until patched AND deployed on every estate).

- Existence: a private advisory with the `g7m7` id prefix exists, `state: draft`
  (unpublished), read 2026-10-22 via the repository security-advisories API; only
  the id and state fields were read.
- Commercial: the candidate fix is an ancestor of `b192f05ea`, and the live
  Commercial console build marker reported `sha=b192f05ea...` on 2026-10-22, so
  "candidate fix contained in the live Commercial build" is established. The
  fix-to-advisory link and the measurement detail are held by the operator, not
  recorded here.
- Not established: (a) that the candidate fix is the complete fix (needs the
  advisory body / operator); (b) the deployed state on the Gov consoles
  (GCC-High, IL5), which needs a GitHub Actions read, not a workstation call.
  Q7 asks about every estate the sink runs on, so it is only partly answered and
  the `health-lakehouse-isolation` gate stays as written for Gov.

### 7.7 Fact 7 - issue #4584

`gh issue view 4584 --json state,title,closedAt,number` (2026-10-22):
`state: OPEN`, `closedAt: null`, title "cloud-parity: the Gov runner-image lane
builds and pushes with NO supply-chain gate - 0 trivy, 0 cosign, against 9/36 on
Commercial". Confirms `LOOM-INTEGRATION.md:76` and `RISKS-AND-OPEN-DECISIONS.md:59`
(R3, Q8). Not re-measured: whether the lane still has 0 trivy / 0 cosign today
(the issue title is the issue's claim, not my count).

### 7.8 Not measured

- Gov (GCC-High, IL5) deploy state of the lakehouse-isolation fix (7.6 b).
- Whether the candidate fix is the complete fix (7.6 a).
- Current trivy/cosign counts on the Gov image lane (7.7).
- Nothing here exercises a deploy; these are source and metadata reads.

## 8. Decision (W0-7)

**Not started.** ADR-001, ADR-002, ADR-003 and ADR-004 stay at `Proposed`.
`CAPACITY-MODEL.md` section 1.3 is unchanged. Moving any of these on local-smoke
numbers would claim a result this receipt did not establish.

What the decision pass needs:

1. Engine runs on the DEV sandbox (function). Then the operator's approval of
   class S for the pass-bar numbers: same script, env overrides.
2. The sandbox run of W0-1, W0-2, W0-4 and W0-5, using the scripts in
   `scripts/measure/health/`. Load drivers run as Linux pods, not Git Bash.
3. Q1 is answered by measurement (section 4.1b): usgovarizona as the Gov
   primary, usgovtexas as its pair, and v4 E-series in place of v5. A support
   request is still needed if the operator wants Virginia.
4. Questions for the decision pass to carry from the local findings:
   - Is 4.5 KB per resource realistic, or should the capacity model move toward
     the roughly 10 KB measured here and cited by ADR-001?
   - Does dcm4chee's Blob storage work with managed identity at all?
   - Does Medplum keep failed transactions atomic, and does its rate limiting
     shape the W6 export design?

The tracking issue and the W1 bicep issue named in W0-7 are not filed. They are
filed at the decision pass.
