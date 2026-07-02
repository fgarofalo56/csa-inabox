# Fabric → Loom Parity Appendix — Governance, Security & Sovereignty

> Domain: **governance-security**. Scope: Microsoft Purview hub in Fabric (Data
> Map / scanning, classifications, sensitivity labels = MIP, DLP, lineage,
> audit, Information Protection, insights), OneLake catalog governance,
> workspace + item RBAC + sharing, OneLake security (folder/table/RLS/CLS),
> managed private endpoints, VNet data gateway, workspace identity + trusted
> workspace access, tenant/admin governance, domains, endorsement /
> certification, protection policies, data loss prevention.
>
> Cross-cutting rules honored: `no-fabric-dependency.md` (Azure-native default,
> Fabric/Power BI opt-in only), dual-cloud Commercial **and** Government (GCC /
> GCC-High / DoD, IL4/5), **day-one ON** (provisioned + enabled by bicep, user
> disables what they don't want), Web-5.0 Fluent v9 + Loom tokens, no-vaporware
> (every control → real backend).
>
> **This is the most-built domain in Loom.** Nine `/governance/*` surfaces are
> shipped A-grade (per `docs/fiab/parity/MASTER-SCORECARD.md` rev.4), plus the
> Platform/Admin governance surfaces (workspace-roles, networking, audit-logs,
> domains, tenant-settings, sensitivity-labels, batch-labeling, CMK). The gaps
> below are the *remaining* Fabric capabilities the scorecard itself flags as
> "not yet built" (F2/F3/F5–F18) or that grep proves absent.

---

## 1. Fabric capability inventory (grounded in Microsoft Learn)

Each row: what it is, how it actually works (architecture / item model / API),
and the Learn URL. Capabilities are grouped by the Fabric governance pillars.

### A. Microsoft Purview governance plane (mostly licensed add-on)

1. **Purview Data Map / scanning** — Purview's scan engine connects to
   registered sources (Azure DBs, ADLS, AWS S3, on-prem via SHIR, Fabric
   OneLake) and ingests metadata into the Data Map; exposed via Apache **Atlas
   APIs**. Fabric OneLake is *not* auto-scanned — you explicitly register +
   scan the Fabric tenant (same-tenant or cross-tenant). Integration runtime
   choice (Azure IR vs SHIR) per source.
   `https://learn.microsoft.com/purview/register-scan-fabric-tenant`,
   `https://learn.microsoft.com/purview/data-map-scan-ingestion`
2. **Purview Unified Catalog / governance domains / glossary / data products**
   — application layer over Data Map; governance domains, glossary terms,
   data-product publication workflows, data-quality checks on ungoverned
   assets. Data Governance Administrator role gates setup.
   `https://learn.microsoft.com/purview/data-governance-overview`,
   `https://learn.microsoft.com/purview/unified-catalog`
3. **Purview live view** (preview) — data consumers see all Fabric workspaces
   they have Viewer access to, surfaced in the Unified Catalog without an
   explicit scan; manual item-level scans add item metadata (enterprise tier).
   `https://learn.microsoft.com/purview/live-view`
4. **Purview Audit** — every Fabric user activity is logged to the unified
   audit log (Standard + Premium; 1-yr / 10-yr retention tiers).
   `https://learn.microsoft.com/fabric/admin/track-user-activities`
5. **Purview Insider Risk Management (IRM)** — ready-made Fabric risk
   indicators (Power BI export, lakehouse/warehouse exfiltration) feed
   data-theft policies.
   `https://learn.microsoft.com/purview/insider-risk-management-settings-policy-indicators`
6. **Purview DSPM for AI / Copilot governance** — risk discovery in
   prompts/responses, audit + retention + eDiscovery over Fabric Copilot/agents.
   `https://learn.microsoft.com/purview/ai-microsoft-purview`

### B. Information Protection (MIP sensitivity labels)

7. **Sensitivity labels (MIP) on Fabric items** — labels defined in the Purview
   compliance portal (taxonomy: Public→Highly Confidential), enabled per-tenant
   via Fabric admin tenant setting "Allow users to apply sensitivity labels".
   Apply via item header flyout or item settings. Metadata-only **or**
   protective (encryption + usage rights).
   `https://learn.microsoft.com/fabric/governance/information-protection`,
   `https://learn.microsoft.com/fabric/fundamentals/apply-sensitivity-labels`
8. **Label capabilities**: manual, **default labeling** (tenant + workspace +
   domain scope), **mandatory labeling** (block save w/o label), **programmatic**
   (Power BI admin REST `SetLabelsAsAdmin`/`RemoveLabelsAsAdmin`), **downstream
   inheritance**, **inheritance on create**, **inheritance from data source**,
   **export persistence**.
   `https://learn.microsoft.com/fabric/governance/information-protection#capabilities`
9. **Protected sensitivity labels** — labels with file-protection policies
   (usage rights: OWNER/EXPORT/EDIT/EDITRIGHTSDATA/VIEW…) control who may
   change/remove a label and encrypt `.pbix` content.
   `https://learn.microsoft.com/fabric/governance/protected-sensitivity-labels`
10. **Protection policies** (preview) — a Purview *access-control* policy bound
    to ONE encryption-capable label; allows listed users/groups to retain
    permissions on labeled items while **blocking everyone else**. Created by
    Information Protection Admin in Purview portal; ≤50 policies, ≤100
    principals; up to 24 h to take effect; no guest/external; not in CI/CD.
    Supported on all native Fabric items + PBI semantic models.
    `https://learn.microsoft.com/fabric/governance/protection-policies-overview`,
    `https://learn.microsoft.com/fabric/governance/protection-policies-create`

### C. Data Loss Prevention (DLP)

11. **DLP policies for Fabric & Power BI** — defined in Purview DLP; conditions =
    sensitivity labels + sensitive info types (SITs, 1–500 instance counts +
    confidence); item types: semantic models, lakehouse, warehouse, KQL DB,
    mirrored DB, SQL DB, Cosmos DB. Actions: policy tip, alert, **restrict
    access** (preview). Evaluated on publish/refresh (models) and on data
    change (items); simulation mode supported.
    `https://learn.microsoft.com/purview/dlp-powerbi-get-started`,
    `https://learn.microsoft.com/fabric/governance/data-loss-prevention-configure`

### D. Discovery / trust / catalog

12. **OneLake catalog (Explore + Govern tabs)** — find/explore Fabric items you
    can access; Govern tab = insights (estate inventory, label coverage, DLP
    coverage, freshness, endorsement, sharing) + recommended actions + Copilot,
    scoped by domain; admin vs data-owner views.
    `https://learn.microsoft.com/fabric/governance/onelake-catalog-govern`
13. **Endorsement** — **Promote** (any writer), **Certify** (authorized
    security groups, tenant-enabled, delegable to domain admins, request flow),
    **Master data** (authorized, data items only). Badges across Fabric +
    sort/priority in lists.
    `https://learn.microsoft.com/fabric/governance/endorsement-overview`,
    `https://learn.microsoft.com/fabric/admin/endorsement-certification-enable`
14. **Tags** — admin-defined tag taxonomy applied to items for
    discovery/search/filter.
    `https://learn.microsoft.com/fabric/governance/tags-overview`
15. **Lineage view + impact analysis** — workspace-scoped graph of item↔item +
    one-level-up external + data sources; impact analysis shows downstream
    children/all-downstream by type or workspace + Notify-contacts email;
    privacy-trimmed ("Limited access").
    `https://learn.microsoft.com/fabric/governance/lineage`,
    `https://learn.microsoft.com/fabric/governance/impact-analysis`
16. **Metadata scanning (scanner APIs)** — admin REST scanner APIs extract item
    name/id/sensitivity/endorsement for external catalogs.
    `https://learn.microsoft.com/fabric/governance/metadata-scanning-overview`

### E. Access / permission model

17. **Workspace roles** — Admin / Member / Contributor / Viewer; apply to all
    items; assignable to users or groups.
    `https://learn.microsoft.com/fabric/security/permission-model`
18. **Item permissions / sharing** — share grants Read by default; per-item
    grades: Read / Edit / Share / ReadAll (SQL endpoint) / Read-all-Spark /
    Build (model) / Execute / Subscribe-OneLake-events; "Manage permission" →
    Direct access; can't modify role-inherited perms; 2-h revoke latency.
    `https://learn.microsoft.com/fabric/fundamentals/share-items`
19. **OneLake security (data-access roles)** (preview) — RBAC over OneLake
    folders/tables/schemas; deny-by-default GRANT roles; Read / ReadWrite;
    **DefaultReader/DefaultReadWriter** virtualized default roles; row-level +
    column-level + object(folder/table)-level security; supported on Lakehouse,
    ADB Mirrored Catalog, Mirrored DB. Manage via "Manage OneLake security".
    `https://learn.microsoft.com/fabric/onelake/security/data-access-control-model`,
    `https://learn.microsoft.com/fabric/onelake/security/get-started-onelake-security`
20. **SQL-surface security** — RLS / CLS / OLS / dynamic data masking on
    warehouse + SQL analytics endpoint + SQL DB.
    `https://learn.microsoft.com/fabric/data-warehouse/column-level-security`
21. **External data sharing** — cross-tenant in-place share of OneLake data
    (the supported successor to Purview Data Sharing).
    `https://learn.microsoft.com/fabric/governance/external-data-sharing-overview`

### F. Network security & identity

22. **Workspace identity** — auto-managed service principal per workspace
    (F-SKU); obtains Entra tokens, no secrets; outbound auth to Entra resources.
    `https://learn.microsoft.com/fabric/security/workspace-identity`
23. **Trusted workspace access** — workspace-identity + resource-instance rules
    let firewalled ADLS Gen2 be reached from OneLake shortcuts / pipelines /
    semantic models / COPY / AzCopy (Spark uses MPE instead).
    `https://learn.microsoft.com/fabric/security/security-trusted-workspace-access`
24. **Managed private endpoints + managed VNets** — workspace admin creates MPEs
    (resource id + subresource + justification → approval) inside a
    Fabric-managed VNet; isolates Spark; supports ADLS/SQL/etc.
    `https://learn.microsoft.com/fabric/security/security-managed-private-endpoints-overview`
25. **VNet data gateway / on-prem data gateway** — connect to Azure-VNet or
    on-prem sources without managing infra (dataflows/pipelines).
    `https://learn.microsoft.com/data-integration/vnet/overview`
26. **Private Link inbound / service tags / Conditional Access** — tenant inbound
    protection.
    `https://learn.microsoft.com/fabric/security/protect-inbound-traffic`

### G. Admin / tenant governance

27. **Admin portal + tenant/domain/workspace settings** — delegable controls.
    `https://learn.microsoft.com/fabric/admin/about-tenant-settings`
28. **Domains / subdomains (data mesh)** — group workspaces; domain admin /
    contributor roles; delegate tenant settings; assign by name/owner/capacity;
    sync role assignments to subdomains; OneLake catalog domain filter.
    `https://learn.microsoft.com/fabric/governance/domains`
29. **Capacities** as compute/isolation/chargeback boundaries.
30. **Privacy, encryption (CMK), customer lockbox** — tenant data-protection.

**featureCount ≈ 30 capability families (≈ 55 sub-capabilities).**

---

## 2. Sovereignty matrix — Commercial vs Government

| Capability | Commercial | Gov (GCC / GCC-High / DoD) | Loom Gov substitute |
|---|---|---|---|
| Purview **classic Data Map** | ✅ | ✅ Azure Gov (AZ/VA/TX regions), `purview.azure.us` | already wired (`purview-client.ts` isGov→`purview.azure.us`) |
| Purview **Unified Catalog / new gov** | ✅ | ⚠️ limited / rolling | Loom-native Cosmos catalog (default) |
| MIP **sensitivity labels** | ✅ | ✅ GCC/GCC-High/DoD | MIP Graph (`graph.microsoft.us`) + Cosmos taxonomy |
| **Protection policies** (label→block) | ✅ preview | ❌ not in GCC-High/DoD | **Loom Label-Protection engine** (RBAC enforcement, no Purview) |
| **DLP** for Fabric | ✅ | ✅ (M365 DLP available GCC-High) | `scc-dlp` + Loom native SIT scan over ADLS/SQL |
| **IRM** | ✅ | ⚠️ in-dev some indicators | Sentinel/Defender UEBA + Loom audit-log risk rules |
| OneLake security / item sharing | ✅ | n/a (no real Fabric) | ADLS ACL + Synapse RLS/CLS/DDM + ADX RLS (cloud-agnostic) |
| Managed private endpoints | ✅ | ✅ | real ARM PE in DLZ managed VNet (`network.bicep`) |
| AOAI for Govern Copilot | ✅ | ✅ AOAI Gov (subset of models) | Foundry Gov deployment; degrade to non-Copilot if absent |
| Fabric itself / Power BI workspace | ✅ opt-in | ⚠️/❌ | **never on default path** (rule) |

Gov posture: private-only networking (PE + P2S VPN, no public firewall IP rules
on private ranges — see VPN memory), `.us` endpoints throughout, IL4/IL5 via
DoD regions, all governance state in in-region Cosmos + ADLS.

---

## 3. Loom coverage (honest: built / stubbed / missing)

> "Stubbed" = client/route/page present but the Fabric-parity workflow is
> incomplete per `MASTER-SCORECARD.md` rev.4 ("F2/F3/F5–F18 not yet built") or
> grep-absent UI.

### Built (A-grade, default-path, Fabric-unbound) — keep, do not rebuild
- `/governance` landing + posture — `governance-overview.md`
- Data catalog (Explore/Unified) — `governance-catalog.md`; `governance-catalog-index.ts`, `onelake-catalog-client.ts`
- Classifications + label taxonomy — `governance-classifications.md`
- Insights & reports (Govern/Data-Health) — `governance-insights.md`
- Lineage + impact — `governance-lineage.md`; `unified-lineage.ts` (705 ln)
- Access & DLP policies — `governance-policies.md`; `access-policy-client.ts` (real Storage RBAC + Synapse `sp_addrolemember` over TDS + ADX), `dlp-graph-client.ts` (620 ln), `scc-dlp-client.ts`
- Microsoft Purview connection — `governance-purview.md`; `purview-client.ts` (2144 ln, gov-aware), `purview-unified-client.ts`
- Data Map scans & sources — `governance-scans.md` (Purview honest-gate by nature)
- Sensitivity labels (MIP) — `governance-sensitivity.md`; `mip-graph-client.ts`, `scc-labels-client.ts`, `purview-mip-client.ts`, `label-protection.ts`
- Workspace roles (Manage access) — `workspace-roles.md`; `rbac-client.ts` + ARM
- Domains / subdomains — `domains.md`; `/api/governance/domains/*` (assign workspaces)
- Audit logs — `audit-logs.md`; Cosmos `audit-log`
- Networking & Private DNS discovery — `networking.md`; `network-discovery.ts` (949 ln, real ARM PE enumeration), `network-topology-graph.ts`
- CMK encryption — `cmk.md`
- Batch labeling (partial) — `app/admin/batch-labeling/page.tsx` + `/api/governance/label-propagation`
- Data quality + MDM (Azure-native, no Fabric) — `data-quality-run-results.md`, `master-data.md`
- IRM surface — `/governance/irm` (Purview-gated)

### Stubbed (present-but-incomplete) → BUILD OUT
- **Protection policies** — `label-protection.ts` (289 ln) exists but no
  label→access *enforcement* policy engine + UI (P0, gap G1).
- **OneLake security data-access roles** — `onelake-security-client.ts` (306),
  `onelake-security-rules.ts`, `/api/items/[type]/[id]/security-roles` exist;
  scorecard says F7–F10 UI **not yet built** (P0, G2).
- **Item sharing / granular permissions dialog** — `item-permissions-client.ts`
  (386 ln, real ADLS ACL + Fabric REST) exists; F6 share dialog **not built**
  (P0, G3).
- **Endorsement / certification workflow** — endorse hints in catalog route;
  no badge service + authorized-certifier admin + request flow (P1, G4).
- **SQL granular security designer** (RLS/CLS/OLS/DDM) — `policies/page.tsx`
  (967 ln) has mask/RLS wizard; full OLS + DDM designer F11 **partial** (P1, G7).
- **Label inheritance / default / mandatory policy** — batch-labeling +
  label-propagation routes exist; default/mandatory/downstream F15–F18
  **partial** (P1, G8).
- **Govern tab Admin/Owner sub-tabs + recommended-action remediation** F2/F3
  (P1, G10).

### Missing (grep-clean zero files) → BUILD
- **Managed private endpoint self-service create** (workspace-settings MPE
  wizard + approval poll) — only discovery exists (P0, G5).
- **Trusted workspace access / resource-instance-rule wizard** (P1, G6).
- **Tags taxonomy admin** (Fabric tags) — folded into classifications? verify
  (P2, G11).
- **Metadata scanner-API config surface** (admin) (P2, G12).
- **External-data-sharing governance register** (cross-tenant share audit) —
  marketplace has sharing; governance register thin (P2, G13).

---

## 4. Build specs per gap

Each gap: architecture (words), Web-5.0 UI, BFF API, Azure backend, bicep /
deploy, day-one config, Commercial vs Gov, acceptance criteria.

### G1 (P0) — Protection Policies engine (label → access enforcement)
**Why:** Fabric's protection policies (block all but listed principals on items
with label X) are **not available in GCC-High** — Loom must own this natively.
**Architecture:** A `LabelProtectionPolicy` Cosmos doc binds a sensitivity
label id → (allowed principals[], retain-full-control flag, mode on/off). A
Console-UAMI reconciler translates the policy into **real** Azure RBAC on every
backing store of every item carrying that label: ADLS Gen2 (Storage Blob Data
Reader/Contributor RBAC + container ACL revoke for non-allowed), Synapse SQL
(`DENY`/role membership), ADX (database principal removal), and the Loom item
grant doc (revoke). Label-issuer exemption preserved (mirrors Fabric). Runs on
policy save + on label-apply event (label-propagation route hook).
**UI (Web-5.0):** `/governance/policies` new "Protection" tab — wizard:
(1) pick label (Dropdown from MIP taxonomy), (2) Add users/groups
(Graph people-picker), (3) retain-full-control toggle, (4) mode On/Off, (5)
review card. Copilot builder: "Block everyone except Finance-Readers on
Confidential" → fills wizard. Policy list = cards w/ status chip + affected-item
count.
**API:** `POST/GET/PATCH/DELETE /api/governance/protection-policies`,
`POST .../{id}/reconcile` (returns per-store receipt). `GET .../{id}/restricted`
lists blocked principals (parity with "view restricted users").
**Azure backend:** `access-policy-client.ts` (extend) + `rbac-client.ts` +
`onelake-security-client.ts` + `item-permissions-client.ts` + `mip-graph-client.ts`.
**Bicep/deploy:** none new (uses Console UAMI Storage/Synapse/ADX roles already
granted); add Cosmos container `protection-policies` via `createIfNotExists`.
**Day-one ON:** ship one disabled sample policy on "Highly Confidential";
engine enabled, zero policies = no-op.
**Commercial vs Gov:** identical (no Purview dependency); Gov is the *primary*
use case. **Acceptance:** apply label → non-allowed principal loses real
SQL/ADLS read (verified via TDS + `az storage` probe), label-issuer retains.

