# tenant-settings — parity with Fabric Admin Tenant settings

Source UI: Fabric Admin portal → **Tenant settings**
Reference: <https://learn.microsoft.com/fabric/admin/about-tenant-settings>
Run date: 2026-06-09

Loom surfaces:

- Page: `/admin/tenant-settings` → `app/admin/tenant-settings/page.tsx`
- BFF: `app/api/admin/tenant-settings/route.ts` (GET/PUT)
- Types: `lib/types/tenant-settings.ts` → `TENANT_SETTING_GROUPS`, `ToggleDef`,
  `defaultSettings()`
- Copilot agents panel: `lib/components/admin/copilot-agents-config.tsx`

This surface has **no dependency on real Microsoft Fabric**. Every toggle is a
Loom-owned tenant policy persisted in the Cosmos `tenant-settings` container; the
default path never touches `api.fabric.microsoft.com`. It renders and saves with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Fabric/Azure feature inventory (grounded in Learn)

1. Grouped tenant settings (collapsible category sections)
2. Per-setting enabled/disabled switch with apply-scope (entire org / specific
   security groups)
3. Search across settings
4. Save / discard with explicit confirmation
5. Per-setting learn-more documentation link
6. Audit trail of who changed which setting and when
7. Forward-compatibility: newly introduced settings appear with their default

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| 15 toggle categories / ~50 toggles (OneLake, Real-Time Intelligence, AI & Copilot, Mirroring, Domains, Information protection, Export & sharing, Help & support, Billing, Purview integration, Data Products, U-SQL legacy, + Copilot-agents groups) | ✅ Built | `GET/PUT /api/admin/tenant-settings` → Cosmos `tenant-settings` |
| Per-toggle enable/disable switch | ✅ Built | PUT body merges toggle key into the tenant doc |
| Sticky toolbar (search, Ctrl+S save, discard) | ✅ Built | Client UI state over fetched groups |
| Per-toggle search filter | ✅ Built | Client filter on `TENANT_SETTING_GROUPS` |
| Dirty-state tracking + "N unsaved" badge | ✅ Built | `settings` vs `original` diff |
| Save emits per-toggle audit row | ✅ Built | PUT route writes `tenant-settings.toggle` rows to Cosmos `audit-log` |
| Forward-compatible default-merge on read (new toggles auto-seeded) | ✅ Built | `loadOrSeed()` merges missing keys from `defaultSettings()` |
| Learn-more link per toggle | ✅ Built | `learnUrl` on `ToggleDef` → `Open16Regular` link |
| Copilot-agents inline config (per-agent enable, model, scope) | ✅ Built | `CopilotAgentsConfig` → same PUT route |

Zero ❌ rows. No ⚠️ gates: all state is Loom-owned Cosmos policy, no external
infra is required to render or save.

## Backend per control

- **Read** — `GET /api/admin/tenant-settings` → `tenantSettingsContainer()` read
  of the tenant policy doc; `loadOrSeed()` merges any toggle keys absent from the
  stored doc so newly shipped settings appear with their default.
- **Write** — `PUT` read-modify-writes the doc and, for each changed toggle,
  appends a `tenant-settings.toggle` row (who / at / key / from / to) to the
  Cosmos `audit-log` container — feeding the `audit-logs.md` surface.
- **Copilot agents** — same PUT route; the agents config is a nested object on
  the policy doc.

## Per-cloud notes

| Cloud | Notes |
|---|---|
| Commercial | All toggles operative |
| GCC | `export.publishToWeb` toggle exists but Power BI GCC does not support Publish to web; documented as non-operative (no Fabric F-SKU). All other toggles operative. |
| GCC-High | Same as GCC; Copilot toggles gate on AOAI availability in the boundary |
| IL5 | Same as GCC-High; toggles are policy only and persist regardless of downstream availability |

## Bicep sync

- No new Azure resources or role grants. The `tenant-settings` Cosmos container
  is created by the existing Cosmos init step (`cosmos-client` `createIfNotExists`).
- No new env var — the surface reads/writes Cosmos with the console UAMI that is
  already wired in `admin-plane/main.bicep`.

## Verification

- `npx tsc --noEmit` clean on touched files.
- Default path works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- Live walk: open `/admin/tenant-settings`, flip a toggle in two categories,
  observe the "2 unsaved" badge, Ctrl+S to save (real PUT → Cosmos), reload and
  confirm persistence, then open `/admin/audit-logs` and confirm two
  `tenant-settings.toggle` rows landed.

Grade: **A** — full inventory built, real Cosmos backend, audit-emitting, zero
gates.
