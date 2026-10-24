# LHDS — Capacity model (all-VA and all-IHS), stamp sizing and cost order of magnitude

Every input is either **CITED** (URL in `research/scale-evidence-va-ihs-dicom-pricing.md`,
retrieved 2026-10-22, publication year noted there) or an **ASSUMPTION**
(stated, with the reason, and replaced by a W0 or W7 measurement). Derived
numbers are arithmetic on those inputs and are reproducible from this file.
Nothing here is a measurement of LHDS; W0 and W7 produce the first measurements.

## 1. Demand inputs

### 1.1 VA / VHA (CITED unless marked)

| Input | Value | Basis |
|---|---|---|
| Enrolled veterans | 9.1 M (2025) | va.gov budget documents |
| Unique patients treated per year | 7.67 M (2025), 8.12 M projected (2027) | FY2027 Budget in Brief |
| Outpatient visits per year | 154.5 M (2025), 169.9 M (2027) | same |
| Inpatients treated per year | 1.25 M (2025) | same |
| Medical centers / outpatient sites / VISNs | 170-172 / ~1,200 / 18 | va.gov, VISN list |
| VistA instances | ~130 | GAO (snippet; **UNVERIFIED** page) |
| VistA Imaging | 10 B images stored by 2019, ~1 B images/yr, 650+ DICOM device models | va.gov VistA Imaging page |
| Radiology exams per year | 10-12 M | VA NTP PACS PIA (**UNVERIFIED**: page 404 at retrieval) |
| Imaging archive size | 1 PB at 1 B images (2009) -> **ASSUMPTION** 16-17 PB today (linear with image count; modern CT/MR are larger, so this is a floor) | research file section A |
| EHR modernization | Oracle Health at 6 sites (Dec 2025), 13 planned 2026, ~170 by 2031 | GAO-26-108812 |

### 1.2 IHS (CITED unless marked)

| Input | Value | Basis |
|---|---|---|
| Service population | 2.8 M American Indian / Alaska Native | IHS Profile (Oct 2024) |
| Areas / service units / urban programs | 12 / 170 / 41 | same |
| Facilities | IHS 21 hospitals + 52 health centers; tribal 22 hospitals + 331 health centers (plus other site types) | same |
| Outpatient visits / admissions per year | 15.29 M / 37,201 (FY2024) | FY2027 Congressional Justification |
| RPMS sites | ~430 facilities | same |
| Imaging volume | not published -> **ASSUMPTION** scaled from VA by visit ratio (15.3/154.5 ~ 1/10) | — |
| Modernization | PATH EHR (GDIT + Oracle Health), awarded Nov 2023, first pilot live Sept 2026 | research file |

### 1.3 Per-patient and per-event factors

| Factor | Value | Basis |
|---|---|---|
| FHIR resources per synthetic lifetime patient | 1,123 (112.3 M resources / 100 k patients) | arXiv 2607.23619 (Synthea 100 k cohort) — CITED. **W0 DEV observed** about 1,490 per patient bundle (Synthea v4.0.0, 10-year history, 1,129 bundles; `W0-RECEIPT.md` s6.3). Different generator settings, so the cited value is kept |
| Bundle size per Synthea patient | ~178 KB gzipped (17.8 GB / 100 k) | same. W0 DEV: not measured gzipped (s6.3 records 4.0 GB uncompressed for 1,131 files) |
| **DEV-MEASURED (on disk) / ASSUMPTION (raw)** average stored FHIR resource | 1.5 KB raw (ASSUMPTION, not measured); **about 10 KB on disk for HAPI** (W0 DEV: HAPI 9,952.7 B, Medplum 7,705.3 B net per resource, indexes included; 92,551 Synthea resources, not 1 M patients). Replaces the 4.5 KB assumption (W0-7 decision 2026-10-24) | **DEV**, `W0-RECEIPT.md` s1.3. The class-M value at 1 M patients is unmeasured and goes to W7. Section 2's "40 B x 4.5 KB" row, and every FHIR-store size built on it, still uses 4.5 KB. Those sizes understate FHIR storage by about 2.2x until they are re-derived (follow-up) |
| **ASSUMPTION** resources per outpatient visit / inpatient stay | 60 / 500 (encounter, conditions, observations incl. vitals and labs, medications, procedures, documents, claims) | to be replaced by W5 converter measurements on VistA-shaped feeds. W0 DEV: not measured |
| **ASSUMPTION** reads per write | 20 (clinician workflows, apps, population queries) | AHDS publishes no RPS. W0 DEV: not measured. The L1 mix used 5 % writes as an *input* (`W0-RECEIPT.md` s2.1), so it does not measure this ratio. Goes to W7 |
| **ASSUMPTION** peak-to-average | 5x (business hours, Monday peaks) | W0 DEV: not measured |
| DICOM study size, typical | CR/DX 15 MB; CT 500 MB (cardiac CT up to 3 GB); MR 400 MB; US 50-200 MB; DBT 1.5 GB; PET-CT 2 GB; WSI ~15 GB raw / ~300 MB JPEG 2000 | research file section C (vendor planning guides, not peer-reviewed). W0 DEV: not measured, because it used synthetic 512 KiB CT instances |
| Lossless compression | JPEG 2000 1.5-3:1 by modality; HTJ2K ~ JPEG-LS ~2.6-2.7:1 | research file. W0 DEV: not measured |
| **ASSUMPTION** VA modality-weighted average study size | 200 MB raw, 100 MB stored (compressed) | mix dominated by CR/DX count, CT/MR bytes. W0 DEV: not measured |

