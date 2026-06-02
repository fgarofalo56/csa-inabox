/**
 * Notebook file import parser — pure, dependency-free.
 *
 * Turns an uploaded notebook file (bytes/text + filename) into the
 * cell-based shape the Loom NotebookEditor reads: { cells, defaultLang }.
 *
 * Supported formats (detected by file extension):
 *
 *  - `.ipynb`  — Jupyter JSON. Each `cell` becomes a markdown or code
 *                cell; `source` string arrays are joined. Kernel /
 *                language metadata maps to a default Loom language
 *                (python → pyspark, sql → sparksql, scala → spark,
 *                r → sparkr).
 *
 *  - `.py`     — Databricks "source" notebooks AND jupytext / VS Code
 *                percent-format scripts:
 *                  • Databricks: cells are separated by
 *                    `# COMMAND ----------`. A cell whose lines are all
 *                    `# MAGIC …` is a magic cell — `# MAGIC %md` →
 *                    markdown, `# MAGIC %sql` → sparksql code,
 *                    `# MAGIC %scala`/`%r` → spark/sparkr, otherwise a
 *                    code cell. The `# MAGIC ` / `# MAGIC` prefixes are
 *                    stripped from the rendered source.
 *                  • Percent format: cells are separated by lines that
 *                    start with `# %%` or `#%%`. A `# %% [markdown]`
 *                    marker → markdown cell; the marker line itself is
 *                    stripped.
 *                If neither marker style is present the whole file is a
 *                single code cell.
 *
 *  - `.sql`    — single Spark SQL code cell.
 *  - `.scala`  — single Spark (Scala) code cell.
 *  - `.r`      — single SparkR (R) code cell.
 *
 * No network, no mocks. Real text parsing only.
 */

import type { NotebookCell, NotebookCellLang } from '@/lib/types/notebook-cell';

export interface ParsedNotebook {
  cells: NotebookCell[];
  defaultLang: NotebookCellLang;
}

let _seq = 0;
function newId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `cell-${Date.now()}-${(_seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function codeCell(source: string, lang: NotebookCellLang): NotebookCell {
  return { id: newId(), type: 'code', lang, source };
}
function markdownCell(source: string): NotebookCell {
  return { id: newId(), type: 'markdown', source };
}

/** Map a Jupyter kernel / language name to a Loom default cell language. */
export function langFromKernel(name: string | undefined | null): NotebookCellLang {
  const n = (name || '').toLowerCase();
  if (/scala/.test(n)) return 'spark';
  if (/sparkr|^r$|\br\b/.test(n)) return 'sparkr';
  if (/sql/.test(n)) return 'sparksql';
  if (/python|pyspark|ipython|py3?/.test(n)) return 'pyspark';
  return 'pyspark';
}

function extOf(filename: string): string {
  const m = /\.([A-Za-z0-9]+)\s*$/.exec(filename || '');
  return m ? m[1].toLowerCase() : '';
}

/** Decode raw bytes (Uint8Array | Buffer) or pass through a string as UTF-8 text. */
export function toText(input: string | Uint8Array | ArrayBuffer): string {
  if (typeof input === 'string') return input;
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
  // Node fallback.
  return Buffer.from(bytes).toString('utf-8');
}

/** Join a Jupyter `source` (string | string[]) into a single string. */
function joinSource(src: unknown): string {
  if (Array.isArray(src)) return src.map((s) => String(s)).join('');
  if (typeof src === 'string') return src;
  return '';
}

// --------------------------------------------------------------------------
// .ipynb (Jupyter JSON)
// --------------------------------------------------------------------------

function parseIpynb(text: string): ParsedNotebook {
  let nb: any;
  try {
    nb = JSON.parse(text);
  } catch (e: any) {
    throw new Error(`Invalid .ipynb JSON: ${e?.message || e}`);
  }
  const kernelName: string | undefined =
    nb?.metadata?.kernelspec?.language ||
    nb?.metadata?.language_info?.name ||
    nb?.metadata?.kernelspec?.name;
  const defaultLang = langFromKernel(kernelName);

  const rawCells: any[] = Array.isArray(nb?.cells) ? nb.cells : [];
  const cells: NotebookCell[] = [];
  for (const c of rawCells) {
    const source = joinSource(c?.source);
    const type = c?.cell_type;
    if (type === 'markdown' || type === 'raw') {
      cells.push(markdownCell(source));
    } else {
      // code (and anything unrecognized) → code cell in the notebook's lang.
      cells.push(codeCell(source, defaultLang));
    }
  }
  if (cells.length === 0) cells.push(codeCell('', defaultLang));
  return { cells, defaultLang };
}

// --------------------------------------------------------------------------
// .py — Databricks source + jupytext/VS Code percent format
// --------------------------------------------------------------------------

const DATABRICKS_SEP = /^#\s*COMMAND\s*-+\s*$/;
const MAGIC_LINE = /^#\s*MAGIC(?:\s?(.*))?$/;
const PERCENT_SEP = /^#\s*%%(.*)$/; // matches `# %% …` and `#%% …`

function magicLangToCell(directive: string, body: string): NotebookCell {
  // `directive` is the first token after the magic %, e.g. "md", "sql".
  const d = directive.toLowerCase();
  if (d === 'md' || d === 'markdown') return markdownCell(body);
  if (d === 'sql') return codeCell(body, 'sparksql');
  if (d === 'scala') return codeCell(body, 'spark');
  if (d === 'r') return codeCell(body, 'sparkr');
  if (d === 'python' || d === 'pyspark') return codeCell(body, 'pyspark');
  // %sh, %fs, %run, etc. — keep the whole magic body as a python code cell.
  return codeCell(body, 'pyspark');
}

