# Release audit — dimension: docs-help

**Scope:** Learning Hub (`apps/fiab-console/lib/learn` + `app/learn`), LearnPopover / in-product
contextual help coverage, `docs/fiab` user-facing docs vs the shipped feature set, and the
README / getting-started path for a NEW external operator.
**Audited:** 2026-07-02, worktree `fix-ui-wave2-a`, branch `feat/loom-marketplace`.
**Method:** file-level reads + cross-checks (registry ↔ files on disk ↔ mkdocs nav ↔ workflows).
Every claim below has a file:line I actually read.

---

## Inventory — what in-product help actually exists (the good news)

The help system is genuinely extensive and mostly CI-guarded:

| Surface | Count | Evidence |
|---|---|---|
| Numbered end-to-end tutorials | 9 (`01-first-workspace` … `09-tenant-topology`) | `lib/learn/content.ts:818-848`; files exist at `docs/fiab/tutorials/0*.md` |
| Core-surface tutorials | 8 (lakehouse-shortcuts, warehouse-sql, notebooks-spark, kql-RTI, pipelines, purview, cosmos, deployment/BYO) | `lib/components/learn/core-surface-tutorials.ts:35-40`; files in `docs/fiab/learn/` |
| Per-editor Loom guides | **118 doc slugs; 118 files on disk; 117/117 unique catalog item types covered (100%)** | `EDITOR_DOC_SLUGS` at `content.ts:89-122`; verified slug↔file diff = zero mismatches; catalog slugs from `lib/catalog/item-types/*.ts` (117 unique) all present |
| Real-world use cases | 40 (23 commercial/federal + 5 sovereign + 6 accelerators + 6 industry), each deep-linking to its own authored walkthrough; 16 with one-click "Install app" wiring | `content.ts:727-775` (`USE_CASES`), install-wiring invariant noted at `content.ts:718-726` |
| Loom service guides | 3 (activator, mirroring, direct-lake shim) | `content.ts:851-863` |
| Reference topics | 4 (what-is, architecture, portal architecture, parity matrix) | `content.ts:866-881` |
| Item-editor Learn drawer | every `/items/[type]/[id]` page via `getLearn()` | `lib/components/item-side-panel.tsx:73,264` |
| Global Help Copilot | docs-grounded RAG chat on every page (Sparkle / Ctrl+/), 5 read-only tools, citations | `docs/fiab/help-copilot/index.md:1-20`; `app/api/help-copilot/chat/route.ts`; mounted through `lib/components/copilot-pane.tsx:7,50-51` in `app-shell.tsx` |
| Learning Hub Copilot | dedicated copilot on /learn | `app/learn/page.tsx:58,546,552` |
| Link-integrity CI | every Learn card's primary link asserted to resolve to a real doc on disk; backlog kept honest | `lib/learn/__tests__/loom-docs-links.test.ts:1-21` |
| Loom runbooks (troubleshooting) | 23 under `docs/fiab/runbooks/` (deploy-failure, first-deploy, secrets-bootstrap, mirroring-cdc-lag, …), 18 nav refs | `ls docs/fiab/runbooks`; `mkdocs.yml` grep `fiab/runbooks` → 18 |
| Compliance statements | NIST 800-53 rev5, CMMC 2.0 L2, DoD IL5, HIPAA, ITAR, GCC/GCC-High/Commercial boundary docs; 11 nav refs | `docs/fiab/compliance/` listing |
| Editor tutorial quality | auto-generated from the live UAT harness, dated verification + real screenshots | `docs/fiab/tutorials/editor-lakehouse.md:1-4` ("verified working against a live console … 2026-07-01") |
| Repo hygiene files | LICENSE, SECURITY.md, CONTRIBUTING.md, SUPPORT.md, CODE_OF_CONDUCT.md all present | repo root `ls` |

So the **item-level** docs story is near-A-grade. The public-release problems are at the
**entry path** (README / quickstart / deploy button), **publication hygiene** (internal + live-estate
artifacts on the public site), and **staleness** at the edges.

---

## Findings

### F1 (CRITICAL) — Live estate identifiers + operator PII published on the public docs site
The docs site auto-publishes to GitHub Pages on every main push (`.github/workflows/docs.yml:1-6`,
`pages: write`). The published corpus includes the operator's **live deployment coordinates**:

