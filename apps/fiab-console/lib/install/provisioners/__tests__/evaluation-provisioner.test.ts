/**
 * evaluation provisioner — the judge model is RESOLVED, not requested (#3508).
 *
 * THE DEFECT. `LOOM_FOUNDRY_EVAL_DEPLOYMENT` was one of three hard gates on
 * install. No bicep module in this repo sets it — `git grep
 * LOOM_FOUNDRY_EVAL_DEPLOYMENT -- platform/fiab/bicep` returns zero hits — so on
 * every estate the platform builds, that condition fired and the remediation
 * asked the customer to go set a value by hand. Admin-plane bicep meanwhile
 * wires `LOOM_AOAI_DEPLOYMENT` (main.bicep:5892) from the Foundry account's
 * default chat deployment, and `tierPolicyFromConfig()`'s `standard` tier
 * already resolves exactly that chain for every other AI surface in Loom.
 * auto-bind-by-default.md §5: a gate over a value the deploy could have
 * supplied is a DEFECT, not an honest state.
 *
 * WHAT THESE TESTS ARE FOR, AND WHAT THEY ARE NOT. They pin the RESOLUTION, not
 * a live Foundry call — `createEvaluation` is mocked, because a unit test cannot
 * reach the AML data plane. Per ux-baseline.md G1 that means these are NOT a
 * completion receipt for the item; a live in-browser install against real
 * Foundry is. What they do prove is that the gate no longer fires on a
 * correctly-deployed estate, which is the thing that was wrong.
 *
 * MUTATION-PROVEN: delete the standard-tier fallback in `resolveJudgeDeployment`
 * (i.e. restore `process.env.LOOM_FOUNDRY_EVAL_DEPLOYMENT` alone) and the
 * "installs with only LOOM_AOAI_DEPLOYMENT set" test goes RED.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const createEvaluation = vi.fn();
vi.mock('@/lib/azure/foundry-client', () => ({
  createEvaluation: (...args: unknown[]) => createEvaluation(...args),
  // The provisioner does `e instanceof FoundryError`, so this must be a real class.
  FoundryError: class FoundryError extends Error {
    status: number;
    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  },
}));

import { evaluationProvisioner, resolveJudgeDeployment } from '../evaluation';

const CONTENT = {
  kind: 'evaluation',
  metrics: [{ name: 'groundedness' }, { name: 'answer_relevance' }],
};

/** The env vars this provisioner reads. Cleared per test so nothing leaks in. */
const KEYS = [
  'LOOM_FOUNDRY_PROJECT',
  'LOOM_FOUNDRY_EVAL_DATASET',
  'LOOM_FOUNDRY_EVAL_DEPLOYMENT',
  'LOOM_AOAI_DEPLOYMENT',
  'LOOM_AOAI_CHAT_DEPLOYMENT',
  'LOOM_MODEL_TIER_ROUTING_ENABLED',
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  createEvaluation.mockReset();
  createEvaluation.mockResolvedValue({ id: 'eval-run-1' });
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const run = () =>
  evaluationProvisioner({ displayName: 'RAG Quality', content: CONTENT } as never);

describe('resolveJudgeDeployment (#3508)', () => {
  it('prefers the explicit eval override when it is set', () => {
    process.env.LOOM_FOUNDRY_EVAL_DEPLOYMENT = 'gpt-4o-judge';
    process.env.LOOM_AOAI_DEPLOYMENT = 'gpt-4o-chat';
    const r = resolveJudgeDeployment();
    expect(r.deployment).toBe('gpt-4o-judge');
    expect(r.source).toBe('LOOM_FOUNDRY_EVAL_DEPLOYMENT');
  });

  it('falls back to the platform standard tier — the var admin-plane bicep ACTUALLY wires', () => {
    process.env.LOOM_AOAI_DEPLOYMENT = 'gpt-4o-chat';
    const r = resolveJudgeDeployment();
    expect(r.deployment).toBe('gpt-4o-chat');
    expect(r.source).toMatch(/LOOM_AOAI_DEPLOYMENT/);
  });

  it('falls further to LOOM_AOAI_CHAT_DEPLOYMENT, matching tierPolicyFromConfig', () => {
    process.env.LOOM_AOAI_CHAT_DEPLOYMENT = 'gpt-4o-legacy';
    const r = resolveJudgeDeployment();
    expect(r.deployment).toBe('gpt-4o-legacy');
    expect(r.source).toMatch(/LOOM_AOAI_CHAT_DEPLOYMENT/);
  });

  it('ignores whitespace-only values rather than binding to a blank deployment name', () => {
    process.env.LOOM_FOUNDRY_EVAL_DEPLOYMENT = '   ';
    process.env.LOOM_AOAI_DEPLOYMENT = 'gpt-4o-chat';
    expect(resolveJudgeDeployment().deployment).toBe('gpt-4o-chat');
  });

  it('resolves NOTHING when the estate has no chat deployment at all — a real infra gap', () => {
    const r = resolveJudgeDeployment();
    expect(r.deployment).toBeUndefined();
    expect(r.source).toBeNull();
  });

  it('is NOT disabled by the model-tier routing kill switch', () => {
    // The kill switch turns off TIER ROUTING, not deployment resolution. If it
    // silenced this, the eval gate would come back on any estate that opted out.
    process.env.LOOM_MODEL_TIER_ROUTING_ENABLED = 'false';
    process.env.LOOM_AOAI_DEPLOYMENT = 'gpt-4o-chat';
    expect(resolveJudgeDeployment().deployment).toBe('gpt-4o-chat');
  });
});

describe('evaluationProvisioner install gate (#3508)', () => {
  it('installs with only LOOM_AOAI_DEPLOYMENT set — no deployment remediation', async () => {
    // THE REGRESSION TEST. On main this returned status:'remediation' naming
    // LOOM_FOUNDRY_EVAL_DEPLOYMENT, on an estate where bicep had wired
    // everything it wires.
    process.env.LOOM_FOUNDRY_PROJECT = 'proj-loom';
    process.env.LOOM_FOUNDRY_EVAL_DATASET = 'azureml://datasets/golden/versions/1';
    process.env.LOOM_AOAI_DEPLOYMENT = 'gpt-4o-chat';

    const r = await run();

    expect(r.status).toBe('created');
    expect(createEvaluation).toHaveBeenCalledTimes(1);
    expect(createEvaluation.mock.calls[0][1]).toMatchObject({ modelDeployment: 'gpt-4o-chat' });
    // The binding the platform made is INSPECTABLE, not guessed
    // (auto-bind-by-default.md §2).
    expect((r.steps ?? []).join(' ')).toMatch(/Judge: gpt-4o-chat \(from LOOM_AOAI_DEPLOYMENT/);
  });

  it('the override still wins when an admin sets a different judge', async () => {
    process.env.LOOM_FOUNDRY_PROJECT = 'proj-loom';
    process.env.LOOM_FOUNDRY_EVAL_DATASET = 'azureml://datasets/golden/versions/1';
    process.env.LOOM_AOAI_DEPLOYMENT = 'gpt-4o-chat';
    process.env.LOOM_FOUNDRY_EVAL_DEPLOYMENT = 'gpt-4o-judge';

    const r = await run();

    expect(r.status).toBe('created');
    expect(createEvaluation.mock.calls[0][1]).toMatchObject({ modelDeployment: 'gpt-4o-judge' });
  });

  it('no remediation text anywhere names LOOM_FOUNDRY_EVAL_DEPLOYMENT as a thing to set', async () => {
    // The two remaining gates are legitimate. Neither may re-introduce the
    // instruction this issue removed.
    process.env.LOOM_AOAI_DEPLOYMENT = 'gpt-4o-chat';
    const r = await run();
    expect(r.status).toBe('remediation');
    const text = `${r.gate!.reason} ${r.gate!.remediation}`;
    expect(text).toContain('LOOM_FOUNDRY_PROJECT');
    expect(text).toContain('LOOM_FOUNDRY_EVAL_DATASET');
    expect(text).not.toMatch(/Set the following env var\(s\)[^.]*LOOM_FOUNDRY_EVAL_DEPLOYMENT/);
  });

  it('still gates HONESTLY on the two the platform cannot supply', async () => {
    // POPULATION FLOOR for this suite: if the gate could never fire, every
    // assertion above would be green over a provisioner that gates on nothing.
    process.env.LOOM_AOAI_DEPLOYMENT = 'gpt-4o-chat';
    const r = await run();
    expect(r.status).toBe('remediation');
    expect(createEvaluation).not.toHaveBeenCalled();
    expect(r.gate!.remediation).toMatch(/LOOM_FOUNDRY_PROJECT/);
    expect(r.gate!.remediation).toMatch(/LOOM_FOUNDRY_EVAL_DATASET/);
  });

  it('with NO chat deployment anywhere, the gate names the var bicep sets, not the unset one', async () => {
    process.env.LOOM_FOUNDRY_PROJECT = 'proj-loom';
    process.env.LOOM_FOUNDRY_EVAL_DATASET = 'azureml://datasets/golden/versions/1';
    const r = await run();
    expect(r.status).toBe('remediation');
    expect(r.gate!.remediation).toMatch(/LOOM_AOAI_DEPLOYMENT/);
    expect(createEvaluation).not.toHaveBeenCalled();
  });

  it('skips cleanly on non-evaluation content', async () => {
    const r = await evaluationProvisioner({ displayName: 'x', content: { kind: 'notebook' } } as never);
    expect(r.status).toBe('skipped');
  });
});
