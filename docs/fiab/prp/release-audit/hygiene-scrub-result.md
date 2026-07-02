# Repo-hygiene scrub — result

> Executed 2026-07-02 by the hygiene-scrub worker, in worktree
> `E:/Repos/GitHub/csa-inabox/.claude/worktrees/fix-ui-wave2-a` on branch
> `feat/loom-marketplace`. **Working-tree edits only — no git operations, no
> commits.** Findings source: `repo-hygiene.md` (same dir).
>
> Scope of this worker: `platform/fiab/grafana/**`, `platform/fiab/bicep/**`
> (modules + params), `.github/workflows/csa-loom-*.yml`, `scripts/**`,
> `docs/**` (files that remain public), `.gitignore`. Explicitly OUT of scope:
> `apps/fiab-console/**` and `azure-functions/**` (listed below for the main
> agent), and dirs being removed from the index (left intact on purpose).

## 1. Identifier scrub — what changed

All four real subscription GUIDs, the Console UAMI principal/client, the deploy
SP appId, the operator OIDs, and the hardcoded admin-group GUID were replaced.
**Placeholder convention:** deployable/code files use a zero-GUID
(`00000000-…`), prose/docs use a readable `<YOUR_…>` token, bicep params now
read from env. Real → placeholder classes:

| Real value (role) | Placeholder used |
|---|---|
| `e093f4fd-…c665f3` (DMLZ/console sub) | `00000000-…-000000000000` (code) / `<YOUR_SUBSCRIPTION_ID>` (docs) |
| `363ef5d1-…3dbf8c` (bureau DLZ sub) | `00000000-…-000000000001` / `<YOUR_DLZ_SUBSCRIPTION_ID>` |
| `ca2b3e6b-…f9f9ea` (2nd demo sub) | `00000000-…-000000000002` / `<YOUR_DEMO_SUBSCRIPTION_ID>` |
| `a60a2fdd-…bf3ef5` (ALZ/connectivity sub) | `00000000-…-000000000003` / `<YOUR_CONNECTIVITY_SUBSCRIPTION_ID>` |
| `e61f3eb3-…cd9a01` (Console UAMI principal) | `00000000-…-00000000000a` / `<YOUR_CONSOLE_UAMI_PRINCIPAL_ID>` |
| `c6272de5-…50209b` (Console UAMI client) | `00000000-…-00000000000b` / `<YOUR_CONSOLE_UAMI_CLIENT_ID>` |
| `95ca491e-…f55e7`  (deploy SP appId) | `<YOUR_DEPLOY_SP_APP_ID>` (only in a doc) |
| `b9c3cc65-…aa6b`   (Synapse admin OID) | (removed from workflow echo) / `<YOUR_SYNAPSE_ADMIN_OID>` |
| `866a2e12-…1e08cd` (UAT OID) | `00000000-…-00000000000e` (script) |
| `85e5d083-…ea11a3` (grant OID) | `''` (blanked workflow default) |
| `f4f25dd9-…17964d` (UAMI client / grant) | `''` (workflow default) / `00000000-…-000000000010` (script) |
| `716f5ec5-…1cd665` (admin Entra group) | `readEnvironmentVariable('LOOM_ADMIN_ENTRA_GROUP_ID','')` / `<YOUR_ADMIN_ENTRA_GROUP_ID>` |

### Deployable artifacts (highest priority — these ship)

- **`platform/fiab/grafana/loom-governance.json`** — 5 hits. Subs in the three
  Azure Resource Graph `subscriptions` arrays and in two Log Analytics resource
  paths blanked to `00000000-…-000000000000` (e093) / `…-000000000001` (363e).
  Valid JSON; a customer must repoint at their own subs before import.
- **`platform/fiab/grafana/loom-usage.json`** — 5 hits (all e093, in the
  `subscription` fields + LAW path) → `00000000-…-000000000000`.
