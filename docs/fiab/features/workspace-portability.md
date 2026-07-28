# Workspace portability (.loomws export, import and clone)

> **Surface:** workspace **Settings → Portability** tab
> **Backend:** `GET /api/workspaces/<id>/export`, `POST …/import`, `POST …/clone` — real Cosmos reads and writes plus AI Search document upserts
> **Kill-switch flag:** `exp1-workspace-portability` (default ON)
> **Honest gate:** none — but a **write-capable role** (Owner / Admin / Member) is required

Move a whole workspace. Export it as a portable `.loomws` bundle, import it into
another workspace (or another estate) with an explicit collision strategy, or
clone it in place with one click.

This is the workspace-scoped sibling of the app-scoped `.loomapp` export — the
same download convention, generalised to the entire metadata plane.

## Why it exists

Item-by-item export answered "move this artifact". It did not answer the
questions people actually ask: promote a dev workspace to test, stand up a
per-agency copy of a working topology, hand an auditor a complete snapshot of
what a workspace contained, or seed a fresh estate from a known-good one.

The bundle travels **through the caller's session**, so an IL5 estate keeps it
in-boundary: nothing is staged in an external service.

## What a `.loomws` bundle contains

| Included | Excluded |
|---|---|
| Every item and its content | **Secrets — always, by construction** |
| Folders and the folder tree | Data (this is the metadata plane, not a data copy) |
| Non-secret configuration | |
| An informational roles manifest | Role grants are **not applied** on import |

Secrets cannot be imported because the bundle format never carries them. The
export receipt names how many paths were scrubbed, so the exclusion is visible
rather than assumed.

## How to use it end to end

### Export

1. Open the workspace, go to **Settings → Portability**.
2. Click **Export**. The browser downloads `<name>.loomws` (pretty-printed JSON,
   as a content-disposition attachment).
3. **Read the post-export receipt.** It shows the manifest counts — items,
   folders — and the explicit secrets-excluded note with the scrubbed-path
   count.

### Import

1. In the **target** workspace, go to **Settings → Portability** and start the
   import wizard. It is a guided wizard, never a freeform JSON box.
2. **Pick a `.loomws` file.**
3. **Review its manifest** — what the bundle claims to contain, validated before
   anything is written.
4. **Choose a collision strategy:**

   | Strategy | Behaviour |
   |---|---|
   | **new-ids** (default) | Creates every folder and item fresh. The old-to-new id map is deep-applied across item states, so intra-bundle relationships — task-flow bindings, lakehouse-to-SQL-endpoint pairing, pipeline references — point at the **imported** graph and never back at the source. |
   | **skip-existing** | Leaves anything already present untouched. |
   | **overwrite** | Replaces the existing item with the bundle's version. |

5. **Import.** The result summary reports created, skipped, overwritten, folders
   created, folders reused, references remapped, and the strategy used.

### Clone

1. **Settings → Portability → Clone**, give the new workspace a name, confirm.
2. Follow the link to the new workspace and verify the cloned items provision
   against the target estate.

Clone is export plus import with `new-ids` in one action — the same reference
remapping applies, so a clone is genuinely independent of its source.

## What the backend actually does

| Control | Backend |
|---|---|
| Export | `GET /api/workspaces/<id>/export` — real Cosmos reads; the bundle is assembled server-side and streamed as a download |
| Import | `POST /api/workspaces/<id>/import` — bundle validation, then a plan, then real Cosmos writes plus AI Search document upserts |
| Clone | `POST /api/workspaces/<id>/clone` |
| Audit | Every export, import and clone writes a portability audit row carrying the workspace, the counts and the scrubbed-secret count |

## Authorization

All three operations require **write-capable workspace access** (Owner, Admin or
Member) on the relevant workspace — the target workspace for import. Read-only
shared roles are explicitly refused with a `read_only_role` error, because the
bundle carries every item's content plus the membership manifest and must not be
exfiltrable wholesale by a viewer.

## Kill-switch

`exp1-workspace-portability` — default ON. Flipping it OFF makes all three
routes refuse with `flag_disabled` (the error names the flag) and the Portability
tab surface a guided notice on the next request. No roll required. Existing
workspaces, items, and the app-scoped `.loomapp` export/import are unaffected.

## Related

- [Workspaces admin page](../admin/workspaces.md) · [Workspace RBAC](../governance/workspace-rbac.md)
- [Upgrade and migration](../operations/upgrade-migration.md)
- [Migration on-ramp](migration-on-ramp.md) — bringing an estate *in* from another platform
