# sensitivity-label-flyout — parity with the Microsoft 365 / Purview "Sensitivity" label picker

**Loom surface:** Sensitivity-label flyout (F12), reached from the shield button
in every item editor's chrome action row (`ItemSidePanel`).
**Source UI:** the "Sensitivity" picker exposed by Office / Microsoft Purview
Information Protection on a document, and the Purview compliance-portal
Information Protection labels list.
**Backend:** Microsoft Graph Information Protection (`/beta/security/informationProtection/sensitivityLabels`),
Cosmos (`items.state` + `label-assignments` + `audit-log`), Microsoft Purview
Atlas (`/datamap/api/atlas/v2/entity`).

This is Azure-native by default: the taxonomy is Microsoft 365 / Purview
Information Protection — there is NO Microsoft Fabric or Power BI dependency, and
the flyout never gates on `fabricWorkspaceId`.

## Azure / Microsoft 365 feature inventory (the label picker)

| # | Capability in the real picker | Grounding |
|---|-------------------------------|-----------|
| 1 | Show the tenant's published sensitivity labels, ordered by sensitivity (low → high) | Graph `sensitivityLabels`, `sensitivity` field |
| 2 | Per-label name + description / tooltip text shown to the user | `displayName`, `description`, `tooltip` |
| 3 | Per-label color swatch | `color` |
| 4 | Indicate the currently-applied label | applied-label state on the asset |
| 5 | Grey out / disallow labels the active label policy blocks for manual application, with the policy reason | `isAppliable` = false; reason carried in `tooltip`/`description` |
| 6 | Apply a chosen label and persist it onto the asset | label written to the document/asset metadata |
| 7 | Remove / clear the applied label | "Remove label" / set to none |
| 8 | Only show active (published) labels | `isActive` |

## Loom coverage

| # | Capability | Status | Where |
|---|-----------|--------|-------|
| 1 | Labels listed live from Graph, sorted by `sensitivity` | ✅ built | `route.ts` GET sorts + filters; `label-flyout.tsx` renders `RadioGroup` |
| 2 | Name + description/tooltip shown | ✅ built | `label-flyout.tsx` label rows + `Radio` label |
| 3 | Color swatch | ✅ built | `label-flyout.tsx` `styles.swatch` (per-label `color`) |
| 4 | Current label badged | ✅ built | "Applied" `Badge color="brand"` + current-label caption |
| 5 | Policy-blocked labels greyed + disabled + tooltip reason | ✅ built | `isAppliable === false` → `disabled` `Radio`, dimmed row, `Tooltip` reason; PUT rejects with `400 label_policy_blocked` + `reason` |
| 6 | Apply persists + reflects in catalog + stamps Purview asset | ✅ built | PUT PATCHes `item.state.sensitivityLabel(+Id)` (read by `/api/governance/sensitivity`) + best-effort `registerAtlasEntity` with `sensitivityLabel`/`sensitivityLabelId` attrs + `label-assignments` + `audit-log` rows |
| 7 | Clear label | ✅ built | "Clear label" button → PUT `{ labelId: '' }` (and `DELETE`) |
| 8 | Only active labels shown | ✅ built | `route.ts` GET `l.isActive !== false` filter |
| — | Graph IP not wired in this deployment (env unset) | ⚠️ honest-gate | `503 mip_not_configured` → `NotConfiguredBar` naming `LOOM_MIP_ENABLED` + the two Graph AppRoles + bootstrap script |
| — | Azure Government boundary (GCC-High / IL5) where Graph IP is unavailable | ⚠️ honest-gate | `route.ts` augments the 503 hint with the Gov note pointing to the Purview compliance portal |

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend call |
|---------|--------------|
| Load taxonomy + current label | `GET /api/items/[type]/[id]/sensitivity-label` → `mip-graph-client.listSensitivityLabels()` (`GET /beta/security/informationProtection/sensitivityLabels`) + Cosmos item read |
| Apply label | `PUT …/sensitivity-label { labelId }` → validate vs live taxonomy + `isAppliable`; `itemsContainer().item().replace()`; `getAssetDetail` + `registerAtlasEntity` (Atlas upsert merges the label attributes); `labelAssignmentsContainer().items.create`; `auditLogContainer().items.create` |
| Clear label | `PUT { labelId: '' }` or `DELETE` → Cosmos item `replace` removing the two state keys + audit row |

## Per-cloud

| Boundary | Graph IP taxonomy | Purview Atlas write | Behavior |
|----------|-------------------|---------------------|----------|
| Commercial | available (`graph.microsoft.com/beta`) | available | full flyout, live taxonomy |
| GCC | available (same Graph host) | available | full flyout, live taxonomy |
| GCC-High / IL5 | not available | available | honest gate: 503 + Gov note ("apply labels in the Microsoft Purview compliance portal"); `LOOM_MIP_GRAPH_BASE` is the future hook if a sovereign MIP Graph endpoint lands |

## Bicep / bootstrap sync

- **No new ARM resource.** The `label-assignments` Cosmos container is created
  via `createIfNotExists` in `lib/azure/cosmos-client.ts` (matches the
  governance-security PRP container list).
- **No new env var.** Reuses `LOOM_MIP_ENABLED` (param `loomMipEnabled`, wired
  into the Container App env block in `platform/fiab/bicep/modules/admin-plane/main.bicep`).
- **No new AppRole.** Reuses `InformationProtectionPolicy.Read.All`
  (`19da66cb-0fb0-4390-b071-ebc76a349482`) granted by
  `scripts/csa-loom/grant-graph-approles.sh` / the post-deploy bootstrap.

## Verification

`vitest` route suite covers: 401 unauth, live-taxonomy GET (no static list),
503 not-configured + hint, apply-appliable-label (persists `item.state`, writes
Purview, assignment, audit), policy-blocked → 400 with reason, unknown label →
400, clear. See
`apps/fiab-console/app/api/items/[type]/[id]/sensitivity-label/__tests__/route.test.ts`.
