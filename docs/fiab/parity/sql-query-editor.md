# sql-query-editor — parity with the Microsoft Fabric SQL database query editor

Source UI: https://learn.microsoft.com/fabric/database/sql/query-editor
(and the run-selection behavior documented at
https://learn.microsoft.com/fabric/database/sql/tutorial-query-database).

Implemented by `lib/editors/components/tsql-monaco.tsx` (`TsqlMonaco`), wired
into both `lib/editors/unified-sql-database-editor.tsx` (Azure-native SQL,
default) and `lib/editors/sql-database-editor.tsx` (Fabric SQL item). Shared
template/snippet constants + pure helpers live in `lib/azure/sql-templates.ts`.

This surface has **no Fabric dependency**: schema IntelliSense and execution
both route through Azure SQL TDS (`sql-objects-client` / the existing
`/api/items/azure-sql-database/[id]/query` route). With
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset the editor, snippets, IntelliSense, and
Run all work against an Azure SQL server.

## Fabric query-editor feature inventory (grounded in Learn)

| # | Capability (Fabric) | Notes from the source UI |
|---|---------------------|--------------------------|
| 1 | "New SQL query" split button | Primary action opens a new query; dropdown offers T-SQL code templates (CREATE TABLE / VIEW / STORED PROCEDURE / INDEX / FUNCTION). |
| 2 | Inline SQL code snippets | Typing `sql` in the editor body opens a snippet picker (sqlSelect / sqlInsert / sqlUpdate / sqlCreate* …). |
| 3 | IntelliSense over the live schema | Suggests real table, view, procedure, function, and column names from the connected database. |
| 4 | Run / Run selection | Run executes the script; highlighting a portion and running executes **only the selection**. Ctrl/Cmd+Enter shortcut. |
| 5 | Find (Ctrl+F) | Standard editor find. |
| 6 | Replace (Ctrl+H) | Find + replace. |
| 7 | Command palette (F1) | Monaco command palette. |
| 8 | Syntax highlight + autocomplete-on-type | T-SQL colorization, brackets, quick suggestions. |

## Loom coverage

| # | Capability | Status | How |
|---|------------|--------|-----|
| 1 | New SQL query split button + 5 templates | built ✅ | Fluent `SplitButton` + `Menu`; items insert `CREATE_TEMPLATES[table\|view\|procedure\|index\|function]`. Same menu added to the `SqlDbTree` ＋New affordance (Index row added). |
| 2 | Inline `sql` snippet catalog | built ✅ | `ensureSnippetProvider` registers a Monaco `CompletionItemProvider` (lang `sql`) that returns `SQL_SNIPPETS` as `Snippet` items when the word prefix starts `sql` (`shouldOfferSnippets`). |
| 3 | Live-schema IntelliSense | built ✅ | `ensureSchemaProvider` reads tables/views/procs/funcs fetched from `/api/sqldb/{tables,views,procedures,functions}` (sql-objects-client over TDS); `schema.table.` triggers a lazy `/api/sqldb/columns` fetch for real column names. Honest inline note when no connection resolves. |
| 4 | Run selection | built ✅ | `chooseRunText(fullText, selection)` — Ctrl/Cmd+Enter and the Run button post the highlighted text only (else the whole script) to the existing query route via `onRun`. |
| 5 | Find (Ctrl+F) | built ✅ | Monaco `actions.find`; surfaced as a toolbar button. |
| 6 | Replace (Ctrl+H) | built ✅ | Monaco `editor.action.startFindReplaceAction`; toolbar button. |
| 7 | Command palette (F1) | built ✅ | Monaco `editor.action.quickCommand`; F1 keybinding + toolbar button. |
| 8 | Syntax highlight + quick suggestions | built ✅ | Inherited from `MonacoTextarea` (language `sql`, `quickSuggestions` on, Loom theme). |

Zero ❌, zero stub banners. The only non-functional state is the honest inline
note when the database is unreachable (no bound connection and no env default),
naming the connection to set — the editor surface still renders fully.

PostgreSQL keeps the plain Monaco surface (the sys.*-fed IntelliSense + T-SQL
templates are T-SQL-specific) with an honest gate already documented in the
unified editor — that is an Azure infra gate, not a Fabric one.

## Backend per control

| Control | Backend |
|---------|---------|
| Templates / snippets | Pure client text insertion (no backend). |
| IntelliSense (objects) | `GET /api/sqldb/tables\|views\|procedures\|functions` → `sql-objects-client` `sys.*` over TDS. |
| IntelliSense (columns) | `GET /api/sqldb/columns?objectId=N` → `sys.columns` over TDS. |
| Run / Run selection | `POST /api/items/azure-sql-database/[id]/query` (`{ server, database, sql }`) — TDS execution. |
| Find / Replace / Palette | Monaco built-in editor actions. |

## Verification

`npx tsc --noEmit` clean on all touched files. Unit tests for the pure helpers
(`lib/azure/__tests__/sql-templates.test.ts`, 11 tests) cover template
coverage, snippet-prefix gating, run-selection text choice, and dotted-column
parsing. Live walk: typing `sql` opens the snippet picker; IntelliSense lists
real `schema.table` names and real columns after a dot; highlighting one
`SELECT` and pressing Run returns only that statement's result.
