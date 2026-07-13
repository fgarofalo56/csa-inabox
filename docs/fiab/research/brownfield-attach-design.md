# Brownfield support — attach existing Azure services to a Loom landing zone

**Status:** Design (2026-07-13). Tracks task #41. No code changed by this doc.

**Operator requirement (verbatim intent):** Deployments, configuration, and
setup of Loom must support brownfield environments. If a customer already has
Synapse (or any underlying service), there must be a way to create a landing
zone and tie the existing brownfield services to that landing zone so they
become part of Loom. Complete support means BOTH: (a) providing existing-service
info during the initial deployment, AND (b) post-deploy attaching/configuring
new landing zones and adding existing services to them. Everything attached
becomes part of Loom's main functionality: data governance, telemetry,
cost/chargeback, cross-service integration.

The good news from the inventory below: **~70% of the primitives already exist**
(day-0 BYO wizard, cross-sub Resource Graph discovery, self-healing coordinate
resolution, Connections import, Purview auto-onboard, RBAC grant script,
cross-sub chargeback). What is missing is a **first-class, persisted "attached
service" registry** that unifies them and a **day-2 attach wizard on the landing
zone detail page**. This design specifies that unifying layer.

---

## Part 1 — Current-state inventory (what already exists)

### 1.1 Day-0 "Bring Your Own" (BYO) deploy-time reuse

The deploy-time reuse path is mature and goes deep (env wiring + RBAC, though
not automated PE).

- **`scripts/csa-loom/byo-wizard.sh`** — interactive/non-interactive wizard that,
  for each of ~12 reusable Azure services, scans every visible subscription via
  Azure Resource Graph (`az graph query`) and lets the operator pick
  EXISTING vs NEW vs honest-gate. Emits two artifacts: a drop-in
  `params/<name>.generated.bicepparam` (regenerating the block between
  `// >>> BYO-WIZARD START` / `END` markers) and a `temp/<name>.byo-exports.sh`
  of canonical `EXISTING_*` exports. Captures **name + RG + subscription** for
  every pick, so cross-sub reuse is a first-class deploy input. It is read-only
  (creates/modifies nothing).
- **The `existing*` bicep params** are declared in `platform/fiab/bicep/main.bicep`
  and consumed by `modules/admin-plane/main.bicep` + `modules/landing-zone/main.bicep`.
  Present in all boundary params (`params/{commercial,commercial-full,gcc,
  gcc-high,il5,tenant-dmlz,dlz-attach}.bicepparam`).
- **The TypeScript twin: `apps/fiab-console/lib/setup/scan-services.ts`** —
  `SETUP_SCAN_SERVICES[]`, the single source of truth shared by the Setup Wizard
  UI, the `/api/setup/scan-services` cross-sub scan, and the choice→param
  translation. It is deliberately kept in lockstep with `byo-wizard.sh`'s
  `SERVICES` array (12 services: AI Search, APIM, ADX, AI Foundry/AOAI, Purview,
  Synapse, Cosmos, ADF, Event Hubs, Stream Analytics, Databricks, Maps). Each
  row declares: ARM type, `existing<Svc>{Name,Rg,Sub}` bicep params, canonical
  `EXISTING_*` env triple, and the `loom<Svc>Enabled` flag. `reuseOnly` marks
  one-per-tenant services (Purview).
