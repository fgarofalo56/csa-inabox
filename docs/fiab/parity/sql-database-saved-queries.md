# sql-database-saved-queries — parity with Azure portal / SSMS / Azure Data Studio "Saved Queries"

Source UI:
- Azure portal **Query editor (preview)** for Azure SQL Database — saved queries are kept per-user.
- **SQL Server Management Studio (SSMS) / Azure Data Studio** — "Open/Save query" + a Saved-queries / Notebooks tree with personal vs shared scope.
- Microsoft Learn: <https://learn.microsoft.com/azure/azure-sql/database/query-editor> and <https://learn.microsoft.com/sql/azure-data-studio/>

This surface is the **Saved queries** tab of the Loom unified SQL-database editor
(`lib/editors/unified-sql-database-editor.tsx`). It gives the editor the
"My Queries" (personal) + "Shared Queries" (workspace) folders the portal/ADS
expose, persisted in the Loom item-state Cosmos store — **no Microsoft Fabric
dependency** (works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset).

## Azure / ADS feature inventory

| # | Capability (real UI) | Notes |
|---|----------------------|-------|
| 1 | Save the current query text with a name | personal scope |
| 2 | Personal ("My Queries") folder of saved queries | per-user |
| 3 | Shared / workspace-visible queries | team members see them |
| 4 | Open a saved query back into the editor | loads the SQL text |
| 5 | Rename a saved query | inline / context menu |
| 6 | Edit a saved query's text + metadata | re-save |
| 7 | Duplicate a saved query | "Save As" / copy |
| 8 | Delete a saved query | context menu |
| 9 | Multi-select (Ctrl / Shift) + bulk delete | tree / list multi-select |
| 10 | Description / annotation per saved query | optional metadata |
| 11 | Role-gated sharing (only contributors can publish shared) | RBAC |
| 12 | Persist across reload / session | server-side storage |
| 13 | Ctrl+S to save | keyboard shortcut |

## Loom coverage

| # | Capability | Status | How |
|---|------------|--------|-----|
| 1 | Save current query with a name | ✅ | "Save current query" → dialog → `POST …/queries` |
| 2 | My Queries folder | ✅ | `QueriesPanel` private folder, GET returns `scope:'private'` rows where `ownerId === caller oid` |
| 3 | Shared Queries folder | ✅ | shared folder; GET returns `scope:'shared'` rows when caller is Admin/Member/Contributor |
| 4 | Open into editor | ✅ | row click → context-menu "Open in Query" sets `sqlText` + switches to Query tab |
| 5 | Rename | ✅ | context-menu "Rename / edit" → dialog (POST upsert with `queryId`) |
| 6 | Edit text + metadata | ✅ | same dialog includes the editable query Textarea |
| 7 | Duplicate | ✅ | context-menu "Duplicate" → POST new private `"<name> (copy)"` |
| 8 | Delete (single) | ✅ | context-menu "Delete" → selects the row → bulk-delete of one |
| 9 | Multi-select + bulk delete | ✅ | Ctrl/Cmd-click toggles, Shift-click ranges; "Delete N selected" → `DELETE …/queries { queryIds }`; receipt `{ deleted, before, after }` |
| 10 | Description per query | ✅ | optional `description` field on the save dialog |
| 11 | Role-gated sharing | ✅ | route 403s a Viewer/non-member creating shared; Shared option disabled in the dialog for Viewer/null role |
| 12 | Persist across reload | ✅ | Cosmos `saved-queries` container (PK /itemId); GET re-reads on tab open |
| 13 | Ctrl+S to save | ✅ | on the Saved-queries tab Ctrl/Cmd+S opens the save dialog (Query tab keeps Run) |

Zero ❌. Zero stub banners. The only non-functional state is the honest
"Save the item first" MessageBar when `id === 'new'` (the item must exist in a
workspace before per-item queries can be stored) — analogous to the portal
requiring a connected database.

## Backend per control

| Control | Backend |
|---------|---------|
| List My/Shared queries | `GET /api/items/azure-sql-database/[id]/queries` → Cosmos `saved-queries` single-partition query (PK /itemId), role via `resolveEffectiveRole` (workspace-roles) |
| Save / rename / edit / duplicate | `POST …/queries` → Cosmos `items.create` / `items.upsert` |
| Bulk / single delete | `DELETE …/queries` → Cosmos `items.executeBulkOperations([{ Delete }])`, ownership-filtered; receipt counts queried before + after |
| Sharing RBAC | `resolveEffectiveRole(oid, workspaceId, { userGroupIds })` — owner (`workspace.tenantId === oid`) treated as Admin; others get direct/group role |

## No-Fabric verification

The container is pure Cosmos + workspace-roles; it never reads `fabricWorkspaceId`,
never calls `api.fabric.microsoft.com` / `api.powerbi.com`, and functions fully
with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. Per-cloud (Commercial / GCC /
GCC-High / DoD) the route depends only on Cosmos (cloud-agnostic endpoint) and,
for shared-query RBAC, Microsoft Graph via the existing `graphBase()` cloud
resolver — no commercial-only hosts.

## Verification receipt (to attach at merge)

- `GET /api/items/azure-sql-database/<id>/queries` after a save returns the row (persist-across-reload).
- A second workspace **Member** GET returns the `scope:'shared'` row (or an honest 403 for a non-member).
- `DELETE { queryIds:[a,b] }` returns `{ ok:true, deleted:2, before:N, after:N-2 }`.
- `npx tsc --noEmit` clean; `vitest` `queries-route.test.ts` 13/13 green.
