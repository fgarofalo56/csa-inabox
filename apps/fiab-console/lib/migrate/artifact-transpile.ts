/**
 * M3 — DAX / PBIX artifact transpile (→ semantic-contract measure + code-report),
 * HONEST + best-effort. REUSES the on-main parsers, never re-implements them:
 *   • DAX measures  → validated with the A1 Pratt parser (parseDaxExpression) and
 *     probed for a loom-native SQL fold with the A2/A3 engine (foldDaxToSql). A
 *     measure that parses is carried over VERBATIM as an N9 semantic-contract
 *     `measure` metric (sourceRef = the original DAX) — never a rewritten guess.
 *   • PBIX / report → assembled into an N16 `code-report` source document and
 *     validated with the N16 parser (parseCodeReport + assertReadOnlyQuery). A
 *     malformed generated report is an ERROR surfaced as needs-review, never a
 *     silent pass.
 *
 * DIE-HARD HONESTY (mirrors A1's unsupportedDaxError): a measure that does not
 * parse, or is outside the loom-native SQL-fold surface, is FLAGGED needs-review
 * with the exact reason (the parser's message, or the fold-unsupported note); a
 * report that fails N16 validation carries the N16 error. Nothing is fabricated.
 *
 * PURE + isomorphic — parser/regex only, no Azure/Cosmos/React — so it runs in
 * the client review-diff AND the server route with zero drift.
 */
import { parseDaxExpression, DaxParseError } from '@/lib/azure/dax';
import { DaxLexError } from '@/lib/azure/dax/tokenizer';
import { foldDaxToSql, type FoldModel } from '@/lib/azure/dax/fold';
import {
  parseCodeReport,
  assertReadOnlyQuery,
  engineDialect,
  CodeReportParseError,
  RawQueryUnsafeError,
  type CodeReportEngine,
  type VisualType,
} from '@/lib/code-report/parse';

// ── DAX measure → N9 semantic-contract measure metric ─────────────────────────

/** A draft governed-metric registration for N9's store (shape mirrors N9's
 * MetricInput; kept as a plain object so this module imports no Cosmos code).
 * The route maps it to `registerMetric` when the reviewer accepts the draft. */
export interface SemanticContractMetricDraft {
  metricId: string;
  label: string;
  owner: string;
  description: string;
  grain: string;
  /** N9 sourceKind — a migrated DAX measure is a `measure`. */
  sourceKind: 'measure';
  /** The ORIGINAL DAX expression, carried over verbatim (never rewritten). */
  sourceRef: string;
  synonyms: string[];
}

export interface DaxMeasureTranslation {
  name: string;
  table: string;
  /** The source DAX expression, verbatim. */
  sourceDax: string;
  /** parse OK && folds to loom-native SQL. */
  supported: boolean;
  /** True when the DAX is syntactically valid (A1 parser accepted it). */
  parses: boolean;
  /** The loom-native T-SQL fold when the A2/A3 engine can express it, else null. */
  loomNativeSql: string | null;
  reason: string;
  /** Emitted whenever the measure PARSES — a faithful measure carry-over. */
  metricDraft?: SemanticContractMetricDraft;
}

const SLUG_RE = /[^a-z0-9]+/g;

/** Deterministic metric id from a measure name (owner-scoped in N9's store). */
export function measureMetricId(name: string): string {
  const slug = String(name || '').trim().toLowerCase().replace(SLUG_RE, '-').replace(/^-+|-+$/g, '');
  return slug || 'measure';
}

/**
 * Translate one DAX measure. Validates with the A1 parser and probes the A2/A3
 * SQL fold by wrapping the expression as `EVALUATE ROW("<name>", <expr>)`. A
 * measure that parses is emitted as a semantic-contract `measure` metric
 * (sourceRef = the original DAX); one that does not parse, or that is outside
 * the fold surface, is flagged needs-review with the exact reason — never a
 * rewritten/guessed expression.
 */
