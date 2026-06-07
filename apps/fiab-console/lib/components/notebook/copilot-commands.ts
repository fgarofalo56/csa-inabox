/**
 * In-cell Copilot — pure command/cell helpers.
 *
 * Extracted from code-cell.tsx so the slash-command parsing and result-cell
 * construction can be unit-tested without a DOM (the component render tests
 * cover the popover wiring). Mirrors the Fabric in-cell Copilot slash-command
 * set: /explain, /fix, /generate <description>, or free-form text.
 */
import { emptyCell, type NotebookCell, type NotebookCellLang } from '@/lib/types/notebook-cell';

export type CopilotMode = 'explain' | 'generate' | 'fix';

/**
 * Maps the in-cell Copilot text box to an assist-route mode + residual prompt.
 *   /explain        → explain  (inserted as a markdown cell)
 *   /fix            → fix       (corrected code from the cell's error output)
 *   /generate <txt> → generate  (new runnable cell from a description)
 *   <free text>     → generate
 */
export function parseCopilotCommand(raw: string): { mode: CopilotMode; prompt: string } {
  const t = raw.trim();
  if (t.startsWith('/explain')) return { mode: 'explain', prompt: t.slice('/explain'.length).trim() };
  if (t.startsWith('/fix')) return { mode: 'fix', prompt: t.slice('/fix'.length).trim() };
  if (t.startsWith('/generate')) return { mode: 'generate', prompt: t.slice('/generate'.length).trim() };
  return { mode: 'generate', prompt: t };
}

/**
 * Turns an assist-route `result` string into the new cell inserted below the
 * source cell. `/explain` yields a styled markdown cell; `/generate` and `/fix`
 * yield a runnable code cell in the source cell's language.
 */
export function copilotResultCell(mode: CopilotMode, lang: NotebookCellLang, result: string): NotebookCell {
  return mode === 'explain'
    ? { ...emptyCell('markdown'), source: `## Copilot explanation\n\n${result}` }
    : { ...emptyCell('code', lang), source: result };
}
