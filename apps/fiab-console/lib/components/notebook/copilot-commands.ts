/**
 * In-cell Copilot — pure command/cell helpers.
 *
 * Extracted from code-cell.tsx so the slash-command parsing and result-cell
 * construction can be unit-tested without a DOM (the component render tests
 * cover the popover wiring). Mirrors the Fabric in-cell Copilot slash-command
 * set: /explain, /fix, /generate <description>, or free-form text.
 */
import { emptyCell, type NotebookCell, type NotebookCellLang } from '@/lib/types/notebook-cell';
import { parseInCellCommand, type InCellMode } from '@/lib/copilot/notebook-tools';

export type CopilotMode = InCellMode;

/**
 * Maps the in-cell Copilot text box to an assist-route mode + residual prompt.
 *   /explain        → explain  (inserted as a markdown cell)
 *   /fix            → fix       (corrected code from the cell's error output)
 *   /comments       → comments  (re-commented code, approval-diff)
 *   /optimize       → optimize  (perf-rewritten code, approval-diff)
 *   /generate <txt> → generate  (new runnable cell from a description)
 *   <free text>     → generate
 *
 * Delegates to the canonical parser in notebook-tools so the popover wiring and
 * the server route can never diverge on the slash-command grammar.
 */
export function parseCopilotCommand(raw: string): { mode: CopilotMode; prompt: string } {
  return parseInCellCommand(raw);
}

/**
 * Turns an assist-route `result` string into the new cell inserted below the
 * source cell — used for the INSERT-BELOW result actions (`/explain` prose and
 * a free-form `/generate` of a new cell). `/explain` yields a styled markdown
 * cell; everything else yields a runnable code cell in the source language.
 * Code-modifying results (`/fix`, `/comments`, `/optimize`, free-form refactor)
 * replace the cell source in place via the approval-diff and never use this.
 */
export function copilotResultCell(mode: CopilotMode, lang: NotebookCellLang, result: string): NotebookCell {
  return mode === 'explain'
    ? { ...emptyCell('markdown'), source: `## Copilot explanation\n\n${result}` }
    : { ...emptyCell('code', lang), source: result };
}
