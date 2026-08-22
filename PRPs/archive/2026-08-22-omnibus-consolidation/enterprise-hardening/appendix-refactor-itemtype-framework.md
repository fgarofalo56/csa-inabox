# Appendix — Refactor: Declarative Item-Type Framework + Naming Cleanup + RLS Compiler De-dup

**Domain:** `refactor-itemtype-framework`
**Scope:** A declarative per-item-type **manifest registry** that collapses today's
4-place boilerplate (catalog-meta + editor + provisioner + routes/RBAC) into one
source of truth; the **naming cleanup** that quarantines Fabric/OneLake terms to the
opt-in adapter (the root cause of the catalog-register bug); and the **de-dup of the
RLS/DAX→SQL compiler** now inlined in a route. Incremental, back-compat, feature-flagged.
**Cross-cut:** Commercial + Azure Government (GCC/GCC-High/IL4-5), 100→60,000 users,
day-one-on but cost-governed, migration-safe.
**Sibling appendix:** the monster-editor-file split (phase3-editors.tsx = 18,078 lines,
etc.) is owned by `appendix-refactor-editor-split.md`; this appendix supplies the
**manifest hook** that makes that split mechanical (one lazy editor module per slug,
keyed off the manifest) and does not re-spec the file carving itself.

---

## 1. Why this exists — current-state, grounded in the code

### 1.1 The 4-place boilerplate tax (every new item type touches ≥4 files)

A single item type (`lakehouse`, `event-hubs-namespace`, `report`, …) is declared
independently in four uncoordinated registries. There is no compiler check that the
four agree; drift is silent until runtime.

| # | Registry | File | Shape | Lines today |
|---|----------|------|-------|-------------|
| 1 | Catalog metadata + create-config + Learn content | `lib/catalog/fabric-item-types.ts` → `FABRIC_ITEM_TYPES` | `FabricItemType` (`slug, displayName, restType, description, category, preview, deprecated, aliasOf, hiddenFromGallery, searchOnly, templateOf, templateId, runtimePreset, createConfig, learnContent`) | **2,919** |
| 2 | Editor component | `lib/editors/registry.ts` → `EDITOR_REGISTRY` | `slug → dynamic(() => import(...))` | 247 |
| 3 | Provisioner + pairings | `lib/install/provisioning-engine.ts` → `PROVISIONERS` and `lib/items/registry.ts` → `ITEM_PAIRING_RULES` | `slug → Provisioner`; `parentSlug → PairedItemDef[]` | 95 + 148 |
| 4 | BFF routes + RBAC | `app/api/items/[type]/[id]/**` and `app/api/items/<slug>/[id]/**` | per-route handlers; RBAC is **implicit** (each route re-checks session/domain ad hoc) | many |

Observed drift hazards baked into this layout:
- A slug can exist in `EDITOR_REGISTRY` but be absent from `FABRIC_ITEM_TYPES`
  (`workspace-monitor`, `sql-analytics-endpoint` map to editors but their catalog
  facets live elsewhere) — the New-item gallery and the editor disagree.
- `aliasOf` / `templateOf` / `runtimePreset` / `hiddenFromGallery` / `searchOnly`
  resolution logic is re-implemented in `page.tsx`, `new-item-dialog.tsx`, the editor
  registry, AND the catalog seed — 4 copies of the same alias math.
- `PROVISIONERS` lists `kql-queryset`/`eventhouse`/`workspace-monitor` aliasing onto
  `kqlDatabaseProvisioner` by hand; the editor registry aliases the same trio onto
  `phase3-editors`. Two hand-maintained alias tables for one fan-out.
- **No central RBAC/cloud-availability descriptor.** "Is this item allowed in
  GCC-High?" is answered ad hoc (e.g. `security-roles/route.ts` calls `isGovCloud()`
  inline to gate the Fabric sync). There is nowhere to declare "this item is
  Commercial-only" once.

### 1.2 Fabric / OneLake naming debt — the catalog-register bug

The core type is **named for Fabric** despite the die-hard `no-fabric-dependency.md`
rule that Fabric is opt-in only:

