# git-integration — parity with Fabric Git integration (F12)

Source UI (Fabric): Workspace → **Settings → Git integration** — the panel that
connects a workspace to an Azure DevOps or GitHub repository, picks
org/project/repo/branch/folder, commits the workspace's items as serialized
definitions, shows the current branch + last sync, and disconnects.

REST grounding (Microsoft Learn / official docs):
- Azure DevOps Git REST 7.1: https://learn.microsoft.com/rest/api/azure/devops/git/?view=azure-devops-rest-7.1
  - Pushes: https://learn.microsoft.com/rest/api/azure/devops/git/pushes/create
  - Refs: https://learn.microsoft.com/rest/api/azure/devops/git/refs/list
  - Items: https://learn.microsoft.com/rest/api/azure/devops/git/items/list
  - Commits: https://learn.microsoft.com/rest/api/azure/devops/git/commits/get-commits
- GitHub Git Data API: https://docs.github.com/rest/git

Surface: `lib/panes/git-integration.tsx` (embedded in
`lib/components/workspace-settings-drawer.tsx` → Git integration tab).
Client: `lib/clients/git-integration-client.ts`.
Store: `lib/azure/git-binding-store.ts` (Cosmos `workspace-git` + Key Vault).
BFF: `app/api/admin/workspaces/[id]/git/{route,meta,sync,status}/route.ts`.

This is 100% Azure-native (per `no-fabric-dependency.md`): no Fabric / Power BI /
OneLake host is ever contacted. Azure DevOps is the default control surface in
every cloud; GitHub is the alternative in Commercial / GCC and is honestly gated
off in GCC-High / IL5.

## Fabric feature inventory (Git integration panel)

| # | Capability in the Fabric UI | ADO REST | GitHub REST |
|---|-----------------------------|----------|-------------|
| 1 | Pick a provider (ADO / GitHub) | — | — |
| 2 | Browse organization → project | `GET /_apis/projects` | n/a (owner field) |
| 3 | Browse repositories | `GET /_apis/git/repositories` | `GET /user/repos`, `GET /orgs/{org}/repos` |
| 4 | Browse / pick a branch (or new) | `GET .../refs?filter=heads/` | `GET /repos/{o}/{r}/branches` |
| 5 | Pick a target folder | (push path prefix) | (tree path prefix) |
| 6 | Connect + validate credentials | live `refs` probe | live `branches` probe |
| 7 | Sync: commit every item as definition JSON | `POST .../pushes` (atomic multi-file) | Git Data API: blobs → tree → commit → ref |
| 8 | Create the branch on first sync | push with `oldObjectId: 000…0` | ref create (orphan commit, no parents) |
| 9 | Current-branch chip + last sync time | binding record | binding record |
| 10 | Status: real head commit / SHA | `GET .../commits?$top=1` | `GET /repos/{o}/{r}/commits/{branch}` |
| 11 | Disconnect (clear bind) | KV secret delete + Cosmos delete | same |
| 12 | Credential secured server-side | PAT/SPN → Key Vault `secretRef` | PAT → Key Vault `secretRef` |

## Loom coverage

| # | Status | Where |
|---|--------|-------|
| 1 | ✅ built | provider `RadioGroup` (git-integration.tsx) |
| 2 | ✅ built | `adoListProjects` → meta `?action=projects` |
| 3 | ✅ built | `adoListRepos` / `githubListRepos` → meta `repos`/`gh-repos` |
| 4 | ✅ built | `adoListBranches` / `githubListBranches`; freeform branch input creates-on-sync |
| 5 | ✅ built | Folder input → `normalizeFolder` → push/tree path prefix |
| 6 | ✅ built | POST `/git` runs a live branch-list probe before persisting |
| 7 | ✅ built | POST `/git/sync` → `adoPushFiles` / `githubBatchCommit` (one atomic commit) |
| 8 | ✅ built | `adoGetBranchTip` → `ADO_ZERO_OBJECT_ID`; GitHub orphan ref |
| 9 | ✅ built | branch `Badge` + last-sync `Caption1` in the connected view |
| 10 | ✅ built | GET `/git/status` → `adoLastCommit` / `githubLastCommit` (live head SHA) |
| 11 | ✅ built | DELETE `/git` → `deleteBinding` (KV + Cosmos) |
| 12 | ✅ built | `saveBinding` writes `loom-git-{ws}-{pat|spn}` to Key Vault; Cosmos keeps only `secretRef` |

