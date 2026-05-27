# Admin Portal — Overview (`/admin`) — Parity Gap

> Validator: v2 fabric-parity-loop · 4-phase check  
> Run date: 2026-05-26  
> Fabric reference: <https://app.fabric.microsoft.com/admin-portal> (the `Admin portal` landing page)  
> Loom URL: <https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/admin>

## Captures

| Loom | Fabric |
|---|---|
| `temp/parity/admin-overview-loom.png` (NOTE: was captured during a session expiry; shows 404. The structure of the page is reconstructed from source code at `apps/fiab-console/app/admin/page.tsx` + `apps/fiab-console/lib/components/admin-shell.tsx`) | Microsoft Learn — `https://learn.microsoft.com/fabric/admin/admin-overview` and `https://learn.microsoft.com/fabric/admin/admin-center` |

## Phase 1 — What Fabric's Admin Portal Overview is

Fabric's admin portal is a dedicated full-page surface (entered via the **gear ⚙ icon → Admin portal** in any Fabric workspace) with a left-nav of ~25 sections. The landing experience is **Tenant settings** by default — not a "pick an area" stub. The left nav (per Microsoft Learn `admin-center.md`) includes:

1. Tenant settings
2. Usage metrics
3. Users
4. Premium Per User (PPU)
5. Audit logs
6. Capacity settings (Fabric capacity / Power BI Premium / Power BI Embedded / Trial)
7. Refresh summary
8. Embed Codes
9. Organizational visuals
10. Featured content
11. Workspaces
12. Custom branding
13. Help + support tickets / Help + support settings
14. Domains
15. Information protection
16. Fabric identities
17. Disaster recovery
18. Protected workspaces (security)
19. Microsoft Purview hub
20. Monitoring workspace (with Feature usage and adoption + Purview hub semantic models)
21. Storage analytics + capacity-level Spark / Data engineering settings

## Phase 2 — What Loom's `/admin` Overview is

From `apps/fiab-console/app/admin/page.tsx`:

```tsx
export default function AdminLandingPage() {
  return (
    <AdminShell>
      <EmptyState icon="◇" title="Pick an area"
        body="Choose a section on the left to manage tenant settings, capacity, domains, security, audit logs, usage metrics, users, or the workspace inventory." />
    </AdminShell>
  );
}
```

The left-nav (per `apps/fiab-console/lib/components/admin-shell.tsx`) has **9 entries**:

1. Tenant settings
2. Capacity & compute
3. Domains
4. Security & governance
5. Audit logs
6. Usage metrics
7. Users & licenses
8. Workspaces
9. Updates & version sync

## Phase 3 — Gap matrix

| Fabric element | Loom | Severity |
|---|---|---|
| ~25 admin sections in left nav | 9 sections | **MAJOR** — 64% of Fabric admin surfaces are missing entirely (PPU, Embed Codes, Org visuals, Featured content, Custom branding, Refresh summary, Help + Support tickets, Fabric identities, Disaster recovery, Protected workspaces, Purview hub, Monitoring workspace, Storage analytics, etc.) |
| Landing pane shows Tenant settings by default | Landing pane is an `EmptyState` saying "Pick an area" | MINOR |
| Each nav item has a Fluent icon | Loom nav items are text only (no icons in the side rail) | MINOR |
| Workspaces is one of many | "Workspaces" appears twice in Loom (the primary `/workspaces` nav AND `/admin/workspaces`) — not a parity issue per se, but unusual | COSMETIC |
| Per-section "What's new" or release banner | Loom has a separate `Updates & version sync` admin section (Loom-native — not in Fabric) | n/a (Loom-only feature) |

## Phase 4 — Functional verification

| Control | Behaviour | Status |
|---|---|---|
| Each left-nav link | Routes to its admin sub-page (HTTP 200 for all 10 routes confirmed) | OK |
| `EmptyState` "Pick an area" body | Pure static — no interactive controls | n/a |
| Any primary action button on landing | None present | n/a |

No BROKEN controls. The page just doesn't *do* anything other than route.

## Grade: **C**

- The landing is honest about itself (it just routes), and the AdminShell renders cleanly.
- But the admin portal as a whole is **9 sections out of ~25**, with most of those 9 being placeholders (see per-section gap docs).
- This is "renders + some functionality, but missing major panes/items vs Fabric" — textbook **C** per `no-scaffold-claims`.

To reach B, Loom would need to add the missing nav entries OR honestly mark them as "Phase 2: not in Loom" in the AdminShell, AND have at least 4 of the 9 sections be functional (today only Capacity + Updates are).
