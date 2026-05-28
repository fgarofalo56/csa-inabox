# Audit tab (`/admin/security` → Audit)

Filterable + CSV-exportable view over the tenant audit-log container (Cosmos `auditLog`, partitioned by `/itemId`). Builds on the existing `/api/admin/audit-logs` route — this tab adds a category filter and a client-side CSV export.

## Capabilities

- **Free-text search** (`q=`) — matches who / kind / key / itemId.
- **Category quick filter** — Sharing, Role, Permission, Policy change, Scan, Label apply, DLP alert. Implemented as a client-side `kind.includes(category)` overlay (the BFF still serves up to 500 rows, the dropdown filters in-memory for snappy UX).
- **Event-kind filter** — Strict `kind = ?` filter populated from the distinct kinds returned by the BFF.
- **CSV export** — Downloads `loom-audit-YYYY-MM-DD.csv` with the currently-filtered rows. Headers: `at, who, kind, key, itemId`.

## Underlying BFF route

`GET /api/admin/audit-logs?q=<text>&type=<kind>&since=<iso>&top=<n>` — already shipped, no changes.

- Tenant-scoped. Cross-partition query (audit container partitions on itemId; tenant slice spans many itemIds — fine at < 50k events/tenant).
- Returns `{ ok, total, rows[], kinds[] }`. `kinds[]` powers the type dropdown.

## Honest-cuts

- The 200-row table cap is client-only. CSV exports all filtered rows up to the BFF `top=500` limit. If you need more, raise the `top=` param via the URL or open a follow-up to add pagination.
- "Policy change" is matched against `kind LIKE '%policy%'` rather than a Cosmos-side index — re-evaluate once audit volume justifies a dedicated `policyKind` indexed property.

## Source files

- Panel: `apps/fiab-console/lib/components/admin-security/audit-panel.tsx`
- Route: `apps/fiab-console/app/api/admin/audit-logs/route.ts` (pre-existing)
