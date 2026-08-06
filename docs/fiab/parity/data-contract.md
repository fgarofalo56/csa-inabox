# data-contract — parity with ODCS v3.1 + Microsoft Purview data products

**Source UI / spec:**
- Open Data Contract Standard (Linux Foundation / Bitol) **v3.1** — <https://bitol-io.github.io/open-data-contract-standard/latest/>
- Microsoft Purview — Unified Catalog **data products** (the closest first-party UI) — <https://learn.microsoft.com/purview/unified-catalog-data-products-create-manage>
- Purview data-product **access policies** — <https://learn.microsoft.com/purview/unified-catalog-data-product-access-policies>

**Surface file:** `apps/fiab-console/lib/editors/data-contract-editor.tsx` (253 lines)
**Designer (shared with the data-product Contract tab):** `components/data-contract-designer.tsx`
**ODCS panel:** `components/data-contract-odcs-panel.tsx`
**Route:** `/items/data-contract/[id]` · W10.

**Related doc (different scope, not a duplicate):**
`docs/fiab/parity/data-contracts.md` grades Loom's contract *model* against the
ODCS v3.1 **specification** (field-by-field schema conformance). This doc grades
the **item editor surface** against the Purview data-product UI. Both are
required by `ui-parity.md`; the spec-conformance doc does not substitute for a
per-slug surface doc.

## Terminology finding (measured, and it changes the comparison)

**Microsoft Learn does not use the phrase "data contract" for this surface, and
does not model "output ports" on a data product.** Purview expresses
contract-like semantics as **terms of use + access policies + custom attributes +
endorsement**, and the *schema* lives on the linked **data assets**, not on the
product. Loom takes the opposite shape: the schema is the contract's primary
object, with SLAs and expectations attached to it.

