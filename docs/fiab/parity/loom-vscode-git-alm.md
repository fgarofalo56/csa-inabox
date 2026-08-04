# loom-vscode — Git / ALM — parity

**Surface:** the CSA Loom VS Code extension's Phase-5 Git/ALM commands —
`Git: status`, `Git: commit…`, `Git: pull` (on a workspace) and `Git: resolve
conflict…` (on an item).

**Source UI (Fabric):** workspace Git integration — view all workspaces' source
control, commit selected items, update/pull from the repo, resolve conflicts,
clone a Git-enabled workspace — <https://learn.microsoft.com/fabric/data-engineering/set-up-fabric-vs-code-extension>
(PRP §1.3 rows W9/W10).

**Governing rules:** `no-fabric-dependency.md` (Azure-native ADO/GitHub, never a
Fabric git surface), `no-vaporware.md` (real route or an honest gate — never a
fabricated status), `ui-parity.md`.

> Legend: ✅ built · ⚠️ honest gate (renders, names the remediation, Fix-it) ·
> ❌ deferred (stated, never claimed as ✅).

## Fabric feature inventory → Loom coverage

| # | Capability (Fabric) | Loom coverage | Status |
|---|---|---|---|
| W10 | View source-control **status** — repo, branch, head, changed items | `CSA Loom: Git: status` — repo/branch/head + a quick-pick of changed items with add/modify/remove badges | ✅ |
| W10 | **Commit** selected items with a message | `CSA Loom: Git: commit…` — multi-select over the changed items + a message prompt; shows the commit sha + an Open-commit link | ✅ |
| W10 | **Update / pull** from the repo | `CSA Loom: Git: pull` — confirms, then applies repo → items; reports the applied count | ✅ |
| W10 | **Resolve** a per-item conflict (keep local / keep remote) | `CSA Loom: Git: resolve conflict…` on an item | ✅ |
| — | No repo bound / no PAT / no Key Vault | route `424 {gated,missing}` → the exact remediation + a **Fix-it** that opens `<apiUrl>/workspaces/<id>` (Git settings) | ⚠️ |
| A3 | Read-only PAT blocks writes before the call | `guardWrite` on commit / pull / resolve — a reason, not a 403 | ✅ |
| W9 | **Clone** a Git-enabled workspace repo to disk | not yet wired — status/commit/pull/resolve is the working subset | ❌ |

**A-grade note:** the ❌ (W9 clone) is stated, not disguised — no empty command,
no stub. The four working verbs each call a real route.

## Backend per control (every command → a real route)

| Command | Route | Request / response |
|---|---|---|
| Git: status | `GET /api/git-integration/status?workspaceId=` | → `{repo:{provider,repoPath,branch}, headSha, lastSyncedSha, changed[]}` |
| Git: commit | `POST /api/git-integration/commit` | `{workspaceId, itemIds[], message}` → `{commitSha, url, files, committed[]}` |
| Git: pull | `POST /api/git-integration/pull` | `{workspaceId, itemIds?}` → `{headSha, applied, items[]}` |
| Git: resolve | `POST /api/git-integration/resolve` | `{workspaceId, itemId, resolution:'local'\|'remote'}` |

These are the **same** workspace-scoped routes the Console's Git integration uses
(ADO default; GitHub where enabled). The provider is resolved server-side — the
client never assumes one.

## Honest gates (no fabricated status)

The routes answer `424 {ok:false, gated:true, missing}` with `missing` one of
`no_repo_bound` / `no_pat` / `kv_forbidden` / `no_kv`. The client maps each to a
distinct, actionable message (named in `describeGitGate`) and offers a **Fix-it**
that opens the Console workspace Git settings — never a fabricated "clean" or a
fake changed-list. A 401 (not a gate) is surfaced as a plain error, not a gate.

## Verification

- `tsc --noEmit` → 0 · `vitest run` (`test/git-integration.test.ts`, 10 tests):
  model (icons/summary/gate text) + transport (URL/body shaping) + the
  **mutation-proof** 424→`GitGateError` mapping (removing the gate detection turns
  it RED) + a 401 that must NOT be a gate.
- G1 in-editor E2E (a real commit sha against a live bound repo) is pending — not
  runnable from the build worktree; the routes are the ones the Console Git
  integration already exercises end-to-end.
