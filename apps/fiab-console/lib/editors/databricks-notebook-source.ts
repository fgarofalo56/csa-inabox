/**
 * Databricks notebook SOURCE-format <-> cell codec.
 *
 * Databricks exports/imports notebooks (api/2.0/workspace/export|import,
 * format=SOURCE) as a single text file whose cells are delimited by a
 * "COMMAND" separator comment, with the comment prefix matching the
 * notebook's base language:
 *
 *   Python:  # COMMAND ----------
 *   SQL:     -- COMMAND ----------
 *   Scala:   // COMMAND ----------
 *   R:       # COMMAND ----------
 *
 * The first line of the file is a header marker, e.g.
 *   # Databricks notebook source
 *
 * Cells in a language other than the notebook default carry MAGIC lines:
 *   # MAGIC %sql
 *   # MAGIC SELECT 1
 * (each content line prefixed with the comment marker + " MAGIC ").
 * Markdown cells use the %md magic the same way.
 *
 * This module parses that wire format into editable cells and serialises
 * cells back to it so import/export round-trip against the real Databricks
 * workspace REST API. It is deliberately tolerant: a plain file with no
 * separators becomes a single cell.
 */

import type { NotebookCell, NotebookCellLang } from '@/lib/types/notebook-cell';

export type DbxBaseLanguage = 'PYTHON' | 'SQL' | 'SCALA' | 'R';

const HEADER = '# Databricks notebook source';

function commentPrefix(base: DbxBaseLanguage): string {
  switch (base) {
    case 'SQL': return '--';
    case 'SCALA': return '//';
    // Python and R both use '#'
    default: return '#';
  }
}

// Magic token -> our NotebookCellLang. Databricks magics: %python %sql %scala %r %md
function magicToCellLang(magic: string): { lang: NotebookCellLang; type: 'code' | 'markdown' } | null {
  switch (magic.toLowerCase()) {
    case 'python': return { lang: 'python', type: 'code' };
    case 'sql': return { lang: 'sparksql', type: 'code' };
    case 'scala': return { lang: 'spark', type: 'code' };
    case 'r': return { lang: 'sparkr', type: 'code' };
    case 'md':
    case 'md-sandbox': return { lang: 'python', type: 'markdown' };
    default: return null;
  }
}

function baseToCellLang(base: DbxBaseLanguage): NotebookCellLang {
  switch (base) {
    case 'SQL': return 'sparksql';
    case 'SCALA': return 'spark';
    case 'R': return 'sparkr';
    default: return 'python';
  }
}

export function cellLangToMagic(lang: NotebookCellLang | undefined, type: 'code' | 'markdown'): string {
  if (type === 'markdown') return 'md';
  switch (lang) {
    case 'sparksql':
    case 'tsql': return 'sql';
    case 'spark': return 'scala';
    case 'sparkr': return 'r';
    default: return 'python';
  }
}

/** Map a Databricks magic / cell lang to the api/1.2 Command Execution language. */
export function cellLangToCommandLanguage(lang: NotebookCellLang | undefined): 'python' | 'sql' | 'scala' | 'r' {
  switch (lang) {
    case 'sparksql':
    case 'tsql': return 'sql';
    case 'spark': return 'scala';
    case 'sparkr': return 'r';
    default: return 'python';
  }
}

function makeId(): string {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `cell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Parse a Databricks SOURCE file into editable cells.
 * @param source  raw exported source text
 * @param base    notebook default language (drives separator + bare-cell lang)
 */
export function parseSource(source: string, base: DbxBaseLanguage): NotebookCell[] {
  const prefix = commentPrefix(base);
  const sep = `${prefix} COMMAND ----------`;
  const magicLead = `${prefix} MAGIC `;

  // Drop the header line if present.
  let text = source.replace(/\r\n/g, '\n');
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (/Databricks notebook source/i.test(firstLine)) {
    text = firstNl === -1 ? '' : text.slice(firstNl + 1);
  }

  const blocks = text.split(new RegExp(`\\n?${escapeRe(sep)}\\n?`));
  const cells: NotebookCell[] = [];

  for (const rawBlock of blocks) {
    const block = rawBlock.replace(/^\n+/, '').replace(/\n+$/, '');
    if (!block && cells.length > 0) continue;

    const lines = block.split('\n');
    // A magic cell starts with `<prefix> MAGIC %<lang>`.
    const firstMagic = lines.find((l) => l.startsWith(magicLead));
    if (firstMagic) {
      // Strip the MAGIC prefix from every magic line, collect content.
      const magicLines = lines
        .filter((l) => l.startsWith(magicLead))
        .map((l) => l.slice(magicLead.length));
      let lang: NotebookCellLang = baseToCellLang(base);
      let type: 'code' | 'markdown' = 'code';
      const content: string[] = [];
      for (const ml of magicLines) {
        const m = ml.match(/^%(\S+)\s?(.*)$/);
        if (m && content.length === 0) {
          const mapped = magicToCellLang(m[1]);
          if (mapped) { lang = mapped.lang; type = mapped.type; }
          if (m[2]) content.push(m[2]);
        } else {
          content.push(ml);
        }
      }
      cells.push({
        id: makeId(),
        type,
        lang: type === 'code' ? lang : undefined,
        source: content.join('\n').replace(/\s+$/, ''),
      });
    } else {
      cells.push({
        id: makeId(),
        type: 'code',
        lang: baseToCellLang(base),
        source: block,
      });
    }
  }

  if (cells.length === 0) {
    cells.push({ id: makeId(), type: 'code', lang: baseToCellLang(base), source: '' });
  }
  return cells;
}

/**
 * Serialise editable cells back to a Databricks SOURCE file.
 * A cell whose language equals the notebook base is emitted bare; any other
 * language (or markdown) is emitted as MAGIC lines.
 */
export function serializeCells(cells: NotebookCell[], base: DbxBaseLanguage): string {
  const prefix = commentPrefix(base);
  const sep = `${prefix} COMMAND ----------`;
  const baseLang = baseToCellLang(base);

  const blocks = cells.map((cell) => {
    const isBase = cell.type === 'code' && (cell.lang ?? baseLang) === baseLang;
    if (isBase) {
      return cell.source;
    }
    const magic = cellLangToMagic(cell.lang, cell.type);
    const bodyLines = (cell.source || '').split('\n');
    const out = [`${prefix} MAGIC %${magic}`];
    for (const bl of bodyLines) {
      out.push(`${prefix} MAGIC ${bl}`);
    }
    return out.join('\n');
  });

  return `${HEADER}\n${blocks.join(`\n\n${sep}\n\n`)}\n`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