That is a genuine architectural divergence, not a gap in either direction. Rows
below therefore separate **ODCS conformance** (where Loom's shape is the right
one to grade) from **Purview UI parity** (where Purview's shape is the bar).

## Block 1 — ODCS v3.1 contract authoring

| # | ODCS capability | Loom | Evidence / gap |
|---|---|---|---|
| 1.1 | Output schema: typed columns | ✅ | `DataContractDesigner`, typed controls only — no free-typed JSON (`loom_no_freeform_config`). |
| 1.2 | Column description | ✅ | Per-column, preserved across re-derive. |
| 1.3 | Column classification (PII / sensitivity) | ✅ | Per-column; consumed downstream by `synthetic-data`'s PII→synthetic mapping. |
| 1.4 | Primary-key / nullable flags | ✅ | Per-column. |
| 1.5 | Quantified **SLAs / SLOs** | ✅ | `stats.slos` counted and badged. |
| 1.6 | Data-quality **expectations** with severity | ✅ | `stats.expectations`; error-severity expectations gate a bound product's publish. |
| 1.7 | **Derive schema from the live source** | ✅ **exceeds** | `POST …/introspect` runs a real ADX `.show table <T> schema as json`. The merge is a **diff, not a wipe**: steward annotations (description / classification / primaryKey / nullable) survive, dropped columns are removed, new ones appended (`:116-125`). Genuinely better than hand-authoring, and better than Purview's Import-schema, which does not preserve annotations this way. |
| 1.8 | **Validate against live data** | ✅ | `ContractQualityRunPanel` → `POST …/quality` runs real KQL against the bound ADX table. |
| 1.9 | ODCS 3.1 registration / export | ✅ | `DataContractOdcsPanel` — registration, enforcement posture, bindings. |
| 1.10 | Contract **versioning** | ❌ | No version field, no version history, no diff-between-versions. ODCS treats a contract as a versioned artifact; a consumer cannot tell that v2 dropped a column. **The most consequential ODCS gap.** |
| 1.11 | Server / infrastructure block (where the data physically lives) | ⚠️ | Captured implicitly as `databaseName` + `databaseTable`, ADX-only — not the general ODCS server block. |
| 1.12 | Contract-level custom properties | ❌ | Not evidenced. |

**Block 1: 8 ✅ (1 exceeding) · 1 ⚠️ · 3 ❌ (12 rows).**

## Block 2 — Purview data-product UI parity

| # | Purview capability | Loom | Evidence / gap |
|---|---|---|---|
| 2.1 | Products list: scroll/sort/search + filter by custom attribute | n/a | Loom's catalog Browse is the list surface, not this editor. |
| 2.2 | 3-page create wizard (basic → business → custom attributes) | ⚠️ | `NewItemCreateGate` with an explanatory intro, then a single flat editor. No stepped wizard, no required-attribute gate. |
| 2.3 | 11 product **Types** | ❌ | No type taxonomy on the contract. |
| 2.4 | **Audience** picker (8 roles) | ❌ | Not modelled. |
| 2.5 | Bulk **Import** (CSV, ≤1000 rows) | ❌ | One contract at a time. |
| 2.6 | **Details**: description, use cases, domain, update frequency, status, owner, subscribers, aggregate DQ score | ⚠️ | DQ results are shown (`ContractQualityRunPanel`); owner/subscribers/update-frequency/status are not on this surface. |
| 2.7 | Custom attributes with "show attributes without a value" toggle | ❌ | Not modelled. |
| 2.8 | **Data observability** tab (preview) | ❌ | Not built. |
| 2.9 | Add / remove data assets | ⚠️ | One ADX table bound via typed dropdowns (real `?browse=databases` / `?browse=tables`). Purview binds *many* assets; Loom binds one validation target. |
| 2.10 | Remove blocked while DQ rules/history exist | ✅ | Analogous protection: an error-severity expectation blocks the bound product's publish (BR-CONTRACT-GATE). |
| 2.11 | Deleted-asset reconciliation banner | ❌ | If the bound ADX table disappears, the surface does not say so until a validation run fails. |
| 2.12 | **Manage policies** — permitted access / usage purposes | ❌ | Not on this surface. |
| 2.13 | **Manage policies** — approval requirements (manager / privacy / approvers chain) | ❌ | Not on this surface. |
| 2.14 | **Manage policies** — access-request approvers | ❌ | Not on this surface. |
| 2.15 | **Manage policies** — access time limit | ❌ | Not on this surface. |
| 2.16 | Inherited policies tab + **Preview request form** | ❌ | Not on this surface. |
| 2.17 | Glossary terms / OKR linking | ❌ | Not on this surface. |
| 2.18 | **Terms of use** links (optionally per-asset) | ❌ | Not modelled. |
| 2.19 | **Documentation** links | ❌ | Not modelled. |
| 2.20 | **Update frequency** attribute | ❌ | Not modelled. |
| 2.21 | **Endorse** flag | ⚠️ | An `endorsement-control.tsx` exists in the editors tree for other item types; it is **not** wired into this editor. |
| 2.22 | **Publish / unpublish / draft / expired** lifecycle | ❌ | Save-only. A contract has no draft-vs-published state — every save is live. Combined with 1.10 (no versioning), a consumer has no stable artifact to depend on. |
| 2.23 | Catalog-curation publish approval workflow | ❌ | Not on this surface. |
| 2.24 | Multi-step guarded delete | ❌ | Standard item delete. |

**Block 2: 1 ✅ · 4 ⚠️ · 18 ❌ · 1 n/a (24 rows).**

Note: rows 2.12-2.17 and 2.23 are **access-governance** features that Loom
locates on `/governance/**` and `/access-requests` rather than on the contract
item. They are genuine ❌ *for this surface* but Loom is not without an answer
for them; the access-governance parity docs own that comparison.

**Combined totals: 9 ✅ · 5 ⚠️ · 21 ❌ · 1 n/a (36 rows).**

## ux-baseline §7 spot-check

| Bar | Status |
|---|---|
| `ItemEditorChrome` + ribbon (Contract / Schema groups) | ✅ |
| `TeachingBanner` + Learn link to Purview data-products | ✅ |
| `NewItemCreateGate` — clean first-open | ✅ |
| Live stat badges (columns / SLOs / expectations / unsaved) | ✅ |
| Typed designer, zero free-typed JSON | ✅ |
| Fluent v9 + Loom tokens; `flexWrap` on toolbars | ✅ |
| Honest ADX gate | ⚠️ — `MessageBar intent="warning"` naming the env var **and** the bicep module that deploys it (better than most). Still not the shared `HonestGate`: no inline **Fix it**, no gate-registry entry (**G2**). |
| Explicit dirty state | ✅ — `unsaved` badge + disabled Save when clean. |
| Derive-schema feedback | ✅ — success/error MessageBar naming the column count and `database.table`. |
| G3 resizable panes | ❌ — fixed-width body (`maxWidth: '1100px'`). |

## Backend per control

| Control | Call | Real backend |
|---|---|---|
| ADX database dropdown | `GET …/quality?browse=databases` | **Azure Data Explorer** |
| Table dropdown | `GET …/quality?browse=tables&database=` | ADX |
| **Derive schema from this table** | `POST …/introspect` | ADX `.show table <T> schema as json` |
| **Run quality checks** | `POST …/quality` | Real KQL against the bound ADX table |
| ODCS panel (register / posture / bindings) | ODCS routes | Cosmos + registry |
| Save | `PATCH` via `useItemState` | Cosmos DB |

Real backend on every control. No mocks. No Fabric/Purview-Fabric host on the
default path — `no-fabric-dependency.md` satisfied (ADX is the backend).

## Verdict

**B for contract authoring; C overall.** The authoring core is genuinely strong:
a typed designer with zero free-typed JSON, live schema derivation that preserves
steward annotations, real KQL validation, ODCS 3.1 registration, and a real
enforcement hook into data-product publish. That is more than the Purview UI does
for schema.

The gaps cluster in **lifecycle**, and they compound:

1. **1.10 (no versioning) + 2.22 (no draft/publish)** together mean a contract is
   a mutable document. Consumers cannot pin a version, and a breaking edit ships
   the moment Save is pressed. For an artifact whose entire purpose is to be a
   stable promise, this is the finding to escalate.
2. **2.11 (no deleted-asset reconciliation)** — a vanished bound table is silent
   until a run fails.
3. **2.18-2.21** (terms of use, documentation, update frequency, endorsement) are
   small, cheap consumer-facing metadata that Purview treats as core.

## Verification

- **V3 (in-browser click-walk): OWED.** `loom-ui-verify` red since 2026-08-04
  (FINISHLINE C13); Actions degraded. When recovered:
  ```bash
  gh workflow run loom-ui-verify.yml --ref main -f target_route=/items/data-contract/<id>
  ```
  The walk must specifically prove the **re-derive diff** behaviour (annotate a
  column → re-derive → the annotation survives; drop a source column → re-derive
  → the column is removed) and that an error-severity expectation really blocks
  a bound product's publish.
- Coverage read from source; static evidence only (`no_scaffold_claims`).
