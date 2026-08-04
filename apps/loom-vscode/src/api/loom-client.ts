/**
 * LoomApi — the extension's transport, a thin wrapper over `@csa-loom/sdk`.
 *
 * Reuse-not-reimplement (PRP §2.2, task directive): the bulk of the surface is
 * the SDK's own typed client —
 *   • `client.workspaces.list()`   → GET  /api/workspaces
 *   • `client.items.list()`        → GET  /api/workspaces/:id/items
 *   • `client.items.update()`      → PATCH /api/cosmos-items/:type/:id   (rename)
 *   • `client.items.delete()`      → DELETE /api/cosmos-items/:type/:id
 *   • `client.whoami()`            → GET  /api/v1/whoami   (identity + PAT scope)
 * The SDK's `HttpTransport` (bearer-PAT OR cookie auth, envelope normalization,
 * `LoomApiError`) does the work. Two routes the SDK class does not model are
 * called with a small `raw()` helper that REUSES the SDK's `LoomApiError`,
 * `COOKIE_NAME` and `normalizeBaseUrl` so the error/auth contract is identical:
 *   • POST /api/cosmos-items/:type   (create — the route the Console NewItemGate
 *     uses; PRP W3)
 *   • GET  /api/auth/me              (flat identity for the status bar; PRP A5)
 *
 * Auth is per-deployment: a device-code `loom_session` cookie OR a scoped PAT.
 * Both are supported natively by the SDK's transport.
 */

import {
  LoomClient,
  LoomApiError,
  isLoomApiError,
  normalizeBaseUrl,
  COOKIE_NAME,
  type Workspace,
  type Item,
  type WhoAmI,
  type CatalogSearchResult,
  type CatalogSearchOptions,
  type QueryResult,
} from '@csa-loom/sdk';

export { LoomApiError, isLoomApiError };
export type { Workspace, Item, WhoAmI, CatalogSearchResult, QueryResult };

import type { DefinitionPayload, DefinitionTransport } from '../fs/loom-fs-core';
import type {
  GitStatusResponse,
  GitCommitResponse,
  GitPullResponse,
  GitResolveResponse,
  GitGateReason,
} from '../git/git-model';
import { isGitGateBody } from '../git/git-model';
import type { SparkBatchJob } from '../spark-job/spark-job-model';

/** A per-deployment credential held in SecretStorage. */
export type Credential =
  | { kind: 'cookie'; value: string }
  | { kind: 'pat'; value: string };

/** Flat identity shape returned by `GET /api/auth/me`. */
export interface MeResult {
  ok: boolean;
  oid?: string;
  upn?: string;
  email?: string;
  name?: string;
}

/** Raw `GET /api/catalog/find` envelope (mapped by `query/search-model.ts`). */
export interface CatalogFindResponse {
  ok?: boolean;
  q?: string;
  backend?: string;
  total?: number;
  workspacesSearched?: number;
  hits?: Array<{
    id: string;
    workspaceId: string;
    workspaceName: string;
    itemType: string;
    displayName: string;
    description?: string;
    tags?: string[];
    updatedAt?: string;
    url?: string;
    score?: number;
  }>;
}

/**
 * A 412 from `PUT …/definition` — the item changed since the client last read
 * it. The Publish command catches this to open a diff (N5) instead of clobbering.
 */
export class DefinitionConflictError extends LoomApiError {
  constructor(readonly currentEtag?: string) {
    super('The item changed since you loaded it (412 Precondition Failed).', 412, 'precondition_failed');
    this.name = 'DefinitionConflictError';
  }
}

/**
 * An honest Git gate (Phase 5, W9/W10) — the `/api/git-integration/*` routes
 * answer 424 `{ gated:true, missing }` (or a KV 503) when no repo is bound / no
 * PAT / no Key Vault. The command turns `missing` into a named remediation +
 * Fix-it, NEVER a fabricated status.
 */
