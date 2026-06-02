/**
 * Phase 2 — Databricks Notebook provisioner.
 *
 * Closes the Direct-Lake-Replacement gap where itemType 'databricks-notebook'
 * (the Silver + Gold medallion notebooks) had NO provisioner and fell to the
 * Cosmos-only skipped path — so the notebooks never ran and the lakehouse was
 * never seeded.
 *
 * This provisioner makes the notebook REAL and RUNNABLE on Databricks:
 *   1. Imports the bundle's NotebookContent cells as a Databricks SOURCE
 *      notebook (api/2.0/workspace/import).
 *   2. Submits a one-time run on a resolved cluster (api/2.1/jobs/runs/submit)
 *      and polls it to terminal (api/2.1/jobs/runs/get) — actually executing
 *      the Silver/Gold transforms that PRODUCE the live Delta data.
 *
 * The companion lakehouse provisioner additionally seeds the bundle's
 * sampleRows into queryable Gold Delta tables (see _seed-databricks.ts) so
 * the semantic model + report render immediately, independent of the run.
 *
 * Honest gates (per .claude/rules/no-vaporware.md): when the Databricks
 * workspace hostname / a runnable cluster / the UAMI's workspace access is
 * missing, the item still installs to Cosmos and surfaces a precise
 * remediation gate naming the exact env var / role — the notebook is created
 * on the next pass once the gate is cleared.
 *
 * Docs:
 *   https://learn.microsoft.com/azure/databricks/api/workspace/workspace/import
 *   https://learn.microsoft.com/azure/databricks/api/workspace/jobs/submit
 *   https://learn.microsoft.com/azure/databricks/api/workspace/jobs/getrun
 */
import type { Provisioner, ProvisionResult } from './types';
import { importAndRunNotebook } from './_seed-databricks';

export const databricksNotebookProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const run = await importAndRunNotebook(input.appId, input.displayName, input.content);
  const steps = run.steps;

  if (run.gate) {
    return {
      status: 'remediation',
      gate: {
        reason: run.gate.reason,
        remediation: run.gate.remediation,
        link: 'https://learn.microsoft.com/azure/databricks/api/workspace/jobs/submit',
      },
      steps,
      ...(run.notebookPath ? { secondaryIds: { notebookPath: run.notebookPath } } : {}),
    };
  }

  if (!run.triggered) {
    // Imported (or attempted) but the run could not be submitted for a
    // non-auth reason — report as failed so the wizard can Retry/Skip.
    return {
      status: 'failed',
      error: 'Notebook run was not triggered; see steps for detail.',
      steps,
      ...(run.notebookPath ? { secondaryIds: { notebookPath: run.notebookPath } } : {}),
    };
  }

  const secondaryIds: Record<string, string> = {};
  if (run.notebookPath) secondaryIds.notebookPath = run.notebookPath;
  if (run.runId !== undefined) secondaryIds.runId = String(run.runId);
  if (run.lifeCycleState) secondaryIds.lifeCycleState = run.lifeCycleState;
  if (run.resultState) secondaryIds.resultState = run.resultState;

  // A FAILED Spark run means the data-production path errored — surface it as
  // a failure (not silent success) so the operator fixes it, per no-vaporware.
  if (run.resultState && run.resultState !== 'SUCCESS') {
    return {
      status: 'failed',
      error: `Notebook run ${run.runId} finished ${run.lifeCycleState}/${run.resultState}${run.stateMessage ? `: ${run.stateMessage}` : ''}.`,
      resourceId: run.runId !== undefined ? String(run.runId) : undefined,
      secondaryIds,
      steps,
    };
  }

  // Still in progress at the end of the poll budget — created, run tracked.
  return {
    status: 'created',
    resourceId: run.runId !== undefined ? String(run.runId) : run.notebookPath,
    secondaryIds,
    steps,
  };
};
