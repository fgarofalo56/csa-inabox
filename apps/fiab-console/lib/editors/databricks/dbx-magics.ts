/**
 * Databricks notebook magic resolution (R4-DBX-5).
 *
 * The interactive Databricks notebook runs each cell through the Command
 * Execution API (api/1.2), which executes a raw command against a single
 * language REPL — it does NOT interpret Databricks notebook magics (`%sql`,
 * `%sh`, `%fs`, `%pip`, `%run`, `%python`, …) the way the first-party notebook
 * UI does. This module translates a cell's leading magic into a concrete
 * (commandLanguage, command) pair with faithful Databricks semantics, so the
 * shared runner can send it verbatim to the real cluster REPL.
 *
 * Grounded in Microsoft Learn:
 *   - Develop code / language magics:
 *     https://learn.microsoft.com/azure/databricks/notebooks/notebooks-code
 *   - `%sql` result → `_sqldf`:
 *     https://learn.microsoft.com/azure/databricks/notebooks/notebook-outputs
 *   - Auxiliary magics (`%sh`, `%fs`, `%pip`, `%run`):
 *     https://learn.microsoft.com/azure/databricks/notebooks/notebooks-code
 *
 * Semantics preserved:
 *   %python|%py|%scala|%r|%sql  → switch the command REPL to that language
 *   %sql (in a non-SQL notebook) → run as Spark SQL in the PYTHON REPL and bind
 *                                  the result to `_sqldf` (real Databricks
 *                                  behaviour: the next Python cell can read it)
 *   %sh <cmd>                    → real driver shell via subprocess
 *   %fs <sub> <args…>            → dbutils.fs.<sub>(<args>)
 *   %pip <args>                  → real pip on the driver (subprocess)
 *   %run <path> [k=v …]          → dbutils.notebook.run(path, timeout, params)
 */

import { cellLangToCommandLanguage, type DbxBaseLanguage } from '../databricks-notebook-source';
import type { NotebookCell, NotebookCellLang } from '@/lib/types/notebook-cell';

/** The four REPL languages the Command Execution API (api/1.2) accepts. Kept
 *  local so this client-safe module never imports the server databricks client. */
export type CommandLanguage = 'python' | 'sql' | 'scala' | 'r';

/** The concrete command to send to the Command Execution API for one cell. */
export interface ResolvedCommand {
  commandLanguage: CommandLanguage;
  command: string;
  /** True when the cell was a `%sql` bound into the Python REPL as `_sqldf`. */
  boundSqldf?: boolean;
  /** Human note when the translation differs from the first-party magic. */
  note?: string;
}

const LANG_MAGICS: Record<string, CommandLanguage> = {
  python: 'python', py: 'python',
  sql: 'sql',
  scala: 'scala',
  r: 'r',
};

/** Split "%magic rest" from the first non-empty line. Returns null when the
 *  cell has no leading `%…` magic. */
export function parseLeadingMagic(source: string): { magic: string; rest: string; bodyAfter: string } | null {
  const lines = source.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  const first = lines[i] ?? '';
  const m = /^\s*%(\w+)\b(.*)$/.exec(first);
  if (!m) return null;
  const magic = m[1].toLowerCase();
  const rest = (m[2] || '').trim();
  const bodyAfter = lines.slice(i + 1).join('\n');
  return { magic, rest, bodyAfter };
}

/** Python triple-quoted raw literal that is safe for arbitrary text (escapes an
 *  embedded triple-double-quote run). */
