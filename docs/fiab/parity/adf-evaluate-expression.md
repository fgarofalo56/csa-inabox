# evaluate-expression — parity with ADF/Synapse/Fabric "Evaluate expression" (F9)

Source UI:
- Fabric: https://learn.microsoft.com/fabric/data-factory/evaluate-pipeline-expression
- ADF/Synapse expression builder: https://learn.microsoft.com/azure/data-factory/control-flow-expression-language-functions
- System variables: https://learn.microsoft.com/azure/data-factory/control-flow-system-variables

The "Evaluate expression" affordance lives inside the pipeline expression
("Add dynamic content") builder. It previews the resolved output of an
expression **before** running the pipeline. Per Microsoft's docs it is purely
client-side and "doesn't pull a run ID, trigger instance ID, activity outputs,
or any values that only exist during a run. So, you'll have to manually provide
these values."

## Source feature inventory

| # | Capability | Source behaviour |
|---|------------|------------------|
| 1 | **Evaluate button** in the expression builder | Resolves the current expression and shows the value |
| 2 | Client-side resolution of design-time tokens | parameters, variables, functions, system variables resolved without a backend |
| 3 | Editable **sample-value fields** for run-time-only tokens | trigger time, run id, activity outputs typed by the user |
| 4 | **Result panel** showing the resolved value | string / JSON output |
| 5 | Full ADF expression-function library | String / Collection / Logical / Conversion / Math / Date |
| 6 | String interpolation `@{…}` + full `@expr` forms | both evaluated |
| 7 | Honest "value not supplied" feedback | resolver flags tokens with no sample value |

## Loom coverage

| # | Capability | Status | Notes |
|---|------------|--------|-------|
| 1 | Evaluate button | built ✅ | `Play20Regular` button in the dialog's `DialogActions`, spinner while busy |
| 2 | Client-side resolver | built ✅ | `evaluateExpression()` — hand-rolled recursive-descent parser over the ADF grammar, no new dependency |
| 3 | Sample-value fields | built ✅ | `detectSampleInputs()` surfaces only run-time-only tokens (activity outputs, run system vars, params/vars not defined on the pipeline); editable `Input` per token |
| 4 | Result panel | built ✅ | `<pre>` with JSON/scalar output; error MessageBar on parse failure |
| 5 | Function library | built ✅ | every function in `EXPRESSION_CATEGORIES` (String/Collection/Logical/Conversion/Math/Date) implemented in `FUNCS` |
| 6 | Interpolation + full expr | built ✅ | `splitInterpolation()` brace-balanced; `@@` escape; pure `@{…}` returns the typed value |
| 7 | Unresolved-token feedback | built ✅ | `unresolvedTokens[]` → warning MessageBar listing the tokens to supply |
| 8 | **Loom enhancement** — pre-fill from last real run | built ✅ (honest-gate) | `/evaluate` route returns the last ADF run's real activity outputs + run system vars to pre-populate blanks; honest empty pre-fill when no ADF backing / no runs / config-gated |

Zero ❌. No stub banners.

## Backend per control

| Control | Backend |
|---------|---------|
| Evaluate (client resolution) | none — pure client-side, exactly like Fabric F9 |
| Sample pre-fill | `POST /api/items/data-pipeline/[id]/evaluate?workspaceId=…` → `adf-client.listPipelineRuns` + `listActivityRuns` (ADF ARM `2018-06-01`, real run outputs). No new run is triggered. |

## Azure-native default

No Fabric dependency. The resolver is local; the pre-fill route calls Azure
Data Factory ARM (`management.azure.com`) under the existing **Data Factory
Contributor** grant (`673868aa-7521-48a0-acc6-0f60742d39f5`) on the Loom
factory. Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. No new Azure
resource, env var, role assignment, or Cosmos container — no bicep change.

## Design note — why not `debugPipeline`

The ADF ARM API exposes no synchronous expression-evaluate or
single-activity-breakpoint endpoint. `debugPipeline` (used by `/debug`) calls
`createRun`, which queues an **asynchronous** pipeline run taking minutes and
charging compute — that is not how Fabric's F9 evaluator behaves. The
`/evaluate` route therefore returns the **last real run's** activity outputs
(read-only) instead of triggering a fresh run.

## Verification

- `lib/components/pipeline/__tests__/evaluate-expression.test.ts` — 13 tests
  GREEN (concat+param+variable, activity-output sub-fields, interpolation,
  nested if/greater/int, deterministic formatDateTime, unresolved-token
  flagging, system-var resolution, parse-error handling, sample-input
  detection).
- Manual: author `@concat(pipeline().parameters.env,'-',variables('x'))`, fill
  sample values, Evaluate → resolved string. `@activity('X').output.rowsCopied`
  with `{"rowsCopied":42}` → `42`; with a real ADF run bound, the pre-fill
  route supplies the live output.
