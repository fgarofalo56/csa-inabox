# Copilot Studio Knowledge Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent from Microsoft Learn (Copilot Studio: knowledge-add-existing-copilot, knowledge-add-file-upload, knowledge-add-sharepoint, knowledge-add-dataverse, knowledge-azure-ai-search, knowledge-unstructured-data, knowledge-real-time-connectors) + inspection of `apps/fiab-console/lib/editors/copilot-studio-editors.tsx::CopilotKnowledgeEditor` and `listKnowledgeSources` / `addKnowledgeSource` in `apps/fiab-console/lib/azure/copilot-studio-client.ts`.

## Overview

Knowledge sources let a Copilot Studio agent ground its generative answers in your data. Each agent can attach multiple knowledge sources of mixed type. At runtime the orchestrator (when generative mode is on) or the **Conversational boosting** system topic (classic mode) searches across the attached sources, retrieves the top semantic matches, and uses them to compose a grounded answer with citations. Sources can be attached at the **agent level** (any topic can use them) or at the **node level** (scoped to one Generative answers node).

## Copilot Studio UX

### Knowledge page chrome
- **Overview · Knowledge** entry points → opens **Add knowledge** dialog
- Knowledge list table: name · type icon · status (Ready · Indexing · Error · Updating) · last-indexed timestamp · row-level **Edit** / **Delete** / **Disable**
- **Filter** by type · **Search** by name · **Reindex** action (some types only)
- Knowledge attached at the Generative answers node level is shown inline on the node, not on the Knowledge page

### Source types (Add knowledge dialog)

| Type | Configuration | Backing infra | Sync |
|---|---|---|---|
| **Public website** | URL (up to 4 root URLs) · Bing site-search · advanced: per-URL allowlist/denylist | Bing index | Real-time crawl |
| **File upload** | Drag/drop or browse from local · `.docx .pptx .pdf .xlsx` (+ images for PDF OCR) · max 512 MB · max 500 objects per agent | Dataverse (chunks + vector embeddings) | Static — re-upload to refresh |
| **OneDrive** | Browse-items file picker · select files/folders · ≤5 root items | Dataverse copies + SharePoint search | Auto every 4–6 h |
| **SharePoint (file upload variant)** | Site URL + Browse picker · supports SharePoint **lists** + files/folders · authenticated user must have access | Dataverse copies + SharePoint search | Auto every 4–6 h |
| **SharePoint (connector variant)** | Site URL · auth: shared / per-user · advanced filters (author / modified date / title) · no Dataverse copy | Live SharePoint search | Real-time |
| **Dataverse** | Pick table from current env · select columns · grounding strategy: `Single best record` vs `Multiple top records` · per-row security honored | Dataverse natural-language search index | Real-time |
| **Azure AI Search** | Service name · index name · API key / managed identity · embedded fields config (title · content · vector) | Azure AI Search service | Index-driven |
| **Real-time connectors** | Pick from 1500+ Power Platform connectors (Salesforce / ServiceNow / Confluence / Zendesk / Jira / Snowflake / etc.) · connector connection ref · per-connector filter | Live source query through connector | Real-time |
| **Manual entries / Q&A pairs** | Pairs of question + answer; useful for FAQ overrides | Stored in `msdyn_knowledgesources` of type `manual` | Static |

### Per-source metadata
- **Name** — must be unique on the agent
- **Description** — used by orchestrator to decide when to query this source; verbose descriptions improve routing
- **Enabled** toggle — disables without deleting
- **Citation behavior** — show citations · suppress citations · numbered vs inline
- **Scope** — agent-level (default) or specific Generative answers node only

### Indexing / sync status panel
- **Status**: Ready · Indexing · Error · Updating · Quota exceeded
- **Last successful sync** timestamp
- **Item count** (files indexed / pages crawled / rows in scope)
- **Error log** — per-item failure reason (e.g. password-protected, sensitivity-labeled, >512 MB)

