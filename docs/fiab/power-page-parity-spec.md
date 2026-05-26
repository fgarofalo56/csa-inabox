# Power Pages Editor — design-studio parity spec

> Captured 2026-05-26 by catalog agent from Microsoft Learn (Power Pages design studio · authentication · table permissions · web roles · site visibility · Portal Management app · Azure Front Door integration) and inspection of `apps/fiab-console/lib/editors/powerplatform-editors.tsx::PowerPageEditor` + `apps/fiab-console/lib/azure/powerplatform-client.ts`. Loom has working Dataverse `mspp_website` read (with `adx_website` legacy fallback, UAT-verified); this spec compares Loom's current surface against the full Power Pages design-studio authoring UX.

## Overview

Power Pages (the modern rebrand of Power Apps portals) is Microsoft's low-code external-facing website platform, built on Microsoft Dataverse. A **Power Pages site** is a public or private web site whose data layer is Dataverse, whose rendering pipeline is Liquid + Bootstrap, and whose authoring tool is the Power Pages design studio at `make.powerpages.microsoft.com`. Each site has Pages (web pages), Lists (Dataverse table views surfaced as searchable grids), Forms / Multi-step Forms (Dataverse form-XML rendered as web forms), Web Roles + Table Permissions + Page Permissions (security model), Site Settings (per-site key/value metadata), Themes + Custom CSS / JS, and an authentication layer that integrates with Microsoft Entra · Microsoft Entra External ID (formerly AAD B2C) · OpenID Connect · SAML 2.0 · WS-Federation · OAuth 2.0 social providers. Sites are hosted as Azure App Service workloads with optional Azure Front Door + WAF in front, and can be **private** (Microsoft Entra only, internal-facing) or **public** (anonymous or authenticated via any configured identity provider).

## Power Pages design studio UX

### Top chrome
- Site name · environment · `Site visibility` badge (Private / Public) · Preview URL · `Sync` indicator
- Action ribbon: Preview · Sync · Edit Code · Browse site

### Left workspaces (5 tabs)

#### 1. Pages workspace
- Tree of webpages (parent → child) with drag-and-drop reorder
- Per-page properties: Display name · Partial URL · Page template (Layout chrome) · Page table (which Dataverse record drives content) · Parent page · Publish state (Published / Draft)
- WYSIWYG editor with section/column grid, drag-and-drop components
- **Components catalog**: Text · Image · Video · Button · Spacer · Divider · Section · Form (single-step) · Multi-step Form · List · Iframe · Code (HTML/Liquid)
- Per-component property pane on the right
- Mobile / tablet / desktop preview switcher
- Code edit hand-off: opens VS Code with the Power Platform CLI's `pac paportal download` content

#### 2. Styling workspace
- Themes (5+ built-in themes: Sapphire · Emerald · Ruby · Topaz · Diamond + custom)
- Per-theme colour palette (primary · secondary · accent · text · background)
- Typography (font family for headers · body · button)
- Per-component style overrides
- Custom CSS code editor

#### 3. Data workspace
- Pick a Dataverse table → manage its **Forms** (Main / Quick-Create) and **Views** (System views) used by the site
- Per-form: pick which columns to show on the web form (subset of Dataverse form), per-column required-level override
- Per-view: pick which columns surface in the web list, sort, filter
- **Table permissions** flyout — Web role membership × table × access level (Read / Write / Create / Delete / Append / Append-to / Share / Assign) + scope (Global / Contact / Account / Parental / Self)

#### 4. Set up workspace
- **General settings** — site name · site URL · time zone · default language · base URL
- **Identity providers** — list of configured: Microsoft Entra · Microsoft Entra External ID · Microsoft account · LinkedIn · Google · Facebook · X · custom OAuth 2.0 · custom OpenID Connect · SAML 2.0 · WS-Federation · local (deprecated)
- **Site visibility** — Private / Public toggle (private = Microsoft Entra only; public = anonymous + any IdP)
- **Web roles** — predefined Anonymous Users + Authenticated Users + custom roles; per-role members (contacts or AAD groups), per-role table permissions, per-role page permissions
- **Page permissions** — per-page ACL: which roles can view + which can edit the page record
- **Languages** — additional content languages
- **Security scan** (preview) — vulnerability scan results
- **HTTPS headers** — CSP, HSTS, X-Frame-Options
- **IP restriction** — allowlist IP / CIDR
- **Azure Front Door** integration — link to bound Front Door profile
- **WAF + DDoS** — display Azure-side WAF status

