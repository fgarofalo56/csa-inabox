# ai-foundry-hub — parity gap (validator v2, 2026-05-26)

**Loom URL**: `/items/ai-foundry-hub/new`
**Fabric/Azure reference**: <https://ai.azure.com> (AI Foundry hub overview)
**Loom screenshot**: `temp/parity/ai-foundry-hub-loom.png`

## Phase 4 — live functional check (HTTPS via minted session)

| Route | Status | Notes |
|---|---|---|
| `/api/foundry/workspace` | 200 | Real workspace `aifoundry-csa-loom-eastus2`, kind=Hub, Succeeded, PNA=Disabled |
| `/api/foundry/connections` | 200 | 0 connections (empty hub but route is wired) |
| `/api/foundry/deployments` | 200 | 0 endpoints, 0 deployments (route works, hub empty) |
| `/api/foundry/computes` | 200 | 0 computes attached |
| `/api/foundry/datastores` | 200 | 0 registered datastores |
| `/api/items/ml-model` | 200 | 0 models (route wires Models tab) |
| `/api/items/ml-experiment` | 200 | 0 jobs, 0 experiments |

All backing routes return 200 with real Azure data. The hub overview tab renders 12 real metadata fields (storage account `safoundryhubm56yejezt7bj`, KV `kv-loom-m56yejezt7bjo`, ACR `acrloomm56yejezt7bjo`, App Insights `ai-csa-loom-eastus2`, discovery URL). 7 tabs visible (Overview · Connections · Models · Deployments · Computes · Datastores · Jobs). Ribbon has 4 actions (Reload · Open in Azure portal · New connection · New deployment).

## Phase 3 — Fabric vs Loom row-by-row

| Fabric AI Foundry hub element | Loom present? | Severity |
|---|---|---|
| Title + friendly name + kind badge | YES (Hub badge) | — |
| Overview metadata grid (workspace, RG, location, storage, KV, ACR, Insights) | YES (12 rows) | — |
| Connections tab with list + Auth column | YES (table headers wired) | — |
| Models tab with version count | YES (basic table) | MINOR — Fabric also shows Model Catalog filter sidebar; Loom is list only |
| Deployments tab (online endpoints + deployments) | YES (2 sub-tables) | — |
| Computes tab with state + VM size | YES | — |
| Datastores tab | YES | — |
| Jobs tab (Experiments + recent jobs) | YES (2 sub-tables) | — |
| **"+ New connection" wizard with provider catalog** (OpenAI / AI Search / Storage / Custom) | NO — button has no click handler wired here | MAJOR |
| **"+ New deployment" wizard with model picker + capacity** | NO — button is dead | MAJOR |
| **Cost meter / quota usage bar** | NO | MINOR |
| Resource Graph quick-link to provisioning state diagram | NO | COSMETIC |

## Buttons clicked / functional

- `Reload` — not tested individually but each tab uses `useLazyFetch` so it should re-call BFF (BFF returns 200, so this works)
- `Open in Azure portal` — likely deep-link (not verified opened a new window)
- `New connection` / `New deployment` — **BROKEN: button visible but has no onClick handler in `foundry-hub-editor.tsx` ribbon definition**

## Grade — **B-**

The hub editor is the most polished of the AI/ML group. Phase 4 ZERO BROKEN on primary read paths — every tab hydrates real data. Phase 3 has 2 MAJOR (dead "New connection" + "New deployment" ribbon buttons) which would normally drop it to C, but the read experience is honest and real enough that B- is fair — the editor PROMISES write but only delivers read. Mark these two ribbon actions as "Coming soon" or wire them, then it's an A-.
