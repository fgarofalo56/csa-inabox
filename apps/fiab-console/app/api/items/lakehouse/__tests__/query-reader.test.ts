/**
 * `_lib/query-reader.ts` against the REAL `serverlessTarget`, so the pool key
 * is compared with the key every other route targeting master receives.
 *
 * What breaks each test:
 *   - own pool: READER_POOL_PREFIX emptied (the key would equal
 *     serverlessTarget('master').cacheKey) or readerTarget returning the base target.
 *   - no serverlessTarget key can equal it: a prefix that itself starts with
 *     `serverless:` (serverlessTarget(<rest>) would produce it).
 *   - batch: the USE prefix dropped, or given a line break.
 *   - messages: the filter removed, widened to every message, or matching a
 *     USE into another database.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { serverlessTarget } from '@/lib/azure/synapse-sql-client';
import { readerTarget, readerBatch, withoutReaderUseMessage } from '../_lib/query-reader';

beforeEach(() => {
  process.env.LOOM_SYNAPSE_WORKSPACE = 'loomsyn';
});

describe('readerTarget', () => {
  it('is serverless master on a pool key of its own', () => {
    const shared = serverlessTarget('master');
    const reader = readerTarget();
    expect(reader.server).toBe(shared.server);
    expect(reader.database).toBe('master');
    expect(reader.cacheKey).toBe('lakehouse-reader:serverless:loomsyn:master');
    expect(reader.cacheKey).not.toBe(shared.cacheKey);
  });

  it('no database name passed to serverlessTarget produces the reader key', () => {
    const key = readerTarget().cacheKey;
    // The suffix after each possible split point, tried as a database name.
    for (let i = 0; i <= key.length; i += 1) {
      expect(serverlessTarget(key.slice(i)).cacheKey).not.toBe(key);
    }
  });
});

describe('readerBatch', () => {
  it('starts the batch with USE [master]; on the same line as the text', () => {
    expect(readerBatch('SELECT 1')).toBe('USE [master]; SELECT 1');
    expect(readerBatch('SELECT 1\nFROM t').split('\n')).toEqual(['USE [master]; SELECT 1', 'FROM t']);
  });
});

describe('withoutReaderUseMessage', () => {
  it('drops the one message for the added USE and keeps the rest in order', () => {
    expect(withoutReaderUseMessage(["Changed database context to 'master'.", 'a', 'b'])).toEqual(['a', 'b']);
  });

  it('drops only the first such message', () => {
    const m = "Changed database context to 'master'.";
    expect(withoutReaderUseMessage([m, m])).toEqual([m]);
  });

  it('keeps a message about another database', () => {
    const m = "Changed database context to 'lakedb'.";
    expect(withoutReaderUseMessage([m])).toEqual([m]);
  });

  it('passes an absent list through', () => {
    expect(withoutReaderUseMessage(undefined)).toBeUndefined();
  });
});
