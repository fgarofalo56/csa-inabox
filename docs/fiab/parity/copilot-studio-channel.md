# copilot-studio-channel — parity with Copilot Studio (channels)

Source UI: Copilot Studio → agent → Channels.
Learn: <https://learn.microsoft.com/microsoft-copilot-studio/publication-fundamentals-publish-channels>

## Feature inventory

1. Channel grid (Teams, Web, Direct Line, Slack, Facebook, custom).
2. Per-channel publish status.
3. Publish / re-publish to a channel with config.

## Loom coverage

| Row | Status | Notes |
| --- | --- | --- |
| Channel grid | built ✅ | 6 channel cards with published/disabled badges |
| Publish | built ✅ | per-card Publish with JSON config |
| Embed URL | built ✅ | shown when present |

## Backend per control

- `listChannels`/`publishToChannel` (Dataverse `msdyn_botchannels`).

## Per-cloud notes

Copilot Studio is a **Power Platform / Dataverse** workload — sovereign routing
is Dataverse-specific. `lib/azure/copilot-studio-client.ts` reads the BAP host
and Direct Line token URL from env so the same code targets each cloud.

| Concern | Commercial / GCC | GCC-High | IL5 / DoD |
| --- | --- | --- | --- |
| BAP base (`LOOM_POWER_PLATFORM_BAP_BASE`) | `api.bap.microsoft.com` | `api.bap.microsoft.us` | Power Platform unavailable — honest ⚠️ gate |
| Dataverse host | `*.crm.dynamics.com` / `*.crm9.dynamics.com` (GCC) | `*.crm.microsoftdynamics.us` | N/A |
| Direct Line channel (`LOOM_DIRECTLINE_TOKEN_URL`) | `directline.botframework.com` | override for GCC-High | not available |
| Availability | GA (Teams/Web/Direct Line/Slack/Facebook/custom) | GA with limits; some channels unavailable | not available — render `MessageBar intent="error"` |
