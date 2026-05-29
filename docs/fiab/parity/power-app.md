# power-app — parity with Power Apps (Power Platform app)

**Source UI:** Power Apps maker portal (`make.powerapps.com` → Apps), app **Details** pane,
and the canvas **web player** (`apps.powerapps.com/play/<appId>`).
**Backend:** Power Apps REST (`api.powerapps.com`, `Microsoft.PowerApps` provider, api-version
`2016-11-01`) + BAP environments (`api.bap.microsoft.com`) for env selection / model-driven
instance URL. Auth: Console UAMI (`LOOM_UAMI_CLIENT_ID`) on the
`https://service.powerapps.com/.default` scope; SP must be in the
**"Service principals can use Power Platform APIs"** allow group.

Grounded in Microsoft Learn:
- List/get apps & publish — `power-platform/admin/programmability-*`, `Publish-AdminPowerApp`.
- Canvas embed URL — `power-apps/maker/canvas-apps/embed-apps-dev`
  (`https://apps.powerapps.com/play/[AppID]?source=iframe`; GCC `apps.gov.powerapps.us`).
- Model-driven open — `power-apps/developer/model-driven-apps` (`/main.aspx?appid=`).

## Root cause fixed (the 404)

The editor passed the **Loom item GUID** as the **Power Apps app id** →
`GET https://api.powerapps.com/.../apps/<loom-guid>` → 404. Fixed with a resource-binding
model (identical to the pipeline fix #476): the `power-app` item binds to
`state.envId` / `state.appId` / `state.appType`; all detail/embed/publish calls resolve the
**real** app id from item state, never the route id. Unbound items render a full bind/select
surface instead of crashing.

## Power Apps feature inventory → Loom coverage

| Capability (Power Apps UI) | Loom coverage | Backend per control |
| --- | --- | --- |
| Pick a Power Platform environment | BUILT ✅ | `GET /api/powerplatform/environments` → BAP `scopes/admin/environments` |
| List apps in an environment | BUILT ✅ | `GET /api/items/power-app?envId=` → `.../scopes/admin/environments/{env}/apps` |
| Bind a Loom item to a real app | BUILT ✅ (Loom-specific) | `POST /api/items/power-app/[id]/state` → Cosmos `replace` (persists envId/appId/appType) |
| App detail: name, app id, type, owner, version, created/modified | BUILT ✅ | `GET /api/items/power-app/[id]` → resolves binding → `.../apps/{appId}` |
| Connectors / data sources used | BUILT ✅ | same GET — `properties.connectionReferences` |
| Sharing summary (users/groups count) | BUILT ✅ (read-only) | same GET — `sharedUsersCount` / `sharedGroupsCount` |
| Play app (canvas) — embedded web player | BUILT ✅ | iframe `apps.powerapps.com/play/{appId}?source=iframe` (`allow="geolocation; microphone; camera"`) |
| Open app (model-driven) | BUILT ✅ | deep link `{instanceUrl}/main.aspx?appid={appId}` (cannot iframe — open-in-tab) |
| Publish latest revision | BUILT ✅ | `POST /api/items/power-app/[id]/publish` → `.../environments/{env}/apps/{appId}/publishAppRevision` |
| Open in maker (edit canvas/model-driven) | BUILT ✅ | deep link `make.powerapps.com/e/{env}/studio/{appId}` (maker is the authoring surface) |
| Re-bind to a different app | BUILT ✅ | app list "Re-bind" → `POST .../state` |
| Author a brand-new canvas app | HONEST-GATE ⚠️ | New canvas authoring is the proprietary maker Studio; MessageBar directs to `make.powerapps.com` + "Open in maker". No fake in-Loom designer. |
| Share app with new users/groups (write) | HONEST-GATE ⚠️ | Read-only sharing summary shown; share-grant is performed in maker (deep link). Surfaced as read info, not a dead button. |

## Honest infra gate

When Power Platform isn't reachable (no `LOOM_UAMI_CLIENT_ID`, or the SP isn't in the allow
group), the editor renders a Fluent `MessageBar intent="warning"` naming the exact env var
(`LOOM_UAMI_CLIENT_ID`) and the **"Service principals can use Power Platform APIs"** allow
group — and **the full editor surface still renders** (env picker, app list, detail, tabs).
GCC/Gov: set `LOOM_POWERAPPS_PLAYER_BASE=https://apps.gov.powerapps.us`.

## Validation

- Backend Vitest contract tests:
  - `lib/azure/__tests__/power-app-binding.test.ts` — binding resolution (state appId used, not
    route id), unbound→412, missing→404, persist writes state, error→status mapping (11 tests).
  - `lib/azure/__tests__/powerapp-rest-shapes.test.ts` — list/get/publish URL + method, canvas vs
    model-driven embed URL, GCC base override, content-type/HTML-404 guard, 403 hint (9 tests).
- `pnpm build` clean (Next.js production build compiles successfully).
- Live `/api/items/power-app/<id>` probe deferred: the worktree has no minted session / Azure
  reachability. The 404 root cause is removed by resolving the real app id from item state
  (covered by the binding test asserting `appId !== routeId`).

A-grade once a live minted-session probe + browser walk confirm the embed renders against a
provisioned environment.