- `lib/catalog/fabric-item-types.ts` exports `FabricItemType` and
  `FABRIC_ITEM_TYPES`; `restType` is documented as "matches Fabric REST `type` field";
  `WorkloadCategory` literally enumerates `'Fabric IQ'`, `'Fabric Apps'`, `'Power BI'`.
  This type is imported as the editor contract everywhere (`EditorProps.item:
  FabricItemType`).
- `lib/catalog/onelake-types.ts` exports `ONELAKE_TYPES` / `OneLakeItemType` /
  `isOneLakeType()` — the *Azure-native* lakehouse/warehouse/mirror set is named
  "onelake". Consumed by `app/onelake/page.tsx`, `app/api/onelake/recycle/route.ts`,
  `lib/panes/onelake-catalog.tsx`.
- `app/api/catalog/register/route.ts` accepts `source: 'unity-catalog' | 'onelake' |
  'azure-database'`. The `'onelake'` branch, **on the opt-in Fabric path**, mints Atlas
  typeNames `fabric_warehouse` / `fabric_lakehouse` / `fabric_item` and a
  `onelake.dfs.fabric.microsoft.com` qualifiedName. The default path was already fixed
  (lines 130-157) to use the built-in `DataSet` supertype + a `loom://` qualifiedName,
  with the in-code comment recording the live failure: *"Type ENTITY with name
  loom_lakehouse does not exist"*. **That is exactly the class of bug the naming debt
  causes** — a `fabric_*` / `loom_*` custom Atlas type that was never POSTed as a
  typedef, so Purview rejects the entity.
  - **MS Learn confirms the rule** (Purview *Type definitions and how to create custom
    types*, and *Create lineage relationships via REST*): a `typeName` must be a
    **built-in supertype** (`DataSet`, `Process`, `Asset`, `Referenceable`) **or** a
    custom typedef you first POST to `…/catalog/api/atlas/v2/types/typedefs` with a
    `superTypes:["DataSet"]` body. Inventing `fabric_lakehouse` inline without the
    typedef is guaranteed to 404 the type.

### 1.3 RLS / DAX→SQL compiler de-dup

- `app/api/items/semantic-model/[id]/roles/route.ts` (**906 lines**) **inlines** the
  DAX-boolean→T-SQL/Databricks predicate compiler: `translateDax()`,
  `daxFilterToTSql()`, `daxFilterToTSqlInline()`, `daxFilterToDatabricks()`,
  `DEFAULT_IDENTITY_TSQL = "COALESCE(CAST(SESSION_CONTEXT(N'loom_user') AS sysname),
  USER_NAME())"`. The header comment is explicit: *"the DAX→SQL compiler is inlined
  here (rather than a shared `lib/azure/rls-compiler.ts`) because this change set may
  touch ONLY this file … Stands in for lib/azure/rls-compiler.ts."* — i.e. the
  canonical module **does not exist yet**; the route is the de-facto home.
- The **predicate validators** already are shared modules: `lib/azure/rls-predicate.ts`
  (`validateWhereClause`, T-SQL injection guard, `RLS_WHERE_MAX`) and
  `lib/azure/kusto-rls-predicate.ts` (KQL guard, `KUSTO_RLS_QUERY_MAX`). These are the
  *validation* half; the *compilation* half (DAX→SQL) lives only inside the route.
- `app/api/items/[type]/[id]/security-roles/route.ts` (353 lines) is a **different
  concern** (OneLake/ADLS POSIX-ACL data-access roles, not DAX→SQL) — NOT a literal
  duplicate, but it is the second "security-roles" surface and would consume the same
  identity-expression constant + Gov gate once extracted. The task brief's parenthetical
  ("inlined in roles/route.ts AND lib/azure/rls-compiler.ts") is reconciled here: the
  de-dup is to **create** `lib/azure/rls-compiler.ts` and move the inlined compiler into
  it, then have the SQL roles route import it; the two predicate validators become its
  dependencies, and `security-roles/route.ts` imports the shared `DEFAULT_IDENTITY_TSQL`
  + the Gov gate.

### 1.4 Identity & scale context (drives the RBAC + partition design)

