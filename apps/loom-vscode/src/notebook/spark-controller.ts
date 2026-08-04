/**
 * SparkNotebookController — the "CSA Loom Spark" NotebookController (N10/N11/N13)
 * on VS Code's built-in `jupyter-notebook` type (no Jupyter-extension
 * dependency). It drives the REAL notebook compute routes:
 *
 *   GET  …/session?probe=1   → which backend (Synapse Livy / Databricks / AML-CI)
 *   POST …/session           → create OR reuse a warm session (N11)
 *   GET  …/session           → poll a cold pool to `idle` (surfaced as progress)
 *   POST …/execute           → submit the cell (server interprets %%-magics)
 *   GET  …/execute           → poll the statement for normalized rich output
 *   DELETE …/session         → Stop / Cancel (interrupt + View-Recent-Runs cancel)
 *
 * HONEST GATE, never a fake kernel (no-vaporware): if a notebook is not linked to
 * a Loom item, or the deployment's Spark backend is not configured (the route
 * answers 503 `not_configured` with the exact env var), the cell output is that
 * message — the extension never pretends to run code it did not run.
 */
import * as vscode from 'vscode';
import type { LoomApi, NotebookExecResult, NotebookOutput } from '../api/loom-client';
import { isLoomApiError } from '../api/loom-client';
import type { NotebookLinkStore, NotebookLink } from './notebook-link';
import { RunHistory, type NotebookRun } from './run-history';

interface WarmSession {
  backend: string;
  sessionId: string | number;
  /** Spark pool (Synapse) or cluster (Databricks). */
  compute: string;
}

