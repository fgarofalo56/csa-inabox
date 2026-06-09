# copilot-slash-commands — parity with Fabric Copilot slash commands (notebook + SQL editors)

Source UI: Microsoft Fabric Notebook Copilot chat panel (`/fix`, `/explain`, `/comments`, `/optimize`)
and the Fabric Data Warehouse / SQL editor Copilot actions (Explain, Fix, Quick fix).
Loom is Azure-native (Azure OpenAI via the AI Foundry `chat` deployment) — no Fabric/Power BI
Copilot dependency, works with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET.

## Azure/Fabric feature inventory

The Fabric Copilot exposes a fixed set of leading slash commands in the notebook chat input,
and equivalent inline actions in the SQL/warehouse editor:

| Capability | Fabric behaviour |
|---|---|
| Slash-command menu | Typing `/` opens a menu of commands; arrow/Tab selects; the chosen command fills the input |
| `/explain` | Plain-language explanation of the selected cell / query, grounded in that code |
| `/fix` | Corrected code, using the cell's REAL last error |
| `/comments` | Same code with inline comments added |
| `/optimize` | Rewritten code for performance (engine-specific hints; query plan where available) |
| Command pill | The selected command shows as a committed token before the argument |
| Apply / approval | Code-producing results go through an Apply / diff affordance before replacing code |
| Context-scoped commands | Commands the surface can't fulfil are not offered |

## Loom coverage

| Inventory row | Loom coverage | Where |
|---|---|---|
| Slash-command menu (`/` opens, arrow/Tab/click selects, fills input) | ✅ built | `lib/components/notebook/copilot-chat-pane.tsx` (menu) + `lib/copilot/slash-commands.ts` (`isSlashMenuOpen`, `matchSlashCommands`) |
| Fixed allowlist parser (command + arg, unknown → null) | ✅ built | `lib/copilot/slash-commands.ts` `parseSlashCommand` (+ unit test) |
| `/explain` (prose, grounded in the selection) | ✅ built | notebook: `/api/copilot/notebook-assist`; SQL: `/api/items/[type]/[id]/assist` mode `explain` |
| `/fix` (uses the cell's real error) | ✅ built | notebook-assist (reads `activeCell.output` error); SQL assist mode `fix` |
| `/comments` (inline comments, names preserved) | ✅ built | notebook-assist; SQL assist mode `comments` |
| `/optimize` (engine-specific, real EXPLAIN plan where available) | ✅ built | SQL assist mode `optimize` — `SET SHOWPLAN_TEXT` (Synapse T-SQL) / `EXPLAIN` (Databricks) folded into the prompt, soft-fail |
| Command pill (committed command before the arg) | ✅ built | chat pane fills `cmd + ' '`; menu closes once committed (`isSlashMenuOpen`) |
| Apply / approval-diff for code results | ✅ built | notebook "Apply N cells" (`onApplyCells`); SQL editor `suggestion` → Apply button |
| Context-scoped commands (hidden where unsupported) | ✅ built | `lib/azure/copilot-personas.ts` `getPersonaCommands`; KQL persona hides `comments`/`optimize` |
| Cross-item Copilot can invoke the same actions as tools | ✅ built | `sql_explain` / `sql_fix` / `sql_comments` / `sql_optimize` in `buildDefaultRegistry()` |

Zero ❌ — every inventory row is built. No stub banners, no disabled-with-tooltip controls.

## Backend per control

- All four commands call Azure OpenAI chat-completions on the AI Foundry `chat` deployment via
  `resolveAoaiTarget()` (env `LOOM_AOAI_ENDPOINT` / `LOOM_AOAI_DEPLOYMENT`, stamped by
  `platform/fiab/bicep/modules/ai/foundry-project.bicep`). AAD bearer, `cogScope()` cloud-aware
  scope (`cognitiveservices.azure.com` Commercial/GCC, `.azure.us` GCC-High/IL5).
- Schema grounding: real Synapse `sys.columns` DMV (Dedicated/Serverless) or Databricks
  `information_schema.columns` — soft-fail to ungrounded when the pool/warehouse is cold.
- `/optimize` EXPLAIN plan: real `SET SHOWPLAN_TEXT ON` (Synapse) / `EXPLAIN` (Databricks),
  10s timeout, soft-fail.
- Honest gate: AOAI unresolved → 503 `code:'no_aoai'` with the exact env vars to set; the
  editor surfaces a Fluent MessageBar and stays fully functional for manual authoring + Run.

## No-Fabric verification

With `LOOM_DEFAULT_FABRIC_WORKSPACE` unset, every command runs against Azure OpenAI + Synapse/
Databricks — no `api.fabric.microsoft.com` / `api.powerbi.com` host is contacted on any path.

## Per-cloud notes

- GCC-High / IL5: `databricksSqlWarehouseEnabled=false` — the Databricks `EXPLAIN`/schema path is
  never reached; Synapse SQL (Dedicated + Serverless) keeps all four commands including SHOWPLAN
  grounding. ADX-backed KQL queryset keeps `explain`/`fix`.
