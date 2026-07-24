/**
 * parse.ts — the pure parser for the N16 `code-report` item type ("Code report").
 *
 * BI-as-code: a report is authored as ONE versionable text document — Markdown
 * prose interleaved with fenced query blocks and inline `{visual}` directives,
 * exactly the Evidence.dev / Rill / Observable model. This module folds that
 * source text into a typed {@link CodeReportAst} that the server renderer
 * (lib/code-report/render.ts) executes and the editor preview renders.
 *
 * PURE + ISOMORPHIC — no Azure, no Cosmos, no React, no `window`: it is a total
 * function `string → CodeReportAst` (or a thrown {@link CodeReportParseError}),
 * so the SAME parser runs in three places with ZERO drift:
 *   • the client editor (live client-side pre-validation),
 *   • the server renderer + the `POST …/validate` route (real dry-compile),
 *   • unit tests (golden fixtures).
 *
 * MALFORMED IS AN ERROR, NEVER A SILENT PASS (die-hard): a duplicate query name,
 * a `{visual}` that references an undefined query, an unnamed `sql` block, a
 * `sql loom` block with no `metric:`, an unknown metric-block key, an unclosed
 * fence, or a visual missing its required axis all throw — the CI validate hook
 * (`loom report validate`) exits non-zero on any of them.
 *
 * Two fenced query-block flavors (the info string after the ``` opener):
 *   ```sql <name>             a RAW query — runs on the report's bound engine.
 *   ```sql loom <name>        a GOVERNED-METRIC query — resolves through N15's
 *                             compileMetricQuery (`one metric ⇒ one number`).
 * A fence whose language is not `sql` (```mermaid, ```python, plain ```) is kept
 * verbatim inside the surrounding Markdown so the preview renders it normally.
 *
 * Grounded in the Evidence.dev component model:
 *   https://docs.evidence.dev/core-concepts/queries/
 *   https://docs.evidence.dev/components/all-components/
 */

// ── Filters (structurally identical to N15's MetricFilter) ───────────────────

/** The comparison operators a metric-block `filter:` line may use. */
export const CODE_REPORT_FILTER_OPS = ['=', '!=', '>', '>=', '<', '<=', 'in'] as const;
export type CodeReportFilterOp = (typeof CODE_REPORT_FILTER_OPS)[number];

/** A structured filter predicate on a governed dimension (bound/escaped downstream). */
export interface CodeReportFilter {
  dimension: string;
  op: CodeReportFilterOp;
  /** Scalar (or array for `in`) — NEVER spliced; N15 binds/escapes it. */
  value: string | number | Array<string | number>;
}

// ── Query definitions ────────────────────────────────────────────────────────

/** The execution engines a query may target (mirrors N15's MetricEngine). */
export const CODE_REPORT_ENGINES = ['synapse', 'lakehouse', 'adx'] as const;
export type CodeReportEngine = (typeof CODE_REPORT_ENGINES)[number];

/** A raw `sql <name>` block — arbitrary read-only SQL/KQL on the bound engine. */
export interface RawQueryDef {
  kind: 'raw';
  name: string;
  /** The block body verbatim (executed on the item's bound engine, read-only). */
  sql: string;
}

/** A governed `sql loom <name>` block — a metric reference resolved through N15. */
export interface MetricQueryDef {
  kind: 'metric';
  name: string;
  /** The governed metric name/id (from the imported MetricFlow spec). */
  metric: string;
  /** Group-by dimensions (each whitelisted by the compiler against the model). */
  dimensions: string[];
  /** Structured filter predicates (each bound/escaped by the compiler). */
  filters: CodeReportFilter[];
  /** Time-grain override for the first time dimension. */
  grain?: string;
  /** Engine override (default = the report's bound engine at render time). */
  engine?: CodeReportEngine;
}

export type QueryDef = RawQueryDef | MetricQueryDef;

// ── Visual directives ────────────────────────────────────────────────────────

/** The visual kinds a `{visual}` directive may request. */
export const VISUAL_TYPES = ['table', 'bar', 'line', 'area', 'scatter', 'bignumber'] as const;
export type VisualType = (typeof VISUAL_TYPES)[number];

/** A parsed `{...}` visual directive that renders a named query's result. */
export interface VisualDirective {
  type: VisualType;
  /** The query name this visual renders (must be defined in the document). */
  query: string;
  /** Category / horizontal axis column (bar | line | area | scatter). */
  x?: string;
  /** Value / vertical axis column (bar | line | area | scatter). */
  y?: string;
  /** Optional series (pivot) column for a multi-series bar/line/area. */
  series?: string;
  /** The value column for a `bignumber` KPI. */
  value?: string;
  /** Optional caption under a `bignumber`. */
  label?: string;
  /** Optional visual title. */
  title?: string;
}

