# git-integration — parity with Fabric Git integration

Source UI: https://learn.microsoft.com/fabric/cicd/git-integration/intro-to-git-integration
Folder convention: https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions

Loom executes real Git on the user's behalf (no "use your own tooling" stub).
Each workspace item is serialized to a canonical text form under a Fabric-style
item folder `<directory>/<displayName>.<ItemType>/`, then committed / pulled
against **Azure DevOps Repos (REST 7.1)** or **GitHub (REST v3)**. No real
Microsoft Fabric or Power BI workspace is required — this works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Azure/Fabric feature inventory → Loom coverage

| Fabric Git capability | Loom coverage | Backend |
|---|---|---|
| Connect repository (GitHub / Azure DevOps) | ✅ `workspace-settings-drawer.tsx` GitSection → `POST /api/workspaces/[id]/scm` | Cosmos `workspace-git` + KV (PAT) |
| Branch selection | ✅ branch field in connect form; used by every REST call | ADO/GitHub refs |
| Source-control status (changed items list) | ✅ `GET /api/git-integration/status` → SourceControlPanel list with added/modified/removed badges | `getStatus` (list + per-file diff) |
| Commit (push selected items) | ✅ checkboxes + commit message + `Commit selected` → `POST /api/git-integration/commit` | ADO Pushes 7.1 / GitHub Git Data API (blobs→tree→commit→ref) |
| Update (pull from remote) | ✅ `Update (pull)` → `POST /api/git-integration/pull` (applies to Cosmos `state.content`) | ADO Items 7.1 / GitHub Trees+Contents |
| Resolve conflicts (keep local / take from repo) | ✅ per-row `Resolve…` dialog → `POST /api/git-integration/resolve` | commit (local) or pull (remote) for the one item |
| Canonical item serialization | ✅ `serializeLoomItem` | — |
| · semantic-model → `model.bim` (TMSL) + `definition.pbism` | ✅ `buildTmslFromContent` (round-trips via `parseTmslToContent`) | — |
| · report → `definition.pbir` + `definition/report.json` | ✅ | — |
| · scorecard → `scorecard.json` | ✅ | — |
| · all other items → `<itemType>.json` | ✅ | — |
| Receipt: commit SHA + URL + applied diff | ✅ commit returns `{commitSha,url,at,files}`; pull returns `{headSha,applied,diff}` | — |

Zero ❌, zero stub banners. The only non-functional state is the honest gate
table below.

## Honest gates

| Condition | code | HTTP | Copy |
|---|---|---|---|
| No repo connected | `no_repo_bound` | 424 | Connect one in workspace Settings → Git integration. |
| Key Vault not configured | `no_kv` | 503 | Set LOOM_KEY_VAULT_URI and grant the Console identity Key Vault Secrets Officer. |
| Key Vault write/read forbidden | `kv_forbidden` | 403 | Grant the Console identity Key Vault Secrets Officer on the vault. |
| No PAT in Key Vault | `no_pat` | 424 | Re-connect the repository and supply a PAT. |
| Provider rejected PAT | `git_auth` | 401 | Supply a PAT with ADO "Code (Read & Write)" / GitHub "repo" scope. |
| Remote branch moved since last sync | `git_conflict` | 409 | Pull (Update) first, then commit. |

## Per-cloud notes

| Surface | Commercial | GCC | GCC-High | DoD / IL5 |
|---|---|---|---|---|
| ADO provider | dev.azure.com | dev.azure.com (ADO Services SaaS; no GCC-only instance) | `LOOM_ADO_HOST` (on-prem ADO Server) | `LOOM_ADO_HOST` (on-prem ADO Server) |
| GitHub provider | api.github.com | api.github.com | api.github.com (or `LOOM_GITHUB_HOST` for GHES) | `LOOM_GITHUB_HOST` (GHES on-prem) |
| PAT storage | KV `vault.azure.net` | KV `vault.azure.net` | KV `vault.usgovcloudapi.net` | KV `vault.usgovcloudapi.net` |

> Grounding: Microsoft Learn states Azure DevOps Services isn't available in
> GCC — "you can use on-premises Azure DevOps or public Azure DevOps services."
> `LOOM_ADO_HOST` covers every sovereign case without hard-coding a nonexistent
> gov endpoint.

## Backend per control

- Connect / disconnect → Cosmos `workspace-git` upsert/delete (`/api/workspaces/[id]/scm`)
- PAT storage → Key Vault `putKeyVaultSecret` / `deleteKeyVaultSecret` (kv-secrets-client.ts)
- Commit → `commitItems` → ADO Pushes 7.1 or GitHub blobs→tree→commit→ref
- Pull → `pullItemFiles` → ADO/GitHub item content read → deserialize → Cosmos `items` replace
- Status → `getStatus` → list repo files + per-file content compare (no writes)
- lastSyncedSha → persisted back to `workspace-git` after each commit/pull

## Bicep / env sync

`platform/fiab/bicep/modules/admin-plane/main.bicep`:
- params `loomAdoHost`, `loomGitHubHost`, `loomGitPatKvPrefix`
- env `LOOM_ADO_HOST`, `LOOM_GITHUB_HOST`, `LOOM_GIT_PAT_KV_PREFIX`
- No new role assignment — Console UAMI already holds Key Vault Secrets Officer
  on the admin-plane vault (`LOOM_KEY_VAULT_URI`).
- No new Cosmos container — `workspace-git` (PK `/workspaceId`) already exists.

## Verification (receipt)

Connect a real ADO/GitHub repo → select a semantic model → Commit:

```json
{ "ok": true, "commitSha": "<sha>", "url": "https://github.com/<owner>/<repo>/commit/<sha>", "at": "<ISO>", "files": 2 }
```

`GET <url>` shows `…/model.bim` with the TMSL of the model. Then edit the file
in the repo and click Update (pull):

```json
{ "ok": true, "headSha": "<sha>", "applied": 1, "diff": { "added": 0, "modified": 1, "removed": 0 } }
```

The Loom item's `state.content` now matches the repo (parsed back from TMSL).
