# Parity Gap — Power Platform editors (v2 validator, 2026-05-26)

> Editors: `powerplatform-environment` / `dataverse-table` / `power-app` / `power-automate-flow` / `power-page` / `ai-builder-model`
> Source: `apps/fiab-console/lib/editors/powerplatform-editors.tsx`
> Validator state: source-grade audit + 1 live render screenshot (`temp/parity/powerplatform-environment-loom.png`). Live click-every-button blocked — the deployed Loom session requires MFA reapproval that broke mid-validation; the BFF returned `unauthenticated` for Power Platform scope.

## Validation method
- Phase 1 (Fabric reference): make.powerapps.com / make.powerautomate.com / make.powerpages.microsoft.com / aka.ms/aibuilder — visited mentally from previous catalog work; full screenshot capture deferred (Phase 1 was completed in earlier catalog passes).
- Phase 2 (Loom capture): `powerplatform-environment` only — others 401'd at the BFF before rendering items.
- Phase 3 (gap doc): below.
- Phase 4 (click every button): BLOCKED — MFA expired mid-session, OBO PowerPlatform token unavailable.

## Common chrome
All six editors share `BASE_RIBBON`:
```
Home → Item → [Reload, Open in Power Platform]
```
That is **2 ribbon actions in 1 group in 1 tab**.

Compared to Fabric / Power Platform admin centre ribbons (make.powerapps.com lists 5-7 ribbon-equivalent commands per surface — Solutions, Tables, Connections, AI Builder, Flows, Apps, Pages, Environments, Analytics + a context menu on each item with Edit / Share / Run / Delete / Versions / Owner / Co-owners / Export), the Loom ribbon is **<30% of Fabric's surface** → **MAJOR**.

## 1. `powerplatform-environment`

| Element | Fabric / make.powerapps.com | Loom | Severity |
|---|---|---|---|
| Environment picker (dropdown) | Top-bar combobox with SKU + region | `Dropdown` with `displayName (sku)` template | present |
| Per-env metadata grid (SKU, State, Location, Default, Dataverse domain, Instance URL) | Admin panel side-rail | `metaGrid` 6 fields | present |
| Reload button | Top-right refresh icon | `Reload` button | present |
| Capacity & DLP summary | Admin centre tile | Caption1 "deferred — add SP to admin role" | **MAJOR** (advertised but no real surface) |
| Security group | Admin centre tile | absent | **MAJOR** |
| Open in Power Platform deep-link | "Open in admin centre" link | Ribbon button "Open in Power Platform" (no `onClick` wired — just a `RibbonTab` label) | **BROKEN** (Phase 4 unverified, label only) |
| User profile photo | Admin centre top-right | absent | MINOR |

**Live observation**: With Loom session reauth'd via MSAL, the BFF still returned `Power Platform error — unauthenticated`. The editor renders the chrome but cannot list environments → for **a real user with a valid Power Platform OBO token** this might work, but **today** it surfaces as a broken state.

**Grade**: **C** — renders, key panes present, key actions either missing or backend-blocked. Not D because the environment picker / metadata grid are real Fluent components shaped to BAP REST.

## 2. `dataverse-table`

| Element | make.powerapps.com → Tables | Loom | Severity |
|---|---|---|---|
| Environment picker | Top combo | EnvPicker (shared) | present |
| Tables list (Logical name / Display name / Entity set / Custom?) | Grid w/ schema icon, audit columns, search, filter dropdowns | Fluent Table 4 cols, no search, no filter | **MAJOR** — no search, no filter |
| Click a table → schema | Side-rail with Form/View/Chart/Dashboard editors | Just `attributes` table (5 cols incl. PK/Name badges) | **MAJOR** — no Forms editor, no Views, no Charts, no Business Rules |
| Add column button | Top "+ New column" | absent | **BLOCKER** |
| Add row / records grid | "Data" tab grid | absent | **BLOCKER** |
| Relationships editor | "Relationships" tab | absent | **BLOCKER** |
| Business rules | "Business Rules" tab | absent | MAJOR |
| Filter by Custom / Managed | Toolbar | hardcoded slice `IsCustomEntity || systemKey` | MINOR (no toggle, but pragmatic) |
| Save & publish | Required for any change | not applicable (read-only editor) | **BLOCKER** for parity with `make.powerapps.com` |

**Grade**: **D** — pure read-only browse. Cannot create / modify a Dataverse table. The earlier "v3 Dataverse-table editor" claim is scaffold-grade compared to `make.powerapps.com/tables`.

## 3. `power-app`

| Element | make.powerapps.com → Apps | Loom | Severity |
|---|---|---|---|
| Apps list (Name / Type / Owner / Modified / Open) | Grid, share/play/edit/version/delete column | 5-col Table with Play link | present |
| Click app → detail | Opens Studio in Canvas or sidepanel | metaGrid 7 fields, no edit | **BLOCKER** for parity — no studio launch, no preview, no share |
| Play (launch app) | Big Play button | Inline `<a target="_blank">` to `appOpenUri` | present (B-grade) |
| Edit in Studio | "Edit" button → Canvas Studio | absent | **BLOCKER** |
| Share app | "Share" dialog | absent | **MAJOR** |
| Versions | "Details → Versions" panel | absent | **MAJOR** |
| Settings | "Details → Settings" | absent | **MAJOR** |
| Insights / Analytics | "Analytics" link | absent | MINOR |
| Solution checker | Top-bar action | absent | MINOR |

