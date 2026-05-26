# Admin Portal — Usage Metrics (`/admin/usage`) — Parity Gap

> Validator: v2 fabric-parity-loop · 4-phase check  
> Run date: 2026-05-26  
> Fabric reference: Fabric admin portal → **Usage metrics** / **Feature usage and adoption report** (in the Admin monitoring workspace)  
> Loom URL: <https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/admin/usage>

## Captures

| Loom | Fabric |
|---|---|
| Live capture blocked by session expiry; structure from `apps/fiab-console/app/admin/usage/page.tsx` | Microsoft Learn — `https://learn.microsoft.com/fabric/admin/feature-usage-adoption` |

## Phase 1 — What Fabric provides

Fabric's "Usage metrics" surface is the **Feature Usage and Adoption Report** — an admin-only Power BI report in the auto-provisioned `Admin monitoring` workspace. It's a real multi-page report with:

- **Filters**: date range slicer (last 30 days), capacity, user, item-related filters, activity characteristics.
- **Report pages** (multiple): Activity overview, Inventory snapshot, Item details, User details, Workspace details.
- **Visuals**: card visuals for total activities / total items / active users / active workspaces / active capacities, plus charts breaking down by item type, by activity type, by user, by workspace, by capacity.
- **Measures** exposed in the underlying semantic model so users with Build permission can author custom reports:
  - Active capacities, Active users, Active workspaces, Activities, Items, Total activities, Total items.
- **Right-click → Drill through** to per-item / per-workspace / per-user detail pages.
- Backed by the Microsoft 365 audit log (the same source as the Audit logs tab).
- **Per-item usage metrics** (per-report, per-dashboard) accessible from each report's settings — separate from the admin Feature Usage report.
- Tenant settings under `Audit and usage settings` control: "Usage metrics for content creators", "Per-user data in usage metrics", "Show user data in Fabric Capacity Metrics app".

## Phase 2 — What Loom provides

Source: `apps/fiab-console/app/admin/usage/page.tsx`:

```tsx
export default function UsagePage() {
  return (
    <AdminShell sectionTitle="Usage metrics">
      <EmptyState icon="◑"
        title="Feature usage & adoption (preview)"
        body="30-day rolling activity, inventory snapshot, per-item details. Drill into capacity, workspace, user, item type, and operation. Identify inactive items for cleanup." />
    </AdminShell>
  );
}
```

`EmptyState` only. No backend route at `/api/admin/usage`. The "(preview)" label suggests it's coming, but nothing in code is wired.

## Phase 3 — Gap matrix

| Fabric element | Loom | Severity |
|---|---|---|
| Date-range slicer (default 30 days) | Absent | **BLOCKER** |
| Capacity / user / item filter slicers | Absent | BLOCKER |
| Card visuals (Total activities / Total items / Active users / Active workspaces / Active capacities) | Absent | **BLOCKER** |
| Activity timeline chart | Absent | BLOCKER |
| Item type breakdown chart | Absent | BLOCKER |
| User breakdown chart | Absent | BLOCKER |
| Workspace breakdown chart | Absent | BLOCKER |
| Capacity breakdown chart | Absent | BLOCKER |
| Item inventory table (item ID / name / type / modified-by / activity status) | Absent | **BLOCKER** |
| Drill-through to detail pages | Absent | BLOCKER |
| Inactive-items identification feature ("Identify inactive items for cleanup" — promised by body text) | Absent | **BROKEN promise** — body text references it; nothing renders |
| Backing data source (audit log → BFF aggregator → JSON for client) | Absent | BLOCKER |
| Honest MessageBar disclosing the feature isn't implemented | Absent — instead the body lists features as if available, qualified only by a "(preview)" badge | **MAJOR** |

## Phase 4 — Functional verification

No interactive controls. The "(preview)" badge in the title is the only honest signal that something isn't quite ready, but the body text is still aspirational.

## Grade: **F**

- Same pattern as Audit logs and Security: vaporware via descriptive body copy with no implementation behind it.
- "(preview)" doesn't redeem it — preview features per `no-vaporware.md` must be tagged `Badge` "Preview" AND surface in the catalog AND have a tracked TODO. The Loom page does have the "(preview)" word, but doesn't ship even a preview-quality data source.
- Minimum fix: replace body with a MessageBar reading "Usage metrics require Microsoft 365 audit log ingestion + a Cosmos `loom-usage` container + a daily scheduled function to aggregate. Tracked under v3.5." OR build a minimum-viable version using the existing `/api/admin/azure-resources` + a `loom-items` index (which already exists per `csa_loom_v33_state` memory) to render at least an "items count by type" card and a "modified in last 30 days" chart.
- Until either ships, this is **F**.
