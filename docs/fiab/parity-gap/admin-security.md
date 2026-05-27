# Admin Portal — Security & Governance (`/admin/security`) — Parity Gap

> Validator: v2 fabric-parity-loop · 4-phase check  
> Run date: 2026-05-26  
> Fabric reference: Fabric admin portal → multiple tabs (Information protection, Fabric identities, Disaster recovery, Protected workspaces, Purview hub)  
> Loom URL: <https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/admin/security>

## Captures

| Loom | Fabric |
|---|---|
| Live capture blocked by mid-session auth expiry; structure from `apps/fiab-console/app/admin/security/page.tsx` | Microsoft Learn — `https://learn.microsoft.com/fabric/admin/fabric-identities-manage`, `https://learn.microsoft.com/fabric/security/workspace-identity`, `https://learn.microsoft.com/fabric/governance/use-microsoft-purview-hub` |

## Phase 1 — What Fabric provides

Fabric's "security & governance" coverage in the admin portal is spread across **multiple dedicated tabs**, each a real CRUD surface:

1. **Fabric identities** tab — Lists every workspace identity (auto-managed service principal). Columns: Name, Service principal ID, State, Workspace. Per-identity actions: Details (side pane with workspace name, state, last state change, SP ID, app ID, tenant ID, assigned role), Delete, Refresh, Export CSV.
2. **Information protection** tab — sensitivity label tenant settings, default labels, enforcement scope, allow/restrict downstream inheritance.
3. **Protected workspaces** tab — workspaces with restricted egress / private link / IP firewall.
4. **Disaster recovery** tab — per-capacity DR toggle.
5. **Microsoft Purview hub** link — deep-link into the Purview portal for Fabric estate governance (sensitivity label coverage, DLP scan results, lineage, certified items count).
6. **Workspace identity audit** — visible inside each workspace's settings (not admin-portal-only).
7. **Customer Lockbox for Fabric** — lockbox requests and approvals.
8. **Tenant settings → Advanced networking** category (Tenant-level Private Link, Block Public Internet Access, workspace-level inbound/outbound rules, IP firewall + trusted resource instances) — surfaced under tenant settings, but security-relevant.

## Phase 2 — What Loom provides

Source: `apps/fiab-console/app/admin/security/page.tsx`:

```tsx
export default function SecurityPage() {
  return (
    <AdminShell sectionTitle="Security & governance">
      <EmptyState icon="◊"
        title="Govern your data estate"
        body="Sensitivity label coverage, DLP scan results, workspace identity audit, and a deep link to the Microsoft Purview hub for unified data governance across Fabric, M365, and Azure." />
    </AdminShell>
  );
}
```

One `EmptyState`. No primary action, no links, no data. No backend route at `/api/admin/security`.

## Phase 3 — Gap matrix

| Fabric element | Loom | Severity |
|---|---|---|
| Fabric identities list (every workspace identity) | Absent | **BLOCKER** |
| Per-identity Details pane | Absent | BLOCKER |
| Delete identity action | Absent | BLOCKER |
| Refresh / Export-CSV ribbon | Absent | BLOCKER |
| Information protection sensitivity label config | Absent | **BLOCKER** |
| Default sensitivity label dropdown | Absent | BLOCKER |
| Protected workspaces list | Absent | BLOCKER |
| Disaster recovery toggle per capacity | Absent | MAJOR |
| Customer Lockbox requests | Absent | MAJOR |
| Microsoft Purview hub deep-link button | Absent — promised in body text, not rendered | **MAJOR** (would be the minimum honest gate) |
| Tenant-level Private Link toggle | Absent | BLOCKER |
| Block Public Internet Access toggle | Absent | BLOCKER |
| Workspace-level inbound / outbound rule config | Absent | BLOCKER |
| IP firewall + trusted resource instances toggle | Absent | BLOCKER |
| Workspace identity audit table | Absent | BLOCKER |
| Honest MessageBar disclosing what's missing + how to provision in Loom's bicep | Absent | MAJOR |

## Phase 4 — Functional verification

No interactive controls. The page's body text *describes* features as if they were on the page; none are rendered.

## Grade: **F**

- Vaporware per `no-vaporware.md` — the body copy says "Sensitivity label coverage, DLP scan results, workspace identity audit, and a deep link to the Microsoft Purview hub" exist on this page. None do.
- A user reads it and waits for the data to load. It never will, because there's no `useEffect` and no backend route.
- Minimum fix: render a Fluent MessageBar `intent="warning"` saying "Loom does not surface Fabric admin security tabs in this build. For workspace identity audit, use Microsoft Entra > Enterprise Applications. For sensitivity labels, use the Microsoft Purview admin center. Tracked v3.5+." OR, at minimum, render a single primary-action `Button` opening `https://purview.microsoft.com/` in a new tab.
