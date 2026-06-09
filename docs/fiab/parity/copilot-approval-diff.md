# copilot-approval-diff — parity with the Copilot "Keep / Undo" edit-approval gate

Source UI: Microsoft Fabric Notebook Copilot + Visual Studio / Copilot inline
"Keep / Undo" review affordance (Learn: *Use Copilot in Fabric notebooks*,
*Review and accept Copilot code suggestions*) and the GitHub Copilot Chat
"Apply in Editor" → diff-review flow. CSA Loom is Azure-native: the before/after
text is produced by the Loom orchestrator over Azure OpenAI (Foundry-resolved),
never by Fabric Copilot.

## The capability being matched

Across Fabric notebook Copilot, VS Code Copilot, and the Azure portal query
editors, any AI-proposed code/query/transform change is **never applied
silently**. The user is shown a **diff** (original vs proposed) and must make an
explicit **Keep / Accept** decision; **Undo / Discard** leaves the editor
unchanged. Nothing mutates the document until Keep.

## Azure/Fabric feature inventory

| # | Capability (real UI) | Notes |
|---|----------------------|-------|
| 1 | A proposed change surfaces a **before/after diff**, not just new text | side-by-side or inline |
| 2 | **Keep / Accept** applies the change to the actual editor surface | mutates the real cell/query |
| 3 | **Undo / Discard / Esc** leaves the editor byte-for-byte unchanged | no mutation |
| 4 | **No change is applied without an explicit Keep** | gate is mandatory |
| 5 | Diff uses the editor's syntax highlighting (language-aware) | Monaco diff |
| 6 | Keyboard + screen-reader accessible (Esc to dismiss, labelled) | a11y |
| 7 | Multi-block answers are reviewable before applying | notebook multi-cell |
| 8 | Stale proposal (editor closed) fails honestly, not silently | robustness |

## Loom coverage

| # | Capability | Status | Where |
|---|-----------|--------|-------|
| 1 | Before/after diff (Monaco `DiffEditor`, side-by-side, read-only) | built ✅ | `lib/components/copilot-diff.tsx` |
| 2 | **Keep** applies via the editor-mutation bridge / `onApplyCells` | built ✅ | `apply-change.ts` `applyChange()`; notebook `keepApply` |
| 3 | **Undo** discards; editor unchanged | built ✅ | `copilot-diff.tsx` `onUndo`; pane `setPendingChange(null)` |
| 4 | Mutation ONLY on Keep — orchestrator emits `proposed_change`, never applies | built ✅ | `copilot-orchestrator.ts` (yields step; no server mutation) |
| 5 | Language-aware highlighting (python/sql/kql/… via `mapLanguage`) | built ✅ | `copilot-diff.tsx` `mapLanguage` |
| 6 | Esc dismiss (Fluent `Dialog` `onOpenChange`), labelled surface + live region | built ✅ | `copilot-diff.tsx` |
| 7 | Multi-block answers reviewed before applying (notebook chat pane) | built ✅ | `copilot-chat-pane.tsx` `openApplyDiff` |
| 8 | Stale target → `applyChange` returns false → honest system note | built ✅ | `copilot-pane.tsx` `keepChange` |

Zero ❌. Zero stub banners.

## Backend per control

- **before/after generation** — Loom orchestrator over Azure OpenAI
  (`copilot-orchestrator.ts` → `callAoai`, Foundry/tenant-resolved deployment).
  The `notebook_propose_refactor` tool returns the proposed source; the
  orchestrator strips the `__proposedChange__` sentinel before the model sees
  the result and emits a `proposed_change` step. Per-cloud token scope handled
  by existing `cogScope()` / `getOpenAiSuffix()` (Commercial / GCC / GCC-High /
  IL5). No Fabric/Power BI REST on any path.
- **Keep (orchestrator flow)** — `applyChange(target, after)` routes to the
  editor bridge registered by `NotebookEditor` (`registerBridge`), mutating the
  real cell in React state; Save (Ctrl+S) persists to Cosmos via the existing
  `PUT /api/items/notebook/[id]`.
- **Keep (notebook chat-pane flow)** — `onApplyCells(blocks)`, the existing
  notebook applier.
- **Undo** — pure client discard; no backend call.

## No-dependency / no-vaporware notes

- No new Azure resource, env var, RBAC grant, or Cosmos container — Monaco is
  self-hosted from the existing `/monaco/vs` static assets; the `proposed_change`
  arm is additive to the `copilot-sessions` step store. **No bicep change.**
- Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset — the diff is pure UI +
  Azure-OpenAI text; the bridge mutates local React state, never a Fabric API.
- Bridge keys are deterministic (`notebook-cell:<id>`), not user-authored JSON —
  honors `loom-no-freeform-config`.

## Verification

- `tsc --noEmit` clean on all touched files.
- `vitest` (pure-logic suites, 8/8): `apply-change.test.ts` (register / apply /
  cleanup / stale-returns-false) + `copilot-proposed-change.test.ts` (sentinel
  stripped from model-facing result; payload parsed/normalized).
- `copilot-diff.test.tsx` (render suite) asserts: closed when `change` is null;
  real before/after reach the diff surface; **onKeep fires only on the Keep
  click (never on open)**; Undo discards without applying. Runs in CI's real
  install (the local isolated worktree cannot mount jsdom through nested pnpm
  junctions — a known harness limitation, not a code defect).
