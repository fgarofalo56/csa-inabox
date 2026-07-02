# Dimension: repo-hygiene (public-GitHub-release readiness)

> Produced by the repo-hygiene audit agent, 2026-07-02. Scope: tracked files on
> branch `feat/loom-marketplace`; categories 1–2 (identifiers, secrets)
> exhaustive, 3–4 (legal, structure) sampled.

## Headline

**No live credentials, keys, or secrets are exposed — not in the tree, not in
git history.** The dominant problem is operator-specific Azure identifiers
(real subscription GUIDs, UAMI principal/client IDs, a deploy service-principal
appId, operator OIDs) hardcoded across ~46 tracked files, including
*deployable artifacts* (Grafana dashboards, a bicep module) that would ship
broken/misleading defaults to customers and leak the operator's FedCiv estate
topology. Governance files and `.gitignore` are in good shape.

Severity note: subscription IDs, tenant/principal object IDs, and SP appIds are
**not credentials** (they cannot authenticate). This is topology-hygiene +
wrong-defaults, not a key-rotation emergency.

## MUST-FIX BEFORE PUBLIC

### 1. Real operator subscription GUIDs hardcoded (46 files, 4 distinct real subs)

Real subs: `e093f4fd-5047-4ee4-968d-a56942c665f3` (DMLZ/console),
`363ef5d1-0e77-4594-a530-f51af23dbf8c` (bureau DLZ),
`ca2b3e6b-f892-4c57-b9d8-b64e5799f9ea` (2nd demo),
`a60a2fdd-c133-4845-9beb-31f470bf3ef5` (ALZ/connectivity hub).

Worst offenders are shipped/deployable artifacts:

- **Grafana dashboards** `platform/fiab/grafana/loom-governance.json`,
  `loom-usage.json` — real subs baked into datasource queries AND full resource
  paths (e.g. loom-governance.json:96 full `/subscriptions/e093f4fd-...` LAW
  path). A customer importing these gets dashboards pointed at the operator's
  sub. Blank/parameterize.
- **Bicep module** `platform/fiab/bicep/modules/ai/foundry-project.bicep` —
  real sub in deployable IaC. Parameterize.
- **GitHub workflows (9)** — real subs as input DEFAULTS:
  `csa-loom-post-deploy-bootstrap.yml`, `csa-loom-grant-synapse-rbac.yml`,
  `csa-loom-grant-delta-sharing.yml`, `csa-loom-attempt-interactive-grants.yml`,
  `csa-loom-shir-idle-stop.yml`, `csa-loom-synapse-spark-fix.yml`,
  `csa-loom-tutorial-capture.yml`, `csa-loom-validate.yml`,
  `csa-loom-wire-navigators.yml`. (Operator-internal ops automation — arguably
  should not ship at all.)
- **Bicep param comments** `platform/fiab/bicep/params/tenant-dmlz.bicepparam`,
  `dlz-attach.bicepparam` — all four real subs enumerated in usage comments
  (lines 11–29). Genericize.
- **Scripts** (9 under `scripts/csa-loom/`), **~10 docs/fiab files**
  (inc. archive/audit/design), and **two test files**
  (`apps/fiab-console/lib/setup/__tests__/deploy-preflight.test.ts`,
  `lib/azure/__tests__/loom-subscriptions.test.ts`) that assert against the
  live estate. Genericize to fake GUIDs.

### 2. Real UAMI + service-principal + operator OIDs (31 files)

- `.harness/config.json:15` — densest leak: real sub + RG names
  (`rg-csa-loom-admin-eastus2`, `rg-csa-loom-dlz-single-eastus2`), LAW name,
  Console UAMI principal `e61f3eb3-c646-4183-8198-4c4a34cd9a01` / client
  `c6272de5-3c4e-4b72-8b57-71b2e950209b`, deploy SP `limitlessdata_deploy`
  appId `95ca491e-f841-43ba-93f2-3315804f55e7`. Remove `.harness/` from the
  public repo.
- Same UAMI principal/client as workflow defaults in
  `csa-loom-post-deploy-bootstrap.yml:67-68`,
  `csa-loom-attempt-interactive-grants.yml:16-18`.
- Operator OIDs hardcoded: Synapse initial admin
  `b9c3cc65-522e-49c9-ad02-914676aa5a6b`
  (`csa-loom-post-deploy-bootstrap.yml:111`); `UAT_OID` default
  `866a2e12-0fee-4c99-923c-7cdfd61e08cd` (`apps/fiab-console/e2e/_lib/uat.ts:22`);
  grant-rbac defaults `85e5d083-...`, `f4f25dd9-...`.

Blank to empty/parameterized inputs (mirror the existing
`param primaryContact string = ''` pattern in `deploy/bicep/DLZ/main.bicep`).

## SHOULD-FIX