- Live subscription IDs: `docs/fiab/audit/gated-services-default-on.md:10-13` ("sub
  `<subscription-id>` … console UAMI principalId `41d32562-f864-…`");
  `docs/fiab/design/full-deployment-and-byo.md:121-122` (DLZ `363ef5d1-…` + DMLZ sub IDs);
  `docs/fiab/design/data-api-builder-ui.md:279`.
- Live workspace GUID under test: `docs/fiab/audit/live-e2e-every-item-and-app-202606160304.md:4`.
- **98 occurrences** of live Front Door hostnames (`<hash>` / `<hash>` …azurefd.net)
  across `docs/fiab` (e.g. `docs/fiab/agent-unattended-access.md:104,271`,
  `docs/fiab/audit/live-ui-sweep-2026-06-21.md:10`).
- Operator personal email in a nav-listed page: `docs/fiab/parity-gap/_top-level-nav-validation-2026-05-26.md:20`
  ("Authed as: Platform Admin (UAT) (admin@contoso.gov)") — and that page IS in nav
  (`mkdocs.yml:1704`).
- The audit pages also narrate **live security posture and RBAC gaps** ("granted the console UAMI
  *Azure Event Hubs Data Owner* + Contributor…", `docs/fiab/audit/day-one-validation-matrix.md:36`).

`exclude_docs` only removes `fiab/archive/`, `prp/`, and a few learn paths (`mkdocs.yml:46-62`) —
`fiab/audit/`, `fiab/design/`, `fiab/parity-gap/` all build and are searchable. Subscription GUIDs
aren't secrets by themselves, but publishing live sub+RG+UAMI+hostname+workspace coordinates plus
open findings against that estate is exactly what an attacker wants for target reconnaissance, and
it embarrasses a public release. **Fix:** extend `exclude_docs` with `fiab/audit/`, `fiab/design/`,
`fiab/parity-gap/`, `fiab/agent-unattended-access.md`, plus a redaction sweep (GUID/hostname/email
grep) as a CI guard (there is already a `hygiene-guard.yml` to hang it on).

### F2 (CRITICAL) — "Deploy to Azure" button path is documented vaporware
`docs/fiab/deployment/deploy-button.md:7-8` instructs evaluators: "Open the csa-inabox README →
Click the **Deploy to Azure** button under the CSA Loom section". Reality:
- Root `README.md` has **no CSA Loom section and no Deploy to Azure button** — the only "Loom"
  match in the 504-line README is the legal disclaimer (`README.md:5`); grep for
  `Deploy to Azure|Microsoft.Template` in README returns nothing.
- The doc claims "The ARM template is `mainTemplate.json` — compiled … and published to a public
  GitHub Pages URL" (`deploy-button.md:30-32`) — no compiled template exists in-repo
  (`ls platform/fiab/bicep/*.json` → no file) and no workflow publishes one.
- The path is *promoted* from the deployment index (`docs/fiab/deployment/index.md:25`) and the
  Loom landing page (`docs/fiab/index.md:47` "azd up or the 'Deploy to Azure' button stands the
  whole platform"). An evaluator's very first click dead-ends. Per `.claude/rules/no-vaporware.md`
  this is a shipped doc describing a non-existent capability.

### F3 (HIGH) — Quick Start (60 minutes) azd path cannot work as written
`docs/fiab/deployment/quickstart.md` is the canonical "git clone → console URL" guide, but:
- Step 1 says `cd csa-inabox/platform/fiab` (quickstart.md:24-27) and Step 3 runs `azd init -t .`
  (quickstart.md:50) — there is **no `azure.yaml` in `platform/fiab/`**; it lives at
  `platform/fiab/azd/azure.yaml` (verified `ls`). `azd-cli.md:31-33` also draws an
  `azd/infra → ../bicep` symlink that does not exist (`platform/fiab/azd/` contains only
  `azure.yaml`).
- `platform/fiab/azd/azure.yaml:3` is itself headed "**Status: SCAFFOLDED**" and mislabels
  services: `setup-orchestrator` declared `language: csharp` (azure.yaml:26-28) while the app is
  Python (`apps/fiab-setup-orchestrator/pyproject.toml` exists; its README describes a FastAPI
  service, `apps/fiab-setup-orchestrator/README.md:9-11`).
- Step 3's interactive prompts ("Boundary: Commercial", "Deployment mode: single-sub",
  quickstart.md:53-60) are not things `azd init` prompts; the file's own comment says these are
  `azd env set` variables (azure.yaml:66-73).
The real, proven deploy path in this repo is `az deployment sub create -f platform/fiab/bicep/main.bicep`
+ `csa-loom-post-deploy-bootstrap.yml` (per `.claude/rules/no-vaporware.md` acceptance test and the
existing `deploy-fiab-commercial.yml`). The primary public install guide must be rewritten around
the path that is actually exercised, or the azd project must be made real and CI-tested.

### F4 (HIGH) — The console's own README declares the product "SCAFFOLDED"
`apps/fiab-console/README.md:10-13`: "## Status / **SCAFFOLDED.** Real implementation per PRP-03…
v1 ships 12 panes; v1.1 adds 4 more." The console actually ships 117 item-type editors across 90
routed pages (`docs/fiab/index.md:6-8` says so; `find app -name page.tsx` = 90). Any external
developer landing in the app directory reads that the flagship product is an empty scaffold.
Same disease in `platform/fiab/azd/azure.yaml:3-5`.

### F5 (HIGH) — Root README does not introduce CSA Loom at all; new-operator landing path points at the old platform
The root `README.md` (public front door) presents only the original CSA-in-a-Box Synapse/Databricks
reference stack; the TOC (`README.md:40-53`) has no Loom entry, and Quick Start (`README.md:245-249`)
routes to `docs/QUICKSTART.md` (old-platform dbt/Synapse setup). The repo's headline product —
the Loom console, 117 editors, marketplace, copilots — is invisible from the README, while
`deploy-button.md:7` claims the README has a CSA Loom section. A new external operator has no
discoverable path from README → Loom deployment quickstart (`docs/fiab/deployment/quickstart.md`).

### F6 (HIGH) — Internal working artifacts are in the PUBLIC site nav
`mkdocs.yml` "Audits, Inventories & Version History" section:
- `mkdocs.yml:2032` — **"Next-session kickoff": fiab/next-session-kickoff.md** — an internal agent
  session prompt ("Fabric UI rebuild - fresh session kickoff", `docs/fiab/next-session-kickoff.md:1`).
- `mkdocs.yml:2026` — "UAT Report (Iteration 1)" and `mkdocs.yml:1701-1705` — five dated
  2026-05-26 parity-gap validation dumps, five weeks stale, presented in public nav.
- Additionally built-but-not-nav'd (still published + searchable): `fiab/no-cuts-sweep-v2.md`
  (internal policy reversal narrative with PR numbers, lines 1-10), `fiab/loom-feature-backlog.md`,
  `fiab/fabric-parity-tasks.json` (raw JSON copied verbatim by mkdocs), `fiab/audit/*` (12 files),
  `fiab/design/*`. Only `fiab/archive/` and `prp/` are excluded (`mkdocs.yml:46-62`).
These read as engineering diary, admit defects in shipped features, and (per F1) carry live
coordinates. Move to `fiab/archive/` or extend `exclude_docs`.

### F7 (MEDIUM) — Release notes effectively dead: one entry, 5+ weeks old, linked as "Recent"
`docs/fiab/releases/` contains exactly one file (`2026-05-27-apps-bundles-and-wiring-sweep.md`);
the Loom landing page links it as "Recent release notes →" (`docs/fiab/index.md:20`) and the nav
"Releases" group has the single stale entry (`mkdocs.yml:2027-2028`). Meanwhile the product moved
~100 console revisions (rev 82 → 179) since. Mitigation exists — root `CHANGELOG.md` +
release-please + the in-console `/admin/updates` page which renders real upstream GitHub releases
(`app/admin/updates/page.tsx:182-201`) — but the public docs site's release story is stale.
Either generate `docs/fiab/releases/` entries per release-please tag or point the landing link at
the GitHub releases page.

### F8 (MEDIUM) — Key day-one admin docs exist but are NOT in the site nav
`docs/fiab/v3-tenant-bootstrap.md` (the one-time tenant bootstrap the in-app honest-gates
reference, per its own header lines 1-8) and `docs/fiab/tenant-admin-walkthroughs.md` (the three
optional tenant grants, lines 1-18) have **zero nav references** (grep `fiab/tenant-admin-walkthroughs`
/ `fiab/v3-tenant-bootstrap` in `mkdocs.yml` → 0). They're reachable only by deep link or search.
For a public release the admin guide chain (deploy → bootstrap → tenant grants) should be a
first-class nav section.

### F9 (MEDIUM) — LearnPopover contextual help covers only 6 of ~28 admin pages; zero on governance/catalog suites
Grep `LearnPopover` across the console → 6 admin pages only: capacity(5), audit-logs(4),
env-config(2), scaling(4), permissions(4), security(6) (`app/admin/*/page.tsx`), plus the shared
component + test. `SectionExplainer` adds ~11 more files (attribute-groups, batch-labeling,
classifications, domains, sensitivity-labels, embed-codes/org-visuals panes). But
`app/governance/**` (18 pages), `app/catalog/**` (7), `app/marketplace`, `app/monitor`,
`app/onelake`, `app/connections` have **zero** LearnPopover/SectionExplainer/learnMoreHref hits
(grep verified). Mitigated by the global Help Copilot and the item-editor Learn drawer, so this is
consistency polish, not a hole — but the wave-9 "admin LearnPopovers" pattern stopped at 6 pages.

### F10 (MEDIUM) — `docs/fiab/workloads/*` editor references drifted from the shipped product
Example `docs/fiab/workloads/lakehouse.md`: cites editor file
`lib/editors/lakehouse-editor.tsx` (line 5 — pre-barrel-split path; the editor now lives under
`lib/editors/lakehouse/lakehouse-editor-shell.tsx`, verified on disk) and states "Shortcuts pane is
gated honestly **until the Fabric REST shortcut endpoint is wired**" (lines 15-17) and "Manage
OneLake security | Gated — Fabric REST shortcut/role assignment route not wired" (line 26) — but
`lakehouse-shortcut` is now a full Azure-native catalog item with its own authored editor doc
(`content.ts:114`; `docs/fiab/tutorials/editor-lakehouse-shortcut.md` exists), and a Fabric-REST
dependency would violate `.claude/rules/no-fabric-dependency.md` anyway. 29 workload docs are in
nav (`mkdocs.yml:1455-1463`); they need a currency sweep or a banner deferring to the
auto-generated, UAT-dated `fiab/tutorials/editor-*.md` guides.

### F11 (LOW) — 33 of 118 Learning Hub editor cards reference a thumbnail image that doesn't exist
`loomThumbUrl()` (`content.ts:76-79`) returns `img/editor-<slug>-1.png` for **every** slug in
`EDITOR_DOC_SLUGS`, but only 85 `-1.png` files exist in `docs/fiab/tutorials/img/`. Missing set =
the wave-9 + backlog-drain slugs (workshop-app, slate-app, ontology-sdk, aip-logic,
release-environment, health-check, event-hubs-namespace, service-bus-namespace, event-grid-topic,
lakehouse-shortcut, airflow-job, automl, azure-cosmos-account, data-api-builder, data-marketplace,
datamart, event-schema-set, integration-runtime, linked-service, logic-app, mapping-dataflow,
materialized-lake-view, mirrored-databricks, mounted-adf, postgres-flexible-server, rayfin-app,
spark-environment, sql-analytics-endpoint, sql-database, stream-analytics-job, synapse-notebook,
tapestry, workspace-monitor). The card component falls back gracefully on img error
(`lib/components/learn/learn-topic-card.tsx:145-163` `imgOk` state), so impact is a 404 fetch +
brief flash, not a broken UI. Fix: gate `loomThumbUrl` on an actual-thumbs set, or capture the 33
missing screenshots via `csa-loom-tutorial-capture.yml`.

### F12 (LOW) — Stale counts/comments in the Learn registry
`content.ts:8` — "every one of the **90** catalog item types renders real guidance" — actual is
117 unique catalog slugs (`docs/fiab/index.md:6` itself says 117). Cosmetic but it's the file's
authoritative header comment.

### F13 (LOW) — `usql-job` doc + registry entry orphaned from the catalog
`usql-job` is in `EDITOR_DOC_SLUGS` (`content.ts:108`) and the legacy REGISTRY
(`content.ts:640-643`) and has a published doc (`docs/fiab/tutorials/editor-usql-job.md` in the
118-file set), but is **not** a catalog item type (slug diff: "doc slugs not in catalog:
['usql-job']"). The Learning Hub won't list it (loop is over `FABRIC_ITEM_TYPES`,
`content.ts:916`), so a published tutorial documents an item users cannot create — remove the doc
+ slug or restore the item.

### F14 (INFO/positive) — Things a release reviewer will ask about that ARE covered
- Install guide: yes (`docs/fiab/deployment/` — index, quickstart, azd, pipelines x4,
  commercial/gcc/gcc-high, multi-sub, upgrade) — but see F2/F3 for accuracy.
- Troubleshooting: yes — 23 Loom runbooks in nav + old-platform `docs/TROUBLESHOOTING.md`.
- Security/compliance statement: yes — `docs/fiab/compliance/` (NIST 800-53 rev5, CMMC 2.0 L2,
  DoD IL5, HIPAA, ITAR, boundary matrix) + `docs/fiab/v3-security-hardening.md` + `docs/fiab/admin/security/`.
- Admin guide: partial — `docs/fiab/admin/` (feature-rbac, network-private-dns, scaling, security)
  + tenant walkthroughs (not in nav, F8).
- Docs link integrity: CI-tested (`loom-docs-links.test.ts`) + `link-check.yml` workflow.
- Learn coverage per item: 117/117 with dual Loom-doc/MS-Learn links and honest
  "not yet authored" fallback (`content.ts:11-16`).

---

## Bottom line

The in-product help system (Learning Hub with ~181 topics, 117/117 editor guides that are
UAT-verified with screenshots, a docs-grounded Help Copilot on every page, CI link-integrity) is
among the strongest I've audited and is release-ready. What is NOT release-ready is the
public-facing shell around it: the README ignores the product, the two headline install paths
(60-minute quickstart via azd; Deploy-to-Azure button) are respectively broken-as-written and
non-existent, the flagship app README says "SCAFFOLDED", and the public docs site publishes
internal audit diaries carrying live subscription/UAMI/hostname/email coordinates. Fix F1-F6 before
any public release; F7-F13 are fast follows.