- Data plane runs on a **single shared Console UAMI** (`uamiArmCredential`, ~233 files);
  per-user OBO only for narrow opt-in (`mcp-obo-token-store`, `pbi-user-token-store`).
  → per-item RBAC in the manifest must express **app-layer + RLS-via-`SESSION_CONTEXT`**
  enforcement, not native per-user Azure RBAC (see `appendix-obo-data-plane.md` and
  `appendix-multi-domain-acl.md` for the identity build-out this manifest plugs into).
- Loom item metadata in Cosmos is partitioned **`/workspaceId`** today
  (`cosmos-client.ts` lines 421-458). At 60k users across many domains this is fine for
  per-workspace reads but a cross-domain "all items" rollup fans out. The manifest is
  **static code** (no scale cost itself), but it is the right place to declare each
  type's `catalogContainer`/partition affinity so the scale-tier appendix
  (`appendix-scale-cosmos-data-tier.md`) can move hot types to a **hierarchical
  partition key** `[/domainId, /workspaceId, /id]` (MS Learn: HPK for multitenant,
  high-cardinality first level, `/id` last level to dodge the 20 GB logical-partition
  cap) without editing each provisioner.

---

## 2. MS Learn grounding (authoritative patterns used below)

- **Cosmos partitioning / multitenancy** — *Partitioning and horizontal scaling*;
  *Multitenancy and Azure Cosmos DB* (partition-key-per-tenant); *Hierarchical partition
  keys (unlimited scale)*. Use HPK `[/domainId,/workspaceId,/id]` for the item-metadata
  container at 60k scale; `/id`-terminated hierarchy avoids the 20 GB logical-partition
  limit; low-cardinality keys (`type`, `status`) are an anti-pattern — never partition
  the item store by item-type.
- **Purview / Apache Atlas type system** — *Type definitions and how to create custom
  types*; *Create lineage relationships using the REST API*. `typeName` must be a
  built-in supertype or a pre-registered custom typedef (`superTypes:["DataSet"]`).
  Classic Data Map endpoint `https://{acct}.purview.azure.com/catalog/api/atlas/v2/...`;
  new portal `https://api.purview-service.microsoft.com/catalog/...`.
- **Next.js dynamic import / code-splitting** — `next/dynamic` with `{ ssr:false }` is
  already the editor-registry pattern; the manifest keeps lazy boundaries so the 18k-line
  editor module is split per slug without eager-loading (ties to the editor-split
  appendix).
