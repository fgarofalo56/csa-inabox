# copilot-studio-channel — parity gap (validator v2, 2026-05-26)

**Loom URL**: `/items/copilot-studio-channel/new`
**Fabric reference**: copilotstudio.microsoft.com — Channels tab (Teams · Web chat · Direct Line · Slack · Facebook · Custom)
**Loom screenshot**: `temp/parity/copilot-studio-channel-loom.png`

## Phase 4

| Route | Status | Notes |
|---|---|---|
| `GET /api/items/copilot-studio-channel?envId=<env>&agentId=<id>` | 503 | Same Copilot Studio honest gate |
| `POST /api/items/copilot-studio-channel/<agentId>/publish` | wired | — |

UI renders **6 channel cards** in a grid (Teams · Web chat · Direct Line · Slack · Facebook · Custom). Each card has: type label · description · "Not published" badge · Config (JSON) textarea · "Publish to channel" button. The card grid layout closely matches Copilot Studio's channel publish surface.

## Phase 3 — Fabric vs Loom

| Copilot Studio element | Loom present? | Severity |
|---|---|---|
| 6 channel cards | YES | — |
| "Published" / "Disabled" / "Not published" status badges | YES (per card) | — |
| **Teams channel-specific config wizard** (app manifest · icon · color · scope) | NO — raw JSON textarea | MAJOR |
| **Web chat: embed code generator + copy-to-clipboard** | partial — `embedUrl` shown but no copy button or `<iframe>` snippet generator | MAJOR |
| **Direct Line key management** (regenerate · expire · token endpoints) | NO | MAJOR |
| **Slack OAuth wizard** | NO — raw JSON | MAJOR |
| **Facebook page binding wizard** | NO — raw JSON | MAJOR |
| **Publish status timeline** (publishing → success/fail; rollback) | NO | MAJOR |
| Per-channel test chat | NO | MAJOR |

## Functional

- Publish-to-channel button fires real POST (verified route exists)
- JSON config textarea accepts free input (no validation)

## Grade — **C-**

The cards layout matches Fabric's shape — this is the BEST-organized of the Copilot Studio editors. But each channel needs a real wizard (Teams manifest, Slack OAuth, Direct Line key ops); right now it's "paste JSON and pray". **Grade C-** — UX shape close, depth missing.