### G2 (P0) — OneLake security data-access roles (folder/table OLS + RLS/CLS)
**Architecture:** Map Fabric OneLake roles → ADLS POSIX ACLs (folder/file) +
Synapse SQL **RLS** (security predicate functions) + **CLS** (`GRANT … (cols)`)
+ **DDM** + ADX RLS over the lakehouse/warehouse backing store. Deny-by-default;
virtualized DefaultReader = "all principals with workspace Read".
**UI:** `/onelake` item → "Manage OneLake security" panel: role list, New role
wizard (name → All/Selected folders via a **tree picker** of `Tables/`+`Files/`
→ Read/ReadWrite → Assign members via Graph picker or virtual "by workspace
role"). RLS/CLS sub-tab: column multiselect + predicate builder (1:1 expression
surface allowed).
**API:** `/api/items/[type]/[id]/security-roles` (extend: folders[], rls, cls,
ddm), `.../preview-as` (test-as-user).
**Backend:** `onelake-security-client.ts`, `onelake-security-rules.ts`,
`adls-client`, `synapse-sql-client`, `kusto-client`.
**Bicep:** none new. **Day-one:** DefaultReader/DefaultReadWriter created with
every lakehouse provision. **Gov:** identical (ADLS/Synapse/ADX exist in Gov).
**Acceptance:** Viewer with custom role reads only granted folder; column
masked in SQL endpoint.

