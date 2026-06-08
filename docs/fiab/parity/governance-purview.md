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

## Grade

**A** — a real probe-driven connection surface: honest reason-coded gate when
unbound, live hero + native-surface launchpad + portal deep-link when bound. No
fake "embedded Purview" placeholder.
