# dataflow-gen2-copilot — parity with Fabric Dataflow Gen2 Copilot

Source UI: https://learn.microsoft.com/fabric/data-factory/copilot-fabric-data-factory
(the Copilot pane inside the Dataflow Gen2 / Power Query Online editor)

Loom surface: the **Copilot** pane docked beside the Power Query authoring
surface in the Dataflow Gen2 editor (`lib/editors/dataflow-gen2-editor.tsx` →
`lib/components/pipeline/dataflow/dataflow-copilot-pane.tsx`).

Backend is **Azure-native by default** (per no-fabric-dependency): the only
external call is to the tenant's Azure OpenAI chat deployment. The execution
engine for the authored Power Query (M) is an ADF WranglingDataFlow on Spark.
No Fabric / Power BI / OneLake host is contacted on any path; the surface works
with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Fabric/Azure feature inventory

The Fabric Dataflow Gen2 Copilot exposes five capabilities in the PQO Copilot
pane, each rendered as a response card with a corresponding Applied Step:

1. **Generate a new query from natural language** — Copilot writes a new
   `shared Name = let … in …` query (often with sample data via `#table(...)`)
   and adds it to the Queries pane.
2. **Generate a query referencing existing queries** — "create a query that
   references Customers and filters to Europe" → a new query whose Source step
   references the named existing query.
3. **Explain the current query + applied steps** — a plain-English summary, one
   line per step.
4. **Add transformation steps** — "count employees by City" appends a real M
   applied step (e.g. `Table.Group`) chained off the prior step.
5. **Undo the last applied step** — removes the most recently appended step and
   rewires `in <result>`.

Each action is a response card; generated code is applied to the real query
after the user approves, and an Undo affordance reverses the applied change.

## Loom coverage

| # | Capability | Status | Notes |
|---|------------|--------|-------|
| 1 | Generate query from NL (with sample data) | built ✅ | `generate_query` → `generateQueryFromNL`; AOAI emits a complete `let..in` body validated by `parseLetBody` before Apply. `#table(...)` literals supported. |
| 2 | Generate query referencing an existing query | built ✅ | `reference_query` → `generateReferenceQuery`; first step must be `Source = <sourceQuery>` and is verified to reference it. |
| 3 | Explain the active query + applied steps | built ✅ | `explain` → `explainQuery`; one sentence per real Applied Step (steps read from the live M). |
| 4 | Add a transformation step | built ✅ | `add_step` → `generateTransformStep`; returns one `{stepName, stepExpr}`, validated by re-parsing the appended body. Applied via `appendStep` + `setQueryBody` — same path as a ribbon step. |
| 5 | Undo the last applied step | built ✅ | `undo` — pure M manipulation (no AOAI); `parseLetBody` → drop last step → `buildLetBody`. Refuses to remove the only remaining step. |
| — | Response card per action + Apply/Dismiss + Undo | built ✅ | Pending diff held until Apply; per-card Undo reverts exactly that edit using a pre-apply snapshot. |
| — | Honest gate when AOAI not wired | honest-gate ⚠️ | 503 `code:'no_aoai'` → MessageBar names `LOOM_AOAI_ENDPOINT` / `LOOM_AOAI_DEPLOYMENT` and the AI Foundry bicep; rest of the editor stays functional. |

Zero ❌. Zero stub banners. The Applied Steps pane is always parsed from the
real M (`parseSharedQueries` + `parseLetBody`) — there is no fabricated step
list; a Copilot step is indistinguishable from a ribbon step.

## Backend per control

| Control | Backend |
|---------|---------|
| New query / Add step / Reference / Explain | `POST /api/items/dataflow/copilot` → `lib/azure/dataflow-engine-client.ts` → Azure OpenAI chat completions (managed identity over the cloud-correct `cogScope()` cognitive-services scope) |
| Undo last step | `POST /api/items/dataflow/copilot` (intent `undo`) — pure `m-script.ts` manipulation, no network |
| Apply (write to M) | client-side `appendStep` / `setQueryBody` / `buildLetBody` from `m-script.ts`; the editor's existing Save PUTs the M to Cosmos; Save & Run compiles it into an ADF WranglingDataFlow |
| Live data preview of a step | real ADF WranglingDataFlow run (Output destination → Save & Run), unchanged from the existing editor |

## Per-cloud notes

- **Commercial / GCC** — `cogScope()` → `cognitiveservices.azure.com/.default`;
  `LOOM_AOAI_AUDIENCE` bicep emits the same. No changes.
- **GCC-High / DoD** — `cogScope()` → `cognitiveservices.azure.us/.default`;
  bicep emits `cognitiveservices.azure.us`. Operators deploy a gpt-4o-class
  model in their USGov AOAI account; the code path is identical. If AOAI is not
  deployed, the route returns the honest 503 gate and the editor stays usable.

## Infra / bicep

No new Azure resources. AOAI (`LOOM_AOAI_ENDPOINT`, `LOOM_AOAI_DEPLOYMENT`,
`LOOM_AOAI_AUDIENCE`) and ADF (`LOOM_ADF_NAME`, `LOOM_DLZ_RG`,
`LOOM_SUBSCRIPTION_ID`) are already wired by
`platform/fiab/bicep/modules/admin-plane/main.bicep`. The Console UAMI already
holds Cognitive Services OpenAI User on the Foundry/AOAI account.

## Verification

- `npx tsc --noEmit` — clean (touched files).
- `vitest run lib/copilot/__tests__/dataflow-tools.test.ts` — 7/7 green:
  `validateMScript`, copilot transform apply-path parity (`appendStep` +
  `setQueryBody` reparses as Applied Steps), `dataflow_undo_last_step` removes
  the real last step and refuses the last-remaining step, and the five-tool
  registry shape.
- Live AOAI E2E (operator, AOAI wired): "only keep European customers" adds a
  real `Table.SelectRows` filter step; "count employees by City" adds a real
  `Table.Group` step; "explain my query" describes the real steps; "undo last
  step" removes the real last step.
