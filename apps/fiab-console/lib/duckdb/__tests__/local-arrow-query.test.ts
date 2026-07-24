/**
 * N2a — in-browser local analysis over an Arrow IPC result.
 *
 * The wasm engine is substituted at the `lib/duckdb/wasm-loader` boundary (the
 * ONE module that touches duckdb-wasm), so these specs exercise the REAL wiring
 * — the real Arrow fixture the serving tier produces, the real registration
 * call, the real statement counting and the real measured stats — with no wasm
 * and no network.
 *
 * What is pinned here is exactly what the timing bar claims on screen: the
 * statement ran locally, it made ZERO network requests, and the fetch cost is a
 * one-time price the session amortizes.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  openLocalSession,
  describeLocalRun,
  quoteIdent,
  DEFAULT_LOCAL_TABLE,
} from '../local-arrow-query';
import { shapeArrowTable, normalizeCell, LocalEngineUnavailable } from '../wasm-loader';
import type { LocalDuckDb, LocalQueryResult } from '../wasm-loader';
import { arrowFixture, ARROW_FIXTURE_BYTES } from './arrow-fixture';

/** A fake engine that records what the real one would have been handed. */
function fakeEngine(result?: LocalQueryResult) {
  const registered: Array<{ name: string; ipc: Uint8Array }> = [];
  const queries: string[] = [];
  let closed = false;
  const db: LocalDuckDb = {
    async registerArrow(name, ipc) { registered.push({ name, ipc }); },
    async query(sql) {
      queries.push(sql);
      return result ?? {
        columns: [{ name: 'product', type: 'Utf8' }, { name: 'amount', type: 'Int64' }],
        rows: [['widget', 175], ['gadget', 250], ['sprocket', 410]],
        rowCount: 3,
      };
    },
    async close() { closed = true; },
  };
  return { db, registered, queries, isClosed: () => closed };
}

const INIT = { fetchMs: 42, sourceRows: 4 };

describe('openLocalSession', () => {
  it('registers the REAL Arrow IPC stream byte-for-byte under the default table name', async () => {
    const engine = fakeEngine();
    const arrow = arrowFixture();
    expect(arrow.byteLength).toBe(ARROW_FIXTURE_BYTES);
    // A valid Arrow IPC *stream* begins with the 0xFFFFFFFF continuation token.
    expect(new DataView(arrow.buffer, arrow.byteOffset).getUint32(0, true)).toBe(0xffffffff);

    await openLocalSession({ ...INIT, arrow, loader: async () => engine.db });

    expect(engine.registered).toHaveLength(1);
    expect(engine.registered[0].name).toBe(DEFAULT_LOCAL_TABLE);
    expect(Array.from(engine.registered[0].ipc)).toEqual(Array.from(arrow));
  });

  it('honours a custom table name and quotes it in the opening SELECT', async () => {
    const engine = fakeEngine();
    const session = await openLocalSession({
      ...INIT, arrow: arrowFixture(), tableName: 'sales "gold"', loader: async () => engine.db,
    });
    await session.selectAll(10);
    expect(engine.registered[0].name).toBe('sales "gold"');
    expect(engine.queries[0]).toBe('SELECT * FROM "sales ""gold""" LIMIT 10');
  });

  it('refuses to open with no bytes, and says what to do instead', async () => {
    await expect(
      openLocalSession({ ...INIT, arrow: new Uint8Array(0), loader: async () => fakeEngine().db }),
    ).rejects.toBeInstanceOf(LocalEngineUnavailable);
  });
});

