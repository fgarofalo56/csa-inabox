# workspace-create — parity with Fabric Create workspace

Source UI: Fabric **Workspaces → New workspace** pane
Reference: <https://learn.microsoft.com/fabric/fundamentals/create-workspaces>
Run date: 2026-08-06 (re-baselined; supersedes the 2026-06-09 single-step run)

Loom surfaces:

- Wizard: `lib/wizards/workspace-create.tsx` → `WorkspaceCreateWizard`
  (5 steps: Basics → Contacts → License mode → Capacity → Advanced)
- Mounted on **both** create surfaces:
  - user-facing `app/workspaces/page.tsx` (`NewWorkspaceButton`, header action
    + the no-workspaces `EmptyState` CTA) → `POST /api/workspaces`
  - admin `app/admin/workspaces/page.tsx` (`isAdmin`) → `POST /api/admin/workspaces`
- BFF: `app/api/workspaces/route.ts` and `app/api/admin/workspaces/route.ts`
  (POST) — the two accept an IDENTICAL body; see the contract spec at
  `app/api/workspaces/__tests__/create-wizard-contract.test.ts`
- Bindings: `lib/azure/workspace-bindings.ts` → `applyWorkspaceBindings()`
- Capacity assignment: `lib/azure/fabric-client.ts` → `assignWorkspaceToCapacity()`
- Settings flyout (the create pane's sibling): see `workspace-create-settings.md`

A workspace is created **Azure-native** as a Cosmos `workspaces` record; the
capacity assignment, Purview domain registration, per-workspace identity, and
optional dedicated backing resource group are best-effort side-effects that
never block creation. Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset
(`no-fabric-dependency.md`) — the default `Org` license mode requires no Power
BI / Fabric license at all.

## Fabric/Azure feature inventory (grounded in Learn)

1. Workspace name (required) + description
2. Contact list (workspace contacts)
3. License mode (Trial / Pro / Premium / PPU / Embedded)
4. Assign to a capacity
5. Advanced: domain, default OneLake storage
6. Review before create; land in the new workspace on success

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| Name (required) | ✅ Built — Step 1 | `POST /api/workspaces` body.name → Cosmos `workspaces` |
| Description | ✅ Built — Step 1 | body.description |
| Contact list (Entra people picker) | ✅ Built — Step 2 | `GET /api/admin/permissions/principals?kind=user` (Graph) → persisted `contacts[]` |
| License mode | ✅ Built — Step 3 option cards | persisted `licenseMode`; Azure-native `Org` is the default; Trial hidden in Gov |
| Capacity picker (real capacities) | ✅ Built — Step 4 dropdown | `GET /api/admin/scaling/capacity`; required only for the Premium-family modes |
| Governance domain (required, t158) | ✅ Built — Step 5 dropdown | `GET /api/admin/domains` → Cosmos; server falls back to the seeded `default` domain |
| Default OneLake / ADLS storage account | ✅ Built — Step 5 dropdown | `GET /api/storage/accounts` (ARM discovery) → persisted `storageAccountId` |
| Dedicated backing resource group (Loom add-on; no Fabric analog) | ✅ Built — Step 5 checkbox | ARM PUT `/resourceGroups/{name}` via UAMI inside `applyWorkspaceBindings` |
| Review before create | ✅ Built — Step 5 review grid | — |
| Redirect to workspace on success | ✅ Built | `router.push('/workspaces/${ws.id}')` |
| Capacity assignment side-effect | ✅ Built | `applyWorkspaceBindings` → `assignWorkspaceToCapacity()` (or queued status) |
| Per-workspace managed identity (I1) | ✅ Built | `applyWorkspaceBindings` → `workspaceIdentity` status (records `skipped` when the mode is off) |
| SIEM audit event on create | ✅ Built | `emitAuditEvent({ action: 'workspace.create' })` on **both** routes |
| Domain registration → Purview mirror | ⚠️ Honest gate | `registerAtlasEntity`; `PurviewNotConfiguredError` captured into `domainRegistration.status`, never blocks create |

Zero ❌ rows. The single ⚠️ gate (Purview mirror) is best-effort and surfaced as
a status field; the workspace is fully created without Purview.

## No-freeform-config note (why the old dialog was replaced)

Until 2026-08-06 the user-facing `/workspaces` page used a separate single-step
`CreateWorkspaceDialog` which:

- offered only name / description / capacity / domain — no contacts, license
  mode, OneLake storage, backing-RG, or review step; and
- **fell back to free-text `Input`s for capacity and domain** whenever their
  upstream lookup failed, which `loom_no_freeform_config` forbids (config is
  dropdowns/pickers, never typed identifiers).

Meanwhile `POST /api/workspaces` destructured only
`{ name, description, capacity, domain }`, so the four extra wizard fields would
have been silently dropped had the wizard been mounted there. Both are fixed:
the wizard is now the single create experience on both surfaces, and the user
route parses the full body identically to the admin route. A third, orphaned
copy of the dialog (`lib/panes/workspaces.tsx`, exported but imported by
nothing) was deleted — it was the surface that made earlier audits report
FGC-31 as "still a single-step Dialog".

## Backend per control

- **Create** — `POST /api/workspaces` (or `/api/admin/workspaces`) writes a
  `workspaces` record (id, name, description, domain, capacity, licenseMode,
  contacts, storageAccountId, owner, tenantId) to Cosmos, then calls
  `applyWorkspaceBindings(resource, { provisionBackingRg })` which (a) assigns
  the workspace to its capacity, (b) attempts a Purview/Atlas domain
  registration, (c) mints the per-workspace identity, and (d) provisions the
  dedicated backing RG when opted in. Every side-effect is wrapped so a failure
  records a status and the create still returns 201.
- **Contacts picker** — `GET /api/admin/permissions/principals` (Graph search).
- **Capacity picker** — `GET /api/admin/scaling/capacity`; enumerates real
  capacities only when the Fabric capacity backend is opted in, otherwise the
  step stays empty and optional (Azure-native default).
- **Domain picker** — reuses the `domains.md` Cosmos source.
- **Storage picker** — `GET /api/storage/accounts` (ARM storage discovery).

## Per-cloud notes

| Cloud | Notes |
|---|---|
| Commercial | All 6 license modes offered; real capacities enumerated when the Fabric capacity backend is opted in |
| GCC | Power BI P-SKU only (P1/P2/P3) reflected; no F-SKU |
| GCC-High | Fabric **Trial** license mode hidden (`govHidden`); capacity step stays optional |
| IL5 | Same as GCC-High; Purview mirror targets `.purview.azure.us` |

## Bicep sync

- No new resource — uses the existing `workspaces` Cosmos container.
- No new env var (`check-env-sync` exit 0); Purview mirror reuses the
  `loomPurviewAccount` param already wired for the domains/governance surfaces;
  the backing-RG prefix reuses the existing optional `LOOM_WORKSPACE_RG_PREFIX`.

## Verification

- Default path works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset — the create
  succeeds and lands in the new workspace even when no capacity/domain/Purview
  is bound (server falls back to the seeded `default` domain).
- Contract spec: `app/api/workspaces/__tests__/create-wizard-contract.test.ts`
  (6 tests) proves each wizard field reaches the persisted doc / the bindings
  call. Mutation-proved 2026-08-06: reverting the route to the old narrow parse
  turns 4 of the 6 red.
- Live walk (G1, owed post-merge): open `/workspaces`, click **New workspace**,
  walk all 5 steps, submit, confirm redirect to `/workspaces/{id}`, the record
  appears in both `/workspaces` and `/admin/workspaces`, and the settings drawer
  shows the persisted licenseMode/contacts. Narrow-width pass on the step rail +
  first-open pass (no error banner on step 1 of a fresh wizard).

Grade: **A** — real Cosmos create + best-effort Azure bindings on both
surfaces; only the Purview mirror is honest-gated. Pending the live G1 receipt
for A+.