### G3 (P0) — Item sharing / granular permission dialog
**Architecture:** Fabric Share dialog → Loom grant doc + real ACL/GRANT.
Permission grades Read/Edit/Share/ReadAll/Read-all-Spark/Build/Execute map to
ADLS ACL bits + Synapse role + Cosmos `item-grants`.
**UI:** reusable `<ShareItemDialog>` (header "Share" button on every item
editor): people-picker, permission checkboxes (item-type-aware), notify-email
toggle, "Direct access" management table (modify/remove, role-inherited rows
locked — parity).
**API:** `POST /api/items/[type]/[id]/share`, `GET/DELETE .../permissions`.
**Backend:** `item-permissions-client.ts` (already real). **Day-one ON.**
**Gov:** identical. **Acceptance:** share Read → recipient sees item, no SQL;
grant ReadAll → SQL endpoint works; revoke reflects within client refresh.

### G4 (P1) — Endorsement & certification
**Architecture:** `endorsement` field on item docs (None/Promoted/Certified/
MasterData) + tenant-setting `certifierGroups[]` + `masterDataGroups[]` +
delegation to domain admins; request-certification → audit-log + notify.
**UI:** endorsement section in every item settings + catalog badges + sort;
admin enablement under `/admin/tenant-settings` (toggle + security-group
picker + policy URL). **API:** `PATCH /api/items/[type]/[id]/endorsement`,
`/api/admin/endorsement-settings`. **Backend:** Cosmos + Graph group check.
**Day-one ON** (promote open to writers; certify gated to a default group).
**Gov:** identical. **Acceptance:** certify badge shows in catalog + sorts
first; unauthorized user sees greyed Certify + request link.