Zero ❌, zero stub banners — every inventory row is built and calls real REST.

## Backend per control

| Control | Calls |
|---------|-------|
| Provider radio | client-only; GitHub disabled by `cloud.githubAvailable` from GET `/git` |
| Load projects / repos / branches | GET `/git/meta?action=…` → ADO/GitHub list REST (PAT inline during connect, else from KV) |
| Connect & sync | POST `/git` (validate + KV store + Cosmos upsert), then POST `/git/sync` |
| Sync now | POST `/git/sync` → serialize all `WorkspaceItem` + manifest → atomic push → records real commit SHA |
| Remote head | GET `/git/status` → live last-commit read |
| Disconnect | DELETE `/git` → KV secret delete + Cosmos doc delete |

## Per-cloud matrix

| Cloud | Azure DevOps | GitHub | Notes |
|-------|--------------|--------|-------|
| Commercial | ✅ `dev.azure.com` | ✅ `api.github.com` | both providers shown |
| GCC | ✅ `dev.azure.com` | ✅ `api.github.com` | GCC runs on Commercial Azure endpoints; GitHub reachable |
| GCC-High | ✅ `dev.azure.com` | ⚠️ hidden + honest note | GitHub has no FedRAMP-High authorization (`githubCloudGate` → 503) |
| IL5 / DoD | ✅ `dev.azure.com` | ⚠️ hidden + honest note | same gate (`detectLoomCloud()` = GCC-High/DoD) |

Azure DevOps Services has **no** Government endpoint — every customer (including
federal) authenticates against `dev.azure.com`, so ADO is available in every
Loom boundary. The PAT/SPN secret is the user's; Loom stores it in the same Key
Vault that backs Loom Connections (`LOOM_KEY_VAULT_URI`, UAMI holds Key Vault
Secrets Officer).

## Front Door / WAF

The admin routes live under `/api/admin/workspaces/{id}/git/**`. Front Door's
`Microsoft_DefaultRuleSet` has a `.git`-exposure rule that 403s the `git` URL
segment, so `modules/admin-plane/front-door.bicep` adds a narrow custom **Allow**
rule matched on a request URI containing BOTH `/api/admin/workspaces/` AND
`/git` — scoping the bypass to exactly this Entra-session-gated admin path family
(request-body inspection is already disabled; URL/header/cookie + Bot Manager
protection still apply everywhere else).

## Verification (real-data E2E)

With `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET (Azure-native default path):
1. Connect a real ADO repo (org/project/repo) with a Code R/W PAT → POST `/git`
   returns `ok:true` after the live `refs` probe.
2. Sync now → POST `/git/sync` commits `loom-workspace/<itemType>/<id>.item.json`
   for every item + `loom-workspace/.loom/workspace.json` in one push; response
   `{ ok:true, commitId:"<40-hex SHA>", fileCount, itemCount }`.
3. GET `/git/status` returns the same `remoteHead.commitId` from the live ADO
   `commits` read — the SHA is the receipt.
4. Disconnect → DELETE `/git` clears the Cosmos bind and soft-deletes the KV
   secret; GET `/git` then returns `git:null`.
5. In a GCC-High/IL5 deployment (`LOOM_CLOUD=GCC-High`) the GitHub radio is
   disabled with the honest note and the GitHub REST paths 503 via
   `githubCloudGate()`; ADO is unaffected.
