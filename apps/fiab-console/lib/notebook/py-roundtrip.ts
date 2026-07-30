/**
 * N19a — percent-format `.py` round-trip for Loom notebooks.
 *
 * Exports a notebook's cells to the jupytext / VS Code "percent" script format
 * and back, so a Loom notebook is a plain reviewable, diffable, git-committable
 * Python file:
 *
 *     # %% [markdown]
 *     # # Title
 *     # explanatory prose
 *
 *     # %%
 *     df = spark.read.parquet(path)
 *
 *     # %% [sparksql]
 *     SELECT * FROM sales
 *
 * The import side is the EXISTING parser (`parseNotebookFile` in
 * ./import-parser) — this module only writes the text and reuses that parser
 * for the inverse, so there is exactly one `.py` reader in the product. The
 * `[<lang>]` tag is honored by that parser (extended for this item) so a
 * multi-language notebook survives the round trip; markdown bodies are
 * comment-prefixed exactly the way the parser strips them.
 *
 * Pure: no I/O, no React, no network.
 */

import type { NotebookCell, NotebookCellLang } from '@/lib/types/notebook-cell';
import { parseNotebookFile, type ParsedNotebook } from './import-parser';
import { trimEdges } from '@/lib/util/trim';

/** Percent-cell tag written for each Loom cell language (parser-symmetric). */
const LANG_TAG: Record<NotebookCellLang, string> = {
  pyspark: 'pyspark',
  python: 'python',
  spark: 'scala',
  sparksql: 'sql',
  sparkr: 'r',
  tsql: 'tsql',
  csharp: 'csharp',
};

/**
 * A line that would be misread as a cell separator if it appeared inside a
 * cell body (jupytext has the identical limitation). Surfaced honestly by
 * `percentPyConflicts` rather than silently corrupting the file.
 */
const PERCENT_SEP = /^#\s*%%/;

/** Cells whose source contains a line that collides with the `# %%` separator. */
export function percentPyConflicts(cells: NotebookCell[]): { cellId: string; line: string }[] {
  const out: { cellId: string; line: string }[] = [];
  for (const c of cells || []) {
    for (const ln of (c.source || '').split(/\r\n|\r|\n/)) {
      if (PERCENT_SEP.test(ln)) { out.push({ cellId: c.id, line: ln.trim() }); break; }
    }
  }
  return out;
}

function trimBlankEdges(text: string): string {
  return text.replace(/^\n+/, '').replace(/\n+$/, '');
}

/**
 * Serialize a notebook to percent-format `.py` text.
 *
 * @param cells       the notebook's cells, in document order
 * @param defaultLang the notebook default language (written into the header so
 *                    an untagged import lands on the same language)
 * @param title       optional notebook display name, written as a header comment
 */
export function cellsToPercentPy(
  cells: NotebookCell[],
  defaultLang: NotebookCellLang = 'pyspark',
  title?: string,
): string {
  const header = [
    '# ---',
    `# Loom notebook${title ? `: ${title}` : ''}`,
    '# format: percent (jupytext / VS Code interactive)',
    `# default_lang: ${LANG_TAG[defaultLang] || 'pyspark'}`,
    '# ---',
    '',
  ];
  const chunks: string[] = [];
  for (const c of cells || []) {
    if (c.type === 'markdown') {
      const body = trimBlankEdges(c.source || '')
        .split('\n')
        .map((ln) => (ln.length ? `# ${ln}` : '#'))
        .join('\n');
      chunks.push(`# %% [markdown]\n${body}`);
      continue;
    }
    const lang = (c.lang || defaultLang) as NotebookCellLang;
    const tag = LANG_TAG[lang] || LANG_TAG[defaultLang] || 'pyspark';
    // ALWAYS tag the language (even the notebook default) so the round trip is
    // lossless regardless of which default the reader infers from the filename.
    chunks.push(`# %% [${tag}]\n${trimBlankEdges(c.source || '')}`);
  }
  if (chunks.length === 0) chunks.push('# %%\n');
  return `${header.join('\n')}\n${chunks.join('\n\n')}\n`;
}

/**
 * Parse percent-format `.py` text back into cells — a thin, explicit alias over
 * the single shared file parser so the round trip has one reader and one
 * writer, never a forked second implementation.
 */
export function percentPyToCells(text: string, defaultLang: NotebookCellLang = 'pyspark'): ParsedNotebook {
  const parsed = parseNotebookFile(text, 'notebook.py');
  // The header comment declares the source notebook's default language; honor
  // it when the caller didn't pin one explicitly through the file name.
  const declared = /^#\s*default_lang:\s*(\S+)\s*$/m.exec(text)?.[1];
  if (declared) {
    const hit = (Object.keys(LANG_TAG) as NotebookCellLang[]).find((k) => LANG_TAG[k] === declared.toLowerCase());
    if (hit) return { ...parsed, defaultLang: hit };
  }
  return { ...parsed, defaultLang: parsed.defaultLang || defaultLang };
}

/** Safe `<name>.py` filename for the download. */
export function percentPyFilename(displayName: string | undefined): string {
  const base = trimEdges((displayName || 'notebook').replace(/[^A-Za-z0-9._-]+/g, '-'), '-') || 'notebook';
  return `${base}.py`;
}
