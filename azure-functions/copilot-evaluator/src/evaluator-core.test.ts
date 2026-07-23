import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  missingConfig,
  evalEnabled,
  resolveJudgeDeployment,
  judgeDailyCap,
  judgeDecision,
  judgeLedgerDay,
  loadEvalSets,
  chunkPath,
  scoreRetrieval,
  deterministicGuards,
  buildJudgeMessages,
  parseJudge,
  computePass,
  rollupRun,
  resolveEvalRoot,
  loadSearchEvalSets,
  normalizeSearchId,
  scoreSearchRelevance,
  rollupSearchRun,
  type EvalResult,
  type SearchResult,
} from './evaluator-core';

const row = {
  id: 'help-001',
  question: 'How do I bind a lakehouse without a Fabric capacity?',
  expectedChunks: ['docs/fiab/parity/lakehouse.md#azure-native', 'docs/fiab/items/lakehouse.md'],
  expectedAnswer: 'Loom defaults to ADLS Gen2 + Delta; no Fabric workspace is required.',
  mustMention: ['ADLS', 'Delta'],
  mustNotMention: ['requires a Fabric capacity'],
  tier: 'mini' as const,
  taskClass: 'general' as const,
};

describe('missingConfig / evalEnabled', () => {
  it('reports the exact missing env vars (honest gate)', () => {
    expect(missingConfig({})).toEqual(['LOOM_COSMOS_ENDPOINT', 'LOOM_EVAL_PROBE_URL', 'LOOM_INTERNAL_TOKEN']);
    expect(
      missingConfig({ LOOM_COSMOS_ENDPOINT: 'x', LOOM_EVAL_PROBE_URL: 'y', LOOM_INTERNAL_TOKEN: 'z' }),
    ).toEqual([]);
  });
  it('is default-ON / opt-out (loom_default_on_opt_out)', () => {
    expect(evalEnabled({})).toBe(true);
    expect(evalEnabled({ LOOM_COPILOT_EVAL_ENABLED: 'true' })).toBe(true);
    expect(evalEnabled({ LOOM_COPILOT_EVAL_ENABLED: 'FALSE' })).toBe(false);
  });
});

describe('resolveJudgeDeployment (strong → mini → default chain, no hardcoded models)', () => {
  it('prefers the dedicated judge deployment', () => {
    expect(
      resolveJudgeDeployment({
        LOOM_COPILOT_EVAL_JUDGE_DEPLOYMENT: 'judge-slot',
        LOOM_AOAI_STRONG_DEPLOYMENT: 'strong-slot',
      }),
    ).toBe('judge-slot');
  });
  it('falls back strong → mini → default', () => {
    expect(resolveJudgeDeployment({ LOOM_AOAI_STRONG_DEPLOYMENT: 's', LOOM_AOAI_MINI_DEPLOYMENT: 'm' })).toBe('s');
    expect(resolveJudgeDeployment({ LOOM_AOAI_MINI_DEPLOYMENT: 'm', LOOM_AOAI_DEPLOYMENT: 'd' })).toBe('m');
    expect(resolveJudgeDeployment({ LOOM_AOAI_DEPLOYMENT: 'd' })).toBe('d');
    expect(resolveJudgeDeployment({})).toBeUndefined();
    expect(resolveJudgeDeployment({ LOOM_COPILOT_EVAL_JUDGE_DEPLOYMENT: '   ' })).toBeUndefined();
  });
});

describe('judge daily cap (round-3 F1)', () => {
  it('defaults to 500 and rejects garbage', () => {
    expect(judgeDailyCap({})).toBe(500);
    expect(judgeDailyCap({ LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP: '120' })).toBe(120);
    expect(judgeDailyCap({ LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP: '0' })).toBe(500);
    expect(judgeDailyCap({ LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP: 'nope' })).toBe(500);
  });
  it('forbidden phrase auto-fails BEFORE any judge spend', () => {
    expect(judgeDecision({ forbiddenHit: true, judgeDeployment: 'j', judgedToday: 0, cap: 500 })).toBe('auto-fail');
  });
  it('over-cap → deferred (retrieval-only), under-cap → judge', () => {
    expect(judgeDecision({ forbiddenHit: false, judgeDeployment: 'j', judgedToday: 500, cap: 500 })).toBe('deferred');
    expect(judgeDecision({ forbiddenHit: false, judgeDeployment: 'j', judgedToday: 499, cap: 500 })).toBe('judge');
  });
  it('no judge deployment → deferred (honest judge-less posture)', () => {
    expect(judgeDecision({ forbiddenHit: false, judgeDeployment: undefined, judgedToday: 0, cap: 500 })).toBe('deferred');
  });
  it('ledger day is a UTC date key', () => {
    expect(judgeLedgerDay(new Date('2026-07-22T23:59:59Z'))).toBe('2026-07-22');
  });
});

