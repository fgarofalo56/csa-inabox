# audit-logs — parity with Fabric Admin audit logs

Source UI: Fabric Admin portal → **Audit logs** (Microsoft Purview audit search)
Reference: <https://learn.microsoft.com/fabric/admin/service-admin-access-audit>
Run date: 2026-06-09

Loom surfaces:

- Page: `/admin/audit-logs` → `app/admin/audit-logs/page.tsx`
- BFF: `app/api/admin/audit-logs/route.ts`

The audit log is **Loom-native**: every admin mutation (tenant-setting toggles,
domain changes, role assignments, …) writes a row to the Cosmos `audit-log`
container. There is **no dependency on real Microsoft Fabric** — the surface
renders with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Fabric/Azure feature inventory (grounded in Learn)

1. Search audit events (who / when / what)
2. Filter by activity type
3. Filter by date range
4. Limit / page results
5. Export to CSV
6. Sort by time

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| Audit log table (who, at, kind, key, from, to) | ✅ Built | `GET /api/admin/audit-logs` → Cosmos `audit-log` |
| Free-text filter | ✅ Built | `?q=` → server-side filter |
| Event-kind filter (dropdown of distinct kinds) | ✅ Built | `?kind=` + distinct-kinds query |
| Time-range filter | ✅ Built | `?from=&to=` ISO params |
| Top clamp (1–1000 rows) | ✅ Built | `top` clamped in route |
| CSV export | ✅ Built | Download button → client-side CSV of fetched rows |
| Sort (at DESC default) | ✅ Built | Cosmos `ORDER BY c.at DESC` |

Zero ❌ rows, zero ⚠️ gates — entirely Cosmos-backed Loom-native data.

## Backend per control

- **Query** — `GET /api/admin/audit-logs` reads the `audit-log` container with
  Cosmos SQL: free-text `q` filters across the indexed columns, `kind` filters by
  activity type (the distinct-kinds list powers the dropdown), `from`/`to` bound
  the `at` timestamp, `top` is clamped 1–1000, and results are `ORDER BY c.at
  DESC`.
- **CSV** — the client serializes the fetched rows to CSV in the browser (no
  separate backend export job).
- **Producers** — rows are written by other admin surfaces (e.g. the
  tenant-settings PUT route emits `tenant-settings.toggle`; domain/role mutations
  emit their own kinds), so the log is real activity, not seeded data.

## Per-cloud notes

| Cloud | Behaviour |
|---|---|
| Commercial / GCC / GCC-High / IL5 | Identical — Cosmos-backed, cloud-agnostic. |

## Bicep sync

- No new resource — `audit-log` Cosmos container via existing init.
- No new env var or role grant.

## Verification

- Default path works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- Live walk: flip a tenant setting (emits an audit row), open `/admin/audit-logs`,
  confirm the row appears with who/at/kind/key/from/to, filter by `kind` and by a
  date range, free-text search, then export CSV and confirm it matches the grid.

Grade: **A** — full audit search/filter/export on real Cosmos, fed by real admin
mutations; zero gates.
