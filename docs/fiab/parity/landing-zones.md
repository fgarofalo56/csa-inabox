# landing-zones — Data Landing Zone overview / visualize / manage + cross-sub deploy

Source UI (Azure-native concept): there is no single Azure portal "landing zone"
blade — a CSA Loom Data Landing Zone (DLZ) is an Azure-native composition
(ADLS Gen2 medallion lake + ADX + Cosmos graph/vector + Key Vault + Managed
Identity + private networking) deployed into a subscription as
`rg-csa-loom-dlz-<domain>-<region>`. The closest portal analogues this surface
mirrors are **Subscriptions → Resource groups** (inventory + RBAC state) and
**Deployments → az deployment sub create** (the deploy/attach action). No Fabric
or Power BI workspace is involved anywhere (no-fabric-dependency).

This doc covers the four fixes shipped in `fix-dlz-setup-wizard`.

## 1. Setup-wizard → landing-zones redirect (was an unexplained dead-end)

- `/setup` (first-run wizard) is the ONLY surface that can deploy the hub
  (`topology=tenant`). Once a hub exists a second Console can never be deployed,
  so `/setup` redirects.
- **Before:** it redirected to `/admin/add-landing-zone` — the bare attach FORM,
  with no context. Operators read it as "the setup wizard is broken / stuck."
- **After:** it redirects to `/admin/landing-zones?from=setup`. That page leads
  with **Overview** (see all DLZs) and shows an info banner when `from=setup`:
  *"Your CSA Loom hub is already deployed … the Setup Wizard now manages this
  hub's Data Landing Zones … a second Console can't be deployed."* The bare
  `/admin/add-landing-zone` link still works — it redirects to the Attach tab.
- **Nav:** left-nav "Setup wizard" → **"Setup & landing zones"**; admin-shell
  "Add landing zone" → **"Landing zones"** pointing at `/admin/landing-zones`.

| Capability | Loom coverage | Backend |
|---|---|---|
| Explain why setup redirects | ✅ banner (`?from=setup`) | client |
| Reach overview, not a bare form | ✅ Overview tab default | `/api/setup/landing-zones` |
| Old deep-links keep working | ✅ `/admin/add-landing-zone` → `?tab=attach` | redirect |

## 2. Attach copy disambiguation (was "Attaching to the existing hub")

- The hub-coordinate card header read **"Attaching to the existing hub"**, which
  looked like a pending/stuck status.
- **After:** header is **"Target hub (read-only)"** with a caption: *"The new
  landing zone will attach to this already-deployed hub. These coordinates are
  inherited automatically — you don't enter them."* The attach is an explicit
  user action: the **"Attach landing zone"** button, with states
  idle → *Attaching…* (ProgressBar) → *Attach submitted* / *Attach could not
  start* (honest MessageBar + Retry).

| Capability | Loom coverage | Backend |
|---|---|---|
| Hub shown read-only as the target | ✅ | `/api/setup/tenant-topology` |
| Explicit attach action + clear states | ✅ | `POST /api/setup/deploy` |

## 3. DLZ overview / visualization / management (NEW)

Page: `/admin/landing-zones` (tabs: **Overview** | **Add a landing zone**).

- **Visualize:** `LandingZonesCanvas` — a hub-and-spoke React-Flow map
  (`@xyflow/react`, same lib as the network / deploy-planner canvases). Hub in
  the center; each DLZ radiates out, colored by attach state, edges animated for
  attached / dashed-amber for detached. Click a node → detail drawer.
- **List:** a table of every DLZ — domain, region, subscription, resource group,
  attach-state badge.
- **Per-DLZ actions:** View details (drawer), **Scale** (→ `/admin/scaling`,
  the real ARM scale-by-SKU surface), **Deploy more** (→ Attach tab),
  **Re-attach / repair** (detached DLZs — drawer shows the exact
  `az role assignment create` to grant Contributor).

