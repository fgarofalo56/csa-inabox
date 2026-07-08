/**
 * Browser-automation tool runner (AIF-18) — the Azure-native substitute for a
 * native browser-automation PaaS. Loom owns a Playwright headless-browser
 * runner and drives it from the agent's `browser_automation` function tool, so
 * the whole path stays in-VNet / Gov-portable with zero external dependency.
 *
 * Two runner shapes are supported (both opt-in, honest-gated):
 *   • LOOM_BROWSER_TOOL_ENDPOINT — a synchronous HTTP Container App runner
 *     (POST {endpoint}/run → { pageText, screenshot }). Preferred when set
 *     because it returns the page result inline for the agent turn.
 *   • LOOM_BROWSER_TOOL_JOB — the resource id of a scale-to-zero Azure Container
 *     Apps JOB (platform/fiab/bicep/modules/copilot/browser-tool.bicep). Loom
 *     starts an execution via ARM with the task passed as an env override.
 *
 * When NEITHER is set the tool honest-gates (no mock output) — the editor shows
 * a MessageBar naming LOOM_BROWSER_TOOL_JOB + the bicep module. See
 * .claude/rules/no-vaporware.md.
 */
import { DefaultAzureCredential, ManagedIdentityCredential, ChainedTokenCredential } from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope } from './cloud-endpoints';
import { fetchWithTimeout } from './fetch-with-timeout';
import { BROWSER_TOOL_ENV, BROWSER_TOOL_GATE_HINT } from './agent-tool-kinds';

const ACA_JOB_API = '2024-03-01';
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

/** Thrown when no browser runner is configured — surfaced as an honest gate. */
export class BrowserToolNotConfiguredError extends Error {
  hint: string;
  missing: string;
  constructor() {
    super('Browser-automation runner is not configured in this deployment.');
    this.name = 'BrowserToolNotConfiguredError';
    this.hint = BROWSER_TOOL_GATE_HINT;
    this.missing = BROWSER_TOOL_ENV;
  }
}

export type BrowserRunnerMode = 'endpoint' | 'job' | 'none';

export interface BrowserToolStatus {
  configured: boolean;
  mode: BrowserRunnerMode;
  /** The env var to set (always the same name so the gate copy is stable). */
  env: string;
  hint?: string;
}

function endpointRunner(): string { return (process.env.LOOM_BROWSER_TOOL_ENDPOINT || '').replace(/\/+$/, ''); }
function jobResourceId(): string { return (process.env.LOOM_BROWSER_TOOL_JOB || '').trim(); }

/** Report which runner (if any) is wired — powers the editor's honest gate. */
export function browserToolStatus(): BrowserToolStatus {
  if (endpointRunner()) return { configured: true, mode: 'endpoint', env: BROWSER_TOOL_ENV };
  if (jobResourceId()) return { configured: true, mode: 'job', env: BROWSER_TOOL_ENV };
  return { configured: false, mode: 'none', env: BROWSER_TOOL_ENV, hint: BROWSER_TOOL_GATE_HINT };
}

export interface BrowserTask {
  url: string;
  /** Ordered actions: {op:'click'|'type'|'read'|'screenshot', selector?, text?}. */
  actions?: Array<Record<string, unknown>>;
}

export interface BrowserRunResult {
  mode: BrowserRunnerMode;
  /** Synchronous HTTP runner result (endpoint mode). */
  pageText?: string;
  screenshot?: string;
  /** ACA-job execution name (job mode — async; results land in the job's sink). */
  execution?: string;
  started?: boolean;
}

async function armFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = await credential.getToken(armScope());
  if (!token?.token) throw new Error('Failed to acquire ARM token for the browser-tool job');
  return fetchWithTimeout(url, {
    ...init,
    headers: { ...(init?.headers || {}), authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
  });
}

/**
 * Run a browser task on whichever runner is configured. Throws
 * BrowserToolNotConfiguredError (honest gate) when none is — never a mock.
 */
export async function runBrowserTask(task: BrowserTask): Promise<BrowserRunResult> {
  if (!task?.url || typeof task.url !== 'string') throw new Error('browser task requires a url');

  const endpoint = endpointRunner();
  if (endpoint) {
    const res = await fetchWithTimeout(`${endpoint}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: task.url, actions: task.actions || [] }),
    });
    const text = await res.text();
    let parsed: any; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    if (!res.ok) throw new Error(`Browser runner ${res.status}: ${String(parsed?.error || text).slice(0, 300)}`);
    return { mode: 'endpoint', pageText: parsed?.pageText, screenshot: parsed?.screenshot };
  }

  const jobId = jobResourceId();
  if (jobId) {
    // Start a Container Apps Job execution, passing the task as an env override
    // on the job's single container (the Playwright runner reads BROWSER_TASK).
    const url = `${armBase()}${jobId.startsWith('/') ? '' : '/'}${jobId}/start?api-version=${ACA_JOB_API}`;
    const body = {
      template: {
        containers: [
          { name: 'browser-runner', env: [{ name: 'BROWSER_TASK', value: JSON.stringify(task) }] },
        ],
      },
    };
    const res = await armFetch(url, { method: 'POST', body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`ACA job start ${res.status}: ${text.slice(0, 300)}`);
    let parsed: any; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
    const execution = parsed?.name || parsed?.id || undefined;
    return { mode: 'job', started: true, execution };
  }

  throw new BrowserToolNotConfiguredError();
}