function pyTripleQuoted(text: string): string {
  // Break any embedded `"""` so the literal can't be terminated early.
  const safe = text.replace(/"""/g, '""\\"');
  return `r"""${safe}"""`;
}

/** Parse `k=v k2="v 2"` style args into an ordered list of pairs. */
export function parseKeyVals(rest: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = /(\w+)\s*=\s*("([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest))) {
    out.push([m[1], m[3] ?? m[4] ?? m[5] ?? '']);
  }
  return out;
}

/**
 * Resolve a code cell to a concrete Command Execution API call.
 *
 * `baseLanguage` is the notebook's default language (drives whether a `%sql`
 * cell binds `_sqldf` in Python — matching Databricks, which only exposes
 * `_sqldf` when the notebook's default language is Python).
 */
export function resolveDbxCommand(
  cell: Pick<NotebookCell, 'source' | 'lang'>,
  baseLanguage: DbxBaseLanguage,
): ResolvedCommand {
  const src = cell.source ?? '';
  const magic = parseLeadingMagic(src);

  // No magic → run in the cell's own language.
  if (!magic) {
    return { commandLanguage: cellLangToCommandLanguage(cell.lang as NotebookCellLang), command: src };
  }

  const { magic: name, rest, bodyAfter } = magic;

  // --- Language magics ---------------------------------------------------
  if (name in LANG_MAGICS) {
    const lang = LANG_MAGICS[name];
    // Body is everything after the magic line (Databricks ignores trailing text
    // on the `%lang` line itself).
    const body = bodyAfter;
    if (lang === 'sql' && baseLanguage !== 'SQL') {
      // Bind the query result to `_sqldf` in the Python REPL, then display it —
      // exactly the first-party behaviour that lets the next Python cell read
      // `_sqldf`.
      return {
        commandLanguage: 'python',
        command: `_sqldf = spark.sql(${pyTripleQuoted(body.trim())})\ndisplay(_sqldf)`,
        boundSqldf: true,
      };
    }
    return { commandLanguage: lang, command: body };
  }

  // --- Auxiliary magics --------------------------------------------------
  const inline = rest || bodyAfter.trim();

  if (name === 'sh') {
    const cmd = (rest ? `${rest}\n${bodyAfter}` : bodyAfter).trim();
    return {
      commandLanguage: 'python',
      command:
        `import subprocess as _sh\n` +
        `_o = _sh.run(${pyTripleQuoted(cmd)}, shell=True, capture_output=True, text=True)\n` +
        `print(_o.stdout, end="")\n` +
        `print(_o.stderr, end="")`,
      note: 'Runs on the driver node via subprocess.',
    };
  }

  if (name === 'fs') {
    // `%fs ls /path` → dbutils.fs.ls("/path"); pass remaining tokens as string
    // args (dbutils.fs takes string paths). display() ls output for a grid.
    const tokens = inline.split(/\s+/).filter(Boolean);
    const sub = tokens.shift() || 'ls';
    const args = tokens.map((t) => JSON.stringify(t)).join(', ');
    const call = `dbutils.fs.${sub}(${args})`;
    const command = sub === 'ls' ? `display(${call})` : call;
    return { commandLanguage: 'python', command };
  }

  if (name === 'pip') {
    return {
      commandLanguage: 'python',
      command:
        `import subprocess as _pip, sys as _sys\n` +
        `_o = _pip.run([_sys.executable, "-m", "pip", ${inline.split(/\s+/).filter(Boolean).map((t) => JSON.stringify(t)).join(', ')}], capture_output=True, text=True)\n` +
        `print(_o.stdout, end="")\n` +
        `print(_o.stderr, end="")`,
      note: 'Installs on the driver interpreter; restart the cluster REPL for a workspace-wide install.',
    };
  }

  if (name === 'run') {
    const tokens = inline.split(/\s+/).filter(Boolean);
    const path = tokens[0] || '';
    const params = parseKeyVals(inline.slice(path.length));
    const paramObj = params.length
      ? `, arguments={${params.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')}}`
      : '';
    return {
      commandLanguage: 'python',
      command: `dbutils.notebook.run(${JSON.stringify(path)}, 3600${paramObj})`,
      note: 'Executed via dbutils.notebook.run (a separate execution); first-party %run inlines definitions into the current scope.',
    };
  }

  // Unknown magic → run the whole cell in its own language and let the REPL
  // surface a precise error (never silently drop it).
  return { commandLanguage: cellLangToCommandLanguage(cell.lang as NotebookCellLang), command: src };
}