// ── AST ──────────────────────────────────────────────────────────────────────

export type CodeReportNode =
  | { kind: 'markdown'; text: string }
  | { kind: 'query'; query: QueryDef }
  | { kind: 'visual'; visual: VisualDirective };

export interface CodeReportAst {
  /** The document in order — prose, query blocks, and visuals interleaved. */
  nodes: CodeReportNode[];
  /** Every query definition, in document order (also unique by `name`). */
  queries: QueryDef[];
}

/** Upper bound on query blocks in one report (a report is a page, not an ETL). */
export const DEFAULT_QUERY_MAX = 100;

/** Thrown for any malformed report — the validate hook maps it to a non-zero exit. */
export class CodeReportParseError extends Error {
  constructor(
    message: string,
    /** 1-based source line the error anchors to (0 when whole-document). */
    public readonly line = 0,
  ) {
    super(line > 0 ? `line ${line}: ${message}` : message);
    this.name = 'CodeReportParseError';
  }
}

// ── Small scalar helpers ─────────────────────────────────────────────────────

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Coerce a bare token to a number when it is a clean numeric literal, else keep the string. */
function coerceScalar(raw: string): string | number {
  const s = raw.trim();
  if (s !== '' && /^-?\d+(\.\d+)?$/.test(s) && Number.isFinite(Number(s))) return Number(s);
  return s;
}

/** Strip a single layer of matching surrounding quotes. */
function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

// ── Metric-block body parsing ────────────────────────────────────────────────

const METRIC_BLOCK_KEYS = new Set(['metric', 'dimensions', 'grain', 'engine', 'filter']);

/** Parse a `filter:` value (`<dim> <op> <value>` / `<dim> in a,b,c`) into a predicate. */
function parseFilter(raw: string, lineNo: number): CodeReportFilter {
  const m = /^([A-Za-z0-9_]+)\s*(=|!=|<>|>=|<=|>|<|\bin\b)\s*(.+)$/i.exec(raw.trim());
  if (!m) {
    throw new CodeReportParseError(
      `filter "${raw}" is not a "<dimension> <op> <value>" predicate (op is one of ${CODE_REPORT_FILTER_OPS.join(', ')})`,
      lineNo,
    );
  }
  const dimension = m[1];
  const opRaw = m[2].toLowerCase();
  const op = (opRaw === '<>' ? '!=' : opRaw) as CodeReportFilterOp;
  const rest = m[3].trim();
  if (op === 'in') {
    const values = rest
      .split(',')
      .map((v) => coerceScalar(unquote(v)))
      .filter((v) => !(typeof v === 'string' && v === ''));
    if (values.length === 0) {
      throw new CodeReportParseError(`filter "${raw}" — an "in" predicate needs at least one value`, lineNo);
    }
    return { dimension, op, value: values };
  }
  return { dimension, op, value: coerceScalar(unquote(rest)) };
}

/** Fold a `sql loom <name>` block body (key: value lines) into a MetricQueryDef. */
function parseMetricBlock(name: string, bodyLines: string[], startLine: number): MetricQueryDef {
  const def: MetricQueryDef = { kind: 'metric', name, metric: '', dimensions: [], filters: [] };
  bodyLines.forEach((rawLine, i) => {
    const lineNo = startLine + i;
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) return; // blank / comment
    const kv = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      throw new CodeReportParseError(`metric block "${name}": expected "key: value", got "${rawLine}"`, lineNo);
    }
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    if (!METRIC_BLOCK_KEYS.has(key)) {
      throw new CodeReportParseError(
        `metric block "${name}": unknown key "${key}" (allowed: ${[...METRIC_BLOCK_KEYS].join(', ')})`,
        lineNo,
      );
    }
    switch (key) {
      case 'metric':
        def.metric = unquote(value);
        break;
      case 'dimensions':
        def.dimensions = value.split(',').map((d) => d.trim()).filter(Boolean);
        break;
      case 'grain':
        def.grain = unquote(value) || undefined;
        break;
      case 'engine': {
        const eng = unquote(value);
        if (!(CODE_REPORT_ENGINES as readonly string[]).includes(eng)) {
          throw new CodeReportParseError(
            `metric block "${name}": engine must be one of ${CODE_REPORT_ENGINES.join(', ')}`,
            lineNo,
          );
        }
        def.engine = eng as CodeReportEngine;
        break;
      }
      case 'filter':
        def.filters.push(parseFilter(value, lineNo));
        break;
    }
  });
  if (!def.metric) {
    throw new CodeReportParseError(`metric block "${name}" is missing a required "metric:" reference`, startLine);
  }
  return def;
}

// ── Visual-directive parsing ─────────────────────────────────────────────────

const VISUAL_KEYS = new Set(['type', 'query', 'x', 'y', 'series', 'value', 'label', 'title']);

