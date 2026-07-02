# Sharing, Endorsement & Preview-as

Every CSA Loom item editor carries three cross-cutting governance affordances in
its header chrome: **Share**, **Endorse**, and — on lake-backed items — the
security-roles **Preview as** tester. All three run on Azure-native backends
(Cosmos, ADLS Gen2 ACLs, ARM RBAC, Synapse/ADX); none of them require a
Microsoft Fabric or Power BI workspace.

> Last verified: 2026-07-02 against `lib/editors/item-editor-chrome.tsx`,
> `lib/editors/endorsement-control.tsx`, `lib/dialogs/share-item-dialog.tsx`,
> `app/api/items/[type]/[id]/endorsement/route.ts`, and
> `app/api/items/[type]/[id]/security-roles/preview-as/route.ts`.

## Share — grant people access

The **Share** button in every editor header opens the Fabric-style
"Grant people access" dialog (`lib/dialogs/share-item-dialog.tsx`). It is a
two-step flow:

1. **Pick a principal** — a real Microsoft Entra search (users and groups) via
   `/api/admin/permissions/principals` (Microsoft Graph). There are no mock
   principals: if the Console identity lacks Graph permissions, the search box
   surfaces the exact remediation instead of an empty list.
2. **Choose permissions and grant** — the permission set is tailored to the
   item type (`Read` is always implied; `ReadData`, `ReadAllSQL`,
   `ReadAllSpark`, `Execute`, and `Build` appear only where they apply).
   Granting POSTs to `/api/items/{type}/{id}/permissions`, which writes the
   permission row to Cosmos and mirrors it as **real enforcement**: ADLS Gen2
   POSIX ACLs plus ARM Storage RBAC on the Azure-native default path.

DLP-restricted items disable **Edit** and **Reshare** in the dialog and explain
why with an inline MessageBar.

## Endorse — Promoted, Certified, Master data

The **Endorse** menu in every editor header (`EndorsementControl`, rendered by
the shared `ItemEditorChrome`) reproduces Fabric / Power BI endorsement
one-for-one on an Azure-native backend:

| Level | What it signals | Who can set it |
| --- | --- | --- |
| **None** | No endorsement — clears the badge. | Item owner |
| **Promoted** | Ready to share; the owner vouches this item is good to use. | Item owner |
| **Certified** | Meets the organization's quality standards. | Certifier (tenant admin) only |
| **Master data** | The single authoritative source of truth for this data. | Certifier (tenant admin) only |

Mechanics:

- Reads and writes go to `GET`/`PATCH /api/items/[type]/[id]/endorsement`. The
  value persists on the item's Cosmos document as `state.endorsement` — there
  is **no Fabric / Power BI endorsement API** on this path.
- The **certifier gate is enforced server-side**: `Certified` and
  `Master data` require the tenant-admin capability
  (`LOOM_TENANT_ADMIN_OID` / `LOOM_TENANT_ADMIN_GROUP_ID`); a PATCH without it
  returns 403, and the menu disables those options with an explanatory tooltip
  so they are never dead buttons.
- Endorsed items render a badge in the editor header, in the governance
  catalog, and on OneLake catalog tiles (the catalog reads the same
  `state.endorsement` key), and the OneLake catalog offers a sortable /
  filterable Endorsement column.

## Preview as — test a security role as another principal

Lake-backed items (lakehouse, mirrored database, mirrored catalog) carry a
**Manage OneLake security** tab whose roles enforce real ADLS Gen2 POSIX ACLs,
row-level-security (RLS) predicates, and column-level-security (CLS)
allow-lists. Its **Preview as** tab answers "what would *this user* actually
see?" with live data, not a simulation:

1. Pick a role and a table, then search Entra for the principal to impersonate
   (debounced live Graph search).
2. The Console runs a **read-only** query against the item's real source
   engine via `POST /api/items/[type]/[id]/security-roles/preview-as`:
   - **Synapse** (the default for lakehouse / mirrored items): a
     `SELECT TOP <n>` of only the role's allowed columns, with the RLS
     predicate's identity functions (`USER_NAME()` / `SUSER_SNAME()`)
     substituted with the selected principal's UPN (injection-safe literal) —
     so the result shows exactly the rows that principal would see, with
     restricted columns masked out. The owner-bypass is intentionally not
     applied, so the role's own filtering is visible.
   - **ADX** (defensive path): the equivalent restricted
     `where … | project … | take <n>` via the Kusto client.
3. The response includes the effective predicate, projected vs. restricted
   columns, sample rows, and execution time.

The route is session-gated, PDP-read-checked, and workspace-ownership-gated
(cross-tenant preview is rejected). When the backing store is not configured it
returns an honest 503 naming the missing configuration
(`LOOM_SYNAPSE_WORKSPACE` / `LOOM_SYNAPSE_DEDICATED_POOL` for Synapse, or
`LOOM_KUSTO_CLUSTER_URI` for ADX) rather than fake rows.

## Related pages

- [OneLake security parity](parity/onelake-security.md)
- [Item permissions parity](parity/item-permissions.md)
- [Governance overview](parity/governance-overview.md)
