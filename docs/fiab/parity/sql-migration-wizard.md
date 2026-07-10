# sql-migration-wizard — parity with SSMA / Synapse Pathway (SQL → Synapse Dedicated SQL pool)

Source UI: SSMA / Azure Synapse Pathway assessment + DACPAC import.
Surface file: `apps/fiab-console/lib/editors/sql-migration-wizard.tsx`
(embedded in the Warehouse editor's **Migrate** tab, `phase3/warehouse-editor.tsx`).
Wave: UX-Wave 3 (UX-304), UX-baseline program. Grade target: C → B/A.

## Baseline bar coverage (docs/fiab/ux-standards.md §7.5 wizard checklist)

| # | Bar item | Status | Notes |
|---|----------|--------|-------|
| Multi-step with clear progress | ✅ | Existing 1 · Upload → 2 · Assess → 3 · Import progress rail with active/done dots. |
| No freeform JSON | ✅ | File upload + checkboxes/severity-chips + read-only generated DDL (download only). |
| Per-step gating | ✅ | Assess disabled until a file is picked; Import only shown once DDL statements exist. |
| Real backend on Finish | ✅ | `POST /api/items/warehouse/migrate/scan` (DACPAC parse + compat report) and `…/migrate/import` (DDL against the live Synapse Dedicated SQL pool). |
| Honest gate if infra missing | ✅ | Warehouse-not-configured gate MessageBar (reason + remediation) preserved. |
| SC-6 Teaching banner | ✅ | New `TeachingBanner surfaceKey="warehouse-migrate"` explaining the DACPAC → Synapse flow, with Learn-more. |
| Success confirmation + **next-step guidance** | ✅ | On a clean import an info MessageBar now points the user to the Query and Model tabs (was missing). |
| Assessment visualization | ✅ | Existing count cards + severity-filter chips + findings table + downloadable T-SQL script (this is the assessment-report visualization the wave called for). |

## Backend per control (unchanged — UX lift only)

- Assess: `POST /api/items/warehouse/migrate/scan` (multipart .dacpac) → compat report + generated DDL.
- Import: `POST /api/items/warehouse/migrate/import?kinds=…` → per-object apply results against the Dedicated SQL pool.

## Notes on SC-5 (PreviewTable)

The wave's "adopts" hint listed SC-5 for an assessment grid. The assessment output
is **findings** (severity / object / issue / handling), not columnar row data, so a
domain-specific findings table with severity badges is the correct, higher-fidelity
representation — a generic data-preview grid would be a downgrade. SC-5 is applied on
the sibling data surfaces (warehouse Query results, lakehouse) where real row previews
exist; here the teaching banner + next-step guidance were the honest gaps closed.

## Verification

- `tsc --noEmit` clean; `no-raw-px`, `no-bare-server-fetch`, `check-circular-deps` green.
- Render test `lib/editors/__tests__/sql-migration-wizard.test.tsx` (upload step + teaching banner mount).
- Fluent v9 + Loom tokens only; token-based spacing; dark + light via shared TeachingBanner.
- Live click-walk (deployed Warehouse editor, `LOOM_DEFAULT_FABRIC_WORKSPACE` unset) pending operator UAT.