/** Tokenise a directive's `key=value` attribute string, honouring quoted values. */
function splitAttrs(input: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  const re = /([A-Za-z_]+)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s}]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    out.push({ key: m[1].toLowerCase(), value: unquote(m[2]) });
  }
  return out;
}

/**
 * Parse a standalone `{...}` line into a VisualDirective, or return null when the
 * line is NOT a visual directive (its first token is not `visual` or a known
 * visual type) — such a line is left as ordinary Markdown, never an error.
 */
function parseVisual(line: string, lineNo: number): VisualDirective | null {
  const inner = line.trim().replace(/^\{/, '').replace(/\}$/, '').trim();
  const head = /^([A-Za-z_]+)\b/.exec(inner);
  if (!head) return null;
  const first = head[1].toLowerCase();
  const isTyped = first === 'visual';
  if (!isTyped && !(VISUAL_TYPES as readonly string[]).includes(first)) return null;

  const attrsStr = inner.slice(head[0].length);
  const attrs = splitAttrs(attrsStr);
  const bag: Record<string, string> = {};
  for (const { key, value } of attrs) {
    if (!VISUAL_KEYS.has(key)) {
      throw new CodeReportParseError(
        `visual "${first}": unknown attribute "${key}" (allowed: ${[...VISUAL_KEYS].join(', ')})`,
        lineNo,
      );
    }
    bag[key] = value;
  }

  const type = (isTyped ? bag.type : first) as VisualType | undefined;
  if (!type || !(VISUAL_TYPES as readonly string[]).includes(type)) {
    throw new CodeReportParseError(
      `visual directive needs a type from ${VISUAL_TYPES.join(', ')}${isTyped ? ' (set type=…)' : ''}`,
      lineNo,
    );
  }
  const query = bag.query;
  if (!query) throw new CodeReportParseError(`visual "${type}" is missing a query=<name>`, lineNo);

  // Per-type required axes/fields (Evidence-parity: a chart needs its wells).
  const need = (k: 'x' | 'y' | 'value', label: string) => {
    if (!bag[k]) throw new CodeReportParseError(`visual "${type}" requires ${label} (${k}=<column>)`, lineNo);
  };
  if (type === 'bar' || type === 'line' || type === 'area' || type === 'scatter') {
    need('x', 'an x column');
    need('y', 'a y column');
  } else if (type === 'bignumber') {
    need('value', 'a value column');
  }

  return {
    type,
    query,
    ...(bag.x ? { x: bag.x } : {}),
    ...(bag.y ? { y: bag.y } : {}),
    ...(bag.series ? { series: bag.series } : {}),
    ...(bag.value ? { value: bag.value } : {}),
    ...(bag.label ? { label: bag.label } : {}),
    ...(bag.title ? { title: bag.title } : {}),
  };
}

// ── The parser ───────────────────────────────────────────────────────────────

const FENCE_RE = /^```(.*)$/;

/**
 * Parse a code-report source document into a typed {@link CodeReportAst}. Total:
 * returns an AST or throws {@link CodeReportParseError} — never a silent pass.
 */
export function parseCodeReport(source: string): CodeReportAst {
  const lines = String(source ?? '').split(/\r?\n/);
  const nodes: CodeReportNode[] = [];
  const queries: QueryDef[] = [];
  const seen = new Set<string>();

  let mdBuf: string[] = [];
  const flushMd = () => {
    if (mdBuf.length === 0) return;
    // Drop a trailing run of blank lines but keep internal spacing.
    while (mdBuf.length && mdBuf[mdBuf.length - 1].trim() === '') mdBuf.pop();
    const text = mdBuf.join('\n');
    if (text.trim() !== '') nodes.push({ kind: 'markdown', text });
    mdBuf = [];
  };
  const registerName = (name: string, lineNo: number) => {
    if (!NAME_RE.test(name)) {
      throw new CodeReportParseError(`query name "${name}" must match [A-Za-z_][A-Za-z0-9_]*`, lineNo);
    }
    if (seen.has(name)) throw new CodeReportParseError(`duplicate query name "${name}"`, lineNo);
    seen.add(name);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE_RE.exec(line);

    if (fence) {
      const info = fence[1].trim();
      const tokens = info === '' ? [] : info.split(/\s+/);
      const isSql = tokens[0] === 'sql';

      // Find the closing fence.
      let close = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^```\s*$/.test(lines[j])) {
          close = j;
          break;
        }
      }
      if (close === -1) {
        throw new CodeReportParseError('unclosed ``` fence', i + 1);
      }
      const body = lines.slice(i + 1, close);

      if (!isSql) {
        // Non-sql fence (mermaid / python / plain): keep verbatim in Markdown.
        mdBuf.push(line, ...body, lines[close]);
        i = close;
        continue;
      }

      // A `sql …` query block.
      const isMetric = tokens[1] === 'loom';
      const name = isMetric ? tokens[2] : tokens[1];
      if (!name) {
        throw new CodeReportParseError(
          isMetric ? '`sql loom` block requires a name (```sql loom <name>)' : '`sql` block requires a name (```sql <name>)',
          i + 1,
        );
      }
      registerName(name, i + 1);

      let query: QueryDef;
      if (isMetric) {
        query = parseMetricBlock(name, body, i + 2);
      } else {
        const sql = body.join('\n').trim();
        if (sql === '') throw new CodeReportParseError(`sql block "${name}" is empty`, i + 1);
        query = { kind: 'raw', name, sql };
      }
      flushMd();
      nodes.push({ kind: 'query', query });
      queries.push(query);
      i = close;
      continue;
    }

    // A standalone `{...}` visual directive?
    const trimmed = line.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}') && trimmed.length > 2) {
      const visual = parseVisual(trimmed, i + 1);
      if (visual) {
        flushMd();
        nodes.push({ kind: 'visual', visual });
        continue;
      }
      // Not a recognised directive — fall through to Markdown.
    }

    mdBuf.push(line);
  }
  flushMd();

  if (queries.length > DEFAULT_QUERY_MAX) {
    throw new CodeReportParseError(`too many query blocks (${queries.length} > ${DEFAULT_QUERY_MAX})`);
  }

  // Cross-reference validation: every visual must point at a defined query.
  const names = new Set(queries.map((q) => q.name));
  for (const node of nodes) {
    if (node.kind === 'visual' && !names.has(node.visual.query)) {
      throw new CodeReportParseError(
        `visual "${node.visual.type}" references undefined query "${node.visual.query}"`,
      );
    }
  }

  return { nodes, queries };
}

