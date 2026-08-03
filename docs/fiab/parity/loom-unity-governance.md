<!-- parity-doc-meta
Reviewed-on: 2026-08-02
Validated-against:
  - apps/fiab-console/lib/governance/uc-overlay/model.ts
  - apps/fiab-console/lib/governance/uc-overlay/store.ts
  - apps/fiab-console/lib/governance/uc-overlay/audit.ts
  - apps/fiab-console/lib/governance/uc-overlay/purview-sync.ts
  - apps/fiab-console/lib/azure/purview-typedef-namespace.ts
  - apps/fiab-console/lib/components/catalog/uc-governance-pane.tsx
  - apps/fiab-console/app/api/catalog/unity/governance/route.ts
  - apps/fiab-console/app/api/catalog/unity/governed-tags/route.ts
-->

# loom-unity-governance — parity with Unity Catalog tags / governed tags / certification

> LU-5. Scope: the Loom-native governance **overlay + API** on `uc:<fqn>`
> securable identities, plus its Microsoft Purview fold-in. Graded per
> `.claude/rules/no-vaporware.md` + `.claude/rules/ui-parity.md`; graded DOWN
> when in doubt.
>
> **THIS PR IS THE UI HALF.** The data plane — model / store / audit / Purview
> projection / the two BFF routes / the Atlas typedef namespace authority — is
> PR #2607; this PR adds the `Governance` **tab** of `/catalog/unity` and
> nothing else. It was split out precisely because `ux-baseline.md` **G1** makes
> an in-browser E2E receipt BLOCKING for a UI surface, so **this** PR does not
> merge without one. Component-level evidence is 27 specs, each
> mutation-verified (8 mutations applied + reverted, all RED). That is coverage,
> NOT the G1 receipt, and is not offered as a substitute for it.

**Source UI (grounded in docs, not memory):**
- Tags on database objects (Catalog Explorer → object → Tags):
  https://learn.microsoft.com/azure/databricks/database-objects/tags
- Governed tags + tag policies (allowed values):
  https://learn.microsoft.com/azure/databricks/admin/governed-tags/manage-governed-tags
- Certify / deprecate data (Catalog Explorer certification badge):
  https://docs.databricks.com/aws/en/data-governance/unity-catalog/certify-deprecate-data
- Purview custom metadata (business-concept attributes):
  https://learn.microsoft.com/purview/unified-catalog-attributes-business-concept
- Purview classic Data Map (Atlas v2 — the API surface this deployment actually has):
  https://learn.microsoft.com/purview/data-gov-api-atlas-2-2

