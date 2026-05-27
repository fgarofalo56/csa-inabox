# copilot-template-library — parity gap (validator v2, 2026-05-26)

**Loom URL**: `/items/copilot-template-library/new`
**Fabric reference**: copilotstudio.microsoft.com — Template gallery (preview · use template)
**Loom screenshot**: `temp/parity/copilot-template-library-loom.png`

## Phase 4

| Route | Status | Notes |
|---|---|---|
| `GET /api/items/copilot-template-library` | 200 | Returns 5 real CSA-curated templates: Contract Analyzer (Legal), Data Steward Agent (Governance), FedRAMP Compliance Coach (Compliance), Lakehouse Q&A Assistant (Analytics), RFP Responder (Sales) |
| `POST /api/items/copilot-template-library/<id>` (use template) | wired | — |

UI renders a categorized card grid by category. Each card shows: template name · "Built-in" badge · description · suggested model · knowledge-source-type badges (sharepoint / url / dataverse-table) · topic count · "Use template" button.

## Phase 3 — Fabric vs Loom

| Copilot Studio element | Loom present? | Severity |
|---|---|---|
| Template gallery cards | YES | — |
| Category grouping | YES | — |
| Template description + suggested model | YES | — |
| **Template preview** (read instructions / topics / knowledge before creating) | NO — no preview modal | MAJOR |
| **Customize template before instantiating** (edit name / model / instructions on the way in) | NO — Use template is one-click | MAJOR |
| **Built-in vs custom template distinction** | YES (Built-in badge) | — |
| **My templates / shared templates** sections | NO (only CSA-curated) | MINOR |
| **Submit to template library** (publish a custom template from existing agent) | NO | MAJOR |
| Target environment picker | YES | — |
| Use template creates real Dataverse agent | wired (POST) — needs Copilot Studio enabled in env | — |

## Functional

- 5 templates load from Cosmos (real CSA library)
- Use template fires real POST (creates an agent + topics + knowledge in env when Copilot Studio is enabled)
- No preview / no customize-before-create

## Grade — **C+**

This is one of the best-shaped editors in the AI/ML group. Real curated data, good card grid, honest target-env picker, real create flow. Missing the preview modal and the customize-before-instantiate path. **Grade C+** — would be B with preview + per-template tweak form.
