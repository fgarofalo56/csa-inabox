# CSA Loom — Master PRP Index

> **Goal:** Achieve **100% Microsoft Fabric feature parity on Azure-native (and
> OSS) services**, surfaced through the **CSA Loom** UI — across **all cloud
> types** (Commercial, GCC, GCC-High, IL5) — with **zero stubs, zero
> placeholders, zero vaporware**. Every Loom experience must run **100% without
> a real Microsoft Fabric or Power BI tenant**. Fabric/Power BI are strictly
> opt-in alternative backends; the Azure-native path is the default and is fully
> functional on its own.

This directory holds the **implementation-ready Product Requirement Prompts
(PRPs)**, one per Loom *experience*. Each PRP is self-contained: a feature
parity table grounded in the real Azure/Fabric UI, the full Azure/OSS service
inventory across all four cloud types, a sequenced list of **no-stub tasks**, a
per-task **four-agent dev-loop**, and a whole-experience **Definition of Done**.

To launch the autonomous coding workflow that drains every task below, paste the
prompt in **[`UNLEASH-KICKOFF.md`](./UNLEASH-KICKOFF.md)** into Claude Code.

---

## Per-experience PRPs

| # | Experience | PRP | Tasks | Current grade | Scope summary |
|---|------------|-----|------:|---------------|---------------|
| 1 | Data Engineering (Lakehouse + Spark) | [`data-engineering.md`](./data-engineering.md) | 17 (T1–T22) | _TBD_ | Azure-native, Fabric-free Lakehouse + Spark parity: 22-row parity table, full Azure/OSS inventory across all 4 clouds, 17 sequenced no-stub tasks, 4-agent dev-loop, Fabric-free / no-vaporware / bicep-synced DoD. |
| 2 | Data Factory | [`data-factory.md`](./data-factory.md) | 12 | _TBD_ | Full Fabric Data Factory parity on Azure-native (ADF default, Fabric opt-in): 12 sequenced tasks closing real audited gaps, four-cloud portability, per-task four-agent dev-loop, zero-stub DoD. |
| 3 | Real-Time Intelligence | [`real-time-intelligence.md`](./real-time-intelligence.md) | 39 | _TBD_ | Full RTI parity, Azure-native (ADX + Event Hubs + Stream Analytics + Azure Monitor), no Fabric dependency: 41-row parity table, 39 sequenced no-stub tasks, per-task dev-loop, whole-experience DoD. |
| 4 | Data Science | [`data-science.md`](./data-science.md) | 19 | **D+** — 37% complete; strong honest-gate discipline and a clear roadmap, but significant feature gaps remain for production data-science use | Full Fabric Data Science parity on Azure-native + OSS (no Fabric dependency): 16-row parity table, 19 sequenced no-stub tasks, 4-agent dev-loop, whole-experience DoD. |
| 5 | Governance & Security | [`governance-security.md`](./governance-security.md) | 21 (Task 0–20) | _TBD_ | Full Governance & Security parity, Azure-native (no Fabric dependency): 22-feature parity table, all-4-cloud architecture, 21 sequenced tasks, per-task dev-loop, whole-experience DoD. |
| 6 | Data Products & API (Data Marketplace) | [`data-marketplace.md`](./data-marketplace.md) | 18 | _TBD_ | Full Purview-Unified-Catalog / Fabric parity for the Data Products & API (Data Marketplace) experience, Azure-native with no Fabric dependency: 18 sequenced no-stub tasks. |
| | **Total** | | **126** | | |

> **Grade legend** (from `no-vaporware.md`): **F** vaporware · **D** stubbed ·
> **C** functional but rough · **B** production-grade · **A** production-grade +
> tested · **A+** production-grade + tested + documented + bicep-synced.
> **Target: every experience A or A+ before the next major release.** Grades
> marked _TBD_ are filled in by the validation/UAT agent on first pass over each
> PRP.

---

## CROSS-CUTTING requirements (apply to EVERY task in EVERY PRP)

These are the die-hard rules from `.claude/rules/`. A task is **not done** —
regardless of its own acceptance criteria — until all of these hold. Reviewers
reject any PR that violates one.

### 1. No hard dependency on "real" Microsoft Fabric — `no-fabric-dependency.md`
- Every item type, app, object, and editor is **100% functional without a real
  Fabric capacity, workspace, or Power BI tenant.** The Azure-native backend is
  the **DEFAULT** code path.
- Fabric/Power BI may exist only as an **opt-in alternative**, gated behind
  `LOOM_<ITEM>_BACKEND=fabric` **and** a bound workspace. If either is absent,
  Loom silently uses the Azure-native path — no gate, no error, no "bind a
  Fabric workspace" message.
- **Forbidden on the default path:** a `status:'remediation'` gate whose reason
  is "needs a Fabric workspace"; any call to `api.fabric.microsoft.com` /
  `api.powerbi.com` / `onelake.dfs.fabric.microsoft.com`; reading
  `fabricWorkspaceId` without an Azure-native fallback in the same function.