- (Cross-domain identity/OBO/RBAC Learn citations live in the OBO + multi-domain-ACL
  appendices; this appendix consumes their output via the manifest's `rbac` block.)

---

## 3. Target architecture — the declarative `ItemManifest` registry

### 3.1 The manifest shape (one entry per item type = the single source of truth)

New module tree `lib/items/manifest/`:

```
lib/items/manifest/
  types.ts            # ItemManifest interface (the contract below)
  registry.ts         # ITEM_MANIFESTS: Record<slug, ItemManifest> (aggregates the per-domain files)
  derive.ts           # pure selectors: toCatalogList(), toEditorRegistry(), toProvisioners(), toPairingRules()
  compat.ts           # back-compat re-exports (FABRIC_ITEM_TYPES, EDITOR_REGISTRY, PROVISIONERS) behind the flag
  domains/            # one file per workload, each exporting ItemManifest[]
    data-engineering.ts   real-time.ts   warehouse.ts   ai-foundry.ts
    messaging.ts          governance.ts  palantir.ts    powerplatform.ts  ...
```

```ts
// lib/items/manifest/types.ts
export type LoomCloud = 'commercial' | 'gov';            // from lib/azure/cloud-endpoints (detectLoomCloud)
export type ItemBackend =
  | 'adls-delta' | 'synapse-serverless' | 'synapse-dedicated' | 'adx-kusto'
  | 'databricks' | 'event-hubs' | 'service-bus' | 'event-grid' | 'azure-monitor'
  | 'aas-tabular' | 'cosmos' | 'apim' | 'ai-foundry' | 'logic-apps'
  | 'power-platform' | 'cosmos-only' | 'fabric';          // 'fabric' = OPT-IN adapter only

export interface ItemManifest {
  /** Stable route slug — /items/<slug>/<id>. Loom-native term (NEVER a fabric_* name). */
  kind: string;
  displayName: string;
  description: string;
  category: WorkloadCategory;                 // see §4.2 renamed categories

  /** DEFAULT Azure-native backend. 'fabric' is forbidden as a default (lint rule). */
  backend: ItemBackend;
  /** Optional opt-in alternative, gated on LOOM_<KIND>_BACKEND=fabric + bound workspace. */
  fabricBackend?: { restType: string; env: string };   // quarantined; never read on default path

  /** Lazy editor module + export name (replaces EDITOR_REGISTRY hand-maintenance). */
  editor: { module: string; export: string };
  /** Provisioner factory id (replaces PROVISIONERS) or 'cosmos-only'. */
  provisioner?: string;
  /** Declarative pairings (replaces ITEM_PAIRING_RULES); deriveContent stays a fn. */
  pairs?: PairedItemDef[];

  /** Catalog/gallery facets (replaces the scattered FabricItemType flags). */
  catalog: {
    preview?: boolean; deprecated?: boolean; coreSurface?: boolean;
    hiddenFromGallery?: boolean; searchOnly?: boolean;
    aliasOf?: string; templateOf?: string; templateId?: string;
    runtimePreset?: 'adf' | 'synapse' | 'fabric';
    createConfig?: CreateConfig; learnContent?: LearnContent;
  };

  /** RBAC + cloud availability — the part that does NOT exist today. */
  rbac: {
    /** Domain roles (from lib/auth/domain-role.ts) allowed to CREATE this kind. */
    create: ('domain-owner' | 'domain-contributor' | 'workspace-admin')[];
    /** Enforcement model declared once, asserted by the route helper. */
    enforce: ('app-layer' | 'rls-session-context' | 'adls-acl' | 'native-rbac')[];
    /** Cost tier so the capacity/cost-governance layer can enable-per-domain. */
    costTier?: 'free' | 'metered' | 'capacity';   // capacity => needs an F-SKU/pool budget
  };
  /** Where this kind may run. Default = both; Fabric/Power-BI-family => commercial-only. */
  clouds?: LoomCloud[];                          // omitted => ['commercial','gov']

  /** Atlas registration so catalog/register never invents an unregistered typeName. */
  atlas?: { superType: 'DataSet' | 'Process'; serviceType?: string };  // default DataSet
}
```

### 3.2 Derivation (the four legacy registries become *projections*, not sources)

`lib/items/manifest/derive.ts` exports pure selectors that rebuild today's structures:

- `toCatalogList(): FabricItemType[]` — maps each manifest to the legacy
  `FabricItemType` shape (flatten `catalog.*` + `kind→slug` + `fabricBackend?.restType ??
  loomRestType`). The New-item dialog, inventory rollup, and `findItemType()` keep working
  unchanged because they consume this output.
- `toEditorRegistry(): Record<string, EditorComponent>` — wraps `editor.{module,export}`
  in the existing `reg()` lazy helper. **One alias table** now: `aliasOf` resolves here,
  so `kql-queryset`/`eventhouse`/`workspace-monitor` no longer need a hand-written line in
  two files.
- `toProvisioners(): Record<string, Provisioner>` — resolves `provisioner` ids against a
  `PROVISIONER_FACTORIES` map (the existing provisioner functions, registered by id).
- `toPairingRules(): Record<string, PairedItemDef[]>` — from `pairs`.

`compat.ts` re-exports `FABRIC_ITEM_TYPES = toCatalogList()`, `EDITOR_REGISTRY =
toEditorRegistry()`, `PROVISIONERS = toProvisioners()`, `ITEM_PAIRING_RULES =
toPairingRules()` **behind the feature flag** (§7). With the flag OFF the legacy files are
the source; with it ON the manifest is the source and the legacy files become thin
re-export shims. No consumer import path changes → migration-safe.

### 3.3 Net effect on "cost of a new item"

Before: edit 4 files + add a route + remember the Gov gate + remember the Atlas
supertype. After: add **one `ItemManifest`** to the right `domains/*.ts` file + author the
editor module + (optional) provisioner factory. A unit test (`manifest.invariants.test.ts`)
asserts: every `kind` has an editor module that exports `editor.export`; `backend !==
'fabric'`; exactly one `createConfig` default per axis; `atlas.superType` is built-in;
`clouds` excludes `'gov'` iff any backend is Fabric/Power-BI-family. The four legacy
drift hazards become compile/test failures.

---

## 4. Naming cleanup (Fabric/OneLake quarantine)

### 4.1 Type + constant rename, fully back-compat

1. **`FabricItemType` → `LoomItemType`**, **`FABRIC_ITEM_TYPES` → `LOOM_ITEM_TYPES`**,
   file `lib/catalog/fabric-item-types.ts` → `lib/catalog/loom-item-types.ts`.
   Keep `export { LoomItemType as FabricItemType, LOOM_ITEM_TYPES as FABRIC_ITEM_TYPES }`
   plus a one-line re-export file at the old path so the ~30 importers compile untouched;
   migrate importers in follow-up waves, then delete the alias.
2. Field `restType` keeps its name (it is the **Loom** REST type now) but its doc comment
   drops "matches Fabric REST"; the Fabric REST type moves to `fabricBackend.restType`
   (opt-in only).
3. `WorkloadCategory`: rename `'Fabric IQ' → 'Knowledge & Agents'`, `'Fabric Apps' →
   'App Templates'`, keep `'Power BI'` label only on the consumer report surface (it is a
   product the user recognizes) but the *category enum value* becomes `'Reporting & BI'`
   with a display alias. Provide a `LEGACY_CATEGORY_ALIAS` map so any persisted
   tenant-catalog docs that stored the old string still resolve.

### 4.2 `onelake-types.ts` → `lakehouse-catalog-types.ts`

`ONELAKE_TYPES → LAKEHOUSE_CATALOG_TYPES`, `OneLakeItemType → LakehouseCatalogType`,
`isOneLakeType → isLakehouseCatalogType`. Same membership set (it is the ADLS-Delta /
Synapse / ADX set — never required Fabric). Re-export old names; migrate
`app/onelake/page.tsx`, `app/api/onelake/recycle/route.ts`, `lib/panes/onelake-catalog.tsx`
in a follow-up wave. (The route paths `/onelake/*` can stay as user-facing URLs or be
aliased to `/lakehouse-catalog/*` with a redirect — UI-string change, low risk, deferred.)

### 4.3 Fabric quarantined to one adapter + the Atlas typedef fix

- New `lib/catalog/adapters/fabric-adapter.ts` is the **only** module allowed to import
  `getFabricItem` / reference `api.fabric.microsoft.com` / build `fabric_*` typeNames or
  `onelake.dfs.fabric` qualifiedNames. The catalog-register route calls
  `fabricAdapter.resolveOneLakeAsset()` **only** inside the
  `LOOM_LAKEHOUSE_BACKEND==='fabric'` branch.
- **Atlas typedef fix (the actual bug):** the adapter must, before POSTing any entity
  with a custom `fabric_*` typeName, ensure that typedef exists — `ensureLoomTypedefs()`
  POSTs `entityDefs:[{name:'loom_lakehouse',superTypes:['DataSet']}, …]` once (idempotent;
  Atlas returns 409 if present, treated as success). **Default-path policy stays:**
  `typeName='DataSet'` + `loom://` qualifiedName (already correct) — never invent a type.
  The opt-in path either registers the typedef first OR also falls back to `DataSet`; a
  lint/grep rule (`no-fabric-dependency.md` §"How to spot a violation") keeps the host
  strings out of every other file.
- `clouds:['commercial']` on the Fabric-family manifests + `isGovCloud()` honest-gate
  (pattern already in `security-roles/route.ts`) means the Fabric adapter is dead code in
  GCC-High/IL5 — correct, since Fabric/Power BI aren't authorized at that boundary.

---

## 5. RLS / DAX→SQL compiler de-dup — create `lib/azure/rls-compiler.ts`

Create the canonical module the route comment already names:

```
lib/azure/rls-compiler.ts        # NEW — exports the compiler moved verbatim from the route
  export const DEFAULT_IDENTITY_TSQL = "COALESCE(CAST(SESSION_CONTEXT(N'loom_user') AS sysname), USER_NAME())";
  export type PredDialect = ...;            // {tsql|databricks, identityExpr, colRef}
  export function translateDax(dax, dialect): { sql; columns; warnings }
  export function daxFilterToTSql(dax, identityExpr?)
  export function daxFilterToTSqlInline(dax, testUpn)
  export function daxFilterToDatabricks(dax)
  // re-export the validators so callers get one import surface:
  export { validateWhereClause, RLS_WHERE_MAX } from './rls-predicate';
  export { validateKustoRlsQuery, KUSTO_RLS_QUERY_MAX } from './kusto-rls-predicate';
```

- `app/api/items/semantic-model/[id]/roles/route.ts`: delete the ~160 inlined compiler
  lines, `import { daxFilterToTSql, daxFilterToTSqlInline, daxFilterToDatabricks,
  DEFAULT_IDENTITY_TSQL } from '@/lib/azure/rls-compiler'`. Behavior identical (move, not
  rewrite) → the existing `rls-compiler.unit.test.ts`-style cases move with it.
- `app/api/items/[type]/[id]/security-roles/route.ts`: import `DEFAULT_IDENTITY_TSQL` +
  the shared Gov gate; no DAX compile there (ADLS-ACL concern) but it stops re-declaring
  the identity expression.
- Add `lib/azure/__tests__/rls-compiler.test.ts` covering AND/OR/NOT/IN/`{set}`,
  `USER_NAME()`/`SUSER_SNAME()` identity, injection rejection (semicolons, comments,
  quotes, DDL keywords) for both dialects — the validators already encode these rules, so
  this is characterization, not new policy.

This is a pure refactor (no API/contract change) → ship **first**, behind no flag (it is
internally invisible), as the lowest-risk slice.

---

## 6. Monster-file shrink hook (defer carving to the editor-split appendix)

The manifest's `editor:{module,export}` is the seam: once `phase3-editors.tsx` (18,078
lines, ~20 editors incl. `eventhouse`, `kql-*`, `eventstream`, `activator`, `warehouse`,
`semantic-model`, `report`, `dashboard`, `scorecard`) is split into per-slug modules,
**only the manifest entries change** (`module: './phase3-editors'` →
`module: './eventhouse-editor'`). No consumer edits, because nobody imports
`EDITOR_REGISTRY` keys directly — they call `getEditor(slug)`. That decoupling is the
whole reason to land the manifest **before** the big carve. File-by-file carving,
ownership, and test strategy: see `appendix-refactor-editor-split.md`.

