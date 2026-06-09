# workspace-create-settings — parity with the Fabric "Create a workspace" pane + Workspace settings

Source UI (Fabric):
- Create a workspace — https://learn.microsoft.com/fabric/fundamentals/create-workspaces
- Workspace settings (License info / Teams and SharePoint / OneLake storage) — https://learn.microsoft.com/fabric/fundamentals/workspaces

Loom surfaces:
- Create wizard: `apps/fiab-console/lib/wizards/workspace-create.tsx`
- Settings flyout: `apps/fiab-console/lib/panes/workspace-settings.tsx`
- Wired into `apps/fiab-console/app/admin/workspaces/page.tsx` (F7 = new, F8 = settings, row click = settings)

## Create wizard — Fabric feature inventory → Loom coverage

| Fabric capability | Loom coverage | Backend per control |
|---|---|---|
| Name (required) | ✅ Step 1 Input | POST `/api/admin/workspaces` → Cosmos `workspaces` doc |
| Description | ✅ Step 1 Textarea | same POST |
| Contact list (assign workspace contacts) | ✅ Step 2, Entra people picker → tag list | `GET /api/admin/permissions/principals?kind=user` (Graph); persisted as `contacts[]` |
| License mode (Trial / Pro / Premium / PPU / Embedded) | ✅ Step 3 option cards (+ Azure-native `Org` default) | persisted as `licenseMode`; Trial hidden in Gov |
| Capacity (assign Premium/Fabric capacity) | ✅ Step 4 dropdown of REAL capacities | `GET /api/admin/scaling/capacity` (Fabric REST `/v1/capacities`); honest gate on 401/403/503 |
| Advanced → governance domain | ✅ Step 5 dropdown | `GET /api/admin/domains` (Cosmos) |
| Advanced → default storage / OneLake account | ✅ Step 5 dropdown of REAL ADLS accounts | `GET /api/storage/accounts` (ARM storage discovery) |
| Dedicated backing resource group (Loom add-on, no Fabric analog) | ✅ Step 5 checkbox | ARM PUT `/resourceGroups/{name}` via UAMI (Contributor) |
| Review before create | ✅ Inline review grid on Step 5 | — |

## Settings flyout — Fabric feature inventory → Loom coverage

| Fabric settings panel | Loom tab | Backend per control |
|---|---|---|
| General (name, description) | ✅ General | PATCH `/api/admin/workspaces/{id}` → Cosmos |
| License info (mode + capacity) | ✅ License | PATCH `/api/admin/workspaces/{id}`; capacity change → `assignWorkspaceToCapacity` best-effort (queued on Azure-native default) |
| Teams and SharePoint (M365 group) | ✅ Teams & SharePoint | `POST /api/admin/workspaces/{id}/m365` — link / create / unlink a REAL Microsoft 365 group (Graph); SharePoint site URL from `/groups/{id}/sites/root` |
| OneLake storage (usage + storage binding) | ✅ OneLake storage | `GET /api/admin/workspaces/{id}/storage-metrics` (Azure Monitor: BlobCapacity / BlobCount / ContainerCount / IndexCapacity on `…/blobServices/default`); binding via PATCH |

## No-Fabric-dependency compliance

- The default create + settings path persists ONLY to Cosmos and (optionally) Azure-native services (ARM RG, ADLS metrics via Monitor, M365 group via Graph). It works with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET.
- Capacity binding (`listFabricCapacities` / `assignWorkspaceToCapacity`) is strictly opt-in and honest-gated; the workspace is fully functional with no capacity bound.
- `licenseMode` is metadata only — the Azure-native path never enforces a Power BI / Fabric license.

## Honest infra-gates (no vaporware)

| Condition | Surface | Remediation shown |
|---|---|---|
| Fabric capacity API not authorized | Capacity step / License tab | "Set LOOM_UAMI_CLIENT_ID and enable 'Service principals can use Fabric APIs'…" |
| Graph people/group search not consented | Contacts step / M365 tab | Exact `az ad sp permission add` command (User.Read.All / Group.Read.All) |
| M365 group **creation** not enabled | M365 tab | "Set LOOM_WORKSPACE_M365_LINK=true and grant Group.ReadWrite.All…" |
| Storage account listing denied | Advanced step / OneLake tab | "Grant the Console UAMI Reader on the subscription…" |
| ADLS metrics not configured / Monitoring Reader missing | OneLake tab | Names LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG / LOOM_ADLS_ACCOUNT + Monitoring Reader |
| Backing-RG provision denied | Create receipt (`backingRgProvision.error`) | "grant the Console UAMI Contributor at subscription scope" |

## Bicep sync

- `platform/fiab/bicep/modules/admin-plane/main.bicep` — new params `loomWorkspaceM365LinkEnabled`, `loomWorkspaceRgPrefix`; env vars `LOOM_WORKSPACE_M365_LINK`, `LOOM_WORKSPACE_RG_PREFIX`.
- `platform/fiab/bicep/modules/admin-plane/identity-graph-rbac.bicep` — documents the additional `Group.ReadWrite.All` Graph AppRole (62a82d76-70ea-41e2-9197-370581804d09) when `workspaceM365LinkEnabled`.

## Verification

- `npx tsc --noEmit` — clean (touched files).
- `vitest` — `lib/azure/__tests__/workspace-create-helpers.test.ts` (5/5) covers `backingRgName` + `mailNicknameFor`.
- E2E receipt: POST `/api/admin/workspaces` persists a Cosmos workspace doc; OneLake-storage tab reads live Azure Monitor metrics on the bound/default ADLS account; M365 tab links a real Entra group.
