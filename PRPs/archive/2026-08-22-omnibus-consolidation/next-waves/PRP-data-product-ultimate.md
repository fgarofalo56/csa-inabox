# PRP — The Ultimate Data Product (guided wizard, certification pipeline, mesh-class feature set)

> **Title:** The ultimate Data Product experience — unify the four confused surfaces, add a
> guided creation wizard, a real certification state machine, in-product walkthroughs + AI
> authoring, and the full mesh-class feature set (ports, versioning, deprecation, subscription
> fulfillment, feedback, sample-data, SLO monitoring, value metrics), on pure Azure + OSS.
> **Date:** 2026-07-08
> **Status:** proposed
> **Owner:** CSA Loom — Data Product / Data Mesh Architect
> **Sources consulted:**
> - **Code audit** (verified via Grep/Read against `apps/fiab-console` on 2026-07-08, file:line per item):
>   `lib/catalog/item-types/csa-data-products.ts` (4 item types), `lib/editors/apim-editors.tsx`
>   (`DataProductEditor`, 9-tab surface), `lib/editors/data-product-detail.tsx` (F3/F15 details page),
>   `lib/editors/data-product-editors.tsx` (template/instance editors), `lib/data-products/data-product-create-wizard.tsx`,
>   `lib/editors/data-marketplace.tsx` (producer Publish tab), `lib/editors/data-product-edit-dialog.tsx`,
>   `lib/editors/components/data-contract-designer.tsx`, `lib/dataproducts/contract.ts`,
>   `lib/catalog/data-product-templates.ts` (CURATED_TEMPLATES), `lib/azure/loom-data-products-search.ts`,
>   `app/api/data-products/[id]/route.ts` + `.../status/route.ts` + `.../access-requests/route.ts` +
>   `.../access-policy/route.ts`, `app/api/items/data-product-template/[id]/route.ts`.
> - **Industry grounding** (URLs per work-item): Dehghani *Data Mesh* (O'Reilly) + datamesh-architecture.com
>   (8 usability attributes, architectural quantum); Bitol **ODPS** v1.0.0 + Linux-Foundation **ODPS** v4.1 +
>   **ODCS** v3.1.0 (`bitol-io.github.io`, `opendataproducts.org`) — ports, executable SLAs, contract lifecycle;
>   `datacontract-cli` (breaking-change detection, linting); **Microsoft Purview Unified Catalog** (governance
>   domains, CDEs, OKRs, typed data-products, draft→published lifecycle, tiered access-request workflow, policy
>   inheritance, health-score controls, DQ thresholds — `learn.microsoft.com/purview/unified-catalog-*`);
>   **AWS DataZone / SageMaker Catalog** (automated subscription fulfillment); **Databricks Marketplace / Unity
>   Catalog Domains / OpenSharing** (provider wizard, try-before-subscribe, zero-copy AI-asset sharing);
>   **Collibra / Alation / data.world / SAP Datasphere / Starburst Galaxy** (marketplace discovery UX,
>   knowledge-graph search, no-code AI authoring, semantic-layer-as-product); **Power BI endorsement**
>   (Promoted vs Certified two-tier trust); Rewire/moderndata101/glitni (semver + deprecation discipline).
> **Governing rules (die-hard, non-negotiable):** `.claude/rules/no-fabric-dependency.md` (Azure-native is
> the DEFAULT; Fabric/Power BI opt-in only, never a gate — a data product is 100% functional with no Fabric
> capacity and no Power BI workspace); `.claude/rules/no-vaporware.md` (real backend + receipt per merge);
> `.claude/rules/ui-parity.md` (one-for-one usable feature parity); `loom_no_freeform_config` (wizards /
> dropdowns / pickers / canvas — **this PRP FIXES the three freeform violations found**, never adds one);
> `loom_design_standards` (Fluent v9 + Loom tokens + LearnPopovers). **Default-ON / opt-out** per the WAVES.md
> global principle: every capability ships enabled by default with an admin disable, never a user-facing
> enablement gate. Dual-cloud (Commercial + Government / GCC / GCC-High / IL4–IL6) mandatory per item.

---

## Executive summary — the strategic "why"

We built a *lot* of real data-product machinery, and the deep parts are genuinely good — the contract
designer is fully typed (schema grid, SLO dropdowns, quality-expectation grid, a real ADX-backed DQ
enforcement run, **no JSON textarea**), the observability tab is one honest GET feeding real ADX KQL
health charts + Purview classic Data Map lineage, and the access-policy / access-request approval flow is
real Purview-parity with an approver inbox and delete-preconditions. That machinery is **not** where the
problem is.

The problem is that "data product" in Loom is currently **four poorly-reconciled surfaces plus two
confusingly-named sibling item types**, and a new user cannot tell which one to use or trust. On `/new`
they see three near-identical cards in one category — **Data product**, **Data product template**, **Data
product instance** — with no hierarchy and no explanation that a *template* spawns an *instance*, and that
neither is the governed mesh entity that **Data product** is. "New → Data product template" creates
*nothing* (the editor and its GET route ignore the item id and always render the same static curated
gallery); "New → Data product instance" dead-ends on an empty state because instances can only be born from
a template's *Instantiate* button. Two entirely separate "create a data product" wizards write different
field vocabularies into the *same* Cosmos record type. The word **Publish** means three unrelated things in
three editors. And most damning: three parallel, never-synced status fields (`lifecycleStatus`, `status`,
`publishStatus`) live on one entity, each written by a different path and read by a different surface — so
**clicking Publish in one editor silently fails to update what another surface displays**: the details-page
badge stays "Draft" forever, and the product never appears in the consumer marketplace search, regardless
of a successful lifecycle Publish.

Meanwhile, measured against the 2026 industry bar — Dehghani's architectural-quantum + 8-usability-attribute
frame, Bitol ODPS/ODCS ports and executable SLAs, Purview's governance-domain/OKR/CDE/health-score model,
AWS DataZone's zero-touch subscription fulfillment, Databricks Marketplace's provider wizard + try-before-
subscribe, and Power BI's two-tier endorsement — Loom is **missing the mesh-class spine**: no input/output/
management ports, no versioning-with-breaking-change-gating or humane deprecation window, no automated
subscription fulfillment, no consumer feedback/ratings/usage analytics, no persisted sample data or starter
notebook, no live SLO monitoring against the declared targets, no value metrics (OKRs/CDEs/cost), and a
push-button template gallery where **9 of ~10 templates never produce a governed product at all** — only a
pile of wired Azure resources.

This PRP does three things, in dependency order. **First it makes the model honest** — one canonical status
vocabulary, one reconciled create path, projection parity across every read surface, a clean item-type
taxonomy, and the three freeform violations fixed. **Then it builds the experience the operator asked for** —
a guided multi-step creation wizard with progressive disclosure and live template previews, a real
certification state machine (draft → validated → certified) whose top rung is *gated by live automated
checks* not a one-time human click, in-product "complete your data product" walkthroughs + LearnPopovers +
a Copilot builder that drafts descriptions/contracts/quality rules. **Then it closes the mesh-class gaps** —
ports, semver + deprecation, subscription fulfillment, feedback, sample-data + starter notebook, SLO
monitoring, value metrics, governed↔infra cross-linking, and a clean editable/consumable/shareable end
state (owner-view vs consumer-view clarity, marketplace + Delta Sharing publication). Every item is
Azure-native by default with **zero** Fabric/Power BI dependency, Commercial and Government alike.

**Dedupe note (read before building).** This PRP deliberately **does not rebuild** three engines the
next-waves plan already owns; it *rides* them: the **schema-diff / breaking-change engine** is `W10`
(Data Contract item) + `BR-CONTRACT-GATE` (publish-time schema-diff gate) — DP-9 wires the data-product
publish gate to that engine rather than writing a second differ; the **DQ rule/score engine** is `W11`
(Data Quality Rule Engine) plus the already-shipped `ContractQualityRunPanel` — DP-5's certification score
consumes it; **external cross-tenant sharing** is `FGC-30` (Entra B2B + scoped ADLS grant) and the shipped
bidirectional **Delta Sharing** marketplace (PR #1578) — DP-16 surfaces a "Share externally" action on the
product record that calls those, it does not re-implement sharing; **marketplace listing analytics +
subscriber webhooks** is `W18` (+ `BR-WEBHOOK`) — DP-11's consumer feedback reuses that plumbing. Where an
item touches those, it references them explicitly and scopes itself to the data-product-specific glue.

---

## Work items

| ID | Item | Operator ask | Capability | Loom state | Priority | Effort |
|----|------|--------------|-----------|-----------|----------|--------|
| DP-1 | Unify the data-product data model | (foundation for all) | One canonical `lifecycleState` vocabulary; reconcile the 4 write paths + 3 status fields; projection parity across every read surface | BROKEN (3 unsynced status fields) | **P0** | L |
| DP-2 | Item-type taxonomy cleanup | (foundation) | Hide template/instance from the `/new` confusion; make template→instance provenance explicit; cross-referenced LearnContent | CONFUSED (3 look-alike cards) | **P0** | M |
| DP-17 | Fix the 3 freeform-config violations | Ask #6 | People-picker owners; reconcile single `owner` into `owners[]`; typed custom-attribute editors | 3 violations | **P0** | S |
| DP-3 | Guided creation wizard | Ask #1 | 7-step pre-create wizard (domain/owner → purpose/consumers → template+preview → sources/ports → contract+SLOs → access policy → review), progressive-disclosure, skippable-with-defaults | bare `/new` form | **P0** | XL |
| DP-4 | Template gallery + instance provenance | Ask #1 | "What you get" template previews; instances show their template lineage; every template also stamps a governed product | thin static gallery | P1 | L |
| DP-5 | Certification pipeline (state machine) | Ask #2 | draft → validated → certified with automated checks (contract, DQ threshold, SLOs, docs, owner+support, lineage, access policy, sample) + promoted/certified endorsement ladder; badge in catalog + marketplace | 2 unsynced booleans | **P0** | XL |
| DP-6 | In-product walkthroughs + LearnPopovers | Ask #3 | "Complete your data product" checklist on the editor + LearnPopovers explaining the model | none | P1 | M |
| DP-7 | Copilot data-product builder | Ask #3 | AI assist to draft descriptions/contracts/quality-rules and suggest which assets belong together | none | P1 | L |
| DP-8 | Input / output / management ports | Ask #4 | Declared input ports (upstream deps) + output ports (contract-bound) + management ports (health/lineage/pause), each 1:many to a contract | output-only, no ports | P1 | L |
| DP-9 | Versioning + deprecation policy | Ask #4 | Semver discipline, version history + diff, breaking-change gate at publish (rides `W10`/`BR-CONTRACT-GATE`), deprecation window + replacement pointer + scheduled sunset + consumer notice | free-text version, overwrite-on-save | P1 | L |
| DP-10 | Subscription approval + fulfillment | Ask #4 | Zero-touch automated RBAC provisioning on approve (DataZone parity) atop the existing tiered-approval flow; usage-purpose + attestations + skip-path | approval real, fulfillment manual | P1 | L |
| DP-11 | Consumer feedback / ratings / usage | Ask #4 | Ratings + comment thread + consumption telemetry on owner *and* consumer views (reuses `W18` analytics/webhooks) | absent | P2 | M |
| DP-12 | Sample data + starter notebook | Ask #4 | Persisted sample dataset (try-before-subscribe) + generated starter notebook + schema-drift detection vs contract | ad-hoc top-25 per click | P2 | M |
| DP-13 | Live SLO monitoring | Ask #4 | Measure actual freshness/availability/latency vs declared SLO targets over time; burn/alert surface | declarative-only | P2 | M |
| DP-14 | Value metrics (OKRs + CDEs + cost) | Ask #4 | Link OKRs, attach Critical Data Elements, surface cost/consumption value on the product | none | P2 | M |
| DP-15 | Governed ↔ infra cross-linking | Ask #4/#5 | Bidirectional link between a governed `data-product` and the `data-product-instance` infra backing it; dependency graph | none | P2 | L |
| DP-16 | Editable / consumable / shareable end state | Ask #5 | Post-create landing; explicit owner-view vs consumer-view; marketplace + Delta Sharing publication path (rides `FGC-30` + PR #1578 + `W18`) | inconsistent per surface | P1 | M |

> **Excluded as already-owned (referenced, not rebuilt):** schema-diff/breaking-change engine (`W10` +
> `BR-CONTRACT-GATE`), DQ rule/score engine (`W11` + shipped `ContractQualityRunPanel`), cross-tenant
> external sharing (`FGC-30` + Delta Sharing PR #1578), marketplace listing analytics + subscriber SLA
> webhooks (`W18` + `BR-WEBHOOK`), cross-catalog impact-analysis-before-delete (`W8`). Also excluded:
> the contract designer, observability tab, and access-policy/access-request approval flow — all verified
> real and A-/B-grade; this PRP wires *around* them, not through them.

---

## DP-1 — Unify the data-product data model  *(P0, L — foundation for the whole PRP)*

**Capability.** One entity, one status vocabulary, one set of field names for one concept, and every read
surface projecting from the same source. This is the die-hard prerequisite: the wizard (DP-3), certification
(DP-5), ports (DP-8), and everything downstream all assume a single coherent record.

**Grounding.** Dehghani's *architectural quantum* — a data product is **one** owned, independently-versioned
unit (`https://www.oreilly.com/library/view/data-mesh/9781492092384/`); ODPS/ODCS define **one** canonical
`status` lifecycle field (proposed/draft/active/deprecated/retired) on the descriptor
(`https://bitol-io.github.io/open-data-contract-standard/v3.1.0/`). Purview exposes exactly one lifecycle
(Draft → Published → Unpublished → Expired) per product
(`https://learn.microsoft.com/en-us/purview/unified-catalog-data-products-create-manage`).

**Current Loom state — BROKEN (verified).** One `itemType='data-product'` Cosmos record is written by **four**
paths with three status vocabularies that no handler keeps in sync:
- `state.lifecycleStatus` — written by the apim-editors ribbon Publish/Unpublish/Expire, authoritative at
  `app/api/data-products/[id]/status/route.ts:171` (`state:{...state, lifecycleStatus:status, lifecycleStatusAt}`),
  gated by 3 real preconditions (≥1 dataset `:82`, an active access policy, a set domain `:107`).
- `state.status` — written **only** by the wizard create POST; read by `route.ts:242`
  (`status: ((st.status as DataProductStatus) ?? 'Draft')`) which **drives the details-page header badge**
  (`data-product-detail.tsx:787`, `statusColor(product.status)`).
- `state.publishStatus` — written **only** by the marketplace producer tab (`route.ts:523-526`); read **only**
  by the AI-Search index doc builder (`lib/azure/loom-data-products-search.ts:414,432`), the sole gate on
  consumer marketplace visibility.
- `state.content{kind:'data-product',…}` — written by app-bundle install; projected into the apim-editors
  fields at load (`apim-editors.tsx:2086-2116 projectDataProductContent`) but **never** read by
  `route.ts` `itemToProduct()`/`toDoc()` (`:163-256`) or the search doc builder — so the *same* bundle-installed
  product opens fully-built in one editor and **empty** on the Details page and **invisible** to marketplace search.

Net effect: Publish via the ribbon sets `lifecycleStatus=PUBLISHED` but not `status` (badge stays "Draft"
forever) and not `publishStatus` (never enters marketplace search). Three surfaces, three truths.

**Azure-first build.**
- **Backend/model:** define one canonical enum `LifecycleState = 'draft'|'validated'|'certified'|'published'|'deprecated'|'retired'` in a new `lib/dataproducts/lifecycle.ts` (superset that also carries DP-5's certification and DP-9's deprecation states). Keep `state.lifecycleState` as the single source of truth. Add a **one-time read-time migration shim** `resolveLifecycleState(state)` that folds the three legacy fields (`lifecycleStatus`/`status`/`publishStatus`, either casing) into the canonical value with a documented precedence, so existing Cosmos records render correctly with no data backfill required; a lazy write-back stamps `lifecycleState` on next save.
- **Write-path reconciliation:** every mutation that changes lifecycle (`status/route.ts`, the wizard POST at `app/api/data-products/route.ts:276-371`, the marketplace publish at `route.ts:250-274`, and the PATCH at `route.ts:523`) calls **one** `setLifecycleState()` helper that (a) writes `state.lifecycleState`, (b) mirrors the legacy trio for backward-compat during the deprecation window, and (c) **re-projects the marketplace search doc** so a lifecycle Publish also makes the product discoverable — closing the "Publish here doesn't publish there" defect.
- **Projection parity:** add the missing `state.content` read to `itemToProduct()`/`toDoc()` and to `docForDataProduct()` so a bundle-installed product is identical across the Details page, the apim-editors surface, and marketplace search. One shared `projectDataProduct(state)` used by all three.
- **BFF:** no new routes; this is a correctness refactor of the existing four handlers behind one helper module.
- **UI:** the Details-page badge (`data-product-detail.tsx:787`) and the apim-editors ribbon read `resolveLifecycleState()`; a single status chip vocabulary everywhere. LearnPopover on the badge explains the states.
- **Catalog/bicep:** none (behavioural). **Gov:** pure Cosmos/logic — both clouds identical.

**No-vaporware acceptance receipt.** Create a product via the apim-editors inline form, click ribbon **Publish**;
receipt = (a) the Details-page badge now reads "Published" (previously stuck "Draft"), (b) a `GET` of the
AI-Search index returns the product as discoverable, (c) the bundle-installed sample product renders identical
datasets/glossary/owner on the Details page, apim-editors, and marketplace — three surfaces, one truth. Include
the before/after Cosmos `state` diff and a Playwright screenshot of the badge.

**Effort:** L. **Priority:** P0 (hard prerequisite; DP-3/DP-5/DP-8 all assume it).

---

## DP-2 — Item-type taxonomy cleanup  *(P0, M)*

**Capability.** A `/new` gallery a stranger can read: one obvious governed **Data product** entry point, the
template gallery reachable as an explicit "start from a template" affordance (not a look-alike sibling that
creates nothing), and instances that clearly show their template provenance rather than dead-ending.

**Grounding.** Best-in-class creation flows (Purview, Databricks Marketplace) expose **type/template as a
lightweight starting choice inside one creation flow**, not as separate top-level entities
(`https://learn.microsoft.com/en-us/azure/databricks/marketplace/create-listing`). Databricks/Unity-Catalog
organize products under one navigable hierarchy, not three parallel item types.

**Current Loom state — CONFUSED (verified).** All four types sit in one category `'CSA Data Products'`
(`lib/catalog/item-types/csa-data-products.ts:11,36,60,84`); only `data-marketplace` sets `coreSurface:true`
(hidden from `/new`). So `data-product`, `data-product-template`, `data-product-instance` all render as
sibling cards. `data-product-template` GET (`app/api/items/data-product-template/[id]/route.ts:11-18`) and its
editor (`lib/editors/data-product-editors.tsx:97-137`) both **ignore the item id** and always render the static
`CURATED_TEMPLATES` gallery — "New → Data product template" persists nothing. `data-product-instance` editor
`loadInstance()` returns early for `id==='new'` (`data-product-editors.tsx:335-336`) → dead-end EmptyState
(`:397-400`). No LearnContent block cross-references the siblings.

**Azure-first build.**
- **Taxonomy:** keep exactly one governed entry point on `/new` — **Data product** (opens the DP-3 wizard).
  Reclassify `data-product-template` as a **non-creatable browse surface**: set `coreSurface:true` (or a new
  `hiddenFromGallery:true`) so it no longer masquerades as a persisted item; its gallery becomes step 3 of the
  DP-3 wizard ("start from a template") and a `/data-products/templates` browse page, not a `/new` card.
  `data-product-instance` likewise `hiddenFromGallery` — it is only ever born from a template Instantiate
  (DP-4 surfaces provenance) and links back to its governed product (DP-15).
- **LearnContent:** rewrite the three `learnContent` blocks (`csa-data-products.ts:13-33,62-82,86-105`) to
  cross-reference each other in plain language: "*A **Data product** is the governed, contract-bound unit
  consumers discover and subscribe to. A **template** is a starting shape that stamps out a data product plus
  its backing infra. An **instance** is the deployed infra bundle a template produced — open its parent Data
  product to govern it.*"
- **BFF/UI:** the `data-product-template` GET/editor stay for the browse page but no longer pretend to be a
  draftable item. No data migration.
- **Catalog/bicep:** catalog-flags only. **Gov:** identical both clouds.

**No-vaporware acceptance receipt.** `/new` shows exactly **one** Data-product card (screenshot); clicking it
opens the DP-3 wizard; "start from a template" inside the wizard reaches the gallery; an existing instance shows
its template name + a link to its governed product. No card in `/new` any longer creates nothing.

**Effort:** M. **Priority:** P0 (pairs with DP-1; removes the first thing a new user trips on).

---

## DP-17 — Fix the three freeform-config violations  *(P0, S)*

**Capability.** Replace every hand-typed delimited/free-text config on the data-product surfaces with the
structured picker the concept demands, per `loom_no_freeform_config`.

**Grounding.** Loom die-hard rule: all config = dropdowns / wizards / pickers / canvas (no freeform text or
JSON) except 1:1 ADF/Synapse expression builders. Purview/Databricks owner fields are Entra people-pickers,
not comma-strings; typed attributes render typed controls.

**Current Loom state — 3 violations (verified).**
1. `lib/editors/data-product-edit-dialog.tsx:294` — **"Owners (comma-separated emails)"** is a plain `<Input>`
   the user hand-types as a delimited string, parsed server-side by `asArray()`/`mergeOwners()`
   (`app/api/data-products/[id]/route.ts:122-144`).
2. `lib/editors/apim-editors.tsx:3123` — **"Owner (email)"** single free-text `<Input>` (`state.owner`) that
   conflicts with the richer `owners[]` model used by the create wizard + edit dialog, reconciled only by a
   read-time singular fallback (`route.ts:189-199`).
3. `lib/editors/data-product-edit-dialog.tsx:346-352` — custom-attribute values render as a **single generic
   `<Input>`** regardless of the attribute's declared `fieldType` (`'Single choice'/'Multiple choice'/'Date'/
   'Boolean'/'Integer'/'Double'/'Rich text'`, defined at `data-product-create-wizard.tsx:94-95`).

**Azure-first build.**
- **(1)+(2) People-picker:** replace both owner inputs with the **Microsoft Graph search-as-you-type
  people-picker** the create wizard already uses (principal search), writing the rich `owners[]`
  `{id,upn,displayName}` shape. The single `state.owner` is retired into `owners[0]` on read (keep the fallback
  only for legacy records). Backend already accepts `owners[]` — this is a client swap + one server-side
  normalization so both surfaces feed the same array.
- **(3) Typed attribute editors:** render the control matching each `AttributeDef.fieldType` — `Dropdown`
  (single/multiple choice), `DatePicker` (date), `Switch` (boolean), `SpinButton`/number input (integer/double),
  rich-text field (rich text) — reusing the wizard's step-3 renderer so the edit dialog and the wizard share
  one typed-attribute component.
- **BFF/catalog/bicep:** none (client + one normalization helper). **Gov:** Graph people-picker resolves the
  Gov Graph endpoint per cloud (already handled by the wizard's picker).

**No-vaporware acceptance receipt.** In the edit dialog, add an owner by typing a name → Graph suggestions →
pick → `owners[]` persists the resolved UPN (no comma parsing); a `Single choice` custom attribute renders a
Dropdown, a `Date` renders a DatePicker, a `Boolean` renders a Switch. Screenshot each + the persisted `state`.

**Effort:** S. **Priority:** P0 (small, and it removes standing rule violations on the flagship surface).

---

## DP-3 — Guided creation wizard  *(P0, XL — operator ask #1)*

**Capability.** A multi-step **pre-create** wizard that replaces the bare `/new` form, matching the shape every
best-in-class platform converged on: **(1) Basics** (name, description, type, audience, owner) → **(2) Business
context** (governance domain placement) → **(3) Template** (gallery with live "what you get" preview, or start
blank) → **(4) Sources & ports** (attach datasets / declare input+output ports) → **(5) Contract & SLOs** (the
existing typed contract designer) → **(6) Access policy** (self-serve vs tiered-approval, attestations, or skip)
→ **(7) Review & preview** (see exactly what a consumer will see, then Publish). Progressive disclosure: a DRAFT
record is created immediately after step 1; every later step is **skippable-with-defaults** per the default-ON
posture, and only the mandatory subset (assets attached + access policy configured, per Purview) gates Publish.

**Grounding.** Purview create-manage flow (Basic details → domain → assets → policies → preview request form →
publish, with hard prerequisites)
`https://learn.microsoft.com/en-us/purview/unified-catalog-data-products-create-manage`; Databricks Marketplace
guided listing wizard (profile → asset selection → discovery attributes → description/resources, draft-save +
live preview each step) `https://learn.microsoft.com/en-us/azure/databricks/marketplace/create-listing`; ODPS/ODCS
progressive descriptor (draft first, harden before live) `https://opendataproducts.org/`.

**Current Loom state — two competing thin flows (verified).** `/data-products/new` mounts
`DataProductCreateWizard` (`lib/data-products/data-product-create-wizard.tsx`, a 3-step Purview-parity wizard,
POST `/api/data-products`), while `/items/data-product/new` opens the apim-editors inline single-page Overview
form. Neither has the full 7-step shape; nothing tells the user they are different flows landing different-shaped
state on the same record (see DP-1). No template step, no ports step, no preview step.

**Azure-first build.**
- **One wizard:** promote `DataProductCreateWizard` to the canonical 7-step flow and make it the **only** create
  entry (the `/new` card from DP-2 routes here; the apim-editors inline create is retired to "edit an existing
  product"). Build on the existing Fluent `Wizard`/stepper pattern; each step is a component, `owners[]`/domain/
  contract all reuse existing typed controls (people-picker, domain dropdown, `DataContractDesigner`).
- **Draft-on-step-1:** POST a DRAFT (canonical `lifecycleState:'draft'` from DP-1) immediately after Basics so
  the product is autosaved and resumable; later steps PATCH. Every step has **Skip** (writes the documented
  default) and **Save & exit**.
- **Template step (rides DP-4):** the `CURATED_TEMPLATES` gallery with a live preview panel; picking one
  pre-fills sources/ports/contract; "start blank" is always available.
- **Ports step (rides DP-8):** attach datasets (existing Purview-scoped asset search) + declare input/output
  ports.
- **Access step:** the existing access-policy designer with an explicit **Skip / delegate to external access
  system** escape hatch (Purview parity).
- **Review step:** renders the **consumer-facing preview** (the no-vaporware QA gate) + a checklist of what's
  still missing before Publish; Publish is refused (honest MessageBar, not silent) until the mandatory subset is met.
- **BFF:** reuse `/api/data-products` create + the DP-1 `setLifecycleState`; add `POST /api/data-products/[id]/preview`
  returning the consumer projection.
- **Catalog/bicep:** none new. **Gov:** identical (Cosmos + Graph + existing designers).

**No-vaporware acceptance receipt.** Walk the wizard end-to-end: after step 1 a DRAFT exists in Cosmos (receipt =
the POST response id); skip steps 2–4 with defaults; the Review step shows the real consumer preview; attempt
Publish with no access policy → honest MessageBar blocks it; add the policy → Publish succeeds and (via DP-1)
the product is Published on the badge *and* discoverable in marketplace search. Playwright trace of all 7 steps.

**Effort:** XL. **Priority:** P0 (the headline ask; unblocks the "editable/usable" end state).

---

## DP-4 — Template gallery + instance provenance  *(P1, L — operator ask #1)*

**Capability.** A template gallery that shows **"what you get"** before you pick (assets, contract shape,
backing infra, sample), instances that surface their **template provenance**, and — critically — **every**
template also stamps a governed `data-product` (not just infra).

**Grounding.** Databricks Marketplace listing preview + bundled sample notebooks/docs
`https://learn.microsoft.com/en-us/azure/databricks/marketplace/create-listing`; Purview typed-taxonomy-as-template
`https://learn.microsoft.com/en-us/purview/unified-catalog-data-products-create-manage`.

**Current Loom state — thin + broken linkage (verified).** `CURATED_TEMPLATES`
(`lib/catalog/data-product-templates.ts:45+`) renders a flat gallery; **only** `'federated-mesh'`
(`:149-158`) spawns a governed `data-product` among its components — the other ~9 (medallion lakehouse, IoT,
RAG, geospatial, …) produce infra-only `data-product-instance` bundles with **no** governed contract/access/
lifecycle record. An instance's components table (`data-product-editors.tsx:403-438`) never references a
`data-product` id.

**Azure-first build.**
- **"What you get" previews:** each template gains a structured preview (item-type list, contract preview,
  sample-data note, backing infra) rendered in the DP-3 template step and the `/data-products/templates` browse
  page — Fluent cards, no freeform.
- **Every template stamps a governed product:** extend the template Instantiate path so **all** templates add a
  `data-product` component (governed record with a default contract + owner from the wizard), not just
  `federated-mesh`. The infra `data-product-instance` gets a back-pointer to that product id (feeds DP-15).
- **Instance provenance:** the instance editor shows "Created from template **X**" + a link to the governed
  product; the governed product shows "Backed by instance **Y**" (DP-15 cross-link).
- **BFF:** extend `/api/items/data-product-template/[slug]/instantiate` to create the governed product +
  cross-links. **Catalog/bicep:** none. **Gov:** identical.

**No-vaporware acceptance receipt.** Instantiate the **medallion** template (previously infra-only); receipt =
a governed `data-product` created alongside the infra instance, the instance shows its template provenance +
product link, and the product shows its backing-instance link. Screenshot both + the created Cosmos records.

**Effort:** L. **Priority:** P1 (makes the push-button gallery actually produce *products*, not just resources).

---

## DP-5 — Certification pipeline (state machine)  *(P0, XL — operator ask #2)*

**Capability.** A real certification lifecycle — **draft → validated → certified** — where the jump to
*certified* is **gated by live automated checks**, not a one-time human toggle, plus a two-rung endorsement
ladder (**Promoted** = lightweight crowd signal; **Certified** = authoritative, approver-gated). Certification
status is visible on the catalog card and the marketplace listing.

**Grounding.** Power BI two-tier endorsement (Promoted, any editor / Certified, admin-restricted reviewer pool,
certifier identity shown) `https://learn.microsoft.com/en-us/power-bi/collaborate-share/service-endorsement-overview`;
Purview health-score control groups (Discoverability / Trusted data / Metadata quality — averaging % owned,
% quality-scored, % certified) `https://learn.microsoft.com/en-us/purview/unified-catalog-controls`; Purview
single "Endorsed" flag settable only by the Data Product Owner
`https://learn.microsoft.com/en-us/purview/unified-catalog-data-products-create-manage`; ODCS schedulable SLA
tests + `datacontract-cli` as the "continuously-verified" bar.

**Current Loom state — two unsynced booleans (verified).** `certified` (Purview-style, `apim-editors.tsx:2007,
2128-2130`) and `endorsed` (marketplace-style, `:2014`) are independent booleans shown as two badges
(`:2978-2979`) with overlapping meaning and **no** workflow, no gating checks, no certifier identity, no recert
date, no audit trail.

**Azure-first build.**
- **State machine:** add `certificationState ∈ {draft, validated, certified}` to the DP-1 canonical model, with
  an **automated-checks engine** `lib/dataproducts/certification.ts` computing a composable score from concrete,
  live checks (each a pass/fail with an honest "what's missing" message): (1) owner assigned, (2) description +
  use-case above a min-length bar, (3) ≥1 linked glossary term/CDE, (4) ≥1 asset attached with resolvable
  lineage, (5) an **active DQ score above threshold** (consumes `W11` + the shipped `ContractQualityRunPanel`
  ADX run), (6) SLOs defined **and monitored** (consumes DP-13), (7) contract present + validated (consumes
  `W10`/`BR-CONTRACT-GATE`), (8) access policy configured or explicitly self-serve, (9) sample data present
  (DP-12). **validated** = checks 1-4+7 pass; **certified** = all pass **and** an explicit human sign-off from an
  authorized reviewer **distinct from the creator**.
- **Honest gating:** the Certify action is **visibly blocked** in the UI (a checklist with red/green rows +
  "what's missing", not a silent allow or a human override of a failing score) — the no-vaporware bar. Score is
  re-evaluated on load and on a schedule; a drop below threshold flips certified → validated and notifies the owner.
- **Endorsement ladder:** **Promoted** (any owner/editor, lightweight badge) vs **Certified** (approver-role gated,
  prominent badge showing the certifier's identity + date). Reconcile the two legacy booleans into this ladder.
- **Approver roles:** reuse the existing access-approver role model; add a **Data Product Owner** (can flip
  certification) and a **certifier pool** (admin-defined). Certification chain is **orthogonal** to the access
  chain (a product can be certified but access-gated, or access-open but not yet certified).
- **Visibility:** the badge flows into the catalog card and the AI-Search marketplace doc (via DP-1's
  `projectDataProduct`), so the trust signal shows at the point of discovery (Collibra parity).
- **BFF:** `GET /api/data-products/[id]/certification` (live score + per-check status), `POST .../certify`
  (sign-off, records certifier + timestamp + audit entry). **Catalog:** badge on the card. **Bicep:** none (Cosmos).
  **Gov:** identical (ADX DQ + Cosmos both GA in Gov; honest-gate if `LOOM_KUSTO_CLUSTER_URI` unset).

**No-vaporware acceptance receipt.** Attempt to certify a product missing a DQ score → the Certify button is
blocked with a red checklist row naming the gap; add assets + run the DQ enforcement (real ADX score) + set an
access policy → all rows green → a reviewer (≠ creator) signs off → badge shows **Certified by <name> on <date>**
on the editor, the catalog card, and the marketplace listing. Screenshot the checklist (blocked + passing) + the
badge in all three places.

**Effort:** XL. **Priority:** P0 (operator ask; the differentiator none of the surveyed vendors fully ship).

---

## DP-6 — In-product walkthroughs + LearnPopovers  *(P1, M — operator ask #3)*

**Capability.** A **"Complete your data product"** progress checklist on the editor (the same checks DP-5
computes, surfaced as guidance while you build) + LearnPopovers explaining the model (what a data product /
template / instance / port / contract / certification tier *is*, and which one to start with).

**Grounding.** Progressive-disclosure creation flows surface a "what's left before you can publish/certify"
checklist (Purview publish prerequisites, Databricks listing completeness). Loom `loom_design_standards` +
the existing LearnPopover pattern (40-page LearnPopover program shipped in Wave 5).

**Current Loom state — none (verified).** No LearnPopover/`learnContent` step explains the template→instance
relationship or the four-surface model; the per-type `learnContent` blocks describe each type in isolation with
no cross-reference (see DP-2). No completion checklist on any editor.

**Azure-first build.**
- **Completion checklist:** a collapsible "Complete your data product" panel on the details/editor surface
  rendering DP-5's live per-check rows with deep-links to the step that fixes each (jump to the contract tab,
  the access-policy tab, etc.) — a guided path to certified, not a wall of tabs.
- **LearnPopovers:** attach LearnPopovers to the status badge (DP-1 states), the certification badges (DP-5
  ladder), the ports panel (DP-8), and the template/instance affordances (DP-2 cross-reference copy). Reuse the
  shipped LearnPopover component + tone.
- **BFF/catalog/bicep:** none (client + content). **Gov:** identical.

**No-vaporware acceptance receipt.** Open a half-built product → the checklist shows 4/9 complete with the 5 gaps
named and each linking to its fix; hovering the status badge opens a LearnPopover explaining the lifecycle;
hovering "template" explains it stamps a product + infra. Screenshots.

**Effort:** M. **Priority:** P1 (cheap, high-orientation-value; pairs with DP-5).

---

## DP-7 — Copilot data-product builder  *(P1, L — operator ask #3)*

**Capability.** An AI assist woven across the wizard/editor that drafts **descriptions**, proposes **contract
schema + quality rules** from asset profiling, and **suggests which assets belong together** based on
lineage/usage — the frontier pattern (SAP Joule, Alation "chat with your data product", data.world graph
suggestions), Azure-native via AOAI.

**Grounding.** SAP Datasphere Joule embedded authoring `https://www.sap.com/products/data-cloud/datasphere.html`;
Alation no-code AI builder `https://www.alation.com/product/data-products-marketplace/`; data.world
knowledge-graph auto-suggestions `https://data.world/`. Loom already ships Copilot builders on ~10 surfaces
(kql-database, kql-dashboard, semantic-model, report — the `<CopilotBuilderPane>` pattern in G1/AIF work).

**Current Loom state — none (verified).** No Copilot/AI-assist surface exists on any of the data-product editors
(the contract/observability tabs are hand-authored). The AOAI client + the shared Copilot-builder pattern exist
elsewhere and are reused, not built new.

**Azure-first build.**
- **Copilot pane:** add a `<CopilotBuilderPane>` (the shared primitive from the G1/AIF Copilot work) to the DP-3
  wizard steps 1-5 and the editor, backed by the unified `aoai-chat-client`, with three grounded actions:
  **(a) draft description** from name + attached assets, **(b) propose contract** — infer schema from a
  `SELECT TOP` profile of the attached table (existing `synapse-sql-client`/`kusto-client`) and draft typed
  quality rules (row-count, null-rate, uniqueness) into the existing typed contract designer (no JSON — it fills
  the structured grid), **(c) suggest related assets** from Purview lineage/usage (existing Purview Data Map
  client). All outputs land in the **structured** controls, never a textarea.
- **BFF:** `POST /api/data-products/[id]/copilot/{describe,draft-contract,suggest-assets}` calling AOAI +
  the existing profiling/lineage clients. **Catalog/bicep:** none. **Gov:** AOAI + Synapse/ADX/Purview all GA in
  Gov; honest-gate if AOAI env unset (reuse `resolveAoaiTarget()`).

**No-vaporware acceptance receipt.** On a product with an attached ADX table, click **Propose contract** →
Copilot profiles the real table and fills the typed schema grid + 3 quality rules (receipt = the profile query
result + the populated grid, not a JSON blob); **Draft description** returns grounded prose; **Suggest assets**
returns real lineage-related tables. Screenshots + the AOAI response first-300-chars.

**Effort:** L. **Priority:** P1 (rides existing AOAI + Copilot-pane plumbing).

---

## DP-8 — Input / output / management ports  *(P1, L — operator ask #4)*

**Capability.** Declared **input ports** (upstream dependencies the product consumes), **output ports**
(contract-bound interfaces it exposes), and **management ports** (health/observability/control endpoints), each
linkable 1:many to a data contract — the ODPS/Bitol port model that distinguishes a mesh product from a dataset.

**Grounding.** Bitol ODPS input **and** output ports + management ports (discoverability/observability/control)
`https://bitol-io.github.io/open-data-product-standard/v1.0.0/`; ODCS contract binding per port
`https://bitol-io.github.io/open-data-contract-standard/v3.1.0/`.

**Current Loom state — output-only, no ports (verified).** `lib/dataproducts/contract.ts` `DataContract` has
only an **output** schema (`data-contract-designer.tsx:124-194`); there is no input-port concept anywhere, so no
upstream-dependency lineage, no impact analysis, no breaking-change propagation to consumers.

**Azure-first build.**
- **Model:** add `ports: { input[], output[], management[] }` to the canonical model. **Input ports** reference
  an upstream `data-product` id or an Azure asset (Synapse table / ADX table / ADLS path / another product's
  output port), each optionally bound to the upstream's contract. **Output ports** are the existing
  contract-bound interfaces (SQL endpoint / ADX / Delta / REST), made explicit and 1:many to a contract.
  **Management ports** register the already-real health/lineage/DQ endpoints (the observability tab's
  trigger-scan/refresh-lineage/rerun-dq actions) as declared control endpoints.
- **Ports designer:** a **Ports** tab in the editor + wizard step 4 — a Fluent panel (not a canvas necessarily,
  but reusing `canvas-node-kit` tokens) listing input/output/management ports with add-via-picker (asset/product
  search — no freeform), each row linking to its contract. Feeds the DP-9 breaking-change propagation and the
  DP-15 dependency graph.
- **BFF:** `PATCH /api/data-products/[id]` ports; `GET .../ports` resolves upstream contracts. **Catalog/bicep:**
  none. **Gov:** identical.

**No-vaporware acceptance receipt.** Declare an input port referencing an upstream product's output port + an
output port bound to the product's contract; receipt = the ports persisted, the upstream contract resolved and
shown, and the port appearing in the DP-15 dependency graph. Screenshot the Ports tab + the resolved contract.

**Effort:** L. **Priority:** P1 (the core mesh-class model gap; DP-9 + DP-15 build on it).

---

## DP-9 — Versioning + deprecation policy  *(P1, L — operator ask #4)*

**Capability.** Semver discipline for the product/contract (patch/minor/major with a precise "what's breaking"
taxonomy), a **version history + diff**, a **breaking-change gate at publish** (schema-diff), and a **humane
deprecation workflow** — deprecation window with parallel-run, a replacement-product pointer, a scheduled sunset
date, and proactive consumer notification.

**Grounding.** Data-product semver taxonomy — major = type change / semantic redefinition / grain change /
key-cardinality change / filter-scope change / access-policy change
`https://rewirenow.com/en/resources/blog/how-data-product-versioning-can-make-or-break-your-federated-data-strategy/`;
advance-notice deprecation (parallel-run window, EOL date, changelog, 30–90-day lead)
`https://glitni.no/en/articles/a-complete-guide-to-data-products/08-change-and-deprecation/`; `datacontract-cli`
breaking-change detection `https://github.com/datacontract/datacontract-cli`.

**Current Loom state — free-text version, overwrite-on-save, no deprecation (verified).** Contract `version`
(`contract.ts:138-139`) is a free-text string with no enforcement, no history, no diff;
`DataContractStudioTab` (`data-contract-designer.tsx:530-612`) **overwrites** the single current contract on
every Save (no breaking-change detection). Lifecycle stops at Draft/Published/Expired
(`status/route.ts:51`); "Expired" is an instantaneous manual flip (`apim-editors.tsx:2626-2653`) — no window,
no replacement pointer, no consumer notice.

**Azure-first build.**
- **Rides the schema-diff engine (dedupe):** the breaking-change detector is **`W10` + `BR-CONTRACT-GATE`** —
  DP-9 does **not** write a second differ. It (a) makes contract `version` a **structured semver picker**
  (major/minor/patch bump buttons that *suggest* the level by running the `W10` schema-diff between the saved
  and edited contract and classifying per the taxonomy above), (b) **appends** each save as a new immutable
  version (version history list + side-by-side diff) instead of overwriting, and (c) at **Publish** invokes the
  `BR-CONTRACT-GATE` publish-time gate: a detected breaking change blocks publish unless the owner performs a
  **major** bump + provides a migration note (honest MessageBar, not silent).
- **Deprecation workflow:** add canonical states `deprecated`/`retired` (from DP-1). A **Deprecate** action opens
  a form: sunset date (DatePicker), replacement-product picker, migration note, and a notice-lead dropdown
  (30/60/90 days) — all structured. On deprecate, consumers with active subscriptions are notified (reuse
  DP-10/`W18` notification path); the product stays queryable through the window (parallel-run), then flips to
  `retired` on the sunset date via a scheduled check.
- **BFF:** `POST /api/data-products/[id]/versions` (append + diff), `POST .../deprecate`,
  `GET .../versions`. **Catalog/bicep:** none (Cosmos). **Gov:** identical.

**No-vaporware acceptance receipt.** Edit a contract to drop a column → the semver picker flags **major** +
Publish is gated by `BR-CONTRACT-GATE` until a major bump + migration note; version history shows v1→v2 diff;
Deprecate with a 60-day sunset + replacement pointer → subscribers notified, product still queryable, and a
scheduled flip to `retired` on the date. Screenshots of the gate, the diff, and the deprecation form.

**Effort:** L. **Priority:** P1 (references `W10`/`BR-CONTRACT-GATE`; adds the version-history + deprecation glue).

---

## DP-10 — Subscription approval + automated fulfillment  *(P1, L — operator ask #4)*

**Capability.** Keep Loom's already-real tiered-approval access-request flow, and add **zero-touch automated
fulfillment**: on approval, the underlying Azure RBAC (ADLS/Synapse/ADX read grants) is **auto-provisioned** with
no manual grant step — the AWS DataZone bar — with a usage-purpose picklist, attestations (no-copy / terms /
custom), and an explicit skip/delegate path.

**Grounding.** AWS DataZone/SageMaker Catalog automated subscription fulfillment (approved subscriptions
auto-provision Lake Formation/Glue/Redshift permissions + emit events for custom workflows)
`https://aws.amazon.com/blogs/big-data/accelerate-data-governance-with-custom-subscription-workflows-in-amazon-sagemaker/`;
Purview access-policy tiered approval + usage-purpose + attestations
`https://learn.microsoft.com/en-us/purview/unified-catalog-data-product-access-policies`.

**Current Loom state — approval real, fulfillment manual (verified).** `app/api/data-products/[id]/access-requests/route.ts`
+ `access-policy/route.ts` implement a real Purview-parity approval flow (approver inbox, request state machine,
delete-preconditions), but approval **records status only** — there is no auto-grant of the underlying storage/
SQL RBAC; a human must still grant access out-of-band (Purview's own limitation).

**Azure-first build.**
- **Fulfillment engine:** on approval, a `fulfillSubscription()` step resolves the product's output-port backing
  resources (DP-8) and performs the real Azure RBAC grant via the existing role-assignment path (the proven
  `az rest` role-assignment pattern from the Copy/managed-VNet work — CLI `az role assignment` is broken, use
  `az rest`) — e.g. **Storage Blob Data Reader** scoped to the ADLS path, **db_datareader** on the Synapse
  serverless DB, ADX **viewer** on the table. Emits a standard event (reuse `BR-WEBHOOK`) so custom/event-driven
  fulfillment can layer on for non-native asset types (DataZone parity).
- **Request form:** add a **usage-purpose** picklist + **attestations** (no-copy / terms-of-use / custom
  checkboxes) + an owner **skip/delegate** toggle (Purview "skip workflow" escape hatch). A **My data access**
  tab tracks request status (Pending → Approved → **Provisioned**) for the requester.
- **BFF:** extend `access-requests/route.ts` approve handler with `fulfillSubscription`; `GET .../my-access`.
  **Catalog:** none. **Bicep:** the Console UAMI needs **User Access Administrator** (or a scoped custom role)
  on the data-plane RG to grant — an honest operator-action, default-off with a MessageBar naming the role.
  **Gov:** role-assignment REST identical (endpoint suffix per cloud).

**No-vaporware acceptance receipt.** A consumer requests access with a usage purpose + accepts the no-copy
attestation; the approver approves; receipt = the **real** role-assignment PUT response granting Storage Blob
Data Reader on the product's ADLS path, the consumer's My-access tab flips to **Provisioned**, and the consumer
can now read the data (real query). No manual portal grant. Include the role-assignment response + the webhook event.

**Effort:** L. **Priority:** P1 (turns approval into fulfillment; the DataZone-class differentiator).

---

## DP-11 — Consumer feedback / ratings / usage analytics  *(P2, M — operator ask #4)*

**Capability.** Ratings, a comment/feedback thread, and consumption telemetry (most-used queries, subscriber
trend, freshness-of-use) on **both** the owner Details page and the consumer marketplace view.

**Grounding.** Purview data-health remediation actions (failing controls become assigned, trackable work items)
`https://learn.microsoft.com/en-us/purview/unified-catalog-data-health-management-actions-page`; Collibra
marketplace trust signals (quality/certification/lineage on the card)
`https://www.collibra.com/blog/find-trusted-data-products-faster-with-the-new-collibra-data-marketplace-experience`.

**Current Loom state — absent (verified).** Neither the owner Details page nor the consumer marketplace view has
ratings, comments, or usage analytics beyond raw `subscriberCount` (`data-product-detail.tsx:881`); the Try-it
panel's run history is not persisted.

**Azure-first build.**
- **Ratings + comments:** a Cosmos-backed `productFeedback` container (rating 1-5 + threaded comments + @mentions,
  reusing `BR-COMMENTS`/`W4` comment plumbing where it lands) shown on both views; aggregate rating on the catalog
  + marketplace card (trust signal at point of discovery).
- **Usage analytics:** surface consumption telemetry from the **existing** access + query paths — subscriber trend,
  top queries (from the Try-it / grounded-execute logs), last-consumed timestamp — reusing **`W18`** marketplace
  listing analytics + subscriber-SLA-webhook plumbing rather than a new telemetry pipeline.
- **BFF:** `GET/POST /api/data-products/[id]/feedback`, `GET .../usage`. **Catalog:** rating on the card.
  **Bicep:** Cosmos container via `createIfNotExists`. **Gov:** Cosmos GA both clouds.

**No-vaporware acceptance receipt.** A consumer leaves a 4-star rating + a comment; both render on the owner
Details page and the marketplace card with the aggregate; the usage panel shows a real subscriber trend + top
queries from actual execution logs. Screenshots + the persisted feedback record.

**Effort:** M. **Priority:** P2 (rides `W18` + `BR-COMMENTS`).

---

## DP-12 — Sample data + starter notebook  *(P2, M — operator ask #4)*

**Capability.** A **persisted** sample dataset for try-before-subscribe, a generated **starter notebook** that
queries the product, and **schema-drift detection** between the declared contract and the live table.

**Grounding.** Databricks Marketplace free sample data + sample notebooks bundled on the listing
`https://learn.microsoft.com/en-us/azure/databricks/marketplace/create-listing` (get-started-consumer);
Dehghani "natively accessible / self-describing" usability attribute.

**Current Loom state — ad-hoc, not persisted (verified).** `DataProductTryItPanel`
(`data-product-detail.tsx:218-253`) runs a single "top 25 rows" query per click — no persisted sample, no
starter notebook, no schema-drift check against the contract.

**Azure-first build.**
- **Persisted sample:** a "Publish sample" action snapshots N rows (owner-configurable, PII-masked per the
  contract's classification tags) to a small Cosmos/ADLS-backed cache the consumer can preview **without** a
  subscription (the try-before-subscribe surface).
- **Starter notebook:** generate a notebook (reuse the notebook item type) pre-wired to the product's output-port
  endpoint with a sample query — "Open starter notebook" on the consumer view.
- **Schema-drift detection:** on load (and on a schedule), diff the live table schema (existing profiling clients)
  vs the declared contract schema; a drift raises an honest banner + (via DP-5) drops the certification score.
- **BFF:** `POST /api/data-products/[id]/sample` (snapshot), `GET .../sample`, `GET .../drift`,
  `POST .../starter-notebook`. **Catalog/bicep:** Cosmos/ADLS cache via existing clients. **Gov:** identical.

**No-vaporware acceptance receipt.** Publish a sample → a consumer previews the masked sample rows with no
subscription; "Open starter notebook" creates a runnable notebook that returns real rows; introduce a column
type change on the source → the drift banner fires and certification drops to validated. Screenshots + records.

**Effort:** M. **Priority:** P2.

---

## DP-13 — Live SLO monitoring  *(P2, M — operator ask #4)*

**Capability.** Measure **actual** freshness / availability / latency / completeness against the contract's
declared SLO targets over time, with an SLO-burn/alert surface — turning the declarative SLO fields into an
operational, alertable metric.

**Grounding.** ODCS executable/schedulable SLA properties (latency/freshness/retention/availability/throughput,
testable) `https://bitol-io.github.io/open-data-contract-standard/v3.1.0/`; Purview DQ threshold color-bands +
breach alerting `https://learn.microsoft.com/en-us/purview/unified-catalog-data-quality-threshold`.

**Current Loom state — declarative-only (verified).** The contract's SLO fields
(`freshness/availability/latencyP95/completeness/retention/supportResponse`, `data-contract-designer.tsx:203-234`)
are typed dropdowns, but nothing **measures** actual values vs target — there is only the one-shot DQ-rule
enforcement run (`ContractQualityRunPanel`), no SLO burn or alerting.

**Azure-first build.**
- **Measurement:** a scheduled SLO evaluator (reuse the existing observability ADX path + the Activator/Monitor
  scheduled-query pattern from the RTI work) computes freshness (max event time vs now), availability (query
  success rate), latency (p95 from query logs), completeness (row-count vs expected) per product and stores a
  time series (ADX table / Cosmos).
- **Burn surface:** an **SLO** panel on the Details page — target vs actual gauges with color bands + a burn
  trend; a breach routes an alert to the owner (Azure Monitor scheduled-query alert, the no-fabric Activator
  substitute) and feeds DP-5 (SLO-monitored check) + DP-11.
- **BFF:** `GET /api/data-products/[id]/slo` (targets + measured series). **Catalog:** none.
  **Bicep:** a scheduled-query alert rule via `monitor-client` (honest-gate if Monitor unset). **Gov:** ADX +
  Monitor GA both clouds.

**No-vaporware acceptance receipt.** With a freshness SLO of "< 1 hour", let the source go stale → the SLO panel
shows actual freshness breaching target with a red band, an Azure Monitor alert fires, and DP-5's "SLOs monitored"
check reflects the breach. Screenshots + the alert + the measured series.

**Effort:** M. **Priority:** P2.

---

## DP-14 — Value metrics (OKRs + CDEs + cost)  *(P2, M — operator ask #4)*

**Capability.** Bind **OKRs** to the product, attach **Critical Data Elements**, and surface **cost/consumption
value** — formalizing Dehghani's "valuable on its own" as structured fields rather than marketing text.

**Grounding.** Purview OKRs linked to data products
`https://learn.microsoft.com/en-us/purview/unified-catalog-okrs`; Critical Data Elements auto-attaching to
products `https://learn.microsoft.com/en-us/purview/unified-catalog-critical-data-elements`; ODPS v4.1
`productStrategy` OKR object `https://opendataproducts.org/`.

**Current Loom state — none (verified).** No OKR, CDE, or cost/value field on the product; value is left as
free-text description. (CDEs referenced in the marketplace producer state as `CDEs[]` but not modeled or
surfaced with governance behavior.)

**Azure-first build.**
- **OKRs:** an **Value** tab — structured OKR rows (objective + key results with target/current), a governance
  KPI ("% of domain products certified / OKR-aligned") rolling up per domain (Purview health-control parity,
  consumes DP-5's score).
- **CDEs:** a Critical Data Element picker (from a domain-scoped CDE library) that auto-attaches when member
  assets are mapped, focusing governance on high-impact fields; CDEs feed DP-5 check (3) and DP-9 breaking-change
  severity.
- **Cost/value:** surface per-product cost/consumption from the existing Cost Management + chargeback plumbing
  (`FGC-28`/`BR-COSTATTR`) alongside consumption (DP-11) — value = usage ÷ cost.
- **BFF:** `GET/POST /api/data-products/[id]/{okrs,cdes}`; cost reuses the chargeback route. **Catalog/bicep:**
  Cost Management Reader already requested by `FGC-28`. **Gov:** identical.

**No-vaporware acceptance receipt.** Add an OKR (target vs current) + attach a CDE + view the product's real
cost from Cost Management next to its consumption; the domain KPI reflects the certified/OKR-aligned %.
Screenshots + records.

**Effort:** M. **Priority:** P2.

---

## DP-15 — Governed ↔ infra cross-linking  *(P2, L — operator ask #4/#5)*

**Capability.** A first-class bidirectional link between a governed `data-product` and the
`data-product-instance` infra bundle backing it, and a dependency graph across products (via DP-8 ports) so an
operator can go from "which infra backs this governed product" to "which governed product owns this infra" and
"what's upstream/downstream."

**Grounding.** Dehghani architectural-quantum (code+data+infra as one unit); Unity Catalog Domains organizing
tables/models/notebooks under one navigable hierarchy
`https://www.databricks.com/blog/whats-new-unity-catalog-data-ai-summit-2026`.

**Current Loom state — no linkage (verified).** An instance's components table
(`data-product-editors.tsx:403-438`) never references a `data-product` id; a governed product's Datasets/
Data-assets tabs reference raw Purview Atlas GUIDs, not an instance id — so there is no UI path either direction.

**Azure-first build.**
- **Back-pointers:** DP-4 already stamps `productId` on the instance and `backingInstanceId` on the product at
  Instantiate. DP-15 renders both as clickable links (instance → "Governed by <product>"; product → "Backed by
  <instance>") and adds a **retro-link** action for pre-existing pairs.
- **Dependency graph:** a **Lineage/Graph** view (reuse `canvas-node-kit`) rendering the product, its backing
  instance's components, and its DP-8 input/output-port edges to other products — one navigable mesh graph
  (consumes the existing Purview Data Map lineage on the observability tab).
- **BFF:** `GET /api/data-products/[id]/graph`. **Catalog/bicep:** none. **Gov:** identical.

**No-vaporware acceptance receipt.** From a governed product, click "Backed by" → the instance opens; from the
instance, click "Governed by" → the product opens; the graph view renders the product + its infra components +
its port edges to an upstream product. Screenshots + the resolved graph payload.

**Effort:** L. **Priority:** P2 (depends on DP-4 back-pointers + DP-8 ports).

---

## DP-16 — Editable / consumable / shareable end state  *(P1, M — operator ask #5)*

**Capability.** A clean post-create end state: a **post-create landing** that shows the owner what to do next,
an explicit **owner-view vs consumer-view** split (the owner sees edit/certify/policy; the consumer sees
discover/sample/subscribe), and a **publication path** to the marketplace **and** external Delta Sharing.

**Grounding.** Databricks OpenSharing / Delta Sharing zero-copy cross-org (extended to AI assets)
`https://www.databricks.com/blog/introducing-opensharing-next-evolution-delta-sharing-agentic-era`; Collibra
governed marketplace consumer view `https://www.collibra.com/blog/find-trusted-data-products-faster-with-the-new-collibra-data-marketplace-experience`;
Starburst federated/logical product `https://docs.starburst.io/starburst-galaxy/working-with-data/explore-data/browse-data-products.html`.

**Current Loom state — inconsistent per surface (verified).** The Details page (`data-product-detail.tsx`) is
read-first with owner/consumer affordances mixed; no post-create landing; external sharing is **not surfaced** on
the product record at all (no "Share externally" on data-product / instance / marketplace producer tab), even
though bidirectional Delta Sharing shipped (PR #1578) and `FGC-30` (Entra B2B + scoped ADLS grant) is planned.

**Azure-first build.**
- **Post-create landing:** after the DP-3 wizard Publish, land on the product with a "You're live — here's your
  consumer view / share it / certify it" summary (the completion checklist from DP-6 + share/publish CTAs).
- **Owner vs consumer view:** an explicit view toggle (or role-derived) — **owner** sees edit/certify/access-policy/
  versions/SLO; **consumer** sees description/contract/sample/subscribe/ratings. Reuses the existing tenant-role
  resolution; consumer view is exactly the DP-3 Review preview.
- **Publication path (dedupe):** a **Publish / Share** action group on the product record: (a) **Marketplace**
  (already wired via `publishStatus` → AI-Search, now driven by DP-1's unified publish), (b) **Share externally**
  = surface the shipped **Delta Sharing** (PR #1578) + **`FGC-30`** cross-tenant path *on the product record*
  (an action that calls those engines with the product's output port as the shared object — not a re-implementation).
- **BFF:** reuse the DP-1 publish + the existing share routes; add `GET .../consumer-view`. **Catalog/bicep:**
  `FGC-30`'s Entra B2B + scoped ADLS grant (already an operator action there). **Gov:** Delta Sharing +
  B2B per-cloud (honest-gate where external B2B is restricted in Gov).

**No-vaporware acceptance receipt.** Finish the wizard → land on the post-create summary; toggle to consumer view
→ see exactly what a stranger sees; click **Marketplace** → the product appears in consumer search (DP-1);
click **Share externally** → a Delta Sharing share is created for the output port (real share receipt from
PR #1578's engine). Screenshots of the landing, both views, and the share receipt.

**Effort:** M. **Priority:** P1 (references `FGC-30` + PR #1578 + `W18`; delivers the "usable/shareable" ask).

---

## Cross-cutting notes

- **DP-1 is the keystone.** Nothing else in this PRP is trustworthy until the three status fields collapse into
  one canonical `lifecycleState` with projection parity. Build it first; DP-3/DP-5/DP-8/DP-16 all assume it.
- **Three engines are referenced, not rebuilt:** schema-diff/breaking-change = `W10` + `BR-CONTRACT-GATE`
  (DP-9); DQ score = `W11` + shipped `ContractQualityRunPanel` (DP-5); external sharing = `FGC-30` + Delta
  Sharing PR #1578 (DP-16); marketplace analytics/webhooks = `W18` + `BR-WEBHOOK` (DP-11). Any PR that
  duplicates one of those is wrong — wire the glue, cite the owner.
- **Certification (DP-5) is the differentiator.** No surveyed vendor gates the top rung on a *live,
  re-evaluated* score. Loom already has the raw materials (the ADX DQ run + observability) — DP-5 is mostly
  composition + an honest gate, not a new backend.
- **Default-ON / opt-out throughout.** Every capability is live on deploy; the only controls are admin
  disables and honest infra gates (AOAI/ADX/Monitor/UAA-role MessageBars). No user-facing enablement flag, and
  **zero** Fabric/Power BI on any default path — a data product is 100% functional with no Fabric capacity and
  no Power BI workspace, Commercial and Government alike.
- **Verification per merge (`no-vaporware.md`):** each item's PR attaches a real-backend receipt (endpoint hit +
  first-300-char response + Playwright screenshot/trace + any bicep diff), demonstrated on the Azure-native
  default path with `LOOM_DEFAULT_FABRIC_WORKSPACE` **unset**.