- **`platform/fiab/bicep/modules/ai/foundry-project.bicep`** — 1 hit, in the
  "Live mapping" header comment → `<YOUR_SUBSCRIPTION_ID>`. Bicep still valid
  (params unchanged; this was a comment only).
- **`.github/workflows/csa-loom-*.yml` (9 files)**:
  - `csa-loom-grant-delta-sharing.yml` — 2 input `default:` values blanked to `''`.
  - `csa-loom-grant-synapse-rbac.yml` — 4 input `default:` values blanked to `''`.
  - `csa-loom-validate.yml` — input `default:` blanked to `''`; sub in the input
    description genericized to `<YOUR_DMLZ_SUBSCRIPTION_ID>`.
  - `csa-loom-post-deploy-bootstrap.yml` — 3 `|| '363ef…'` expression fallbacks
    blanked to `|| ''`; the `vars.LOOM_CONSOLE_UAMI_PRINCIPAL/CLIENT` fallbacks
    blanked to `|| ''`; the runtime `echo "Acting as Synapse initial admin (b9c3…)"`
    had the OID removed; two comments referencing `(363ef5d1)` genericized.
  - `csa-loom-synapse-spark-fix.yml` — 2 `|| 'GUID'` expression fallbacks → `|| ''`.
  - `csa-loom-attempt-interactive-grants.yml` — bare `env:` SUB / UAMI principal /
    UAMI client → `00000000-…-000000000000`.
  - `csa-loom-shir-idle-stop.yml`, `csa-loom-tutorial-capture.yml`,
    `csa-loom-wire-navigators.yml` — bare `env: SUB:` → `00000000-…-000000000000`.
- **`platform/fiab/bicep/params/tenant-dmlz.bicepparam`** — 5 hits (all in the
  header usage comments) → `<YOUR_*_SUBSCRIPTION_ID>` tokens.
- **`platform/fiab/bicep/params/dlz-attach.bicepparam`** — 6 hits (usage
  comments) → `<YOUR_*_SUBSCRIPTION_ID>` tokens.
- **`platform/fiab/bicep/params/commercial-full.bicepparam`** — the hardcoded
  admin-group GUID at line 184 now reads
  `readEnvironmentVariable('LOOM_ADMIN_ENTRA_GROUP_ID','')`, matching the Gov /
  tenant-dmlz param files.

### Scripts (16 files, zero-GUID placeholders)

`scripts/diagnostic-settings/Initiatives/alz DiagSetting Initiative.json`
(10: ca2b3e6b→…002 ×5, a60a2fdd→…003 ×5), and 15 files under `scripts/csa-loom/`:
`enable-unity-catalog.sh`, `deploy-v2-synapse.sh`, `cleanup-test-workspaces.mjs`,
`grant-bi-rbac.sh`, `grant-apim-rbac.sh`, `grant-shortcut-storage-rbac.sh`,
`grant-shortcut-graph-approles.sh`, `grant-powerplatform-sp.sh`,
`grant-navigator-rbac.sh`, `grant-identity-graph-approles.sh`,
`grant-cost-monitoring-rbac.sh`, `seed-governance.sh`, `seed-catalogs.sh`,
`provision-gh-runner.sh`, `patch-navigator-env.sh`. Each distinct real value
mapped to a distinct zero-GUID so cross-references are preserved.

### Docs that remain public (19 files, `<YOUR_…>` tokens)

`docs/copilot-analytics.md`, `docs/javascripts/copilot-chat.js`,
`docs/fiab/loom-mirror-followups-plan.md`, `docs/fiab/github-actions-runner.md`,
`docs/fiab/operator-interactive-setup.md`, `docs/fiab/v3-security-hardening.md`,
`docs/fiab/topology-migration.md`,
`docs/fiab/releases/2026-05-27-apps-bundles-and-wiring-sweep.md`, and 11
`docs/fiab/archive/*.md` files (incl. `v2.0-pushbutton-gap-audit.md`, whose
admin-group GUID was scrubbed to `<YOUR_ADMIN_ENTRA_GROUP_ID>`).

