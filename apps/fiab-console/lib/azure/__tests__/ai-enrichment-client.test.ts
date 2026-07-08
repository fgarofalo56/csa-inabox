import { describe, it, expect, vi } from 'vitest';
import {
  ENRICHMENT_OPS, isEnrichmentOp, opHasDbxBuiltin,
  chunk, normalizeExecTuning, DEFAULT_BATCH_SIZE, DEFAULT_CONCURRENCY, MAX_BATCH_SIZE, MAX_CONCURRENCY,
  sanitizeIdent, quoteColumn, buildAiSqlExpr, buildEnrichmentCtas, buildValuesCtas, buildSampleSelect,
  estimateEnrichmentCost, avgTokensPerRow, DEFAULT_USD_PER_1M_TOKENS,
  runAoaiEnrichment, appendRun, runStatusFor, MAX_PERSISTED_RUNS, MAX_AOAI_ROWS,
  type EnrichmentRun,
} from '../ai-enrichment-client';

const noSleep = async () => {};

describe('ai-enrichment: op registry', () => {
  it('recognizes every op and rejects junk', () => {
    for (const op of ENRICHMENT_OPS) expect(isEnrichmentOp(op)).toBe(true);
    expect(isEnrichmentOp('nope')).toBe(false);
    expect(isEnrichmentOp(42)).toBe(false);
  });
  it('marks the seven builtins as dbx-pushdownable and custom_prompt not', () => {
    expect(opHasDbxBuiltin('summarize')).toBe(true);
    expect(opHasDbxBuiltin('classify')).toBe(true);
    expect(opHasDbxBuiltin('custom_prompt')).toBe(false);
  });
});

describe('ai-enrichment: chunk + tuning', () => {
  it('chunks into contiguous groups', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(chunk([1], 5)).toEqual([[1]]);
  });
  it('clamps batch size + concurrency into the supported window', () => {
    expect(normalizeExecTuning(undefined)).toEqual({ batchSize: DEFAULT_BATCH_SIZE, concurrency: DEFAULT_CONCURRENCY });
    expect(normalizeExecTuning({ batchSize: 99999, concurrency: 99 })).toEqual({ batchSize: MAX_BATCH_SIZE, concurrency: MAX_CONCURRENCY });
    expect(normalizeExecTuning({ batchSize: 0, concurrency: 0 })).toEqual({ batchSize: 1, concurrency: 1 });
    expect(normalizeExecTuning({ batchSize: NaN as unknown as number })).toEqual({ batchSize: DEFAULT_BATCH_SIZE, concurrency: DEFAULT_CONCURRENCY });
  });
});

describe('ai-enrichment: identifier + expression safety', () => {
  it('accepts plain identifiers and rejects punctuation', () => {
    expect(sanitizeIdent('ai_result')).toBe('ai_result');
    expect(sanitizeIdent('  Col_1 ')).toBe('Col_1');
    expect(() => sanitizeIdent('drop table x', 'output column')).toThrow(/output column/);
    expect(() => sanitizeIdent('a-b')).toThrow();
    expect(() => sanitizeIdent('1col')).toThrow();
    expect(() => sanitizeIdent('')).toThrow();
  });
  it('quotes a bare column but leaves dotted/backticked input intact', () => {
    expect(quoteColumn('review')).toBe('`review`');
    expect(quoteColumn('cat.sch.tbl')).toBe('cat.sch.tbl');
    expect(quoteColumn('`c`')).toBe('`c`');
    expect(() => quoteColumn('')).toThrow();
  });
  it('builds each builtin ai_* expression and escapes literals', () => {
    expect(buildAiSqlExpr('sentiment', '`c`')).toBe('ai_analyze_sentiment(`c`)');
    expect(buildAiSqlExpr('summarize', '`c`')).toBe('ai_summarize(`c`)');
    expect(buildAiSqlExpr('classify', '`c`', { labels: ["a'b", 'c'] })).toBe("ai_classify(`c`, ARRAY('a''b', 'c'))");
    expect(buildAiSqlExpr('translate', '`c`', { targetLang: "O'Brien" })).toBe("ai_translate(`c`, 'O''Brien')");
    expect(buildAiSqlExpr('extract', '`c`', { fields: ['co'] })).toBe("ai_extract(`c`, ARRAY('co'))");
    expect(() => buildAiSqlExpr('custom_prompt', '`c`')).toThrow(/no Databricks ai_\* builtin/);
  });
});

