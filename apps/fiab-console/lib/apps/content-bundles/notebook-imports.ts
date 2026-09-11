/**
 * #3530 (systemic arm) — derive, from a notebook's OWN cells, which PyPI
 * distributions it needs declared in `NotebookContent.requiredLibraries`.
 *
 * The original defect was fixed for one bundle: `app-rag-builder` declares
 * `azure-search-documents` + `openai`, the provisioner prepends a `%pip install`
 * bootstrap, and Run-all stops failing with `ModuleNotFoundError`. The issue's
 * acceptance criteria also required auditing the OTHER bundles for the same
 * pattern, because the gap is systemic: any bundle whose notebook imports a
 * package outside the Spark image hits the identical wall.
 *
 * That audit cannot be a one-time sweep. A hand-checked list is exactly the
 * shape that goes stale the moment someone adds a bundle — the same failure
 * `#3920` records at another layer (a rule implemented twice with nothing
 * asserting the copies agree). So the audit is expressed as a DERIVATION over
 * the live bundle registry: this module reads the cells, and the guard test
 * enumerates every bundle from `listBundleIds()` rather than a literal list.
 *
 * It FAILS CLOSED over the import forms it parses: `import a`, `import a.b`,
 * `import a as b`, `import a, b as c, d` and `from a.b import …`, in Python code
 * cells, at line start. An import whose module is in neither the stdlib set nor
 * the reviewed runtime set must be declared; a module nobody has classified is
 * reported as undeclared rather than silently assumed present. A new import in
 * a new bundle therefore surfaces as a red test, not as a customer's stack
 * trace on the golden path.
 *
 * What it does NOT see, stated rather than implied. Fail-OPEN holes (a real
 * import the sweep misses): a dynamic `importlib.import_module(...)`, an import
 * nested under an `if`/`try` at an indent it still matches but whose module name
 * is computed, a `;`-chained or backslash-continued second statement, and a
 * `%pip install` the cell performs itself. Those are un-analysable from the cell
 * text, not oversights — but they are holes, and this list is the honest
 * boundary of the claim above. The comma form was in this list until it was
 * measured to be hiding a real shipped defect (`app-supercharge-guide`'s
 * `import struct, pyodbc`); it is now parsed.
 *
 * And one fail-CLOSED hole, which belongs in the same list because a spurious
 * red costs the next author just as much time: `IMPORT_RE` is line-anchored and
 * STRING-UNAWARE, so an `import x` line inside a triple-quoted block — a
 * docstring, a `spark.sql("""…""")` heredoc, a generated-code template — is read
 * as a real import and manufactures a finding. No shipped bundle currently
 * trips it (measured: the sweep's findings are all genuine import lines), and
 * the remedy when one does is to declare the package or classify the module,
 * both of which are harmless. A full Python tokenizer is the only real fix and
 * is not worth it here.
 */

/**
 * Python standard-library roots imported by the shipped bundle notebooks, plus
 * the common neighbours a new cell is likely to reach for. Never pip-installed.
 */
const STDLIB_ROOTS = new Set([
  '__future__', 'abc', 'argparse', 'ast', 'asyncio', 'base64', 'binascii',
  'calendar', 'codecs', 'collections', 'concurrent', 'contextlib', 'copy',
  'csv', 'dataclasses', 'datetime', 'decimal', 'enum', 'functools', 'glob',
  'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http', 'importlib', 'inspect',
  'io', 'ipaddress', 'itertools', 'json', 'logging', 'math', 'operator', 'os',
  'pathlib', 'pickle', 'platform', 'pprint', 'queue', 'random', 're',
  'secrets', 'shutil', 'socket', 'sqlite3', 'ssl', 'statistics', 'string',
  'struct', 'subprocess', 'sys', 'tempfile', 'textwrap', 'threading', 'time',
  'traceback', 'types', 'typing', 'unittest', 'urllib', 'uuid', 'warnings',
  'xml', 'zipfile', 'zoneinfo',
]);

/**
 * Modules the Spark runtime already provides, so declaring them would cost a
 * pip round-trip on every Run-all for no gain — the reason `app-rag-builder`
 * deliberately omits `azure-identity` from its declaration.
 *
 * This is a REVIEWED list, not a machine-read manifest: the console cannot
 * introspect the pool image from here. Entries are matched as dotted-path
 * prefixes (`azure.identity` covers `azure.identity.aio`).
 *
 * THE ASYMMETRY THAT MATTERS, STATED RATHER THAN IMPLIED. An `UNVERIFIED_AT_HEAD`
 * baseline entry in the guard suite is LOUD: it is enumerated, it must still be
 * a real finding or the suite reds, and it can only shrink. A wrong entry HERE
 * is SILENT — no finding, no baseline line, no red test, just a
 * `ModuleNotFoundError` on the customer's Run-all, which is exactly the #3530
 * defect. So this list is split by what backs each entry, and the asserted half
 * is tracked on #3530 alongside the baseline rather than treated as settled.
 *
 * Measured against this repo, not assumed: `platform/fiab/bicep/modules/
 * landing-zone/synapse-spark-pools.bicep` sets `sparkVersion: '3.4'` and
 * declares NO `libraryRequirements`, so the pools run the STOCK Synapse Spark
 * 3.4 image. Every claim below is therefore a claim about that stock image (and
 * about the Databricks runtime, for the bundles that target it).
 */