**Verification:** a full-tree ripgrep for all 12 real values returns ZERO hits
across every in-scope file (`platform/**`, `.github/workflows/**`, `scripts/**`,
and the 19 public docs). Remaining hits in the tree are only in out-of-scope or
being-removed paths (next two sections).

### Minor residue (low severity, left as-is)

Bare 8-hex prefixes used as shorthand in a few prose docs (e.g. the literal
`363ef5d1` alone, without the rest of the GUID, in `topology-migration.md`) were
left untouched — an 8-char fragment cannot authenticate or address a resource
and is only recognizable if you already hold the full GUID. Flagging for
awareness; not a blocker.

## 2. `.gitignore` additions + tracked paths needing `git rm --cached`

Added a "Public-release hygiene" block to `.gitignore` (worktree root):
`.harness/`, `dev-loop/`, `docs/fiab/prp/`, `docs/fiab/audit/`,
`docs/fiab/parity-gap/`, `docs/fiab/design/`, `apps/fiab-console/test-results/`.
(`temp/` and `.env` / `.env.*` were already ignored — verified.)

`.gitignore` only stops *future* adds. The following are **currently tracked**
and must be removed from the index by the main agent
(`git rm -r --cached <path>` — do NOT `rm` from disk if you want them kept
locally):

| Path | Tracked files |
|---|---|
| `.harness/` | 4 (`config.json`, `session-notes.md`, `spec.md`, `state.json`) |
| `dev-loop/` | 9 |
| `docs/fiab/prp/` | 21 |
| `docs/fiab/audit/` | 12 |
| `docs/fiab/parity-gap/` | 115 |
| `docs/fiab/design/` | 4 |
| `apps/fiab-console/test-results/` | 173 |
| `temp/audit/` | 2 (tracked despite `temp/` being ignored — pre-existing) |

`.harness/config.json`, `docs/fiab/audit/*`, `docs/fiab/design/*`,
`docs/fiab/prp/release-audit/*` still contain the real identifiers **on
purpose** — they are the densest leaks and the audit record, and are all in the
`git rm --cached` set above, so they will not ship. They were intentionally NOT
scrubbed.

**Secrets check (verified clean):** no `.env`, `.pem`, `.pfx`, `.key`, or
`*secret*` value files are tracked. The only matches are `.env.example`
(intentional) and legitimate secret-*rotation* source/docs
(`kv-secrets-client.ts`, the `secretRotation` Function, runbooks). Confirms the
audit's "no secrets in tree" headline.

## 3. Provenance / license findings (report-only, nothing changed)

- **Content-bundle notebook source — CLEARED.** The seven
  `apps/fiab-console/lib/apps/content-bundles/app-supercharge-*.ts` bundles cite
  `github.com/fgarofalo56/Suppercharge_Microsoft_Fabric`. Verified live: the
  repo is **public** and **MIT-licensed**. Redistribution of derived notebooks
  is permitted provided the MIT copyright + license text travel with derivative
  works — recommend adding a NOTICE/attribution line in the bundle or repo
  THIRD-PARTY-NOTICES. No blocker.
- **Vendored Azure icons — VERIFY BEFORE SHIP.** 25 PNGs under
  `apps/fiab-console/public/azure-icons/` are Microsoft's official Azure
  architecture icons (API-Management, Cosmos-DB, OpenAI, Key-Vaults, etc.).
  Microsoft's Azure-icon terms permit use in architecture diagrams/docs but
  **restrict modification and stand-alone redistribution**; bundling the raw
  PNGs in a public repo is a gray area. Recommend either (a) confirm current MS
  icon terms allow repo redistribution, or (b) reference the icons at runtime /
  replace with the project's own glyphs. `public/brand/loom-logo*.png` are the
  project's own assets — fine. (These files are under `apps/fiab-console/**`, so
  the main agent must action any change.)