---

## 7. Incremental, reversible migration (feature-flagged)

**Flag:** `LOOM_ITEM_MANIFEST_REGISTRY` (env, default `off`). Plumb through
`lib/flags.ts` (or the existing flag util) so it is readable server + client.

Phases (each independently shippable + revertible by flipping the flag / reverting the
slice):

- **P0 (no flag, invisible): RLS compiler de-dup** (§5). Pure move; ship immediately.
- **P1 (no flag): naming re-exports only.** Add `loom-item-types.ts` +
  `lakehouse-catalog-types.ts` as the real files; old paths become re-export shims. Zero
  behavior change; importers still compile. The Fabric adapter + `ensureLoomTypedefs()`
  land here (fixes the register bug regardless of the registry flag).
- **P2 (flag-gated): manifest as projection.** Author `lib/items/manifest/**`,
  back-fill `ITEM_MANIFESTS` from the existing data (a codemod reads `FABRIC_ITEM_TYPES`
  + `EDITOR_REGISTRY` + `PROVISIONERS` and emits the `domains/*.ts` files). With flag ON,
  `compat.ts` serves the derived registries; with OFF, legacy files serve. Run the
  invariants test in CI in **both** modes; diff `toCatalogList()` against the live
  `FABRIC_ITEM_TYPES` to prove byte-equivalence before flip.
