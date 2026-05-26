# Power App Editor — canvas + model-driven parity spec

> Captured 2026-05-26 by catalog agent from Microsoft Learn (Power Apps Studio · canvas-app authoring · model-driven app designer · control reference) and inspection of `apps/fiab-console/lib/editors/powerplatform-editors.tsx::PowerAppEditor` + `apps/fiab-console/lib/azure/powerplatform-client.ts`. Loom has working PowerApps admin REST read of apps (UAT-verified); this spec compares Loom's current surface against the full Power Apps Studio + model-driven app designer authoring UX.

## Overview

A Power App is either a **canvas app** (drag-and-drop UI authored in Power Apps Studio, configured with Power Fx, connects to 1000+ connectors, no Dataverse requirement) or a **model-driven app** (data-first, generated from Dataverse tables · forms · views · business rules, surfaced via the Unified Interface, requires a Dataverse env). Both are stored as Dataverse records under a Power Platform environment and exposed via the PowerApps admin REST API (`api.powerapps.com`). The maker creates an app, the runtime is `apps.powerapps.com` (browser) / Power Apps mobile (iOS · Android · Windows) / embedded in Teams / Power Pages / model-driven hosts. Apps are licensed per-user (Power Apps per-user plan) or per-app (per-app plan); first-party Dynamics 365 apps come bundled with Dynamics 365 licenses.

## Power Apps Studio (canvas) UX

### Left navigation
- **Tree view** — hierarchical Screens → Controls; drag to reorder, right-click for rename/duplicate/delete; shows control count
- **Insert** — Controls catalog: Text label · Text input · Button · Image · Icon · Shapes · Gallery (vertical/horizontal/blank vertical/blank horizontal) · Data table · Forms (Display / Edit) · Charts (Column / Line / Pie) · Media (Video / Audio / Microphone / Camera / Barcode scanner / PDF viewer) · Input (Drop down · Combo box · List box · Date picker · Toggle · Slider · Rating · Timer · Pen input) · Layout (Container · Horizontal/Vertical container — responsive · HTML text · Rich text editor) · AI (AI Builder Form processor · Object detector · Business card reader · Receipt processor · Text recognizer · Generic AI prompt)
- **Data** — connections + data sources panel; `+ Add data` opens connector picker (1000+ connectors)
- **Media** — image/video/audio asset library
- **Components** — custom + library components
- **Variables** — global / context / collection inspector with current values
- **App checker** — accessibility, performance, formulas with errors / warnings
- **Search** — across screens, controls, properties

### Top ribbon
- **File** — App settings (Name · Icon · Description · Screen size + orientation + scale-to-fit · Theme · Advanced settings) · Save · Save as · Publish · Share · Export package · Connections · Versions
- **Insert** · **Data** · **View** · **Action** (incl. New screen, Power Automate flow attach, Edit themes)

### Center canvas
- WYSIWYG render of current screen
- Resize handles, snap-to-grid, alignment guides
- Tablet vs phone layout toggle
- Zoom slider · Fit to screen
- Live data preview if data source is bound

### Right rail
- **Properties panel** — control properties grouped (Action / Color / Border / Display / Position / Size / Design); each property has a current value editor or formula bar hand-off
- **Advanced** — full property dictionary with Power Fx formula editor per property

### Formula bar
- Power Fx editor: IntelliSense, autocomplete, parameter help, inline error squiggles
- Per-property contextual help
- Multi-line formula editor

### Bottom
- App checker badges · variable inspector · run/save state

### Run + share
- **Play** (preview) — runs the app in-Studio with live data
- **Share** — pick users / AAD groups · canvas-app share role (User / Co-owner) · grant data-source access · email invite
- **Versions** — restore previous version (every save = new version)
- **Settings** — Advanced (general formula-level error management, modern controls, Copilot, accessibility, performance, security)

## Model-driven app designer UX

### App designer landing
- App name · description · icon · welcome page
- **Navigation** — Areas → Groups → Subareas (sitemap); enable collapsible groups, enable Areas, show Home / Recent / Pinned
- **Pages** — table-driven page (list + form), custom page (canvas), dashboard, URL, web resource
- **Tables** — pick which tables the app surfaces; per-table choose Forms (Main / Quick-Create / Quick-View / Card / Mobile Express) and Views to include
- **Business process flows** — bind a process bar to a table
- **Validate** — checks all referenced components exist
- **Publish** — pushes changes live
- **Play** — opens the Unified Interface runtime in a new tab
- **Share** — pick users / security roles

### Unified Interface (runtime)
- Sitemap navigation on the left
- View grid → record open opens the Main form
- Form ribbon: Save · Save+Close · New · Deactivate · Assign · Share · Email a Link · Run Workflow · Run Report · Word Templates · Word/Excel templates · Process
- Form rendering driven by form-XML; tabs, sections, columns, sub-grids, related navigation
- Quick view forms (embedded mini-record-view from related table)

## What Loom has today

From `apps/fiab-console/lib/editors/powerplatform-editors.tsx::PowerAppEditor` and `apps/fiab-console/lib/azure/powerplatform-client.ts`:

- **Environment picker** (shared)
- **List apps** — `GET https://api.powerapps.com/providers/Microsoft.PowerApps/scopes/admin/environments/{envId}/apps?api-version=2016-11-01` (admin REST, UAMI auth)
- **Apps table** — Name (clickable) · Type (`CanvasApp` / `ModelDrivenApp`) · Owner (display name · email) · Last modified · Open (Play URL via `appOpenUri`)
- **Click an app** → detail view
- **Get app** — `GET .../apps/{name}?api-version=2016-11-01`
- **Detail metadata grid** — Display name · Name (GUID) · Type badge · Owner · Created · Modified · Play URL (clickable)
- Reload button
- Error MessageBars on 401/403 with hint
- Ribbon stub: Reload · Open in Power Platform

