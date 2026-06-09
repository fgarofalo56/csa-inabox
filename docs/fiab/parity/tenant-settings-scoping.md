# tenant-settings (F2 scoping + numeric params) — parity with Microsoft Fabric tenant settings

Source UI: Fabric Admin portal → Tenant settings
(https://learn.microsoft.com/fabric/admin/about-tenant-settings,
https://learn.microsoft.com/fabric/admin/service-admin-portal-about-tenant-settings)

This doc covers the **F2 increment**: per-toggle "Apply to" security-group
scoping + integer companion parameters. The base boolean-toggle page is covered
by the parent tenant-settings surface.

## Fabric feature inventory (grounded in Learn)

Each Fabric tenant setting that supports delegation exposes a scope control with
these states (security groups only — not M365 groups / distribution lists):

| # | Fabric capability | Notes |
|---|---|---|
| 1 | Enabled / Disabled toggle | the base switch |
| 2 | "Apply to: The entire organization" | enabled for everyone |
| 3 | "Apply to: Specific security groups" + group multi-select | enabled only for chosen groups |
| 4 | "Except specific security groups" + group multi-select | enabled for everyone except chosen groups |
| 5 | Security-group picker with type-ahead search | live directory search |
| 6 | Numeric/parameter inputs on settings that carry one (e.g. export row limits, retention windows) | integer inputs with min/max |
| 7 | Audit of who changed what | Fabric writes to the unified audit log |

(Fabric "Enabled for a subset … except …" combined mode is out of F2 scope —
recorded as a deliberate non-goal, not a gap.)

## Loom coverage

| Fabric row | Loom coverage | Backend per control |
|---|---|---|
| 1 Enabled/Disabled | ✅ Fluent `Switch` per toggle | PUT `/api/admin/tenant-settings` → Cosmos `tenant-settings` |
| 2 Entire org | ✅ `ToggleScopePicker` Dropdown → mode `entire-org` | persisted in `scopeConfig[id].mode` |
| 3 Specific groups | ✅ Dropdown `specific-groups` + `GroupMultiPicker` | `scopeConfig[id].groupIds` |
| 4 Except groups | ✅ Dropdown `except-groups` + `GroupMultiPicker` | `scopeConfig[id].groupIds` |
| 5 Group type-ahead search | ✅ `GroupMultiPicker` | GET `/api/governance/identities/search?kind=group` → Graph `searchGroups` (`/v1.0/groups?$search=`) |
| 5b Stored-group → name resolve on load | ✅ chips show display names | GET `/api/admin/tenant-settings/groups?ids=` → Graph `getGroupsByIds` (`POST /v1.0/directoryObjects/getByIds`, `types=['group']`) |
| 6 Numeric parameters | ✅ Fluent `SpinButton` clamped to `[min,max]` (e.g. `ai.inlineCodeComplete.maxCompletions`, `mirror.azureSql.retentionDays`) | `numericParams[paramId]` in Cosmos |
| 7 Audit | ✅ one audit entry per delta | `auditLogContainer` kinds `tenant-settings.scope` + `tenant-settings.numeric` (+ existing `.toggle`) |

Zero ❌. The only non-functional state is the honest infra-gate (below).

## No-Fabric-dependency note

Security groups are **Entra** objects resolved via **Microsoft Graph** — there
is no Fabric/Power BI dependency. Scoping + numeric params persist to **Cosmos**
and work with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. The group picker is the
only control that needs an Azure-side grant; when `LOOM_IDENTITY_PICKER_ENABLED`
is unset (or `Group.Read.All` isn't consented) the picker renders an honest
Fluent `MessageBar` naming the exact env var + AppRole + the
`grant-identity-graph-approles.sh` step — and the numeric SpinButtons still save.

## Backend wiring

- Types: `lib/types/tenant-settings.ts` — `AppliesToConfig`, `NumericParamDef`,
  `scopableToggleIds()` / `numericParamIds()` whitelists (no-freeform-config),
  `isValidAppliesTo` / `appliesToEqual` guards.
- Graph: `lib/azure/graph-identity-client.ts` — `getGroupsByIds()`
  (`POST /directoryObjects/getByIds`, sovereign-correct base+scope).
- Routes: `app/api/admin/tenant-settings/route.ts` (GET+PUT delta+audit),
  `app/api/admin/tenant-settings/groups/route.ts` (bulk name resolve).
- UI: `lib/components/ui/group-multi-picker.tsx`,
  `lib/components/admin/toggle-scope-picker.tsx`,
  `app/admin/tenant-settings/page.tsx`.

## Per-cloud matrix

| Capability | Commercial | GCC | GCC-High | IL5 |
|---|---|---|---|---|
| Boolean + numeric persist (Cosmos) | ✅ | ✅ | ✅ | ✅ |
| "Apply to" UI renders | ✅ | ✅ | ✅ | ✅ |
| Graph group search / getByIds host | graph.microsoft.com | graph.microsoft.com | graph.microsoft.us | dod-graph.microsoft.us |
| Requires `loomIdentityPickerEnabled` + `Group.Read.All` consent | ✅ | ✅ | ✅ | ✅ |
| Audit (3 kinds) | ✅ | ✅ | ✅ | ✅ |

## Verification (real data E2E)

- `node node_modules/typescript/bin/tsc --noEmit` — touched files clean.
- `vitest run` — `lib/types/__tests__/tenant-settings.test.ts` (8) +
  `lib/azure/__tests__/graph-identity-client.test.ts` (9, incl. `getGroupsByIds`).
- Scoping round-trip: PUT `{scopeConfig:{'export.publishToWeb':{mode:'specific-groups',groupIds:[...]}}}`
  → GET returns the same `scopeConfig` → page renders chips via the groups route.
- Numeric round-trip: PUT `{numericParams:{'mirror.azureSql.retentionDays':14}}`
  → GET returns `14` → SpinButton displays it. Out-of-range values clamp to
  `[min,max]`; non-integers are rejected at the route.