- **P3 (flag default ON in dev → staging → prod):** flip per environment after a full
  UAT pass (New-item gallery renders identically; every editor opens; install/provision
  receipts unchanged). Roll back = flag OFF, instant.
- **P4 (cleanup):** delete the legacy alias re-exports + the hand-maintained
  `EDITOR_REGISTRY`/`PROVISIONERS` literals once all importers point at the manifest;
  migrate `/onelake/*` URL strings last (optional).

Rollback at every phase is a flag flip or a one-slice revert — no big-bang, satisfying
`migration-safe`.

---

## 8. Commercial vs Azure Government

| Concern | Commercial | Azure Government (GCC/GCC-High/IL4-5) |
|---|---|---|
| Manifest source | identical code | identical code (static; no runtime cloud dependency) |
| Fabric/Power-BI items | available behind opt-in env | **`clouds:['commercial']` → hidden + honest-gated**; Fabric adapter dead code (Fabric/PBI not ATO'd at GCC-High/IL5) |
| Purview Atlas endpoint | `https://{acct}.purview.azure.com/catalog/...` (classic Data Map, per live state) | `https://{acct}.purview.azure.us/catalog/...`; new-portal `api.purview-service.microsoft.us` — selected via `cloud-endpoints` (add a `purviewBase()` helper alongside `armBase()`) |
| ARM / token audience | `management.azure.com`, `login.microsoftonline.com` | `management.usgovcloudapi.net`, `login.microsoftonline.us` — already centralized in `cloud-endpoints.ts` (`armBase/armAudience`) |
| Cosmos item store | autoscale | autoscale; CMK + private-only (IL5) — partition design identical |
| OSS substitute where managed svc absent in Gov | n/a | semantic layer falls back to OSS tabular/AAS-optional; report renderer is Loom-native (no Power BI dependency) — manifest `backend:'aas-tabular'` with an OSS flag |

The only cloud-specific code the manifest introduces is `clouds?: LoomCloud[]` +
`atlas.serviceType`; everything else routes through the existing `cloud-endpoints.ts`
helpers (`detectLoomCloud`, `isGovCloud`, `armBase`). Add one helper: `purviewBase()`.

---

## 9. Code vs tenant-admin action

**Code Loom ships (this domain):** the manifest module tree + derivation + back-compat
shims + the flag; the naming renames + re-exports; the Fabric adapter +
`ensureLoomTypedefs()`; `lib/azure/rls-compiler.ts` + the two route edits; the invariants
+ compiler tests; one `purviewBase()` Gov helper.

**Tenant-admin / Azure actions (runbook — honest in-product gate, not code):**

1. **Purview custom typedef registration (only if opt-in Fabric path is used).** The
   Console UAMI needs **Data Map Data Source Administrator + Data Curator** (live state
   confirms Purview DataMap role already granted) to POST `…/types/typedefs`. Runbook:
   `POST {purviewBase}/catalog/api/atlas/v2/types/typedefs` with the
   `loom_lakehouse/loom_warehouse → DataSet` bodies; idempotent. **Default path needs
   nothing** (uses built-in `DataSet`). In-product gate: a `MessageBar intent="warning"`
   "Opt-in Fabric catalog registration requires a one-time Purview typedef registration —
   run `scripts/csa-loom/register-loom-typedefs.sh`." Only shown on the Fabric branch.
2. **Feature-flag flip** `LOOM_ITEM_MANIFEST_REGISTRY=on` per environment — operator
   action via the ACA env var (admin-plane bicep `apps[].env`). Document in
   `docs/fiab/v3-tenant-bootstrap.md`.
3. **(Scale, cross-ref)** moving the item-metadata container to a hierarchical partition
   key is a **container recreate + data copy** (Cosmos HPK is create-time only) — owned by
   `appendix-scale-cosmos-data-tier.md`; the manifest only declares the affinity.

---

## 10. File-level build spec

**Create:**
- `apps/fiab-console/lib/azure/rls-compiler.ts` (P0)
- `apps/fiab-console/lib/azure/__tests__/rls-compiler.test.ts` (P0)
- `apps/fiab-console/lib/catalog/loom-item-types.ts` (P1 — real file; old path becomes shim)
- `apps/fiab-console/lib/catalog/lakehouse-catalog-types.ts` (P1)
- `apps/fiab-console/lib/catalog/adapters/fabric-adapter.ts` (P1 — incl. `ensureLoomTypedefs`)
- `apps/fiab-console/lib/azure/cloud-endpoints.ts` → add `purviewBase()` (P1, edit)
- `apps/fiab-console/lib/items/manifest/{types,registry,derive,compat}.ts` (P2)
- `apps/fiab-console/lib/items/manifest/domains/*.ts` (P2 — codemod-generated)
- `apps/fiab-console/lib/items/manifest/__tests__/manifest.invariants.test.ts` (P2)
- `apps/fiab-console/lib/items/provisioner-factories.ts` (P2 — id → Provisioner)
- `scripts/csa-loom/register-loom-typedefs.sh` (runbook, P1)

**Edit:**
- `app/api/items/semantic-model/[id]/roles/route.ts` — strip inlined compiler, import shared (P0)
- `app/api/items/[type]/[id]/security-roles/route.ts` — import shared identity + Gov gate (P0)
- `app/api/catalog/register/route.ts` — route `onelake` opt-in through `fabricAdapter`; default unchanged (P1)
- `lib/catalog/fabric-item-types.ts` → becomes `export * from './loom-item-types'` shim (P1)
- `lib/catalog/onelake-types.ts` → re-export shim from `lakehouse-catalog-types` (P1)
- `lib/editors/registry.ts`, `lib/install/provisioning-engine.ts`, `lib/items/registry.ts`
  → behind flag, become `export const X = derive.X()` (P2)
- `docs/fiab/v3-tenant-bootstrap.md` — typedef + flag runbook (P1/P2)
- `docs/fiab/parity/` — add `item-type-framework.md` parity/architecture note

**Do NOT touch:** any editor component file (the split is a separate appendix); any
provisioner body (only its registration moves); any consumer of `getEditor()/findItemType()`
(they are projection-stable).

---

## 11. Acceptance criteria

1. **RLS de-dup (P0):** `lib/azure/rls-compiler.ts` exists; the SQL roles route has zero
   inlined DAX-compiler functions; `rls-compiler.test.ts` green; a real test-as-role
   receipt against a Synapse dedicated pool is byte-identical to pre-refactor (no-vaporware
   receipt in the PR).
2. **Naming (P1):** `grep -rn "FabricItemType\|FABRIC_ITEM_TYPES\|ONELAKE_TYPES" lib app`
   resolves only through the shims; no `fabric_*` typeName or `onelake.dfs.fabric` /
   `api.fabric.microsoft.com` string outside `lib/catalog/adapters/fabric-adapter.ts`
   (matches `no-fabric-dependency.md` grep). The catalog-register default path returns a
   `DataSet` entity; the opt-in path 200s only after `ensureLoomTypedefs()` (no more "Type
   ENTITY … does not exist").
3. **Manifest (P2/P3):** with `LOOM_ITEM_MANIFEST_REGISTRY=on`, `toCatalogList()` deep-equals
   the legacy `FABRIC_ITEM_TYPES`; every `EDITOR_REGISTRY`/`PROVISIONERS` key matches; the
   New-item gallery + every editor open identically (Playwright UAT); flag OFF restores the
   legacy source with no diff. Invariants test fails if any `backend==='fabric'` default,
   missing editor export, or Gov-allowed Fabric item is introduced.
4. **Dual cloud:** with `detectLoomCloud()==='gov'`, Fabric-family kinds are absent from the
   gallery and their adapter is never invoked; `purviewBase()` returns the `.us` host.
5. **Migration-safe:** each phase reverts via flag flip or single-slice revert; no consumer
   import path changed across P0-P3.

---

## 12. Priority & sequencing

- **P0 — `rls-compiler.ts` de-dup** (this-week, no flag, lowest risk): the brief's named
  de-dup, pure move, immediate value.
- **P1 — naming quarantine + Fabric adapter + Atlas typedef fix** (this-week): closes the
  catalog-register bug class permanently; re-export shims make it zero-break.
- **P2 — manifest as projection behind the flag** (next): the boilerplate-killer; codemod +
  dual-mode CI proves equivalence before any flip.
- **P3 — flag-on rollout + cleanup**, then hand the editor module seam to
  `appendix-refactor-editor-split.md`.
