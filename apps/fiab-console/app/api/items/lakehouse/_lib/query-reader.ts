/**
 * Where the lakehouse SQL tab runs a query for a caller who is not a tenant
 * admin, and how the batch is framed.
 *
 * Two things hold for every such query, together:
 *
 *   - It runs on a connection pool of its OWN. `getPool` in
 *     `lib/azure/synapse-sql-client.ts` caches one pool per `cacheKey` for the
 *     whole process, and a pooled connection keeps its session state (the
 *     current database among it) from one request to the next. Every other
 *     target in the console builds its key from a fixed prefix (`serverless:`,
 *     `dedicated:`, `pbi:`, `pbi-preview:`, `prpt:`, `conn:synapse:`), so a key
 *     starting with {@link READER_POOL_PREFIX} is used by this path alone (the
 *     serverless SQL pool editor passes its own prefix), and
 *     the only text sent on it is text the classifier accepted, which never
 *     contains `USE`.
 *   - The batch starts with {@link READER_BATCH_PREFIX}, so it runs in `master`
 *     whatever state the connection holds. The prefix is on the same line as
 *     the caller's first line, so the server's line numbers in an error still
 *     match the text the caller wrote.
 */
import { serverlessTarget, type SynapseTarget } from '@/lib/azure/synapse-sql-client';

/** The database every caller who is not a tenant admin runs in. */
export const READER_DATABASE = 'master';

/** Pool-key prefix no other Synapse target in the console uses. */
export const READER_POOL_PREFIX = 'lakehouse-reader:';

/** Sent ahead of every reader batch. */
export const READER_BATCH_PREFIX = 'USE [master]; ';

/** The info message the server returns for {@link READER_BATCH_PREFIX}. */
const READER_USE_MESSAGE = /^Changed database context to 'master'\.?$/;

/**
 * The serverless `master` target, on the reader path's own pool.
 *
 * `poolPrefix` lets another surface that runs classifier-accepted text (the
 * serverless SQL pool editor, `sql-pool-reader:`; Direct Lake raw SQL,
 * `direct-lake-reader:`) keep a pool of its own too, so no surface shares a
 * pooled connection with another.
 */
export function readerTarget(poolPrefix: string = READER_POOL_PREFIX): SynapseTarget {
  const base = serverlessTarget(READER_DATABASE);
  return { ...base, database: READER_DATABASE, cacheKey: `${poolPrefix}${base.cacheKey}` };
}

/** The batch sent for classifier-accepted text. */
export function readerBatch(sqlText: string): string {
  return READER_BATCH_PREFIX + sqlText;
}

/**
 * Drop the one info message the server returns for the `USE` this path added,
 * so the Messages pane shows only what the caller's own text produced.
 */
export function withoutReaderUseMessage(messages: string[] | undefined): string[] | undefined {
  if (!messages) return messages;
  const i = messages.findIndex((m) => READER_USE_MESSAGE.test(m.trim()));
  return i < 0 ? messages : [...messages.slice(0, i), ...messages.slice(i + 1)];
}
