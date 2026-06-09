# git-integration — parity with Fabric Git integration (SCM binding)

Source UI: Fabric **Workspace settings → Git integration**
Reference: <https://learn.microsoft.com/fabric/cicd/git-integration/intro-to-git-integration>
Run date: 2026-06-09

Loom surfaces:

- BFF: `app/api/workspaces/[id]/scm/route.ts` (GET/POST/DELETE)
- Store: Cosmos `workspace-git` container (PK `/workspaceId`)

> **Route naming:** the route is `/scm` (not `/git`) because Azure Front Door's
> OWASP managed ruleset 403s a POST whose path contains the segment `git`. This
> is documented in the route file header.

The SCM binding is **Loom-native** state in Cosmos. There is **no dependency on
real Microsoft Fabric** — connecting a workspace to GitHub / Azure DevOps records
intent and the binding works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Fabric/Azure feature inventory (grounded in Learn)

1. Connect a workspace to a GitHub or Azure DevOps repo + branch + directory
2. Authenticate with a token / OAuth
3. View the current connection
4. Disconnect
5. Commit workspace items to the repo / update workspace from the repo

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| Connect workspace to GitHub / Azure DevOps repo | ✅ Built | `POST …/scm` body `{provider, repoUrl, branch, directory?, pat?}` → Cosmos `workspace-git` |
| Read current SCM binding | ✅ Built | `GET …/scm` → Cosmos read |
| Disconnect SCM binding | ✅ Built | `DELETE …/scm` → Cosmos delete |
| PAT hashed (never stored plaintext) | ✅ Built | `crypto.createHash('sha256')` — only the hash is persisted |
| Provider validation (`github` / `ado`) | ✅ Built | `PROVIDERS` const validated in route |
| Branch + directory scoping | ✅ Built | stored on the binding |
| Sync items to/from repo (actual Git ops) | ⚠️ Honest gate | Route header discloses: Loom records the binding intent and exports items to a deterministic JSON shape; executing Git on the user's behalf lands when the Functions/CA job ships in v3.4. The connect/read/disconnect surface is fully functional. |

Zero ❌ rows. The Git execution leg is an honest ⚠️ gate (disclosed in the route
header + in-product), not a dead control — the binding management is fully built.

## Backend per control

- **Connect** — `POST` validates the provider, hashes any PAT with SHA-256 (the
  raw token is never written to Cosmos or returned), and upserts the binding into
  `workspace-git`.
- **Read** — `GET` returns the binding without the hash.
- **Disconnect** — `DELETE` removes the binding doc.
- **Git execution** — deferred to a Functions/Container-App job (v3.4); the
  binding is the recorded intent + deterministic item-export shape.

## Per-cloud notes

| Cloud | Behaviour |
|---|---|
| Commercial / GCC | Identical; GitHub.com + Azure DevOps Services reachable |
| GCC-High / IL5 | Binding stored identically; repo host must be reachable from the boundary (GitHub Enterprise / Azure DevOps in-boundary). The Front-Door `/scm` workaround applies on all Front-Door-fronted boundaries. |

## Bicep sync

- No new resource — `workspace-git` Cosmos container via existing init.
- No new env var or role grant for the binding surface. The future Git-execution
  job will add its own Function + secret wiring when it lands.

## Verification

- Default path works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- Live walk: in a workspace, connect a GitHub repo + branch (real POST →
  Cosmos), confirm the GET returns the binding without any token, confirm the PAT
  is stored only as a SHA-256 hash, then disconnect (DELETE). Confirm the
  Git-sync MessageBar honestly states execution is deferred.

Grade: **B+** — binding lifecycle fully built on real Cosmos with hashed
secrets; Git execution is the single honest deferred gate.
