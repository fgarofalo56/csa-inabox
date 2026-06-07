# notebook-monaco-lsp — parity with the Fabric / VS Code notebook code editor (IntelliSense)

Source UI:
- Fabric notebook editor (Monaco + IntelliSense): https://learn.microsoft.com/fabric/data-engineering/author-execute-notebook
- VS Code Python IntelliSense (Pylance): https://learn.microsoft.com/visualstudio/python/editing-python-code-in-visual-studio
- jupyter-lsp (LSP in JupyterLab): https://github.com/jupyter-lsp/jupyterlab-lsp
- VS Code for the Web on AML compute instance: https://learn.microsoft.com/azure/machine-learning/how-to-launch-vs-code-remote

The Fabric notebook cell editor is a full Monaco surface with language-server
IntelliSense: member completions, signature help, hover docstrings, and
diagnostics. CSA Loom matches this on an **Azure-native, no-Fabric** path: cells
are Monaco editors wired over a WebSocket bridge to **python-lsp-server + pyright**
(the open-source engines Pylance is built on) running in the Console container.

## Source feature inventory

| # | Capability | Source behaviour |
|---|------------|------------------|
| 1 | Monaco code editor per cell (not a textarea) | syntax colouring, multi-cursor, find/replace, minimap |
| 2 | Member **completions** | `pd.read_` → `read_csv`, `read_parquet`, … from real stubs |
| 3 | **Hover** docstrings | hovering `pd.DataFrame` shows the docstring + signature |
| 4 | **Signature help** | parameter hints inside `func(` |
| 5 | **Diagnostics** (squigglies) | unresolved names / syntax errors underlined |
| 6 | Completion **resolve** (lazy docs) | docstring fetched when a row is highlighted |
| 7 | Per-language editor (Python / Scala / SQL / R) | language picker drives colouring + IntelliSense |
| 8 | Markdown cell editor | Monaco markdown editor with preview toggle |
| 9 | "Edit in VS Code" / open in richer IDE | Fabric/AML deep-link to a full VS Code surface |

## Loom coverage

| # | Capability | Status | Backend / wiring |
|---|------------|--------|------------------|
| 1 | Monaco per cell | built ✅ | `code-cell.tsx` renders `MonacoTextarea` (monaco-editor 0.52); **zero** HTML `<textarea>` cell editors remain |
| 2 | Completions | built ✅ | `notebook-lsp-client.mjs` registers `registerCompletionItemProvider` → `textDocument/completion` over WS → **pylsp/pyright** (`pandas-stubs`) |
| 3 | Hover docstrings | built ✅ | `registerHoverProvider` → `textDocument/hover` → pylsp |
| 4 | Signature help | built ✅ | `registerSignatureHelpProvider` → `textDocument/signatureHelp` |
| 5 | Diagnostics | built ✅ | `publishDiagnostics` → `monaco.editor.setModelMarkers` |
| 6 | Completion resolve | built ✅ | `resolveCompletionItem` → `completionItem/resolve` |
| 7 | Per-language editor | built ✅ (pre-existing) | `MonacoTextarea` language map; LSP attaches for `python`/`pyspark` cells, other languages keep Monaco built-ins |
| 8 | Markdown cell editor | built ✅ | `markdown-cell.tsx` now uses `MonacoTextarea` (markdown) + preview toggle — the last notebook `<textarea>` is gone |
| 9 | Open in VS Code for the Web | built ✅ (honest-gate) | `notebook-editor.tsx` button → `ml.azure.com/compute/instance/<i>/vscode?wsId=<id>`; **Commercial-only**, hidden in GCC/GCC-High/DoD, only shown when `LOOM_AML_INSTANCE` + `LOOM_AML_WORKSPACE_ID` are set (no dead button) |

Zero ❌. No stub banners.

## Backend per control

| Surface | Wire | Real backend |
|---------|------|--------------|
| `/api/notebook/[id]/lsp` (GET) | JSON probe | reports `lspAvailable` (`LOOM_PYLSP_ENABLED`), `wsUrl`, boundary, and the VS-Code-for-Web gate |
| `/api/notebook/[id]/lsp` (WS upgrade) | JSON-RPC-over-WebSocket ↔ Content-Length stdio | `pylsp` (`python -m pylsp`) spawned per socket by `lib/lsp/pylsp-bridge.mjs`, attached to the Next HTTP server in `instrumentation.ts` |
| auth on the WS upgrade | `loom_session` cookie (AES-256-GCM, HKDF from `SESSION_SECRET`) | decoded in-bridge — invalid sessions are destroyed before any process spawns |

## No-Fabric / sovereign notes

- **No Fabric/Power BI dependency.** The bridge spawns a local pylsp; it never
  calls `api.fabric.microsoft.com` / `api.powerbi.com`. Works with
  `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- **Opt-in & non-breaking.** The bridge only attaches when `LOOM_PYLSP_ENABLED`
  is set; the default image (`node server.js`, no Python) is untouched and the
  probe reports `lspAvailable:false`, leaving Monaco's built-in completions.
- **Gov boundaries.** The LSP bridge runs in-process in every cloud (no external
  calls). Only the **VS Code for the Web** deep-link is Commercial-only —
  Microsoft does not offer VS Code for the Web in GCC / GCC-High / DoD — so that
  one button is gated on `CSA_LOOM_BOUNDARY === 'Commercial'`.

## Verification

- `tests/e2e/notebook-lsp.spec.ts`: asserts code cells are Monaco (no legacy
  `<textarea>`), drives `import pandas as pd; pd.read_` to the `.suggest-widget`,
  and — when the bridge is live — asserts a real `read_csv` row + a
  `.monaco-hover` docstring on `pd.DataFrame`. Capture the completion-popup trace
  with `--trace on`.
- `lib/lsp/__tests__/pylsp-bridge.test.ts`: Vitest for the Content-Length framing
  round-trip (the load-bearing codec) + the cookie parser + the LSP→Monaco mappers.
- Bicep: `ml-workspace.bicep` adds the curated `loom-pylsp-env` AML Environment
  (jupyter-lsp + python-lsp-server + pyright); `app-deployments.bicep` wires
  `LOOM_PYLSP_ENABLED` / `LOOM_AML_*`; `Dockerfile` installs pylsp behind
  `--build-arg LOOM_INCLUDE_PYLSP=true`.
