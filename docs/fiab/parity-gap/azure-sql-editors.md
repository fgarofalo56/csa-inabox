# Parity Gap — Azure SQL editors (v2 validator, 2026-05-26)

> Editors: `azure-sql-server` / `azure-sql-database` / `azure-sql-managed-instance` / `sql-server-2025-vector-index`
> Source: `apps/fiab-console/lib/editors/azure-sql-editors.tsx` (485 lines)
> Validator state: source-grade audit. Phase 4 (live click) blocked by MFA session expiration; the captured prior screenshots `temp/parity/warehouse-loom.png` use the same patterns and confirm the textarea/results pattern.

## Common chrome

All four editors use `ItemEditorChrome` with a small ribbon: 1 tab × 2-4 groups × 1-3 actions/group. **5-15 ribbon buttons total.**

Portal Azure SQL editors (portal.azure.com → SQL database → Query editor) have ribbon equivalents:
- Query editor: New query / Open / Save / Run / Cancel / Estimate plan / Actual plan / Show statistics / Format / Comment / Login / Settings / Help → **~13 buttons**.
- SQL Database overview: Overview / Activity log / Access control (IAM) / Tags / Diagnose / Connection strings / Quick start / Query editor / Sync / Copy / Restore / Export / Set server firewall / Geo-Replication / Active Geo-replication / Auditing / Microsoft Defender / Dynamic data masking / Transparent data encryption / Identity / Manage Backups / Locks → **~22 panes**.

Loom ribbon at ~30% of the portal surface area → **MAJOR**.

## 1. `azure-sql-server`

| Element | portal.azure.com SQL Server | Loom | Severity |
|---|---|---|---|
| Server tree on left | Resource tree | `Tree → Servers (N)` | present |
| Server metadata (FQDN, State, Location, Public access, Version) | Overview blade | Subtitle2 + 4 Badges + 2 Body1 lines | present |
| Databases sub-table (Name / Status / SKU) | Databases blade | 3-col Table | present |
| AAD admin set | Active Directory admin blade with picker | Caption1 "deferred — provision via bicep" | **MAJOR** advertised in ribbon but no UI |
| Firewall rules | Firewall blade with table + Add | Caption1 "deferred" | **MAJOR** advertised in ribbon but no UI |
| Network selection (Public/Private/Service endpoint) | Networking blade | absent | **BLOCKER** for production |
| Subnet rules | Network blade | absent | MAJOR |
| Defender / Auditing / TDE | Security blades | absent | MAJOR — Defender is required by Azure policy in most tenants |
| Backups / Geo-replication | Replicas pane | absent | MAJOR |

**Grade**: **C** — server list + metadata + database list real, REST-wired. But every "Security" / "Firewall" / "AAD admin" ribbon button is a label without backing UI. Ribbon advertises capabilities that aren't built → vaporware-adjacent.

## 2. `azure-sql-database`

This is the headline editor. 4-tab TabList: Query / Mirroring / Replication / SQL 2025.

### CRITICAL CHECKS (from request)
- **T-SQL Monaco + result grid + query history?** — **NO Monaco. PLAIN `<textarea>`** (line 322: `<textarea className={s.editor} ... value={sqlText} ...>`). Per parity-validation-standard memory this is an **immediate BLOCKER**.

| Element | portal.azure.com Query editor | Loom | Severity |
|---|---|---|---|
| **T-SQL editor** | Monaco with SQL IntelliSense + schema-aware completion + error squiggles + `OBJECT_NAME` hover | **`<textarea>` only** | **BLOCKER** ❌ |
| Run button | Toolbar | `Run` Button | present |
| Cancel running query | Toolbar | absent | MAJOR |
| Results grid | `<table>` with sortable + copy + JSON view | Fluent Table — sortable? No. Copy? No. JSON? No. | MAJOR |
| Result count / executionMs / truncated | Status bar | Badges above table | present (B-present) |
| Query history | Side panel "History" with timestamps | absent | **MAJOR** |
| Saved queries | Side panel "Saved queries" | absent | MAJOR |
| Schemas / Tables tree | Left rail browser | absent | **MAJOR** — request asked for this explicitly |
| Mirroring tab | Real mirroring config flow w/ source picker | Single button + JSON dump | **MAJOR** — no source/target selection UI |
| Replication tab | Geo-replica picker + map | MessageBar "deferred" | **D-equivalent** |
| SQL 2025 tab | Feature-availability matrix | Single "Probe engine" button + JSON dump | C-present |
| Error display | Inline below editor with line/col | MessageBar "Query failed" | present |
| Estimated execution plan | "Estimate plan" button | absent | **BLOCKER** for SQL parity |