## Gaps for parity

### Both kinds
1. **No `+ New app` create flow** — can't create a canvas app or model-driven app from Loom (would need to choose Blank · From data · From template · Copilot prompt for canvas; Blank · From existing table for model-driven)
2. **No edit-app** — Loom can't open Power Apps Studio or the model-driven app designer; can only launch the runtime via `appOpenUri`
3. **No share / role assignment** — can't grant User / Co-owner roles, can't share with AAD groups
4. **No publish / versions** — Loom shows last-modified timestamp but no version list, no `restore previous version`, no `publish this version`
5. **No app-settings panel** — name · icon · description · screen size / orientation (canvas) · welcome page (model-driven) not editable
6. **No app checker** — accessibility / performance / formula warnings not surfaced
7. **No connections / data-sources panel** — Loom can't list which connectors a canvas app uses, can't show broken connection references after env-move
8. **No play (preview-in-Studio)** — Loom can launch the runtime but can't run-in-place with mocked variables
9. **No app-package export / import** — can't download a .msapp / managed-solution zip; can't import a solution
10. **No usage telemetry** — no last-used, no user-count, no session-count per app
11. **No solution membership** — can't show which solution(s) contain the app, can't switch active solution
12. **No environment-move** — can't move a custom app between sandboxes / production within the tenant
13. **No app delete / restore** — soft-delete (within 30-day TTL) and hard-delete not exposed

### Canvas-specific gaps
14. **No Studio at all** — Loom can't author screens / controls / formulas; no Tree view, no Insert catalog, no Properties panel, no formula bar
15. **No Power Fx editor** — no IntelliSense, no formula validation, no rename-control safe refactor
16. **No theme / responsive-layout designer** — no theme picker, no scale-to-fit toggle, no responsive container editor
17. **No AI Builder component picker** — Form processor / Object detector / Business card reader / Receipt processor / Text recognizer / AI prompt controls not insertable
18. **No embedded canvas in model-driven form** — the canonical "embedded canvas app on a model-driven form" pattern is not authorable

### Model-driven-specific gaps
19. **No app designer** — can't pick tables to include, can't define sitemap (Areas → Groups → Subareas), can't choose which Forms / Views per table
20. **No custom pages** — can't add custom canvas pages to a model-driven app
21. **No validate-before-publish** — Microsoft's `Validate` check (all referenced components exist) not run
22. **No Business Process Flow attach** — can't bind a BPF to a model-driven app
23. **No Unified Interface preview** — Loom links to the runtime but doesn't render forms / views inline for QA
24. **No security-role gating** — can't choose which security roles see the app

## Backend mapping

Live PowerApps admin REST is the canonical path (Loom has read working):
- **List apps** — `GET https://api.powerapps.com/providers/Microsoft.PowerApps/scopes/admin/environments/{envId}/apps?api-version=2016-11-01`
- **Get app** — `GET .../apps/{name}`
- **Update app metadata** — `PATCH .../apps/{name}` with `{ properties: { displayName, description } }`
- **Delete app** — `DELETE .../apps/{name}`
- **Share app** — `POST .../apps/{name}/modifyPermissions` with role + principal
- **Versions** — `GET .../apps/{name}/versions`; restore via `POST .../apps/{name}/restoreVersion`
- **Publish** — `POST .../apps/{name}/publish`
- **Connections** — `GET .../environments/{envId}/connections`; per-app needed connections: `GET .../apps/{name}?$expand=connectionReferences`
- **Canvas-app .msapp** — `GET .../apps/{name}/exportPackage` returns a managed-solution zip containing the `.msapp` (a zipped folder of YAML + JSON descriptors; Power Apps Studio is the only first-party authoring surface)
- **Model-driven app (Dataverse `appmodule` entity)** — `GET https://<org>.crm.dynamics.com/api/data/v9.2/appmodules` for listing; sitemap edits via the `sitemap` entity + form/view bindings via `appmodulecomponent`
- **Power Apps Studio** is a SaaS at `make.powerapps.com/apps/{name}/edit` — there's no embeddable Studio SDK; the realistic authoring play in Loom is **deep-link out** to Studio and re-read the published version on return

## Required Azure resources / tenant settings

- UAMI SP added to `Service principals can use Power Platform APIs` allow group
- Per-user Power Apps license (per-user OR per-app) to run apps; SP cannot run an app, only manage it
- For model-driven: Dataverse-enabled environment, MSAL Web App SP as Application User with `System Customizer` role minimum for read, `System Administrator` for full edit
- For canvas: connector access — premium connectors require per-user premium license; HTTP / Custom connectors live in the env

## Estimated effort

4 sessions. Update-metadata + share + versions list + publish + delete is ~1 session (all on top of existing list/get). Solutions panel + connections list + app-checker badges is ~0.5 session. Model-driven app designer (sitemap / tables / forms / views picker) is ~1.5 sessions because the sitemap entity is XML-heavy. Canvas Studio authoring is **not feasible in Loom** — recommend deep-link to `make.powerapps.com/apps/{name}/edit` for canvas edits and focus Loom on metadata / lifecycle / governance. Embedded-canvas-on-model-driven-form is a follow-up (~1 session, depends on the Forms-designer track in `dataverse-table-parity-spec.md`).