Data: `GET /api/setup/landing-zones` composes the hub coords
(`getTenantTopologySafe`) + DLZ RGs (Azure Resource Graph, RBAC-trimmed) and
derives attach state from a per-sub write-permission probe (the same pre-flight
as #4). No mock DLZs — when ARG returns nothing the map + table say so.

| Capability | Loom coverage | Backend |
|---|---|---|
| See every attached DLZ | ✅ | ARG `ResourceContainers` |
| Visualize hub + DLZs | ✅ React-Flow | `/api/setup/landing-zones` |
| Per-DLZ: details | ✅ drawer | (mapped data) |
| Per-DLZ: Scale | ✅ link to `/admin/scaling` | real ARM PATCH there |
| Per-DLZ: Deploy more | ✅ → Attach tab | `POST /api/setup/deploy` |
| Per-DLZ: Re-attach/repair | ✅ honest gate (Contributor grant) | pre-flight probe |
| Attach state (attached/detached) | ✅ | ARM permissions check |

## 4. Cross-subscription DLZ deploy — diagnosis + pre-flight gate

### Live diagnosis (2026-06-16, authenticated `az`)

- Hub/Console: sub `e093f4fd-…` (DMLZ), RG `rg-csa-loom-admin-centralus`,
  centralus.
- A cross-sub DLZ already exists: `rg-csa-loom-dlz-default-centralus` in sub
  `363ef5d1-…` (DLZ) → cross-sub DLZ **can** exist.
- Console UAMI (principalId `41d32562-…`) on the target sub: **Reader +
  Cost Management Reader + Monitoring Reader only. No Contributor/Owner.** It can
  SEE the sub (it appears in the dropdown; ARG returns its RGs) but cannot run a
  subscription-scoped deployment there.
- Operator (oid `866a2e12-…`): **Owner** on the target sub → the copy-paste
  `az deployment sub create` path would succeed.
- RPs (Kusto, DocumentDB, Storage, Databricks, EventHub) all **Registered** on
  the target sub → RP registration was **not** the blocker.
- `LOOM_SETUP_ORCHESTRATOR_URL` is empty → tier-1 orchestrator inactive; deploy
  falls to the tier-3 copy-paste command (which the Owner operator can run).

**Root cause:** the deploy route did no pre-flight permission check, so a cross-
sub deploy by the Reader-only UAMI failed opaquely (or, in copy-paste mode,
embedded an `<orchestrator-principal-object-id>` placeholder that didn't match
who was actually running it).

### Fix

`lib/setup/deploy-preflight.ts` + wiring in `app/api/setup/deploy/route.ts`:

1. **Permission pre-flight** — before any deploy tier, the route calls ARM
   `POST {arm}/subscriptions/{sub}/providers/Microsoft.Authorization/permissions`
   for the caller's effective actions and evaluates whether they cover the
   deployment writes (`Microsoft.Resources/deployments/write` etc., net of
   notActions). Reader → blocked with a precise **403 honest gate**:
   *"The deploying identity does not have permission to deploy a Data Landing
   Zone into subscription <id>. … Grant Contributor on the target subscription,
   then retry:"* + the exact `az role assignment create --role Contributor
   --scope /subscriptions/<id>`.
2. **RP-registration pre-flight** — any required RP not Registered on the target
   sub is appended to the gate as `az provider register` lines.
3. Both are Reader-only reads (the UAMI already has Reader), so the pre-flight
   never needs elevated rights — it predicts the deploy outcome.
4. Escape hatch `LOOM_SKIP_DEPLOY_PREFLIGHT=1` for environments where the
   deploying identity differs from the Console UAMI and the UAMI can't read
   permissions; the downstream tiers remain the hard guard. A pre-flight ARM
   *error* (token/network/403-on-read) is non-fatal — the route falls through to
   its existing honest copy-paste gate rather than wrongly blocking.

### Cross-sub prerequisite (document & happy path)

A cross-subscription DLZ deploy **can** succeed end-to-end once the deploying
identity holds **Contributor** (or Owner) on the target subscription:

- **Orchestrator path** (tier-1, when `LOOM_SETUP_ORCHESTRATOR_URL` is set):
  grant the orchestrator's managed identity Contributor on each target sub
  (`setup-orchestrator-rbac.bicep`).
- **Direct UAMI path / copy-paste** (tiers 2–3): grant the Console UAMI or the
  operator running the command Contributor on the target sub:

  ```
  az role assignment create \
    --assignee-object-id <deploying-identity-object-id> \
    --assignee-principal-type ServicePrincipal \
    --role Contributor \
    --scope /subscriptions/<target-subscription-id>
  ```

  (For Gov, prefix `az cloud set --name AzureUSGovernment`.) Required RPs are
  registered automatically by the deployment, or pre-register with
  `az provider register --namespace <RP> --subscription <target-sub>`.

This is a **live Azure prerequisite that cannot be auto-granted from the
Console** — the Console UAMI cannot give itself Contributor. The fix makes the
requirement explicit and precise instead of an opaque failure.

| Capability | Loom coverage | Backend |
|---|---|---|
| Detect missing target-sub write rights pre-deploy | ✅ | ARM permissions |
| Detect unregistered RPs pre-deploy | ✅ | ARM providers |
| Precise honest gate (Contributor grant + RP register) | ✅ | route 403 |
| Happy path when Contributor is held | ✅ | orchestrator / dispatch / az |

## Verification

- Vitest: `lib/setup/__tests__/deploy-preflight.test.ts` (18) +
  `lib/setup/__tests__/landing-zones-model.test.ts` (11) — 29 passing.
  Covers the Reader→deny / Owner→allow permission math, the RP diff, the gate
  command builders, and the overview attach-state mapping (incl. the live
  cross-sub-default scenario).
- `npx tsc --noEmit`: 0 new errors in touched files (repo has a large
  pre-existing baseline unrelated to this change).
- Live: confirmed the UAMI Reader-only-on-target state with `az role assignment
  list`, which is exactly what the pre-flight now reports as a Contributor gate.