## 2. Steady-state volumes — all VA

| Quantity | Derivation | Result |
|---|---|---|
| Patient records in the store | **ASSUMPTION** 20 M (8 M active + historical/deceased records retained; VA retains records for decades) | 20 M |
| FHIR resources (backfill) | 20 M x **ASSUMPTION** 2,000 (real longitudinal records exceed Synthea's 1,123; historical data is sparser per year) | 40 B resources |
| FHIR store on disk | 40 B x 4.5 KB | ~180 TB (plus history growth) |
| New resources per year | 154.5 M x 60 + 1.25 M x 500 | ~9.9 B / yr |
| Average write rate | 9.9 B / 31.5 M s | ~315 resources/s |
| Peak write rate | x5 | ~1,600 resources/s |
| Average / peak read rate | x20 | ~6,300 / ~32,000 req/s |
| Imaging studies per year | 11 M (**UNVERIFIED** source) | 11 M |
| Imaging ingest | 11 M x 200 MB raw | 2.2 PB/yr raw, ~1.1 PB/yr stored |
| Imaging ingest per day (avg / peak 8 h) | 1.1 PB / 365; x3 | ~3 TB/day stored; ~0.11 TB/h avg, ~0.4 TB/h peak |
| Instances per year | ~1 B (CITED) | ~1 B, ~32/s avg, ~160/s peak |
| Imaging archive (20 y) | 16-17 PB (ASSUMPTION floor) + 1.1 PB/yr | ~20 PB by 2030 |
| DICOM metadata rows | 1 B instances x ~1 KB indexed | ~1 TB per 1 B instances; 20 B instances -> ~20 TB |
| Audit events | (reads + writes) x 1 | ~6,600/s avg; ~600 GB/day at 1 KB each; 6-year retention ~1.3 PB (compressed ~250 TB) |
| Bulk export, full system | 40 B x 1.5 KB | ~60 TB ndjson (~12 TB gz) |

## 3. Steady-state volumes — all IHS

Scaled by visits (1/10 of VA) unless cited: patients 2.8 M (+ historical,
**ASSUMPTION** 5 M records), resources ~10 B, store ~45 TB, writes ~32/s avg,
reads ~640/s avg, imaging **ASSUMPTION** ~1 M studies/yr, ~110 TB/yr stored.
IHS fits in a handful of stamps; the reason for stamps there is Area
alignment, data residency per tribal agreement and blast radius, not capacity
(Decision D4).

## 4. Search patterns that drive index design (ADR-008)

The W0 load mix and the ADR-008 index set are built from these patterns
(ranked by assumed frequency; W7 replaces the ranking with measured ones):
1. `Patient?identifier=` (MRN / ICN lookup) — exact, must be sub-10 ms.
2. `Observation?patient=&category=&date=ge..&_sort=-date&_count=100` (vitals,
   labs panels).
3. `Condition|MedicationRequest|AllergyIntolerance?patient=` (problem list,
   meds, allergies — `$everything`-lite).
4. `Encounter?patient=&date=` and `Encounter?location=&date=` (census).
5. `DocumentReference?patient=&type=&date=` (notes).
6. `Patient?name=&birthdate=` (demographic search; fuzzy, bounded).
7. `ImagingStudy?patient=` (QIDO cross-walk).
8. Group membership / cohort queries for export (`Group/{id}/$export`).
9. `_lastUpdated` scans for incremental sink/subscriptions.
10. Full-text over notes — **not** in v1 (D20); provided by the lakehouse / AI
    Search path instead.

## 5. Stamp definition and size classes

A stamp (`ARCHITECTURE.md` section 3) hosts N tenants. Size classes:

| Class | Patient records (max) | FHIR store | PostgreSQL | DICOM ingest | Blob accounts | AKS nodes (steady) |
|---|---|---|---|---|---|---|
| S | 250 k | 2.5 TB | E8ds_v5 HA + 1 replica, SSD v2 | 50 GB/day | 1 per tenant (flat-namespace) | 6 x D8s_v5 |
| M | 1.5 M | 15 TB | E16ds_v5 HA + 2 replicas | 300 GB/day | per tenant, split yearly past 1 PB | 12 x D16s_v5 |
| L | 3 M | 30 TB | E32ds_v5 HA + 2 replicas (storage 64 TiB ceiling, SSD v2 — Gov SSD v2 **UNVERIFIED**) | 600 GB/day | as M | 24 x D16s_v5 |

Ceilings that fix the class sizes:
- PostgreSQL Flexible Server: 32 TiB (Premium SSD) / 64 TiB (SSD v2) max
  storage; 80 k IOPS; ~5,000 connections on D16/E16 (CITED, research section F).
  LHDS caps a tenant database working set at **20 TB** (ASSUMPTION, driven by
  PITR/restore time targets of 1 h per TB-class in `OPERATIONS-AND-BCDR.md`,
  not by the platform limit).
- Blob: 5 PiB default per account, 40 k req/s, 60 Gbps in / 200 Gbps out in
  US Gov Virginia (CITED). A stamp needs multiple accounts only past ~4 PB per
  tenant; sharding key is tenant then year.
- AKS: 5,000 nodes/cluster, 250 pods/node (CITED); a stamp never approaches
  these; the cluster is sized by the stateless tiers.
- Event Hubs: 1 MB/s per TU; Premium up to 16 PU; Dedicated 10 CU default
  (CITED). An M stamp needs ~2 PU for 1,600 events/s at 1 KB with headroom.

## 6. Number of stamps

| Estate | Records | Imaging/day | Stamps (class) | Alignment |
|---|---|---|---|---|
| All VA | 20 M | 3 TB | **18 x M** (1.1 M records, 170 GB/day each) — one per VISN, which also matches VA's operational geography | VISN (D4 default) |
| All VA, consolidated | 20 M | 3 TB | 7 x L | region |
| All IHS | 5 M | 300 GB | **4 x M** (Area-grouped) or 12 x S (one per Area) | Area (D4) |
| Commercial regional health system (reference) | 1-3 M | 100-600 GB | 1 x M or L | tenant |
| Pilot / sandbox | <= 50 k | <= 10 GB | 1 x S (pausable) | — |

The number of stamps is a configuration of the control plane; W11 proves the
scale-out path from 1 to 3 stamps with synthetic tenants in both clouds, and
the arithmetic above is what a Go/No-Go for a VA-scale deployment is measured
against.

## 7. Bulk export and sink throughput targets

- Export: a 1 M-patient group (~2 B resources, ~3 TB ndjson) must complete in
  **TARGET** 24 h per stamp: ~23 k resources/s sustained read-and-serialise.
  Public reference points: Microsoft fhir-server OSS ~440 res/s import on one
  instance and a vendor-reported ~11.7 k res/s (UNVERIFIED, research section D).
  The target therefore requires parallel workers reading partitioned ranges
  directly from read replicas, not the single-engine `$export` path (ADR-003,
  W6 design); W0 measures the single-engine baseline.
- Sink: steady state equals the write rate (~90 res/s per VA stamp); backfill of
  a 1.1 M-record stamp (~2.2 B resources) at 23 k res/s is ~27 h.

## 8. Per-stamp resource floors (KEDA minimums, class M)

FHIR API 6 pods (2 vCPU/8 GiB), DICOMweb 6 pods (2/8), PDP 3 pods (1/2),
converter 2 workers, export/sink workers 0-20 (scale to zero), terminology 2
pods (2/16 — in-memory indexes), viewer BFF 2 pods, observability agents.
~60 vCPU steady on 12 x D16s_v5 (192 vCPU) leaves headroom for 3x bursts
before the node pool scales.

## 9. Cost order of magnitude (Azure Government prices unless noted; Retail Prices API, 2026-10-22, research section E)

Per class-M stamp per month (730 h):

| Item | Unit price (Gov) | Quantity | Monthly |
|---|---|---|---|
| PostgreSQL E16ds_v5 primary + HA standby | $2.44/h x2 | 1,460 h | $3,560 |
| PostgreSQL read replicas | $2.44/h x2 | 1,460 h | $3,560 |
| PostgreSQL storage SSD v2 | $0.138/GiB-mo (Gov **UNVERIFIED** meter) | 15 TB -> 15,360 GiB | $2,120 |
| AKS nodes D16s_v5 | $0.968/h | 12 x 730 h | $8,480 |
| Event Hubs Premium | $1.284/PU-h | 2 x 730 h | $1,875 |
| Log Analytics | $2.88/GB | 30 GB/day x 30 (scrubbed app logs; audit stream is cheaper Blob) | $2,590 |
| Key Vault Premium / HSM operations | — | shared; Managed HSM B1 $4.00/h if required at IL5 | $0-2,920 |
| Front Door Premium / App Gateway WAF v2 | $412.50/mo base (FD, Gov AZ/TX only) | shared across stamps | ~$200 allocated |
| **Stamp compute subtotal** | | | **~$22-25 k/mo** |

Imaging storage, all VA (20 PB by 2030, LRS, Gov prices; GRS/object replication
roughly doubles the stored-bytes cost):

| Tier | Share (policy in `OPERATIONS-AND-BCDR.md` section 9) | GB | $/GB-mo | Monthly |
|---|---|---|---|---|
| Hot | 10 % | 2.0 M | $0.0296 | $59 k |
| Cool | 30 % | 6.0 M | $0.016 | $96 k |
| Archive | 60 % | 12.0 M | $0.0024 | $29 k |
| **Total** | | 20 PB | | **~$185 k/mo** (+ transactions, + rehydration $0.026/GB on demand) |

All-VA order of magnitude: 18 stamps x ~$24 k = ~$430 k/mo compute + ~$185 k
imaging + ~$25 k FHIR storage across stamps + audit/backup storage (~$30 k) ->
**~$0.7 M/mo, ~$8 M/yr, LRS, before reserved-instance discounts and before
cross-region DR copies (which add most of the storage figure again).** All-IHS:
~4 stamps -> ~$0.15 M/mo. These are order-of-magnitude figures with the stated
assumptions; they are not a quote and are not a measured bill.

## 10. First bottleneck at each 10x (from one class-S stamp, 50 k records)

| Scale step | Records | First thing that breaks | Mitigation already in the design |
|---|---|---|---|
| 1x (pilot) | 50 k | nothing; single stamp S | — |
| 10x | 500 k | FHIR search p95 on unindexed patterns; converter floods back up the single queue | ADR-008 index set; per-tenant partitions |
| 100x | 5 M | Single-stamp PostgreSQL exceeds the 20 TB working-set cap; restore time > RTO; read QPS exceeds one primary + 2 replicas | Add stamps (routing by tenant); replicas; read-through cache for hot resources |
| 1,000x (all VA) | 20-50 M | Control plane: MPI identity index ~50 M identities with 200 M identifiers — fine in PostgreSQL, but cross-stamp `$everything` fan-out latency and the audit stream (~6.6 k events/s, 600 GB/day) become the shared-service load; Blob account count and lifecycle policy count | MPI returns stamp pointers only (no data fan-out on the hot path); audit is per stamp with a global index of ids; Blob accounts per tenant-year |
| 10,000x | 500 M | Beyond any US agency; not designed for | — |

## 11. What W0 must measure to replace assumptions

1. Disk bytes per stored resource per candidate engine (Synthea 100 k load).
2. Single-pod read/search/write req/s and p95 per engine at 1 M patients.
3. `$export` resources/s per engine (single path).
4. STOW/WADO throughput per DICOM engine pod and Blob 503 onset.
5. PostgreSQL Flexible Server SSD v2 and E-series SKU availability in US Gov
   Virginia (Actions run; the Gov meter is unverified).
6. Synthea generation throughput in the pool (how far toward 100 M is feasible).

## Related

`research/scale-evidence-va-ihs-dicom-pricing.md`, `ARCHITECTURE.md` section 3,
`OPERATIONS-AND-BCDR.md`, `adr/ADR-003-fhir-persistence-sharding.md`,
`adr/ADR-004-dicom-storage-layout.md`, `W00-measurement-spike.md`.
