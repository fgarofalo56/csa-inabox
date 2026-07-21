import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveFineTuneBackend,
  fineTuneConfigGate,
  validateTrainingData,
  shapeFineTuningJobView,
  safetyEvalDecision,
  MIN_TRAINING_ROWS,
} from '../fine-tuning-client';
import type { RedTeamSummary } from '@/lib/foundry/red-team';

/**
 * WS-1.3 — fine-tuning-client pure-logic tests: backend selection default
 * (Azure-native AOAI), the honest config gate, the training-data-eval gate, the
 * FT job view shaping, and the resulting-model safety-eval decision. No network —
 * every function under test is pure or env-only.
 */

describe('fine-tuning-client — backend selection', () => {
  const prev = process.env.LOOM_FINETUNE_BACKEND;
  afterEach(() => {
    if (prev === undefined) delete process.env.LOOM_FINETUNE_BACKEND;
    else process.env.LOOM_FINETUNE_BACKEND = prev;
  });

  it('defaults to the Azure-native AOAI backend when unset (no Fabric)', () => {
    delete process.env.LOOM_FINETUNE_BACKEND;
    expect(resolveFineTuneBackend()).toBe('aoai');
  });

  it('selects Databricks only on the explicit opt-in value', () => {
    process.env.LOOM_FINETUNE_BACKEND = 'databricks';
    expect(resolveFineTuneBackend()).toBe('databricks');
    process.env.LOOM_FINETUNE_BACKEND = 'fabric';
    expect(resolveFineTuneBackend()).toBe('aoai'); // any other value → Azure-native default
  });
});

describe('fine-tuning-client — honest config gate', () => {
  const prevBackend = process.env.LOOM_FINETUNE_BACKEND;
  const prevHost = process.env.LOOM_DATABRICKS_HOSTNAME;
  afterEach(() => {
    if (prevBackend === undefined) delete process.env.LOOM_FINETUNE_BACKEND; else process.env.LOOM_FINETUNE_BACKEND = prevBackend;
    if (prevHost === undefined) delete process.env.LOOM_DATABRICKS_HOSTNAME; else process.env.LOOM_DATABRICKS_HOSTNAME = prevHost;
  });

  it('AOAI default returns null (addressability resolved by the real call)', () => {
    delete process.env.LOOM_FINETUNE_BACKEND;
    expect(fineTuneConfigGate()).toBeNull();
  });

  it('Databricks opt-in without a hostname gates on LOOM_DATABRICKS_HOSTNAME', () => {
    process.env.LOOM_FINETUNE_BACKEND = 'databricks';
    delete process.env.LOOM_DATABRICKS_HOSTNAME;
    const g = fineTuneConfigGate();
    expect(g?.backend).toBe('databricks');
    expect(g?.fixEnvVar).toBe('LOOM_DATABRICKS_HOSTNAME');
    expect(g?.gateId).toBe('svc-fine-tuning');
  });

  it('Databricks opt-in WITH a hostname still gates (Mosaic FT is not wired) → unset to use AOAI', () => {
    process.env.LOOM_FINETUNE_BACKEND = 'databricks';
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-123.azuredatabricks.net';
    const g = fineTuneConfigGate();
    expect(g?.fixEnvVar).toBe('LOOM_FINETUNE_BACKEND');
    expect(g?.hint).toMatch(/not available/i);
  });
});