#### 5. Templates workspace (when creating new)
- 30+ site templates: Blank · Customer self-service · Employee self-service · Partner portal · Community · Government · Healthcare · Education · Nonprofit · Field service · Custom (from your tenant)
- Each template ships a starter set of Pages + Lists + Forms + Web roles

### Code editor hand-off
- VS Code extension for Power Pages: download site as a folder structure (webpages, web templates, content snippets, web files, web roles, table permissions); edit Liquid + HTML + JS + CSS locally; `pac paportal upload` pushes back

### Liquid template language
- Dynamic content using `{% %}` (tags) and `{{ }}` (output)
- Built-in objects: `user` (current contact), `website`, `page`, `entities` (Dataverse query), `request`, `settings`, `snippets`, `now`
- Tags: `entityview` · `entitylist` · `entityform` · `editable` · `chart` · `searchindex` · `assign` · `if` · `case` · `for` · `include`

### Portal Management app (advanced editing)
- Model-driven app inside the env for editing every site metadata table (sitemarker, redirect, content snippet, web link set, poll, ad, file uploads, etc.) that the design studio doesn't surface
- Settings keys (e.g., `Authentication/Registration/Enabled`, `HTTPS/ForceSSL`)
- Web file uploads (static assets stored in Dataverse `mspp_webfile`)

### Lifecycle
- **Sites list** — `make.powerpages.microsoft.com` shows all sites in tenant; per-site card: env · status (Active / Suspended / Pending) · URL · last edited
- **Provision new site** — pick template + name + env + URL + language → portal provisions an App Service instance + Dataverse base records (~10–15 min)
- **Reset / Delete / Restart** — admin operations
- **Manage capacity** — per-site MAU (authenticated / anonymous) usage vs allocation; pay-as-you-go billing link

## What Loom has today

From `apps/fiab-console/lib/editors/powerplatform-editors.tsx::PowerPageEditor` and `apps/fiab-console/lib/azure/powerplatform-client.ts`:

- **Environment picker** (shared)
- **List sites** — `GET /api/data/v9.2/mspp_websites?$select=mspp_websiteid,mspp_name,mspp_primarydomainname,mspp_partialurl,statecode,statuscode,mspp_createdon,mspp_modifiedon` (modern table), with automatic fallback to `adx_websites` for legacy portals
- **Derived `websiteurl`** — `https://<primarydomain>/<partialurl>` (Power Pages stores domain + partial separately)
- **Sites table** — Site (clickable) · Domain (clickable opens in new tab) · Status badge · Type (state) · Modified
- **Click a site** → detail view
- **Get site** — `GET /api/data/v9.2/mspp_websites(<id>)` (with `adx_websites` fallback)
- **Detail metadata grid** — Site name · Website ID · Domain · URL (clickable) · Status badge · Type · Created · Modified
- Reload button + error MessageBar with hint
- Ribbon stub: Reload · Open in Power Platform

## Gaps for parity

1. **No `+ New site` provision flow** — can't pick template + name + env + URL + language to provision a new Power Pages site
2. **No design-studio authoring** — Loom can't open Pages / Styling / Data / Set up / Templates workspaces; no Pages tree, no component drag-and-drop, no Liquid editor
3. **Pages list / tree** — Loom doesn't list `mspp_webpages` records; no parent/child hierarchy, no per-page properties
4. **Components catalog** — Text · Image · Form · List · Multi-step Form · Iframe · Code components not surfaced
5. **Themes + styling** — no theme picker, no colour palette editor, no typography settings, no custom-CSS editor
6. **Forms (web forms)** — `mspp_basicforms` and `mspp_advancedforms` not surfaced; can't pick which Dataverse form/view a page uses
7. **Lists (web lists)** — `mspp_lists` not surfaced
8. **Web roles** — `mspp_webroles` not listed; can't add/edit a role, can't set members (contacts / AAD groups)
9. **Table permissions** — `mspp_tablepermissions` not surfaced; can't ACL Dataverse tables per web role
10. **Page permissions** — per-page ACL not exposed
11. **Identity providers** — list of configured IdPs not surfaced; can't add/edit Microsoft Entra / Entra External ID / OpenID / SAML / WS-Fed / OAuth 2.0
12. **Site visibility** — Private / Public toggle not exposed (this is a critical governance control)
13. **Site settings (key/value)** — `mspp_sitesettings` not surfaced; can't edit `Authentication/Registration/Enabled`, `HTTPS/ForceSSL`, etc.
14. **Web files (static assets)** — `mspp_webfiles` not listed; can't upload/manage CSS / JS / image assets
15. **Content snippets** — `mspp_contentsnippets` not surfaced; can't edit reusable text blocks
16. **Languages** — multi-language site config not surfaced
17. **HTTPS headers + IP restriction** — CSP / HSTS / X-Frame-Options / IP allowlist not exposed
18. **Azure Front Door + WAF binding** — not surfaced; the Loom recipe for fronting a Power Pages site with Front Door + WAF + DDoS Protection is documented elsewhere in csa-inabox but not wired here
19. **Liquid template language** — no editor with IntelliSense for `entityview` / `entitylist` / `entityform` / `editable` / `chart` / `searchindex`
20. **Code edit hand-off** — no integration with the Power Platform CLI's `pac paportal download` / `upload` round-trip
21. **Templates catalog** — 30+ site templates not surfaced at create-time
22. **Lifecycle operations** — Reset / Delete / Restart / suspend not exposed
23. **Capacity management** — per-site authenticated MAU vs anonymous MAU usage vs allocation not surfaced (governance gap — Power Pages is MAU-billed)
24. **Security scan (preview)** — Power Pages built-in security-scan results not surfaced
25. **Portal Management app deep-link** — no link to open the advanced metadata editor

