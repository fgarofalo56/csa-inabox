/**
 * LoomEmbedClient — the transport a `<loom-report>` / React `<LoomReport>` uses
 * to fetch a governed metric with an EMBED TOKEN.
 *
 * It builds on `@csa-loom/sdk` (reuses `normalizeBaseUrl` + `LoomApiError`), and
 * targets the Fabric-free embed data endpoint `POST /api/embed/query`, sending
 * the short-lived embed token in an `x-loom-embed-token` header. Row-level
 * security is applied SERVER-SIDE from the token identity (the N15 metric
 * compiler ANDs the identity's claims into the WHERE) — the client never sees or
 * filters rows it wasn't allowed to fetch.
 *
 * Runtime-agnostic: uses the global `fetch` (browser / Node ≥ 18) and can take
 * an injected `fetch` for tests.
 */

import { normalizeBaseUrl, LoomApiError } from '@csa-loom/sdk';

/** The header the embed token is presented in (mirrors the server route). */
export const EMBED_TOKEN_HEADER = 'x-loom-embed-token';

export type MetricEngine = 'synapse' | 'lakehouse' | 'adx';

/** A viewer-supplied filter that NARROWS the query (RLS is added server-side). */
export interface EmbedFilterInput {
  dimension: string;
  op?: '=' | '!=' | '>' | '>=' | '<' | '<=' | 'in';
  value: string | number | Array<string | number>;
}

/** Arguments to {@link LoomEmbedClient.query}. */
export interface EmbedQueryInput {
  /** The governed metric name (must be defined on the token owner's spec). */
  metric: string;
  /** Group-by dimensions (whitelisted server-side against the model). */
  dimensions?: string[];
  /** Extra viewer filters (conjunctive with the identity's RLS predicate). */
  filters?: EmbedFilterInput[];
  /** Time-grain override for the first time dimension. */
  grain?: string;
  /** Target engine (default `synapse`). */
  engine?: MetricEngine;
}

/** The governed-metric result the endpoint returns (report-grid shape). */
export interface EmbedMetricResult {
  metric: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionMs: number;
  engine?: string;
  dialect?: string;
  sql?: string;
  groupBy?: string[];
  cached?: boolean;
  /** Echoed from the token — the report the result belongs to. */
  reportId?: string;
}

export interface LoomEmbedClientOptions {
  /** Base URL of the Loom deployment, e.g. `https://csa-loom.limitlessdata.ai`. */
  baseUrl: string;
  /** A short-lived embed token (`loom_embed_…`) minted at `POST /api/embed/token`. */
  token: string;
  /** Per-request timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Override the fetch implementation (tests / custom runtimes). */
  fetch?: typeof fetch;
}

export class LoomEmbedClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LoomEmbedClientOptions) {
    if (!opts.baseUrl) throw new Error('LoomEmbedClient requires a baseUrl');
    if (!opts.token) throw new Error('LoomEmbedClient requires an embed token');
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') {
      throw new Error('No global fetch available — pass options.fetch (Node < 18) or upgrade Node.');
    }
    this.fetchImpl = f;
  }

  /** The resolved base URL (trailing slash stripped). */
  get base(): string {
    return this.baseUrl;
  }

  /**
   * Query a governed metric as the token's effective identity. Throws
   * {@link LoomApiError} on a non-2xx / `{ ok:false }` response (honest gates,
   * expired token, unknown metric all surface with their server message + code).
   */
  async query(input: EmbedQueryInput): Promise<EmbedMetricResult> {
    const metric = String(input.metric || '').trim();
    if (!metric) throw new LoomApiError('metric is required', 400, 'bad_request');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/embed/query`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          [EMBED_TOKEN_HEADER]: this.token,
        },
        body: JSON.stringify({
          metric,
          dimensions: input.dimensions ?? [],
          filters: input.filters ?? [],
          grain: input.grain,
          engine: input.engine,
        }),
        signal: controller.signal,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'network_error';
      throw new LoomApiError(`${code === 'timeout' ? 'Timed out' : 'Network error'} querying embed metric: ${msg}`, 0, code);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok || (parsed && typeof parsed === 'object' && (parsed as { ok?: unknown }).ok === false)) {
      const p = (parsed && typeof parsed === 'object' ? parsed : {}) as { error?: unknown; code?: unknown };
      const msg = typeof p.error === 'string' && p.error ? p.error : `${res.status} ${res.statusText}`;
      throw new LoomApiError(msg, res.status, typeof p.code === 'string' ? p.code : undefined);
    }
    return parsed as EmbedMetricResult;
  }
}

/** A flat, render-ready view of a metric result (columns + row matrix). */
export interface ReportView {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
}

/**
 * Reshape a {@link EmbedMetricResult} into a column list + row matrix for
 * rendering. Pure — the web component and any custom renderer share it.
 */
export function toReportView(result: EmbedMetricResult): ReportView {
  const columns = Array.isArray(result?.columns) ? result.columns : [];
  const records = Array.isArray(result?.rows) ? result.rows : [];
  const rows = records.map((r) => columns.map((c) => (r ? r[c] : undefined)));
  return { columns, rows, rowCount: typeof result?.rowCount === 'number' ? result.rowCount : rows.length };
}
