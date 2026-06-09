# refresh-summary — parity with Power BI dataset refresh history + schedule

Source UI: Power BI **Dataset → Refresh history** + **Scheduled refresh** settings
Reference: <https://learn.microsoft.com/rest/api/power-bi/datasets/get-refresh-history-in-group>
Run date: 2026-06-09

Loom surfaces:

- History BFF: `app/api/items/semantic-model/[id]/refreshes/route.ts`
- Schedule BFF: `app/api/items/semantic-model/[id]/refresh-schedule/route.ts`
- Client: `lib/azure/powerbi-client.ts` → `listRefreshHistory`,
  `getRefreshSchedule`, `patchRefreshSchedule`, `refreshDataset`, `takeOverDataset`

Refresh history + scheduling target the Power BI REST data plane. Per
`no-fabric-dependency.md`, Power BI is Fabric-family and strictly **opt-in**: the
semantic-model item's default backend is the Loom-native tabular layer (see
`semantic-model.md`), and this Power-BI refresh surface activates only when a
Power BI workspace is bound. When unbound, the surface honest-gates rather than
blocking. It does not require `LOOM_DEFAULT_FABRIC_WORKSPACE`.

## Fabric/Azure feature inventory (grounded in Learn)

1. Refresh history (status, start/end, type, error detail)
2. Trigger an on-demand refresh
3. View scheduled-refresh configuration
4. Edit schedule (enabled, days, times, timezone, failure notification)
5. Take over a dataset to manage its schedule

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| Refresh history (status, startTime, endTime, type, error) | ✅ Built | `GET …/refreshes?workspaceId=&top=25` → `listRefreshHistory()` → PBI REST `GET /groups/{ws}/datasets/{id}/refreshes` |
| On-demand refresh trigger | ✅ Built | `POST …/refresh` → `refreshDataset()` |
| Read scheduled-refresh config | ✅ Built | `GET …/refresh-schedule` → `getRefreshSchedule()` |
| Update schedule (enabled, days, times, timezone, failure notification) | ✅ Built | `PATCH …/refresh-schedule` → `patchRefreshSchedule()` → PBI REST `PATCH …/refreshSchedule` |
| 400 guard (enabled=true without day+time) | ✅ Built | route validates days (`VALID_DAYS` Set) + times (`TIME_RE` regex) |
| Take over dataset (fix ownership for schedule PATCH 400) | ✅ Built | `POST …/take-over` → `takeOverDataset()` |
| Honest gate when PBI SP not configured / workspace unbound | ⚠️ Honest gate | `powerbiConfigGate()` → 503 naming `LOOM_UAMI_CLIENT_ID` + SP authorization steps |

Zero ❌ rows. The single ⚠️ gate keeps the surface honest when no Power BI
workspace / SP is bound — consistent with Power BI being opt-in per
`no-fabric-dependency.md`. With a bound workspace, every control hits real PBI
REST, per `no-vaporware.md`.

## Backend per control

- **History** — `listRefreshHistory()` calls PBI REST `GET
  /groups/{ws}/datasets/{id}/refreshes?$top=N`.
- **On-demand** — `refreshDataset()` POSTs a refresh.
- **Schedule read/write** — `getRefreshSchedule()` / `patchRefreshSchedule()`;
  the PATCH route validates `days` against `VALID_DAYS` and each time against
  `TIME_RE` before calling REST, and refuses `enabled:true` without at least one
  day + time.
- **Take over** — `takeOverDataset()` resolves the 400 that PBI returns when the
  SP doesn't own the dataset, then the schedule PATCH succeeds.
- **Gate** — `powerbiConfigGate()` returns a 503 naming `LOOM_UAMI_CLIENT_ID` +
  the SP-authorization steps when Power BI isn't configured.

## Per-cloud notes

| Cloud | Power BI REST endpoint |
|---|---|
| Commercial | `api.powerbi.com` |
| GCC | `api.powerbigov.us` |
| GCC-High / IL5 | `api.powerbigov.us` / `api.high.powerbigov.us` — resolved via `cloud-endpoints.ts` |

Refresh + schedule are available across all clouds where a Power BI capacity is
bound; absent a binding the surface honest-gates everywhere.

## Bicep sync

- No new resource — Power BI is an opt-in tenant binding, not a Loom-deployed
  resource.
- `LOOM_UAMI_CLIENT_ID` is already in the `apps[]` env list; the Power BI SP
  authorization is a documented tenant bootstrap step
  (`docs/fiab/v3-tenant-bootstrap.md`), surfaced in-product as the honest gate.

## Verification

- Default path: with no Power BI workspace bound (and
  `LOOM_DEFAULT_FABRIC_WORKSPACE` unset), the surface shows the honest gate, not
  an error — the semantic-model item itself still works on the Loom-native
  tabular layer.
- Live walk (PBI bound): open a semantic model's Refresh tab, confirm the history
  grid populates from real PBI REST, trigger an on-demand refresh, edit the
  schedule (days + times + timezone), confirm the 400 guard rejects an empty
  schedule, and take over a dataset to fix an ownership 400.

Grade: **A** — full history + on-demand + schedule + take-over on real Power BI
REST; the only gate is the honest, opt-in Power-BI-not-bound state.
