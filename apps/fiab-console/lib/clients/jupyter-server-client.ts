/**
 * Azure Machine Learning Compute-Instance Jupyter Server proxy client.
 *
 * Lets the Loom notebook editor read/write `.ipynb` files on a workspace and
 * execute cells against the running CI kernel — the Azure-native, no-Fabric
 * equivalent of a Fabric notebook running on a Spark/CI kernel. Two surfaces:
 *
 *   1. Jupyter Server REST (contents + sessions + kernels), proxied through the
 *      AML CI authenticated tunnel at `https://<hostName>/jupyter/api/...`.
 *   2. The Jupyter kernel-messaging protocol (v5.3) over a WebSocket to
 *      `wss://<hostName>/jupyter/api/kernels/<kernelId>/channels` to run a cell
 *      (`execute_request` → stream / execute_result / error → execute_reply).
 *
 * Auth flow (all REST data-plane shapes verified on Microsoft Learn):
 *   POST {armBase}/subscriptions/{sub}/resourceGroups/{rg}/providers/
 *        Microsoft.MachineLearningServices/workspaces/{ws}/listNotebookAccessToken
 *        ?api-version=2024-10-01
 *   Authorization: ARM Bearer (the sovereign-cloud ARM `.default` scope, minted
 *   from the Console UAMI via ChainedTokenCredential — same identity foundry-
 *   client.ts / mlflow-client.ts use). The response carries a notebook-scoped
 *   token (`scope: aznb_identity`) plus the `hostName` of the workspace Jupyter
 *   server. That notebook token authenticates every subsequent contents /
 *   sessions / kernel call as `Authorization: Bearer <accessToken>`.
 *
 * Sovereign clouds: `armBase()` (cloud-endpoints.ts) selects the right ARM host
 * for Commercial / GCC-High / IL5, and the `hostName` returned by
 * listNotebookAccessToken already points at the cloud-correct Jupyter endpoint
 * (`*.notebooks.azure.net` / `*.azureml.us` / DoD). No host switch-statements
 * needed here. Per Azure Government guidance, notebook-token lifetimes longer
 * than 24h aren't available — we honor the `expiresIn` the response gives us
 * exactly and never try to extend it.
 *
 * Honest infra-gate: when the AML workspace/sub can't be resolved from env,
 * `jupyterCiConfig()` throws `JupyterNotConfiguredError` carrying the exact env
 * vars to set; routes surface that as a Fluent MessageBar (503) while the editor
 * still renders. No mocks, no Fabric/OneLake dependency.
 *
 * Learn references:
 *   https://learn.microsoft.com/rest/api/azureml/workspaces/list-notebook-access-token
 *   https://jupyter-server.readthedocs.io/en/latest/developers/rest-api.html
 *   https://jupyter-client.readthedocs.io/en/latest/messaging.html  (protocol v5.3)
 */
import crypto from 'node:crypto';
import type { TokenCredential } from '@azure/core-auth';
import { armBase, armScope } from '../azure/cloud-endpoints';
import type { NormalizedOutput } from '../azure/synapse-livy-client';

const ARM_SCOPE = armScope();
const NOTEBOOK_TOKEN_API_VERSION = '2024-10-01';

// Lazily construct the ARM credential so importing this module for the pure
// helpers / kernel-WS path never pulls @azure/identity into the graph (keeps
// unit tests light and avoids a hard dep at module-eval time).
let _credential: TokenCredential | null = null;
async function getCredential(): Promise<TokenCredential> {
  if (_credential) return _credential;
  const { DefaultAzureCredential, ManagedIdentityCredential, ChainedTokenCredential } =
    await import('@azure/identity');
  const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  _credential = uamiClientId
    ? new ChainedTokenCredential(
        new ManagedIdentityCredential({ clientId: uamiClientId }),
        new DefaultAzureCredential(),
      )
    : new DefaultAzureCredential();
  return _credential;
}

