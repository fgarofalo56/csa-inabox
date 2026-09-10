/**
 * Phase 2 — Databricks Notebook provisioner.
 *
 * Closes the Direct-Lake-Replacement gap where itemType 'databricks-notebook'
 * (the Silver + Gold medallion notebooks) had NO provisioner and fell to the
 * Cosmos-only skipped path — so the notebooks never ran and the lakehouse was
 * never seeded.
 *
 * This provisioner makes the notebook REAL and RUNNABLE on Databricks:
 *   0. Prepends the `%pip install` bootstrap cell for whatever the bundle
 *      declares in `requiredLibraries` (#3530) — same mechanism, same helper,
 *      as the `notebook` itemType's three backends.
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
import { withRequiredLibraryBootstrap, pipPackagesFor } from './notebook';

export const databricksNotebookProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  // #3530 — the same `%pip install` bootstrap the `notebook` itemType applies
  // (notebook.ts, all three backends). Without it a `databricks-notebook` item
  // whose cells import a package outside the cluster image dies on
  // `ModuleNotFoundError` at the first import — the exact defect #3530 filed,
  // on the one notebook itemType that was not wired to the mechanism. The
  // undeclared-import sweep enumerates `NOTEBOOK_ITEM_TYPES`, which includes
  // this one, so before this line an author could follow the sweep's failure
  // message, declare the package, watch the sweep go green, and still get the
  // ModuleNotFoundError: a fail-green trap.
  //
  // `withRequiredLibraryBootstrap` is idempotent and returns `content`
  // unchanged when nothing is declared, so this is a no-op for every bundle
  // that declares nothing (today: all of them — `app-direct-lake-replacement`
  // is the only bundle with `databricks-notebook` items and its cells carry no
  // Python imports). The bootstrap cell is `lang:'pyspark'`, i.e. the notebook
  // default, so `buildDatabricksSource` emits it natively rather than as a
  // `# MAGIC` block — byte-identical to how notebook.ts's Databricks arm has
  // shipped this cell since #3530.
  const content = withRequiredLibraryBootstrap(input.content);
  const run = await importAndRunNotebook(input.appId, input.displayName, content);
  const steps = run.steps;
  const pkgs = pipPackagesFor(input.content);
  if (pkgs.length) {
    steps.unshift(
      `Prepended a session-scoped '%pip install ${pkgs.join(' ')}' bootstrap cell (declared requiredLibraries).`,
    );
  }

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

  // A TERMINAL non-SUCCESS Spark run means the data-production path errored —
  // surface it as a failure (not silent success) so the operator fixes it,
  // per no-vaporware. We only judge result_state once the run has actually
  // settled; a still-running job has no result_state and must NOT be flagged.
  if (run.settled && run.resultState && run.resultState !== 'SUCCESS') {
    return {
      status: 'failed',
      error: `Notebook run ${run.runId} finished ${run.lifeCycleState}/${run.resultState}${run.stateMessage ? `: ${run.stateMessage}` : ''}.`,
      resourceId: run.runId !== undefined ? String(run.runId) : undefined,
      secondaryIds,
      steps,
    };
  }

  // Created. The notebook was imported and a real run was submitted. If it
  // settled to SUCCESS within the short window the medallion data is live now;
  // otherwise it is still executing on the cluster (tracked by runId) and the
  // install request returns promptly instead of blocking past the Front Door
  // gateway window. The lakehouse provisioner's seeded Gold/dim rows mean the
  // semantic model + report render immediately regardless.
  if (!run.settled) secondaryIds.runProgress = 'executing';
  return {
    status: 'created',
    resourceId: run.runId !== undefined ? String(run.runId) : run.notebookPath,
    secondaryIds,
    steps,
  };
};