describe('fine-tuning-client — training-data-eval gate', () => {
  const row = (assistant = true) =>
    JSON.stringify({
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'hi' },
        ...(assistant ? [{ role: 'assistant', content: 'hello' }] : []),
      ],
    });

  it('accepts a well-formed JSONL dataset with ≥ the minimum rows', () => {
    const data = Array.from({ length: MIN_TRAINING_ROWS }, () => row()).join('\n');
    const ev = validateTrainingData(data);
    expect(ev.ok).toBe(true);
    expect(ev.rows).toBe(MIN_TRAINING_ROWS);
    expect(ev.errors).toHaveLength(0);
  });

  it('rejects an empty dataset', () => {
    expect(validateTrainingData('   ').ok).toBe(false);
  });

  it('rejects too few valid rows with an actionable error', () => {
    const ev = validateTrainingData([row(), row()].join('\n'));
    expect(ev.ok).toBe(false);
    expect(ev.errors.join(' ')).toMatch(new RegExp(`at least ${MIN_TRAINING_ROWS}`));
  });

  it('flags invalid JSON, a missing assistant turn, and empty content', () => {
    const bad = [
      '{ not json',
      JSON.stringify({ messages: [{ role: 'user', content: 'q' }, { role: 'user', content: 'again' }] }), // no assistant
      JSON.stringify({ messages: [{ role: 'user', content: '' }, { role: 'assistant', content: 'a' }] }), // empty user
    ].join('\n');
    const ev = validateTrainingData(bad);
    expect(ev.ok).toBe(false);
    expect(ev.rows).toBe(0);
    expect(ev.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('warns on a small (but valid) dataset', () => {
    const data = Array.from({ length: MIN_TRAINING_ROWS }, () => row()).join('\n');
    expect(validateTrainingData(data).warnings.length).toBeGreaterThan(0);
  });
});

describe('fine-tuning-client — FT job view shaping', () => {
  it('marks a succeeded job with a fine-tuned model as terminal + deployable', () => {
    const v = shapeFineTuningJobView({
      id: 'ftjob-1', status: 'succeeded', model: 'gpt-4o-mini',
      fineTunedModel: 'gpt-4o-mini.ft-abc', trainedTokens: 12345,
    } as any);
    expect(v.succeeded).toBe(true);
    expect(v.terminal).toBe(true);
    expect(v.hasModel).toBe(true);
    expect(v.fineTunedModel).toBe('gpt-4o-mini.ft-abc');
  });

  it('marks a running job as non-terminal with no model', () => {
    const v = shapeFineTuningJobView({ id: 'ftjob-2', status: 'running', model: 'gpt-4o-mini', fineTunedModel: null } as any);
    expect(v.terminal).toBe(false);
    expect(v.hasModel).toBe(false);
  });

  it('treats failed/cancelled as terminal but not succeeded', () => {
    expect(shapeFineTuningJobView({ id: 'a', status: 'failed' } as any).terminal).toBe(true);
    expect(shapeFineTuningJobView({ id: 'b', status: 'cancelled' } as any).succeeded).toBe(false);
  });
});

describe('fine-tuning-client — resulting-model safety-eval decision', () => {
  const summary = (over: Partial<RedTeamSummary>): RedTeamSummary => ({
    total: 8, refused: 8, partial: 0, unsafe: 0, refusalRate: 100, attackSuccessRate: 0, byCategory: {}, ...over,
  });

  it('passes when refusal grade is A/B and no harmful completions', () => {
    const d = safetyEvalDecision(summary({}), { contentSafetyConfigured: true });
    expect(d.passed).toBe(true);
    expect(d.grade).toBe('A');
  });

  it('blocks when a completion was flagged harmful even at a high refusal rate', () => {
    const d = safetyEvalDecision(summary({ unsafe: 1, refused: 7, refusalRate: 100 }), { contentSafetyConfigured: true });
    expect(d.passed).toBe(false);
    expect(d.reason).toMatch(/harmful/i);
  });

  it('blocks when the refusal rate is below the A/B bar', () => {
    const d = safetyEvalDecision(summary({ refused: 4, partial: 4, refusalRate: 50, attackSuccessRate: 50 }), { contentSafetyConfigured: true });
    expect(d.passed).toBe(false);
    expect(d.grade).toBe('F');
  });

  it('notes when Content Safety was not configured', () => {
    const d = safetyEvalDecision(summary({}), { contentSafetyConfigured: false });
    expect(d.reason).toMatch(/Content Safety is not configured/i);
  });
});
