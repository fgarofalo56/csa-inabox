/**
 * Phase 2 — shared seeder helper for the Logic Apps provisioner.
 *
 * After the Microsoft.Logic/workflows resource is created/updated from the
 * bundle's WDL definition, this helper proves the workflow is REAL by firing
 * its manual trigger and polling the workflow run history until terminal —
 * the Logic Apps analogue of data-pipeline.ts's on-demand pipeline run.
 *
 * Real ARM REST only (no mocks). Endpoints (api-version 2016-06-01):
 *   POST {workflowUrl}/triggers/{triggerName}/run   — fire the trigger
 *     https://learn.microsoft.com/rest/api/logic/workflow-triggers/run
 *   GET  {workflowUrl}/runs                          — list run history
 *     https://learn.microsoft.com/rest/api/logic/workflow-runs/list
 *   Run statuses: Running | Succeeded | Failed | Cancelled | Aborted | Waiting
 *     https://learn.microsoft.com/azure/logic-apps/view-workflow-status-run-history
 */

import { LOGIC_API } from './logic-app';

type ArmFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface WorkflowRunResult {
  /** True when the manual trigger fired. */
  triggered: boolean;
  /** The workflow run name (history id), once resolved. */
  runName?: string;
  /** Latest observed status. */
  status?: string;
  /** Failure detail when the run failed. */
  failureReason?: string;
  /** Step log lines for the provisioner's steps[]. */
  steps: string[];
  /** Set when the trigger run was rejected for auth (401/403). The workflow
   * itself was already created; the provisioner maps this to remediation. */
  authGate?: { status: number; message: string };
}

const TERMINAL = new Set(['Succeeded', 'Failed', 'Cancelled', 'Aborted', 'TimedOut']);

interface RunRow {
  name?: string;
  properties?: { status?: string; startTime?: string; error?: { code?: string; message?: string } };
}

async function listRuns(callArm: ArmFetch, workflowUrl: string): Promise<RunRow[]> {
  const r = await callArm(`${workflowUrl}/runs?api-version=${LOGIC_API}&$top=10`);
  if (!r.ok) return [];
  const body = await r.json().catch(() => ({}));
  return Array.isArray(body?.value) ? (body.value as RunRow[]) : [];
}

/**
 * Fire the workflow's manual trigger, then poll run history for the new run
 * until it reaches a terminal status or the budget elapses. Never throws —
 * returns a structured result the provisioner folds into its ProvisionResult.
 *
 * @param callArm     bearer-authenticated ARM fetch (from logic-app.ts)
 * @param workflowUrl the management.azure.com workflow resource URL (no query)
 * @param triggerName the WDL trigger to fire (first trigger in the definition)
 * @param opts.maxPolls max GET-runs polls (default 6)
 * @param opts.pollMs   delay between polls in ms (default 5000)
 */
export async function triggerAndPollWorkflowRun(
  callArm: ArmFetch,
  workflowUrl: string,
  triggerName: string,
  opts: { maxPolls?: number; pollMs?: number } = {},
): Promise<WorkflowRunResult> {
  const steps: string[] = [];
  const maxPolls = opts.maxPolls ?? 6;
  const pollMs = opts.pollMs ?? 5000;

  // Snapshot existing runs so we can pick out the one our trigger creates.
  let before = new Set<string>();
  try {
    const prior = await listRuns(callArm, workflowUrl);
    before = new Set(prior.map((r) => r.name || '').filter(Boolean));
  } catch {
    /* empty history is fine */
  }

  // POST .../triggers/{triggerName}/run — fire the manual trigger.
  try {
    const r = await callArm(
      `${workflowUrl}/triggers/${encodeURIComponent(triggerName)}/run?api-version=${LOGIC_API}`,
      { method: 'POST' },
    );
    if (r.status === 401 || r.status === 403) {
      const msg = await r.text().catch(() => '');
      return { triggered: false, steps, authGate: { status: r.status, message: msg.slice(0, 240) } };
    }
    // 200 / 202 both mean accepted. A polling/recurrence trigger returns 202
    // ("Accepted"); a Request trigger returns 200 with the response body.
    if (!r.ok && r.status !== 202) {
      steps.push(`Manual trigger '${triggerName}' could not run (HTTP ${r.status}); definition is still live.`);
      return { triggered: false, steps };
    }
    steps.push(`Fired manual trigger '${triggerName}'.`);
  } catch (e: any) {
    steps.push(`Trigger run could not be issued: ${e?.message || String(e)}`);
    return { triggered: false, steps };
  }

  // Poll run history for the new run + terminal status.
  let resolved: RunRow | undefined;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((res) => setTimeout(res, pollMs));
    let runs: RunRow[] = [];
    try {
      runs = await listRuns(callArm, workflowUrl);
    } catch (e: any) {
      steps.push(`Run-history poll ${i + 1} failed: ${e?.message || String(e)}`);
      continue;
    }
    const fresh = runs.filter((r) => r.name && !before.has(r.name));
    const pool = fresh.length > 0 ? fresh : runs;
    pool.sort((a, b) => (b.properties?.startTime || '').localeCompare(a.properties?.startTime || ''));
    resolved = pool[0];
    if (resolved?.properties?.status && TERMINAL.has(resolved.properties.status)) break;
  }

  if (!resolved) {
    steps.push('Trigger fired but no run surfaced in history within the poll budget (Logic Apps is still scheduling it).');
    return { triggered: true, steps };
  }

  const status = resolved.properties?.status || 'Running';
  steps.push(`Workflow run ${resolved.name} → ${status}.`);
  const failureReason = resolved.properties?.error?.message
    || (resolved.properties?.error?.code ? `code=${resolved.properties.error.code}` : undefined);
  if (failureReason) steps.push(`Failure reason: ${failureReason}`);

  return { triggered: true, runName: resolved.name, status, failureReason, steps };
}
