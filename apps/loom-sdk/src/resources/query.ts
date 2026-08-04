import { HttpTransport, enc } from '../http.js';
import type { QueryResult, SqlQueryOptions, KqlQueryOptions } from '../types.js';

/**
 * Bounded data-read operations — the surface behind the M2 `loom-query` MCP
 * server. These call the console's per-item query / preview routes, which are
 * polymorphic over the item type:
 *
 *   • SQL      → `POST /api/items/{type}/{id}/query`  body `{ sql, database?, parameters? }`
 *                (synapse-serverless-sql-pool, synapse-dedicated-sql-pool,
 *                 sql-analytics-endpoint, lakehouse, warehouse, azure-sql-database, …)
 *   • KQL      → `POST /api/items/{type}/{id}/query`  body `{ kql, db?, page? }`
 *                (kql-database / eventhouse — ADX)
 *   • preview  → `GET  /api/items/{type}/{id}/preview?top=`
 *                (dataset, data-products, materialized-lake-view, …)
 *
 * Every route is READ-ONLY and enforces its own server-side caps (the SQL route
 * a 60s TDS timeout; the KQL route `KQL_MAX_ROWS`; the preview route `MAX_TOP`).
 * The M2 tool layers additional row/byte caps and a DDL/DML parse-reject on top
 * (PRP §5.3) — this SDK layer stays a thin, honest map onto the real routes.
 */
export class QueryResource {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Run bounded T-SQL against a SQL-capable item and read the result set.
   * `type` selects the per-item route (default `synapse-serverless-sql-pool`).
   */
  async sql(id: string, sql: string, opts: SqlQueryOptions & { type?: string } = {}): Promise<QueryResult> {
    const type = opts.type ?? 'synapse-serverless-sql-pool';
    const body: Record<string, unknown> = { sql };
    if (opts.database) body.database = opts.database;
    if (opts.parameters) body.parameters = opts.parameters;
    return this.http.request<QueryResult>('POST', `/api/items/${enc(type)}/${enc(id)}/query`, body);
  }

  /**
   * Run bounded KQL against an ADX-backed item (kql-database / eventhouse) and
   * read the result set. `type` selects the per-item route (default
   * `kql-database`). A leading-`.` control command is a mutation and is rejected
   * by the M2 tool before it reaches here.
   */
  async kql(id: string, kql: string, opts: KqlQueryOptions & { type?: string } = {}): Promise<QueryResult> {
    const type = opts.type ?? 'kql-database';
    const body: Record<string, unknown> = { kql };
    if (opts.database) body.db = opts.database;
    if (opts.page) body.page = opts.page;
    return this.http.request<QueryResult>('POST', `/api/items/${enc(type)}/${enc(id)}/query`, body);
  }

  /**
   * Read a bounded data preview (sampled rows + column profile) for a registered
   * data asset. `type` selects the per-item route (default `dataset`); `top`
   * bounds the sample (route caps it server-side).
   */
  async preview(id: string, opts: { type?: string; top?: number; project?: string; version?: string } = {}): Promise<QueryResult> {
    const type = opts.type ?? 'dataset';
    const params = new URLSearchParams();
    if (opts.top != null) params.set('top', String(opts.top));
    if (opts.project) params.set('project', opts.project);
    if (opts.version) params.set('version', opts.version);
    const qs = params.toString();
    return this.http.request<QueryResult>('GET', `/api/items/${enc(type)}/${enc(id)}/preview${qs ? `?${qs}` : ''}`);
  }
}