**Loom surface (data plane — PR #2607)**
- BFF: `app/api/catalog/unity/governance/route.ts` (overlay read/write + Purview
  sync) and `app/api/catalog/unity/governed-tags/route.ts` (tenant vocabulary).
- Model / store / audit / Purview: `lib/governance/uc-overlay/{model,store,audit,purview-sync}.ts`.
- Atlas typedef namespace authority: `lib/azure/purview-typedef-namespace.ts` —
  the only way a tenant-authored word can become an ACCOUNT-GLOBAL Atlas
  classification typedef (branded type + sink assert; see the S4 section below).
- Tests: `lib/governance/uc-overlay/__tests__/{model,store,purview-sync,audit}.test.ts`
  (47 + 22 + 21 + 9), `app/api/catalog/unity/governance/__tests__/route.test.ts`
  (47), and `lib/azure/__tests__/purview-typedef-namespace.test.ts` (19) plus the
  S4 caller pins — **173 total**, every security assertion mutation-verified (see
  the round-3 and round-4 PR comments for the exact mutation applied per fix and
  the failure it produced).

**UI (THIS PR)**
- `apps/fiab-console/lib/components/catalog/uc-governance-pane.tsx`, mounted as
  the `Governance` tab in `app/catalog/unity/page.tsx`.
- Tests: `lib/components/catalog/__tests__/uc-governance-pane.test.tsx` — 27
  specs asserting what the pane SENDS and what it REFUSES to render (a governed
  value is a dropdown, never a text box; `securableType` derivation; "Save note"
  re-sends the CURRENT rung; only DIRTY attributes are sent; an infra gate gets
  the shared `HonestGate` while a non-infra reason does not).
- **REQUIRED BEFORE MERGE — the G1 browser E2E receipt:** a click-walk of every
  control against a real backend, screenshots (light + dark), and a
  narrow-width pass for badge overlap.

**Backend reality check.** Reads and writes hit Cosmos (`uc-governance` container,
PK `/tenantId`; vocabulary in `tenant-settings` under `uc-governed-tags:<tenantId>`).
The Purview fold-in calls the classic Data Map (`ensureClassificationDefs` →
`addAssetClassification` → `setBusinessMetadata`, Atlas v2). No mock arrays, no
`return []`. No Fabric / Power BI on any path. The securable picker walks the
real `/api/databricks/unity-catalog/{catalogs,schemas,tables}` routes, which
serve BOTH the Databricks and OSS Unity Catalog backends.

---

## Feature inventory → Loom coverage → backend

Legend: built ✅ · honest-gate ⚠️ · MISSING ❌

### A. Tags

| # | Source capability | Loom | Where / backend |
|---|---|---|---|
| A1 | Assign key=value tags to a catalog / schema / table | ✅ built | Governance tab → Tags → Apply tag → `POST /api/catalog/unity/governance` `setTags` → Cosmos overlay |
| A2 | Remove a tag | ✅ built | chip ✕ → `removeTagKeys` (pinned to exactly that key) |
| A3 | Browse tags on an object | ✅ built | `GET …/governance?fullName=` |
| A4 | List every tagged object under a catalog/schema | ✅ built | `GET …/governance?prefix=` (single-partition `STARTSWITH`) |
| A5 | Column-level tags | ⚠️ partial | the model + store address columns (`col:uc:<fqn>::<column>`) and the API accepts `column=`; the pane exposes no column picker (see Residual) |
| A6 | Tag DDL executed in the metastore itself | ⚠️ Databricks-only | `ALTER … SET TAGS` remains on the SQL-warehouse path (`/api/databricks/unity-catalog/tags`); OSS UC 0.5 has no tag DDL, so the overlay is the Azure-native default |

### B. Governed tags (controlled vocabulary)

| # | Source capability | Loom | Where / backend |
|---|---|---|---|
| B1 | Define a governed tag key + description | ✅ built | Governance tab → Governed tags → `POST /api/catalog/unity/governed-tags` (tenant admin; a non-admin's 403 is shown verbatim, not hidden) |
| B2 | Declare ALLOWED VALUES | ✅ built | same; `validateGovernedTagDefs` rejects a definition with none |
| B3 | REJECT an assignment outside the vocabulary | ✅ built | `validateTagAssignment` → 400 from the BFF (enforced server-side, not just in the form) |
| B4 | Drop a governed tag | ✅ built | chip ✕; the POST carries the FULL next vocabulary because the route replaces the doc (pinned both ways: delete, and re-add replaces rather than duplicates — mutation P7 turns the second red) |
| B5 | Value picker driven by the vocabulary | ✅ built | governed key → value **Dropdown**; the spec asserts the option set EQUALS the vocabulary and that the free-text value input is ABSENT, and that Apply stays disabled until an allowed value is chosen (mutations P2 / P3 turn these red) |
| B6 | Governed vs free tag distinguishable after the fact | ✅ built | `governed` flag persisted per assignment |
| B7 | Account-level governed-tag DDL | ⚠️ Databricks-only | `CREATE GOVERNED TAG` stays on the warehouse path; the Loom vocabulary is tenant-scoped and backend-independent |

### C. Certification

| # | Source capability | Loom | Where / backend |
|---|---|---|---|
| C1 | Mark an object certified | ✅ built | Certification → status Dropdown → overlay `certification.rung='certified'` |
| C2 | Show the certifier identity + timestamp | ✅ built | stamped from the session on the rung change; rendered under the control |
| C3 | Certification comment | ✅ built | Note field. "Save note" re-sends the CURRENT rung, which is what makes the model's "re-stamp by/at only when the rung MOVES" rule reachable from the UI (mutation P4 turns it red) |
| C4 | Intermediate "promoted" rung | ✅ built | shared `EndorsementRung` (`none`/`promoted`/`certified`) — the same ladder as data products |
| C5 | Deprecate an object | ❌ MISSING | Databricks pairs certify with deprecate; not modelled yet (see Residual) |

### D. Custom attributes

| # | Source capability | Loom | Where / backend |
|---|---|---|---|
| D1 | Typed business attributes on an asset | ✅ built | one control per `AttributeDef.fieldType` (Text / Single / Multiple choice / Date / Boolean / Integer / Double / Rich text); a Single choice is a dropdown limited to its `choices`, and only DIRTY ids are sent so one editor cannot rewrite another's values (mutation P5 turns it red) |
| D2 | Attribute schema is admin-defined, not per-asset | ✅ built | reads `attribute-groups:<tenantId>` — the SAME doc `/api/attribute-groups` owns; the overlay stores values only |
| D3 | Reject values for undefined attributes | ✅ built | `applyOverlayMutation` throws on an unknown attribute id |

### E. Purview fold-in

| # | Source capability | Loom | Where / backend |
|---|---|---|---|
| E1 | Governed tags → controlled classifications | ✅ built | `ensureClassificationDefs` + `addAssetClassification` (Atlas v2), name `Loom_<tenant8>_<key>_<value>` — tenant-namespaced because Atlas typedefs are ACCOUNT-GLOBAL while a Loom tenant is a Cosmos partition |
| E2 | Free tags + certification → business metadata | ✅ built | `setBusinessMetadata` into a **tenant-namespaced** `LoomCustomTags_<tenant8>` bag (`isOverwrite=true`). Namespaced for the same reason E1 is: an Atlas business-metadata typedef is ACCOUNT-GLOBAL, its attribute names come verbatim from tenant-authored free-tag keys, and the write overwrites — so an account-global bag would let one tenant clobber another's `cost_center` / `loom_certification` on a shared Purview account (`model.tenantBusinessMetadataName`). Since #2633 the account-global bag is **not expressible**: `setBusinessMetadata` / `ensureBusinessMetadataDef` take a branded `AtlasBusinessMetadataName`, mintable only by `purview-typedef-namespace.loomTenantBusinessMetadataName`, and the pre-existing item-level custom-tags route (`/api/items/[type]/[id]/business-metadata`) writes the SAME per-tenant bag |
| E2a | **REVOKE** a classification Loom applied | ✅ built | `removeAssetClassification` (new DELETE counterpart). The sync is a SUPERSEDE: classifications recorded in `overlay.purview.classifications` that are no longer desired are removed, so an asset can never carry `…_pii_yes` **and** `…_pii_no` |
| E2b | **CLEAR** a stale certification / removed free tag | ✅ built | `loom_certification` is ALWAYS emitted (`none` when de-certified) and previously-pushed business-metadata keys are blanked, so a de-certified asset does not keep a `certified` label |
| E2c | Push to a re-registered asset | ✅ built | a LIVE `resolveAssetIdentities` wins over the cached `purview.guid`; the cached guid is only the fallback |
| E3 | Honest state when Purview is absent | ⚠️ honest-gate | `reason` names `LOOM_PURVIEW_ACCOUNT` + the Data Curator grant, rendered through the shared G2 `HonestGate` with an inline **Fix it** wizard. A NON-infra reason (no Atlas entity, column overlay, nothing to sync) stays an informational bar — both directions pinned; mutation P6 turns the second red. The overlay itself still saves |
| E4 | Honest state when the asset is not registered | ⚠️ honest-gate | `reason` points at `/api/catalog/register` |
| E5 | Unified-catalog (`/datagovernance`) business domains | ❌ N/A | the ARM-provisioned account is a CLASSIC Data Map account; that host does not exist here (see `lib/azure/purview-client.ts` header) |
| E6 | Column-level classification push | ❌ MISSING | needs `ensureColumnEntities` first; refused with a reason rather than faked |

---

## Data model (why it composes instead of forking)

| Concern | Reused from | Consequence |
|---|---|---|
| Securable identity | `unified-lineage.ucIdentity` / `columnIdentity` (re-stated pure + pinned by test) | an overlay row joins a lineage node, a Purview asset, and a Loom item with no mapping table |
| Certification ladder | `lib/dataproducts/certification.EndorsementRung` | a certified table and a certified data product land in the same `endorsement` catalog facet |
| Attribute schema | `lib/types/attribute-groups` (`attribute-groups:<tenantId>`) | one tenant attribute schema for products and securables |
| Vocabulary storage | `tenant-settings` one-doc-per-tenant, like `policies:` / `attribute-groups:` | the tenant's governance vocabularies live and back up together |
| Purview write | `purview-client.{ensureClassificationDefs,addAssetClassification,removeAssetClassification,setBusinessMetadata}` | no second Purview client |
| Authorization | `feature-gate.enforceCapability('admin.security', …)` | write tiers are delegable at /admin/permissions; tenant admins bypass |
| Audit | `auditLogContainer` — same shape as `governance/domain-audit.ts` | overlay/vocabulary/Purview events **and denials** land in Admin → Audit Logs |

The one NEW concept is the governed-tag definition. A tag is a key=value on a
*securable*; an `AttributeDef` is a typed field of a *governance-domain business
concept*. Modelling a tag as a "Single choice" AttributeDef would force every tag
key into a domain scope it does not have, so the definition instead mirrors the
Databricks DDL (key + description + ALLOWED VALUES) — which also lets LU-6's ABAC
compiler emit either the Databricks tag DDL or a Synapse secure view from the
same rows.

## Residual (tracked, not claimed)

- **A5 / E6 — column-level UI + Purview column push.** Model, store, and API
  handle columns today; the pane has no column picker and the Purview sync
  refuses column overlays with a reason.
- **C5 — deprecation.** Databricks pairs certify with deprecate; the Loom
  endorsement ladder has no deprecated rung yet.
- **Bulk apply.** Tagging many securables at once (Catalog Explorer multi-select)
  is not built; the prefix listing endpoint is the foundation for it.
- **Browser E2E (`ux-baseline` G1) — OPEN, and BLOCKING for this PR.** The 27
  mutation-verified component specs are coverage, not a receipt. The tab is NOT
  graded A until a click-walk against a real backend is attached, with light +
  dark screenshots and a narrow-width badge-overlap pass.
- **Manual FQN entry.** The securable picker drives off the live
  `catalogs`/`schemas`/`tables` routes; with neither Databricks nor
  `LOOM_UNITY_URL` configured the picker is empty and the tab has nothing to
  select, even though the overlay API itself is backend-independent. The
  “no gate” property holds for the API, not yet for the surface.

## Authorization + audit (added after adversarial review)

`POST /api/catalog/unity/governance` is **not** session-only. Writes are tiered
on the delegable `admin.security` capability:

| Mutation | Required role | Why |
|---|---|---|
| free-form tags, attribute values | `Contributor` | tenant-visible annotation |
| certification | `Admin` | a trust attestation stamped with the caller's UPN — forging it is the whole attack |
| governed-tag assign/remove | `Admin` | LU-6's ABAC compiler turns these into real tag DDL / secure views |
| `syncPurview` | `Admin` | writes the SHARED tenant Purview account via the Console UAMI and creates account-global Atlas typedefs |

`POST /api/catalog/unity/governed-tags` (the vocabulary) stays tenant-admin.
A tag counts as GOVERNED for tiering if the tenant vocabulary defines it TODAY
**or** the row being mutated already carries `governed: true`. The row half is
load-bearing: the vocabulary is tenant-wide mutable state, and one tenant-admin
`POST /api/catalog/unity/governed-tags {tags: []}` would otherwise demote every
already-persisted governed assignment to the Contributor tier — letting a
Contributor de-classify `pii=yes`.

Every applied mutation, Purview push, vocabulary edit **and denial** (403 authz,
400 validation) is written to the Cosmos audit-log container
(`lib/governance/uc-overlay/audit.ts`) and surfaces in Admin → Audit Logs — the
overlay's own `updatedBy` / `certification.by` are last-writer-wins fields, not
a trail. Denial payloads are bounded (`audit.boundAttempted`) because the 403
branch records raw request body from a caller who holds no grant.

The Atlas typedef NAMESPACE rules that E1/E2 rely on (the branded
`AtlasClassificationTypedefName`, the sink assert, and the MIP-GUID-only
rule for `MICROSOFT.GOVERNANCE.LABELS.*`) ship in PR #2607 — see its S4
section. This PR consumes them and adds nothing to that surface.

**The audit trail is BEST-EFFORT, not guaranteed.** `audit.write` swallows Cosmos
failures so an audit outage cannot fail a governance write that already applied
(the same contract as `writeDomainAudit`). With the audit container missing or
misconfigured, governance mutations and refused forgery attempts proceed
UNRECORDED. This is an attributability aid, not a tamper-evident ledger, and must
not be relied on as a standalone compliance control.