## Backend mapping

Live Dataverse Web API on each environment is the canonical path (Loom has read working):
- **Sites** — `mspp_websites` (legacy `adx_websites`)
- **Pages** — `mspp_webpages` (legacy `adx_webpages`)
- **Page templates** — `mspp_pagetemplates`
- **Web templates (Liquid)** — `mspp_webtemplates`
- **Web forms** — `mspp_basicforms`, `mspp_advancedforms`, `mspp_advancedformsteps`
- **Web lists** — `mspp_lists`
- **Web roles** — `mspp_webroles` with `mspp_webrolecontacts` association
- **Table permissions** — `mspp_tablepermissions` (referenced by web role via association)
- **Page permissions** — `mspp_webpageaccesscontrolrules` + `mspp_pageaccesscontrolrule_webrole`
- **Site settings** — `mspp_sitesettings` (key/value)
- **Content snippets** — `mspp_contentsnippets`
- **Web files** — `mspp_webfiles` (binary in `mspp_filecontent` annotation)
- **Identity providers** — `Authentication/...` site settings keys + `mspp_externalidentities`

Power Pages **management REST API** (`https://api.powerplatform.com/powerpages/...`) for site-level lifecycle:
- **List sites** (tenant-wide) — `GET .../websites`
- **Provision site** — `POST .../websites` with template + env + name + URL
- **Restart / Reset / Suspend / Delete** — admin operations
- **Capacity** — `GET .../websites/{id}/capacity`
- **Front Door binding** — `PATCH .../websites/{id}/customDomain`
- **Site visibility** — `PATCH .../websites/{id}/visibility` Private/Public

**Power Platform CLI (`pac paportal`)** for code authoring round-trip:
- `pac paportal download --webSiteId <id> --path <folder>` — exports the site as a YAML/HTML/JS/CSS folder
- `pac paportal upload --path <folder>` — pushes back

## Required Azure resources / tenant settings

- Dataverse-enabled Power Platform environment (Power Pages requires Dataverse)
- MSAL Web App SP as Application User on each env with `System Administrator` security role (read all `mspp_*` tables)
- Power Pages license: authenticated MAU + anonymous MAU capacity per tenant (current model) or legacy Portal Add-on
- For Front Door fronting: Azure Front Door Standard / Premium profile + WAF policy + custom domain + cert
- For Azure Entra External ID: a Microsoft Entra External ID tenant + app registration with `https://<site>/signin-microsoft-entra-external-id` redirect
- For sovereign / Gov deployments: confirm Power Pages availability in the chosen Gov region (US Gov + DoD have separate URL roots)

## Estimated effort

5 sessions. Pages list / tree + per-page properties (read-only) + Site settings (key/value) editor + Web roles list + Table permissions list is ~1 session (all on top of existing `mspp_*` reads). Identity providers + Site visibility toggle + HTTPS headers + IP restriction + Front Door binding is ~1 session. Capacity / lifecycle (Reset / Delete / Restart) + Templates catalog + provisioning new site is ~1 session. Web forms + Web lists + page-template assignment is ~1 session. Liquid / code-edit hand-off (deep-link into `pac paportal` or VS Code extension) + components-catalog WYSIWYG is **not feasible** in Loom — recommend deep-link to `make.powerpages.microsoft.com/sites/{siteId}/edit` for the design studio and focus Loom on governance + metadata. Themes / styling is a small follow-up.