- **Verification per merge:** the item installs + its editor works with
  `LOOM_DEFAULT_FABRIC_WORKSPACE` **UNSET**, with a real Azure backend response
  in the receipt.

### 2. No vaporware — `no-vaporware.md`
- Functional **end-to-end**: front-end renders cleanly and every interactive
  element does what its label says; the BFF route validates session and returns
  `{ok, data, error}` with correct HTTP status; the **real Azure service is
  actually called** (real REST / Cosmos / TDS / ARM). No mock arrays, no
  `return []`, no `useState(MOCK_DATA)`, no dead buttons, no static tabs.
- Honest infra-gates are the **only** allowed non-functional state: a Fluent
  `MessageBar intent="warning"` naming the exact env var / role / resource to
  provision, with a link to the bicep module — and the full UI still renders.
- **Receipt per PR:** endpoint hit, real response body (first ~300 chars),
  screenshot or Playwright trace, and bicep diff if infra changed.

### 3. UI parity, one-for-one — `ui-parity.md`
- Inventory the **real** Azure portal / Fabric UI first (grounded in Microsoft
  Learn + the live portal, not memory). Build every tab, panel, button, dialog,
  wizard, context menu, and inline action **one-for-one**, same workflow and
  outcome — only the theme (Fluent v9 + Loom tokens) differs.
- **Forbidden shortcuts:** removing a header/banner/button to look "clean";
  disabling a control with a "deferred to vN" tooltip; an empty tab; replacing a
  rich surface (canvas, designer, wizard, schema tree, query grid) with a single
  form or JSON textarea.
- Each surface ships a parity doc at `docs/fiab/parity/<slug>.md`. A surface is
  **A-grade only when every inventory row is built ✅ or honest-gate ⚠️ — zero
  ❌, zero stub banners.**

### 4. No freeform / JSON config — `loom-no-freeform-config.md`
- All Loom configuration is **dropdowns / wizards / WYSIWYG / canvas**. The
  **only** exception is a 1:1 ADF/Synapse expression + dynamic-content builder.
  No raw JSON/YAML textarea as the primary config surface.

### 5. Portability across Commercial / GCC / GCC-High / IL5
- Every service call resolves the correct **sovereign cloud endpoint** (ARM,
  data-plane, AAD authority, storage suffix) — never a hard-coded Commercial
  host. Each PRP's service inventory enumerates the per-cloud equivalents and
  any feature that is region-gated. A task is portable only when it works (or
  shows an honest per-cloud infra-gate) in **all four** cloud types.

### 6. Bicep + post-deploy bootstrap sync — `no-vaporware.md` (Bicep sync)
- Every new Azure resource → `platform/fiab/bicep/modules/**`; every new env var
  → the `apps[]` env list in `admin-plane/main.bicep`; every new role assignment
  → the resource's bicep module; every new Cosmos container → a Cosmos init
  step; every tenant/bootstrap action → `docs/fiab/v3-tenant-bootstrap.md` +
  `scripts/csa-loom/*.sh` or a `*-bootstrap.yml` workflow.
- **Acceptance:** `az deployment sub create -f platform/fiab/bicep/main.bicep -p
  params/commercial-full.bicepparam` + the post-deploy bootstrap workflow
  produces a working Loom with the **same feature set as the live deployment.**
  Drift is itself a vaporware violation.

---

## Overall sequencing across experiences

The experiences share Azure backends and Loom primitives, so they are sequenced
to land foundational data + integration layers first, then the consumption and
governance layers that depend on them. Within each experience, follow that PRP's
own task order (T1…/Task 0…); across experiences, the recommended wave order is:

1. **Wave 1 — Foundation (data + movement).**
   **Data Engineering** (Lakehouse + Spark — the storage/compute substrate every
   other experience reads from) and **Data Factory** (the movement/orchestration
   layer that lands data into it). These two unblock everyone else.

2. **Wave 2 — Streaming & analytics.**
   **Real-Time Intelligence** (ADX + Event Hubs + Stream Analytics + Azure
   Monitor) builds on the landed/streamed data and the integration patterns from
   Wave 1.

3. **Wave 3 — Advanced consumption.**
   **Data Science** (models/notebooks/experiments over the lakehouse + warehouse)
   consumes Wave 1/2 outputs.

4. **Wave 4 — Trust & distribution (cross-cutting consumers).**
   **Governance & Security** (catalog, lineage, access policy, classification
   over all items) and **Data Products & API / Data Marketplace** (publishing the
   curated outputs of every prior wave). These sit on top of everything and are
   sequenced last because they catalog and distribute what the earlier waves
   produce.

The autonomous workflow may run multiple experiences in parallel where their
tasks touch disjoint code paths, but it must respect intra-experience task order
and the wave dependencies above when tasks share backends or Loom primitives.

---

_Last updated: 2026-06-06._
