# Release audit — dimension: product-gaps

Date: 2026-07-02 · Auditor: product-gaps subagent · Scope: what a PUBLIC release of CSA Loom needs that nobody asked for yet — versioning/upgrade, backup/DR, telemetry/error reporting, cost/quota visibility, onboarding, licensing/legal, branding, support channel, a11y, i18n, performance at scale, multi-region/HA.

## Executive summary

CSA Loom has **far more "product infrastructure" than a typical internal project**: an in-product self-update path (`/admin/updates` → ghcr image rolls with honest gates), a feedback widget + automatic client-error reporting with PII redaction, real usage analytics and a Cost-Management-backed capacity/chargeback dashboard, a first-run setup wizard + onboarding tour, and full repo hygiene (SECURITY.md, CONTRIBUTING, CODE_OF_CONDUCT, dependabot, CodeQL, MIT license, release-please + CHANGELOG). Those are genuinely public-release-grade.

The release-blocking gaps cluster in four places: (1) the **public onboarding funnel is documentation vaporware** — the quickstart tells a new org to run an `azd` flow whose azure.yaml is marked "SCAFFOLDED", the "Deploy to Azure button" doc describes a README button that does not exist, and the upgrade doc references a `fiab-migrate` CLI that does not exist anywhere in the repo; (2) the **DR doc contradicts the deployed bicep** (claims RA-GRS + Cosmos geo-replication; reality is ZRS/LRS + single-region Cosmos with failover disabled); (3) the **upgrade path is image-only with no schema/infra migration mechanism** for releases that add env vars/roles/containers; (4) **a11y is claimed but never tested** (`@axe-core/playwright` installed, zero usages) — a problem for a Gov-facing public product. i18n is absent (acceptable if declared), multi-region is honestly out of scope for v1 (once the DR doc stops overstating it), and licensing is clean of GPL but lacks a THIRD-PARTY-NOTICES.

---

## What EXISTS and is good (verified)

