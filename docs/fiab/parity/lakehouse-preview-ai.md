# lakehouse-preview-ai — parity with Fabric Data Wrangler AI, on the Lakehouse Preview grid

> Sibling of `docs/fiab/parity/data-wrangler-ai.md` (the notebook, pandas-host
> Data Wrangler AI panel). This doc covers the **second** Data Wrangler AI entry
> point the G4 gap named: the **"AI" tab on the Lakehouse Preview DataGrid**,
> where prep runs on **Synapse Spark (Livy)** over the ADLS source rather than a
> notebook pandas host.

Source UI:
- **Fabric Data Wrangler → AI / Copilot experience** — suggested cleaning
  operations from the data profile, natural-language → transform code, and a live
  sample preview of each step before it is committed to the notebook.
  https://learn.microsoft.com/fabric/data-science/data-wrangler-ai
- **Fabric Data Wrangler → "Summary" / column-statistics panel** — the per-column
  profile that grounds the AI suggestions (already built in Loom —
  `docs/fiab/parity/lakehouse-preview.md`).

Loom surface: the **"AI" tab** on the Lakehouse **Preview** DataGrid — a new
`TabList` [Data | AI] on
`apps/fiab-console/lib/editors/components/delta-preview-grid.tsx`, with the panel
`apps/fiab-console/lib/editors/components/data-wrangler-ai-panel.tsx`. It sits
alongside the existing File/Table toggle + Spark column-statistics panel and
reuses that statistics output as the profile it feeds to Azure OpenAI. No
Microsoft Fabric / OneLake / Power BI dependency (per `no-fabric-dependency.md`):
suggestions = real Azure OpenAI; NL code-gen = the notebook-persona Copilot (real
AOAI grounded on the ADLS Delta schema); live preview = real Synapse Spark (Livy)
over the ADLS Gen2 source.

## Fabric feature inventory → Loom coverage

| Capability (Fabric Data Wrangler AI) | Loom coverage | Backend per control |
|---|---|---|
| AI tab distinct from the data/summary view | built ✅ — `TabList` [Data \| AI] on `DeltaPreviewGrid` (`enableAiTab`, default on; off in the nested preview grid) | client tab state |
| Copilot cleaning suggestions from the column profile | built ✅ — "Generate cleaning suggestions" cards (trim / cast / dedupe / fill-null / outlier-flag) | `POST /api/lakehouse/ai-clean-suggest` → `aoaiChatJson` (real AOAI) grounded on the Spark stats + sample rows |
| Each suggestion carries runnable transform code | built ✅ — per-card PySpark over the bound `df`, server-sanitized (fences stripped, DataFrame var normalized) + validated (known kind, known column, non-empty) | `ai-clean-suggest` route |
| NL → transform code | built ✅ — plain-English box → streamed PySpark / Spark SQL scoped to the active DataFrame + columns | `POST /api/copilot/notebook-assist` (command `generate`, SSE) → notebook persona + `notebook_generate_code` tool (real ADLS Delta schema) |
| Approval diff before insert | built ✅ — generated code shown in a review card with Insert / Copy / Regenerate; suggestion code shown before any apply | client |
| Insert into the bound notebook cell | built ✅ (seam) — `onInsertToNotebook(code, lang)` prop; the standalone Lakehouse preview has no bound notebook, so it falls back to copy-to-clipboard with the code visible | host callback |
| Preview-before-apply on a live sample | built ✅ — "Preview" runs the candidate against a sampled copy of the source and renders the resulting rows back in a nested `DeltaPreviewGrid`, with +/− column badges + timing | `POST`/`GET /api/lakehouse/transform-preview` → Livy `df.limit(n)` scratch statement (real Synapse Spark) |
| Honest transform-error surfacing | built ✅ — a candidate that throws returns `status:'transform_error'` with the real Python exception, not a dead session | `transform-preview` route (try/except wrapper prints `LOOM_PREVIEW:{error}`) |
| Honest infra gates | ⚠️ — AOAI: `503 { code:'no_aoai', hint }`; Spark: `503 { code:'not_configured', missing:'LOOM_SYNAPSE_WORKSPACE' }`; live preview disabled with a reason when no file source is selected | `resolveAoaiTarget` / `synapseConfigGate` |
| Per-column AI functions in the grid | built ✅ (G2, reused) — "Add AI column" on the Data tab | `POST /api/ai-functions/table` (real AOAI batch) |

Zero ❌ — every Data Wrangler AI capability is built, with honest Fluent
MessageBar gates when the Azure OpenAI deployment or Synapse Spark workspace env
vars are unset, and a copy-only fallback where no notebook is bound.

## Backend / data flow

1. **Suggestions** — the AI tab POSTs the previewed `columns`, the Spark
   `columnStats` (the same `summary()` output the Table tab computed), a few
   sample rows, and the detected numeric columns to
   `/api/lakehouse/ai-clean-suggest`. The route builds a compact profile,
   resolves the tenant/Foundry AOAI target (honest `no_aoai` gate), and asks the
   model for JSON suggestion cards. Every card is validated against the real
   column set + the fixed kind allowlist and its code is sanitized before it
   reaches the UI.
2. **NL → code** — the NL box streams from `/api/copilot/notebook-assist`
   (`command:'generate'`), the SAME notebook-persona Copilot the notebook editor
   uses, scoped with a synthetic context cell naming the active DataFrame + its
   columns. The generated code is shown as an approval diff.
3. **Live preview** — "Preview" POSTs the candidate PySpark to
   `/api/lakehouse/transform-preview`, which reuses the Livy interactive-session
   plumbing from `/api/lakehouse/table-stats`: create session → (once idle) submit
   a scratch statement that loads the ADLS source into `df.limit(n)`, run the
   candidate inside a try/except, print the first rows as `LOOM_PREVIEW:<json>`.
   The client polls every 3 s (cold-pool-safe) and renders the result rows in a
   nested `DeltaPreviewGrid`. The candidate never writes.

## Bicep sync

No new Azure resource. Reuses the AOAI chat deployment resolved by
`resolveAoaiTarget` (AI Foundry hub / `LOOM_AOAI_ENDPOINT`+`LOOM_AOAI_DEPLOYMENT`,
wired day-one via `platform/fiab/bicep/modules/ai/foundry-project.bicep`) and the
`loompool` Synapse Spark pool (`LOOM_SPARK_POOL`, deployed by
`platform/fiab/bicep/modules/landing-zone/synapse.bicep`) — the same pool the
column-statistics job runs on.

## Verification

- `app/api/lakehouse/__tests__/ai-clean-suggest.test.ts` (5) — 401 / 400 / 503
  no_aoai gate / suggestion validation + sanitization / DataFrame-var rewrite.
- `app/api/lakehouse/__tests__/transform-preview.test.ts` (10) — 401 / 503 gate /
  400 / warming vs running kick-off / poll parse of `LOOM_PREVIEW` / honest
  transform_error / stmt-less warm-up submit.
- `tsc -p tsconfig.build.json` clean; `no-bare-client-fetch` + `no-freeform`
  guards pass (the `-assist` SSE call is the sanctioned streaming exception).
- Live (owed, per `loom_browser_e2e_before_done`): with `LOOM_AOAI_*` +
  `LOOM_SYNAPSE_WORKSPACE` + `LOOM_{BRONZE,…}_URL` set, open a Delta/CSV file in
  the Lakehouse Preview → AI tab → Generate cleaning suggestions → Preview a
  trim/fill-null card (real Spark sample rows render) → NL box "add a month
  column from order_date" → generated PySpark → Preview → Copy.
