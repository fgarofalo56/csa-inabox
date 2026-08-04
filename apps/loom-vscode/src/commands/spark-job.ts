/**
 * Spark job definition commands (Phase 5, J1-J6) — configure the spec, upload
 * the main/reference file, submit a real Synapse-Livy batch run, and browse run
 * history (with cancel). Every action hits the dedicated, REAL SJD route the
 * Console's own editor uses (Azure-native Synapse Spark, never OneLake). No fake
 * kernel: an unconfigured pool / main file / Synapse workspace surfaces the
 * route's honest 400/502 verbatim with a Fix-it (no-vaporware.md G2).
 */
import * as vscode from 'vscode';
import type { CommandContext, ItemNode } from './context';
import { guardWrite } from './context';
import type { Deployment } from '../config/deployments';
import type { LoomApi } from '../api/loom-client';
import { isLoomApiError } from '../api/loom-client';
import {
  buildSpecUpdate,
  buildSubmitBody,
  runsFromResponse,
  specFromState,
  summarizeRun,
  isTerminalRun,
  type SparkBatchJob,
  type SparkJobSpec,
  type SparkLanguage,
} from '../spark-job/spark-job-model';

const ITEM_TYPE = 'spark-job-definition';

interface SjdTarget {
  dep: Deployment;
  api: LoomApi;
  id: string;
  displayName: string;
}

async function resolveSjd(cx: CommandContext, node?: ItemNode): Promise<SjdTarget | undefined> {
  if (!node || node.kind !== 'item') {
    vscode.window.showInformationMessage('Run this from a Spark job definition in the CSA Loom Explorer.');
    return undefined;
  }
  if (node.item.itemType !== ITEM_TYPE) {
    vscode.window.showWarningMessage('This action is only available for a Spark job definition item.');
    return undefined;
  }
  const api = await cx.resolveApi(node.dep.id);
  if (!api) {
    vscode.window.showWarningMessage(`Sign in to ${node.dep.name} first.`);
    return undefined;
  }
  return { dep: node.dep, api, id: node.item.id, displayName: node.item.displayName };
}

/**
 * `CSA Loom: Configure Spark job` (J1) — guided pool + main file + language, then
 * a merged `PUT …/[id]` (never a freeform JSON blob — loom_no_freeform_config).
 */
export async function configureSparkJob(cx: CommandContext, node?: ItemNode): Promise<void> {
  const t = await resolveSjd(cx, node);
  if (!t || !node) return;
  if (!guardWrite(cx, t.dep)) return;

  let current: SparkJobSpec = {};
  let currentState: Record<string, unknown> | undefined;
  try {
    const item = await t.api.getSparkJobItem(t.id);
    currentState = (item.state as Record<string, unknown>) || {};
    current = specFromState(item.state);
  } catch (e) {
    vscode.window.showErrorMessage(`Could not load the Spark job spec: ${isLoomApiError(e) ? e.message : String(e)}`);
    return;
  }

  const pool = await vscode.window.showInputBox({
    title: `Spark job — pool (1/3)`,
    prompt: 'Synapse Spark pool to run this job on',
    value: current.pool ?? '',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'A Spark pool is required to submit a run.'),
  });
  if (pool === undefined) return;

  const file = await vscode.window.showInputBox({
    title: `Spark job — main definition file (2/3)`,
    prompt: 'abfss:// URI of the main .py / .jar / .R file (or upload one with "Upload file")',
    value: current.file ?? '',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'The main definition file is required to submit a run.'),
  });
  if (file === undefined) return;

  const langPick = await vscode.window.showQuickPick(
    [
      { label: 'PySpark (Python)', value: 'PySpark' as SparkLanguage },
      { label: 'Spark (Scala / Java jar)', value: 'Spark' as SparkLanguage },
      { label: 'SparkR (R)', value: 'SparkR' as SparkLanguage },
    ],
    { title: 'Spark job — language (3/3)', placeHolder: current.language ? `Current: ${current.language}` : undefined },
  );
  if (!langPick) return;

  const patch: Partial<SparkJobSpec> = { pool: pool.trim(), file: file.trim(), language: langPick.value };
  const { state } = buildSpecUpdate(currentState, patch);
  try {
    await t.api.putSparkJobState(t.id, state);
    cx.tree.refresh();
    vscode.window.showInformationMessage(`Configured "${t.displayName}" — pool ${pool.trim()}, ${langPick.value}.`);
  } catch (e) {
    vscode.window.showErrorMessage(`Could not save the Spark job spec: ${isLoomApiError(e) ? e.message : String(e)}`);
  }
}

