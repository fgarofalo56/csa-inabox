---
name: W00-measurement-spike
status: backlog
priority: P1
order: 1
depends_on: []
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W0 — Measurement and decision spike (no product code)

**Goal**: replace the assumptions the plan rests on with measurements, and fix
ADR-001/002 (engines), ADR-003/004 (persistence/storage) and the Gov
availability matrix with receipts. Everything lands in
`PRPs/active/loom-health-data-services/W0-RECEIPT.md` plus raw outputs under
`temp/` (never committed) and GitHub Actions run ids for Gov.

**Day-one brief for the executing session** (fresh session, Sonnet):
1. Read `README.md` (reading order), `CAPACITY-MODEL.md` section 11,
   `AZURE-GOV-AVAILABILITY.md` section 5, ADR-001/002 pass bars.
2. Items W0-1..W0-7 below; W0-1 and W0-2 can run in parallel with W0-5/W0-6
   (lane plan). Max 4 lanes.
3. Cost cap: one class-S stamp-equivalent (AKS 3 nodes D8s_v5, PostgreSQL
   E8ds_v5 no HA, 2 TB) in a Commercial sandbox RG for <= 14 days, deleted at
   the end (receipt includes the deletion). Order of magnitude $4 k (Q2).
4. Done = `W0-RECEIPT.md` complete with every table filled or marked "not
   measured: <why>", ADR status lines updated to Accepted/Rejected with the
   measured values, Gov matrix cells closed, PR opened, no product code.

## Items

| ID | Title | Owns (edits only these) | Depends on | Model | Review | Verify command |
|---|---|---|---|---|---|---|
| W0-1 | Load the Synthea 100 k cohort (fixed seed) into HAPI JPA and Medplum on identical PostgreSQL; record bytes/resource, import res/s, L1 mix req/s and p95, ADR-008 pattern p95, `$export` res/s single path | `scripts/measure/health/fhir-engine-*.sh`, `W0-RECEIPT.md` sections 1-2 | none | Sonnet | none | `bash scripts/measure/health/fhir-engine-report.sh` prints the table with non-empty cells |
| W0-2 | dcm4chee-arc-light on AKS with PostgreSQL + Azure Blob storage descriptor (Commercial endpoint, CMK, private endpoint); STOW/QIDO/WADO throughput at 100 concurrent senders; restart/backup of LDAP; Blob 503 onset; Orthanc same probe only if dcm4chee fails its pass bar | `scripts/measure/health/dicom-engine-*.sh`, Helm values under `temp/`, `W0-RECEIPT.md` section 3 | none | Sonnet | none | `bash scripts/measure/health/dicom-engine-report.sh` |
| W0-3 | Gov availability closure: one GitHub Actions run (existing Gov workflow identity, `gov-discover.yml` pattern) executing `az provider show` for the resource providers in `AZURE-GOV-AVAILABILITY.md` section 5, `az account list-locations` (pairing), `az postgres flexible-server list-skus --location usgovvirginia`, Event Hubs Premium create dry-run, KEDA add-on probe | `.github/workflows/health-w0-gov-probe.yml` (new), `W0-RECEIPT.md` section 4, `AZURE-GOV-AVAILABILITY.md` (cell updates only) | none | Sonnet | **required** (new Gov workflow) | `gh run view <id> --json conclusion` = success and the receipt quotes the run id |
| W0-4 | No-calls-home check: run each candidate engine image on an isolated node pool with egress logging; list every outbound FQDN over 24 h; classify | `scripts/measure/health/egress-*.sh`, `W0-RECEIPT.md` section 5 | W0-1, W0-2 | Sonnet | none | report lists FQDNs with classification; any non-Azure FQDN is a finding |
| W0-5 | Synthea generation throughput in the pool; the largest cohort reachable in 48 h; cohort manifests (seed, version, counts, hashes) stored in Blob | `scripts/measure/health/synthea-*.sh`, `W0-RECEIPT.md` section 6 | none | Sonnet | none | manifest files exist with hashes; the receipt quotes patients/hour |
| W0-6 | Loom integration measurements: confirm the `backingStore` field status (governance-autopilot W2), `ESTATE_PAUSE_TIER` entries, `apimSku` usage, `boundary` enum, `containerPlatform` per param file, GHSA-g7m7 deploy state (existence only, no detail), #4584 state — each with `file:line` at head | `W0-RECEIPT.md` section 7 | none | Sonnet | none | every row has a `file:line` or issue/PR number measured at the named SHA |
| W0-7 | Decide: update ADR-001..004 status lines with measured values against their pass bars; update `CAPACITY-MODEL.md` section 1.3 assumptions that were measured; file the tracking issue and the W1 bicep issue | `adr/ADR-00{1,2,3,4}-*.md` (status + measured-values lines only), `CAPACITY-MODEL.md` (section 1.3 rows only), `W0-RECEIPT.md` section 8 | W0-1..W0-6 | **Opus** for the decision pass (one session) | **required** | `python -S -E C:/Users/fgaro/.claude/kits/orchestrated-prp/prp_index.py check --root .` clean; ADR status lines no longer say Proposed |

Lanes: L1 = W0-1 -> W0-4 -> W0-7; L2 = W0-2; L3 = W0-3 (Gov workflow, review
required); L4 = W0-5 then W0-6. Bicep: none (sandbox resources are created
with `az` from scripts in the sandbox RG, not with the shared bicep tree).

## Assertions that would break (assertion-design)
- W0-1 table has a measured bytes/resource per engine; the receipt fails if any
  engine row is empty or if the two engines report identical numbers (the
  copy-paste control).
- W0-3 run id resolves with `gh run view` to a `success` whose job executed
  steps > 0 (a skipped job is not a receipt).
- W0-4 lists at least the Azure FQDNs every pod must reach (positive control:
  an empty list means the egress log was not wired).

## Rollback
Delete the sandbox RG; nothing in the tracked tree except scripts, the receipt
and ADR status lines.

## Cost / credit estimate
Sonnet sessions ~6; one Opus decision session; Azure ~$4 k (Q2).

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W0-1 | blocked | feat/lhds-w0-dev-run | sonnet | DEV run done, see W0-RECEIPT s1/2 DEV; pass bar still needs class S (Q2) | 2026-10-23 |
| W0-2 | blocked | feat/lhds-w0-dev-run | sonnet | DEV run done, see W0-RECEIPT s3 DEV; pass bar still needs class S (Q2) | 2026-10-23 |
| W0-3 | merged | feat/lhds-w0-gov-probe | sonnet | PR #5092 merged; run 39887825372 success, 11 steps (W0-RECEIPT s4) | 2026-10-22 |
| W0-4 | blocked | feat/lhds-w0-dev-run | sonnet | DEV capture done, see W0-RECEIPT s5 DEV; 24 h pass-bar capture still needs class S (Q2) | 2026-10-23 |
| W0-5 | blocked | feat/lhds-w0-dev-run | sonnet | DEV run done, see W0-RECEIPT s6 DEV; in-pool throughput and 48 h cohort still need class S (Q2) | 2026-10-23 |
| W0-6 | verifying | feat/lhds-w0-no-cost | sonnet | all 7 facts measured at b192f05ea (W0-RECEIPT s7) | 2026-10-22 |
| W0-7 | todo | | opus | | 2026-10-22 |