describe('local execution stats', () => {
  it('reports zero network requests and counts statements served locally', async () => {
    const engine = fakeEngine();
    const session = await openLocalSession({ ...INIT, arrow: arrowFixture(), loader: async () => engine.db });

    const first = await session.run('SELECT product, sum(amount) FROM result GROUP BY 1');
    expect(first.stats.ranOn).toBe('browser');
    expect(first.stats.networkRequests).toBe(0);
    expect(first.stats.statementsServed).toBe(1);
    expect(first.stats.sourceBytes).toBe(ARROW_FIXTURE_BYTES);
    expect(first.stats.sourceRows).toBe(4);
    expect(first.stats.fetchMs).toBe(42);
    expect(first.rows).toHaveLength(3);

    const second = await session.run('SELECT * FROM result WHERE region = \'east\'');
    expect(second.stats.statementsServed).toBe(2);
    expect(session.statementsServed).toBe(2);
    // Still zero: the whole point is that nothing after the first fetch is remote.
    expect(second.stats.networkRequests).toBe(0);
    // And the engine really was asked BOTH statements, in order.
    expect(engine.queries).toEqual([
      'SELECT product, sum(amount) FROM result GROUP BY 1',
      "SELECT * FROM result WHERE region = 'east'",
    ]);
  });

  it('measures elapsed time rather than reporting a constant', async () => {
    const engine = fakeEngine();
    const session = await openLocalSession({ ...INIT, arrow: arrowFixture(), loader: async () => engine.db });
    const spy = vi.spyOn(performance, 'now');
    spy.mockReturnValueOnce(1000).mockReturnValueOnce(1012.5);
    const outcome = await session.run('SELECT 1');
    expect(outcome.stats.elapsedMs).toBe(12.5);
    spy.mockRestore();
  });

  it('closes the engine when the session closes', async () => {
    const engine = fakeEngine();
    const session = await openLocalSession({ ...INIT, arrow: arrowFixture(), loader: async () => engine.db });
    await session.close();
    expect(engine.isClosed()).toBe(true);
  });
});

describe('describeLocalRun — the sentence the timing bar prints', () => {
  it('states where it ran, that no network was used, and the amortized fetch', () => {
    const text = describeLocalRun({
      ranOn: 'browser',
      elapsedMs: 7.4,
      networkRequests: 0,
      sourceBytes: 640,
      sourceRows: 4,
      statementsServed: 3,
      fetchMs: 42,
    });
    expect(text).toContain('Ran in your browser in 7 ms');
    expect(text).toContain('0 network requests');
    expect(text).toContain('4 rows');
    expect(text).toContain('fetched once in 42 ms');
    expect(text).toContain('3 statements served locally');
  });

  it('renders sub-millisecond runs honestly rather than as 0 ms', () => {
    const text = describeLocalRun({
      ranOn: 'browser', elapsedMs: 0.3, networkRequests: 0,
      sourceBytes: 1024, sourceRows: 1, statementsServed: 1, fetchMs: 5,
    });
    expect(text).toContain('<1 ms');
    expect(text).toContain('1 statement served locally');
  });
});

describe('Arrow result shaping', () => {
  it('projects an Arrow table into columns + positional rows', () => {
    const shaped = shapeArrowTable({
      numRows: 2,
      schema: { fields: [{ name: 'product', type: 'Utf8' }, { name: 'amount', type: 'Int64' }] },
      toArray: () => [{ product: 'widget', amount: 100n }, { product: 'gadget', amount: 250n }],
    });
    expect(shaped.columns).toEqual([
      { name: 'product', type: 'Utf8' },
      { name: 'amount', type: 'Int64' },
    ]);
    expect(shaped.rows).toEqual([['widget', 100], ['gadget', 250]]);
    expect(shaped.rowCount).toBe(2);
  });

  it('keeps an out-of-range bigint exact instead of silently losing precision', () => {
    expect(normalizeCell(12345n)).toBe(12345);
    expect(normalizeCell(9007199254740993n)).toBe('9007199254740993');
  });

  it('normalizes dates and nulls for rendering', () => {
    expect(normalizeCell(new Date('2026-07-23T00:00:00.000Z'))).toBe('2026-07-23T00:00:00.000Z');
    expect(normalizeCell(null)).toBeNull();
    expect(normalizeCell(undefined)).toBeNull();
  });
});

describe('quoteIdent', () => {
  it('doubles embedded quotes so a table name can never break out of the identifier', () => {
    expect(quoteIdent('result')).toBe('"result"');
    expect(quoteIdent('a"; DROP TABLE t; --')).toBe('"a""; DROP TABLE t; --"');
  });
});
