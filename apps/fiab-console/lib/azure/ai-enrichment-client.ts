/**
 * ai-enrichment-client — batch LLM augmentation over a source table's columns.
 *
 * This is the execution + planning core behind the `ai-enrichment` catalog item
 * (Fabric AI-functions "batch over a column" parity, Azure-native, no Microsoft
 * Fabric / Power BI dependency — per no-fabric-dependency.md). It reuses the SAME
 * live backends as the item-scoped `/ai-function` route (rel-T85):
 *
 *   • Commercial / GCC + a Databricks SQL Warehouse → the enriched column is
 *     computed IN-DATABASE by Databricks' `ai_*` SQL builtins via a real
 *     CREATE TABLE … AS SELECT (CTAS). One statement enriches the whole table
 *     into a new Delta table with the new output column populated — the real
 *     destination the acceptance test checks.
 *
 *   • `custom_prompt` (no `ai_*` builtin) or a Gov boundary → per-row Azure
 *     OpenAI chat-completions via `callAiFn` (the same unified AOAI client the
 *     Copilot resolves), orchestrated here with bounded concurrency + retry.
 *
 * SPLIT OF CONCERNS
 * -----------------
 * Everything in THIS module is PURE (no Azure SDK / network / credential import)
 * so the batch-orchestration logic is unit-testable on its own
 * (ai-enrichment-client.test.ts). The BFF routes own the side-effects
 * (executeStatement / callAiFn / Cosmos persistence) and call into the pure
 * helpers here for chunking, the CTAS/expr SQL, the cost estimate, and the
 * concurrency+retry orchestrator (which takes the per-row enrich fn injected).
 */

import { escapeSqlLiteral } from '@/lib/sql/quoting';

// ─────────────────────────────────────────────────────────────────────────────
// Operations
// ─────────────────────────────────────────────────────────────────────────────

/** The enrichment operations. The first seven map to a Databricks `ai_*` SQL
 *  builtin (in-database CTAS path); `custom_prompt` is AOAI-only (the prompt IS
 *  the content — the one allowed freeform field, per no-freeform-config). */
export type EnrichmentOp =
  | 'summarize'
  | 'classify'
  | 'sentiment'
  | 'extract'
  | 'translate'
  | 'fix_grammar'
  | 'generate_response'
  | 'custom_prompt';

export const ENRICHMENT_OPS: readonly EnrichmentOp[] = [
  'summarize',
  'classify',
  'sentiment',
  'extract',
  'translate',
  'fix_grammar',
  'generate_response',
  'custom_prompt',
] as const;

export function isEnrichmentOp(v: unknown): v is EnrichmentOp {
  return typeof v === 'string' && (ENRICHMENT_OPS as readonly string[]).includes(v);
}

/** Ops with a direct Databricks `ai_*` SQL builtin (in-database CTAS path). */
const DBX_BUILTIN_OPS: ReadonlySet<EnrichmentOp> = new Set<EnrichmentOp>([
  'summarize', 'classify', 'sentiment', 'extract', 'translate', 'fix_grammar', 'generate_response',
]);

/** True when `op` can be pushed down to a Databricks `ai_*` SQL builtin. */
export function opHasDbxBuiltin(op: EnrichmentOp): boolean {
  return DBX_BUILTIN_OPS.has(op);
}

/** Model tier for the enrichment run (FGC-19 two-tier selector). `fast` = the
 *  default cost-efficient deployment (no override); `advanced` = a higher-
 *  reasoning deployment, optionally with a reasoning-effort param. */
export type ModelTier = 'fast' | 'advanced';
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

// ─────────────────────────────────────────────────────────────────────────────
// Execution tuning (batch size / concurrency)
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_BATCH_SIZE = 20;
export const MIN_BATCH_SIZE = 1;
export const MAX_BATCH_SIZE = 500;

export const DEFAULT_CONCURRENCY = 4;
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 16;