**Grade**: **D** — `<textarea>` for T-SQL is a BLOCKER per memory; no schema tree; no history; Mirroring/Replication tabs are essentially MessageBars. Run + result table work end-to-end so it's not F.

## 3. `azure-sql-managed-instance`

List-only.

| Element | portal.azure.com SQL MI | Loom | Severity |
|---|---|---|---|
| Instance list (Name / State / Location / SKU / FQDN) | Resource list | 5-col Table | present |
| Click MI → overview | Full blade with Compute / Networking / Backups / etc. | absent — list only | **BLOCKER** for any editing |
| Query against MI | Query editor (portal) or SSMS link | absent | **BLOCKER** |
| Failover group | Pane | absent | MAJOR |
| Logical server reference | Field | absent | MINOR |

Editor's own MessageBar admits "list-only in v3". So this is honest, but parity is D.

**Grade**: **D** — honest list-only, no detail editor.

## 4. `sql-server-2025-vector-index`

DDL builder for `CREATE VECTOR INDEX`.

| Element | Portal SQL 2025 vector | Loom | Severity |
|---|---|---|---|
| Form: Server / Database / Table / Vector column / Dimensions / Metric | n/a (portal has no UI for this yet) | 6 inputs + native `<select>` for metric | present |
| Generated DDL preview | n/a | `<textarea readOnly>` with templated DDL | present (B-present for new feature) |
| Create button | n/a | `Create vector index` primary → POSTs to `azure-sql-database/[id]/query` | present |
| Similarity test | n/a | absent (no "Test similarity" wired) | MAJOR — ribbon claims it |
| SQL 2025 version probe | n/a | MessageBar "verify version first" (manual) | MINOR |
| Index list | Should show existing vector indexes | absent | **BLOCKER** |

The metric `<select>` is a raw HTML element (not Fluent `Dropdown`) — minor styling inconsistency.

**Grade**: **C** — best of the SQL family because no Fabric equivalent exists (SQL 2025 is brand new); form + DDL preview + create are wired. But no Similarity test, no index list, the ribbon's "Test similarity" is a label-only button → not above C.

## Phase 4 (functional click-every-button)

Blocked by MFA session expiration. Source-grade `onClick` audit:

| Button | Has `onClick`? | Action |
|---|---|---|
| AzureSqlServerEditor Reload | indirect (useEffect on mount) | listServers |
| AzureSqlServerEditor "Refresh" / "Firewall" / "AAD admin" ribbon | **NO** — ribbon labels only | dead clicks |
| AzureSqlDatabase Run | ✓ | POST query |
| AzureSqlDatabase "New T-SQL" / "Toggle Fabric mirror" / "Add geo-replica" / "Probe engine" ribbon | **NO** (the in-pane Toggle/Probe buttons do fire, ribbon labels do not) | partial — dead from ribbon, works from pane |
| AzureSqlManagedInstance "List instances" ribbon | **NO** | useEffect handles it |
| SqlServer2025VectorIndex "Create" ribbon | **NO** (in-pane Create button works) | partial |
| SqlServer2025VectorIndex "Test similarity" ribbon | **NO** + the in-pane button is `disabled` | dead — explicitly marked disabled |

Per parity-validation-standard: any dead button without a documented MessageBar gate = BROKEN. **This contributes ~6 BROKEN dead ribbon buttons across the family.**

## Summary

| Editor | Grade | Reason |
|---|---|---|
| azure-sql-server | **C** | Real REST list + databases, multiple ribbon buttons are labels-only |
| azure-sql-database | **D** | `<textarea>` not Monaco (BLOCKER), no schema tree, no history, Mirroring/Replication are stub panes |
| azure-sql-managed-instance | **D** | List-only, no detail editor, no query, no failover |
| sql-server-2025-vector-index | **C** | DDL builder + create works, no Test similarity (disabled), no index list |