- **Dependency license scan — DONE, no strong copyleft.**
  `npx license-checker` over `apps/fiab-console` (81 packages):
  MIT 63, Apache-2.0 12, MPL-2.0 1, EPL-2.0 1, ISC 1, BSD-2-Clause 1, 0BSD 1,
  UNLICENSED 1. **No GPL / AGPL / LGPL.** The three non-permissive-by-default:
  - `elkjs@0.11.1` — **EPL-2.0** (weak/file-level copyleft; using and
    redistributing the unmodified library imposes no source-disclosure on our
    code — fine).
  - `@axe-core/playwright@4.11.3` — **MPL-2.0** (dev-only a11y test dep;
    file-level copyleft, no obligation on our source — fine).
  - `@csa-loom/fiab-console@0.49.0` — **UNLICENSED** — this is the app's OWN
    private package. Recommend setting its `license` to `MIT` (to match the repo
    LICENSE) or keeping `"private": true` so tooling doesn't flag it.

## 4. Out-of-scope items for the MAIN agent to action

Files containing real identifiers that this worker could NOT edit (outside the
assigned scope). Each still needs scrubbing (or removal) before public:

- **`apps/fiab-console/**` (another worker's tree):**
  - `e2e/_lib/uat.ts` (1 — `UAT_OID` default `866a2e12-…`)
  - `lib/setup/__tests__/deploy-preflight.test.ts` (6),
    `lib/setup/__tests__/landing-zones-model.test.ts` (2),
    `lib/azure/__tests__/loom-subscriptions.test.ts` (2),
    `lib/azure/__tests__/multisub-scope-wiring.test.ts` (2) — assert against the
    live estate subs.
  - `tests/walkthrough.mjs`, `tests/uat-v3.mjs`, `tests/service-health.mjs`,
    `tests/eventstream-eventhouse-e2e.mjs`, `tests/editors-render-smoke.mjs`,
    `tests/e2e/_shared.ts`, `tests/apps-install-e2e.mjs` (1 each).
  - Plus the **Azure-icons** provenance item in section 3.
- **`azure-functions/copilot-chat/DEPLOYMENT.md`** (5) — not under my assigned
  dirs; genericize the subs/UAMI like the other deploy docs.
- **`.claude/migrated-archon-tasks.md`** (1 real sub) — `.claude/` was not in
  my gitignore list and the repo tracks `.claude/` shared instructions
  deliberately, so I did not touch it. Decide: scrub the one sub, or add this
  single internal artifact to `.gitignore` + `git rm --cached`.

## READY FOR SNAPSHOT — what the git-history step still needs to do

The working tree is scrubbed, but **the real identifiers still exist in prior
commits** across the branch's history (they were added over many commits). The
edits here do not touch history. Before public release, the main agent / user
must run ONE of:

1. **Fresh squashed public snapshot (recommended, simplest):** create a new
   orphan branch / new repo from the current cleaned working tree
   (`git checkout --orphan public-main && git add -A && git commit`), so the
   public repo has a single clean root commit and NONE of the historical
   identifier commits. Then `git rm --cached` is unnecessary — the internal dirs
   simply won't be `git add`ed for the snapshot (respect the new `.gitignore`).
2. **History rewrite in place:** `git rm -r --cached` the eight tracked internal
   paths in section 2, commit, then run `git filter-repo` (NOT `filter-branch`)
   to purge the 12 identifier strings and the internal dirs from all history.
   Higher risk; requires force-push.

Either path is **topology hygiene, not key rotation** — subscription IDs,
principal/object IDs, and SP appIds cannot authenticate, so this is not a
secret-rotation emergency (confirmed: no credentials/keys in tree or history per
`repo-hygiene.md`). This worker did not run any history operation, per
instructions — it is left for the user to approve and the main agent to execute.
