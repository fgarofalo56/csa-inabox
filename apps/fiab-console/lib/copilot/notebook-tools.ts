/**
 * In-cell Copilot — pure tooling for the per-cell Notebook Copilot popover.
 *
 * This module is the single canonical source for:
 *   - parseInCellCommand  : slash-command / free-form → mode + residual prompt
 *   - inCellResultAction  : mode (+ prompt) → 'insert-below' | 'propose-edit'
 *   - buildAssistMessages : mode → AOAI system + user message pair
 *
 * It is import-minimal on PURPOSE: no React, no Azure SDK, no Next runtime —
 * only the NotebookCell language type. That lets BOTH surfaces share it:
 *   • code-cell.tsx ('use client') imports parseInCellCommand + inCellResultAction
 *     to drive the popover and route a code-modifying result to the approval-diff
 *     panel instead of inserting a new cell.
 *   • app/api/notebook/[id]/assist/route.ts (server) imports buildAssistMessages
 *     so the cell-scoped prompts stay aligned from one place.
 *
 * Parity note (Fabric in-cell Copilot): the slash set is /explain, /fix,
 * /comments, /optimize, /generate <desc>, plus free-form text. /explain emits
 * prose (a markdown cell below); /generate of a NEW cell is inserted below; the
 * code-MODIFYING commands (/fix, /comments, /optimize, and a free-form refactor)
 * propose an in-place edit reviewed via the approval-diff before they apply.
 */
import type { NotebookCellLang } from '@/lib/types/notebook-cell';

export type InCellMode = 'explain' | 'fix' | 'comments' | 'optimize' | 'generate';

/**
 * Free-form prompts that REWRITE the current cell (rather than asking for a new,
 * standalone cell) should land in the approval-diff, not be inserted below. We
 * detect that intent by a small, conservative verb set on the leading words.
 */
const REFACTOR_KEYWORDS = [
  'convert', 'refactor', 'rename', 'move', 'extract', 'rewrite', 'wrap',
  'turn this', 'turn it', 'make this', 'make it', 'split', 'inline', 'modularize',
  'modularise', 'parameterize', 'parameterise', 'add type hints', 'add types',
];

/**
 * Map the in-cell prompt box to an assist mode + residual prompt.
 *   /explain        → explain  (prose, inserted as a markdown cell below)
 *   /fix            → fix       (corrected code, approval-diff)
 *   /comments       → comments  (re-commented code, approval-diff)
 *   /optimize       → optimize  (perf-rewritten code, approval-diff)
 *   /generate <txt> → generate  (new runnable cell from a description)
 *   <free text>     → generate  (refactor verbs route to approval-diff downstream)
 */
export function parseInCellCommand(raw: string): { mode: InCellMode; prompt: string } {
  const t = (raw || '').trim();
  if (t.startsWith('/explain')) return { mode: 'explain', prompt: t.slice('/explain'.length).trim() };
  if (t.startsWith('/fix')) return { mode: 'fix', prompt: t.slice('/fix'.length).trim() };
  if (t.startsWith('/comments')) return { mode: 'comments', prompt: t.slice('/comments'.length).trim() };
  if (t.startsWith('/optimize')) return { mode: 'optimize', prompt: t.slice('/optimize'.length).trim() };
  if (t.startsWith('/generate')) return { mode: 'generate', prompt: t.slice('/generate'.length).trim() };
  return { mode: 'generate', prompt: t };
}

/**
 * Decide what happens to the AOAI result:
 *   'insert-below' : explain (markdown cell) and a free-form /generate that asks
 *                    for a NEW standalone cell.
 *   'propose-edit' : fix, comments, optimize (they rewrite the current cell), and
 *                    a free-form /generate whose prompt is a refactor of the
 *                    current cell ("convert to a function", "refactor this", …).
 * The caller (code-cell.tsx) routes 'propose-edit' to the approval-diff UI and
 * applies the change in-place on Accept; 'insert-below' splices a new cell.
 */
export function inCellResultAction(mode: InCellMode, prompt: string): 'insert-below' | 'propose-edit' {
  if (mode === 'explain') return 'insert-below';
  if (mode === 'fix' || mode === 'comments' || mode === 'optimize') return 'propose-edit';
  // mode === 'generate'
  const p = (prompt || '').trim().toLowerCase();
  return REFACTOR_KEYWORDS.some((k) => p.startsWith(k) || p.includes(` ${k} `)) ? 'propose-edit' : 'insert-below';
}