/** Raised when the AML workspace/sub needed for the CI Jupyter backend is unset. */
export class JupyterNotConfiguredError extends Error {
  hint: string;
  missing: string[];
  constructor(missing: string[]) {
    super('Azure ML Compute-Instance Jupyter backend is not configured in this deployment');
    this.name = 'JupyterNotConfiguredError';
    this.missing = missing;
    this.hint =
      `Set ${missing.join(' + ')} to a deployed Azure Machine Learning workspace ` +
      `with a running compute instance, then grant the Console UAMI the AzureML ` +
      `Data Scientist role on it. LOOM_AML_WORKSPACE / LOOM_AML_RG / LOOM_AML_REGION ` +
      `fall back to LOOM_FOUNDRY_NAME / LOOM_FOUNDRY_RG / LOOM_FOUNDRY_REGION when set.`;
  }
}

/** Non-2xx failure from the ARM token mint or a Jupyter REST call. */
export class JupyterError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `Jupyter server call failed (${status})`);
    this.name = 'JupyterError';
    this.status = status;
    this.body = body;
  }
}

export interface JupyterCiConfig {
  sub: string;
  rg: string;
  ws: string;
}

/**
 * Resolve the AML workspace coordinates from env. Workspace / RG / region honor
 * the task's dedicated vars first, then fall back to the Foundry hub env so an
 * already-configured Loom keeps working without new vars (an AI Foundry hub is
 * itself an `Microsoft.MachineLearningServices/workspaces`).
 */
export function jupyterCiConfig(): JupyterCiConfig {
  const missing: string[] = [];
  const sub = process.env.LOOM_SUBSCRIPTION_ID;
  if (!sub) missing.push('LOOM_SUBSCRIPTION_ID');

  const ws = process.env.LOOM_AML_WORKSPACE || process.env.LOOM_FOUNDRY_NAME;
  if (!ws) missing.push('LOOM_AML_WORKSPACE');

  if (missing.length) throw new JupyterNotConfiguredError(missing);

  const rg =
    process.env.LOOM_AML_RG ||
    process.env.LOOM_FOUNDRY_RG ||
    'rg-csa-loom-admin-eastus2';

  return { sub: sub!, rg, ws: ws! };
}

/** True when the CI Jupyter backend can be reached (env is set). No throw. */
export function isJupyterCiConfigured(): boolean {
  try {
    jupyterCiConfig();
    return true;
  } catch {
    return false;
  }
}

export interface NotebookToken {
  accessToken: string;
  hostName: string; // e.g. "abc123.notebooks.azure.net" (cloud-correct)
  expiresIn: number; // seconds, as returned — honored exactly (gov 24h cap)
  publicDns?: string; // CI FQDN, e.g. "ci.eastus2.instances.azureml.ms"
  scope?: string; // "aznb_identity"
  notebookResourceId?: string;
}

