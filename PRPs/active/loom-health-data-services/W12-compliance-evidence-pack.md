---
name: W12-compliance-evidence-pack
status: backlog
priority: P1
order: 13
depends_on: [W11-hardening-dr-scale-out]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W12 — Compliance evidence pack (design mapping and generated evidence; never a certification claim)

**Goal**: the platform generates the evidence list in
`SECURITY-AND-COMPLIANCE.md` section 16 on demand, per cloud, with the control
mappings (HIPAA, NIST 800-53 High families -> per-control rows using the Azure
Gov CRM as the inheritance source, 42 CFR Part 2, HITRUST domains, VA 6500 /
IHS package inputs). Every page states plainly that it is design mapping and
evidence, not an authorization.

## Items

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W12-1 | Evidence generator job: role/scope inventory, isolation probe output, CMK inventory, TLS scan, audit-chain report, network scan (zero public data-plane endpoints), SBOM + signature verification, BCDR drill receipts, conformance receipts, log-scrub receipt — each stamped with cloud + Actions run id | `apps/loom-health-cp/src/evidence/**`, `app/api/health/evidence/**` | W11 | Sonnet | **required** (produces assurance artefacts) | Generated pack < 1 h; every item present or marked "not produced: why"; a tampered input changes the pack hash |
| W12-2 | Control mapping tables: per-control NIST 800-53 High rows (inherited vs LHDS), HIPAA, Part 2, HITRUST domains, VA/IHS inputs; machine-readable (CSV/OSCAL component definition) + rendered docs | `docs/fiab/health/compliance/**`, `apps/loom-health-cp/src/evidence/mappings/**` | W12-1 | **Opus** (one mapping pass) | **required** | Every row cites a design element and an evidence item id; a row without evidence is flagged, not hidden |
| W12-3 | Admin surface: tenant editor Evidence tab (generate, download, history); ISSO persona walk | `apps/fiab-console/lib/editors/health/tenant-editor.tsx` (Evidence tab), `app/api/health/tenants/[id]/evidence/**` | W12-1 | Sonnet | none (G1) | Playwright walk; download hash equals the generator's |
| W12-4 | Final per-cloud status, PRP close-out: every wave's receipts linked; anything merged-not-deployed listed in those words; leftovers filed as issues | `README.md`, `ARCHITECTURE.md` section 6, `PRP.md` (status lines) | W12-1..W12-3 | Sonnet | none | `prp_index.py check` clean; status table rows carry run ids |

Lanes: L1 = W12-1 -> W12-3 -> W12-4; L2 = W12-2.

## Done receipt
Pack generated in Commercial and GCC-High (run ids); mapping docs reviewed by
one reviewer; no authorization claimed anywhere (grep for "certified",
"authorized", "compliant" in `docs/fiab/health/**` returns only the
disclaimer sentences — the needle scan is a regression guard, the review is
the check).

## Rollback
Docs and a generator; nothing to roll back.

## Cost / credit estimate
~7 Sonnet sessions, 1 Opus pass.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W12-1 | todo | | sonnet | | 2026-10-22 |
| W12-2 | todo | | opus | | 2026-10-22 |
| W12-3 | todo | | sonnet | | 2026-10-22 |
| W12-4 | todo | | sonnet | | 2026-10-22 |