describe('loadEvalSets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-'));
  fs.writeFileSync(path.join(dir, 'help.jsonl'), `${JSON.stringify(row)}\n${JSON.stringify({ ...row, id: 'help-002' })}\n`);
  fs.writeFileSync(path.join(dir, 'cost.jsonl'), `${JSON.stringify({ ...row, id: 'cost-001' })}\n`);
  fs.writeFileSync(path.join(dir, '_schema.json'), '{}');
  it('loads one set per surface JSONL, skipping _-prefixed files', () => {
    const sets = loadEvalSets(dir);
    expect(sets.map((s) => s.surface)).toEqual(['cost', 'help']);
    expect(sets.find((s) => s.surface === 'help')!.rows).toHaveLength(2);
  });
  it('filters to requested surfaces', () => {
    expect(loadEvalSets(dir, ['help']).map((s) => s.surface)).toEqual(['help']);
  });
  it('throws loudly on a malformed line (never silently scores 0)', () => {
    fs.writeFileSync(path.join(dir, 'bad.jsonl'), 'not json\n');
    expect(() => loadEvalSets(dir, ['bad'])).toThrow(/bad\.jsonl:1/);
  });
  it('returns [] for a missing root', () => {
    expect(loadEvalSets(path.join(dir, 'nope'))).toEqual([]);
  });
});

describe('scoreRetrieval (hit + MRR)', () => {
  it('matches on doc path ignoring #anchors and case', () => {
    expect(chunkPath('Docs/Fiab/X.md#anchor')).toBe('docs/fiab/x.md');
    const { hit, mrr } = scoreRetrieval(row.expectedChunks, [
      'docs/fiab/other.md',
      'docs/fiab/parity/lakehouse.md#some-other-anchor',
    ]);
    expect(hit).toBe(true);
    // expected[0] at rank 2 → 1/2; expected[1] absent → 0; mean = 0.25
    expect(mrr).toBeCloseTo(0.25);
  });
  it('perfect first-rank retrieval scores mrr 1 with one expected chunk', () => {
    expect(scoreRetrieval(['docs/a.md'], ['docs/a.md'])).toEqual({ hit: true, mrr: 1 });
  });
  it('no overlap → miss', () => {
    expect(scoreRetrieval(['docs/a.md'], ['docs/b.md'])).toEqual({ hit: false, mrr: 0 });
  });
});

describe('deterministicGuards (gate BEFORE the judge)', () => {
  it('passes when every mustMention appears and no forbidden phrase does', () => {
    const g = deterministicGuards('Loom uses ADLS Gen2 with Delta tables.', row);
    expect(g).toMatchObject({ mentionPass: true, forbiddenHit: false });
  });
  it('flags a forbidden phrase (auto-fail, no judge spend) case-insensitively', () => {
    const g = deterministicGuards('This Requires a Fabric Capacity to work.', row);
    expect(g.forbiddenHit).toBe(true);
    expect(g.forbiddenPhrases).toEqual(['requires a Fabric capacity']);
  });
  it('reports the exact missing mentions', () => {
    const g = deterministicGuards('Loom uses Delta.', row);
    expect(g.mentionPass).toBe(false);
    expect(g.missingMentions).toEqual(['ADLS']);
  });
});