### G5 (P0) — Managed private endpoint self-service
**Architecture:** Workspace-settings "Managed private endpoints" → real ARM
`Microsoft.Network/privateEndpoints` create against the **DLZ managed VNet**
subnet, target resource id + subresource (blob/sql/etc.) + justification;
approval poll on `privateLinkServiceConnections[].privateLinkServiceConnectionState`.
**UI:** `/admin/network` MPE tab: list (status chips Pending/Approved/Rejected)
+ Create wizard (resource picker via Resource Graph → subresource dropdown →
justification). **API:** `POST/GET/DELETE /api/network/managed-private-endpoints`.
**Backend:** `network-discovery.ts` (extend to create), ARM. **Bicep:**
managed-VNet subnet in `network.bicep` (day-one). **Gov:** identical (ARM PE in
Gov). **Acceptance:** create PE → ARM resource exists + status polled; Spark/SQL
reaches PE-only source (mirrors live managed-VNet fix in memory).

### G6 (P1) — Trusted workspace access / resource-instance rules
**Architecture:** Wizard writes ADLS `networkAcls.resourceInstances[]` (or RBAC
+ resource-instance rule) authorizing the Console UAMI / workspace identity to a
firewalled storage account; status surfaced. **UI:** `/admin/network` "Trusted
access" tab. **API:** `/api/network/trusted-access`. **Backend:** ARM storage
PATCH. **Day-one:** DLZ lake pre-authorized. **Gov:** identical.
**Acceptance:** shortcut/pipeline reads firewalled ADLS with public access off.