export class GitGateError extends LoomApiError {
  constructor(
    readonly missing: GitGateReason,
    readonly detail: string | undefined,
    status: number,
  ) {
    super(detail || `Git integration is not configured (${missing}).`, status, String(missing));
    this.name = 'GitGateError';
  }
}

/** `POST …/spark-job-definition/[id]/submit` result. */
export interface SparkSubmitResult {
  ok: boolean;
  pool?: string;
  job?: SparkBatchJob;
}

/** `GET …/spark-job-definition/[id]/runs` result. */
export interface SparkRunsResult {
  ok: boolean;
  pool?: string;
  from?: number;
  total?: number;
  sessions?: SparkBatchJob[];
}

/** `POST …/spark-job-definition/[id]/files` result. */
export interface SparkFileUploadResult {
  ok: boolean;
  filename?: string;
  path?: string;
  abfssPath?: string;
  size?: number;
}

/** Normalized rich output for a notebook statement (mirrors the route). */
export interface NotebookOutput {
  status?: 'ok' | 'error' | string;
  textPlain?: string;
  textHtml?: string;
  tableColumns?: string[];
  tableRows?: string[][];
  imageBase64?: string;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

/** `POST/GET …/session` result. */
export interface NotebookSessionResult {
  ok: boolean;
  backend?: string;
  sessionId?: number | string;
  clusterId?: string;
  state?: string;
  appInfo?: Record<string, unknown>;
}

/** `POST/GET …/execute` result. */
export interface NotebookExecResult {
  ok: boolean;
  backend?: string;
  sessionId?: number | string;
  stmtId?: number | string | null;
  state?: string;
  output?: NotebookOutput | null;
  sessionWarming?: boolean;
  sessionDead?: boolean;
  configureApplied?: boolean;
  progress?: number;
}

/** Build a query string from a param map (values URL-encoded). */
function qs(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

export class LoomApi implements DefinitionTransport {
  readonly baseUrl: string;
  private readonly client: LoomClient;
  private readonly cred: Credential;
  constructor(baseUrl: string, cred: Credential) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.cred = cred;
    this.client = new LoomClient(
      cred.kind === 'pat' ? { baseUrl, token: cred.value } : { baseUrl, cookie: cred.value },
    );
  }

  // --- SDK-covered operations ---------------------------------------------

  /** List workspaces (with item counts). */
  listWorkspaces(): Promise<Workspace[]> {
    return this.client.workspaces.list({ count: true });
  }

  /** List items in a workspace. */
  listItems(workspaceId: string): Promise<Item[]> {
    return this.client.items.list(workspaceId);
  }

  /** Rename an item (PATCH displayName). */
  renameItem(type: string, id: string, displayName: string): Promise<Item> {
    return this.client.items.update(type, id, { displayName });
  }

  /** Delete an item. */
  deleteItem(type: string, id: string): Promise<void> {
    return this.client.items.delete(type, id);
  }

  /** Identity + PAT scope probe (`/api/v1/whoami`) — accepts cookie or PAT. */
  whoami(): Promise<WhoAmI> {
    return this.client.whoami();
  }

  // --- read grounding for the @loom chat participant (PRP M3) ---------------
  // All read-only, all through the SDK's typed client — the SAME routes the
  // shipped M1 `loom-catalog` / M2 `loom-query` MCP servers call. Never a mock.

  /** Federated catalog search (`GET /api/catalog/search`). */
  catalogSearch(query: string, opts?: CatalogSearchOptions): Promise<CatalogSearchResult> {
    return this.client.catalog.search(query, opts);
  }

  /** Get an item by type + id (`GET /api/cosmos-items/:type/:id`). */
  getItem(itemType: string, itemId: string): Promise<Item> {
    return this.client.items.get(itemType, itemId);
  }

  /** Bounded data preview for a data asset (`GET /api/items/:type/:id/preview`). */
  preview(itemType: string, itemId: string, top?: number): Promise<QueryResult> {
    return this.client.query.preview(itemId, { type: itemType, top });
  }

  // --- Routes the SDK class does not model (reuse the SDK error contract) ---

  /** Flat identity for the status bar (`GET /api/auth/me`). */
  me(): Promise<MeResult> {
    return this.raw<MeResult>('GET', '/api/auth/me');
  }

  /**
   * Create an item (PRP W3). Hits `POST /api/cosmos-items/:type` — the same
   * route the Console's shared NewItemGate uses — with `{ workspaceId,
   * displayName, description? }`. Returns the created item.
   */
  async createItem(
    type: string,
    workspaceId: string,
    displayName: string,
    description?: string,
  ): Promise<Item> {
    const body: Record<string, unknown> = { workspaceId, displayName };
    if (description && description.trim()) body.description = description.trim();
    const out = await this.raw<{ ok: boolean; item: Item }>(
      'POST',
      `/api/cosmos-items/${encodeURIComponent(type)}`,
      body,
    );
    return out.item;
  }

  // --- item-definition transport (P1.5 / W6) --------------------------------

  /**
   * GET the item's editable definition (`GET /api/items/:type/:id/definition`).
   * Reads the strong ETag from the response header (falling back to the body's
   * `etag`) so a subsequent {@link putDefinition} can send `If-Match`.
   */
  async getDefinition(itemType: string, itemId: string): Promise<DefinitionPayload> {
    const path = `/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/definition`;
    const res = await this.rawResponse('GET', path);
    if (res.status < 200 || res.status >= 300) throw this.errorFrom(res.json, res.response);
    const body = (res.json ?? {}) as { definition?: unknown; schemaVersion?: unknown; etag?: unknown };
    return {
      definition: body.definition ?? {},
      etag: this.etagOf(res, body),
      schemaVersion: typeof body.schemaVersion === 'number' ? body.schemaVersion : 1,
    };
  }

  /**
   * PUT the edited definition back with `If-Match` (`*` when no ETag is known).
   * A 412 becomes a {@link DefinitionConflictError} so the caller opens a diff
   * rather than clobbering a concurrent edit.
   */
  async putDefinition(
    itemType: string,
    itemId: string,
    definition: unknown,
    ifMatch: string,
  ): Promise<DefinitionPayload> {
    const path = `/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/definition`;
    const res = await this.rawResponse('PUT', path, { definition }, { 'If-Match': ifMatch || '*' });
    if (res.status === 412) {
      const b = (res.json ?? {}) as { etag?: unknown };
      const cur = typeof b.etag === 'string' ? b.etag : res.headers.get('etag') ?? undefined;
      throw new DefinitionConflictError(cur);
    }
    if (res.status < 200 || res.status >= 300) throw this.errorFrom(res.json, res.response);
    const body = (res.json ?? {}) as { definition?: unknown; schemaVersion?: unknown; etag?: unknown };
    return {
      definition: body.definition ?? definition,
      etag: this.etagOf(res, body),
      schemaVersion: typeof body.schemaVersion === 'number' ? body.schemaVersion : 1,
    };
  }

  private etagOf(res: { headers: Headers }, body: { etag?: unknown }): string {
    const h = res.headers.get('etag');
    if (h) return h;
    return typeof body.etag === 'string' ? body.etag : '';
  }

  // --- notebook execution transport (N10-N13) -------------------------------
  // Real Synapse Livy / Databricks / AML-CI routes. `raw()` throws a LoomApiError
  // carrying the route's `code` (e.g. `not_configured`) on an honest 503 gate, so
  // the NotebookController can surface the exact remediation instead of faking a
  // kernel.

  /** `GET …/session?probe=1` — which compute backend this deployment uses. */
  async notebookBackend(id: string): Promise<string> {
    const r = await this.raw<{ ok: boolean; backend?: string }>(
      'GET',
      `/api/notebook/${encodeURIComponent(id)}/session?probe=1`,
    );
    return r.backend || 'synapse';
  }

  /** `POST …/session` — create or reuse a Spark/Databricks session. */
  createNotebookSession(id: string, body: Record<string, unknown>): Promise<NotebookSessionResult> {
    return this.raw<NotebookSessionResult>('POST', `/api/notebook/${encodeURIComponent(id)}/session`, body);
  }

  /** `GET …/session?…` — keepalive + state poll. */
  getNotebookSession(id: string, query: Record<string, string | number>): Promise<NotebookSessionResult> {
    return this.raw<NotebookSessionResult>('GET', `/api/notebook/${encodeURIComponent(id)}/session?${qs(query)}`);
  }

  /** `DELETE …/session?…` — kill the session (Stop / Cancel). */
  async killNotebookSession(id: string, query: Record<string, string | number>): Promise<void> {
    await this.raw<{ ok: boolean }>('DELETE', `/api/notebook/${encodeURIComponent(id)}/session?${qs(query)}`);
  }

  /** `POST …/execute` — submit a cell (magic-aware server-side). */
  execNotebookCell(id: string, body: Record<string, unknown>): Promise<NotebookExecResult> {
    return this.raw<NotebookExecResult>('POST', `/api/notebook/${encodeURIComponent(id)}/execute`, body);
  }

  /** `GET …/execute?…` — poll a submitted statement for its output. */
  getNotebookCell(id: string, query: Record<string, string | number>): Promise<NotebookExecResult> {
    return this.raw<NotebookExecResult>('GET', `/api/notebook/${encodeURIComponent(id)}/execute?${qs(query)}`);
  }

  // --- bounded read: query + preview + estate search (Phase 3) --------------
  // Thin delegates onto the SDK `query` resource — the SAME per-item routes the
  // M2 `loom-query` MCP server calls (POST /api/items/{type}/{id}/query and
  // GET /api/items/{type}/{id}/preview). The read-only parse + row/byte caps
  // live in `query/query-caps.ts` and are applied by the command BEFORE/AFTER
  // these calls (kept out of transport so they are unit-testable in isolation).

  /** Run bounded T-SQL against a SQL-capable item and read the result set. */
  querySql(itemType: string, id: string, sql: string, database?: string): Promise<QueryResult> {
    return this.client.query.sql(id, sql, { type: itemType, database });
  }

  /** Run bounded KQL against an ADX-backed item; `take` is the server-side row window. */
  queryKql(itemType: string, id: string, kql: string, take: number, database?: string): Promise<QueryResult> {
    return this.client.query.kql(id, kql, { type: itemType, database, page: { skip: 0, take } });
  }

  /** Read a bounded, sampled data preview (rows + column profile) for a data asset. */
  queryPreview(itemType: string, id: string, top: number): Promise<QueryResult> {
    return this.client.query.preview(id, { type: itemType, top });
  }

  /**
   * Estate-wide catalog search (`GET /api/catalog/find`) — the `loom find`
   * backend, ACL/tenant-scoped server-side. Returns the raw envelope; the
   * command maps + ranks it (`query/search-model.ts`).
   */
  catalogFind(q: string, opts: { type?: string; limit?: number } = {}): Promise<CatalogFindResponse> {
    const params = new URLSearchParams();
    params.set('q', q ?? '');
    if (opts.type) params.set('type', opts.type);
    if (opts.limit != null) params.set('limit', String(opts.limit));
    return this.raw<CatalogFindResponse>('GET', `/api/catalog/find?${params.toString()}`);
  }

  // --- Git / ALM integration (Phase 5, W9/W10) ------------------------------
  // Workspace-scoped ADO/GitHub over the REAL /api/git-integration/* routes. A
  // 424 `{gated:true,missing}` becomes a typed {@link GitGateError} the command
  // turns into a named remediation — never a fabricated status.

  /** `GET …/status?workspaceId=` — repo + changed items (or an honest gate). */
  gitStatus(workspaceId: string): Promise<GitStatusResponse> {
    return this.gitRequest<GitStatusResponse>(
      'GET',
      `/api/git-integration/status?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
  }

  /** `POST …/commit` — commit the selected items as one commit; returns the sha. */
  gitCommit(workspaceId: string, itemIds: string[], message: string): Promise<GitCommitResponse> {
    return this.gitRequest<GitCommitResponse>('POST', '/api/git-integration/commit', {
      workspaceId,
      itemIds,
      message,
    });
  }

  /** `POST …/pull` — pull repo → apply to Loom items; returns applied count. */
  gitPull(workspaceId: string, itemIds?: string[]): Promise<GitPullResponse> {
    const body: Record<string, unknown> = { workspaceId };
    if (itemIds && itemIds.length) body.itemIds = itemIds;
    return this.gitRequest<GitPullResponse>('POST', '/api/git-integration/pull', body);
  }

  /** `POST …/resolve` — resolve one item's conflict (keep local | keep remote). */
  gitResolve(
    workspaceId: string,
    itemId: string,
    resolution: 'local' | 'remote',
  ): Promise<GitResolveResponse> {
    return this.gitRequest<GitResolveResponse>('POST', '/api/git-integration/resolve', {
      workspaceId,
      itemId,
      resolution,
    });
  }

  /** Like {@link raw} but maps an honest git gate body to a {@link GitGateError}. */
  private async gitRequest<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
    const res = await this.rawResponse(method, apiPath, body);
    if (isGitGateBody(res.json)) {
      throw new GitGateError(res.json.missing, res.json.detail, res.status);
    }
    if (res.status < 200 || res.status >= 300) throw this.errorFrom(res.json, res.response);
    if (res.json && typeof res.json === 'object' && (res.json as { ok?: unknown }).ok === false) {
      throw this.errorFrom(res.json, res.response);
    }
    return res.json as T;
  }

  // --- Spark job definitions (Phase 5, J1-J6) -------------------------------
  // The dedicated, REAL Synapse-Livy BATCH API the Console's SJD editor uses.
  // No fake kernel; the submit route returns an honest 400/502 (pool/main file
  // unset, or Synapse not configured) which the command surfaces verbatim.

  /** `GET …/spark-job-definition/[id]` — the persisted item (spec in state.spec). */
  async getSparkJobItem(id: string): Promise<Item> {
    const out = await this.raw<{ ok: boolean; item: Item }>(
      'GET',
      `/api/items/spark-job-definition/${encodeURIComponent(id)}`,
    );
    return out.item;
  }

  /** `PUT …/spark-job-definition/[id]` — persist a merged `state` (J1 configure). */
  async putSparkJobState(id: string, state: Record<string, unknown>): Promise<Item> {
    const out = await this.raw<{ ok: boolean; item: Item }>(
      'PUT',
      `/api/items/spark-job-definition/${encodeURIComponent(id)}`,
      { state },
    );
    return out.item;
  }

  /** `POST …/spark-job-definition/[id]/submit` — real Livy batch submit (J5). */
  submitSparkJob(id: string, body: Record<string, unknown> = {}): Promise<SparkSubmitResult> {
    return this.raw<SparkSubmitResult>(
      'POST',
      `/api/items/spark-job-definition/${encodeURIComponent(id)}/submit`,
      body,
    );
  }

  /** `GET …/spark-job-definition/[id]/runs` — Livy batch history (J4). */
  listSparkJobRuns(id: string, size = 20, from = 0): Promise<SparkRunsResult> {
    return this.raw<SparkRunsResult>(
      'GET',
      `/api/items/spark-job-definition/${encodeURIComponent(id)}/runs?${qs({ size, from })}`,
    );
  }

  /** `POST …/spark-job-definition/[id]/runs/[runId]/cancel` — cancel a batch. */
  async cancelSparkJobRun(id: string, runId: number | string): Promise<void> {
    await this.raw<{ ok: boolean }>(
      'POST',
      `/api/items/spark-job-definition/${encodeURIComponent(id)}/runs/${encodeURIComponent(String(runId))}/cancel`,
    );
  }

  /**
   * `POST …/spark-job-definition/[id]/files` — multipart upload of the main
   * definition / a reference file to ADLS (J2). Returns the `abfss://` URI the
   * caller records in `spec.file`. Honest gate: 400 `adls_not_configured`.
   */
  async uploadSparkJobFile(
    id: string,
    kind: 'main' | 'reference',
    filename: string,
    bytes: Uint8Array,
    contentType = 'application/octet-stream',
  ): Promise<SparkFileUploadResult> {
    const form = new FormData();
    form.set('kind', kind);
    // A fresh ArrayBuffer copy — a Uint8Array view over a larger buffer would
    // upload trailing bytes.
    const copy = bytes.slice();
    form.set('file', new Blob([copy], { type: contentType }), filename);
    const url = `${this.baseUrl}/api/items/spark-job-definition/${encodeURIComponent(id)}/files`;
    // NOTE: do NOT set Content-Type — fetch sets the multipart boundary itself.
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.cred.kind === 'pat') headers.Authorization = `Bearer ${this.cred.value}`;
    else headers.Cookie = `${COOKIE_NAME}=${this.cred.value}`;
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers, body: form });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new LoomApiError(`Network error uploading file: ${msg}`, 0, 'network_error');
    }
    const text = await res.text();
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) throw this.errorFrom(parsed, res);
    return parsed as SparkFileUploadResult;
  }

  private authHeaders(hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json' };
    if (hasBody) h['Content-Type'] = 'application/json';
    if (this.cred.kind === 'pat') h.Authorization = `Bearer ${this.cred.value}`;
    else h.Cookie = `${COOKIE_NAME}=${this.cred.value}`;
    return h;
  }

  /**
   * Like {@link raw} but returns the full response (status + headers + parsed
   * body) WITHOUT throwing on a non-2xx — the definition transport needs the
   * ETag header and must inspect a 412 itself.
   */
  private async rawResponse(
    method: string,
    apiPath: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; headers: Headers; json: unknown; response: Response }> {
    const url = `${this.baseUrl}${apiPath}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { ...this.authHeaders(body !== undefined), ...(extraHeaders ?? {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new LoomApiError(`Network error calling ${method} ${apiPath}: ${msg}`, 0, 'network_error');
    }
    const text = await res.text();
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    return { status: res.status, headers: res.headers, json, response: res };
  }

  /** Minimal request that mirrors the SDK's error/auth contract exactly. */
  private async raw<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${apiPath}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: this.authHeaders(body !== undefined),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new LoomApiError(`Network error calling ${method} ${apiPath}: ${msg}`, 0, 'network_error');
    }
    const text = await res.text();
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) throw this.errorFrom(parsed, res);
    if (parsed && typeof parsed === 'object' && (parsed as { ok?: unknown }).ok === false) {
      throw this.errorFrom(parsed, res);
    }
    return parsed as T;
  }

  private errorFrom(parsed: unknown, res: Response): LoomApiError {
    if (parsed && typeof parsed === 'object') {
      const p = parsed as { error?: unknown; message?: unknown; code?: unknown; hint?: unknown };
      const msg =
        (typeof p.error === 'string' && p.error) ||
        (typeof p.message === 'string' && p.message) ||
        `${res.status} ${res.statusText}`;
      return new LoomApiError(
        String(msg),
        res.status,
        typeof p.code === 'string' ? p.code : undefined,
        typeof p.hint === 'string' ? p.hint : undefined,
      );
    }
    const msg = typeof parsed === 'string' && parsed ? parsed : `${res.status} ${res.statusText}`;
    return new LoomApiError(msg, res.status);
  }
}