/** Strip the `# MAGIC ` / `# MAGIC` prefix from each line of a magic block. */
function stripMagicPrefix(lines: string[]): string[] {
  return lines.map((ln) => {
    const m = MAGIC_LINE.exec(ln);
    return m ? (m[1] ?? '') : ln;
  });
}

function parseDatabricksBlock(blockLines: string[], defaultLang: NotebookCellLang): NotebookCell | null {
  // Drop a leading Databricks header line if present.
  const lines = blockLines.filter(
    (ln) => !/^#\s*Databricks notebook source\s*$/i.test(ln),
  );
  // Trim leading/trailing blank lines.
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length === 0) return null;

  const isMagicBlock = lines.every((ln) => MAGIC_LINE.test(ln) || ln.trim() === '');
  if (isMagicBlock) {
    const stripped = stripMagicPrefix(lines);
    // First non-empty stripped line may carry a `%md` / `%sql` directive.
    const firstIdx = stripped.findIndex((ln) => ln.trim() !== '');
    const first = firstIdx >= 0 ? stripped[firstIdx].trim() : '';
    const dm = /^%(\w+)\s*(.*)$/.exec(first);
    if (dm) {
      const rest = [...stripped];
      // Replace the directive line with any trailing text after the directive.
      rest[firstIdx] = dm[2] ?? '';
      const body = rest.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
      return magicLangToCell(dm[1], body);
    }
    // Magic block with no recognizable directive — treat as code.
    return codeCell(stripped.join('\n').trim(), defaultLang);
  }
  // Plain code cell.
  return codeCell(lines.join('\n'), defaultLang);
}

function parsePercentBlock(headerMarker: string, bodyLines: string[], defaultLang: NotebookCellLang): NotebookCell {
  const isMarkdown = /\[markdown\]/i.test(headerMarker) || /\[md\]/i.test(headerMarker);
  const body = bodyLines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
  if (isMarkdown) {
    // jupytext markdown bodies are commonly comment-prefixed (`# text`).
    const stripped = bodyLines
      .map((ln) => ln.replace(/^#\s?/, ''))
      .join('\n')
      .replace(/^\n+/, '')
      .replace(/\n+$/, '');
    return markdownCell(stripped || body);
  }
  return codeCell(body, defaultLang);
}

function parsePy(text: string, defaultLang: NotebookCellLang): ParsedNotebook {
  const allLines = text.split(/\r\n|\r|\n/);
  const hasDatabricks = allLines.some((ln) => DATABRICKS_SEP.test(ln));
  const hasPercent = allLines.some((ln) => PERCENT_SEP.test(ln) && !DATABRICKS_SEP.test(ln));

  const cells: NotebookCell[] = [];

  if (hasDatabricks) {
    let block: string[] = [];
    for (const ln of allLines) {
      if (DATABRICKS_SEP.test(ln)) {
        const cell = parseDatabricksBlock(block, defaultLang);
        if (cell) cells.push(cell);
        block = [];
      } else {
        block.push(ln);
      }
    }
    const last = parseDatabricksBlock(block, defaultLang);
    if (last) cells.push(last);
  } else if (hasPercent) {
    let marker: string | null = null;
    let body: string[] = [];
    const flush = () => {
      if (marker === null) {
        // Preamble before the first `# %%` marker — keep as a code cell.
        const pre = body.join('\n').trim();
        if (pre) cells.push(codeCell(pre, defaultLang));
      } else {
        cells.push(parsePercentBlock(marker, body, defaultLang));
      }
      body = [];
    };
    for (const ln of allLines) {
      const m = PERCENT_SEP.exec(ln);
      if (m) {
        flush();
        marker = m[1] || '';
      } else {
        body.push(ln);
      }
    }
    flush();
  } else {
    // No cell markers — whole file is one code cell.
    cells.push(codeCell(text.replace(/\r\n|\r/g, '\n').replace(/\n+$/, '\n').replace(/\n$/, ''), defaultLang));
  }

  if (cells.length === 0) cells.push(codeCell('', defaultLang));
  return { cells, defaultLang };
}

// --------------------------------------------------------------------------
// Public entry point
// --------------------------------------------------------------------------

/**
 * Parse a notebook file into Loom cells.
 *
 * @param input    file contents (text string, Uint8Array, or ArrayBuffer)
 * @param filename used only for extension-based format detection
 */
export function parseNotebookFile(
  input: string | Uint8Array | ArrayBuffer,
  filename: string,
): ParsedNotebook {
  const text = toText(input);
  const ext = extOf(filename);

  switch (ext) {
    case 'ipynb':
      return parseIpynb(text);
    case 'py':
      return parsePy(text, 'pyspark');
    case 'sql':
      return { cells: [codeCell(normalizeTrailing(text), 'sparksql')], defaultLang: 'sparksql' };
    case 'scala':
      return { cells: [codeCell(normalizeTrailing(text), 'spark')], defaultLang: 'spark' };
    case 'r':
      return { cells: [codeCell(normalizeTrailing(text), 'sparkr')], defaultLang: 'sparkr' };
    default:
      // Unknown extension — best-effort: try JSON (ipynb-without-ext) else
      // treat as a single pyspark code cell rather than failing the import.
      if (/^\s*\{/.test(text)) {
        try {
          return parseIpynb(text);
        } catch { /* fall through */ }
      }
      return { cells: [codeCell(normalizeTrailing(text), 'pyspark')], defaultLang: 'pyspark' };
  }
}

function normalizeTrailing(text: string): string {
  return text.replace(/\r\n|\r/g, '\n').replace(/\n+$/, '');
}
