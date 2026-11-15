---
name: W05-conversion-hl7v2-ccda
status: backlog
priority: P1
order: 9
depends_on: [W02a-fhir-core-build, W02b-fhir-core-ops]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
branch: feat/lhds-w5-conversion
allow_parallel: true
---
# W5 — Conversion: HL7 v2 and C-CDA to FHIR, `$convert-data`, VistA and RPMS adapter specs

## Goal
FHIR-Converter (MIT) per stamp with versioned templates, an MLLP (TLS) and REST ingest path through Service Bus, validation, enrichment, `Provenance`, dead-letter + reprocess, the `health-conversion-pipeline` item and monitor editor,
and VistA/RPMS adapter specifications (documents only; unverifiable here, stated as such).

## Why
Legacy HL7 v2 and C-CDA are the v1 ingest paths for VA and IHS (operator decision 5). Dependency note: W5 needs the W02a engine and per-tenant config (W2-2) only. The old graph put W5 after W4 (terminology). The one real code edge is the pipeline's enrichment step calling `$translate`;
that step is built behind an interface with a passthrough default, so W5 does NOT depend on W04. Enrichment acceptance (row 5 below) is run once W04 has merged; until then it is recorded "deferred, W04".
> ASSUMPTION: a passthrough enrichment default is acceptable for the first merge (it records in `Provenance` that no translation was applied). If the operator wants enrichment mandatory at first merge, restore `depends_on: [W02a-fhir-core-build, W04-terminology]`.

## Scope / Non-goals
Items W5-1..W5-5. Non-goals: VistA/RPMS code (specs only until an agency partner gives test access, D10/Q5; specs stay UNVERIFIED); device ingest (W10); bulk export (W06). GCC never exercised; IL5/DoD params only.

## Acceptance criteria
- [ ] W5-1: FHIR-Converter MIT fixtures convert to validator-clean bundles (0 validator errors); a known-bad message yields an `OperationOutcome` with severity `error` (fails if it returns a bundle).
- [ ] W5-2: L2 flood test: sent = converted + dead-lettered exactly (a lost message fails the equality); ingest lag p95 <= 5 s at the per-stamp rate; MLLP accepts only TLS from the private network (a plaintext connect is refused); the raw-message store honours its PHI retention class (TTL value asserted).
- [ ] W5-3: Playwright walk of the editor (Templates versioned editor, Endpoints, Monitor, Fixtures tester): editing a template changes the tester output; narrow-width 0 badge overlap; first-open 0 errors; parity doc 0 MISSING.
- [ ] W5-4: each spec cites a public source per section and carries an "Unverified without agency access" list; one reviewer confirms accuracy against the public VistA VDL / IHS documents.
- [ ] W5-5: ORU with 3 OBX -> 3 Observations with the expected LOINC codes (fails at 2 or 4); ADT A01 -> Encounter + Patient; C-CDA CCD -> expected problem/medication/allergy counts; every fixture hash-pinned.
- [ ] Enrichment via `$translate` (deferred until W04 merged): a mapped code gains its target coding; Commercial and GCC-High receipts separate.

## Read first
`adr/ADR-014-conversion-service.md`, `CONTRACT-FREEZE-W2.md`, `W02a-fhir-core-build.md`, `AHDS-MODEL-MAP.md` (`$convert-data` shape), `TEST-STRATEGY.md` sections 3 and 6, `SECURITY-AND-COMPLIANCE.md` (raw message PHI class), `apps/loom-health-fhir/config/**`, the `health-tenant` exemplar, `docs/fiab/health/`.

## Owns
`apps/loom-health-converter/**`; `platform/fiab/bicep/modules/health/engines-converter.bicep` (NEW file; one `module` line in `health.bicep`); `apps/loom-health-cp/src/jobs/convert-*.ts`; `lib/install/provisioners/health-conversion-pipeline.ts`; `lib/editors/health/conversion-editor.tsx`;
`app/api/health/[tenant]/convert/**`; `docs/fiab/parity/health-conversion-pipeline.md`; `docs/fiab/health/adapters/{vista,rpms}.md`; `tests/health/conversion/**`.

> ASSUMPTION: new `engines-converter.bicep` instead of editing `engines.bicep`, to avoid colliding with W2-2 and W4-2.