/**
 * `CSA Loom: Upload Spark job file` (J2) — pick a local file, upload to ADLS as
 * the main definition or a reference. A `main` upload also records `spec.file`.
 * Honest gate: 400 `adls_not_configured` offers pasting an abfss:// URI instead.
 */
export async function uploadSparkJobFile(cx: CommandContext, node?: ItemNode): Promise<void> {
  const t = await resolveSjd(cx, node);
  if (!t || !node) return;
  if (!guardWrite(cx, t.dep)) return;

  const kindPick = await vscode.window.showQuickPick(
    [
      { label: '$(file-code) Main definition file', value: 'main' as const },
      { label: '$(library) Reference file (library / module)', value: 'reference' as const },
    ],
    { title: `Upload to "${t.displayName}"`, placeHolder: 'What kind of file?' },
  );
  if (!kindPick) return;

  const picked = await vscode.window.showOpenDialog({
    title: 'Choose a file to upload',
    canSelectMany: false,
    openLabel: 'Upload',
  });
  if (!picked || picked.length === 0) return;
  const uri = picked[0];
  const filename = uri.path.split('/').pop() || 'upload.bin';

  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Uploading ${filename}…` },
      () => t.api.uploadSparkJobFile(t.id, kindPick.value, filename, bytes),
    );
    if (kindPick.value === 'main' && res.abfssPath) {
      const item = await t.api.getSparkJobItem(t.id);
      const { state } = buildSpecUpdate((item.state as Record<string, unknown>) || {}, { file: res.abfssPath });
      await t.api.putSparkJobState(t.id, state);
      cx.tree.refresh();
    }
    vscode.window.showInformationMessage(
      `Uploaded ${filename}${res.abfssPath ? ` → ${res.abfssPath}` : ''}${kindPick.value === 'main' ? ' (set as main file)' : ''}.`,
    );
  } catch (e) {
    if (isLoomApiError(e) && e.code === 'adls_not_configured') {
      const paste = 'Paste abfss:// URI';
      const choice = await vscode.window.showWarningMessage(e.message, paste);
      if (choice === paste && kindPick.value === 'main') {
        const abfss = await vscode.window.showInputBox({
          title: 'Main definition file — abfss:// URI',
          prompt: 'Paste the abfss:// URI of the already-uploaded main file',
          ignoreFocusOut: true,
          validateInput: (v) => (/^abfss:\/\//i.test(v.trim()) ? undefined : 'Expected an abfss:// URI.'),
        });
        if (abfss) {
          const item = await t.api.getSparkJobItem(t.id);
          const { state } = buildSpecUpdate((item.state as Record<string, unknown>) || {}, { file: abfss.trim() });
          await t.api.putSparkJobState(t.id, state);
          cx.tree.refresh();
          vscode.window.showInformationMessage('Recorded the main definition file.');
        }
      }
      return;
    }
    vscode.window.showErrorMessage(`Upload failed: ${isLoomApiError(e) ? e.message : String(e)}`);
  }
}

/**
 * `CSA Loom: Run Spark job` (J5) — submit a real Livy batch from the persisted
 * spec. A missing pool / main file / Synapse config surfaces the route's honest
 * error with a "Configure Spark job" Fix-it.
 */
export async function runSparkJob(cx: CommandContext, node?: ItemNode): Promise<void> {
  const t = await resolveSjd(cx, node);
  if (!t || !node) return;
  if (!guardWrite(cx, t.dep)) return;
  try {
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Submitting Spark job "${t.displayName}"…` },
      () => t.api.submitSparkJob(t.id, buildSubmitBody()),
    );
    const job = res.job;
    const view = 'View runs';
    const choice = await vscode.window.showInformationMessage(
      job
        ? `Submitted batch ${job.id}${job.state ? ` (${job.state})` : ''} to pool ${res.pool ?? ''}.`
        : `Submitted a Spark batch to pool ${res.pool ?? ''}.`,
      view,
    );
    if (choice === view) await viewSparkJobRuns(cx, node);
  } catch (e) {
    await handleSjdErrorWithConfigure(cx, t, node, e);
  }
}

