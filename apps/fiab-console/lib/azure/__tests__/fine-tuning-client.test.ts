import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * #3562 — "Load failed — API version not supported" on every open of a
 * fine-tuning job.
 *
 * Live repro (2026-08-15 V&V sprint, item `vnv-finetune-01`): the Overview tab —
 * the FIRST thing a user sees — reported a backend failure on the Azure-native
 * DEFAULT path, persisting across Reload. The transport lives one module over in
 * `foundry-cs-client.ts`, which is what this block reads.
 *
 * THE INVARIANT IS ROUTE ↔ VERSION, NOT A SPELLING. `/openai/v1/...` is the
 * Foundry Models v1 API surface and its `api-version` accepts exactly `v1` or
 * `preview`; a DATED value is rejected. Grounded in Learn:
 *   learn.microsoft.com/rest/api/microsoft-foundry/azureopenai/fine-tuning
 *     "api-version | query | No | string. Possible values: `v1`, `preview`"
 *   learn.microsoft.com/azure/ai-foundry/openai/reference-preview-latest
 *     "GET {endpoint}/openai/v1/fine_tuning/jobs?api-version=preview"
 * The legacy `/openai/...` routes (no `/v1`) DO take a dated version, which is
 * why `/openai/batches` keeps one — so the assertion is scoped to the route, not
 * applied to the file.
 *
 * WHY THIS IS A SOURCE-SHAPE ASSERTION, STATED RATHER THAN DRESSED UP. It reads
 * `foundry-cs-client.ts` and checks which constant each `/openai/v1` URL builder
 * interpolates. It is NOT an in-browser or live-Azure receipt: no request was
 * issued against a real AOAI account in this change, and the live surface is
 * therefore UNVERIFIED here. What it does prove is that the defect's exact
 * shape — a dated version on the v1 route — cannot come back silently, and it
 * covers the whole CLASS (evals, files, fine-tuning), not just the one constant
 * that was wrong.
 */
describe('#3562 — every /openai/v1 call site pairs with a v1-surface api-version', () => {
  const SRC_PATH = join(__dirname, '..', 'foundry-cs-client.ts');
  const src = readFileSync(SRC_PATH, 'utf8').replace(/\r\n/g, '\n');

  /** `const NAME = process.env.X || 'value';` → NAME → value. */
  function apiVersionDefaults(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    const re = /^const (AOAI_\w+_API|CS_API) = (?:process\.env\.\w+ \|\| )?'([^']+)';$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out[m[1]!] = m[2]!;
    return out;
  }

  /** Every `${endpoint}/openai/…?api-version=${CONST}` builder, as (route, const). */
  function callSites(text: string): Array<{ route: string; constName: string }> {
    const out: Array<{ route: string; constName: string }> = [];
    const re = /\$\{endpoint\}(\/openai\/[^`]*?)api-version=\$\{(\w+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push({ route: m[1]!, constName: m[2]! });
    return out;
  }

  const DATED = /^\d{4}-\d{2}-\d{2}/;

  it('POPULATION: the source was read and both parsers found real subjects', () => {
    // A parser that matched nothing would make every assertion below vacuously
    // true — the exact "green over an empty set" this repo keeps rediscovering.
    expect(src.length).toBeGreaterThan(1000);
    const versions = apiVersionDefaults(src);
    expect(Object.keys(versions)).toEqual(
      expect.arrayContaining(['AOAI_EVALS_API', 'AOAI_FT_API', 'AOAI_BATCH_API']),
    );
    const sites = callSites(src);
    expect(sites.length).toBeGreaterThanOrEqual(4);
    // The specific builder the issue is about is in the population, by route.
    expect(sites.some((s) => s.route.startsWith('/openai/v1') && s.constName === 'AOAI_FT_API')).toBe(true);
  });

  it('CONTROL: the dated-version matcher fires, so a clean result is not a broken regex', () => {
    expect(DATED.test('2025-04-01-preview')).toBe(true); // the value that broke it
    expect(DATED.test('2024-10-01')).toBe(true);
    expect(DATED.test('preview')).toBe(false);
    expect(DATED.test('v1')).toBe(false);
  });

  it('no /openai/v1 builder uses a DATED api-version', () => {
    const versions = apiVersionDefaults(src);
    const offenders = callSites(src)
      .filter((s) => s.route.startsWith('/openai/v1'))
      .filter((s) => DATED.test(versions[s.constName] ?? ''))
      .map((s) => `${s.route} uses ${s.constName}='${versions[s.constName]}'`);
    expect(offenders).toEqual([]);
  });

  it("the fine-tuning default is a v1-surface value, and it is still overridable", () => {
    const versions = apiVersionDefaults(src);
    expect(['preview', 'v1']).toContain(versions.AOAI_FT_API);
    // The override must survive: `preview` moves under Microsoft and an operator
    // pinning `v1` must not need this file redeployed.
    expect(src).toContain('process.env.LOOM_AOAI_FT_API_VERSION');
  });

  it('the LEGACY /openai routes keep their dated version — the fix is scoped, not blanket', () => {
    // The other direction. A "just make everything preview" edit would break the
    // batches surface, which has no `/v1` segment and does take a dated version.
    const versions = apiVersionDefaults(src);
    const batches = callSites(src).find((s) => s.route.startsWith('/openai/batches'));
    expect(batches, 'the batches builder is gone; this assertion is looking at nothing').toBeTruthy();
    expect(DATED.test(versions[batches!.constName] ?? '')).toBe(true);
  });
});
