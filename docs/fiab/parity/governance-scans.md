# governance-scans — parity with Microsoft Purview Data Map (sources & scans)

**Source UI:** Microsoft Purview portal → **Data Map → Sources** (register +
manage) and **Scans** (scan rules, run, run history). Grounded in Microsoft
Learn:
- https://learn.microsoft.com/purview/register-scan-azure-data-lake-storage
- https://learn.microsoft.com/purview/concept-scans-and-ingestion
- https://learn.microsoft.com/purview/manage-data-sources

**Loom surface:** `app/governance/scans/page.tsx` (+ `GovernanceShell`,
`LoomDataTable`, `PurviewGate`).

## Infra reality (honest gate, allowed)

The Data Map scan plane is intrinsically a **Purview** capability — there is no
Azure-native substitute for "Purview scan history". Per `no-vaporware.md` this is
an **allowed honest-gate**: the full sources/scans UI renders, and the
register/run/remove actions are calls to the **real Purview scan plane**
(`/scan/datasources/...`); when Purview isn't wired in this deployment (or is
cross-cloud) the `PurviewGate` MessageBar names the one-time fix and the
mutating buttons disable themselves. This surface is opt-in Purview by nature and
does **not** gate any other governance surface or any item type.

## Inventory → Loom coverage → backend per control

| Purview Data Map capability | Loom control | Backend per control | Status |
|---|---|---|---|
| Registered data-sources list (name / kind / endpoint / collection) | `LoomDataTable` — Name, Kind badge, Endpoint, Collection, actions | `GET /api/governance/scans` → `listDataSources()` (`/scan/datasources`) | ⚠️ honest-gate (live Purview REST; renders empty-state + gate until bound) |
| Register a new source (kind picker + endpoint) | "Register source" dialog — name `Input`, kind `Dropdown` (AdlsGen2 / AzureSqlDatabase / Synapse / Blob / Cosmos / ADX / PowerBI / Snowflake / Databricks / Teradata / Oracle), endpoint `Input` | `POST /api/governance/scans` → `registerDataSource()` (PUT `/scan/datasources/{name}`) | ⚠️ honest-gate |
| De-register a source | per-row "Remove" | `DELETE /api/governance/scans?name=` → `deleteDataSource()` | ⚠️ honest-gate |
| Per-source scans list | "Scans" drawer per source | `GET /api/governance/scans?source=` → `listScansForSource()` | ⚠️ honest-gate |
| Trigger a scan run on demand | per-scan "Run now" | `POST /api/governance/scans {source,scan,run:true}` → `triggerScanRun()` | ⚠️ honest-gate |
| Scan run history (last runs + status + error) | per-scan "History" → status-coded run rows | `GET /api/governance/scans?source=&scan=&runs=1` → `listScanRuns()` | ⚠️ honest-gate |
| Connection / reachability status | `PurviewGate` chip + reason-coded MessageBar | `GET /api/governance/purview/status` → `probePurview()` | ✅ BUILT |
| Refresh sources + connection | "Refresh" re-probes + reloads | re-invokes status + `listDataSources()` | ✅ BUILT |

**Legend:** ✅ BUILT = real control + real backend today. ⚠️ honest-gate = the
control renders and calls live Purview scan REST; it disables behind the named
`PurviewGate` (env var + bicep + roles) until `LOOM_PURVIEW_ACCOUNT` is bound in
this cloud — the *allowed* infra-gate, not a stub. No MISSING rows, no dead controls.

## Grade

**A-when-wired** — every control (register / remove / list scans / run / history)
calls the real Purview scan plane; the full Data Map surface renders with an
honest, named gate when Purview is unbound. No mock source list.
