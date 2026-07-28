/**
 * B-FN — copilot-evaluator client contract after the Function → ACA-job move.
 *
 * The evaluator is now an in-VNet `Microsoft.App/jobs` execution instead of a
 * Y1 Consumption Function HTTP trigger (Y1 is structurally broken on this
 * estate). Two behaviours are load-bearing and easy to regress, so they are
 * pinned here:
 *
 *  1. the honest gate keys off LOOM_COPILOT_EVALUATOR_JOB_ID (the ARM id the
 *     job module wires), NOT the retired LOOM_COPILOT_EVALUATOR_URL;
 *  2. an on-demand start OVERRIDES the job's execution template, and per Learn
 *     the override REPLACES the template wholesale — so `mergeRunEnv` must keep
 *     the image, resources, command and every pre-existing env entry
 *     (especially `secretRef` ones like the internal token) and only set the
 *     four COPILOT_EVAL_* run knobs the entrypoint reads. Dropping any of those
 *     would produce an execution that silently cannot reach Cosmos/AOAI.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mergeRunEnv,
  evaluatorRunGate,
  evaluatorJobId,
  EVALUATOR_JOB_NAME,
  type JobContainer,
} from '@/lib/azure/copilot-evaluator-client';

const JOB_ID_ENV = 'LOOM_COPILOT_EVALUATOR_JOB_ID';

function templateFixture(): JobContainer[] {
  return [
    {
      name: 'evaluator',
      image: 'acrloom.azurecr.io/loom-copilot-evaluator:latest',
      resources: { cpu: 1, memory: '2.0Gi' },
      env: [
        { name: 'LOOM_COSMOS_ENDPOINT', value: 'https://acct.documents.azure.com:443/' },
        { name: 'LOOM_INTERNAL_TOKEN', secretRef: 'loom-internal-token' },
        { name: 'COPILOT_EVAL_MODE', value: 'all' },
        { name: 'COPILOT_EVAL_TRIGGER', value: 'nightly' },
      ],
    },
  ];
}

function envOf(containers: JobContainer[], name: string) {
  return (containers[0].env || []).find((e) => e.name === name);
}

describe('copilot-evaluator client (ACA job)', () => {
  const saved = process.env[JOB_ID_ENV];
  beforeEach(() => { delete process.env[JOB_ID_ENV]; });
  afterEach(() => {
    if (saved === undefined) delete process.env[JOB_ID_ENV];
    else process.env[JOB_ID_ENV] = saved;
  });

  it('gates on the JOB id env, naming it in the remediation', () => {
    const gate = evaluatorRunGate();
    expect(gate).not.toBeNull();
    expect(gate!.gateId).toBe('svc-copilot-evaluator');
    expect(gate!.missing).toEqual([JOB_ID_ENV]);
    expect(gate!.remediation).toContain('copilot-evaluator-job.bicep');
  });

  it('resolves the gate once the job id is wired (trailing slash tolerated)', () => {
    process.env[JOB_ID_ENV] = `/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/jobs/${EVALUATOR_JOB_NAME}/`;
    expect(evaluatorRunGate()).toBeNull();
    expect(evaluatorJobId().endsWith(EVALUATOR_JOB_NAME)).toBe(true);
  });

  it('keeps image/resources and every non-override env entry (incl. secretRef)', () => {
    const merged = mergeRunEnv(templateFixture(), { surfaces: ['docs'], trigger: 'manual' });
    expect(merged).toHaveLength(1);
    expect(merged[0].image).toBe('acrloom.azurecr.io/loom-copilot-evaluator:latest');
    expect(merged[0].resources).toEqual({ cpu: 1, memory: '2.0Gi' });
    expect(envOf(merged, 'LOOM_COSMOS_ENDPOINT')?.value).toBe('https://acct.documents.azure.com:443/');
    expect(envOf(merged, 'LOOM_INTERNAL_TOKEN')?.secretRef).toBe('loom-internal-token');
  });

  it('replaces (never duplicates) the run knobs', () => {
    const merged = mergeRunEnv(templateFixture(), { surfaces: ['docs', 'catalog'], trigger: 'manual' });
    const modes = (merged[0].env || []).filter((e) => e.name === 'COPILOT_EVAL_MODE');
    expect(modes).toHaveLength(1);
    expect(modes[0].value).toBe('copilot');
    expect(envOf(merged, 'COPILOT_EVAL_TRIGGER')?.value).toBe('manual');
    expect(envOf(merged, 'COPILOT_EVAL_SURFACES')?.value).toBe('docs,catalog');
    // A copilot-mode run must not leak a stale domain filter into the search mode.
    expect(envOf(merged, 'COPILOT_EVAL_DOMAINS')?.value).toBe('');
  });

  it('maps search / tier modes to their own knobs', () => {
    const search = mergeRunEnv(templateFixture(), { mode: 'search', domains: ['items', 'docs'], trigger: 'corpus' });
    expect(envOf(search, 'COPILOT_EVAL_MODE')?.value).toBe('search');
    expect(envOf(search, 'COPILOT_EVAL_TRIGGER')?.value).toBe('corpus');
    expect(envOf(search, 'COPILOT_EVAL_DOMAINS')?.value).toBe('items,docs');
    expect(envOf(search, 'COPILOT_EVAL_SURFACES')?.value).toBe('');

    const tier = mergeRunEnv(templateFixture(), { mode: 'tier', trigger: 'manual' });
    expect(envOf(tier, 'COPILOT_EVAL_MODE')?.value).toBe('tier');
    expect(envOf(tier, 'COPILOT_EVAL_SURFACES')?.value).toBe('');
    expect(envOf(tier, 'COPILOT_EVAL_DOMAINS')?.value).toBe('');
  });
});