/** Hard ceiling on rows a single AOAI (per-row) run will process, to keep a
 *  serverless invocation bounded. The Databricks CTAS path is not row-capped
 *  here (the whole table is enriched in one statement). */
export const MAX_AOAI_ROWS = 2_000;

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export interface ExecTuning {
  batchSize: number;
  concurrency: number;
}

/** Clamp caller-supplied batch-size / concurrency into the supported window. */
export function normalizeExecTuning(input: Partial<ExecTuning> | undefined): ExecTuning {
  return {
    batchSize: clampInt(input?.batchSize, MIN_BATCH_SIZE, MAX_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    concurrency: clampInt(input?.concurrency, MIN_CONCURRENCY, MAX_CONCURRENCY, DEFAULT_CONCURRENCY),
  };
}

/** Split `items` into contiguous chunks of at most `size`. Pure. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Identifier / expression helpers (Databricks SQL)
// ─────────────────────────────────────────────────────────────────────────────

/** A plain SQL identifier token (letters, digits, underscore) — used to guard
 *  the OUTPUT column name and destination table name (they are spliced into a
 *  DDL string, so they must never carry punctuation). */
const SAFE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate + return a bare identifier for the output column / destination table.
 * Throws on anything that is not a plain `[A-Za-z_][A-Za-z0-9_]*` token so the
 * caller never splices unsanitized text into DDL. (Source column / table names
 * that may be qualified with dots/backticks are handled by `quoteColumn`.)
 */
export function sanitizeIdent(raw: string, what = 'identifier'): string {
  const t = (raw || '').trim();
  if (!SAFE_IDENT_RE.test(t)) {
    throw new Error(`Invalid ${what} "${raw}". Use letters, digits, and underscores (must start with a letter or underscore).`);
  }
  return t;
}

/** Backtick-quote a possibly-qualified source column/table (leaves already-
 *  backticked or dotted input intact — same rule as the ai-function route). */
export function quoteColumn(raw: string): string {
  const t = (raw || '').trim();
  if (!t) throw new Error('column is required');
  if (t.includes('`') || t.includes('.')) return t;
  return `\`${t}\``;
}

/**
 * Build the Databricks `ai_*` SQL expression for a builtin op over `colExpr`
 * (already quoted). `custom_prompt` has no builtin and throws — the caller must
 * route it to the AOAI per-row path.
 */
export function buildAiSqlExpr(op: EnrichmentOp, colExpr: string, opts: EnrichmentOptions = {}): string {
  switch (op) {
    case 'sentiment':
      return `ai_analyze_sentiment(${colExpr})`;
    case 'summarize':
      return `ai_summarize(${colExpr})`;
    case 'fix_grammar':
      return `ai_fix_grammar(${colExpr})`;
    case 'generate_response':
      return `ai_gen(${colExpr})`;
    case 'classify': {
      const labels = (opts.labels && opts.labels.length ? opts.labels : ['positive', 'negative', 'neutral'])
        .map((l) => `'${escapeSqlLiteral(String(l))}'`)
        .join(', ');
      return `ai_classify(${colExpr}, ARRAY(${labels}))`;
    }
    case 'translate':
      return `ai_translate(${colExpr}, '${escapeSqlLiteral(String(opts.targetLang || 'English'))}')`;
    case 'extract': {
      const fields = (opts.fields && opts.fields.length ? opts.fields : ['entity'])
        .map((f) => `'${escapeSqlLiteral(String(f))}'`)
        .join(', ');
      return `ai_extract(${colExpr}, ARRAY(${fields}))`;
    }
    default:
      throw new Error(`Operation "${op}" has no Databricks ai_* builtin; use the Azure OpenAI per-row path.`);
  }
}

export interface EnrichmentOptions {
  labels?: string[];
  fields?: string[];
  targetLang?: string;
  customPrompt?: string;
}

export interface CtasParams {
  catalog: string;
  schema: string;
  /** Destination table name (bare identifier — sanitized). */
  destTable: string;
  /** Fully-/partly-qualified source table (quoted verbatim). */
  sourceTable: string;
  /** Source column being enriched (quoted). */
  sourceColumn: string;
  /** Output column name (bare identifier — sanitized). */
  outputColumn: string;
  op: EnrichmentOp;
  options?: EnrichmentOptions;
  /** Optional row cap on the CTAS SELECT (0/undefined = whole table). */
  limit?: number;
}

/**
 * Build the in-database enrichment CTAS: create a new Delta table containing
 * every source column PLUS the `ai_*`-computed output column. Real destination
 * write — this is what materialises the enriched table for the builtin ops.
 *
 *   CREATE TABLE `cat`.`sch`.`dest` USING DELTA AS
 *   SELECT *, <ai_expr(col)> AS `out` FROM <src> [LIMIT n]
 */
export function buildEnrichmentCtas(p: CtasParams): string {
  const cat = sanitizeIdent(p.catalog, 'catalog');
  const sch = sanitizeIdent(p.schema, 'schema');
  const dest = sanitizeIdent(p.destTable, 'destination table');
  const outCol = sanitizeIdent(p.outputColumn, 'output column');
  const colExpr = quoteColumn(p.sourceColumn);
  const src = p.sourceTable.includes('`') || p.sourceTable.includes('.')
    ? p.sourceTable
    : `\`${sanitizeIdent(p.sourceTable, 'source table')}\``;
  const expr = buildAiSqlExpr(p.op, colExpr, p.options);
  const limitClause =
    typeof p.limit === 'number' && p.limit > 0 ? `\nLIMIT ${Math.floor(p.limit)}` : '';
  return (
    `CREATE TABLE \`${cat}\`.\`${sch}\`.\`${dest}\` USING DELTA AS\n` +
    `SELECT *, ${expr} AS \`${outCol}\`\n` +
    `FROM ${src}${limitClause}`
  );
}

export interface ValuesCtasParams {
  catalog: string;
  schema: string;
  destTable: string;
  outputColumn: string;
  /** Enriched pairs — source value + model output — one per row. */
  pairs: ReadonlyArray<{ source: string; output: string }>;
}

/**
 * Build a CTAS that materialises the AOAI per-row results as a new two-column
 * Delta table `(source_value, <outputColumn>)`. Used by the `custom_prompt` /
 * Gov AOAI run path (the ops with no `ai_*` builtin). Every literal is escaped
 * via `escapeSqlLiteral`; the table + output-column names are sanitized. Throws
 * on an empty `pairs` (nothing to write).
 */
export function buildValuesCtas(p: ValuesCtasParams): string {
  const cat = sanitizeIdent(p.catalog, 'catalog');
  const sch = sanitizeIdent(p.schema, 'schema');
  const dest = sanitizeIdent(p.destTable, 'destination table');
  const outCol = sanitizeIdent(p.outputColumn, 'output column');
  if (!p.pairs.length) throw new Error('no enriched rows to write.');
  const values = p.pairs
    .map((r) => `('${escapeSqlLiteral(r.source ?? '')}', '${escapeSqlLiteral(r.output ?? '')}')`)
    .join(',\n  ');
  return (
    `CREATE TABLE \`${cat}\`.\`${sch}\`.\`${dest}\` USING DELTA AS\n` +
    `SELECT * FROM VALUES\n  ${values}\n` +
    `AS t(source_value, \`${outCol}\`)`
  );
}

/** Build the read-N-rows SELECT for the preview / AOAI per-row path. */
export function buildSampleSelect(sourceTable: string, sourceColumn: string, limit: number): string {
  const colExpr = quoteColumn(sourceColumn);
  const src = sourceTable.includes('`') || sourceTable.includes('.')
    ? sourceTable
    : `\`${sanitizeIdent(sourceTable, 'source table')}\``;
  const n = clampInt(limit, 1, MAX_AOAI_ROWS, 20);
  return `SELECT ${colExpr} AS source_value FROM ${src} LIMIT ${n}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cost estimate (grounded in real measured usage — rel-T85 token metering)
// ─────────────────────────────────────────────────────────────────────────────

/** Default blended $/1M-token rate used ONLY for the "≈ USD" convenience line.
 *  Deliberately conservative + disclosed in the UI; the token estimate (which is
 *  grounded in a REAL preview run) is the primary figure. */
export const DEFAULT_USD_PER_1M_TOKENS = 5;

export interface CostEstimateInput {
  /** Total rows the full run will process. */
  rowCount: number;
  /** Average total tokens per row, measured from a real preview run. */
  avgTokensPerRow: number;
  /** Optional $/1M-token override (else DEFAULT_USD_PER_1M_TOKENS). */
  usdPer1MTokens?: number;
}

export interface CostEstimate {
  rowCount: number;
  avgTokensPerRow: number;
  estTotalTokens: number;
  usdPer1MTokens: number;
  estUsd: number;
}

/**
 * Estimate the full-run token/$ cost from a REAL sampled average (never an
 * invented number). `estTotalTokens = round(avgTokensPerRow) * rowCount`.
 */
export function estimateEnrichmentCost(input: CostEstimateInput): CostEstimate {
  const rowCount = Math.max(0, Math.floor(input.rowCount || 0));
  const avg = Math.max(0, input.avgTokensPerRow || 0);
  const rate = input.usdPer1MTokens && input.usdPer1MTokens > 0 ? input.usdPer1MTokens : DEFAULT_USD_PER_1M_TOKENS;
  const estTotalTokens = Math.round(avg * rowCount);
  const estUsd = (estTotalTokens / 1_000_000) * rate;
  return {
    rowCount,
    avgTokensPerRow: Math.round(avg),
    estTotalTokens,
    usdPer1MTokens: rate,
    estUsd: Math.round(estUsd * 10_000) / 10_000,
  };
}

/** Average total tokens per row from a set of per-row usage receipts. Rows with
 *  no usage are ignored; returns 0 when none carry usage. */
export function avgTokensPerRow(usages: ReadonlyArray<{ totalTokens?: number } | undefined>): number {
  let sum = 0;
  let n = 0;
  for (const u of usages) {
    if (u && typeof u.totalTokens === 'number' && u.totalTokens > 0) {
      sum += u.totalTokens;
      n += 1;
    }
  }
  return n === 0 ? 0 : sum / n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-row batch orchestrator (bounded concurrency + retry/backoff)
// ─────────────────────────────────────────────────────────────────────────────

export interface RowUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface RowResult {
  index: number;
  input: string;
  output?: string;
  model?: string;
  usage?: RowUsage;
  error?: string;
  attempts: number;
}

export interface BatchRunResult {
  total: number;
  succeeded: number;
  failed: number;
  results: RowResult[];
  usage: RowUsage;
}

export interface EnrichOneOutput {
  result: string;
  model?: string;
  usage?: RowUsage;
}

/** The per-row enrich fn injected by the route (wraps `callAiFn`). */
export type EnrichOneFn = (input: string, index: number) => Promise<EnrichOneOutput>;

export interface OrchestratorOptions {
  concurrency?: number;
  /** Max attempts per row (>=1). Default 3. */
  maxAttempts?: number;
  /** Base backoff ms between retries (exponential). Default 250. */
  backoffBaseMs?: number;
  /** Injected sleep (tests pass a no-op / fake timer). Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Progress callback fired as each row settles. */
  onProgress?: (done: number, total: number) => void;
  /** Optional abort signal — stops scheduling new rows when aborted. */
  signal?: { aborted: boolean };
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const emptyUsage = (): RowUsage => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });

function addUsage(a: RowUsage, b?: RowUsage): void {
  if (!b) return;
  a.promptTokens += b.promptTokens || 0;
  a.completionTokens += b.completionTokens || 0;
  a.totalTokens += b.totalTokens || 0;
}

/**
 * Run `enrichOne` over every input with bounded concurrency and per-row retry
 * with exponential backoff. A row that exhausts its attempts is recorded with
 * an `error` (the run continues — partial success is reported, never silently
 * dropped). Pure control flow: all side-effects come through the injected
 * `enrichOne` / `sleep`, so this is fully unit-testable.
 */
export async function runAoaiEnrichment(
  inputs: readonly string[],
  enrichOne: EnrichOneFn,
  opts: OrchestratorOptions = {},
): Promise<BatchRunResult> {
  const concurrency = clampInt(opts.concurrency, MIN_CONCURRENCY, MAX_CONCURRENCY, DEFAULT_CONCURRENCY);
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? 3));
  const backoffBaseMs = Math.max(0, opts.backoffBaseMs ?? 250);
  const sleep = opts.sleep ?? realSleep;

  const results: RowResult[] = new Array(inputs.length);
  const total = inputs.length;
  let done = 0;
  let next = 0;

  const runRow = async (index: number): Promise<void> => {
    const input = inputs[index];
    let attempts = 0;
    let lastErr: unknown;
    while (attempts < maxAttempts) {
      attempts += 1;
      if (opts.signal?.aborted) {
        results[index] = { index, input, error: 'aborted', attempts };
        return;
      }
      try {
        const out = await enrichOne(input, index);
        results[index] = { index, input, output: out.result, model: out.model, usage: out.usage, attempts };
        return;
      } catch (e) {
        lastErr = e;
        if (attempts < maxAttempts) {
          await sleep(backoffBaseMs * 2 ** (attempts - 1));
        }
      }
    }
    results[index] = {
      index,
      input,
      error: lastErr instanceof Error ? lastErr.message : String(lastErr),
      attempts,
    };
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (opts.signal?.aborted) return;
      const index = next++;
      if (index >= total) return;
      await runRow(index);
      done += 1;
      opts.onProgress?.(done, total);
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, total || 1); i++) workers.push(worker());
  await Promise.all(workers);

  const usage = emptyUsage();
  let succeeded = 0;
  let failed = 0;
  for (const r of results) {
    if (!r) continue;
    if (r.error) failed += 1;
    else {
      succeeded += 1;
      addUsage(usage, r.usage);
    }
  }
  return { total, succeeded, failed, results: results.filter(Boolean), usage };
}

// ─────────────────────────────────────────────────────────────────────────────
// Persisted run-history record (Cosmos item.state.runs[])
// ─────────────────────────────────────────────────────────────────────────────

export type EnrichmentEngine = 'databricks' | 'aoai';
export type EnrichmentRunStatus = 'succeeded' | 'partial' | 'failed';

export interface EnrichmentRun {
  id: string;
  startedAt: string;
  finishedAt: string;
  engine: EnrichmentEngine;
  op: EnrichmentOp;
  sourceTable: string;
  sourceColumn: string;
  outputColumn: string;
  destTable?: string;
  tier: ModelTier;
  model?: string;
  rowsProcessed: number;
  rowsSucceeded: number;
  rowsFailed: number;
  totalTokens: number;
  durationMs: number;
  status: EnrichmentRunStatus;
  error?: string;
  startedBy?: string;
}

export const MAX_PERSISTED_RUNS = 50;

/** Prepend `run` to the persisted history, capped at MAX_PERSISTED_RUNS. Pure. */
export function appendRun(existing: EnrichmentRun[] | undefined, run: EnrichmentRun): EnrichmentRun[] {
  const list = Array.isArray(existing) ? existing : [];
  return [run, ...list].slice(0, MAX_PERSISTED_RUNS);
}

/** Derive a run status from the success/fail counts. */
export function runStatusFor(succeeded: number, failed: number): EnrichmentRunStatus {
  if (failed === 0 && succeeded > 0) return 'succeeded';
  if (succeeded === 0) return 'failed';
  return 'partial';
}
