# Clean tenant — purge test / tutorial workspace debris

CSA Loom's UAT and tutorial-capture suites create one throwaway workspace per
app or item to keep runs isolated (names like `uat-app-supercharge-bronze-…`,
`tut-notebook-…`, `supercharge-…`). Two suites historically skipped teardown,
so hundreds of these accumulate and pollute the **Workspaces** page, the
`/browse` item counts, the app-install **workspace-picker**, and Copilot
answers. Before you show or hand off a tenant, purge them.

Two layers keep a tenant clean:

1. **Prevention** — the UAT suites now delete every workspace they mint at suite
   end (`test.afterAll` → `cleanupWorkspaces`, see `apps/fiab-console/e2e/_lib/uat.ts`).
   Fresh runs no longer leave debris. This section covers cleaning up what
   *already* accumulated, or debris created by an older harness.
2. **Purge** — `scripts/csa-loom/purge-test-workspaces.sh` sweeps the Cosmos
   `loom` database directly.

## Why a script (and not the in-app bulk-delete)

The in-app **Workspaces → Select → Delete** bulk action is **owner-scoped**: the
`workspaces` container is partitioned by `/tenantId` where `tenantId` is the
*creator's* object id, and the bulk-delete route only reads the caller's own
partition. UAT creates workspaces under a **synthetic automation OID**, so that
debris lands in a partition the real operator's owner-scoped views cannot even
enumerate, let alone delete. The script talks to the Cosmos **data plane**
directly and sweeps **cross-partition**, so it removes debris regardless of
which owner it was created under.

## What it deletes

Per matched workspace, mirroring the in-app cascade plus the per-workspace
satellite documents the app leaves behind:

| Cosmos container | Partition key | What |
| --- | --- | --- |
| `workspaces` | `/tenantId` | the workspace document |
| `items` | `/workspaceId` | every item in the workspace |
| `loom-workspaces` | `/tenantId` | the admin Workspace-Catalog row (matched by name) |
| `folders`, `workspace-folders`, `workspace-permissions`, `workspace-roles`, `workspace-git`, `task-flows`, `azure-connections`, `networking-config`, `workspace-spark-config` | `/workspaceId` | per-workspace satellites |
| `item-permissions`, `saved-queries`, `onelake-security-roles`, `audit-log`, `comments`, `shares` | `/itemId` | item-scoped satellites (**only with `--deep`**) |

It does **not** touch the AI Search `loom-search` index (`ws:<id>` / `it:<id>`
docs) — that is a separate Azure Cognitive Search resource and self-heals on the
next reindex. This is a harmless residual, not a blocker.

## Prerequisites

- `az login` as a principal (your user, or the deploy service principal) holding
  **Cosmos DB Built-in Data Contributor** at the Cosmos account scope — the same
  data-plane auth model as `write-tenant-topology.sh`.
- Python 3 with `azure-cosmos` and `azure-identity`
  (`pip install azure-cosmos azure-identity`).

## Dry-run (default)

Nothing is deleted without `--apply`. Point it at the Cosmos account (the
endpoint is resolved for you) and review what it *would* remove:

```bash
./scripts/csa-loom/purge-test-workspaces.sh --account <cosmos-acct>
# or with an explicit endpoint:
LOOM_COSMOS_ENDPOINT=https://<acct>.documents.azure.com:443/ \
  ./scripts/csa-loom/purge-test-workspaces.sh
```

The dry-run prints, per matched workspace, its `items` / `satellites` /
`admin-rows` counts, and a total. The script **refuses to run** without an
endpoint or a resolvable `--account` — there is no hidden default.

## Apply

```bash
# Delete workspaces + items + per-workspace satellites (interactive confirm):
./scripts/csa-loom/purge-test-workspaces.sh --account <cosmos-acct> --apply

# Also sweep item-scoped satellites, and skip the prompt (for CI/automation):
./scripts/csa-loom/purge-test-workspaces.sh --account <cosmos-acct> --apply --deep --yes
```

`--apply` logs each deleted document and prints a **receipt** (workspaces, items,
admin rows, satellites, failures). A non-zero exit means at least one delete
failed — re-run to converge.

## The match pattern

The default is deliberately narrow and anchored at the start of the name:

```
^(uat-app-|tut-|supercharge-)
```

Override it to broaden the sweep — for example to also remove the per-suite
`uat-<suite>-` workspaces (`uat-copilot-…`, `uat-editors-…`, …):

```bash
PURGE_PATTERN='^(uat-|tut-|supercharge-)' \
  ./scripts/csa-loom/purge-test-workspaces.sh --account <cosmos-acct>
# equivalently: --pattern '^(uat-|tut-|supercharge-)'
```

Keep the pattern anchored (`^`) so it never matches a real workspace whose name
merely *contains* one of these words.

## Verify

After `--apply`, confirm the tenant is clean:

1. **Console** — open **Workspaces** and `/browse`; the `uat-app-*` / `tut-*` /
   `supercharge-*` rows are gone and the counts drop to the real inventory.
2. **Re-run the script in dry-run** — it should report `Nothing to purge`.
3. **Install a fresh app** — the workspace-picker no longer lists throwaway
   workspaces.

## Note on workspace counts

The **Workspaces** page and `/browse` show an **owner-scoped** count (`/api/workspaces`,
your own partition), while **Admin → Workspaces** shows a **tenant-wide**
cross-partition count (`/api/admin/workspaces`). When workspaces exist under more
than one owner (exactly what UAT produces), these two numbers legitimately
differ. Purging the debris collapses both toward the real inventory. See the
rel-T09c PR for the full diagnosis.