/**
 * `CSA Loom: View Spark job runs` (J4) — the real Livy batch history for this
 * SJD; a running batch can be cancelled, any batch shows its detail (state,
 * appId, log tail). Real runs only — never a synthetic row.
 */
export async function viewSparkJobRuns(cx: CommandContext, node?: ItemNode): Promise<void> {
  const t = await resolveSjd(cx, node);
  if (!t || !node) return;
  let runs: SparkBatchJob[];
  try {
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Loading runs for "${t.displayName}"…` },
      () => t.api.listSparkJobRuns(t.id),
    );
    runs = runsFromResponse(res);
  } catch (e) {
    await handleSjdErrorWithConfigure(cx, t, node, e);
    return;
  }
  if (runs.length === 0) {
    vscode.window.showInformationMessage(`No runs yet for "${t.displayName}" — use "Run Spark job" to submit one.`);
    return;
  }
  interface RunPick extends vscode.QuickPickItem {
    job: SparkBatchJob;
  }
  const picks: RunPick[] = runs.map((job) => {
    const s = summarizeRun(job);
    return {
      label: `$(${s.icon}) ${s.label}`,
      description: `${s.state}${s.result ? ` · ${s.result}` : ''}`,
      detail: s.appId ? `appId ${s.appId}` : undefined,
      job,
    };
  });
  const pick = await vscode.window.showQuickPick(picks, {
    title: `Spark runs — ${t.displayName}`,
    placeHolder: 'Select a run to view detail (a running batch can be cancelled)',
  });
  if (!pick) return;
  const job = pick.job;
  if (!isTerminalRun(job)) {
    const cancel = 'Cancel run';
    const choice = await vscode.window.showQuickPick([{ label: '$(output) Show detail', act: 'detail' as const }, { label: `$(circle-slash) ${cancel}`, act: 'cancel' as const }], {
      title: `Batch ${job.id} — ${summarizeRun(job).state}`,
    });
    if (!choice) return;
    if (choice.act === 'cancel') {
      if (!guardWrite(cx, t.dep)) return;
      try {
        await t.api.cancelSparkJobRun(t.id, job.id);
        vscode.window.showInformationMessage(`Requested cancellation of batch ${job.id}.`);
      } catch (e) {
        vscode.window.showErrorMessage(`Cancel failed: ${isLoomApiError(e) ? e.message : String(e)}`);
      }
      return;
    }
  }
  showRunDetail(t.displayName, job);
}

/** Render a single batch's detail (state, appId, log tail) in an output channel. */
function showRunDetail(displayName: string, job: SparkBatchJob): void {
  const ch = vscode.window.createOutputChannel(`CSA Loom Spark — ${displayName}`);
  const s = summarizeRun(job);
  ch.appendLine(`Batch ${job.id}${job.name ? ` (${job.name})` : ''}`);
  ch.appendLine(`State:  ${s.state}${s.result ? `  Result: ${s.result}` : ''}`);
  if (s.appId) ch.appendLine(`AppId:  ${s.appId}`);
  if (job.sparkPoolName) ch.appendLine(`Pool:   ${job.sparkPoolName}`);
  if (Array.isArray(job.log) && job.log.length) {
    ch.appendLine('');
    ch.appendLine('--- driver log (tail) ---');
    for (const line of job.log) ch.appendLine(line);
  }
  ch.show(true);
}

/** Error handler that can launch the guided configure flow with the real context. */
async function handleSjdErrorWithConfigure(cx: CommandContext, t: SjdTarget, node: ItemNode, e: unknown): Promise<void> {
  const msg = isLoomApiError(e) ? `${e.message}${e.hint ? ` (${e.hint})` : ''}` : e instanceof Error ? e.message : String(e);
  const needsSpec = /spec\.(pool|file)/i.test(msg);
  const configure = 'Configure Spark job';
  const choice = await vscode.window.showWarningMessage(
    `Spark job "${t.displayName}": ${msg}`,
    ...(needsSpec ? [configure] : []),
  );
  if (choice === configure) await configureSparkJob(cx, node);
}