/** Look up a query definition by name (undefined when absent). */
export function queryByName(ast: CodeReportAst, name: string): QueryDef | undefined {
  return ast.queries.find((q) => q.name === name);
}

// ── Read-only guard for RAW blocks (pure — shared by render + validate) ───────

/** Thrown for a mutating / multi-statement raw block. */
export class RawQueryUnsafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RawQueryUnsafeError';
  }
}

// Statement-leading keywords that MUTATE or execute — forbidden in a raw block.
const TSQL_FORBIDDEN =
  /\b(insert|update|delete|merge|drop|alter|create|truncate|exec|execute|grant|revoke|deny|sp_\w+|xp_\w+|backup|restore|shutdown|reconfigure|bulk|openrowset|openquery)\b/i;

/** Strip `--` line comments, block comments, and single-quoted string bodies. */
function stripSqlNoise(sql: string): string {
  let s = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  s = s.replace(/'(?:[^']|'')*'/g, "''");
  return s;
}

/**
 * Assert a raw `sql` block is a SINGLE read-only statement for the dialect the
 * bound engine speaks (`synapse` → T-SQL, `adx` → KQL). Throws
 * {@link RawQueryUnsafeError} for a mutating / multi-statement / control body.
 *
 * Pure (regex only) so it runs in the client editor's pre-check, the server
 * renderer, AND the `validate` route with no drift. A raw block is
 * author-controlled SQL executed in the AUTHOR's own boundary (the Evidence.dev
 * model) — this guard stops it from mutating data or stacking a 2nd statement.
 */
export function assertReadOnlyQuery(sql: string, dialect: 'synapse' | 'kql'): void {
  const raw = String(sql ?? '').trim();
  if (!raw) throw new RawQueryUnsafeError('empty query');

  if (dialect === 'kql') {
    // A leading `.` is an ADX CONTROL/management command (`.drop`, `.set`, …);
    // a query pipeline (`Table | where … | summarize …`) is read-only.
    if (raw.startsWith('.')) {
      throw new RawQueryUnsafeError('KQL control commands (leading ".") are not allowed in a code report');
    }
    return;
  }

  const cleaned = stripSqlNoise(raw);
  const withoutTrailing = cleaned.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) {
    throw new RawQueryUnsafeError('a raw sql block must be a single statement (no ";" separators)');
  }
  const firstWord = (withoutTrailing.trim().match(/^([A-Za-z_]+)/)?.[1] || '').toLowerCase();
  if (firstWord !== 'select' && firstWord !== 'with') {
    throw new RawQueryUnsafeError('a raw sql block must be a read-only query (start with SELECT or WITH)');
  }
  if (TSQL_FORBIDDEN.test(withoutTrailing)) {
    throw new RawQueryUnsafeError('a raw sql block may not contain data-modifying or EXEC statements');
  }
}

/** The dialect a bound engine speaks. */
export function engineDialect(engine: CodeReportEngine): 'synapse' | 'kql' {
  return engine === 'adx' ? 'kql' : 'synapse';
}
