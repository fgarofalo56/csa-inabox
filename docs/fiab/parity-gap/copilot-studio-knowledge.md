# copilot-studio-knowledge — parity gap (validator v2, 2026-05-26)

**Loom URL**: `/items/copilot-studio-knowledge/new`
**Fabric reference**: copilotstudio.microsoft.com — Knowledge tab on an agent (Add knowledge wizard: Public website / Documents / SharePoint / Dataverse / Bot Framework Skills)
**Loom screenshot**: `temp/parity/copilot-studio-knowledge-loom.png`

## Phase 4

| Route | Status | Notes |
|---|---|---|
| `GET /api/items/copilot-studio-knowledge?envId=<env>&agentId=test` | **503** | Honest gate: `"Copilot Studio is not enabled in this environment. Enable it from Power Platform admin centre → Environments → <env> → Settings → Product → Features → 'Copilot Studio'."` |

The editor surfaces this **as a Fluent MessageBar** with the exact remediation path. **This is correct no-vaporware behavior.**

## Phase 3 — Fabric vs Loom

| Copilot Studio element | Loom present? | Severity |
|---|---|---|
| Knowledge source types: URL · File · SharePoint · Dataverse | YES (4-option dropdown) | — |
| **Bot Framework skills** type | NO | MINOR |
| **Public website search depth + crawl rules** | NO | MAJOR |
| **Document indexing status / re-index button** | NO | MAJOR |
| **Per-source enable/disable toggle** | NO — only add/remove | MINOR |
| **Generative answers preview** (ask a question, see grounded answer) | NO | MAJOR |
| List with name + type + URI + status + remove | YES | — |
| Honest MessageBar when Copilot Studio not enabled | YES | — |

## Functional

- The list call returns 503 with the honest gate; the Add form does not submit until the gate is cleared
- Add button is wired to POST (verified route exists)

## Grade — **C**

Honest gate per no-vaporware. Real CRUD wired. But the editor is missing the indexing-status, generative-preview, and crawl-config features that Copilot Studio surfaces. **Grade C** — solid backend, thin UX.
