# Admin Portal — Domains (`/admin/domains`) — Parity Gap

> Validator: v2 fabric-parity-loop · 4-phase check  
> Run date: 2026-05-26  
> Fabric reference: Fabric admin portal → **Domains**  
> Loom URL: <https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/admin/domains>

## Captures

| Loom | Fabric |
|---|---|
| Live capture blocked by mid-session auth-expiry; structure reconstructed from `apps/fiab-console/app/admin/domains/page.tsx` | Microsoft Learn — `https://learn.microsoft.com/fabric/governance/domains` (multi-screenshot reference + tenant-setting docs at `service-admin-portal-domain-management-settings`) |

## Phase 1 — What Fabric provides

Fabric's Domains tab is a real CRUD surface for the entire data-domain governance model:

- List of all domains in the tenant (with workspace count, contributor scope, parent domain).
- **Create new domain** button → modal with `Name` (required), `Description`, `Admins` (people picker).
- Per-domain detail page (clicking a domain row): full settings side-pane with tabs:
  1. **General settings** — Name + Description.
  2. **Image** — gallery to pick a thumbnail/color that shows in the OneLake catalog.
  3. **Admins** — people picker (specifies who can edit the domain).
  4. **Contributors** — people picker OR security group (specifies who can assign workspaces to the domain).
  5. **Default domain** — sets users / security groups for whom new workspaces auto-assign here.
  6. **Delegated settings** — overrides of tenant-level settings for this domain (Information protection default sensitivity label, Certification settings, etc.).
- **New subdomain** action — creates a child domain.
- **Assign workspaces** action — bulk-assign by workspace name OR by workspace admin / security group.
- Domain admins (vs. Fabric admins) see only their own domains and can only edit description / contributors / image / delegated settings.
- Backed by `Domains - List Domains`, `Create Domain`, `Update Domain`, `Assign Workspaces` Fabric admin REST APIs.

## Phase 2 — What Loom provides

Source: `apps/fiab-console/app/admin/domains/page.tsx`:

```tsx
export default function DomainsPage() {
  return (
    <AdminShell sectionTitle="Domains">
      <EmptyState icon="▣"
        title="No domains defined"
        body="Domains group workspaces into business areas (Finance, Operations, Marketing, etc.). The OneLake catalog and Govern tab respect the active domain selector."
        primaryAction={{ label: 'Add domain' }} />
    </AdminShell>
  );
}
```

Notice the `primaryAction={{ label: 'Add domain' }}` — there is **no `onClick` handler**. The button renders but does nothing.

No backend route — `apps/fiab-console/app/api/admin/domains/` does **not exist**. No Cosmos container for domains. No Bicep module to provision a domain store.

## Phase 3 — Gap matrix

| Fabric element | Loom | Severity |
|---|---|---|
| Domain list (with name, workspace count, parent, contributor scope) | Absent — only an empty-state message | **BLOCKER** |
| **Create new domain** modal | Loom shows a button labelled "Add domain" but **the button has no `onClick` handler — it is dead** | **BROKEN** (per `no-vaporware.md`) |
| Per-domain settings side-pane (6 tabs) | Absent | BLOCKER |
| **New subdomain** | Absent | BLOCKER |
| **Assign workspaces** (by name / admin / group) | Absent | BLOCKER |
| Domain image / icon picker | Absent | MAJOR |
| Domain admins / contributors people picker | Absent | BLOCKER |
| Default-domain mechanism | Absent | MAJOR |
| Delegated tenant settings (info protection default label, cert settings) | Absent | MAJOR (and dependent on the missing tenant-settings backend) |
| Persistence layer (Cosmos / DB / file) | Absent | BLOCKER |
| Bicep / bootstrap to provision domain store | Absent | BLOCKER |
| Honest MessageBar saying "Domains not implemented in this Loom build" | Absent — instead the page implies "No domains defined" (suggesting a domain CAN be defined here) | **MAJOR** |

## Phase 4 — Functional verification

| Control | Expected behaviour | Actual |
|---|---|---|
| Click "Add domain" button | Should open Create domain modal | **BROKEN** — button renders but has no `onClick`; clicking it does nothing. This is a textbook `no-vaporware.md` violation: "Buttons with no click handler" is explicitly listed under "What's explicitly forbidden". |
| Page text "No domains defined" | Implies there's a way to define one in this UI | Misleading — there isn't. |

## Grade: **F**

- The "Add domain" button is a vaporware violation per `.claude/rules/no-vaporware.md`.
- The "No domains defined" framing is misleading: a user reasonably expects to click the button and define one.
- To get out of F: replace the EmptyState with a Fluent MessageBar `intent="warning"` stating the actual state ("Loom does not implement Fabric domains in this build. Domains require a Cosmos container `loom-domains`, an admin API at `/api/admin/domains`, and a bicep module under `platform/fiab/bicep/modules/governance/domains.bicep`. Tracked under v3.5.") OR build the feature.
- This is one of the worst offenders in the admin portal — silent dead button + misleading copy.