- **Internal-process dirs tracked** — leak planning/agent/audit context:
  `PRPs/` (61 files), `.claude/` (27), `docs/fiab/prp/` (21),
  `docs/fiab/audit/` (12), `dev-loop/` (9), `.harness/` (4), `temp/audit/` (2 —
  tracked despite `temp/` being gitignored). `docs/fiab/audit/*` and
  `.claude/migrated-archon-tasks.md` reference live subs/internal findings.
  Prune/relocate before public.
- **Build artifacts committed**:
  `apps/fiab-console/test-results/uat/screenshots/*.png` (dozens) — tracked
  test output; at least one carries a real sub. Gitignore, don't ship.
- **Vendored Microsoft Azure icons** `apps/fiab-console/public/azure-icons/*.png`
  (25). Microsoft's Azure icon terms restrict redistribution/modification —
  bundling in a public repo is a gray area. Verify terms or reference rather
  than vendor. (`public/brand/loom-logo*.png` are the project's own — fine.)
- **Content bundles cite a personal source repo**:
  `lib/apps/content-bundles/app-supercharge-*.ts` derive notebooks from
  `github.com/fgarofalo56/Suppercharge_Microsoft_Fabric`. Confirm public +
  license permits redistribution; else licensing gap.
- **Dependency license scan not performed** — run `license-checker` /
  `pnpm licenses` for GPL/AGPL transitives before public (no obvious copyleft
  by name in 32 deps / 17 devDeps).
- **LICENSE** = MIT, `Copyright (c) 2023 Frank Garofalo` (personal) — valid;
  consider org attribution if org-owned.
- **CODEOWNERS** routes everything to `@fgarofalo56`; personal GitHub org refs
  in `apps/*/Dockerfile` LABELs and
  `app/api/catalog/domains/route.ts:61` → update if the repo moves to an org.

## FINE AS-IS (verified)

- No secrets in tree or history: all `AccountKey=` hits are deploy-time
  `listKeys()` bicep patterns or UI hint text; doc passwords are placeholders;
  `git log -S` probes clean; no `.env`/`.pem`/`.pfx`/`.key` ever committed. The
  one `BEGIN PRIVATE KEY` (`lib/components/onelake/shortcut-wizard.tsx`) is
  placeholder text in a credential-paste UI.
- Deployable IaC clean of operator resource names — derives via
  `uniqueString(resourceGroup().id)`. No hardcoded tenantId / azurefd / acr /
  blob hostnames in source.
- Azure built-in role GUIDs + Graph permission IDs are public constants — not
  findings. Test-fixture GUIDs are obvious placeholders.
- Root-level portal screenshots are gitignored (confirmed `git check-ignore`).
- Prior `PrimaryContact: 'frgarofa'` finding already remediated in
  `deploy/bicep/DLZ/main.bicep`.
- Governance files present: LICENSE, README, SECURITY.md, CONTRIBUTING.md,
  CODE_OF_CONDUCT.md, MAINTAINERS.md, SUPPORT.md, `.gitleaks.toml`,
  `.pre-commit-config.yaml`, `.checkov.yaml`, `.env.example`.

## Execution status (2026-07-02, main-loop)

**TREE FULLY SCRUBBED — zero real identifiers in any shippable tracked file
(verified repo-wide).** Done: the hygiene-scrub agent's 40-file pass (subs +
UAMI/OID + admin-group env-read) + main-loop follow-ups: 2 leftover docs
(copilot-chat/DEPLOYMENT.md, .claude/migrated-archon-tasks.md), the 12 console
test files (8 auth files chained through `LOOM_AUTOMATION_*` runtime env before
generic placeholders + personal email→`uat@example.invalid`; 4 unit tests real
GUIDs→distinct placeholder GUIDs, assertions intact), and 2 more tracked docs
(archive/v2.2-done.md, loom-mirror-followups-plan.md). `.gitignore` covers
`.harness/`, `dev-loop/`, `temp/`, `docs/fiab/{prp,audit,parity-gap,design}/`,
`test-results/`, `.playwright-mcp/`. All edits parse-clean.

**STILL PENDING (needs user decision — history is NOT rewritten):** the 12
identifiers remain in PRIOR COMMITS. Recommended: fresh orphan-branch squashed
snapshot from the cleaned tree (internal dirs + historical identifiers never
carry over). Alternative: `git rm -r --cached` the internal dirs + `git
filter-repo` + force-push. Not run — awaiting the user's go.

## Recommended remediation order

1. Parameterize/blank the 4 real subs + UAMI/SP/OID GUIDs (deployable artifacts
   first: Grafana JSON, foundry-project.bicep, workflow defaults, bicepparam
   comments).
2. Delete `.harness/`; prune internal dirs (`PRPs/`, `.claude/`,
   `docs/fiab/prp/`, `docs/fiab/audit/`, `dev-loop/`, `temp/audit/`) and
   tracked `test-results/` screenshots; add `.gitignore` entries.
3. Resolve icon + notebook provenance; run a dependency license scan.
4. Consider a **fresh squashed public snapshot** (or history scrub) since the
   identifiers exist across many commits — topology hygiene, not key rotation.