export function translateDaxMeasure(
  name: string,
  table: string,
  dax: string,
  opts: { owner?: string; model?: FoldModel } = {},
): DaxMeasureTranslation {
  const sourceDax = String(dax ?? '').trim();
  const base: DaxMeasureTranslation = {
    name, table, sourceDax, supported: false, parses: false, loomNativeSql: null, reason: '',
  };

  if (!sourceDax) {
    return { ...base, reason: 'Empty measure expression — nothing to translate.' };
  }

  // 1) A1 parse — validity gate. A malformed measure is an error, not a guess.
  try {
    parseDaxExpression(sourceDax);
  } catch (e) {
    if (e instanceof DaxParseError || e instanceof DaxLexError) {
      return { ...base, reason: `DAX does not parse — ${e.message}` };
    }
    return { ...base, reason: `DAX could not be parsed — ${(e as Error)?.message || 'unknown error'}` };
  }

  // Parses → a faithful measure carry-over is always safe (sourceRef = original DAX).
  const metricDraft: SemanticContractMetricDraft = {
    metricId: measureMetricId(name),
    label: String(name || '').trim() || measureMetricId(name),
    owner: String(opts.owner || '').trim(),
    description: `Migrated DAX measure${table ? ` from table "${table}"` : ''}.`,
    grain: '',
    sourceKind: 'measure',
    sourceRef: sourceDax,
    synonyms: [],
  };

  // 2) A2/A3 fold probe — does a loom-native SQL translation exist? A fixed
  // label keeps the wrapper's DAX string-literal escaping trivially valid.
  const wrapped = `EVALUATE ROW("value", ${sourceDax})`;
  const loomNativeSql = foldDaxToSql(wrapped, opts.model);

  if (loomNativeSql) {
    return {
      ...base,
      parses: true,
      supported: true,
      loomNativeSql,
      reason: 'Parses (A1) and folds to loom-native Synapse SQL (A2/A3) — the default backend can evaluate it.',
      metricDraft,
    };
  }

  // Parses but outside the fold surface — honest needs-review (mirrors A1).
  return {
    ...base,
    parses: true,
    supported: false,
    loomNativeSql: null,
    reason:
      'Parses as valid DAX but is outside the loom-native SQL-fold surface (e.g. FILTER / RELATED / measure references). ' +
      'It is carried over verbatim as an Analysis-Services-evaluated measure; the SQL-native rewrite needs review.',
    metricDraft,
  };
}

// ── PBIX / report → N16 code-report ───────────────────────────────────────────

/** A raw dataset query the report renders (carried over onto the report's engine). */
export interface ReportQueryDescriptor {
  name: string;
  /** Read-only SELECT/KQL executed on the bound engine. */
  sql: string;
}

/** A visual pinned on a report page (Power BI / Fabric report visual). */
export interface ReportVisualDescriptor {
  type: VisualType;
  query: string;
  x?: string;
  y?: string;
  series?: string;
  value?: string;
  label?: string;
  title?: string;
}

/** The enumerated report shape a reader produces from a PBIX / report (M3 does
 * NOT parse the PBIX binary — the reader supplies this structured descriptor). */
export interface ReportDescriptor {
  name: string;
  narrative?: string;
  engine?: CodeReportEngine;
  queries: ReportQueryDescriptor[];
  visuals: ReportVisualDescriptor[];
}

export interface ReportTranslation {
  name: string;
  supported: boolean;
  /** The generated N16 code-report source document (always shown in the diff). */
  source: string;
  reason: string;
  /** Set when N16 validation succeeded — counts for the review summary. */
  stats?: { queries: number; visuals: number };
}

/** Render an attribute, quoting the value when it contains whitespace. */
function attr(key: string, value?: string): string {
  if (value === undefined || value === '') return '';
  return /\s/.test(value) ? ` ${key}="${value.replace(/"/g, '')}"` : ` ${key}=${value}`;
}

/** Assemble an N16 code-report source document from a report descriptor. */
export function buildCodeReportSource(desc: ReportDescriptor): string {
  const lines: string[] = [];
  lines.push(`# ${desc.name || 'Migrated report'}`);
  lines.push('');
  if (desc.narrative && desc.narrative.trim()) {
    lines.push(desc.narrative.trim());
    lines.push('');
  }
  for (const q of desc.queries) {
    lines.push(`\`\`\`sql ${q.name}`);
    lines.push(String(q.sql ?? '').trim());
    lines.push('```');
    lines.push('');
  }
  for (const v of desc.visuals) {
    const body =
      `{${v.type} query=${v.query}` +
      attr('x', v.x) + attr('y', v.y) + attr('series', v.series) +
      attr('value', v.value) + attr('label', v.label) + attr('title', v.title) +
      `}`;
    lines.push(body);
    lines.push('');
  }
  return lines.join('\n').trim() + '\n';
}

/**
 * Translate a report descriptor to an N16 code-report and VALIDATE it with the
 * N16 parser (structure) + assertReadOnlyQuery (each raw query). A validation
 * failure surfaces as needs-review with the exact N16 error — never a silent
 * emit of a malformed report.
 */
export function translateReport(desc: ReportDescriptor): ReportTranslation {
  const source = buildCodeReportSource(desc);
  const engine = desc.engine ?? 'synapse';
  try {
    const ast = parseCodeReport(source);
    // Reuse N16's read-only guard on every raw block (render-time safety, checked now).
    for (const q of ast.queries) {
      if (q.kind === 'raw') assertReadOnlyQuery(q.sql, engineDialect(engine));
    }
    return {
      name: desc.name,
      supported: true,
      source,
      reason: 'Assembled and validated against the N16 code-report parser (structure + read-only query guard).',
      stats: { queries: ast.queries.length, visuals: ast.nodes.filter((n) => n.kind === 'visual').length },
    };
  } catch (e) {
    if (e instanceof CodeReportParseError) {
      return { name: desc.name, supported: false, source, reason: `Generated code-report failed N16 validation — ${e.message}` };
    }
    if (e instanceof RawQueryUnsafeError) {
      return { name: desc.name, supported: false, source, reason: `A report dataset query is not a read-only single statement — ${e.message}` };
    }
    return { name: desc.name, supported: false, source, reason: `Report translation failed — ${(e as Error)?.message || 'unknown error'}` };
  }
}