describe('buildJudgeMessages / parseJudge', () => {
  it('grounds the rubric on excerpts + gold answer and bakes in the no-Fabric ground truth', () => {
    const msgs = buildJudgeMessages(row, 'candidate', ['excerpt one']);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('NOT Microsoft Fabric');
    expect(msgs[0].content).toContain('grounding');
    expect(msgs[1].content).toContain('excerpt one');
    expect(msgs[1].content).toContain(row.expectedAnswer);
    expect(msgs[1].content).toContain('candidate');
  });
  it('parses strict JSON, fenced JSON, and prose-wrapped JSON; clamps to 1–5', () => {
    expect(parseJudge('{"grounding":4,"relevance":5,"completeness":3,"rationale":"ok"}')).toEqual({
      grounding: 4, relevance: 5, completeness: 3, rationale: 'ok',
    });
    expect(parseJudge('```json\n{"grounding":9,"relevance":0,"completeness":2.6,"rationale":"r"}\n```')).toEqual({
      grounding: 5, relevance: 1, completeness: 3, rationale: 'r',
    });
    expect(parseJudge('Sure! {"grounding":2,"relevance":2,"completeness":2,"rationale":""} hope that helps')).toMatchObject({ grounding: 2 });
    expect(parseJudge('no json here')).toBeNull();
    expect(parseJudge('{"grounding":"high"}')).toBeNull();
  });
});

describe('computePass + rollupRun', () => {
  const base: EvalResult = {
    questionId: 'q', surface: 'help', retrievalHit: true, mrr: 1, mentionPass: true,
    forbiddenHit: false, judgeStatus: 'scored',
    judge: { grounding: 5, relevance: 5, completeness: 4, rationale: '' },
    pass: true, latencyMs: 100,
  };
  it('pass requires hit + mentions + no forbidden + grounding≥4', () => {
    expect(computePass(base)).toBe(true);
    expect(computePass({ ...base, judge: { ...base.judge!, grounding: 3 } })).toBe(false);
    expect(computePass({ ...base, retrievalHit: false })).toBe(false);
    expect(computePass({ ...base, forbiddenHit: true })).toBe(false);
    expect(computePass({ ...base, mentionPass: false })).toBe(false);
  });
  it('deferred judge keeps the deterministic verdict (E3 no-change semantics)', () => {
    expect(computePass({ ...base, judgeStatus: 'deferred', judge: undefined })).toBe(true);
    expect(computePass({ ...base, judgeStatus: 'deferred', judge: undefined, retrievalHit: false })).toBe(false);
  });
  it('rolls up hit-rate / mrr / grounding / pass-rate / judge counters', () => {
    const results: EvalResult[] = [
      base,
      { ...base, questionId: 'q2', retrievalHit: false, mrr: 0, pass: false, judgeStatus: 'deferred', judge: undefined },
      { ...base, questionId: 'q3', forbiddenHit: true, pass: false, judgeStatus: 'auto-fail', judge: undefined },
      { ...base, questionId: 'q4', judge: { grounding: 3, relevance: 4, completeness: 4, rationale: '' }, pass: false },
    ];
    const t = rollupRun(results);
    expect(t.questions).toBe(4);
    expect(t.retrievalHitRate).toBe(0.75);
    expect(t.judged).toBe(2);
    expect(t.deferred).toBe(1);
    expect(t.autoFailed).toBe(1);
    expect(t.groundingAvg).toBe(4); // (5 + 3) / 2
    expect(t.passRate).toBe(0.25);
    expect(t.mrrAvg).toBe(0.75);
  });
  it('empty run → zeroed totals with null judge averages', () => {
    expect(rollupRun([])).toMatchObject({ questions: 0, groundingAvg: null, answerAvg: null });
  });
});

describe('resolveEvalRoot', () => {
  it('walks up to a repo checkout content/evals', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
    fs.mkdirSync(path.join(root, 'content', 'evals'), { recursive: true });
    const nested = path.join(root, 'azure-functions', 'copilot-evaluator');
    fs.mkdirSync(nested, { recursive: true });
    expect(resolveEvalRoot(nested)).toBe(path.join(root, 'content', 'evals'));
  });
  it('prefers a package-local evals/ dir', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-'));
    fs.mkdirSync(path.join(root, 'evals'));
    expect(resolveEvalRoot(root)).toBe(path.join(root, 'evals'));
  });
  it('returns null when nothing is found', () => {
    expect(resolveEvalRoot(os.tmpdir())).toBeNull();
  });
});

