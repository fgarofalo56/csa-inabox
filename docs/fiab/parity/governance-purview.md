# governance-purview — parity with the Microsoft Purview portal connection / launch surface

**Source UI:** Microsoft Purview portal home + account connection / Data Map
connection status. Grounded in Microsoft Learn:
- https://learn.microsoft.com/purview/purview-portal
- https://learn.microsoft.com/purview/concept-best-practices-accounts
- https://learn.microsoft.com/purview/unified-catalog

**Loom surface:** `app/governance/purview/page.tsx` (+ `GovernanceShell`,
`PurviewGate`).

## No-Fabric / no-Purview reality

This surface is the **honest connection status + portal launcher**. It is the one
governance surface whose *primary subject* is Purview itself — so when Purview is
not wired (or is cross-cloud), it renders the `PurviewGate` MessageBar naming the
exact env var (`LOOM_PURVIEW_ACCOUNT`), bicep module, and the three UAMI roles.
The page still renders fully (no blank/error state). When bound, it confirms the
connection and surfaces every native Loom governance surface running against it.
No Fabric / Power BI workspace is ever required.

## Inventory → Loom coverage → backend per control

| Purview-portal capability | Loom control | Backend per control | Status |
|---|---|---|---|
| Purview connection / account status | `PurviewGate` chip + connected hero (account name, Data Map data-plane host) | `GET /api/governance/purview/status` → `probePurview()` (cheap `GET /datagovernance/businessdomains`) | ⚠️ honest-gate when unbound / cross-cloud (full UI renders); ✅ live hero when bound |
| Reason-coded connection diagnostics (not-configured / role-missing / cross-cloud / upstream-error) | `PurviewGate` MessageBar with the exact `missingEnvVar`, `bicepModule`, `rolesRequired[]`, follow-up | `probePurview()` `reason` + `hint` | ✅ BUILT |
| Launch the full Microsoft Purview portal | "Open Microsoft Purview portal" primary `Button` (X-Frame-Options: deny → launch, not iframe) | deep-link to `purview.microsoft.com` (from `purview.purviewPortal`) | ✅ BUILT |
| Native governance surfaces running on this account | responsive icon-card grid → Catalog / Domains / Scans / Lineage / Classifications / Sensitivity / Policies / Insights | client routes into the `/governance/*` + `/catalog/domains` surfaces | ✅ BUILT |
| Account + data-plane identity disclosure | account name + `<account>.purview.azure.com` host shown in the connected hero | `purview.account` from status probe | ✅ BUILT |

**Legend:** ✅ BUILT = real control + real backend today. ⚠️ honest-gate = the
connection status legitimately reflects "Purview not bound in this cloud" with
the exact one-time fix — this is the *allowed* config state per `no-vaporware.md`,
not a stub. The page never renders empty or with a fake iframe. No MISSING rows.

## Authorization — granted by default (the 403 fix)

Classic Data Map permissions are **data-plane** (root-collection metadata
policy), **not Azure RBAC**, so they cannot be set in bicep
([Learn: data-governance roles](https://learn.microsoft.com/purview/data-governance-roles-permissions)).
The Console UAMI is therefore authorized **by default** in
`csa-loom-post-deploy-bootstrap.yml` → step *Grant Console UAMI Purview Data Map
roles*, which loops `grant-purview-datamap-role.sh` over **data-reader,
data-curator, data-source-administrator, collection-administrator** on the root
collection (the deploy SP created the account, so it is the root Collection
Admin and can grant these). Two things make this work on every deploy, not just
the live eastus2 estate:

- **Right identity / account, per deploy.** `CONSOLE_UAMI_PRINCIPAL` and
  `PURVIEW_ACCOUNT` are sourced from repo vars
  (`LOOM_CONSOLE_UAMI_PRINCIPAL` ← bicep `identity.outputs.uamiConsolePrincipalId`,
  `LOOM_PURVIEW_ACCOUNT` ← bicep `catalog.outputs.purviewAccountName`) with the
  live Commercial defaults as fallback. `PURVIEW_CLOUD` drives the Data Map host
  TLD (`.us` in US Gov), mirroring `purviewBase()`'s `isGovCloud()` switch.
- **Reachability.** `catalog.bicep` deploys Purview with
  `publicNetworkAccess: 'Disabled'`, so the data plane is unreachable from the
  public GHA runner and the grant would silently fail (leaving a permanent 403
  after a "successful" deploy). The grant step now temporarily flips
  `publicNetworkAccess=Enabled` for the grant window and **restores `Disabled`
  via a trap** (mirrors the Synapse/Databricks steps).

When `LOOM_PURVIEW_ACCOUNT` is unset the pane renders the honest `PurviewGate`
(no fabricated data) — `probePurview()` returns `role_missing` on 401/403 and
`not_configured` when unbound.

## Grade

**A** — a real probe-driven connection surface: honest reason-coded gate when
unbound, live hero + native-surface launchpad + portal deep-link when bound. No
fake "embedded Purview" placeholder.
