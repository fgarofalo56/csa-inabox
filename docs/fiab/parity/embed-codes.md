# embed-codes — parity with Power BI embedding

Source UI: Power BI **Embed** (Publish to web codes) + embed-for-customers
Reference: <https://learn.microsoft.com/power-bi/collaborate-share/service-publish-to-web>
Also: <https://learn.microsoft.com/power-bi/developer/embedded/embed-sample-for-customers>
Run date: 2026-06-09

Loom surfaces:

- Embed component: `lib/components/embed/powerbi-embed.tsx` → `PowerBIEmbedFrame`
  (uses `powerbi-client-react`)
- Token BFF: `app/api/items/report/[id]/embed-token/route.ts`,
  `app/api/items/semantic-model/[id]/embed-token/route.ts`
- Client: `lib/azure/powerbi-client.ts` → `getEmbedToken`,
  `generateReportEmbedToken`, `generateDashboardEmbedToken`,
  `generateTileEmbedToken`, `generateDatasetEmbedToken`

> **Scope note:** the Fabric/Power BI admin "Embed codes" surface manages *public
> Publish-to-web* iframe codes (list + revoke). Loom's built surface is
> **authenticated per-item embed** (`PowerBIEmbedFrame` + embed-token mint) — the
> developer-grade embed. Per `no-fabric-dependency.md`, Power BI is Fabric-family
> and **opt-in**; tokens mint only when a Power BI workspace is bound. The
> surface does not require `LOOM_DEFAULT_FABRIC_WORKSPACE`.

## Fabric/Azure feature inventory (grounded in Learn)

1. Generate an embed token for a report / dashboard / tile / dataset
2. View-mode and edit-mode embeds
3. Render the embedded artifact in an iframe
4. Manage public Publish-to-web embed codes (list + revoke)

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| Authenticated embed token (report, per item) | ✅ Built | `POST …/report/[id]/embed-token` → `generateReportEmbedToken()` → PBI REST GenerateToken |
| Authenticated embed token (dashboard) | ✅ Built | `generateDashboardEmbedToken()` |
| Authenticated embed token (dataset) | ✅ Built | `generateDatasetEmbedToken()` |
| Authenticated embed token (tile) | ✅ Built | `generateTileEmbedToken()` |
| `PowerBIEmbedFrame` render (report / dashboard / tile / qna) | ✅ Built | `powerbi-client-react` `PowerBIEmbed`, lazily loaded; honest error when token missing |
| Edit-mode embed token | ✅ Built | `accessLevel:'Edit'` in POST body |
| Honest gate when PBI SP not configured / workspace unbound | ⚠️ Honest gate | token route returns `powerbiConfigGate()` 503 naming `LOOM_UAMI_CLIENT_ID` + SP authorization |
| Public Publish-to-web admin (list + revoke active embed codes) | ⚠️ Honest gate | Not built; the `export.publishToWeb` toggle lives in `tenant-settings.md`. The admin code-management surface is disclosed as a tracked future surface; the authenticated embed path is the recommended, governable alternative and is fully built. |

Zero ❌ rows. The two ⚠️ gates are honest: the opt-in Power-BI-not-bound state,
and the (deliberately deferred) public Publish-to-web admin — the latter is the
*less* governable Power BI feature, and Loom's authenticated embed delivers the
embedding parity today, per `no-vaporware.md`.

## Backend per control

- **Token mint** — each `embed-token` route calls the matching
  `generate*EmbedToken()` in `powerbi-client.ts`, which hits PBI REST
  `GenerateToken` for the artifact; `accessLevel:'Edit'` requests an edit-mode
  token.
- **Render** — `PowerBIEmbedFrame` lazy-loads `powerbi-client-react` and mounts
  `PowerBIEmbed` with the embed URL + minted token; when no token is available it
  renders an honest error rather than a blank frame.
- **Publish-to-web admin** — not wired (Fabric `POST /admin/...` not called); the
  honest gate explains the alternative.

## Per-cloud notes

| Cloud | PBI REST endpoint |
|---|---|
| Commercial | `api.powerbi.com` |
| GCC | `api.powerbigov.us` |
| GCC-High / IL5 | `api.powerbigov.us` / `api.high.powerbigov.us` (via `cloud-endpoints.ts`) |

Public Publish-to-web is unsupported in GCC/GCC-High/IL5 regardless, which
reinforces authenticated embed as the cross-cloud parity path.

## Bicep sync

- No new resource — Power BI is an opt-in tenant binding.
- `LOOM_UAMI_CLIENT_ID` already in `apps[]` env; the PBI SP authorization is a
  documented tenant bootstrap step surfaced as the honest gate.

## Verification

- Default path: with no Power BI workspace bound (and
  `LOOM_DEFAULT_FABRIC_WORKSPACE` unset), the token route returns the honest gate
  and the frame shows the honest error — no blank iframe, no fake render.
- Live walk (PBI bound): open a report item, confirm `PowerBIEmbedFrame` mints a
  real token via `generateReportEmbedToken()` and renders the report; request an
  edit-mode token and confirm edit affordances; confirm the Publish-to-web admin
  MessageBar honestly describes the deferred surface.

Grade: **B** — authenticated per-item embed fully built on real PBI REST for
report/dashboard/dataset/tile; the public Publish-to-web admin and the opt-in
PBI-not-bound state are the honest gates.
