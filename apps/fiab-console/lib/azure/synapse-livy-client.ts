/**
 * Synapse Spark Livy interactive-session client — F16 per-cell notebook
 * execution. Talks to the Synapse dev endpoint Livy API:
 *
 *   https://{ws}.dev.azuresynapse.net/livyApi/versions/2019-11-01-preview
 *     /sparkPools/{pool}/sessions[...]
 *
 * Adds, beyond what synapse-dev-client.ts already had:
 *   - killLivySession    (DELETE .../sessions/{id})    — session teardown
 *   - keepaliveLivySession (PUT .../sessions/{id}/keepalive) — idle reset
 *   - parseMagicKind / parseConfigureMagic — Synapse %%-magic interception
 *   - normalizeLivyOutput — text/plain, text/html, application/json (df) → table,
 *     image/png passthrough for display(df) rich rendering
 *   - resolveNotebookBackend — LOOM_NOTEBOOK_BACKEND opt-in routing
 *
 * Auth: ChainedTokenCredential(UAMI, DefaultAzureCredential), DEV_SCOPE
 * (https://dev.azuresynapse.net/.default) — identical to synapse-dev-client.
 * The console UAMI needs the Synapse data-plane role "Synapse Compute Operator"
 * at the Spark-pool scope to submit interactive sessions/statements (granted by
 * the consoleSparkSubmitRoleScript deployment-script in synapse.bicep).
 *
 * No mocks. Every network call hits the real Livy REST surface and surfaces
 * errors verbatim. synapse-dev-client re-exports the session/statement helpers
 * from here for backward-compat with the existing run-cell route.
 *
 * Learn:
 *   https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/create-spark-session
 *   https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/create-spark-statement
 *   https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/get-spark-statement
 *   https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-development-using-notebooks (magic commands)
 */

import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';

const DEV_SCOPE = 'https://dev.azuresynapse.net/.default';
const LIVY_API = '2019-11-01-preview';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

function ws(): string {
  const v = process.env.LOOM_SYNAPSE_WORKSPACE;
  if (!v) throw new Error('Missing env var: LOOM_SYNAPSE_WORKSPACE');
  return v;
}

function devBase(): string {
  return `https://${ws()}.dev.azuresynapse.net`;
}

function livyBase(pool: string): string {
  return `${devBase()}/livyApi/versions/${LIVY_API}/sparkPools/${encodeURIComponent(pool)}`;
}

async function callDev(url: string, init?: RequestInit): Promise<Response> {
  const tok = await credential.getToken(DEV_SCOPE);
  if (!tok?.token) throw new Error('Failed to acquire Synapse dev token');
  return fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${tok.token}`,
      'content-type': 'application/json',
    },
  });
}

async function jsonOrThrow<T>(r: Response, label: string): Promise<T> {
  if (!r.ok && r.status !== 202) {
    throw new Error(`${label} failed ${r.status}: ${await r.text()}`);
  }
  const text = await r.text();
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; }
  catch { return {} as T; }
}

// ============================================================
// Types
// ============================================================

export type LivyKind = 'pyspark' | 'spark' | 'sql' | 'sparkr';
export type MagicKind = LivyKind;

export interface LivySessionOptions {
  kind: LivyKind;
  name?: string;
  driverMemory?: string;
  driverCores?: number;
  executorMemory?: string;
  executorCores?: number;
  numExecutors?: number;
  conf?: Record<string, string>;
}

export interface LivySession {
  id: number;
  state: string;
  kind?: string;
  appId?: string | null;
  appInfo?: { sparkUiUrl?: string; driverLogUrl?: string } | null;
  log?: string[];
}

export interface LivyStatementOutput {
  status: 'ok' | 'error';
  execution_count?: number;
  data?: {
    'text/plain'?: string | string[];
    'text/html'?: string | string[];
    'application/json'?: unknown;
    'image/png'?: string;
  };
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export interface LivyStatement {
  id: number;
  state: string;
  output?: LivyStatementOutput | null;
  progress?: number;
}

export interface NormalizedOutput {
  status: 'ok' | 'error';
  textPlain?: string;
  textHtml?: string;
  tableColumns?: string[];
  tableRows?: string[][];
  imageBase64?: string;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

// ============================================================
// Session lifecycle
// ============================================================

export async function createLivySession(
  poolName: string,
  opts: LivySessionOptions,
): Promise<LivySession> {
  const body: Record<string, unknown> = {
    kind: opts.kind,
    name: opts.name || `loom-session-${Date.now()}`,
    driverMemory: opts.driverMemory || '4g',
    driverCores: opts.driverCores ?? 4,
    executorMemory: opts.executorMemory || '4g',
    executorCores: opts.executorCores ?? 4,
    numExecutors: opts.numExecutors ?? 2,
  };
  if (opts.conf && Object.keys(opts.conf).length) body.conf = opts.conf;
  const r = await callDev(`${livyBase(poolName)}/sessions`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return jsonOrThrow<LivySession>(r, `createLivySession(${poolName})`);
}

export async function getLivySession(poolName: string, sessionId: number): Promise<LivySession> {
  const r = await callDev(`${livyBase(poolName)}/sessions/${sessionId}`);
  return jsonOrThrow<LivySession>(r, `getLivySession(${poolName}/${sessionId})`);
}

/**
 * Kill an interactive Livy session (DELETE). Returns {"msg":"deleted"} on
 * success. A 404 means the session is already gone — treat as success so the
 * editor's kill-on-unmount never throws.
 */
export async function killLivySession(poolName: string, sessionId: number): Promise<void> {
  const r = await callDev(`${livyBase(poolName)}/sessions/${sessionId}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 200 && r.status !== 204 && r.status !== 404) {
    throw new Error(`killLivySession failed ${r.status}: ${await r.text()}`);
  }
}