const LANG_LABEL: Record<string, string> = {
  pyspark: 'PySpark (Python)',
  spark: 'Spark (Scala)',
  sql: 'Spark SQL',
  sparksql: 'Spark SQL',
  sparkr: 'SparkR (R)',
  python: 'Python',
  tsql: 'T-SQL',
};

export function langLabel(lang: string): string {
  return LANG_LABEL[lang] || lang;
}

/**
 * Build the AOAI system + user message pair for the cell-scoped assist. The
 * code-modifying modes (fix / comments / optimize / generate) return ONLY code
 * — no prose, no fences, no leading language tag — because the result either
 * replaces the cell source (propose-edit) or becomes a new runnable cell. The
 * route still strips a stray fenced block defensively. /explain returns prose.
 */
export function buildAssistMessages(
  mode: InCellMode,
  lang: NotebookCellLang | string,
  source: string,
  prompt: string,
  errorText: string,
  schema: string,
): { role: 'system' | 'user'; content: string }[] {
  const langName = langLabel(String(lang));
  const schemaSection = (schema || '').trim()
    ? `\n\nLakehouse schema context (ground every reference in these REAL container/table/column names — never invent them):\n${schema}`
    : '';
  const codeOnly =
    ` Return ONLY the resulting ${langName} code for the cell — no markdown fences, no commentary, ` +
    `no leading language tag. Preserve the user's variable, DataFrame, and column names exactly.`;

  if (mode === 'generate') {
    return [
      {
        role: 'system',
        content:
          `You are a Spark notebook code generator for the CSA Loom platform (Azure Synapse Spark). ` +
          `Given a natural-language request and the CURRENT CELL, write idiomatic, runnable ${langName} ` +
          `code for a SINGLE notebook cell. Assume a SparkSession named \`spark\` is already available. ` +
          `If the request is a refactor of the current cell (e.g. "convert to a function"), transform the ` +
          `current cell's code accordingly while keeping the same behaviour.` +
          codeOnly +
          schemaSection,
      },
      {
        role: 'user',
        content: source.trim()
          ? `Request: ${prompt || 'Improve this cell.'}\n\nCURRENT CELL:\n${source}`
          : (prompt || 'Write a PySpark cell that reads from the bronze container.'),
      },
    ];
  }

  if (mode === 'explain') {
    return [
      {
        role: 'system',
        content:
          `You are a Spark notebook assistant for the CSA Loom platform. Explain what the following ` +
          `${langName} cell does in 3-5 concise sentences, referencing the ACTUAL variable, DataFrame, ` +
          `and column names. Describe the data flow, transformations, and business intent. Plain prose, ` +
          `no code fences.` +
          schemaSection,
      },
      { role: 'user', content: `Cell source:\n\`\`\`\n${source}\n\`\`\`` },
    ];
  }

  if (mode === 'comments') {
    return [
      {
        role: 'system',
        content:
          `You are a Spark notebook assistant for the CSA Loom platform. Return the CURRENT ${langName} ` +
          `cell's source with a clear, concise comment/docstring added above or beside every non-trivial ` +
          `line, preserving the EXACT logic and variable names. Do not change behaviour.` +
          codeOnly +
          schemaSection,
      },
      { role: 'user', content: `Cell source:\n\`\`\`\n${source}\n\`\`\`` },
    ];
  }

  if (mode === 'optimize') {
    return [
      {
        role: 'system',
        content:
          `You are a Spark performance engineer for the CSA Loom platform. Rewrite the CURRENT ${langName} ` +
          `cell for better Spark performance — avoid Python UDFs in favour of native/vectorized functions, ` +
          `broadcast small DataFrames, push down predicates and prune columns before joins, cache reused ` +
          `DataFrames, and prefer DataFrame ops over collect(). Keep the SAME output and the user's variable ` +
          `names.` +
          codeOnly +
          schemaSection,
      },
      { role: 'user', content: `Cell source:\n\`\`\`\n${source}\n\`\`\`` },
    ];
  }

  // mode === 'fix'
  return [
    {
      role: 'system',
      content:
        `You are a Spark notebook debugger for the CSA Loom platform. Fix the following ${langName} cell ` +
        `that produced an error, using the real error/traceback below to find the root cause.` +
        codeOnly +
        schemaSection,
    },
    { role: 'user', content: `Cell source:\n\`\`\`\n${source}\n\`\`\`\n\nError:\n${errorText || '(no error text supplied)'}` },
  ];
}