async function armAuthHeader(): Promise<string> {
  const credential = await getCredential();
  const token = await credential.getToken(ARM_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire ARM token for listNotebookAccessToken');
  return `Bearer ${token.token}`;
}

// In-process notebook-token cache keyed by sub|rg|ws. Refreshes 60s early so a
// long-running execute never trips on an expiry boundary. Honors expiresIn
// strictly (no extension beyond what ARM grants — required in Azure Government).
const tokenCache = new Map<string, { token: NotebookToken; expiresAt: number }>();

/**
 * POST .../listNotebookAccessToken — mint a notebook-scoped token + resolve the
 * workspace Jupyter host. Cached within `expiresIn`.
 */
export async function getNotebookToken(forceRefresh = false): Promise<NotebookToken> {
  const cfg = jupyterCiConfig();
  const key = `${cfg.sub}|${cfg.rg}|${cfg.ws}`;
  const now = Date.now();
  if (!forceRefresh) {
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt > now) return cached.token;
  }

  const url =
    `${armBase()}/subscriptions/${cfg.sub}/resourceGroups/${cfg.rg}` +
    `/providers/Microsoft.MachineLearningServices/workspaces/${cfg.ws}` +
    `/listNotebookAccessToken?api-version=${NOTEBOOK_TOKEN_API_VERSION}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: await armAuthHeader(), 'content-type': 'application/json' },
  });
  const text = await res.text();
  let parsed: any = undefined;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!res.ok) {
    const msg = parsed?.error?.message || parsed?.message || (typeof parsed === 'string' ? parsed : `HTTP ${res.status}`);
    throw new JupyterError(res.status, parsed, `listNotebookAccessToken ${res.status}: ${String(msg).slice(0, 280)}`);
  }
  const accessToken: string = parsed?.accessToken || parsed?.access_token;
  const hostName: string = parsed?.hostName || parsed?.host_name;
  if (!accessToken || !hostName) {
    throw new JupyterError(502, parsed, 'listNotebookAccessToken returned no accessToken/hostName');
  }
  const expiresIn: number = Number(parsed?.expiresIn ?? parsed?.expires_in ?? 3600);
  const token: NotebookToken = {
    accessToken,
    hostName,
    expiresIn,
    publicDns: parsed?.publicDns || parsed?.public_dns,
    scope: parsed?.scope,
    notebookResourceId: parsed?.notebookResourceId || parsed?.notebook_resource_id,
  };
  // Refresh 60s before the granted lifetime; never beyond it.
  tokenCache.set(key, { token, expiresAt: now + Math.max(0, (expiresIn - 60) * 1000) });
  return token;
}

/** Clear the cached notebook token (used by tests / on 401 retry). */
export function _clearNotebookTokenCache(): void {
  tokenCache.clear();
}

// ============================================================
// Jupyter Server REST (contents + sessions)
// ============================================================

export interface JupyterContentsModel {
  name: string;
  path: string;
  type: 'notebook' | 'file' | 'directory';
  format?: string | null;
  mimetype?: string | null;
  writable?: boolean;
  created?: string;
  last_modified?: string;
  size?: number | null;
  content?: unknown;
}

function encodePath(p: string): string {
  // Jupyter contents paths are slash-delimited; encode each segment but keep '/'.
  return p
    .replace(/^\/+/, '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/** Low-level Jupyter REST fetch with the notebook bearer token. */
export async function jupyterFetch(
  hostName: string,
  accessToken: string,
  apiPath: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = `https://${hostName}/jupyter/api${apiPath.startsWith('/') ? apiPath : `/${apiPath}`}`;
  return fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
  });
}

async function jupyterJson<T>(res: Response, ctx: string): Promise<T> {
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!res.ok) {
    const msg =
      (parsed as any)?.message ||
      (parsed as any)?.reason ||
      (typeof parsed === 'string' ? parsed : `HTTP ${res.status}`);
    throw new JupyterError(res.status, parsed, `${ctx} ${res.status}: ${String(msg).slice(0, 280)}`);
  }
  return (parsed as T) ?? ({} as T);
}

/** GET /api/contents/{path} — read a notebook/file/directory model. */
export async function contentsGet(
  token: NotebookToken,
  path: string,
  opts: { content?: boolean } = {},
): Promise<JupyterContentsModel> {
  const content = opts.content === false ? '0' : '1';
  const res = await jupyterFetch(
    token.hostName,
    token.accessToken,
    `/contents/${encodePath(path)}?content=${content}`,
    { method: 'GET' },
  );
  return jupyterJson<JupyterContentsModel>(res, `contentsGet(${path})`);
}

/**
 * PUT /api/contents/{path} — upsert a notebook/file. `content` is the parsed
 * `.ipynb` object for a notebook (the Jupyter contents API stores it as JSON).
 */