/**
 * Backed by something other than belief: the module is the runtime itself, is
 * injected by the notebook host, or has in-repo evidence.
 *
 *   pyspark / py4j / delta   a Spark pool that lacks these is not a Spark pool;
 *                            `delta` is the Delta Lake Python API the pools are
 *                            built on and every shipped bundle already uses.
 *   notebookutils /          host-injected helper namespaces — Synapse
 *   mssparkutils / dbutils   (`notebookutils`, `mssparkutils`) and Databricks
 *                            (`dbutils`). They exist only INSIDE a notebook
 *                            session and are not pip-installable at all, so
 *                            "declare it" is not even an available answer.
 *   azure.identity           documented in-repo: `app-rag-builder.ts`
 *                            deliberately omits it from `requiredLibraries`
 *                            while importing it.
 *   azure.core               a hard install-requires of `azure-identity`, so it
 *                            is present wherever the line above is.
 */
const RUNTIME_PROVIDED_EVIDENCED = [
  'pyspark', 'py4j', 'delta',
  'notebookutils', 'mssparkutils', 'dbutils',
  'azure.identity', 'azure.core',
];

/**
 * ASSERTED — the data-science baseline these images are commonly built with,
 * believed present but NOT established from this repo or from a running pool.
 * Same class of unverifiable fact as `UNVERIFIED_AT_HEAD` in the guard suite,
 * and tracked on #3530 with it: each one needs a `pip list` on a live Synapse
 * 3.4 pool and a live Databricks runtime before it can move to the list above.
 *
 * The failure mode if one is wrong: a bundle importing it sweeps GREEN and dies
 * on Run-all with `ModuleNotFoundError`. Removing an entry is the safe
 * direction (it costs a pip round-trip); adding one is the dangerous direction.
 *
 * `pyarrow` sits here rather than above deliberately — pyspark declares it as
 * an EXTRA (`pyspark[sql]`), not an install-requires, so "Spark is present"
 * does not imply it.
 */
const RUNTIME_PROVIDED_ASSERTED = [
  'pyarrow',
  'numpy', 'pandas', 'scipy', 'sklearn', 'matplotlib', 'seaborn', 'mlflow',
  'requests',
];

/**
 * The matched set. Split above only so the evidence behind each half is
 * inspectable; `isProvidedByRuntime` treats them identically.
 *
 * Adding an entry is a claim that the package ships in the Synapse Spark /
 * Databricks stock image — make it deliberately, and put it in the half whose
 * evidence you actually have, because a wrong entry re-opens #3530 for that
 * bundle and does so SILENTLY.
 */
export const RUNTIME_PROVIDED_PREFIXES = [
  ...RUNTIME_PROVIDED_EVIDENCED,
  ...RUNTIME_PROVIDED_ASSERTED,
];

/** The unverifiable half, exported so the guard suite can enumerate it. */
export const RUNTIME_PROVIDED_ASSERTED_PREFIXES: readonly string[] = RUNTIME_PROVIDED_ASSERTED;
/** The half with evidence behind it, exported for the same reason. */
export const RUNTIME_PROVIDED_EVIDENCED_PREFIXES: readonly string[] = RUNTIME_PROVIDED_EVIDENCED;

/** Cell languages whose source is Python (and therefore has Python imports). */
const PYTHON_LANGS = new Set(['pyspark', 'python']);

/**
 * `^import <clause>` / `^from a.b import c`, anchored at line start so a
 * commented or prose mention (`# import delta_sharing`) is not read as a real
 * import.
 *
 * For the `from` form the module is the single dotted path before `import`, so
 * group 1 is the answer outright — `from X import a, b` names one module, X.
 *
 * For the plain form the whole clause is captured (group 2) and split by
 * `importClauseModules`, because `import a, b, c` names THREE modules on one
 * line. Capturing only the first dotted path there made the sweep fail OPEN:
 * `import struct, pyodbc` read as `["struct"]` and reported clean, which is
 * precisely the undeclared-package defect #3530 is about.
 */
const IMPORT_RE = /^[ \t]*(?:from[ \t]+([A-Za-z_][\w.]*)[ \t]+import[ \t]|import[ \t]+([A-Za-z_].*))/gm;