| Capability | Evidence | Assessment |
|---|---|---|
| In-product update path | `docs/fiab/in-product-update-path.md`; `app/api/admin/updates/apply/route.ts` (GET preflight + POST ARM PATCH, honest gates `images-not-published` etc.); `app/api/version/route.ts` (LOOM_VERSION → build marker → NEXT_PUBLIC fallback) | Strong. Unit-tested orchestration. But image-only (see F3) and never rehearsed end-to-end (doc admits "Needs the public-image CI to run", lines 137–146). |
| Versioning/release engineering | `.release-please-manifest`-synced version default in `platform/fiab/bicep/modules/admin-plane/main.bicep:332`; `CHANGELOG.md`; `package.json` version 0.49.0 | Good. |
| Server telemetry | `apps/fiab-console/lib/telemetry/app-insights.ts` (App Insights via OTel, default-on in bicep, crash-guarded per #1382); `instrumentation.ts` | Good; operator-consultable in App Insights. |
| Client error reporting | `lib/components/error-boundary.tsx` — GlobalErrorBoundary + window.onerror/unhandledrejection auto-file to `/api/feedback` with redaction + fingerprint dedupe + 5/session cap | Good design; see F4 (endpoint unauthenticated) and F10 (consent/toggle). |
| Support/feedback channel | `lib/components/feedback-widget.tsx` (Bug/Feature tabs, privacy block) → `app/api/feedback/route.ts` forwarding to upstream GitHub issues with tenant-hash, air-gap fallback | Exists — rare for this class of product. See F4. |
| Usage analytics | `app/admin/usage/page.tsx` — Cosmos item/audit metrics + Log Analytics DAU/feature adoption with honest MessageBar gates | Real. |
| Cost/quota visibility | `app/admin/usage-chargeback/page.tsx` — "Real Azure Cost Management spend + real Azure Monitor utilization … honest MessageBar gate names Cost Management Reader + LOOM_BILLING_SCOPE"; `lib/azure/cost-management-client.ts` | Cost = covered. Azure *quota* pre-flight = missing (F9). |
| Onboarding in-product | `app/setup/page.tsx` (first-run wizard, redirect-once-hub-exists), `lib/components/onboarding/onboarding-tour.tsx`, `e2e/onboarding-tour.uat.ts` | Good. The *docs* funnel is the problem (F1). |
| Backup (control plane) | `platform/fiab/bicep/modules/admin-plane/loom-console-cosmos.bicep` backupPolicy `Continuous`/`Continuous7Days`; landing-zone `cosmos.bicep` same | Baseline PITR exists. No restore runbook; single region (F2). |
| HA within region | `container-platform.bicep:67` `zoneRedundant: true`; console `minReplicas: 2` (`admin-plane/main.bicep:2383`); lake `Standard_ZRS` (`landing-zone/storage.bicep:52`) | Reasonable v1 posture. |
| Repo/community hygiene | `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `.github/dependabot.yml`, `.github/ISSUE_TEMPLATE/*`, CodeQL workflow, MIT `LICENSE` | Complete. |
| Health | `app/api/health` (+ `/api/health/deep` per comments), `/admin/health` page | Exists. |

---

## Findings (full detail)

### F1 — CRITICAL — Public onboarding funnel is documentation vaporware (broken first-run path)
The three documented entry points for a brand-new org do not work:
- `docs/fiab/deployment/quickstart.md:47–65` — "Quick Start (60 minutes)" instructs `azd init -t .` + `azd up`, but the only azd project file, `platform/fiab/azd/azure.yaml`, opens with `# Status: SCAFFOLDED — real services land via PRP-02…` (line 3). There is no azure.yaml at the path the quickstart runs from (`platform/fiab/`).
- `docs/fiab/deployment/deploy-button.md` — describes README "Deploy to Azure" buttons backed by a published `mainTemplate.json`; grep of `README.md` finds **no** Deploy-to-Azure button, `find` finds **no** mainTemplate.json, and no workflow in `.github/workflows/` renders/publishes one.
- `docs/fiab/operations/upgrade-migration.md:54–55` — references `fiab-migrate snapshot` / `fiab-migrate execute --target il5`; no `fiab-migrate` artifact exists anywhere in the repo.
- `docs/fiab/deployment/quickstart.md` prerequisites also list "Power BI Premium P1 or F-SKU capacity in your tenant" as a hard requirement — Fabric-family-first messaging in the very first onboarding doc, contrary to `.claude/rules/no-fabric-dependency.md` (Azure-native is the default; Power BI counts as Fabric-family).
The proven path (per `.claude/rules/no-vaporware.md` acceptance test and live deploys) is `az deployment sub create -f platform/fiab/bicep/main.bicep -p params/…` + the post-deploy bootstrap workflow — which is not what the quickstart says.
**Must be in v1:** rewrite quickstart around the real, exercised deploy path; delete or implement deploy-button and fiab-migrate content; remove the Power BI prerequisite (make it the opt-in it actually is). Effort M.

### F2 — HIGH — DR documentation contradicts the deployed infrastructure; no tested restore runbook
`docs/fiab/operations/disaster-recovery.md` claims:
- line 25: "ADLS Gen2 | 15 min | 0 (RA-GRS = immediately readable in secondary) | GRS / RA-GRS within boundary region pair"
- line 35: "Loom Copilot agents | Cosmos backup | 1 h | Cosmos geo-replication"
- lines 53–58: DR drill via `azd env new` / `azd up` (see F1 — azd is scaffolded)

Deployed reality:
- Lake storage is `Standard_ZRS` (`platform/fiab/bicep/modules/landing-zone/storage.bicep:52`) — zonal, not geo.
- Admin-plane storage accounts are `Standard_LRS` (`admin-plane/main.bicep:1717,1781,1840`; catalog.bicep:338; others), with main.bicep:1833 commenting "geo-redundancy off".
- Both Cosmos accounts are single-region, `isZoneRedundant: false`, `enableAutomaticFailover: false` (`admin-plane/loom-console-cosmos.bicep:71–73`, `landing-zone/cosmos.bicep:69–71`) — serverless constraint acknowledged in comments. Backup is Continuous7Days PITR, which does not survive a regional outage on a single-region account.
- No runbook exercises a Cosmos point-in-time restore of the control plane (the entire workspace/item/permission metadata store). `docs/runbooks/dr-drill.md` exists but the doc's mechanics reference azd.
**Must be in v1:** make the DR doc truthful (state single-region + PITR + redeploy-from-git posture and its real RPO/RTO), and write + execute one Cosmos PITR restore runbook. Geo-DR itself can wait. Effort M.

### F3 — HIGH — Upgrade path is image-only; no versioned schema/infra migration mechanism
`docs/fiab/in-product-update-path.md:85–89`: the updater "PATCHes each app's image" — that is the entire upgrade. When a release adds env vars, role assignments, or bicep-provisioned containers (the norm — see `no-vaporware.md` bicep-sync rule §2/§3), an image-rolled tenant will not have them; features will hit their honest gates or fail. Cosmos containers partially self-heal (`loom-console-cosmos.bicep:86–89`: "the Console's ensure() createIfNotExists is the idempotent fallback"), but env/RBAC/infra do not. There is no per-release migration manifest, no "this release requires a bicep re-deploy" gate in the apply preflight, and no min-infra-version check. Cosmos *document* shape changes are handled ad hoc by tolerant readers (e.g. `app/api/workspaces/[id]/items/route.ts:49–51` legacy `state.certified` fallback) — workable, but uncontracted.
**Must be in v1:** a release-compat manifest consumed by the `/admin/updates` preflight (min bicep version / required env list, diffed against the running app's env), surfacing "this update needs an infra re-deploy first" as another honest gate. Effort M.

### F4 — HIGH — `/api/feedback` is unauthenticated with no server-side rate limiting, holding a GitHub token
`app/api/feedback/route.ts:47–56`: `POST` parses JSON and proceeds — no `getSession()` check (every other route family is session-gated; this one deliberately is not so pre-login errors report). There is no server-side throttle; the only caps are client-side (`error-boundary.tsx:16` `MAX_AUTO_REPORTS_PER_SESSION = 5`, trivially bypassed with curl). With `LOOM_FEEDBACK_GITHUB_TOKEN` set, any unauthenticated internet client that can reach the console origin can mint unlimited GitHub issues in the upstream repo and exhaust the token's rate limit; without the token it can still spam logs. This is a public-release abuse vector on every deployed tenant.
**Must be in v1:** per-IP/per-tenant server-side rate limit + payload fingerprint dedupe on the server; optionally require a session for `kind: bug|feature` and keep only `auto-error` anonymous but heavily throttled. Effort S.

### F5 — MEDIUM/HIGH — Accessibility baseline claimed but never tested
`apps/fiab-console/package.json:56` declares `"@axe-core/playwright": "^4.10.0"` and `README.md:24` claims "Playwright E2E + Vitest unit + **axe-core accessibility**" — but a repo-wide grep finds **zero** `AxeBuilder`/axe usages in `e2e/`, `tests/`, or anywhere else. No WCAG/508 statement, no a11y CI gate. Fluent v9 gives a decent baseline and `web3-ui.md` mandates keyboard navigability, but nothing verifies it. For a public product aimed at Gov/public-sector (Section 508 / VPAT expectations) this is a credibility and procurement problem, and the README claim itself violates the no-scaffold-claims rule.
**Must be in v1:** wire axe scans over the top ~20 surfaces in the existing Playwright harness, fix critical violations, correct the README. VPAT/full WCAG audit can wait. Effort M.

### F6 — MEDIUM — No pagination/virtualization contract on core list APIs (1,000-item workspaces)
`app/api/workspaces/[id]/items/route.ts:35–40`: `SELECT * FROM c WHERE c.workspaceId = @w ORDER BY c.createdAt DESC` → `.fetchAll()` returning **full item documents** (including `state`) as "a bare array" (comment line 46). No `maxItemCount`, no continuation token, no field projection. Virtualization exists in isolated spots (`lib/editors/lakehouse/lakehouse-editor-shell.tsx`) but not on the item-list surfaces. A 1,000-item workspace returns everything on every list render; payload grows with item `state` size.
**v1-or-early-v1.x:** add server-side projection (drop `state` from list responses) now — cheap and non-breaking; add continuation-token pagination as an additive API mode before external clients freeze on the bare-array shape. Effort M.

### F7 — MEDIUM — Branding is split three ways (CSA-in-a-Box / CSA Loom / FiaB), plus a trademark consideration
- Repo + docs site: "CSA-in-a-Box: Cloud-Scale Analytics Platform" (`README.md:1`).
- Product UI: "CSA Loom Console" (`apps/fiab-console/app/layout.tsx:8`; wordmark `lib/components/app-shell.tsx:169`).
- Legacy brand in shipping user-visible text: `lib/apps/content-bundles/app-rag-builder.ts:71` — "the Fabric-in-a-Box (FiaB) reference deployment" (rendered to users in the bundle description); 14 docs files still say FiaB/Fabric-in-a-Box (e.g. `docs/fiab/index.md`, `docs/fiab/whitepaper.md`); code paths (`apps/fiab-console`, `platform/fiab`, `deploy-fiab-*.yml`) carry the old name (fine internally, confusing in public docs URLs).
- Trademark: any public use of "Fabric-in-a-Box" trades on Microsoft's "Fabric" mark; the docs also present Loom as a "Microsoft Fabric parity layer" (`platform/fiab/azd/azure.yaml:10`) — fine as comparison, risky as naming.
**v1:** one name in every user-visible string + docs landing pages; keep internal paths. Effort M (strings S, docs sweep M).

### F8 — MEDIUM — No OSS license inventory / THIRD-PARTY-NOTICES; no license gate in CI (GPL scan is clean)
Root `LICENSE` is MIT. A full scan of the console's `node_modules/.pnpm` (3,500+ packages) found **no GPL/AGPL/SSPL** — copyleft exposure is limited to weak-copyleft: `sharp`/libvips `LGPL-3.0-or-later` (Next image optimization, dynamically linked — compliant but attribution-required), `elkjs` `EPL-2.0`, 4× `MPL-2.0`, 3× `CC-BY-4.0`, 2 UNKNOWN. There is no THIRD-PARTY-NOTICES/attribution file shipped in the public container images and no license-check step in any workflow (dependabot + CodeQL exist; license scanning does not).
**v1:** generate THIRD-PARTY-NOTICES at image build (license-checker/oss-attribution) + add an allowlist CI gate so a future GPL transitive dep fails PR. Effort S.

### F9 — MEDIUM — No Azure-quota pre-flight in the setup/deploy funnel
The setup wizard/deploy route pre-flights permissions (cross-sub Contributor 403 gate, PR #1428) but nothing checks compute/Databricks/ADX/VM quota — the exact failure that blocked the operator's own multi-sub provisioning (DMLZ VM quota=0) and that quickstart.md tells users to check *manually* (`az vm list-usage`). Grep of `lib/setup`, `lib/panes/setup-wizard.tsx`, `app/api/setup` finds no quota usage.
**v1:** add `Microsoft.Capacity`/usages checks for the SKUs the selected topology will deploy, surfaced as honest pre-deploy gates in the wizard. Effort M.

### F10 — MEDIUM — Phone-home telemetry lacks an operator-facing disclosure doc and admin toggle
Auto error reports and feedback forward to the **maintainer's** GitHub (`app/api/feedback/route.ts:27–28` defaults `fgarofalo56/csa-inabox`) with a hashed tenant ID whenever `LOOM_FEEDBACK_GITHUB_TOKEN` is set. Redaction is real (`lib/feedback/redaction.ts`, re-applied server-side) and the dialog shows a privacy block — good. But: the only docs hit for `LOOM_FEEDBACK_GITHUB_TOKEN` is an incidental line in `docs/fiab/parity/admin-portal.md`; there is no "what leaves your tenant" page, and no `/admin/tenant-settings` switch to disable **auto-error** forwarding independent of the token (an operator who wants the widget but not automatic crash export has no knob). Server telemetry (`app-insights.ts:11` default-on, opt-out) stays in-tenant — fine.
**v1:** one docs page (data collected, destination, redaction rules, how to disable) + an admin toggle for auto-error forwarding. Effort S.

### F11 — MEDIUM — Update path never rehearsed end-to-end; ghcr publish requires undone manual step
`docs/fiab/in-product-update-path.md:137–146` is honest: the apply flow "works the moment the public images exist," but the first `publish-ghcr-images` run + the one-time make-packages-public step have not happened, so every deployed tenant's `/admin/updates` currently gates on `images-not-published`. For a public v1, the headline "self-updating" capability must have been exercised at least once (publish → flip public → in-product roll on a live tenant).
**v1:** run the rehearsal as a release gate. Effort S (process).

### F12 — LOW — i18n absent (acceptable if declared)
No i18n framework in `package.json` (no next-intl/react-intl/i18next); all UI strings hard-coded English; scattered `toLocaleString()` gives locale-dependent number/date formats inside English text. For v1 declare "English (en-US) only" in docs; defer localization. Effort S (declaration only).

### F13 — LOW — Multi-region/HA posture is fine for v1 but must be stated, not overstated
Within-region HA is real: ACA env `zoneRedundant: true` (`container-platform.bicep:67`), console `minReplicas: 2` (`admin-plane/main.bicep:2383`), ZRS lake. Cross-region is redeploy-from-git by design. That is a defensible v1 posture **once F2's doc corrections land**; add a one-paragraph "supported availability model" statement to the deployment docs. Effort S.

---

## What v1 MUST have vs can wait

**MUST (release-blocking):** F1 (working quickstart), F2 (truthful DR + restore runbook), F3 (update compat gate), F4 (feedback abuse fix), F5 (axe baseline + fix README claim), F11 (one update rehearsal), F8 (NOTICES file — cheap legal hygiene), F10 (disclosure page).

**SHOULD (v1.x):** F6 (pagination contract), F7 (brand sweep), F9 (quota pre-flight).

**CAN WAIT:** i18n (F12), geo-DR/multi-region active-active, VPAT, license-gate automation beyond the NOTICES file.
