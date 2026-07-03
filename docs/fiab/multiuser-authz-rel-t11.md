# Multi-user authorization model (rel-T11 / B4)

Before rel-T11, `tenantId` on every Loom Cosmos doc held the individual user's
Entra **`oid`**, and every access check compared `workspace.tenantId === oid`.
Nothing was shareable: a second user in the same Entra tenant could not open a
shared workspace, feature grants never resolved for a grantee, and the shipped
sharing/permissions UIs wrote ACL rows no read guard ever consulted.

rel-T11 wires the existing ACL (`workspace-roles` container, `resolveEffectiveRole`)
and Entra tenant id (`tid`) into the read path — **without** rewriting any
immutable partition key.

## Access-resolution algorithm (owner → ACL → tid boundary)

Central resolver: `lib/auth/workspace-access.ts › resolveWorkspaceAccessByOid(oid, workspaceId, {groups, callerTid})`.

1. **Owner fast-path** — point-read the workspace on `(id, oid)`. A hit means the
   caller owns it → full access (`canWrite`). Byte-identical to the legacy check
   and runs first, so the single-operator estate does zero new work.
2. **Kill switch** — if `LOOM_MULTIUSER_ACL=off`, stop (owner-only, legacy).
3. **Locate the doc** cross-partition (the caller is not its owner).
4. **tid boundary** — when the caller's `tid` and the workspace doc's `tid` are
   both known, they must match, else deny. Legacy docs lack `tid`; for those the
   explicit ACL grant below is itself the tenant boundary (a foreign principal
   can only get a `workspace-roles` row if a workspace admin in the owning tenant
   added their oid, and the sharing UI's principal search is tenant-scoped).
5. **ACL** — `resolveEffectiveRole` returns the highest workspace role via direct
   + (nested) group membership. Non-null → access at that role.

**Write vs read**: `canWrite` is true only for **Owner / Admin / Member** (the
roles mapping to Azure RBAC Contributor). Contributor / Viewer are read-only.
`loadOwnedItem` and `authorizeWorkspace` gate to `canWrite` **by default** (they
back mutation routes), admitting read-only members only via
`{ allowReadRoles: true }`. So sharing can never silently escalate a viewer into
a writer.

## Where it's wired

| Layer | Change |
|-------|--------|
| Session | `UserClaims.tid` added; populated in `app/auth/callback` + `app/api/auth/cli-session` from `idTokenClaims.tid → account.tenantId → homeAccountId[1]`. `tenantScopeId(session)` = `tid ?? oid`. |
| Workspace guard | `authorizeWorkspace` / `requireWorkspace` now allow owner **or** tenant-admin **or** ACL member (write-capable by default; `allowReadRoles` opt-in). |
| Item guard | `loadOwnedItem` delegates ownership to `resolveWorkspaceAccessByOid` (write-capable by default). This one helper reaches every item route. |
| Item listing | `listOwnedItems` / `listAllOwnedItems` / `GET /api/workspaces` include ACL-shared resources (read-safe, any role). |
| Feature gate | `checkCapability` + `/api/admin/permissions/grants` key grants by `tenantScopeId` (tid) so a delegated grant resolves for the grantee. |
| Write path | `POST /api/workspaces`, `POST /api/admin/workspaces`, git branch-out now record `ownerOid` + `tid`. |

## Migration story

- **Partition keys are immutable** — `workspaces`/`items` stay partitioned by the
  owner oid (`/tenantId`). Sharing is an overlay via `workspace-roles`, not a
  re-partition. Existing docs keep working unchanged (owner fast-path).
- **New fields going forward** — every new workspace records `tid` + `ownerOid`.
- **Existing docs** — run `scripts/csa-loom/backfill-workspace-tid.mjs` (dry-run
  by default; `--apply` to write). It (a) adds `tid`/`ownerOid` to existing
  workspaces via in-partition upsert, and (b) re-homes `feature-permissions`
  grants from the owner-oid partition into the tenant-id partition so grantees
  resolve. Idempotent; safe to re-run. Backfill is preferred over lazy migration
  and is the only step required for the live estate.
- **Feature-flag posture** — `LOOM_MULTIUSER_ACL` (default `on`) gates only the
  ACL fallback; the owner/admin fast-paths are unconditional, so a flip to `off`
  restores exact legacy owner-only behavior without touching the single-user path.

## Two-user live E2E (post-roll)

1. As user **A** (owner), create a workspace `W` and an item `I` in it.
2. As A, open **Manage Access** on `W` and add user **B** (same Entra tenant) as
   **Member**. Confirm the `workspace-roles` row is written.
3. Sign in as **B**: `GET /api/workspaces` lists `W`; opening `W` and item `I`
   succeeds (200 with real data), and B can edit `I` (Member = write).
4. As a tenant admin, grant B a capability at `/admin/permissions`; confirm B's
   next request to that surface is allowed (grant resolved by `tid`).
5. Negative: a user **C** in a **different** Entra tenant with no grant gets 404
   on `W` and 403 on the capability — the `tid` boundary holds.
