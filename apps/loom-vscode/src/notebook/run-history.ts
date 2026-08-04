/**
 * RunHistory — the in-session run log behind "View Recent Runs" (N13). Every
 * cell the CSA Loom Spark controller submits records a run here with its live
 * state; a running run can be cancelled from the panel (→ `DELETE …/session`).
 *
 * These are REAL runs the controller actually submitted — never synthetic
 * sample rows (no-vaporware). The richer Fabric run detail (Spark History
 * Server, driver-log download) is deferred to a later phase (see report); this
 * is the honest, working subset over the routes that exist today.
 */
import * as vscode from 'vscode';

export type RunState = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface NotebookRun {
  id: string;
  deploymentId: string;
  itemId: string;
  displayName: string;
  language: string;
  codePreview: string;
  startedAt: number;
  endedAt?: number;
  state: RunState;
  /** Live compute session (Livy session id / Databricks context id). */
  sessionId?: string;
  /** Spark pool (Synapse) or cluster (Databricks) the run used. */
  compute?: string;
  backend?: string;
  error?: string;
}

const MAX_RUNS = 100;

export class RunHistory {
  private runs: NotebookRun[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  add(run: NotebookRun): void {
    this.runs.unshift(run);
    if (this.runs.length > MAX_RUNS) this.runs.length = MAX_RUNS;
    this._onDidChange.fire();
  }

  update(id: string, patch: Partial<NotebookRun>): void {
    const r = this.runs.find((x) => x.id === id);
    if (!r) return;
    Object.assign(r, patch);
    this._onDidChange.fire();
  }

  list(): readonly NotebookRun[] {
    return this.runs;
  }

  running(): NotebookRun[] {
    return this.runs.filter((r) => r.state === 'running');
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
