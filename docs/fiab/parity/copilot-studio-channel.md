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
