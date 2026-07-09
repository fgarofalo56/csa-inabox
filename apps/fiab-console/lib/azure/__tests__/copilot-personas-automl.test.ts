/**
 * AutoML / ML Experiment Copilot builder config — pure logic tests (G1).
 *
 * Verifies task/metric validation (a metric is only accepted when valid for the
 * effective task, including a task change earlier in the same plan) and that
 * applyOps clears a now-invalid metric after a task switch.
 */
import { describe, it, expect } from 'vitest';
import { makeAutoMlBuilderConfig, AUTOML_BUILDER_CONFIG } from '../copilot-personas-automl';

const cfg = AUTOML_BUILDER_CONFIG as any;

describe('automl builder — normalizeOps validation', () => {
  it('accepts a valid task + a metric valid for that task in the same plan', () => {
    const ops = cfg.normalizeOps([
      { kind: 'set-task', task: 'Regression' },
      { kind: 'set-primary-metric', metric: 'R2Score' },
    ], {});
    expect(ops.map((o: any) => o.kind)).toEqual(['set-task', 'set-primary-metric']);
  });

  it('drops a metric that is invalid for the effective task', () => {
    // No task set → defaults to any task's metric list; 'Accuracy' is Classification-only.
    const ops = cfg.normalizeOps([
      { kind: 'set-task', task: 'Regression' },
      { kind: 'set-primary-metric', metric: 'Accuracy' },
    ], {});
    expect(ops.map((o: any) => o.kind)).toEqual(['set-task']);
  });

  it('clamps invalid trial / timeout values out', () => {
    expect(cfg.normalizeOps([{ kind: 'set-max-trials', value: 0 }], {})).toHaveLength(0);
    expect(cfg.normalizeOps([{ kind: 'set-max-trials', value: 50 }], {})).toHaveLength(1);
    expect(cfg.normalizeOps([{ kind: 'set-experiment-timeout', minutes: 1 }], {})).toHaveLength(0);
    expect(cfg.normalizeOps([{ kind: 'set-experiment-timeout', minutes: 60 }], {})).toHaveLength(1);
  });
});

describe('automl builder — applyOps', () => {
  it('writes the config draft and drops a metric invalidated by a task change', () => {
    const doc = { task: 'Classification', primaryMetric: 'Accuracy' } as any;
    const ops = cfg.normalizeOps([{ kind: 'set-task', task: 'Regression' }], doc);
    const { patch } = cfg.applyOps(doc, ops);
    expect(patch.copilotAutomlConfig.task).toBe('Regression');
    // 'Accuracy' is not valid for Regression → cleared.
    expect(patch.copilotAutomlConfig.primaryMetric).toBeUndefined();
  });

  it('sets target column + trials', () => {
    const ops = cfg.normalizeOps([
      { kind: 'set-target-column', column: 'is_churned' },
      { kind: 'set-max-trials', value: 30 },
    ], {});
    const { patch } = cfg.applyOps({}, ops);
    expect(patch.copilotAutomlConfig.targetColumn).toBe('is_churned');
    expect(patch.copilotAutomlConfig.maxTrials).toBe(30);
  });
});

describe('automl builder — item type wiring', () => {
  it('makeAutoMlBuilderConfig binds the item type + checkpoints key', () => {
    const ml = makeAutoMlBuilderConfig('ml-experiment');
    expect(ml.itemType).toBe('ml-experiment');
    expect(ml.checkpointsKey).toBe('ml-experimentCheckpoints');
    expect(AUTOML_BUILDER_CONFIG.itemType).toBe('automl');
  });
});
