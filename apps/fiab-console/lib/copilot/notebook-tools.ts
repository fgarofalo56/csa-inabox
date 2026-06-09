/**
 * In-cell Copilot — pure tooling for the per-cell Notebook Copilot popover.
 *
 * This module is the single canonical source for:
 *   - parseInCellCommand  : slash-command / free-form → mode + residual prompt
 *   - inCellResultAction  : mode (+ prompt) → 'insert-below' | 'propose-edit'
 *   - buildAssistMessages : mode → AOAI system + user message pair
 *
 * It also hosts the pure helpers for the "Fix with Copilot" inline cell-error
 * remediation (buildCellFixMessages / parseCellFixResponse / stripCodeFences),
 * extracted from /api/copilot/sessions so the prompt assembly and response
 * parsing can be unit-tested without spinning up Next.js or Azure OpenAI.
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

export const CELL_FIX_LANG_LABEL: Record<string, string> = {
  pyspark: 'PySpark (Python)',
  spark: 'Spark (Scala)',
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
export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface CellFixErrorContext {
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export interface CellFixExecutionDetails {
  executionCount?: number;
  durationMs?: number;
  executedAtUtc?: string;
  /** Livy / Spark pool name (from LOOM_SYNAPSE_SPARK_POOL on the server). */
  sessionPool?: string;
}

export interface CellFixRequest {
  cellSource: string;
  lang: string;
  errorContext: CellFixErrorContext;
  executionDetails?: CellFixExecutionDetails;
}

export interface CellFixResult {
  /** 1-2 sentence plain-language summary of what went wrong. */
  summary: string;
  /** 1 sentence root cause. */
  rootCause: string;
  /** Corrected, runnable cell code — no markdown fences. */
  proposedCode: string;
}

/**
 * Strip a single leading ```lang fence and a trailing ``` fence the model may
 * add despite instructions, then trim. Shared with the route so there is one
 * implementation.
 */
export function stripCodeFences(raw: string): string {
  return String(raw ?? '')
    .replace(/^\s*```[a-zA-Z0-9_+-]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

/** Compose the human-readable error text from the normalized Livy fields. */
function composeErrorText(ec: CellFixErrorContext): string {
  const ename = (ec.ename || '').trim();
  const evalue = (ec.evalue || '').trim();
  const traceback = Array.isArray(ec.traceback) ? ec.traceback.filter(Boolean) : [];
  return [[ename, evalue].filter(Boolean).join(': '), traceback.join('\n')]
    .filter(Boolean)
    .join('\n');
}

/** Render the optional execution-details block, or '' when nothing is present. */
function composeExecutionDetails(d?: CellFixExecutionDetails): string {
  if (!d) return '';
  const lines: string[] = [];
  if (typeof d.executionCount === 'number') lines.push(`Execution count: ${d.executionCount}`);
  if (typeof d.durationMs === 'number') lines.push(`Duration: ${d.durationMs} ms`);
  if (d.executedAtUtc) lines.push(`Executed at (UTC): ${d.executedAtUtc}`);
  if (d.sessionPool) lines.push(`Spark pool: ${d.sessionPool}`);
  return lines.length ? `\n\nExecution details:\n${lines.join('\n')}` : '';
}

/**
 * Build the AOAI chat-completions messages for a cell-fix request. The system
 * prompt pins the response to a strict JSON object so the pane can render a
 * summary + root cause above the proposed-fix diff.
 */
export function buildCellFixMessages(req: CellFixRequest): ChatMessage[] {
  const langName = CELL_FIX_LANG_LABEL[req.lang] || req.lang;
  const errorText = composeErrorText(req.errorContext);
  const execBlock = composeExecutionDetails(req.executionDetails);

  const system =
    `You are a Spark notebook debugger for the CSA Loom platform. You are given a ` +
    `${langName} cell that failed and the REAL error it produced. Assume a SparkSession ` +
    `named \`spark\` is already available. Diagnose the failure and produce a corrected, ` +
    `runnable version of the cell.\n\n` +
    `Respond with ONLY a single valid JSON object — no markdown fences, no prose before ` +
    `or after — with exactly these keys:\n` +
    `  "summary": a 1-2 sentence plain-language summary of what went wrong,\n` +
    `  "rootCause": a single sentence naming the underlying cause,\n` +
    `  "proposedCode": the full corrected ${langName} cell as a string (runnable, no ` +
    `markdown fences, no language tag).\n` +
    `The "proposedCode" must address the actual error shown — do not invent table, ` +
    `column, or container names that are not implied by the cell or error.`;

  const user =
    `Cell source:\n\`\`\`\n${req.cellSource}\n\`\`\`\n\n` +
    `Error:\n${errorText}` +
    execBlock;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Parse the model's reply into a structured CellFixResult. On a valid JSON
 * object with a non-empty proposedCode, extracts all three fields (proposedCode
 * fence-stripped for safety). On any parse failure or missing code, falls back
 * to treating the whole reply as the proposed code (fences stripped) and is
 * honest in `summary` about the parse failure — never fabricates a diagnosis.
 */
export function parseCellFixResponse(raw: string): CellFixResult {
  const text = String(raw ?? '').trim();

  // The model may still wrap JSON in a ```json fence despite instructions.
  const unfenced = stripCodeFences(text);

  try {
    const parsed = JSON.parse(unfenced);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const proposedCode = stripCodeFences(asString((parsed as Record<string, unknown>).proposedCode));
      if (proposedCode) {
        return {
          summary: asString((parsed as Record<string, unknown>).summary).trim(),
          rootCause: asString((parsed as Record<string, unknown>).rootCause).trim(),
          proposedCode,
        };
      }
    }
  } catch {
    /* fall through to the honest fallback below */
  }

  // Fallback: the reply was not the structured JSON we asked for. Treat it as
  // raw code so the user still gets a usable fix, and say so plainly.
  return {
    summary: 'AOAI response could not be parsed as structured JSON; showing the raw suggestion as the proposed fix.',
    rootCause: '',
    proposedCode: stripCodeFences(text),
  };
}
