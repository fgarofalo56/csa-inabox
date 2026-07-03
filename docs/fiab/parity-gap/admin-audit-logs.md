# Admin Portal — Audit Logs (`/admin/audit-logs`) — Parity Gap

> Validator: v2 fabric-parity-loop · 4-phase check  
> Run date: 2026-05-26  
> Fabric reference: Fabric admin portal → **Audit logs** (links out to Microsoft Purview compliance portal)  
> Loom URL: <https://<your-console-hostname>/admin/audit-logs>

## Captures

| Loom | Fabric |
|---|---|
| `temp/parity/admin-audit-logs-loom.png` (captured live — shows `EmptyState` placeholder with circle icon, title "Audit feed will appear here", body explaining what *will* be filterable by user/item/workspace/capacity/date — no filters, no table, no data) | Microsoft Learn — `https://learn.microsoft.com/fabric/admin/service-admin-portal-audit-logs` and `https://learn.microsoft.com/fabric/admin/track-user-activities` |

## Phase 1 — What Fabric provides

Fabric's audit-logs surface is a thin wrapper. The admin portal's **Audit logs** tab itself just provides a **"Go to Microsoft 365 Admin Center"** link that deep-links into the **Microsoft Purview compliance portal** Audit search. There, Fabric admins (with Audit Logs role in Exchange Online) can:

1. Search by **Activities** — selectable from a list of all Fabric/Power BI operations (the `operation-list` page on Microsoft Learn has ~700 friendly-name audit events: `AutoBoundGitCredentials`, `GitBranchedOut`, `ComputeItemsSize`, `CreateCrossTenantAuthMapping`, etc.).
2. Search by **Users** (one or more user UPNs).
3. Search by **Date range** (default last 7 days; retention per Purview SKU).
4. Search by **File / folder / site** name.
5. Export results to CSV.
6. Programmatic access: PowerShell (`Search-UnifiedAuditLog`) or REST (`ActivityEvents` API, `/admin/activityevents?startDateTime=…`, paginated with continuation tokens).

In addition, Fabric admins typically also see:
- The Capacity Metrics app linked from this surface
- Audit retention policy reminder
- Workspace monitoring (Eventhouse / KQL DB) toggle reference

## Phase 2 — What Loom provides

Source: `apps/fiab-console/app/admin/audit-logs/page.tsx`:

```tsx
export default function AuditLogsPage() {
  return (
    <AdminShell sectionTitle="Audit logs">
      <EmptyState icon="◐"
        title="Audit feed will appear here"
        body="Microsoft 365 audit log activity for every Fabric operation. Filter by user, item type, workspace, capacity, and date range. Export to CSV." />
    </AdminShell>
  );
}
```

That's it. A single `<EmptyState>` with promotional copy about what the page *will* do.

No backend route: `apps/fiab-console/app/api/admin/audit-logs/` does **not exist**. The only admin API in the codebase is `/api/admin/azure-resources` (powers Capacity).

## Phase 3 — Gap matrix

| Fabric element | Loom | Severity |
|---|---|---|
| Date-range filter (Start / End date pickers, default 7 days) | Absent | **BLOCKER** |
| Activities multi-select filter (~700 operation friendly names) | Absent | **BLOCKER** |
| Users filter (one or more UPNs) | Absent | **BLOCKER** |
| File / folder / site filter | Absent | BLOCKER |
| Search button | Absent | BLOCKER |
| Results table with columns: timestamp, user, activity, item, workspace, capacity | Absent | **BLOCKER** |
| CSV export button | Absent | BLOCKER |
| Deep-link to Microsoft Purview compliance portal | Absent | MAJOR (would be the minimum honest gate — open Purview to do the actual search) |
| Honest MessageBar saying "Loom doesn't expose audit logs in this surface — open Microsoft Purview at `<URL>`" per `no-vaporware.md` | Absent (instead the body text suggests filtering *will* work in this surface, which is misleading) | **MAJOR** |
| Capacity / item / workspace filter dropdowns populated from the actual tenant | Absent | BLOCKER |

## Phase 4 — Functional verification

No interactive controls exist on the page besides the side-nav (which is shared). The promised filters/export/CSV do not render. Nothing to click → nothing to break.

| Control | Behaviour | Status |
|---|---|---|
| Page render | Renders `EmptyState` only | OK (renders) |
| `/api/admin/audit-logs` | Endpoint does not exist | n/a — no call to make |

## Grade: **F**

- This is **vaporware** per `.claude/rules/no-vaporware.md`. The body copy describes a feature ("Filter by user, item type, workspace, capacity, and date range. Export to CSV.") that does not exist in code. The user reads it and reasonably believes the page is "loading". It isn't — there's no `useEffect`, no fetch, no backend route.
- The fix per the no-vaporware rule is one of: (1) build the page (minimum: Purview deep-link + a real filter form posting to `/api/admin/audit-logs` that proxies the `ActivityEvents` Power BI admin REST API), or (2) replace the misleading body copy with a Fluent MessageBar `intent="warning"` reading "Loom does not surface Microsoft 365 audit logs in this build. Open Microsoft Purview at https://purview.microsoft.com/audit to search Fabric operations. Tracked under v3.5 — needs `LOOM_PURVIEW_TENANT_ID` env var + Fabric admin API role grant."

Until one of those ships, this is F.
