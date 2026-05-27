# Admin Portal — Tenant Settings (`/admin/tenant-settings`) — Parity Gap

> Validator: v2 fabric-parity-loop · 4-phase check  
> Run date: 2026-05-26  
> Fabric reference: Fabric admin portal → **Tenant settings** (the single largest admin surface in Fabric)  
> Loom URL: <https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/admin/tenant-settings>

## Captures

| Loom | Fabric |
|---|---|
| Live capture blocked by session expiry; structure from `apps/fiab-console/app/admin/tenant-settings/page.tsx` | Microsoft Learn — `https://learn.microsoft.com/fabric/admin/tenant-settings-index` (full markdown fetched, parsed below) |

## Phase 1 — What Fabric provides (authoritative count)

Fetched the official `tenant-settings-index` page from Microsoft Learn and parsed it programmatically. Result:

- **25 categorized sections** in Fabric Tenant settings:
  1. Microsoft Fabric
  2. Help and support settings
  3. Workspace settings
  4. Information protection
  5. Export and sharing settings
  6. Discovery settings
  7. Integration settings
  8. Power BI visuals
  9. R and Python visuals settings
  10. Audit and usage settings
  11. Dashboard settings
  12. Developer settings
  13. Admin API settings
  14. Gen1 dataflow settings
  15. Template app settings
  16. Q&A settings
  17. Advanced networking
  18. User experience experiments
  19. Share data with your Microsoft 365 services
  20. Insights settings
  21. Datamart settings
  22. Scale-out settings
  23. OneLake settings
  24. Git integration
  25. Copilot and Azure OpenAI Service

- **~160 individual toggle / setting rows** across those 25 sections (count from parsing the table rows; some sections contain >20 toggles e.g. "Microsoft Fabric" and "Export and sharing settings"; some have 2-3).

Each toggle has:
- Title + (link to learn-more docs page)
- Description text
- **Enabled / Disabled** switch
- **Apply to**: Entire organization / Specific security groups / Except specific groups
- For some: parameter inputs (e.g. "Define maximum number of Fabric identities" takes an int; "Define workspace retention period" takes days)
- Audit log entries on every change (`UpdatedAdminFeatureSwitch` and similar)
- Some toggles can be delegated to capacity-admin or domain-admin level
- Search box at the top to filter across all 25 sections

## Phase 2 — What Loom provides

Source: `apps/fiab-console/app/admin/tenant-settings/page.tsx` (15 lines total, including imports and JSX):

```tsx
export default function TenantSettingsPage() {
  return (
    <AdminShell sectionTitle="Tenant settings">
      <EmptyState icon="⚙"
        title="Loom tenant switches"
        body="Per-area toggles that control what Loom surfaces across the tenant: OneLake, Real-Time Intelligence, AI & Copilot, Mirroring, Synapse passthrough, Databricks passthrough, ADF passthrough, U-SQL legacy enablement, Git integration, Domain management, Information protection, Export & sharing, Help & support, Billing connections (Azure Cost Management hookup for the Capacity page), Purview account binding (for the Governance portal embed)." />
    </AdminShell>
  );
}
```

A single `EmptyState`. **Zero categories. Zero toggles. Zero input fields.** No persistence layer. No backend route (`apps/fiab-console/app/api/admin/tenant-settings/` does not exist). No Cosmos container. No bicep module.

The body text lists ~15 categories that the page *would* control, but none are rendered.

## Phase 3 — Gap matrix (counting)

| Dimension | Fabric | Loom | Severity |
|---|---|---|---|
| Number of categorized sections | **25** | **0** | **BLOCKER** |
| Number of individual toggle rows | **~160** | **0** | **BLOCKER** |
| Per-toggle "Apply to" scope (org / security group / except group) | Yes (every toggle) | Absent | **BLOCKER** |
| Search bar across all toggles | Yes | Absent | MAJOR |
| Persistence backend | Fabric tenant ARM resource | None — no Cosmos, no DB, no file | **BLOCKER** |
| Audit-log emission on toggle change | Yes (logged as `UpdatedAdminFeatureSwitch`) | Absent | BLOCKER |
| Delegation to capacity-admin / domain-admin | Yes (selected toggles) | Absent | MAJOR |
| Honest MessageBar disclosing none of this is implemented + how to set the env-var equivalents | Absent — instead the body lists 15 categories as if the UI could control them | **MAJOR** |

**Loom delivers 0% of Fabric's tenant-settings surface area** — both in terms of categories (0/25) and individual toggles (0/~160).

## Phase 4 — Functional verification

No interactive controls. The page text promises a switchboard; none of the switches exist.

## Grade: **F**

- This is the **single biggest vaporware violation in the admin portal**, by area. Fabric exposes 160+ toggles across 25 categories. Loom shows promotional copy and nothing else.
- Per `.claude/rules/no-vaporware.md` — "Tabs that show static content" + "What's explicitly forbidden — Pre-configured / hard-coded UI values that look like real data but aren't" both apply. The page text *implies* Loom has tenant-level toggles. It does not.
- For a B-grade fix: implement at least the Loom-specific tenant toggles the body promises (OneLake / RTI / AI&Copilot / Mirroring / Synapse / Databricks / ADF / U-SQL legacy / Git / Domains / Info protection / Export & sharing / Help & support / Billing connections / Purview binding) — that's a `loom-tenant-settings` Cosmos container + `/api/admin/tenant-settings` GET/PATCH + a Fluent form. Probably 1-2 sessions of work.
- For A-grade: replicate Fabric's full 25-section / 160-toggle structure with `Apply to` scoping. Not realistic without months of work.
- Until either ships, this is **F**. Anyone reading the page text and seeing zero toggles is in vaporware territory.
