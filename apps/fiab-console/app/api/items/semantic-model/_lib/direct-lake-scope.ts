/**
 * Scope for the raw-SQL branch of `POST /api/items/semantic-model/[id]/direct-lake`.
 *
 * That branch runs a semantic model's own T-SQL on the shared Synapse Serverless
 * endpoint as the console's identity. For a caller who is not a tenant admin it
 * follows the same rules as the serverless SQL pool editor
 * (`../../synapse-serverless-sql-pool/_lib/query-scope.ts`):
 *
 *   - the text passes the lakehouse SQL tab's classifier (SELECT only; no `USE`,
 *     no other database, no `sys` catalog outside the INFORMATION_SCHEMA views);
 *   - every `OPENROWSET(BULK …)` location is a literal URL under the storage root
 *     of a lakehouse in the semantic model's own workspace, resolved server-side;
 *   - it runs in `master` on a connection pool of its own
 *     ({@link DIRECT_LAKE_READER_POOL_PREFIX}), with the batch starting
 *     `USE [master];` (`../../lakehouse/_lib/query-reader.ts`).
 *
 * A tenant admin's SQL runs unchanged. A model whose SQL reads storage outside
 * those lakehouse roots is refused for other callers until a per-item serverless
 * database (#4821) provides a scoped data source for it.
 *
 * The table branch of the route builds its own SQL from the Gold root and is not
 * covered here.
 */
import type { QueryScopeSurface } from '@/app/api/items/lakehouse/_lib/query-scope';

/** How the classifier's refusals name this surface. */
export const DIRECT_LAKE_SQL_SURFACE: QueryScopeSurface = {
  lead:
    'Direct Lake SQL for a semantic model runs read-only SELECT queries over the files of the lakehouses in '
    + 'the model\'s workspace. ',
  name: 'Direct Lake SQL',
  place: 'Direct Lake SQL',
  files: 'the files of the lakehouses in the model\'s workspace',
  selectRemediation:
    'Write a SELECT (optionally with a WITH clause) that reads a lakehouse in the model\'s workspace through '
    + "OPENROWSET(BULK 'https://<account>.dfs.<suffix>/<container>/<lakehouse root>/…'), or query the "
    + 'INFORMATION_SCHEMA views. A tenant admin can run other statements.',
  dataSource:
    'no external data source is scoped to the model\'s workspace; name each file by its full URL under a lakehouse root',
};

/** Pool-key prefix for non-admin Direct Lake SQL; no other target uses it. */
export const DIRECT_LAKE_READER_POOL_PREFIX = 'direct-lake-reader:';