- **`apps/fiab-console/lib/setup/service-choices-to-params.ts`** — pure translator
  from wizard picks → `{ bicepParams, existingEnv }`. `use-existing` sets the
  three `existing*` params + the `EXISTING_*` env triple and flips
  `loom<Svc>Enabled=false` (reuse, don't provision).

**How deep does BYO reuse go?**
- **Env wiring: yes.** `EXISTING_*` triples flow to `LOOM_<SVC>_{NAME,RG,SUB}`
  console env vars; navigators read those at runtime.
- **RBAC: yes, post-deploy.** `scripts/csa-loom/grant-navigator-rbac.sh` has a
  dedicated `byo_grant()` block that grants the Console UAMI the correct
  management/data-plane role on each **reused** resource at its **real
  subscription scope** (Event Hubs Data Owner, DocumentDB Account Contributor +
  Cosmos SQL data-plane role, Search Service/Index Data Contributor, Cognitive
  Services Contributor, APIM Service Contributor, Synapse Contributor, ADF
  Contributor). Idempotent, cross-sub aware.
- **Private Endpoint / network: NOT automated.** BYO wiring is string
  pass-through + RBAC. Reaching a PE-locked brownfield resource from the hub
  VNet (peering, private DNS, a PE into the hub) is a manual/honest-gate step
  today. This is the biggest gap for attach.

### 1.2 dlz-attach topology — attaching a NEW landing zone to an existing hub

- **`platform/fiab/bicep/main.bicep`** supports `param topology` with a
  `'dlz-attach'` value (audit-t156/t157). When `topology=='dlz-attach'` it
  provisions ONE new Data Landing Zone RG (`dlzAttachRg`), wires it into the
  **existing** hub (VNet peering `dlzAttachHubPeering`, private DNS, access-policy
  RBAC `dlzAttachAccessPolicyRbac`, org-visuals RBAC, hub-console env
  `dlzAttachHubConsoleEnv`), and does **not** stamp a second Console/admin plane.
  Hub coordinates arrive as the `hubCoordinates` object (sourced from the Cosmos
  `tenant-topology` doc the first-run deploy wrote). `params/dlz-attach.bicepparam`
  is the boundary template.
- **`apps/fiab-console/lib/setup/user-arm-deploy.ts`** — the day-2 in-product
  path: submits the real subscription-scoped `az deployment sub create`
  equivalent under the **signed-in user's delegated ARM token**
  (`getArmTokenPreferUser`), so an operator can attach a DLZ into any sub they
  hold Contributor on. `buildDlzDeploymentParameters()` maps hub coords → attach
  params. Requires the compiled template published at `LOOM_DLZ_TEMPLATE_URI`
  (honest gate names the env var when unset). Races the ARM PUT against an early
  return to dodge Front Door's 504.
- **`apps/fiab-console/app/admin/landing-zones/page.tsx`** +
  **`lib/panes/landing-zones-shell.tsx`** — the `/admin/landing-zones` surface,
  two tabs: **Overview** (`LandingZonesOverviewPane`) and **Add a landing zone**
  (`AddLandingZoneWizardPane`, the dlz-attach form). This is where a day-2
  "Attach existing service" entry point belongs.
- **`apps/fiab-console/lib/setup/landing-zones-model.ts`** — pure model that maps
  the Cosmos hub doc + Resource-Graph-discovered DLZ RGs (`rg-csa-loom-dlz-<domain>-<region>`)
  into the overview, computing `attachState` (`attached` | `detached` | `unknown`)
  from probed write-permissions.

### 1.3 Cross-service discovery + self-healing coordinates

- **`apps/fiab-console/app/api/azure/connectables/route.ts`** — the strong
  cross-subscription "Add existing" browser. One multi-type Azure Resource Graph
  query returns every connectable resource (SQL, PostgreSQL, Storage/ADLS,
  Cosmos, Synapse, Databricks, Event Hubs, Service Bus, Key Vault) the signed-in
  user can reach across ALL their subscriptions, honoring their RBAC + ABAC, with
  a proven ARM control-plane list fallback and honest no-access gate. **This is
  the discovery engine the attach wizard should reuse**, extended to the full
  service-type set (ADX, ADF, Purview, AI Search, AML).
- **`apps/fiab-console/lib/azure/resource-graph-coords.ts`** —
  `discoverResourceCoordsByName()`, self-healing resolution of a resource's real
  `{subscriptionId, resourceGroup}` by name via Resource Graph, used as a
  fallback when env-configured coordinates 404/403. Cloud-invariant.

### 1.4 How services get INCLUDED in Loom functionality today

- **Connections (`apps/fiab-console/lib/azure/connections-store.ts`)** — a
  Cosmos-persisted, Key Vault-backed registry of reusable data-source
  connections, **read live at request time** (not env). Supports an `origin:
  'existing'` import path carrying non-secret ARM provenance
  (`armResourceId`, `subscriptionId`, `resourceGroup`, `location`) captured from
  the connectables ARG browser. **On create it best-effort registers the
  connection as a Purview scan source** (`registerConnectionInPurview`). This is
  the closest existing analog to the attach registry this design proposes — the
  attach registry generalizes it from "data-source connections" to "any Azure
  service backing a landing zone."
- **Governance / Purview (`apps/fiab-console/lib/azure/purview-autoonboard.ts` +
  `app/api/governance/scans/register-existing/route.ts` +
  `lib/components/governance/register-existing-source-dialog.tsx`)** — every Loom
  item is auto-onboarded as a Purview Atlas entity + (value-driven) scan source;
  there is already an "Add existing (browse my subscriptions)" governance path
  that registers an ARG-discovered resource as a Purview Data Map scan source.
- **Chargeback / cost** — `lib/azure/cost-management-client.ts` runs Cost
  Management queries **per Loom subscription** (multi-sub, throttle-aware) and
  `lib/azure/cost-attribution.ts` records per-execution LCU attribution to a
  Cosmos ledger keyed by workspace/item/domain/**resourceId**. Attributing an
  attached resource's spend needs its `resourceId` to be known to Loom — which
  the registry provides.
- **Telemetry** — diagnostic-settings → Log Analytics wiring exists for
  Loom-provisioned resources; attached resources need a diagnostic-settings
  push to the hub LAW (see Phase 2).
- **Runtime config vs env vars** — CRITICAL constraint. `admin-plane/main.bicep`
  is **at the 256-param bicep cap** (per memory), and the runtime env path
  (`lib/admin/env-config.ts` + `app/api/admin/env-config/route.ts`) applies a
  change by **rolling a new ACA revision** (ARM PATCH) — the Cosmos `env-config`
  doc is for durability/drift only; the console reads `process.env` at request
  time. So **adding a new `LOOM_<SVC>_*` env var per attached service is the
  wrong model** (bicep-param pressure + a revision roll per attach + reverts on
  redeploy). The right model is a **Cosmos-backed registry the clients read live**
  — exactly how `connections-store.ts` already works.

---

## Part 2 — The design: "Attach existing service" as a first-class capability

### 2.1 The unifying idea — a Landing-Zone Service Registry (Cosmos)

Introduce one durable registry, `lib/azure/attached-services-store.ts`, backed
by a new Cosmos container `attached-services` (PK `/tenantId`). This is the
convergence point that both day-0 BYO and day-2 attach write into, and that
every consumer (navigators, governance, chargeback, telemetry, connections)
reads. It follows the proven `connections-store.ts` pattern: Cosmos metadata,
KV `secretRef` for any secret, best-effort Purview registration on create,
referential-integrity guard on delete.

```ts
export type AttachedServiceKind =
  | 'synapse' | 'adx' | 'databricks' | 'storage-adls' | 'azure-sql'
  | 'cosmos' | 'eventhubs' | 'adf' | 'purview' | 'aml' | 'ai-search'
  | 'apim' | 'stream-analytics' | 'aoai' | 'maps';   // = scan-services keys ∪ extras

export interface AttachedService {
  id: string;                    // uuid
  tenantId: string;              // partition key
  landingZoneId: string;         // `${subscriptionId}/${rg}` — ties to a DLZ (or 'hub')
  kind: AttachedServiceKind;
  displayName: string;
  // ARM provenance (non-secret) — the source of truth for coordinates.
  armResourceId: string;
  subscriptionId: string;
  resourceGroup: string;
  location?: string;
  // Live posture captured at attach + refreshed on demand.
  reachability?: 'reachable' | 'private-endpoint-needed' | 'blocked' | 'unknown';
  rbacState?: 'granted' | 'pending' | 'manual-gate';
  networkPosture?: 'public' | 'private-endpoint' | 'service-endpoint' | 'unknown';
  // Integration toggles — everything default-ON (loom_default_on_opt_out).
  governanceRegistered?: boolean;   // Purview scan source id
  purviewSourceName?: string;
  telemetryWired?: boolean;         // diagnostic-settings → hub LAW
  chargebackIncluded?: boolean;     // resourceId flows to cost attribution
  // Optional data-plane secret (only for kinds that need one; else Entra-MI).
  secretRef?: string;
  origin: 'day0-byo' | 'day2-attach';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
```

Why a registry and not env vars: it is read live (no revision roll per attach),
carries zero bicep-param cost (dodges the 256-cap), survives redeploys (Cosmos,
not `process.env`), is multi-tenant/multi-LZ, and gives every consumer one place
to enumerate "what belongs to Loom." Env/`EXISTING_*` remain the **day-0
bootstrap seed** (see §2.6 convergence).

### 2.2 Admin UI — the attach wizard

Add a third tab / detail-drawer action on `/admin/landing-zones`: **"Attach
existing service"** (entry from both the Overview pane's per-LZ card and the LZ
detail drawer). A 4-step Fluent wizard (matching `ux-standards.md` + the Setup
Wizard's look):

1. **Discover** — call an extended `/api/azure/connectables` (superset including
   ADX `Microsoft.Kusto/clusters`, ADF `Microsoft.DataFactory/factories`,
   Purview `Microsoft.Purview/accounts`, AI Search `Microsoft.Search/searchServices`,
   AML `Microsoft.MachineLearningServices/workspaces`). Group candidates by kind;
   each row shows name, RG, subscription, region. Honors the caller's RBAC/ABAC.
2. **Pick** — dropdown/checkbox selection (no free-text resource id — honors
   `loom_no_freeform_config`). Multi-select allowed (attach several at once).
3. **Validate** — a real preflight per pick (`/api/landing-zones/[id]/attach/preflight`):
   - **Reachability** — control-plane GET on the resource id (200 = reachable).
   - **RBAC** — does the Console UAMI already hold the navigator role? If not,
     compute the exact role + scope needed (reuse the `byo_grant` role-GUID map
     from `grant-navigator-rbac.sh`).
   - **Network posture** — read `publicNetworkAccess` / private-endpoint
     connections; flag `private-endpoint-needed` when the resource is PE-locked
     and the hub has no PE/DNS path to it.
   - Render each as a green check or an **honest MessageBar** (per
     `no-vaporware.md`) naming the exact remediation.
4. **Register** — POST `/api/landing-zones/[id]/attach` → writes the
   `AttachedService` doc, kicks the auto-integration hooks (§2.4), returns a
   receipt (what was registered, what was auto-granted, what still needs a manual
   action) shown as a summary card.

### 2.3 API surface (BFF routes)

- `GET  /api/azure/connectables?kinds=synapse,adx,…` — extend the existing route
  with the fuller kind set (backward compatible; default = current connectable
  set).
- `POST /api/landing-zones/[id]/attach/preflight` — body `{ armResourceId }[]`;
  returns per-resource `{ reachability, rbacNeeded, networkPosture, remediation }`.
- `POST /api/landing-zones/[id]/attach` — body `{ services: {armResourceId, kind}[]
  }`; validates tenant-admin (`enforceCapability`), writes registry docs, fires
  auto-integration, returns the receipt. PDP-gated like `env-config`.
- `GET  /api/landing-zones/[id]/services` — list attached services for a LZ
  (drives the LZ detail drawer).
- `DELETE /api/landing-zones/[id]/services/[serviceId]` — detach; referential-
  integrity guard (refuse if items bind it, mirror of `ConnectionInUseError`);
  best-effort de-register from Purview; **never** deletes the customer's Azure
  resource (brownfield = we borrow, we don't own).

### 2.4 Auto-integration on attach (the "becomes part of Loom" step)

On successful attach, fire these best-effort, non-blocking hooks (each honest-
gated, mirroring the existing patterns):

1. **RBAC** — grant the Console UAMI the navigator role at the resource's real
   scope. Two modes: (a) **auto-grant** when the running principal/UAMI can
   create the role assignment (reuse the role-GUID map + `az role assignment`
   logic already in `grant-navigator-rbac.sh`, ported to an ARM PUT in
   `lib/azure/role-grant-client.ts`); (b) **emit a grant script** (honest gate)
   when it cannot, naming the exact role + scope — never a silent failure.
2. **Governance** — register the resource as a Purview Data Map scan source via
   the existing `registerConnectionInPurview` / `register-existing` machinery
   (map `AttachedServiceKind` → Purview kind via `purview-source-map.ts`), store
   `purviewSourceName` on the doc. Auto-scan gated on `LOOM_PURVIEW_AUTOSCAN`.
3. **Chargeback** — include the resource id in cost attribution + the Cost
   Management rollup. Because attribution keys on `resourceId` already, this is:
   (a) ensure the resource's subscription is in the billing-scope sweep, and
   (b) tag executions against attached backends with their `resourceId`.
4. **Telemetry** — push a diagnostic-settings profile on the resource → the hub
   Log Analytics workspace (`lib/azure/monitor-client.ts` already talks to
   Monitor). Honest-gate when the UAMI lacks Monitoring Contributor.
5. **Navigators + Connections** — the registry makes the resource selectable as a
   backend in the relevant service navigator and, for data sources, auto-creates
   a matching `origin:'existing'` Loom Connection so it is immediately usable in
   mirroring / linked services / Get-Data.

### 2.5 How items select an attached service as a backend

Item provisioners currently resolve their backend from `LOOM_<ITEM>_BACKEND` +
`EXISTING_*`/`LOOM_<SVC>_*` env (per `no-fabric-dependency.md`, Azure-native is
default). Extend the backend resolver to **consult the registry first**: given a
landing zone + item kind, prefer an attached service of the matching kind (its
`armResourceId` supplies coordinates), then fall back to env, then to the
Loom-provisioned default. This is a small, additive change to the resolver — the
registry is just a higher-priority coordinate source, so existing behavior is
unchanged when the registry is empty.

### 2.6 Deploy-time (day-0) convergence

Unify day-0 BYO with the day-2 registry so there is one model:

- After a deploy that used `byo-wizard.sh` / `EXISTING_*`, a **one-time seed
  step** (a small BFF reconcile on first admin login, or a post-deploy job)
  reads the `EXISTING_*`/`LOOM_<SVC>_*` env and **upserts a matching
  `AttachedService` doc** (`origin:'day0-byo'`) for each reused service, binding
  it to the hub/default LZ. From then on the registry is authoritative and the
  env is just the bootstrap seed.
- `scan-services.ts` stays the shared catalog (its keys ARE the
  `AttachedServiceKind` core set), so the Setup Wizard, `byo-wizard.sh`, and the
  attach wizard all speak the same service vocabulary.
- Result: whether a service arrived on day 0 (bicep params) or day 2 (attach
  wizard), it lands in the same registry and gets the same auto-integration.

### 2.7 Gov / Commercial parity + honest gates

- Every route uses `armBase()`/`armScope()` + cloud-endpoint suffix helpers
  (already the norm) so discovery, coordinates, and PE/DNS work in Commercial /
  GCC / GCC-High / IL5 / DoD. No `api.fabric.microsoft.com` / Power BI hosts on
  any path (`no-fabric-dependency.md`).
- Every non-functional state is an honest Fluent MessageBar naming the exact env
  var / role / resource (`no-vaporware.md`): unreachable resource, missing UAMI
  role (with the grant script), PE-needed (with the peering/PE remediation),
  Purview not configured, Monitor not granted. The full wizard surface still
  renders in every gated state.

---

## Part 3 — Phased build plan

**Phase 1 — Registry + attach wizard + backend selection (Synapse / ADX / storage).**
- `lib/azure/attached-services-store.ts` + the `attached-services` Cosmos
  container (add to the cosmos init step per `no-vaporware.md` bicep-sync).
- Extend `/api/azure/connectables` to the fuller kind set (ADX, ADF, Purview, AI
  Search, AML).
- `/api/landing-zones/[id]/attach{,/preflight}` + `/services` routes.
- The "Attach existing service" wizard tab/drawer on `/admin/landing-zones`
  (discover → pick → validate → register), Fluent v9 + Loom tokens, honest gates.
- Backend resolver consults the registry first for Synapse / ADX / ADLS.
- Day-0 seed reconcile (`EXISTING_*` → registry docs).
- Verification: attach a real existing Synapse + ADX + storage account with
  `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET; a notebook/KQL runs against them; the
  service shows in the LZ detail drawer. Real-data E2E receipt in the PR.

**Phase 2 — Auto-integration (RBAC / governance / chargeback / telemetry).**
- `lib/azure/role-grant-client.ts` — ARM-PUT port of `grant-navigator-rbac.sh`'s
  role-GUID map; auto-grant when possible, else emit the grant script (honest
  gate). Wire into the attach hook.
- Purview scan-source registration on attach (reuse `registerConnectionInPurview`
  / `register-existing`), `purviewSourceName` persisted.
- Chargeback: ensure attached subs are in the billing sweep; tag executions with
  the attached `resourceId`.
- Telemetry: diagnostic-settings → hub LAW push on attach (Monitor client),
  honest-gate on missing Monitoring Contributor.
- Auto-create `origin:'existing'` Connections for data-source kinds.
- Verification: attach → confirm the resource appears in Governance (Purview
  source), its spend in Chargeback, its logs in the hub LAW, its role assignment
  live — each with a receipt.

**Phase 3 — Full parity attach for all 12+ service types + network posture.**
- Remaining kinds: Databricks, Cosmos, Event Hubs, ADF, Stream Analytics, AOAI,
  AI Search, APIM, AML, Maps — each with its navigator backend-selection wired to
  the registry.
- **Private-endpoint / network remediation** (the biggest current gap): detect
  PE-locked brownfield resources at preflight; offer a guided remediation —
  create a PE from the hub VNet into the resource + private DNS record (bicep
  module `modules/landing-zone/attach-service-pe.bicep`), or hub↔resource-VNet
  peering. Honest-gate when it needs an action only the resource owner can take.
- Detach lifecycle + referential-integrity guard across all kinds.
- Teardown validation (per `no-vaporware.md`): attach in a clean sub, confirm
  every attached kind's navigator executes its primary action, Commercial + Gov.

---

## Open questions

1. **PE-locked brownfield resources.** When the existing Synapse/ADLS/etc. is
   private-endpoint-only and its VNet is the customer's (not the hub's), does
   Loom (a) auto-create a PE from the hub VNet + DNS (needs the resource owner's
   consent + rights), (b) require hub↔customer VNet peering, or (c) honest-gate
   with a runbook? Recommend (a) as an opt-in guided action, (c) as the default
   gate. Phase 3.
2. **Landing-zone binding for `hub`-scoped services.** Admin-plane services
   (APIM, AI Search, AOAI, Purview) attach to the hub, not a DLZ. Model as a
   synthetic `landingZoneId='hub'`? (Proposed above.) Confirm.
3. **Ownership on detach.** Confirmed intent: detach never deletes the customer's
   Azure resource — it removes the registry binding + Loom's RBAC/scan source
   only. Should we also revoke the UAMI role we granted on attach (clean) or
   leave it (safer for re-attach)? Recommend revoke-on-detach with a toggle.
4. **Day-0 seed timing.** First-admin-login reconcile vs a post-deploy job — the
   former needs no new infra; the latter is more deterministic. Recommend the
   login reconcile (idempotent upsert) for Phase 1.
5. **Multi-tenant scope of the registry.** `connections-store` partitions by the
   user's `oid`; the attach registry should partition by tenant and be
   admin-managed. Confirm PK = tenant (`claims.tid`) vs the admin's `oid`.
6. **AML / AI Search / Maps in `connectables`.** These aren't in the current
   `CONNECTABLE_ARM_TYPES`; adding them widens the ARG query. Confirm no
   performance concern on large tenants (the route already bounds paging + wall
   clock).

---

## Phase 1 — implemented (2026-07-13)

Phase 1 (registry + attach wizard + backend selection) is built. Decisions taken
against the open questions: PK = tenant (`claims.tid ?? oid`, open-Q #5);
hub-scoped services use `landingZoneId='hub'` (open-Q #2); detach removes only the
Loom binding, never the Azure resource (open-Q #3); day-0 seed is the idempotent
first-read reconcile (open-Q #4). Discovery is a dedicated route (not an extended
`/connectables`, open-Q #6) to keep the working Connections import path
untouched.

**Shipped:**
- `lib/azure/attached-services-store.ts` — the `attached-services` Cosmos
  container (PK `/tenantId`; added to `cosmos.bicep loomContainers` +
  `cosmos-client.ts ensure()`), CRUD, idempotent-per-resource upsert, referential-
  integrity detach guard (`AttachedServiceInUseError`), and the day-0 BYO seed
  reconcile (`reconcileDay0Byo` from `EXISTING_*`).
- `lib/azure/attached-service-kinds.ts` — closed kind enum, ARM-type↔kind map
  (incl. AOAI vs Maps Cognitive disambiguation), the navigator role-GUID map
  (verbatim from `grant-navigator-rbac.sh`), and the `scan-services` key bridge.
- `lib/azure/attached-discovery.ts` + `GET /api/landing-zones/discover` — ARG
  discovery over the full attachable kind set (user token → UAMI fallback →
  honest gate).
- `lib/azure/attach-preflight.ts` + `POST /api/landing-zones/[id]/attach/preflight`
  — real reachability + network posture (from the ARM properties bag) + the exact
  navigator role the UAMI needs.
- `POST /api/landing-zones/[id]/attach`, `GET /api/landing-zones/[id]/services`,
  `DELETE /api/landing-zones/[id]/services/[serviceId]` — register (with receipt),
  list (+ day-0 seed on read), detach (409-guarded). All gated to the new
  `admin.attach-service` capability + PDP.
- Admin UI — `AttachedServicesSection` (per-DLZ in the overview detail drawer +
  a hub-scoped card) + the 4-step `AttachServiceWizard` (discover → pick →
  validate → register), Fluent v9 + Loom tokens, `EmptyState`, honest MessageBars.
- Backend resolver — `lib/azure/attached-target-resolver.ts` +
  `serverlessTargetResolved` / `dedicatedTargetResolved` (synapse-sql-client) +
  `resolvedClusterUri` (kusto-client). The ADX navigator's shared guard
  (`app/api/adx/_shared.ts`) now resolves the cluster registry-first (env
  fallback), consumed by `/api/adx/overview`. `resolveAttachedService` is fronted
  by a dependency-free module-level **TTL cache** (60s, caches hits AND nulls,
  invalidated on attach/detach/upsert) so the per-request ADX-guard resolution
  (many concurrent KQL tile queries) costs a Cosmos read at most once per
  tenant/kind/LZ per minute — the empty-registry common case never re-queries.

**Honest gaps (deferred to Phase 2/3 per the plan):**
- RBAC is *reported* (exact role + scope), not yet auto-granted — Phase 2's
  `role-grant-client`. Attach records `status:'pending-grants'`.
- Governance / telemetry / chargeback auto-integration hooks are Phase 2
  (`chargebackIncluded` defaults true since attribution keys on `resourceId`).
- Private-endpoint remediation is flagged at preflight but not auto-created —
  Phase 3.
- Registry-first resolution is wired at the ADX guard + the Synapse/ADX async
  client variants; broad adoption across every navigator caller is Phase 3.