/**
 * The modules named by a plain `import` clause — `a, b.c, d as e` -> `[a, b.c, d]`.
 *
 * A trailing comment is dropped first so `import os  # see also, sys` does not
 * manufacture a `sys` finding, then each comma-separated item contributes its
 * LEADING dotted path, which discards an `as <alias>` tail without needing to
 * match the alias grammar. An item that does not start with a dotted name (a
 * `;`-chained statement, a line continuation) contributes nothing rather than
 * a guess.
 */
function importClauseModules(clause: string): string[] {
  const mods: string[] = [];
  for (const part of clause.split('#')[0].split(',')) {
    const m = /^[ \t]*([A-Za-z_][\w.]*)/.exec(part);
    if (m) mods.push(m[1]);
  }
  return mods;
}

/**
 * PEP 503 name normalisation: lowercase, and any run of `-`, `_` or `.`
 * collapses to a single `-`. Applied to BOTH sides of the coverage test so
 * `delta_sharing` (module) and `delta-sharing` (distribution) compare equal.
 */
export function normalizeDistName(name: string): string {
  return String(name).trim().toLowerCase().replace(/[-_.]+/g, '-');
}

/** Strip a pin/extra so `openai==1.2.3` and `pkg[all]` compare as `openai` / `pkg`. */
function declaredBaseName(declared: string): string {
  return normalizeDistName(String(declared).split(/[[<>=!~,;\s]/)[0] || '');
}

function cellSource(cell: unknown): string {
  const s = (cell as any)?.source;
  if (typeof s === 'string') return s;
  if (Array.isArray(s)) return s.join('');
  return '';
}

/**
 * Every dotted module path imported by the notebook's PYTHON code cells.
 * Markdown cells are skipped (their fenced samples are documentation, not the
 * code that runs), as are non-Python languages.
 */
export function extractPythonImports(content: unknown): string[] {
  const c = content as any;
  const cells: any[] = Array.isArray(c?.cells) ? c.cells : [];
  const defaultLang = String(c?.defaultLang || 'pyspark');
  const found = new Set<string>();
  for (const cell of cells) {
    if (cell?.type !== 'code') continue;
    const lang = String(cell?.lang || defaultLang);
    if (!PYTHON_LANGS.has(lang)) continue;
    const src = cellSource(cell);
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(src)) !== null) {
      if (m[1]) {
        // `from X import …` — one module, X, however many names follow.
        found.add(m[1]);
      } else if (m[2]) {
        for (const mod of importClauseModules(m[2])) found.add(mod);
      }
    }
  }
  return [...found].sort();
}

/** True when the dotted module is stdlib or is provided by the Spark image. */
export function isProvidedByRuntime(dottedModule: string): boolean {
  const root = dottedModule.split('.')[0];
  if (STDLIB_ROOTS.has(root)) return true;
  // Matched on the DOTTED path, never on the normalised name: `delta` must
  // cover the submodule `delta.tables` WITHOUT swallowing the unrelated
  // distribution `delta_sharing` (which normalises to `delta-sharing` and
  // would pass a hyphen-prefix test).
  return RUNTIME_PROVIDED_PREFIXES.some(
    (p) => dottedModule === p || dottedModule.startsWith(`${p}.`),
  );
}

/**
 * True when `declared` (a PyPI distribution name) supplies `dottedModule`.
 *
 * The test is a normalised PREFIX match rather than a module→distribution
 * lookup table, because that table would be a third hand-maintained list to
 * drift. It is exact for the shapes the bundles use:
 *   `azure.search.documents.indexes.models` ⊂ `azure-search-documents`
 *   `azure.ai.agents.models`                ⊂ `azure-ai-agents`
 *   `delta_sharing`                         = `delta-sharing`
 */
export function distributionCovers(declared: string, dottedModule: string): boolean {
  const d = declaredBaseName(declared);
  if (!d) return false;
  const m = normalizeDistName(dottedModule);
  return m === d || m.startsWith(`${d}-`);
}

/**
 * The imports this notebook needs declared but does not declare — empty for a
 * compliant bundle. Returns the dotted module together with the distribution
 * name to add, so the guard's failure message tells the author what to write.
 */
export function undeclaredImports(
  content: unknown,
): { module: string; suggestedDistribution: string }[] {
  const declared: string[] = Array.isArray((content as any)?.requiredLibraries)
    ? (content as any).requiredLibraries
    : [];
  return extractPythonImports(content)
    .filter((mod) => !isProvidedByRuntime(mod))
    .filter((mod) => !declared.some((d) => distributionCovers(d, mod)))
    .map((mod) => ({ module: mod, suggestedDistribution: normalizeDistName(mod) }));
}