// ── SRCH1 — federated-search relevance ───────────────────────────────────────

describe('normalizeSearchId', () => {
  it('lowercases, strips it: prefix, collapses whitespace', () => {
    expect(normalizeSearchId('it:Sales   Lakehouse')).toBe('sales lakehouse');
    expect(normalizeSearchId('it_ABC')).toBe('abc');
  });
});

describe('scoreSearchRelevance', () => {
  it('perfect ranking → hit, mrr 1, ndcg 1', () => {
    const s = scoreSearchRelevance(['sales-lakehouse'], ['Demo · sales-lakehouse', 'other'], 5);
    expect(s.hit).toBe(true);
    expect(s.mrr).toBe(1);
    expect(s.ndcg).toBe(1);
    expect(s.matched).toBe(1);
  });
  it('match at rank 2 → mrr 0.5, ndcg < 1', () => {
    const s = scoreSearchRelevance(['sales-lakehouse'], ['noise', 'sales-lakehouse'], 5);
    expect(s.hit).toBe(true);
    expect(s.mrr).toBe(0.5);
    expect(s.ndcg).toBeLessThan(1);
    expect(s.ndcg).toBeGreaterThan(0);
  });
  it('no match in top-k → all zero', () => {
    const s = scoreSearchRelevance(['sales-lakehouse'], ['a', 'b', 'c'], 3);
    expect(s).toMatchObject({ hit: false, mrr: 0, ndcg: 0, matched: 0 });
  });
  it('respects k (a hit beyond k does not count)', () => {
    const s = scoreSearchRelevance(['x'], ['a', 'b', 'x'], 2);
    expect(s.hit).toBe(false);
  });
  it('two expected, both in top-2 → ndcg 1', () => {
    const s = scoreSearchRelevance(['alpha', 'beta'], ['alpha item', 'beta item', 'gamma'], 5);
    expect(s.matched).toBe(2);
    expect(s.ndcg).toBe(1);
  });
  it('empty expected → zero', () => {
    expect(scoreSearchRelevance([], ['a'], 5)).toMatchObject({ hit: false, ndcg: 0 });
  });
});

describe('rollupSearchRun', () => {
  const mk = (o: Partial<SearchResult>): SearchResult => ({
    queryId: 'q', domain: 'd', query: 'q', expectedResults: ['x'], retrieved: ['x'],
    hit: true, mrr: 1, ndcg: 1, matched: 1, k: 5, latencyMs: 10, ...o,
  });
  it('averages hit-rate / mrr / ndcg', () => {
    const t = rollupSearchRun([mk({}), mk({ hit: false, mrr: 0, ndcg: 0 })]);
    expect(t.queries).toBe(2);
    expect(t.hitRate).toBe(0.5);
    expect(t.mrrAvg).toBe(0.5);
    expect(t.ndcgAvg).toBe(0.5);
  });
  it('empty → zeroed', () => {
    expect(rollupSearchRun([])).toMatchObject({ queries: 0, hitRate: 0, ndcgAvg: 0 });
  });
});

describe('loadSearchEvalSets', () => {
  it('loads search/<domain>.jsonl, skips _files, filters by domain', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srch-'));
    fs.mkdirSync(path.join(root, 'search'), { recursive: true });
    fs.writeFileSync(path.join(root, 'search', 'catalog.jsonl'),
      JSON.stringify({ id: 'catalog-001', query: 'sales data', expectedResults: ['sales-lakehouse'] }) + '\n');
    fs.writeFileSync(path.join(root, 'search', '_schema.json'), '{}');
    const sets = loadSearchEvalSets(root);
    expect(sets).toHaveLength(1);
    expect(sets[0].domain).toBe('catalog');
    expect(sets[0].rows[0].expectedResults).toEqual(['sales-lakehouse']);
    expect(loadSearchEvalSets(root, ['nope'])).toHaveLength(0);
  });
  it('throws on a malformed row', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srch-'));
    fs.mkdirSync(path.join(root, 'search'), { recursive: true });
    fs.writeFileSync(path.join(root, 'search', 'bad.jsonl'), '{"id":"x"}\n');
    expect(() => loadSearchEvalSets(root)).toThrow(/missing id\/query\/expectedResults/);
  });
});