export async function contentsPut(
  token: NotebookToken,
  path: string,
  content: unknown,
  type: 'notebook' | 'file' = 'notebook',
): Promise<JupyterContentsModel> {
  const name = path.replace(/^\/+/, '').split('/').pop() || path;
  const body: Record<string, unknown> =
    type === 'notebook'
      ? { type: 'notebook', format: 'json', content, name, path }
      : { type: 'file', format: 'text', content: typeof content === 'string' ? content : JSON.stringify(content), name, path };
  const res = await jupyterFetch(
    token.hostName,
    token.accessToken,
    `/contents/${encodePath(path)}`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
  return jupyterJson<JupyterContentsModel>(res, `contentsPut(${path})`);
}

export interface JupyterSession {
  sessionId: string;
  kernelId: string;
  state?: string;
}

/** POST /api/sessions — allocate a kernel on a running CI for `notebookPath`. */
export async function sessionsCreate(
  token: NotebookToken,
  notebookPath: string,
  kernelName = 'python3',
): Promise<JupyterSession> {
  const cleanPath = notebookPath.replace(/^\/+/, '');
  const body = {
    path: cleanPath,
    name: cleanPath.split('/').pop() || cleanPath,
    type: 'notebook',
    kernel: { name: kernelName },
  };
  const res = await jupyterFetch(token.hostName, token.accessToken, '/sessions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const j = await jupyterJson<any>(res, `sessionsCreate(${notebookPath})`);
  const kernelId = j?.kernel?.id;
  if (!j?.id || !kernelId) throw new JupyterError(502, j, 'sessionsCreate returned no session/kernel id');
  return { sessionId: j.id, kernelId, state: j?.kernel?.execution_state };
}

/** GET /api/sessions/{id} — poll session/kernel state. */
export async function sessionsGet(token: NotebookToken, sessionId: string): Promise<JupyterSession> {
  const res = await jupyterFetch(token.hostName, token.accessToken, `/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'GET',
  });
  const j = await jupyterJson<any>(res, `sessionsGet(${sessionId})`);
  return { sessionId: j?.id || sessionId, kernelId: j?.kernel?.id || '', state: j?.kernel?.execution_state };
}

/** DELETE /api/sessions/{id} — kill the session (404/already-gone is success). */
export async function sessionsDelete(token: NotebookToken, sessionId: string): Promise<void> {
  const res = await jupyterFetch(token.hostName, token.accessToken, `/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
  if (res.ok || res.status === 404) return;
  await jupyterJson(res, `sessionsDelete(${sessionId})`);
}

// ============================================================
// Output normalizer (pure)
// ============================================================

function joinMaybeArray(v: unknown): string | undefined {
  if (v == null) return undefined;
  return Array.isArray(v) ? v.join('') : String(v);
}

/**
 * Normalize Jupyter kernel-message outputs into the `NormalizedOutput` shape the
 * notebook editor already renders for Livy/Databricks. Pure — no network.
 *   - stream chunks (stdout/stderr) → accumulated textPlain
 *   - execute_result/display_data `data` mime bundle → text/plain | text/html |
 *     image/png
 *   - error (ename/evalue/traceback) → status:'error'
 */
export function normalizeJupyterOutput(
  streamChunks: string[],
  executeResult: Record<string, unknown> | null,
  errorMsg: { ename?: string; evalue?: string; traceback?: string[] } | null,
): NormalizedOutput {
  const streamText = (streamChunks || []).join('');

  if (errorMsg) {
    return {
      status: 'error',
      ename: errorMsg.ename,
      evalue: errorMsg.evalue,
      traceback: Array.isArray(errorMsg.traceback) ? errorMsg.traceback : undefined,
      textPlain: streamText || undefined,
    };
  }

  const out: NormalizedOutput = { status: 'ok' };
  const data = (executeResult?.data as Record<string, unknown>) || null;

  const resultText = data ? joinMaybeArray(data['text/plain']) : undefined;
  const combined = [streamText, resultText].filter((s) => s != null && s !== '').join('');
  if (combined) out.textPlain = combined;

  if (data) {
    const html = joinMaybeArray(data['text/html']);
    if (html) out.textHtml = html;
    const png = data['image/png'];
    if (typeof png === 'string' && png) out.imageBase64 = png.startsWith('data:image') ? png.split(',')[1] : png;
  }

  return out;
}

// ============================================================
// Kernel WebSocket execute (Jupyter messaging protocol v5.3)
// ============================================================

interface JupyterMsgHeader {
  msg_id: string;
  session: string;
  username?: string;
  date?: string;
  msg_type: string;
  version: string;
}

function buildExecuteRequest(code: string, sessionUuid: string): { msgId: string; envelope: string } {
  const msgId = crypto.randomUUID();
  const header: JupyterMsgHeader = {
    msg_id: msgId,
    session: sessionUuid,
    username: 'loom',
    date: new Date().toISOString(),
    msg_type: 'execute_request',
    version: '5.3',
  };
  const envelope = {
    header,
    parent_header: {},
    metadata: {},
    content: {
      code,
      silent: false,
      store_history: true,
      user_expressions: {},
      allow_stdin: false,
      stop_on_error: true,
    },
    channel: 'shell',
    buffers: [] as unknown[],
  };
  return { msgId, envelope: JSON.stringify(envelope) };
}

/**
 * Open the kernel channels WebSocket, send one `execute_request`, collect
 * stream / execute_result / display_data / error frames until the matching
 * `execute_reply`, then resolve a `NormalizedOutput`. Uses the global WebSocket
 * (undici on Node 22 — supports the non-standard `{ headers }` init for the
 * bearer token); the token is also passed as a `?token=` query param, which the
 * Jupyter server accepts, so auth works regardless of header support.
 */
export async function executeViaKernelWs(
  token: NotebookToken,
  kernelId: string,
  sessionId: string,
  code: string,
  timeoutMs = 120_000,
): Promise<NormalizedOutput> {
  const WS: typeof WebSocket | undefined = (globalThis as any).WebSocket;
  if (typeof WS !== 'function') {
    throw new Error(
      'Global WebSocket is unavailable in this runtime (Node < 21). Upgrade the ' +
        'Container App runtime to Node 22, or add the `ws` package, to use the AML CI kernel backend.',
    );
  }

  const sessionUuid = sessionId || crypto.randomUUID();
  const wsUrl =
    `wss://${token.hostName}/jupyter/api/kernels/${encodeURIComponent(kernelId)}/channels` +
    `?session_id=${encodeURIComponent(sessionUuid)}&token=${encodeURIComponent(token.accessToken)}`;

  const { msgId, envelope } = buildExecuteRequest(code, sessionUuid);

  return new Promise<NormalizedOutput>((resolve, reject) => {
    let settled = false;
    const streamChunks: string[] = [];
    let executeResult: Record<string, unknown> | null = null;
    let errorMsg: { ename?: string; evalue?: string; traceback?: string[] } | null = null;

    let ws: WebSocket;
    try {
      // undici WebSocket accepts an init object with `headers` (non-standard);
      // a mocked global WebSocket in tests ignores the 2nd arg.
      ws = new (WS as any)(wsUrl, { headers: { Authorization: `Bearer ${token.accessToken}` } });
    } catch {
      ws = new (WS as any)(wsUrl);
    }

    const timer = setTimeout(() => {
      finish(() => reject(new JupyterError(504, null, `kernel execute timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    function finish(action: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* noop */ }
      action();
    }

    function resolveOutput() {
      finish(() => resolve(normalizeJupyterOutput(streamChunks, executeResult, errorMsg)));
    }

    ws.onopen = () => {
      try { ws.send(envelope); } catch (e: any) {
        finish(() => reject(new JupyterError(502, null, `failed to send execute_request: ${e?.message || e}`)));
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      let msg: any;
      try {
        const raw = typeof event.data === 'string' ? event.data : String(event.data);
        msg = JSON.parse(raw);
      } catch {
        return; // ignore non-JSON / binary frames
      }
      // Only correlate replies to our request (parent_header.msg_id === msgId).
      const parentId = msg?.parent_header?.msg_id;
      if (parentId && parentId !== msgId) return;

      const msgType = msg?.header?.msg_type;
      const content = msg?.content || {};
      switch (msgType) {
        case 'stream':
          if (typeof content.text === 'string') streamChunks.push(content.text);
          break;
        case 'execute_result':
        case 'display_data':
          if (content.data) executeResult = { data: content.data };
          break;
        case 'error':
          errorMsg = {
            ename: content.ename,
            evalue: content.evalue,
            traceback: Array.isArray(content.traceback) ? content.traceback : undefined,
          };
          break;
        case 'execute_reply':
          // Terminal for our request. If the kernel reported error but emitted
          // no `error` message, synthesize one from the reply payload.
          if (content.status === 'error' && !errorMsg) {
            errorMsg = {
              ename: content.ename,
              evalue: content.evalue,
              traceback: Array.isArray(content.traceback) ? content.traceback : undefined,
            };
          }
          resolveOutput();
          break;
        default:
          break;
      }
    };

    ws.onerror = (ev: Event) => {
      finish(() => reject(new JupyterError(502, ev, 'kernel WebSocket error')));
    };

    ws.onclose = () => {
      // If the socket closed before execute_reply, resolve with whatever we have
      // (stream/result/error) rather than hang.
      if (!settled) resolveOutput();
    };
  });
}
