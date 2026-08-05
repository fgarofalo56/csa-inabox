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
  classifyExcerptProvenance,
  detectParityInversion,
  buildJudgeMessages,
  parseJudge,
  computePass,
  passPredicateFor,
  rollupRun,
  rollupBackends,
  resolveEvalRoot,
  loadSearchEvalSets,
  normalizeSearchId,
  scoreSearchRelevance,
  rollupSearchRun,
  loadTierLabels,
  routeTierForPrompt,
  scoreTierDecision,
  reduceTierConfusion,
  type EvalResult,
  type RetrievedExcerpt,
  type SearchResult,
  type TierDecisionScore,
  type TierLabelRow,
} from './evaluator-core';
import type { TierSelection } from '../../../apps/fiab-console/lib/foundry/model-tier-router';

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
    const msgs = buildJudgeMessages(row, 'candidate', [
      { path: 'docs/fiab/lakehouse.md', heading: null, content: 'excerpt one' },
    ]);
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

// ── #2979 — parity-doc product provenance ────────────────────────────────────
//
// FIXTURES ARE REAL CORPUS TEXT, NOT PARAPHRASE. Every excerpt below is copied
// verbatim out of the docs it claims to come from, with the breadcrumb the
// #2969 chunker actually produces (`documentTitle › innermost heading`). A
// fixture written to match what this code EXPECTS rather than what the corpus
// CONTAINS is how a guard passes while the thing it guards is broken, so these
// strings are lifted from the files and the round-trip through the real
// chunker is asserted below.
describe('parity-doc provenance (#2979)', () => {
  // docs/fiab/parity/activator-run-history.md — a LABELLED inventory H2.
  const ACTIVATOR_TITLE =
    'activator-run-history — parity with Fabric Activator "Recent activity" / Azure Monitor alert history';
  const inventoryExcerpt: RetrievedExcerpt = {
    path: 'docs/fiab/parity/activator-run-history.md',
    heading: `${ACTIVATOR_TITLE} › Azure/Fabric feature inventory (run history surface)`,
    content:
      '| 1 | List fired/resolved events for the object\'s rules, newest-first | one row per alert instance |\n' +
      '| 2 | Timestamp of each event (fired / last modified / resolved) | `essentials.startDateTime` |\n' +
      '| 3 | State badge — Fired vs Resolved | `essentials.monitorCondition` |',
  };
  const coverageExcerpt: RetrievedExcerpt = {
    path: 'docs/fiab/parity/activator-run-history.md',
    heading: `${ACTIVATOR_TITLE} › Loom coverage`,
    content:
      '| 1 | Fired/resolved list newest-first | ✅ | `ActivatorEditor` → Run history tab; ' +
      '`getActivatorHistory()` merges per-rule + sorts desc |\n' +
      '| 3 | Fired/Resolved badge | ✅ | Fluent `Badge` (danger / success) |',
  };

  it('classifies inventory vs Loom-coverage vs plain-docs sections off the #2969 breadcrumb', () => {
    expect(classifyExcerptProvenance(inventoryExcerpt)).toBe('other-product');
    expect(classifyExcerptProvenance(coverageExcerpt)).toBe('loom');
    expect(
      classifyExcerptProvenance({ path: 'docs/fiab/parity/data-agent.md', heading: 'x › Build plan (prioritized)' }),
    ).toBe('loom-plan');
    // A heading naming BOTH halves is mixed, never silently "other product".
    expect(
      classifyExcerptProvenance({ path: 'docs/fiab/parity/lakehouse.md', heading: 'x › Feature inventory → Loom coverage' }),
    ).toBe('mixed');
    // Ordinary Loom docs are untouched by the rule.
    expect(classifyExcerptProvenance({ path: 'docs/fiab/copilot-quality-triage.md', heading: 'x › §2.5' })).toBe('general');
  });

  it('DOES NOT guess a role for an unlabelled H3 inside a comparison doc', () => {
    // The measured limit (see evaluator-core's section header): the breadcrumb
    // is `title › INNERMOST heading`, so `### A. Data sources` under
    // `## Real feature inventory` — the actual data-agent-013 chunk — carries no
    // inventory label. ~459 such H3s exist and they split roughly evenly
    // between inventory-side and Loom-side parents, so guessing would mislabel
    // about one in six. It must stay 'unlabelled' (disclosed to the judge,
    // never deterministically hard-failed).
    expect(
      classifyExcerptProvenance({
        path: 'docs/fiab/parity/data-agent.md',
        heading:
          'data-agent — parity with Microsoft Fabric Data Agent (NL-to-query AI data agent) › A. Data sources (left "explorer" rail)',
      }),
    ).toBe('unlabelled');
  });

  it('the breadcrumbs these fixtures assert are the ones the shipped corpus actually produces', () => {
    // Guards the fixtures against drift in either direction: if docs-chunker
    // changes its breadcrumb shape, or the doc is retitled, this fails rather
    // than letting the classifier keep agreeing with a stale fixture.
    const repo = path.resolve(__dirname, '..', '..', '..');
    const doc = path.join(repo, 'docs', 'fiab', 'parity', 'activator-run-history.md');
    if (!fs.existsSync(doc)) return; // corpus not staged in this checkout
    const text = fs.readFileSync(doc, 'utf-8');
    const title = text.split(/\r?\n/).find((l) => /^# /.test(l))!.replace(/^#\s+/, '').trim();
    expect(title).toBe(ACTIVATOR_TITLE);
    expect(text).toContain('## Azure/Fabric feature inventory (run history surface)');
    expect(text).toContain('## Loom coverage');
  });

  // ── MUTATION PROOF, both directions ────────────────────────────────────────
  it('FAILS an answer that reports a labelled Fabric-inventory row as a CSA Loom fact', () => {
    // The inversion: a span that exists ONLY in the inventory excerpt, restated
    // as Loom's own behaviour, with the other product never named.
    const inverted =
      'Yes. Loom will list fired/resolved events for the object\'s rules, newest-first, ' +
      'with a timestamp of each event (fired / last modified / resolved).';
    const d = detectParityInversion({ answer: inverted, excerpts: [inventoryExcerpt, coverageExcerpt] });
    expect(d.hit).toBe(true);
    expect(d.borrowed.length).toBeGreaterThanOrEqual(2);
    // …and the verdict actually flips. Grounding is a perfect 5 — the sentence
    // IS in the retrieved context — which is precisely why grounding alone
    // passed this answer before.
    const scored = {
      retrievalHit: true,
      mentionPass: true,
      forbiddenHit: false,
      parityInversionHit: d.hit,
      judgeStatus: 'scored' as const,
      judge: { grounding: 5, relevance: 5, completeness: 5, rationale: 'fully supported by the excerpt' },
    };
    expect(computePass(scored)).toBe(false);
    expect(computePass({ ...scored, parityInversionHit: false })).toBe(true); // the ONLY thing that changed
  });

  it('PASSES a legitimate Loom-coverage citation, and an attributed Fabric mention', () => {
    const legitimate =
      'Loom shows the fired/resolved list newest-first in the ActivatorEditor Run history tab; ' +
      '`getActivatorHistory()` merges per-rule and sorts desc, with a Fluent `Badge` for Fired/Resolved.';
    const legit = detectParityInversion({ answer: legitimate, excerpts: [inventoryExcerpt, coverageExcerpt] });
    expect(legit.hit).toBe(false);
    expect(
      computePass({
        retrievalHit: true, mentionPass: true, forbiddenHit: false,
        parityInversionHit: legit.hit, judgeStatus: 'scored',
        judge: { grounding: 5, relevance: 5, completeness: 5, productFidelity: 5, rationale: '' },
      }),
    ).toBe(true);

    // docs-grounding rule 2: describing the OTHER product AS the other product
    // is correct, not an inversion. Naming it is attribution.
    const attributed = detectParityInversion({
      answer:
        'Fabric Activator will list fired/resolved events for the object\'s rules, newest-first, ' +
        'with a timestamp of each event (fired / last modified / resolved); Loom does the same over Azure Monitor.',
      excerpts: [inventoryExcerpt, coverageExcerpt],
    });
    expect(attributed.attributed).toBe(true);
    expect(attributed.hit).toBe(false);
  });

  it('never fires when no labelled other-product excerpt was retrieved', () => {
    expect(
      detectParityInversion({
        answer: 'Loom stores lakehouse tables as Delta on ADLS Gen2.',
        excerpts: [{ path: 'docs/fiab/lakehouse.md', heading: 'Lakehouse › Storage', content: 'Delta on ADLS Gen2.' }],
      }).hit,
    ).toBe(false);
  });

  it('labels every excerpt with its product provenance in the judge prompt', () => {
    const msgs = buildJudgeMessages(row, 'candidate', [inventoryExcerpt, coverageExcerpt]);
    expect(msgs[0].content).toContain('productFidelity');
    expect(msgs[0].content).toContain('INDEPENDENT of grounding');
    // The path + breadcrumb reach the judge at all — the regression that was
    // the whole bug (probeConsole flattened excerpts to bare `preview` text).
    expect(msgs[1].content).toContain('docs/fiab/parity/activator-run-history.md');
    expect(msgs[1].content).toContain('Azure/Fabric feature inventory (run history surface)');
    expect(msgs[1].content).toContain('OTHER PRODUCT');
    expect(msgs[1].content).toContain('CSA LOOM — authoritative');
  });

  it('productFidelity: parsed when returned, absent when not, and blocks a pass below 4', () => {
    expect(
      parseJudge('{"grounding":5,"relevance":5,"completeness":5,"productFidelity":1,"rationale":"reports Fabric as Loom"}'),
    ).toMatchObject({ grounding: 5, productFidelity: 1 });
    // A judge deployment that ignores the new field must NOT null out the whole
    // question — that would make groundingAvg null, which E3 reads as
    // no-change, and the gate would go green having measured nothing.
    const legacy = parseJudge('{"grounding":4,"relevance":4,"completeness":4,"rationale":"ok"}');
    expect(legacy).not.toBeNull();
    expect(legacy!.productFidelity).toBeUndefined();

    const base = {
      retrievalHit: true, mentionPass: true, forbiddenHit: false, judgeStatus: 'scored' as const,
    };
    expect(computePass({ ...base, judge: { grounding: 5, relevance: 5, completeness: 5, productFidelity: 5, rationale: '' } })).toBe(true);
    expect(computePass({ ...base, judge: { grounding: 5, relevance: 5, completeness: 5, productFidelity: 3, rationale: '' } })).toBe(false);
    // absent → grounding-only verdict, never an implied 5
    expect(computePass({ ...base, judge: { grounding: 5, relevance: 5, completeness: 5, rationale: '' } })).toBe(true);
  });

  it('rollup reports the fidelity channel as NOT MEASURED rather than implying coverage', () => {
    const mk = (id: string, judge: any, extra: Partial<EvalResult> = {}): EvalResult => ({
      questionId: id, surface: 'data-agent', retrievalHit: true, mrr: 1, mentionPass: true,
      forbiddenHit: false, judgeStatus: 'scored', judge, pass: true, latencyMs: 10, ...extra,
    });
    const noFidelity = rollupRun([
      mk('a', { grounding: 5, relevance: 5, completeness: 5, rationale: '' }),
      mk('b', { grounding: 4, relevance: 4, completeness: 4, rationale: '' }),
    ]);
    expect(noFidelity.judged).toBe(2);
    expect(noFidelity.productFidelityJudged).toBe(0);
    expect(noFidelity.productFidelityAvg).toBeNull(); // "not measured", not 5
    expect(noFidelity.parityInversions).toBe(0);

    const withFidelity = rollupRun([
      mk('a', { grounding: 5, relevance: 5, completeness: 5, productFidelity: 5, rationale: '' }),
      mk('b', { grounding: 5, relevance: 5, completeness: 5, productFidelity: 1, rationale: '' }, { pass: false }),
      mk('c', { grounding: 5, relevance: 5, completeness: 5, rationale: '' }, { pass: false, parityInversionHit: true }),
    ]);
    expect(withFidelity.productFidelityJudged).toBe(2);
    expect(withFidelity.productFidelityAvg).toBe(3); // (5 + 1) / 2 — the un-returned one is NOT averaged in
    expect(withFidelity.parityInversions).toBe(1);
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

  /**
   * Issue #2992 — `passRate` was emitted under one name for two different
   * quantities. When the judge deferred on every question, `computePass` fell
   * back to the deterministic verdict and the resulting (necessarily HIGHER)
   * rate went out as `passRate`, where a CI gate subtracted it from a judged
   * baseline and reported the difference as `+20`.
   *
   * The rollup now REFUSES to publish that number under the judged name.
   */
  describe('#2992 — the pass predicate is declared, and a degraded rate is renamed', () => {
    const judged = { ...base };
    const deferred: EvalResult = { ...base, judgeStatus: 'deferred', judge: undefined };

    it('emits NO passRate when the judge scored no row — the value is deterministicPassRate', () => {
      const t = rollupRun([deferred, { ...deferred, questionId: 'q2' }]);
      expect(t.groundingAvg).toBeNull();
      expect(t.passRate).toBeNull();          // ← the defect: this used to be 1.0
      expect(t.deterministicPassRate).toBe(1);
      expect(t.passPredicate).toMatchObject({ id: 'deterministic', degraded: true });
    });

    it('emits passRate (and no deterministicPassRate) on a judged run', () => {
      const t = rollupRun([judged, { ...judged, questionId: 'q2' }]);
      expect(t.passRate).toBe(1);
      expect(t.deterministicPassRate).toBeUndefined();
      expect(t.passPredicate).toMatchObject({ id: 'deterministic+grounding', degraded: false });
    });

    it('records the productFidelity conjunct only when the judge returned it (#2979)', () => {
      const withFid: EvalResult = {
        ...base,
        judge: { grounding: 5, relevance: 5, completeness: 5, productFidelity: 5, rationale: '' },
      };
      expect(passPredicateFor([withFid]).id).toBe('deterministic+grounding+productFidelity');
      expect(passPredicateFor([judged]).id).toBe('deterministic+grounding');
    });

    it('measures judge coverage over the JUDGEABLE set (auto-fails spend no judge call)', () => {
      const autoFail: EvalResult = { ...base, judgeStatus: 'auto-fail', judge: undefined, forbiddenHit: true, pass: false };
      // 2 judged + 2 auto-failed = full coverage of what could be judged
      expect(passPredicateFor([judged, { ...judged, questionId: 'q2' }, autoFail, { ...autoFail, questionId: 'q4' }]).judgeCoverage).toBe(1);
      // 1 judged of 2 judgeable = half
      expect(passPredicateFor([judged, deferred]).judgeCoverage).toBe(0.5);
    });

    it('an errored judge degrades exactly like a deferred one', () => {
      const errored: EvalResult = { ...base, judgeStatus: 'error', judge: undefined };
      const t = rollupRun([errored]);
      expect(t.passRate).toBeNull();
      expect(t.passPredicate?.degraded).toBe(true);
    });
  });

  // Catches the #2798 observability gap, the same shape as #2585's `backends`
  // below: rows whose eval-probe call failed were dropped silently, so a
  // surface whose EVERY probe failed rolled up as `questions: 0,
  // retrievalHitRate: 0` — a hard zero indistinguishable from "retrieval found
  // nothing", which is exactly how it was triaged. The rollup must carry what
  // it FAILED to measure, not just what it measured.
  it('carries rowsAttempted + probeErrors so a not-measured run cannot pose as a 0.00', () => {
    const t = rollupRun([], { attempted: 15, errors: { 429: 14, 0: 1 } });
    expect(t.questions).toBe(0);
    expect(t.rowsAttempted).toBe(15);
    expect(t.probeErrors).toEqual({ 429: 14, 0: 1 });
  });
  it('reports probe failures on a PARTIALLY measured run too', () => {
    const t = rollupRun([{ ...base, questionId: 'q1' }], { attempted: 15, errors: { 429: 14 } });
    expect(t.questions).toBe(1);
    expect(t.rowsAttempted).toBe(15);
    expect(t.probeErrors).toEqual({ 429: 14 });
  });
  it('omits both fields when no probe info is supplied (legacy shape preserved)', () => {
    const t = rollupRun([{ ...base }]);
    expect(t).not.toHaveProperty('rowsAttempted');
    expect(t).not.toHaveProperty('probeErrors');
    // a clean run reports rowsAttempted but no error map
    expect(rollupRun([{ ...base }], { attempted: 1, errors: {} })).not.toHaveProperty('probeErrors');
  });

  // Catches the #2585 observability gap: `backend` was recorded on every
  // per-question doc but never rolled up, so the CI receipt could not say which
  // retrieval backend served a run and the triage had to infer it. A rollup
  // that drops the field passes every other assertion here and fails this one.
  it('counts which retrieval backend served the run', () => {
    expect(rollupBackends([
      { backend: 'ai-search' }, { backend: 'ai-search' }, { backend: 'cosmos' },
      { backend: undefined }, { backend: '  ' },
    ])).toEqual({ 'ai-search': 2, cosmos: 1 });
    expect(rollupBackends([])).toEqual({});
    expect(rollupRun([
      { ...base, backend: 'cosmos' },
      { ...base, questionId: 'q2', backend: 'cosmos' },
    ]).backends).toEqual({ cosmos: 2 });
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

// ── E6 — tier-router decision evals ──────────────────────────────────────────

describe('loadTierLabels', () => {
  it('loads _tier-labels.jsonl and validates the enums', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-'));
    fs.writeFileSync(
      path.join(root, '_tier-labels.jsonl'),
      `${JSON.stringify({ id: 'tier-001', prompt: 'What is a lakehouse?', expectedTier: 'mini', taskClass: 'lightweight' })}\n` +
        `${JSON.stringify({ id: 'tier-002', prompt: 'Design a medallion architecture.', expectedTier: 'strong', taskClass: 'reasoning' })}\n`,
    );
    const set = loadTierLabels(root);
    expect(set.rows).toHaveLength(2);
    expect(set.rows[0]).toMatchObject({ id: 'tier-001', expectedTier: 'mini', taskClass: 'lightweight' });
  });
  it('returns no rows for a missing file', () => {
    expect(loadTierLabels(fs.mkdtempSync(path.join(os.tmpdir(), 'tier-'))).rows).toEqual([]);
  });
  it('throws on invalid JSON', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-'));
    fs.writeFileSync(path.join(root, '_tier-labels.jsonl'), 'not json\n');
    expect(() => loadTierLabels(root)).toThrow(/_tier-labels\.jsonl:1/);
  });
  it('throws on an invalid tier / task-class enum', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-'));
    fs.writeFileSync(path.join(root, '_tier-labels.jsonl'),
      `${JSON.stringify({ id: 'x', prompt: 'p', expectedTier: 'gigantic', taskClass: 'reasoning' })}\n`);
    expect(() => loadTierLabels(root)).toThrow(/invalid expectedTier/);
    fs.writeFileSync(path.join(root, '_tier-labels.jsonl'),
      `${JSON.stringify({ id: 'x', prompt: 'p', expectedTier: 'mini', taskClass: 'trivial' })}\n`);
    expect(() => loadTierLabels(root)).toThrow(/invalid taskClass/);
  });
});

describe('routeTierForPrompt (REAL routeTurnTier, all tiers wired)', () => {
  it('routes a short lookup to mini', () => {
    const s = routeTierForPrompt('What is a lakehouse in CSA Loom?');
    expect(s.tier).toBe('mini');
    expect(s.taskClass).toBe('lightweight');
  });
  it('routes a plain build request to standard', () => {
    const s = routeTierForPrompt('Create a new dashboard for the sales team.');
    expect(s.tier).toBe('standard');
    expect(s.taskClass).toBe('general');
  });
  it('routes a reasoning/analysis prompt to strong', () => {
    expect(routeTierForPrompt('Why is my Spark pool failing to start?').tier).toBe('strong');
    expect(routeTierForPrompt('Design a medallion lakehouse architecture.').tier).toBe('strong');
    expect(routeTierForPrompt('Write the SQL: SELECT id FROM sales.').tier).toBe('strong');
  });
  it('agrees with the golden label set at or above the 0.85 floor', () => {
    // Resolve the repo checkout content/evals (the loader walks up from cwd).
    const root = resolveEvalRoot(process.cwd());
    expect(root).not.toBeNull();
    const set = loadTierLabels(root!);
    expect(set.rows.length).toBeGreaterThanOrEqual(60);
    const scores = set.rows.map((r) => scoreTierDecision(r, routeTierForPrompt(r.prompt)));
    const acc = scores.filter((s) => s.correct).length / scores.length;
    expect(acc).toBeGreaterThanOrEqual(0.85);
  });
});

describe('scoreTierDecision (pure comparator)', () => {
  const row: TierLabelRow = { id: 'tier-001', prompt: 'p', expectedTier: 'mini', taskClass: 'lightweight' };
  const sel = (o: Partial<TierSelection>): TierSelection => ({ tier: 'mini', taskClass: 'lightweight', routed: false, ...o });
  it('marks a matching tier correct + carries both classes', () => {
    const s = scoreTierDecision(row, sel({}));
    expect(s).toMatchObject({ correct: true, chosenTier: 'mini', expectedTier: 'mini', taskClass: 'lightweight', chosenTaskClass: 'lightweight', taskClassCorrect: true });
  });
  it('marks a mismatched tier incorrect', () => {
    const s = scoreTierDecision(row, sel({ tier: 'strong', taskClass: 'reasoning' }));
    expect(s.correct).toBe(false);
    expect(s.taskClassCorrect).toBe(false);
    expect(s.chosenTier).toBe('strong');
  });
});

describe('reduceTierConfusion', () => {
  const mk = (o: Partial<TierDecisionScore>): TierDecisionScore => ({
    correct: true, chosenTier: 'mini', expectedTier: 'mini', taskClass: 'lightweight', chosenTaskClass: 'lightweight', taskClassCorrect: true, ...o,
  });
  it('builds the confusion matrix + accuracy + per-class stats', () => {
    const t = reduceTierConfusion([
      mk({}),
      mk({ correct: false, chosenTier: 'standard', expectedTier: 'mini', taskClass: 'lightweight', chosenTaskClass: 'general', taskClassCorrect: false }),
      mk({ chosenTier: 'strong', expectedTier: 'strong', taskClass: 'reasoning', chosenTaskClass: 'reasoning' }),
    ]);
    expect(t.rows).toBe(3);
    expect(t.tierAccuracy).toBeCloseTo(0.667, 2);
    expect(t.taskClassAccuracy).toBeCloseTo(0.667, 2);
    expect(t.matrix.mini.mini).toBe(1);
    expect(t.matrix.mini.standard).toBe(1);
    expect(t.matrix.strong.strong).toBe(1);
    expect(t.perClass.lightweight).toMatchObject({ total: 2, correct: 1, accuracy: 0.5 });
    expect(t.perClass.reasoning).toMatchObject({ total: 1, correct: 1, accuracy: 1 });
  });
  it('empty → zeroed accuracy with a fully-zeroed matrix', () => {
    const t = reduceTierConfusion([]);
    expect(t).toMatchObject({ rows: 0, tierAccuracy: 0, taskClassAccuracy: 0 });
    expect(t.matrix.mini.strong).toBe(0);
    expect(t.perClass.general.total).toBe(0);
  });
});