## Must NOT touch
`engines.bicep`, `engines-terminology.bicep`; `apps/loom-health-fhir/**`; `apps/loom-health-terminology/**`; relay/outbox; `lib/gates/registry/health.ts`, `lib/copilot/health-tools.ts` (no tool in W5); `main.bicep`; build matrix except the converter row (last commit).

## Consumes
W2-2 engine + tenant config; PDP decision API; Service Bus (stamp `eventing.bicep`); W01b stamp; `$translate` from W04 through the enrichment interface (optional).

## Provides
`$convert-data` endpoint, MLLP/REST ingest, template OCI artifacts in ACR, the pipeline item/editor, the adapter specs.

## Steps
1. W5-4 specs (no dependency; start immediately).
2. W5-1 converter + templates; W5-5 fixtures (needs W5-1).
3. W5-2 ingest pipeline (review: PHI store + MLLP surface); enrichment behind the interface.
4. W5-3 editor after W5-2.

### Integration step (serialized)
- `apps/fiab-console/lib/catalog/item-types/health.ts`: append one block. Owner: `W02b-fhir-core-ops` (now in `depends_on`). Concurrent appenders in wave 4 (W03b, W04) rebase on whichever merged first.

## Validation
```bash
node --test tests/health/conversion/                                      # fixtures hash-pinned; semantic assertions (counts, LOINC)
cd apps/loom-health-converter && npm test                                 # pipeline: sent = converted + dead-lettered
az bicep build --file platform/fiab/bicep/health.bicep --stdout >/dev/null && node scripts/ci/check-bicep-sync.mjs
cd apps/loom-health-cp && npm test -- convert
cd apps/fiab-console && npx tsc --noEmit && npx vitest run lib/install lib/editors/health
cd apps/fiab-console && npx playwright test health-conversion-pipeline   # G1 walk
grep -c "Unverified without agency access" docs/fiab/health/adapters/vista.md docs/fiab/health/adapters/rpms.md   # each must be >= 1
```
Mutation receipt on a sandbox copy: change one template mapping (the fixture semantic test goes RED). Merged is "merged, not deployed".

## Rollback
`LOOM_HEALTH_CONVERT_ENABLED=false`; queues drained before disable (jobs guard); converter workload scaled to 0.

## Docs to update
`docs/fiab/parity/health-conversion-pipeline.md`, `docs/fiab/health/adapters/*.md`, `adr/ADR-014` status, `docs/fiab/health/index.md` per-cloud table.

## Wave / Blocked-by / Branch / Worktree
Wave: 4 · Blocked-by: W02a-fhir-core-build, W02b-fhir-core-ops (soft: W04 for enrichment acceptance only) · Branch: feat/lhds-w5-conversion · Worktree: E:/Repos/_lhds-w5

## Hot files
`health.bicep` (one module line), `lib/catalog/item-types/health.ts`, build matrix row. `touches_bicep: yes` (W5-1 only; serialized behind W04's W4-2 if both in flight).
Bicep queue: see PRPs/reference/GLOBAL-SCHEDULE.md

## Kickoff prompt
Fresh session, Sonnet. Read `PRPs/active/loom-health-data-services/W05-conversion-hl7v2-ccda.md`, `CONTRACT-FREEZE-W2.md`, `adr/ADR-014-conversion-service.md`, `W02a-fhir-core-build.md`. Start W5-4 (docs) and W5-1 in parallel worktrees.
Build enrichment behind an interface with a passthrough default; do not depend on W04. Review required on W5-2 (PHI + MLLP) and W5-4 (accuracy). Proof of done: the Validation block plus the L2 flood receipt. Report merged vs deployed separately.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W5-1 converter + templates + `$convert-data` | todo | | sonnet | | 2026-11-14 |
| W5-2 ingest pipeline (MLLP/REST/Service Bus) | todo | | sonnet | | 2026-11-14 |
| W5-3 health-conversion-pipeline item + editor | todo | | sonnet | | 2026-11-14 |
| W5-4 VistA + RPMS adapter specs | todo | | sonnet | | 2026-11-14 |
| W5-5 template fixture suite | todo | | sonnet | | 2026-11-14 |