/**
 * Reset the session idle-timeout clock (PUT .../keepalive). The editor calls
 * this every ~4 minutes while a notebook is open so a warm session survives
 * between cell runs. A 404 means the session already died — swallow it.
 */
export async function keepaliveLivySession(poolName: string, sessionId: number): Promise<void> {
  const r = await callDev(`${livyBase(poolName)}/sessions/${sessionId}/keepalive`, { method: 'PUT' });
  if (!r.ok && r.status !== 200 && r.status !== 204 && r.status !== 404) {
    throw new Error(`keepaliveLivySession failed ${r.status}: ${await r.text()}`);
  }
}

// ============================================================
// Statements
// ============================================================

export async function submitLivyStatement(
  poolName: string,
  sessionId: number,
  code: string,
  kind: LivyKind,
): Promise<LivyStatement> {
  const r = await callDev(`${livyBase(poolName)}/sessions/${sessionId}/statements`, {
    method: 'POST',
    body: JSON.stringify({ code, kind }),
  });
  return jsonOrThrow<LivyStatement>(r, `submitLivyStatement(${poolName}/${sessionId})`);
}

export async function getLivyStatement(
  poolName: string,
  sessionId: number,
  stmtId: number,
): Promise<LivyStatement> {
  const r = await callDev(`${livyBase(poolName)}/sessions/${sessionId}/statements/${stmtId}`);
  return jsonOrThrow<LivyStatement>(r, `getLivyStatement(${poolName}/${sessionId}/${stmtId})`);
}

// ============================================================
// Magic-command parsing (pure — no network; server + client safe)
// ============================================================

const MAGIC_KINDS: Record<string, MagicKind> = {
  '%%pyspark': 'pyspark',
  '%%python': 'pyspark',
  '%%spark': 'spark',
  '%%scala': 'spark',
  '%%sql': 'sql',
  '%%sparksql': 'sql',
  '%%sparkr': 'sparkr',
  '%%r': 'sparkr',
};

/**
 * Detect a leading Synapse language magic (%%pyspark / %%spark / %%sql /
 * %%sparkr and aliases) on the first non-empty line. Returns the resolved
 * statement `kind` plus the source with the magic line stripped (so Livy runs
 * the body, not the magic). Returns null when there is no language magic.
 */
export function parseMagicKind(source: string): { kind: MagicKind; strippedCode: string } | null {
  const lines = source.split('\n');
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') { firstIdx = i; break; }
  }
  if (firstIdx < 0) return null;
  const first = lines[firstIdx].trim().toLowerCase();
  // Match the magic token (allow a trailing space + args, e.g. "%%sql -q").
  const token = first.split(/\s+/)[0];
  const kind = MAGIC_KINDS[token];
  if (!kind) return null;
  const stripped = [...lines.slice(0, firstIdx), ...lines.slice(firstIdx + 1)].join('\n');
  return { kind, strippedCode: stripped };
}

/**
 * Parse a `%%configure` magic cell. The JSON body after the magic line is
 * merged into the Livy session-create body. Per Synapse semantics %%configure
 * must be the first code cell and the session must be (re)created for it to
 * take effect. Returns the parsed session options, or null when the cell is not
 * a %%configure cell. Throws when the JSON body is malformed (surfaced to the
 * user — no silent swallow).
 */