**Grade**: **D** — list + play link works (B for that sliver), but everything past clicking into an app is missing. Pure browse, no authoring.

## 4. `power-automate-flow`

| Element | make.powerautomate.com → My flows | Loom | Severity |
|---|---|---|---|
| Flows list (Name / State / Trigger / Modified) | Grid with Start/Stop column + run pill + share | 4-col Table + clickable name | present |
| State badge (Started / Stopped / Suspended) | Pill | `Badge color=success/danger/subtle` | present |
| **Run now** action | Top-right "Run" button on detail | "Run flow" primary button when selected | **B-present** ✓ |
| Run result MessageBar | Inline toast | success/error MessageBar | present |
| Runs list (Run name / Status / Started / Ended / Error) | 28-day history grid | 5-col Table | present |
| Edit flow definition | Opens Designer | absent | **BLOCKER** |
| Turn on / Turn off | Toggle | absent | **MAJOR** |
| Delete flow | Bin icon | absent | **MAJOR** |
| Share flow with co-owners | Share dialog | absent | **MAJOR** |
| Trigger detail (which Dataverse table / SP list / Schedule) | Side-rail | only `triggerType` string | MINOR |
| Run history pagination | infinite scroll | top 5-50 cap | MINOR |

**Grade**: **C** — Run is wired (this is the strongest feature of any PP editor in Loom), runs history renders, but cannot edit, toggle, or delete. The Run button being functional saves it from D.

## 5. `power-page`

| Element | make.powerpages.microsoft.com → Sites | Loom | Severity |
|---|---|---|---|
| Sites list (Name / Domain / Status / Type / Modified) | Card grid with thumbnail | 5-col Table | **MAJOR** — no thumbnails, no card view |
| Click site → detail | Opens Studio with Pages / Components / Site settings / Templates | metaGrid 8 fields, no edit, no link | **BLOCKER** |
| Edit in Power Pages Studio button | "Edit" button → studio | **absent — no deep-link to studio** | **BLOCKER** (request explicitly asked for this) |
| Visit site link | Open in new tab | `<a target="_blank">` on websiteurl | present |
| Pages / Components / Site Settings tabs | Side-rail tabs in Studio | absent | **BLOCKER** |
| Templates (Photo Gallery / Event / Help Center / Custom) | Studio gallery | absent | MAJOR |
| Status pill | Active / Inactive | Badge brand color (semantic mapping not great — "1" → success) | MINOR |

**Specific critical check** ("Power Pages: deep-link to make.powerpages.microsoft.com on save? or in-editor edit?"): **NEITHER.** The Power Pages editor in Loom is browse-only — no in-editor edit, no save, no deep link to the make studio. The "Open in Power Platform" ribbon button (BASE_RIBBON) has no `onClick` wired and would not open the site even if it did.

**Grade**: **D** — list-and-link, no studio bridge.

## 6. `ai-builder-model`

| Element | aka.ms/aibuilder → Models | Loom | Severity |
|---|---|---|---|
| Models list (Name / Template / State / Status / Modified) | Card grid with thumbnail | 5-col Table | MAJOR — no thumbnails |
| State / Status badges | Live with quick-test | Badge with `aiStateLabel`/`aiStatusLabel` switch | present |
| Click model → detail | Opens model design surface w/ Train / Quick test / Publish | metaGrid 9 fields, no actions | **BLOCKER** |
| Train | Big button | absent | **BLOCKER** |
| Quick test | Image / text upload + run | absent | **BLOCKER** |
| Publish | Button | absent | **MAJOR** |
| Versions | Tab | absent | MAJOR |
| Performance / Confidence chart | Detail tab | absent | MAJOR |
| Solution checker | Top-bar | absent | MINOR |

**Grade**: **D** — list-only browse. Cannot train, test, publish, or even open the model design surface.

## Phase 4 (functional click-every-button)

**Blocked** — MFA expired and re-auth required for each Power Platform OBO request; the deployed Loom environment doesn't have a persistent Power Platform service-principal token. Documented as a session limitation, NOT graded as F.

Specific buttons that exist in source but have NO `onClick` in this editor and therefore cannot fire even if a user clicks them:
- `Open in Power Platform` (in `BASE_RIBBON`)
- `Reload` in `BASE_RIBBON` (the page-level Reload buttons inline DO fire)

Those count as **BROKEN ribbon buttons** if a user discovers them.

## Summary

| Editor | Grade | Reason |
|---|---|---|
| powerplatform-environment | **C** | Renders, real env REST, no capacity/security panes, BackendError visible on session expire |
| dataverse-table | **D** | Read-only browse, no Forms / Views / Charts / Add column / Add row / Relationships / Business rules |
| power-app | **D** | Read-only browse, no Studio launch, no edit / share / versions / settings |
| power-automate-flow | **C** | Run wired ✓, runs history ✓, but no edit / toggle / delete / share |
| power-page | **D** | Read-only browse, NO deep-link to make.powerpages.microsoft.com, no studio bridge |
| ai-builder-model | **D** | Read-only browse, no Train / Quick test / Publish / Versions |