### G7 (P1) — SQL granular security designer (OLS + DDM completion)
Extend `policies/page.tsx`: object-level GRANT/DENY designer + Dynamic Data
Masking (mask functions: default/email/partial/random) over Synapse SQL.
Backend `synapse-permissions-client.ts` (exists). Acceptance: masked column
returns mask for non-privileged TDS session.

### G8 (P1) — Label inheritance / default / mandatory policies
Engine: default-label policy (tenant/workspace/domain scope) applied on create;
mandatory-label gate blocks save; downstream + on-create + from-source
inheritance propagator (extend `/api/governance/label-propagation`). UI under
`/admin/sensitivity-labels`. Acceptance: new item auto-labeled; save blocked
without label when mandatory on.

### G10 (P1) — Govern tab Admin/Owner sub-tabs + remediation actions
Complete `/governance/govern` F2/F3: admin (tenant-wide) vs owner (My items)
views + recommended-action cards that execute (apply label, request scan,
endorse) via existing routes. Acceptance: action card runs real backend +
updates posture.

### G11–G13 (P2)
- **G11 Tags admin** — admin tag taxonomy + item tagging + catalog filter.
- **G12 Metadata scanner config** — admin surface exposing the Cosmos catalog
  "scanner" (incremental modifiedSince) + optional Purview scanner trigger.
- **G13 External-data-sharing governance register** — cross-tenant Delta
  Sharing audit/lineage register (complements marketplace).

---

## 5. Acceptance (per merge, per `no-fabric-dependency.md` §Verification)
Every gap PR must show the surface working with `LOOM_DEFAULT_FABRIC_WORKSPACE`
UNSET and no Purview account, with a real Azure backend receipt (ADLS ACL /
Synapse TDS / ARM PE / Graph) in the PR body, plus a Gov-cloud note. Purview /
MIP / DLP legs may remain the *allowed* honest opt-in gate (`PurviewGate` names
env var + bicep module + UAMI role) — never the default path.

## 6. Sources
See inline Learn URLs in §1 (Purview Data Map, Information Protection,
protection policies, DLP, OneLake catalog/govern, endorsement, lineage/impact,
permission model, share-items, OneLake security model, workspace identity,
trusted workspace access, managed private endpoints, domains, GCC-High Purview
plan) + `docs/fiab/parity/MASTER-SCORECARD.md` (rev.4 governance section) +
`apps/fiab-console/lib/azure/*` governance clients.
