/**
 * The Pipeline Copilot's `runId` tools must prove ownership BEFORE they read.
 *
 * Split out of #2609's round-3 review, where the ownership gate was added to the
 * item ROUTES (`data-pipeline/[id]/output`, `synapse-pipeline/[id]/runs`,
 * `adf-pipeline/[id]/runs`) and NOT to the Copilot tool that reaches the same
 * data plane. Independent adjudication called that correctly: the class was still
 * live on this surface.
 *
 * Why this surface is the worse one:
 *   - the `runId` is MODEL-supplied, i.e. whatever the user typed ("explain the
 *     error on run <guid>") lands in the tool call;
 *   - a factory / Synapse workspace is SHARED across Loom workspaces, and
 *     `listActivityRuns(runId)` is run-scoped, not pipeline-scoped;
 *   - `pipeline_explain_error` returns per-activity `error.errorCode` /
 *     `error.message`, the most disclosive fields either data plane produces —
 *     ADF failure messages routinely quote connection strings, `abfss://` paths
 *     and SQL text — and the Copilot then narrates them in the transcript.
 *
 * Every case below asserts a DENIAL or the ABSENCE of a read. Each mutation was
 * applied, observed RED, and reverted; the mutation is named in its block.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@azure/identity', () => {
  class FakeCred { async getToken() { return { token: 'x', expiresOnTimestamp: Date.now() + 3_600_000 }; } }
  return { DefaultAzureCredential: FakeCred, ManagedIdentityCredential: FakeCred, ChainedTokenCredential: FakeCred };
});

vi.mock('../../azure/adf-client', () => ({
  listLinkedServices: vi.fn(),
  listDatasets: vi.fn(),
  getPipeline: vi.fn(),
  runPipeline: vi.fn(),
  listPipelineRuns: vi.fn(),
  listActivityRuns: vi.fn(),
  upsertPipeline: vi.fn(),
}));
vi.mock('../../azure/synapse-dev-client', () => ({
  listLinkedServices: vi.fn(),
  listDatasets: vi.fn(),
  getPipeline: vi.fn(),
  runPipeline: vi.fn(),
  getPipelineRun: vi.fn(),
  queryPipelineRuns: vi.fn(),
  listActivityRuns: vi.fn(),
  upsertPipeline: vi.fn(),
}));

import * as adf from '../../azure/adf-client';
import * as synapseDev from '../../azure/synapse-dev-client';
import {
  handlePipelineExplainError,
  handlePipelineGetRunStatus,
  resolveOwnedPipelineRun,
  PipelineRunNotOwnedError,
  RUN_OWNERSHIP_WINDOW_DAYS,
} from '../pipeline-tools';

/** What the OTHER team's failed run would have disclosed. */
const FOREIGN_ACTIVITY = {
  activityName: 'CopyPayroll',
  activityType: 'Copy',
  status: 'Failed',
  error: {
    errorCode: 'UserErrorFailedFileOperation',
    message:
      "Failure happened on 'Source' side. Sink=abfss://finance@stother.dfs.core.windows.net/payroll/2026, "
      + "query='SELECT * FROM hr.salaries', connectionString='Server=tcp:syn-hr.sql.azuresynapse.net'",
    failureType: 'UserError',
  },
};

/** The bound pipeline's own runs (what the pipeline-filtered list returns). */
const OWN_RUNS = [{ runId: 'own-run-1', pipelineName: 'copy_orders', status: 'Failed', message: 'Activity CopyOrders failed' }];

beforeEach(() => {
  vi.clearAllMocks();
  (adf.listPipelineRuns as any).mockResolvedValue(OWN_RUNS);
  (synapseDev.queryPipelineRuns as any).mockResolvedValue({ value: [{ runId: 'own-run-1', pipelineName: 'ws_pipe', status: 'Failed' }] });
  (adf.listActivityRuns as any).mockResolvedValue([FOREIGN_ACTIVITY]);
  (synapseDev.listActivityRuns as any).mockResolvedValue([FOREIGN_ACTIVITY]);
});

