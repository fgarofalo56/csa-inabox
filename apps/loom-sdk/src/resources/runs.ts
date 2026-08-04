import { HttpTransport, enc } from '../http.js';
import type { RunList, RunDetail, RunLogSlice, RunStartResult, RunListOptions, RunLogOptions } from '../types.js';

/**
 * Run / job operations — the surface behind the M4 `loom-ops` MCP server. Like
 * the query surface these hit the console's polymorphic per-item routes:
 *
 *   • list   → `GET  /api/items/{type}/{id}/runs?after=&before=&status=`
 *   • get    → `GET  /api/items/{type}/{id}/runs?runId={runId}`  (activity receipts)
 *   • logs   → `GET  /api/items/{type}/{id}/runs/{runId}/log?workspaceId=&from=&size=`
 *   • start  → `POST /api/items/{type}/{id}/run`   body `{ params? }`      (WRITE)
 *   • cancel → `POST /api/items/{type}/{id}/runs/{runId}/cancel`           (WRITE)
 *
 * `type` selects the per-item route. `list`/`get`/`start` default to
 * `adf-pipeline` (the canonical schedulable item; the route also accepts the
 * `data-pipeline` alias); `logs` defaults to `notebook` (where driver-log
 * streaming lives); `cancel` defaults to `spark-job-definition` (per-run
 * cancel). Any run-capable item type may be passed explicitly.
 */
export class RunsResource {
  constructor(private readonly http: HttpTransport) {}

  /** List runs for an item, filtered to the bound target (default window 7 days). */
  async list(id: string, opts: RunListOptions & { type?: string } = {}): Promise<RunList> {
    const type = opts.type ?? 'adf-pipeline';
    const params = new URLSearchParams();
    if (opts.after) params.set('after', opts.after);
    if (opts.before) params.set('before', opts.before);
    if (opts.status) params.set('status', opts.status);
    const qs = params.toString();
    return this.http.request<RunList>('GET', `/api/items/${enc(type)}/${enc(id)}/runs${qs ? `?${qs}` : ''}`);
  }

  /** Get one run's per-activity receipts (status, timing, and owner-scoped IO). */
  async get(id: string, runId: string, opts: { type?: string } = {}): Promise<RunDetail> {
    const type = opts.type ?? 'adf-pipeline';
    const params = new URLSearchParams({ runId });
    return this.http.request<RunDetail>('GET', `/api/items/${enc(type)}/${enc(id)}/runs?${params.toString()}`);
  }

  /** Read a slice of a run's driver log (spark/aml). Tail by advancing `from`. */
  async logs(id: string, runId: string, opts: RunLogOptions & { type?: string } = {}): Promise<RunLogSlice> {
    const type = opts.type ?? 'notebook';
    const params = new URLSearchParams();
    if (opts.workspaceId) params.set('workspaceId', opts.workspaceId);
    if (opts.from != null) params.set('from', String(opts.from));
    if (opts.size != null) params.set('size', String(opts.size));
    const qs = params.toString();
    return this.http.request<RunLogSlice>('GET', `/api/items/${enc(type)}/${enc(id)}/runs/${enc(runId)}/log${qs ? `?${qs}` : ''}`);
  }

  /** **WRITE** — start a run. The caller is authorized against the item at the BFF. */
  async start(id: string, opts: { type?: string; params?: Record<string, unknown> } = {}): Promise<RunStartResult> {
    const type = opts.type ?? 'adf-pipeline';
    return this.http.request<RunStartResult>('POST', `/api/items/${enc(type)}/${enc(id)}/run`, { params: opts.params ?? {} });
  }

  /** **WRITE** — cancel an in-flight run. */
  async cancel(id: string, runId: string, opts: { type?: string } = {}): Promise<{ ok: boolean; [k: string]: unknown }> {
    const type = opts.type ?? 'spark-job-definition';
    return this.http.request<{ ok: boolean }>('POST', `/api/items/${enc(type)}/${enc(id)}/runs/${enc(runId)}/cancel`);
  }
}
