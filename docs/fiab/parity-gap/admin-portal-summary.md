# CSA Loom Admin Portal — Fabric Parity Summary

> v2 fabric-parity-loop validator · 10 pages assessed · 2026-05-26  
> Brutal honesty per `no-scaffold-claims` + `parity-validation-standard` memories  
> See also: `.claude/rules/no-vaporware.md`

## How this was validated

Per the v2 validator standard, each of the 10 admin pages should have gotten:
1. Live Fabric reference screenshot.
2. Live Loom screenshot at the same URL.
3. Side-by-side gap matrix.
4. Click-every-button functional check.

**Caveat about the live captures in this run:** During execution the Playwright session for `https://<your-console-hostname>` lost its MSAL cookie partway through (the toolbar transitioned from `Account · Platform Admin` to `Sign in`). The site's internal tab-restore client then aggressively redirected several captures to `/items/.../new` pages that 404 for unauthenticated users. This meant **only 2 of the 10 Loom captures landed on the right page** (`admin-overview-loom.png` — header only, `admin-audit-logs-loom.png` — usable). Fabric reference captures could not be taken at all (Fabric requires MSAL too and bounced to `login.microsoftonline.com`).

To compensate per the v2 standard (which requires a real, defensible verdict), I substituted:
- **Direct source-code inspection** of all 10 Loom page files (`apps/fiab-console/app/admin/<page>/page.tsx`) — this is a stronger signal than a screenshot because it shows exactly what renders and what's wired.
- **Authoritative Fabric references via Microsoft Learn `microsoft_docs_search` + `microsoft_docs_fetch`** — fetched the full `tenant-settings-index` page and parsed it programmatically (25 sections, ~160 toggle rows).
- **Server-side route enumeration** (`Glob` over `apps/fiab-console/app/api/admin/**/route.ts`) — proves which backend endpoints actually exist.
- **HTTP probe** of all 10 admin URLs from inside the Loom client (all returned 200 — so the chrome renders).

The grades below are defensible from this evidence. They are intentionally brutal per the rules cited.

## Tenant-settings toggle count (the headline number you asked about)

| Surface | Categorized sections | Individual toggles |
|---|---:|---:|
| Fabric Tenant settings (`learn.microsoft.com/fabric/admin/tenant-settings-index`) | **25** | **~160** |
| Loom `/admin/tenant-settings` | **0** | **0** |
| Parity | 0% | 0% |

Loom's tenant-settings page is a single `<EmptyState>` describing what such a switchboard *would* control. There is no Cosmos container, no `/api/admin/tenant-settings` route, no Fluent form, no `Apply to` security-group scoping, no audit-log emission. The body text lists 15 categories Loom *would* control, but zero are interactive.

## Backend route reality

The codebase contains only **one** admin API route:

- `/api/admin/azure-resources` — powers the Capacity page (real ARM call, honest cost/util deferral)

The following routes **do not exist**:
- `/api/admin/audit-logs`
- `/api/admin/domains`
- `/api/admin/security`
- `/api/admin/tenant-settings`
- `/api/admin/usage`
- `/api/admin/users`
- `/api/admin/workspaces`

