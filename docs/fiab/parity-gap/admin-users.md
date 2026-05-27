# Admin Portal — Users & Licenses (`/admin/users`) — Parity Gap

> Validator: v2 fabric-parity-loop · 4-phase check  
> Run date: 2026-05-26  
> Fabric reference: Fabric admin portal → **Users** (which deep-links to Microsoft 365 admin center and Microsoft Entra) + **Premium Per User** tab  
> Loom URL: <https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/admin/users</br>

## Captures

| Loom | Fabric |
|---|---|
| Live capture blocked by session expiry; structure from `apps/fiab-console/app/admin/users/page.tsx` | Microsoft Learn — `https://learn.microsoft.com/fabric/admin/admin-overview` ("Add and remove users" section), Power BI licensing guide for organizations, Microsoft 365 admin center docs |

## Phase 1 — What Fabric provides

Fabric's Users surface in the admin portal is intentionally thin — it deep-links out to the source systems that actually own license assignment:

- **Users tab** with a link to **Microsoft 365 admin center → Active users** for full user management (add user, delete user, assign Microsoft 365 / Power BI Pro / Fabric Free / Microsoft 365 E3/E5 licenses).
- **Microsoft Entra admin center → Billing → Licenses** deep-link for group-based licensing (assign a license SKU to a security group → every member gets the license).
- **Power BI Premium Per User (PPU)** tab in the admin portal — shows PPU seats assigned in your tenant and the list of users consuming a PPU seat.
- **Tenant settings → Microsoft Fabric → "Users can create Fabric items"** controls who can act on Fabric.
- For service principals: the **Admin API settings** category in tenant settings has "Service principals can access read-only admin APIs", "Service principals can access admin APIs used for updates", "Service principals can create workspaces, connections, and deployment pipelines", "Service principals can call Fabric public APIs" — each with a security-group scope picker.
- Fabric admin roles (Power Platform admin / Fabric admin / Power BI service admin) are managed in the Microsoft 365 admin center → Roles, not in the Fabric admin portal directly.

## Phase 2 — What Loom provides

Source: `apps/fiab-console/app/admin/users/page.tsx`:

```tsx
export default function UsersPage() {
  return (
    <AdminShell sectionTitle="Users, roles & licenses">
      <EmptyState icon="◓"
        title="Entra ID seats & Loom roles"
        body="Manage Loom workspace roles (Admin / Member / Contributor / Viewer) and the downstream Azure roles Loom requires per service (Synapse SQL admin, Databricks workspace admin, ADF contributor, ADLS Storage Blob Data Contributor, etc.). License costs roll up from Microsoft 365 admin center for Microsoft-licensed users and from Databricks / Synapse billing for service-licensed seats." />
    </AdminShell>
  );
}
```

One `EmptyState`. No backend route at `/api/admin/users`. No user list, no role assignment UI, no license table, no deep-links to Entra / M365 admin center.

## Phase 3 — Gap matrix

| Fabric element | Loom | Severity |
|---|---|---|
| User list (paged, searchable) | Absent | **BLOCKER** |
| Per-user role assignment | Absent | **BLOCKER** |
| Deep-link to Microsoft 365 admin center → Active users | Absent | **MAJOR** (would be the minimum honest gate) |
| Deep-link to Entra admin → Billing → Licenses | Absent | **MAJOR** |
| PPU tab (Premium Per User seats assigned) | Absent | MAJOR (less relevant for Loom — no PPU concept) |
| Service principal admin API toggles | Absent (these live under tenant settings anyway, which is also unimplemented) | BLOCKER |
| Loom-native role enforcement (Admin / Member / Contributor / Viewer + downstream service-RBAC mapping promised in body text) | Absent | **BLOCKER** — the body claims this is the page's purpose |
| Downstream Azure role visualization (Synapse SQL admin, Databricks workspace admin, ADF contributor, ADLS Storage Blob Data Contributor) | Absent | BLOCKER |
| License-cost roll-up | Absent | BLOCKER |
| Honest MessageBar disclosing what's missing | Absent | **MAJOR** |

## Phase 4 — Functional verification

No interactive controls. Body text describes a sophisticated role-mapping + license-cost surface; none of it renders.

## Grade: **F**

- Same vaporware pattern. Body promises "Manage Loom workspace roles (Admin/Member/Contributor/Viewer) and the downstream Azure roles Loom requires per service" + "License costs roll up from Microsoft 365 admin center... and from Databricks / Synapse billing". Neither exists.
- Minimum fix: replace body with a Fluent MessageBar `intent="warning"` listing the three deep-links (M365 admin center, Entra > Billing > Licenses, Entra > Enterprise Apps for service-principal review) so admins can at least click out to the actual systems-of-record.
- For a B-grade fix: implement a minimum read-only viewer that calls Microsoft Graph `GET /users` (with `Directory.Read.All` granted to the Loom BFF) + a per-user side-pane showing the downstream Azure role assignments computed via ARM `roleAssignments` queries. That's 1-2 sessions.
- Until either ships, this is **F**.