### Knowledge in Generative answers node (per-topic override)
- Topic-level **Use knowledge sources** picker (subset of agent-level sources)
- **Disable files** for this node (e.g. medical-info topic shouldn't use marketing PDFs)
- **Pre-defined data sources** (legacy: Bing Custom Search · Azure OpenAI on Your Data · Custom Data) — classic-mode fallback

## What Loom has today

From `apps/fiab-console/lib/editors/copilot-studio-editors.tsx::CopilotKnowledgeEditor` and `app/api/items/copilot-studio-knowledge/**`:
- Env picker + agent picker (reuses the agent editor's env/agent state)
- List knowledge sources for the selected agent (`GET /msdyn_knowledgesources?$filter=_msdyn_copilotid_value eq {agentId}`)
- Per-source row: name · type · URI · status
- **Add knowledge** dialog with a `type` dropdown supporting `url | file | sharepoint | dataverse-table`, plus name + URI fields
- POST to `/msdyn_knowledgesources` with `msdyn_copilotid@odata.bind` to attach to the agent
- **Delete** per row
- MessageBar surfacing Copilot-Studio-not-enabled 503 and Dataverse errors verbatim

## Gaps for parity

1. **Source-type coverage** — Loom only supports `url | file | sharepoint | dataverse-table`. Missing: OneDrive, SharePoint connector variant, Azure AI Search, real-time connectors (Salesforce/ServiceNow/Confluence/Zendesk/Snowflake), manual Q&A entries
2. **File upload** — Loom takes a URI string; no drag-and-drop, no `.docx/.pptx/.pdf/.xlsx` mime gate, no 512 MB enforcement, no actual file upload to Dataverse (the file content has to land as a `msdyn_file` annotation/note, not just a URI)
3. **OneDrive / SharePoint browse-items picker** — Loom can't open the Graph item picker; the maker must paste a URL
4. **Dataverse table picker** — no schema browser; the maker has to type the table logical name (e.g. `account`) blind
5. **Dataverse grounding strategy** — `Single best record` vs `Multiple top records` not exposed
6. **Azure AI Search wiring** — no service-name / index-name / vector-field config form
7. **Real-time connector picker** — no list of 1500+ connectors with connection-ref selection
8. **Description field** — Loom doesn't write `msdyn_description` on the source; orchestrator routing quality suffers
9. **Status surface** — Loom shows raw `msdyn_status` string only; no Ready/Indexing/Error/Updating chip, no item count, no error-log drawer
10. **Last-indexed timestamp** — not displayed
11. **Reindex / refresh-now button** — not exposed
12. **Citation behavior** — show/suppress citations toggle not exposed
13. **Enabled/disabled toggle** — Loom only has delete; no soft-disable
14. **Per-node knowledge scoping** — Loom always attaches at agent level; can't scope to a single Generative answers node
15. **Quota visibility** — Dataverse storage consumed by knowledge files is not shown; the maker hits 500-object/512 MB walls blind
16. **Sensitivity-label / password-protected file detection** — not surfaced (Microsoft Learn calls out these never index but show as Ready)

## Backend mapping

Dataverse Web API on the env's instance URL:
- **List/CRUD** — `msdyn_knowledgesources` (id · name · type · uri · description · status · `_msdyn_copilotid_value` · createdon)
- **File payload** — files live as `annotation` (Note) records bound to the `msdyn_knowledgesource` row, with `documentbody` (base64) + `mimetype` + `filename`; Loom needs to POST the annotation alongside the source row
- **Connector knowledge sources** — `msdyn_knowledgesources` of type `connector` + connection-reference GUID; the connection itself is in `connectionreferences` table (created via the connector picker)
- **Azure AI Search sources** — `msdyn_knowledgesources` of type `azureaisearch` + JSON config in `msdyn_configuration` (service URL · index name · key vault ref or API key · vector field name)
- **Sync trigger** — bound action `Microsoft.Dynamics.CRM.msdyn_RefreshKnowledgeSource` (reindex now)
- **Status events** — Dataverse `cdsentitydataservices` change events; Loom can poll `msdyn_status` and `modifiedon`

## Required Azure resources / tenant settings

- All Agent-editor prerequisites (env + Copilot Studio enabled + Dataverse App User)
- **Dataverse search enabled** — Environment Settings → Product → Features → Dataverse search = On (required for file/SharePoint/OneDrive knowledge — Microsoft Learn flags this prerequisite)
- **PowerAIExtensions solution** version 1.01.688+ — required for SharePoint/OneDrive file-upload variant
- **For Azure AI Search source**: existing Azure AI Search service (`Microsoft.Search/searchServices`) + index built with vector field; key vault secret or managed identity for auth
- **For real-time connectors**: connector connection in the env (`connectionreferences`); per-connector licensing (premium connectors require Power Apps / Power Automate per-user license)
- **For SharePoint / OneDrive**: `Sites.Read.All` + `Files.Read.All` granted to the Copilot Studio SP (admin consent)
- **For unstructured data licensing**: messages count against Copilot generative-answers billing; storage counts against Dataverse storage entitlement

## Estimated effort

3 sessions. File upload (multipart → annotation) + drag-and-drop + mime gate + 512 MB check is ~1 session. OneDrive/SharePoint Graph browse-items picker + connector picker + Dataverse table schema browser is ~1 session (Graph + connector-list API integration). Azure AI Search wiring + status chips + reindex button + description field + per-node scoping is the third session. Real-time connectors deeper integration (1500+ connectors with auth flow) can spill into a fourth session if the connector picker has to ship full UX.