(There are also 3 admin-utility routes — `bootstrap-catalogs`, `reindex-items`, `load-sample-data` — but they aren't surfaced in any admin sub-page.)

## Grade summary

| # | Admin page | Loom implementation | Fabric reference scope | Grade | Why |
|---|---|---|---|:---:|---|
| 1 | `/admin` (overview) | AdminShell + 9-item left nav + EmptyState landing pane | ~25-section Fabric admin portal nav | **C** | Renders cleanly; nav is 64% short of Fabric and landing pane is "Pick an area" stub. |
| 2 | `/admin/audit-logs` | Pure `EmptyState` with promotional body copy | Date-range / activities / users / file filters; CSV export; deep-link to Microsoft Purview | **F** | Vaporware — body promises filters that don't exist. No `/api/admin/audit-logs`. |
| 3 | `/admin/capacity` | Real `useEffect` → `/api/admin/azure-resources`; Fluent table; honest cost/util MessageBar | Capacity-type tabs (Fabric/Premium/Embedded/Trial); per-capacity detail pane (Workloads/Notifications/DR); resize/pause/admin actions | **B** | The single A-tier-shaped page. Real backend, real data, honest gating. Missing capacity-tabs abstraction + actionable per-capacity buttons. |
| 4 | `/admin/domains` | Pure `EmptyState` + a dead "Add domain" button (no `onClick`) | Domain list + 6-tab settings side pane + Create / Subdomain / Assign workspaces / Default domain / Delegated settings | **F** | Dead button + misleading "No domains defined" framing. Textbook no-vaporware violation. |
| 5 | `/admin/security` | Pure `EmptyState`. Body lists features ("sensitivity label coverage, DLP scan results, workspace identity audit, Purview hub deep-link") that aren't rendered. | Fabric identities tab + Information protection + Protected workspaces + DR + Customer Lockbox + Purview hub | **F** | Vaporware. None of the promised links/data/tables render. |
| 6 | `/admin/tenant-settings` | Pure `EmptyState`. Body lists ~15 categories. **Zero toggles render.** | 25 categorized sections / ~160 individual toggle rows / per-toggle `Apply to` scoping / audit emission / delegation to capacity & domain admins | **F** | Biggest vaporware violation in the portal. 0% of Fabric's surface area. |
| 7 | `/admin/updates` | Real implementation: hero with version badges + Re-check + GitHub release/Actions deep-links + release notes + recent-releases list + privacy footer | No Fabric equivalent (Fabric is SaaS, no version-sync surface) | **A−** | Honest, real backend, real CTAs, sensible error states. Knock-down: release notes render as raw text instead of Markdown. |
| 8 | `/admin/usage` | Pure `EmptyState` with "(preview)" badge in title | Feature Usage and Adoption Power BI report (multi-page, with date slicer, capacity/user/item filters, card visuals, drill-through) | **F** | "(preview)" doesn't redeem the lack of any data / visuals / backend. |
| 9 | `/admin/users` | Pure `EmptyState`. Body promises Loom workspace roles + downstream Azure-RBAC mapping + license cost roll-up. | Thin Fabric wrapper that deep-links to M365 admin center + Entra > Billing > Licenses + PPU tab | **F** | Vaporware. None of the promised role mapping or cost roll-up exists. Not even the deep-links to the systems-of-record are rendered. |
| 10 | `/admin/workspaces` | Pure `EmptyState` + a misleading "My workspaces" primary button that routes to the non-admin user view at `/workspaces` | Tenant-wide workspace list with state column (Active/Orphaned/Deleted/Removing) + Refresh / Export / Edit access / Get temp access / Restore / Reassign / Rename / Delete ribbon | **F** | Vaporware + misleading button. No tenant-wide list, no admin actions. |

### Final tally

| Grade | Count | Pages |
|:---:|:---:|---|
| **A−** | 1 | `/admin/updates` |
| **B** | 1 | `/admin/capacity` |
| **C** | 1 | `/admin` (overview chrome) |
| **D** | 0 | — |
| **F** | 7 | `/admin/audit-logs`, `/admin/domains`, `/admin/security`, `/admin/tenant-settings`, `/admin/usage`, `/admin/users`, `/admin/workspaces` |

**8 of 10 admin pages fail the no-vaporware rule.** 7 are pure F-grade vaporware (promotional body copy with no implementation), 1 is partially redeemed by being the admin-portal chrome that hosts the others (graded C because it just routes).

## What "F" actually means here

Per `no-scaffold-claims`:
> **F** — Vaporware: looks like data but isn't, crashes on click, returns 500.

Per `.claude/rules/no-vaporware.md` — explicitly forbidden:
- Buttons with no click handler → `/admin/domains` "Add domain" button
- Pre-configured / hard-coded UI values that look like real data but aren't → every F-grade body text describes data that doesn't exist
- Tabs that show static content → all 7 F-grades show static `EmptyState` content
- "Coming soon" labels without a tracked TODO ticket → `/admin/usage`'s "(preview)" without a backlog ID

## Recommended remediation (priority order)

1. **Highest leverage** — convert all 7 F-grade pages from `EmptyState` to **Fluent `MessageBar intent="warning"`** per `no-vaporware.md`, naming:
   - The missing backend (`/api/admin/<page>` route)
   - The missing env vars (e.g. `LOOM_PURVIEW_TENANT_ID`)
   - The missing Cosmos containers (e.g. `loom-domains`, `loom-tenant-settings`)
   - The missing bicep module (e.g. `platform/fiab/bicep/modules/governance/domains.bicep`)
   - A deep-link to the upstream system-of-record (Microsoft Purview / M365 admin center / Entra Billing) where applicable
   This is ~half a session of work and immediately moves each from **F → C** (honest gate, no vaporware claims).

2. **Pick 2 to actually implement** to bring the portal up to >50% functional:
   - `/admin/workspaces` — easiest: enumerate Loom workspaces from the existing `/api/fabric/workspaces` shape + the resource inventory from `/api/admin/azure-resources`.
   - `/admin/users` — second easiest: call Microsoft Graph `GET /users` from the BFF (requires `Directory.Read.All` grant) → list + role-assignment view.

3. **The big one** — `/admin/tenant-settings`. Implement at least the 15 Loom-specific categories the body text already promises (OneLake / RTI / AI&Copilot / Mirroring / Synapse / Databricks / ADF / U-SQL legacy / Git / Domains / Info protection / Export & sharing / Help & support / Billing / Purview). Backing store: a `loom-tenant-settings` Cosmos container. Estimated 2-3 sessions.

4. **Defer indefinitely** unless customer-driven:
   - Replicating Fabric's full 25-section / 160-toggle structure. This is months of work for a SaaS surface Loom doesn't try to be.
   - `/admin/usage` Power BI report parity. Use the existing `loom-items` AI Search index + a simple aggregator if needed.

5. **Polish `/admin/updates` (A−→A)**: add `react-markdown` and render the release-notes body as Markdown rather than raw text. ~30 minutes of work.

6. **Polish `/admin/capacity` (B→A−)**: add a capacity-type segmented control above the table that filters by Azure RP (Synapse / Databricks / ADF / AML / Cosmos / Storage / ACR), and a per-row "Open in Azure portal" link. ~1 hour.

## Bottom line

The Loom admin portal is **2 functional pages + 1 functional shell + 7 vaporware placeholders**. Anyone clicking around the portal expecting Fabric-equivalent admin power will find one (Capacity) page that delivers and seven that don't. Per the brutal honest grading standard the user installed, this admin portal as a whole is currently **D-grade** — renders, mostly stubbed, looks nothing like the Fabric admin portal except for the side-nav structure.

The good news: every F-grade page can move to C in about an hour of work by replacing the misleading body text with an honest MessageBar — no new backend required, just compliance with the existing `no-vaporware.md` rule.