const computeKey = (link: NotebookLink) => `loom.compute:${link.deploymentId}:${link.itemId}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(['available', 'error', 'cancelled', 'success', 'ok']);

export class SparkNotebookController {
  static readonly id = 'csa-loom-spark';
  static readonly notebookType = 'jupyter-notebook';

  private readonly controller: vscode.NotebookController;
  private readonly sessions = new Map<string, WarmSession>();
  private order = 0;

  constructor(
    private readonly resolveApi: (deploymentId: string) => Promise<LoomApi | undefined>,
    private readonly links: NotebookLinkStore,
    private readonly runs: RunHistory,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.controller = vscode.notebooks.createNotebookController(
      SparkNotebookController.id,
      SparkNotebookController.notebookType,
      'CSA Loom Spark',
    );
    this.controller.supportedLanguages = ['python', 'sql', 'scala', 'r'];
    this.controller.supportsExecutionOrder = true;
    this.controller.description = 'Remote Spark on Azure Synapse (or Databricks) — no local kernel';
    this.controller.detail = 'Runs cells on the linked CSA Loom notebook item';
    this.controller.executeHandler = (cells, notebook) => this.executeAll(cells, notebook);
    this.controller.interruptHandler = (notebook) => this.interrupt(notebook);
  }

  dispose(): void {
    this.controller.dispose();
  }

  private sessKey(link: NotebookLink): string {
    return `${link.deploymentId}:${link.itemId}`;
  }

  private async executeAll(cells: vscode.NotebookCell[], notebook: vscode.NotebookDocument): Promise<void> {
    const link = this.links.get(notebook.uri);
    for (const cell of cells) {
      const exec = this.controller.createNotebookCellExecution(cell);
      exec.executionOrder = ++this.order;
      exec.start(Date.now());
      await exec.clearOutput();

      if (!link) {
        await this.gate(
          exec,
          'This notebook is not linked to a CSA Loom item. Open it from the CSA Loom Explorer ("Run on Spark") so it can execute on remote Spark.',
        );
        continue;
      }
      const api = await this.resolveApi(link.deploymentId);
      if (!api) {
        await this.gate(exec, `Not signed in to ${link.deploymentId}. Sign in from the CSA Loom Explorer, then run again.`);
        continue;
      }
      try {
        await this.runCell(api, link, cell, exec);
      } catch (e) {
        await this.failCell(exec, e);
      }
    }
  }

  private async runCell(
    api: LoomApi,
    link: NotebookLink,
    cell: vscode.NotebookCell,
    exec: vscode.NotebookCellExecution,
  ): Promise<void> {
    const code = cell.document.getText();
    const language = cell.document.languageId || 'python';
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const run: NotebookRun = {
      id: runId,
      deploymentId: link.deploymentId,
      itemId: link.itemId,
      displayName: link.displayName,
      language,
      codePreview: code.replace(/\s+/g, ' ').slice(0, 120),
      startedAt: Date.now(),
      state: 'running',
    };
    this.runs.add(run);

    let session: WarmSession;
    try {
      session = await this.ensureSession(api, link, language, exec);
    } catch (e) {
      this.runs.update(runId, { state: 'failed', endedAt: Date.now(), error: this.msg(e) });
      throw e;
    }
    this.runs.update(runId, { sessionId: String(session.sessionId), compute: session.compute, backend: session.backend });

    // Submit; recover from a warming or dead session once.
    let submit = await api.execNotebookCell(link.itemId, this.execBody(session, code, language));
    if (submit.configureApplied) {
      // %%configure — the route parsed compute options; recreate the session.
      this.sessions.delete(this.sessKey(link));
      await exec.replaceOutput(
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.text('Session compute reconfigured — the next cell starts a fresh Spark session.', 'text/plain'),
        ]),
      );
      exec.end(true, Date.now());
      this.runs.update(runId, { state: 'succeeded', endedAt: Date.now() });
      return;
    }

    let guard = 0;
    while ((submit.sessionWarming || submit.sessionDead) && guard++ < 30) {
      if (exec.token.isCancellationRequested) break;
      if (submit.sessionDead) {
        this.sessions.delete(this.sessKey(link));
        session = await this.ensureSession(api, link, language, exec);
      } else {
        await this.pollSessionIdle(api, link, session, exec);
      }
      submit = await api.execNotebookCell(link.itemId, this.execBody(session, code, language));
    }

    const output = await this.pollForOutput(api, link, session, submit, exec);
    if (!output) {
      // cancelled
      exec.end(undefined, Date.now());
      this.runs.update(runId, { state: 'cancelled', endedAt: Date.now() });
      return;
    }
    const isErr = output.status === 'error' || !!output.ename || !!output.evalue;
    await this.render(exec, output);
    exec.end(!isErr, Date.now());
    this.runs.update(runId, {
      state: isErr ? 'failed' : 'succeeded',
      endedAt: Date.now(),
      error: isErr ? output.evalue || output.ename : undefined,
    });
  }

  private async ensureSession(
    api: LoomApi,
    link: NotebookLink,
    language: string,
    exec: vscode.NotebookCellExecution,
  ): Promise<WarmSession> {
    const existing = this.sessions.get(this.sessKey(link));
    if (existing) return existing;

    // Probe backend — throws an honest 503 the caller surfaces.
    const backend = await api.notebookBackend(link.itemId);
    const compute = await this.computeTarget(link, backend);
    if (!compute) {
      throw new Error(
        backend === 'databricks'
          ? 'No Databricks cluster set for this notebook. Run "CSA Loom: Set Spark compute" to attach one.'
          : 'No Spark pool set for this notebook. Run "CSA Loom: Set Spark compute" to attach one.',
      );
    }

    const body: Record<string, unknown> =
      backend === 'databricks' ? { cluster: compute, kind: language } : { pool: compute, kind: language };
    const created = await api.createNotebookSession(link.itemId, body);
    const session: WarmSession = {
      backend,
      sessionId: created.sessionId ?? '',
      compute,
    };
    this.sessions.set(this.sessKey(link), session);
    if (created.state !== 'idle') {
      await this.pollSessionIdle(api, link, session, exec);
    }
    return session;
  }

  private async pollSessionIdle(
    api: LoomApi,
    link: NotebookLink,
    session: WarmSession,
    exec: vscode.NotebookCellExecution,
  ): Promise<void> {
    // A cold Spark pool can take 60-90s to reach idle — surface as progress.
    for (let i = 0; i < 60; i++) {
      if (exec.token.isCancellationRequested) return;
      const s = await api.getNotebookSession(link.itemId, this.sessionQuery(session));
      const state = String(s.state || '');
      if (state === 'idle') return;
      if (['error', 'dead', 'killed', 'shutting_down'].includes(state)) {
        throw new Error(`Spark session is ${state} — retry to start a fresh session.`);
      }
      await this.progress(exec, `Starting Spark session (${state || 'warming'})…`);
      await sleep(3000);
    }
    throw new Error('Spark session did not reach idle in time — the pool may be cold; try again.');
  }

  private async pollForOutput(
    api: LoomApi,
    link: NotebookLink,
    session: WarmSession,
    submit: NotebookExecResult,
    exec: vscode.NotebookCellExecution,
  ): Promise<NotebookOutput | null> {
    if (submit.stmtId === null || submit.stmtId === undefined) {
      return { status: 'ok', textPlain: '' };
    }
    for (let i = 0; i < 200; i++) {
      if (exec.token.isCancellationRequested) return null;
      const poll = await api.getNotebookCell(link.itemId, {
        ...this.sessionQuery(session),
        stmtId: submit.stmtId as string | number,
      });
      const state = String(poll.state || '');
      if (poll.output && (TERMINAL.has(state) || poll.output.status)) return poll.output;
      if (TERMINAL.has(state)) return poll.output ?? { status: state === 'error' ? 'error' : 'ok', textPlain: '' };
      await this.progress(exec, `Running (${state || 'busy'})…`);
      await sleep(1500);
    }
    return { status: 'error', evalue: 'Timed out waiting for the statement result.' };
  }

  private execBody(session: WarmSession, code: string, language: string): Record<string, unknown> {
    const base: Record<string, unknown> = { code, kind: language, sessionId: session.sessionId };
    if (session.backend === 'databricks') base.cluster = session.compute;
    else base.pool = session.compute;
    return base;
  }

  private sessionQuery(session: WarmSession): Record<string, string | number> {
    const q: Record<string, string | number> = { sessionId: session.sessionId as string | number };
    if (session.backend === 'databricks') q.cluster = session.compute;
    else q.pool = session.compute;
    return q;
  }

  private async computeTarget(link: NotebookLink, backend: string): Promise<string | undefined> {
    const key = computeKey(link);
    const saved = this.context.globalState.get<string>(key);
    if (saved) return saved;
    const value = await vscode.window.showInputBox({
      title: `Spark compute for ${link.displayName}`,
      prompt:
        backend === 'databricks'
          ? 'Databricks cluster id to run this notebook on'
          : 'Synapse Spark pool name to run this notebook on',
      ignoreFocusOut: true,
      validateInput: (v) => (v && v.trim() ? undefined : 'A compute target is required.'),
    });
    if (value && value.trim()) {
      await this.context.globalState.update(key, value.trim());
      return value.trim();
    }
    return undefined;
  }

  private async interrupt(notebook: vscode.NotebookDocument): Promise<void> {
    const link = this.links.get(notebook.uri);
    if (!link) return;
    await this.stopSession(link);
  }

  /** Kill the warm session for a link (Interrupt + View-Recent-Runs cancel). */
  async stopSession(link: NotebookLink): Promise<void> {
    const session = this.sessions.get(this.sessKey(link));
    if (!session) return;
    this.sessions.delete(this.sessKey(link));
    const api = await this.resolveApi(link.deploymentId);
    if (!api) return;
    try {
      await api.killNotebookSession(link.itemId, this.sessionQuery(session));
    } catch {
      /* already gone */
    }
  }

  /** (Re)prompt + persist the Spark pool / Databricks cluster for a notebook. */
  async setCompute(link: NotebookLink): Promise<void> {
    await this.context.globalState.update(computeKey(link), undefined);
    let backend = 'synapse';
    const api = await this.resolveApi(link.deploymentId);
    if (api) {
      try {
        backend = await api.notebookBackend(link.itemId);
      } catch {
        /* keep default label; the real gate surfaces on run */
      }
    }
    const chosen = await this.computeTarget(link, backend);
    if (chosen) vscode.window.showInformationMessage(`Spark compute for "${link.displayName}" set to ${chosen}.`);
  }

  private async render(exec: vscode.NotebookCellExecution, output: NotebookOutput): Promise<void> {
    const items: vscode.NotebookCellOutputItem[] = [];
    if (output.status === 'error' || output.ename || output.evalue) {
      const err = new Error(output.evalue || output.ename || 'Execution error');
      err.name = output.ename || 'SparkError';
      if (output.traceback?.length) err.stack = output.traceback.join('\n');
      items.push(vscode.NotebookCellOutputItem.error(err));
    } else {
      if (output.imageBase64) {
        items.push(new vscode.NotebookCellOutputItem(Buffer.from(output.imageBase64, 'base64'), 'image/png'));
      }
      if (output.textHtml) items.push(vscode.NotebookCellOutputItem.text(output.textHtml, 'text/html'));
      if (output.tableColumns && output.tableRows) {
        items.push(vscode.NotebookCellOutputItem.text(htmlTable(output.tableColumns, output.tableRows), 'text/html'));
      }
      if (output.textPlain) items.push(vscode.NotebookCellOutputItem.text(output.textPlain, 'text/plain'));
      if (items.length === 0) items.push(vscode.NotebookCellOutputItem.text('(no output)', 'text/plain'));
    }
    await exec.replaceOutput(new vscode.NotebookCellOutput(items));
  }

  private async gate(exec: vscode.NotebookCellExecution, message: string): Promise<void> {
    await exec.replaceOutput(
      new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(`⚠️ ${message}`, 'text/plain')]),
    );
    exec.end(false, Date.now());
  }

  private async failCell(exec: vscode.NotebookCellExecution, e: unknown): Promise<void> {
    // An honest 503 gate (missing Spark config) carries its exact env var — show
    // it verbatim rather than a generic error, and never a fabricated result.
    const err = new Error(this.msg(e));
    err.name = isLoomApiError(e) && e.code ? e.code : 'Error';
    await exec.replaceOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(err)]));
    exec.end(false, Date.now());
  }

  private async progress(exec: vscode.NotebookCellExecution, text: string): Promise<void> {
    await exec.replaceOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(text, 'text/plain')]));
  }

  private msg(e: unknown): string {
    if (isLoomApiError(e)) return `${e.message}${e.hint ? ` (${e.hint})` : ''}`;
    return e instanceof Error ? e.message : String(e);
  }
}

function htmlTable(columns: string[], rows: string[][]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const head = columns.map((c) => `<th style="text-align:left;padding:2px 8px">${esc(c)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${r.map((c) => `<td style="padding:2px 8px">${esc(c)}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