export function parseConfigureMagic(source: string): Partial<LivySessionOptions> | null {
  const lines = source.split('\n');
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') { firstIdx = i; break; }
  }
  if (firstIdx < 0) return null;
  const first = lines[firstIdx].trim().toLowerCase();
  if (!first.split(/\s+/)[0].startsWith('%%configure')) return null;
  const bodyText = lines.slice(firstIdx + 1).join('\n').trim();
  if (!bodyText) return {};
  let parsed: any;
  try { parsed = JSON.parse(bodyText); }
  catch (e: any) { throw new Error(`%%configure body is not valid JSON: ${e?.message || e}`); }
  if (parsed == null || typeof parsed !== 'object') return {};
  const opts: Partial<LivySessionOptions> = {};
  if (typeof parsed.driverMemory === 'string') opts.driverMemory = parsed.driverMemory;
  if (typeof parsed.driverCores === 'number') opts.driverCores = parsed.driverCores;
  if (typeof parsed.executorMemory === 'string') opts.executorMemory = parsed.executorMemory;
  if (typeof parsed.executorCores === 'number') opts.executorCores = parsed.executorCores;
  if (typeof parsed.numExecutors === 'number') opts.numExecutors = parsed.numExecutors;
  if (parsed.conf && typeof parsed.conf === 'object') {
    const conf: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.conf)) conf[k] = String(v);
    opts.conf = conf;
  }
  return opts;
}

// ============================================================
// Backend resolver
// ============================================================

/**
 * Azure-native default: Synapse Spark Livy. Databricks and the AML Compute-
 * Instance Jupyter kernel (`aml-ci`) are strictly opt-in via
 * LOOM_NOTEBOOK_BACKEND (per no-fabric-dependency.md the default path must never
 * require an opt-in backend). Any other value falls back to Synapse silently.
 */
export function resolveNotebookBackend(): 'synapse' | 'databricks' | 'aml-ci' {
  const v = (process.env.LOOM_NOTEBOOK_BACKEND || '').trim().toLowerCase();
  if (v === 'databricks') return 'databricks';
  if (v === 'aml-ci' || v === 'aml' || v === 'jupyter') return 'aml-ci';
  return 'synapse';
}

// ============================================================
// Output normalizer (server-side)
// ============================================================

function joinMaybeArray(v: string | string[] | undefined): string | undefined {
  if (v == null) return undefined;
  return Array.isArray(v) ? v.join('') : String(v);
}

const MAX_TABLE_ROWS = 200;

/**
 * Normalize a Livy statement output into the shape the editor renders:
 *   - text/plain  → textPlain
 *   - text/html   → textHtml (Synapse display(df) emits an HTML table here)
 *   - application/json with {schema:{fields},data} → tableColumns + tableRows
 *     (Vega-Lite / df json — the live rendered DataFrame grid)
 *   - image/png   → imageBase64 (matplotlib display output)
 *   - error       → ename/evalue/traceback
 */
export function normalizeLivyOutput(output: LivyStatementOutput | null | undefined): NormalizedOutput | null {
  if (!output) return null;
  if (output.status === 'error') {
    return {
      status: 'error',
      ename: output.ename,
      evalue: output.evalue,
      traceback: Array.isArray(output.traceback) ? output.traceback : undefined,
    };
  }
  const data = output.data || {};
  const norm: NormalizedOutput = { status: 'ok' };
  norm.textPlain = joinMaybeArray(data['text/plain']);
  const html = joinMaybeArray(data['text/html']);
  if (html) norm.textHtml = html;
  const png = data['image/png'];
  if (typeof png === 'string' && png) norm.imageBase64 = png;

  const appJson: any = data['application/json'];
  if (appJson && typeof appJson === 'object') {
    const fields = appJson?.schema?.fields;
    const rows = appJson?.data;
    if (Array.isArray(fields) && Array.isArray(rows)) {
      norm.tableColumns = fields.map((f: any) => String(f?.name ?? ''));
      norm.tableRows = rows.slice(0, MAX_TABLE_ROWS).map((row: any) => {
        if (Array.isArray(row)) return row.map((c: any) => (c == null ? '' : String(c)));
        // object rows keyed by column name
        return (norm.tableColumns || []).map((col) => {
          const c = row?.[col];
          return c == null ? '' : String(c);
        });
      });
    }
  }
  return norm;
}