// ---------------------------------------------------------------------------
describe('ATTACK: a runId this pipeline does not own must not be read at all', () => {
  // MUTATION C1: in `handlePipelineExplainError`, replace
  //     const run = await resolveOwnedPipelineRun(runId, backend, pipelineName);
  //   with a stub run object (i.e. read the activities without proving anything).
  // → observed: 6 RED. `listActivityRuns` is called with the foreign runId on
  //   BOTH backends and the handler resolves instead of rejecting, so the
  //   fixture's `error.message` — which carries a connection string, SQL text and
  //   another workspace's `abfss://` sink, because that is what real ADF failure
  //   messages contain — is returned for the Copilot to narrate.
  it('refuses the foreign runId and never calls listActivityRuns (ADF)', async () => {
    await expect(
      handlePipelineExplainError({ runId: 'someone-elses-run', backend: 'adf', pipelineName: 'copy_orders' }),
    ).rejects.toBeInstanceOf(PipelineRunNotOwnedError);
    expect(adf.listActivityRuns).not.toHaveBeenCalled();
  });

  it('refuses the foreign runId and never calls listActivityRuns (Synapse)', async () => {
    await expect(
      handlePipelineExplainError({ runId: 'someone-elses-run', backend: 'synapse', pipelineName: 'ws_pipe' }),
    ).rejects.toBeInstanceOf(PipelineRunNotOwnedError);
    expect(synapseDev.listActivityRuns).not.toHaveBeenCalled();
  });

  it('the refusal message discloses nothing about the foreign run', async () => {
    const err = await handlePipelineExplainError({ runId: 'someone-elses-run', backend: 'adf', pipelineName: 'copy_orders' })
      .then(() => null, (e: Error) => e);
    const text = String(err?.message || '');
    // It must not say WHOSE run it is, nor whether it exists.
    expect(text).not.toMatch(/payroll|finance|hr\.|syn-hr|connectionString/i);
    expect(text).not.toMatch(/belongs to/i);
    // …and it must be actionable rather than a bare 'not found'.
    expect(text).toContain('Runs list');
    expect(text).toContain(String(RUN_OWNERSHIP_WINDOW_DAYS));
  });

  it('the same gate covers pipeline_get_run_status — the activity rollup fallback is gone', async () => {
    // MUTATION C2: same stub substitution, applied to
    //   `handlePipelineGetRunStatus` instead — which is what the pre-fix code
    //   effectively did once its pipeline-filtered lookup missed and it fell
    //   through to `listActivityRuns(runId)`.
    // → observed: 3 RED (this spec plus both PIPELINE-FILTERED specs, because the
    //   ownership call IS the only read on this path now — there is no second
    //   lookup left to fall back to).
    await expect(
      handlePipelineGetRunStatus({ runId: 'someone-elses-run', backend: 'adf', pipelineName: 'copy_orders' }),
    ).rejects.toBeInstanceOf(PipelineRunNotOwnedError);
    expect(adf.listActivityRuns).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('the oracle is PIPELINE-FILTERED, not just "some run list"', () => {
  // MUTATION C3: `adf.listPipelineRuns(undefined, …)` and
  //   `queryPipelineRuns({ filters: undefined })`.
  // → observed: 2 RED. This is the mutation that matters most: without the
  //   filter the "run list" is every pipeline's runs in the factory, so a foreign
  //   run resolves, the gate passes, and the ATTACK block above would still be
  //   green. A gate that reads an unscoped list is decoration.
  it('ADF filters by the bound pipeline name over the retention window', async () => {
    await handlePipelineGetRunStatus({ runId: 'own-run-1', backend: 'adf', pipelineName: 'copy_orders' });
    expect(adf.listPipelineRuns).toHaveBeenCalledWith('copy_orders', RUN_OWNERSHIP_WINDOW_DAYS);
  });

  it('Synapse sends a PipelineName Equals filter', async () => {
    await handlePipelineGetRunStatus({ runId: 'own-run-1', backend: 'synapse', pipelineName: 'ws_pipe' });
    const q = (synapseDev.queryPipelineRuns as any).mock.calls[0][0];
    expect(q.filters).toEqual([{ operand: 'PipelineName', operator: 'Equals', values: ['ws_pipe'] }]);
    expect(q.orderBy).toEqual([{ orderBy: 'RunStart', order: 'DESC' }]);
  });

  it('an absent bound pipeline is a refusal, not an unscoped read', async () => {
    // The structural half: `pipelineName` is required by the type, but assert the
    // runtime too — an empty string must not fall through to an unfiltered list.
    //
    // MUTATION C5: delete the `if (!pipelineName) throw …` guard.
    // → observed: 1 RED — an empty bound name calls
    //   `adf.listPipelineRuns('', 45)`, and `listPipelineRuns` treats a falsy name
    //   as "no filter", which is exactly mutation C3 arrived at from the other
    //   direction.
    await expect(resolveOwnedPipelineRun('own-run-1', 'adf', '')).rejects.toBeInstanceOf(PipelineRunNotOwnedError);
    expect(adf.listPipelineRuns).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('fail-closed, but not fail-stupid', () => {
  // MUTATION C4: wrap the ADF oracle call in `.catch(() => [])` — the shape
  //   round 3 had to remove from the item routes for exactly this reason.
  // → observed: 1 RED — ARM throttling is reported to the user as "that run is
  //   not one of this pipeline's runs", so the owner's own run disappears
  //   whenever the data plane is busy. The Synapse spec is the same assertion on
  //   the sibling branch; both are here so neither branch can regress alone.
  it('a transient ARM failure PROPAGATES instead of becoming "not your run" (ADF)', async () => {
    (adf.listPipelineRuns as any).mockRejectedValue(new Error('listPipelineRuns failed 429: throttled'));
    const err = await handlePipelineExplainError({ runId: 'own-run-1', backend: 'adf', pipelineName: 'copy_orders' })
      .then(() => null, (e: Error) => e);
    expect(err).not.toBeInstanceOf(PipelineRunNotOwnedError);
    expect(String(err?.message)).toContain('429');
  });

  it('a transient Synapse failure PROPAGATES too', async () => {
    (synapseDev.queryPipelineRuns as any).mockRejectedValue(new Error('queryPipelineRuns failed 503: unavailable'));
    const err = await handlePipelineExplainError({ runId: 'own-run-1', backend: 'synapse', pipelineName: 'ws_pipe' })
      .then(() => null, (e: Error) => e);
    expect(err).not.toBeInstanceOf(PipelineRunNotOwnedError);
    expect(String(err?.message)).toContain('503');
  });
});

// ---------------------------------------------------------------------------
describe('the owner still gets the full explanation', () => {
  // A gate that also breaks the legitimate path is not a fix.
  it('an owned failed run returns its activity errors and the run-level message', async () => {
    (adf.listActivityRuns as any).mockResolvedValue([
      { activityName: 'CopyOrders', activityType: 'Copy', status: 'Failed', error: { errorCode: 'UserErrorColumnMappingNotCompatible', message: 'Column mapping is invalid', failureType: 'UserError' } },
      { activityName: 'Notify', activityType: 'WebActivity', status: 'Skipped' },
    ]);
    const out = await handlePipelineExplainError({ runId: 'own-run-1', backend: 'adf', pipelineName: 'copy_orders' });
    expect(out.failedActivities).toHaveLength(1);
    expect(out.failedActivities[0].errorCode).toBe('UserErrorColumnMappingNotCompatible');
    expect(out.status).toBe('Failed');
    expect(out.runMessage).toBe('Activity CopyOrders failed');
    // ONE ownership call, not one per handler step — bounded ARM fan-out for a
    // model-supplied id.
    expect((adf.listPipelineRuns as any).mock.calls).toHaveLength(1);
  });
});