describe('ai-enrichment: CTAS builders', () => {
  it('builds the enrichment CTAS preserving all source columns + the new column', () => {
    const sql = buildEnrichmentCtas({
      catalog: 'main', schema: 'sales', destTable: 'reviews_enriched',
      sourceTable: '`main`.`sales`.`reviews`', sourceColumn: 'body', outputColumn: 'ai_result',
      op: 'summarize',
    });
    expect(sql).toContain('CREATE TABLE `main`.`sales`.`reviews_enriched` USING DELTA AS');
    expect(sql).toContain('SELECT *, ai_summarize(`body`) AS `ai_result`');
    expect(sql).toContain('FROM `main`.`sales`.`reviews`');
    expect(sql).not.toContain('LIMIT');
  });
  it('adds a LIMIT when provided and rejects a bad output column', () => {
    const sql = buildEnrichmentCtas({
      catalog: 'main', schema: 'sales', destTable: 'd', sourceTable: 't', sourceColumn: 'c', outputColumn: 'o', op: 'sentiment', limit: 100,
    });
    expect(sql).toContain('LIMIT 100');
    expect(() => buildEnrichmentCtas({
      catalog: 'main', schema: 'sales', destTable: 'd', sourceTable: 't', sourceColumn: 'c', outputColumn: 'bad col', op: 'sentiment',
    })).toThrow(/output column/);
  });
  it('builds a VALUES CTAS from enriched pairs, escaping quotes, and throws when empty', () => {
    const sql = buildValuesCtas({
      catalog: 'main', schema: 'sales', destTable: 'out', outputColumn: 'ai_result',
      pairs: [{ source: "it's fine", output: 'ok' }, { source: 'b', output: 'good' }],
    });
    expect(sql).toContain('CREATE TABLE `main`.`sales`.`out` USING DELTA AS');
    expect(sql).toContain("('it''s fine', 'ok')");
    expect(sql).toContain('AS t(source_value, `ai_result`)');
    expect(() => buildValuesCtas({ catalog: 'm', schema: 's', destTable: 'd', outputColumn: 'o', pairs: [] })).toThrow(/no enriched rows/);
  });
  it('builds a bounded sample SELECT', () => {
    expect(buildSampleSelect('`m`.`s`.`t`', 'body', 5)).toBe('SELECT `body` AS source_value FROM `m`.`s`.`t` LIMIT 5');
    // clamps insane limits
    expect(buildSampleSelect('t', 'c', 10_000_000)).toContain(`LIMIT ${MAX_AOAI_ROWS}`);
  });
});

describe('ai-enrichment: cost estimate', () => {
  it('extrapolates measured avg tokens across the row count', () => {
    const est = estimateEnrichmentCost({ rowCount: 1000, avgTokensPerRow: 150 });
    expect(est.estTotalTokens).toBe(150_000);
    expect(est.usdPer1MTokens).toBe(DEFAULT_USD_PER_1M_TOKENS);
    expect(est.estUsd).toBeCloseTo((150_000 / 1_000_000) * DEFAULT_USD_PER_1M_TOKENS, 6);
  });
  it('honors a custom rate and zero rows', () => {
    expect(estimateEnrichmentCost({ rowCount: 0, avgTokensPerRow: 100 }).estTotalTokens).toBe(0);
    expect(estimateEnrichmentCost({ rowCount: 10, avgTokensPerRow: 100, usdPer1MTokens: 10 }).usdPer1MTokens).toBe(10);
  });
  it('averages token usage receipts, ignoring rows without usage', () => {
    expect(avgTokensPerRow([{ totalTokens: 100 }, { totalTokens: 200 }, undefined, { totalTokens: 0 }])).toBe(150);
    expect(avgTokensPerRow([])).toBe(0);
    expect(avgTokensPerRow([undefined, {}])).toBe(0);
  });
});

