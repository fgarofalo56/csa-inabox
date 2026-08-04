/**
 * M2 `loom-query` tools — the bounded data-read surface (PRP §4.2, §5.3). This
 * is the data-exfiltration surface, so every tool: is `readOnly` (queries only),
 * requires a `read-only` scope floor, enforces server-side row/byte caps the
 * caller cannot raise, rejects DDL/DML/control statements at parse, and returns
 * DATA rows — which the core scrub (§5.2) sanitizes cell-by-cell before they
 * leave the process. The query text is audited only as a hash (core `args_hash`)
 * and the row count is recorded (§5.3.6).
 *
 * | tool               | SDK call                         | endpoint (via SDK)                                   |
 * |--------------------|----------------------------------|------------------------------------------------------|
 * | loom.query.sql     | client.query.sql(id, sql, opts)  | POST /api/items/{type}/{id}/query  (T-SQL)           |
 * | loom.query.kql     | client.query.kql(id, kql, opts)  | POST /api/items/{type}/{id}/query  (KQL / ADX)       |
 * | loom.query.preview | client.query.preview(id, opts)   | GET  /api/items/{type}/{id}/preview                  |
 */
import { z } from 'zod';
import type { QueryResult } from '@csa-loom/sdk';
import type { ToolSpec } from '../../core/types.js';
import { assertReadOnlySql, assertReadOnlyKql, clampLimit, capResult, MAX_ROWS_HARD } from './guards.js';

/** The three M2 query tools. Read-only, capped, DDL/DML-rejecting. */
export function queryTools(): ToolSpec[] {
  return [
    {
      name: 'loom.query.sql',
      title: 'Run a bounded read-only SQL query',
      description:
        'Execute a READ-ONLY T-SQL query against a SQL-capable Loom item (Synapse serverless/dedicated, ' +
        'SQL analytics endpoint, lakehouse, warehouse, Azure SQL, …) and read the result rows. ' +
        'DDL/DML (INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/…) is rejected at parse — only SELECT/WITH/EXPLAIN/SHOW/DESCRIBE run. ' +
        `Rows are capped server-side (default ${clampLimit()}, hard max ${MAX_ROWS_HARD}); the cap cannot be raised. Secrets in any cell are scrubbed.`,
      inputSchema: {
        id: z.string().describe('Item id (GUID) of the SQL-capable item to query.'),
        sql: z.string().describe('A read-only T-SQL statement (SELECT / WITH / EXPLAIN / SHOW / DESCRIBE).'),
        type: z
          .string()
          .optional()
          .describe('Item type route (default synapse-serverless-sql-pool). e.g. synapse-dedicated-sql-pool, lakehouse, warehouse.'),
        database: z.string().optional().describe('Database/catalog to target (default: the route default).'),
        limit: z.number().int().min(1).max(MAX_ROWS_HARD).optional().describe(`Max rows to return (<= ${MAX_ROWS_HARD}). May only LOWER the default.`),
      },
      readOnly: true,
      minScope: 'read-only',
      async run({ auth, args }) {
        const sql = String(args.sql ?? '');
        assertReadOnlySql(sql); // §5.3.4 — reject non-read statements at parse
        const maxRows = clampLimit(args.limit as number | undefined);
        const res = await auth.client.query.sql(String(args.id), sql, {
          type: args.type as string | undefined,
          database: args.database as string | undefined,
        });
        return capResult(res as QueryResult, maxRows);
      },
    },
    {
      name: 'loom.query.kql',
      title: 'Run a bounded read-only KQL query',
      description:
        'Execute a READ-ONLY KQL query against an ADX-backed Loom item (kql-database / eventhouse) and read the result rows. ' +
        'Control/management commands (leading `.`: .create/.drop/.ingest/.set/…) are rejected at parse. ' +
        `Rows are capped server-side (default ${clampLimit()}, hard max ${MAX_ROWS_HARD}) and cannot be raised. Secrets in any cell are scrubbed.`,
      inputSchema: {
        id: z.string().describe('Item id (GUID) of the kql-database / eventhouse to query.'),
        kql: z.string().describe('A read-only KQL query (no leading-`.` control commands).'),
        type: z.string().optional().describe('Item type route (default kql-database). e.g. eventhouse.'),
        database: z.string().optional().describe('Database override (default: the item’s resolved database).'),
        limit: z.number().int().min(1).max(MAX_ROWS_HARD).optional().describe(`Max rows to return (<= ${MAX_ROWS_HARD}). May only LOWER the default.`),
      },
      readOnly: true,
      minScope: 'read-only',
      async run({ auth, args }) {
        const kql = String(args.kql ?? '');
        assertReadOnlyKql(kql); // §5.3.4 — reject control commands at parse
        const maxRows = clampLimit(args.limit as number | undefined);
        const res = await auth.client.query.kql(String(args.id), kql, {
          type: args.type as string | undefined,
          database: args.database as string | undefined,
          page: { skip: 0, take: maxRows }, // ask the engine for only what we'll keep
        });
        return capResult(res as QueryResult, maxRows);
      },
    },
    {
      name: 'loom.query.preview',
      title: 'Preview an item’s data',
      description:
        'Read a bounded data preview (sampled rows + a per-column profile) for a registered Loom data asset ' +
        '(dataset, data-product, materialized lake view, …). No query text — a safe, capped sample. ' +
        `Rows are capped (default ${clampLimit()}, hard max ${MAX_ROWS_HARD}); secrets in any cell are scrubbed.`,
      inputSchema: {
        id: z.string().describe('Item id (GUID) of the data asset to preview.'),
        type: z.string().optional().describe('Item type route (default dataset). e.g. data-product, materialized-lake-view.'),
        project: z.string().optional().describe('Optional Foundry project scope for the asset.'),
        version: z.string().optional().describe('Optional named asset version (default: latest).'),
        limit: z.number().int().min(1).max(MAX_ROWS_HARD).optional().describe(`Max sample rows (<= ${MAX_ROWS_HARD}).`),
      },
      readOnly: true,
      minScope: 'read-only',
      async run({ auth, args }) {
        const maxRows = clampLimit(args.limit as number | undefined);
        const res = await auth.client.query.preview(String(args.id), {
          type: args.type as string | undefined,
          project: args.project as string | undefined,
          version: args.version as string | undefined,
          top: maxRows,
        });
        return capResult(res as QueryResult, maxRows);
      },
    },
  ];
}