describe('ai-enrichment: batch orchestrator', () => {
  it('enriches every row with bounded concurrency and aggregates usage', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const enrich = vi.fn(async (input: string) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return { result: `E:${input}`, model: 'gpt-test', usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } };
    });
    const inputs = Array.from({ length: 10 }, (_, i) => `r${i}`);
    const res = await runAoaiEnrichment(inputs, enrich, { concurrency: 3, sleep: noSleep });
    expect(res.total).toBe(10);
    expect(res.succeeded).toBe(10);
    expect(res.failed).toBe(0);
    expect(res.usage.totalTokens).toBe(100);
    expect(res.results.map((r) => r.output)).toEqual(inputs.map((i) => `E:${i}`));
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('retries a transient failure with backoff then succeeds', async () => {
    let calls = 0;
    const enrich = vi.fn(async (input: string) => {
      calls++;
      if (calls === 1) throw new Error('429 transient');
      return { result: `ok:${input}`, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });
    const res = await runAoaiEnrichment(['a'], enrich, { concurrency: 1, maxAttempts: 3, sleep: noSleep });
    expect(res.succeeded).toBe(1);
    expect(res.results[0].attempts).toBe(2);
    expect(res.results[0].output).toBe('ok:a');
  });

  it('records a row that exhausts its attempts as failed without aborting the run', async () => {
    const enrich = vi.fn(async (input: string) => {
      if (input === 'bad') throw new Error('permanent');
      return { result: `ok:${input}`, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });
    const res = await runAoaiEnrichment(['good', 'bad', 'good2'], enrich, { concurrency: 2, maxAttempts: 2, sleep: noSleep });
    expect(res.succeeded).toBe(2);
    expect(res.failed).toBe(1);
    const bad = res.results.find((r) => r.input === 'bad');
    expect(bad?.error).toMatch(/permanent/);
    expect(bad?.attempts).toBe(2);
  });

  it('reports progress per settled row', async () => {
    const seen: Array<[number, number]> = [];
    const enrich = async (input: string) => ({ result: input });
    await runAoaiEnrichment(['a', 'b', 'c'], enrich, { concurrency: 1, sleep: noSleep, onProgress: (d, t) => seen.push([d, t]) });
    expect(seen).toEqual([[1, 3], [2, 3], [3, 3]]);
  });

  it('stops scheduling when the abort signal is set', async () => {
    const signal = { aborted: false };
    let processed = 0;
    const enrich = async (input: string) => {
      processed++;
      if (processed === 1) signal.aborted = true;
      return { result: input };
    };
    const res = await runAoaiEnrichment(['a', 'b', 'c', 'd'], enrich, { concurrency: 1, sleep: noSleep, signal });
    expect(processed).toBeLessThan(4);
    expect(res.total).toBe(4);
  });
});

describe('ai-enrichment: run history', () => {
  const mkRun = (id: string): EnrichmentRun => ({
    id, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    engine: 'databricks', op: 'summarize', sourceTable: 'm.s.t', sourceColumn: 'c', outputColumn: 'o',
    tier: 'fast', rowsProcessed: 1, rowsSucceeded: 1, rowsFailed: 0, totalTokens: 0, durationMs: 1, status: 'succeeded',
  });
  it('prepends newest-first and caps the history', () => {
    let hist: EnrichmentRun[] | undefined;
    for (let i = 0; i < MAX_PERSISTED_RUNS + 10; i++) hist = appendRun(hist, mkRun(`r${i}`));
    expect(hist!.length).toBe(MAX_PERSISTED_RUNS);
    expect(hist![0].id).toBe(`r${MAX_PERSISTED_RUNS + 9}`);
  });
  it('derives run status from counts', () => {
    expect(runStatusFor(5, 0)).toBe('succeeded');
    expect(runStatusFor(0, 3)).toBe('failed');
    expect(runStatusFor(3, 2)).toBe('partial');
  });
});
