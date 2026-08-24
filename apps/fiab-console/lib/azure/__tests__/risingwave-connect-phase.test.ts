/**
 * #3546 — RisingWave CONNECT-phase attribution + connect budget.
 *
 * TWO defects, both deploy-integrity R7 ("an error must not state as fact
 * something it did not establish"):
 *
 *  1. `connectionTimeoutMillis` was 20_000 — the SAME value as the console
 *     client's own per-request ceiling (`lib/client-fetch.ts`
 *     CLIENT_FETCH_TIMEOUT_MS = 20_000). Both deadlines expired together, so the
 *     browser aborted at the exact moment this code would have produced its
 *     diagnosis. Every connect failure reached the operator as the generic
 *     client-side timeout copy instead.
 *  2. A connect failure and a statement failure were surfaced identically. They
 *     carry completely different remediations — "the tier is cold / unreachable"
 *     vs "your SQL failed" — and the code always knows which one happened,
 *     because it either got past `client.connect()` or it did not.
 *
 * TEST SHAPE — the assertions below deliberately attack the NARROW fix that
 * would pass a naive suite: attributing the phase by sniffing the driver
 * message for /timeout/. Two cases make that impossible to fake:
 *   - a connect failure whose message contains NO timeout wording (ECONNREFUSED)
 *     must still be phase 'connect';
 *   - a connect failure and a statement failure carrying the BYTE-IDENTICAL
 *     driver message must still be told apart.
 * Only positional attribution (did we get past connect?) satisfies both.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** Mutable knobs the hoisted `pg` mock reads. */
const h = vi.hoisted(() => ({
  /** Rejection for client.connect(); null → connect succeeds. */
  connectError: null as any,
  /** Rejection for client.query(); null → query succeeds. */
  queryError: null as any,
  /** Every Client config the driver was constructed with, in order. */
  configs: [] as any[],
  /** How many times connect() / query() / end() were called. */
  calls: { connect: 0, query: 0, end: 0 },
}));

vi.mock('pg', () => ({
  Client: class {
    constructor(cfg: any) { h.configs.push(cfg); }
    async connect() {
      h.calls.connect += 1;
      if (h.connectError) throw h.connectError;
    }
    async query() {
      h.calls.query += 1;
      if (h.queryError) throw h.queryError;
      return { fields: [{ name: 'ok' }], rows: [{ ok: 1 }], command: 'SELECT' };
    }
    async end() { h.calls.end += 1; }
  },
}));

const SAVED = { ...process.env };
beforeEach(() => {
  process.env.LOOM_RISINGWAVE_URL = 'loom-risingwave.internal:4566';
  h.connectError = null;
  h.queryError = null;
  h.configs = [];
  h.calls = { connect: 0, query: 0, end: 0 };
});
afterEach(() => { process.env = { ...SAVED }; vi.restoreAllMocks(); });

/** The pg driver's real connection-timeout rejection carries no `code`. */
const timeoutErr = () => Object.assign(new Error('timeout expired'), { code: undefined });
/** A refused TCP connect — note: NO timeout wording anywhere in the message. */
const refusedErr = () => Object.assign(new Error('connect ECONNREFUSED 10.0.0.4:4566'), { code: 'ECONNREFUSED' });

describe('#3546 — the connect budget must fit INSIDE the client budget', () => {
  it('leaves the caller a real margin — not merely a connectionTimeoutMillis one ms under the ceiling', async () => {
    const { CLIENT_FETCH_TIMEOUT_MS } = await import('../../client-fetch');
    const { RISINGWAVE_CONNECT_TIMEOUT_MS, runStreamingQuery } = await import('../risingwave-client');
    await runStreamingQuery('SELECT 1');

    // POPULATION: exactly one driver construction happened, so the config we
    // assert on is not an empty set silently passing.
    expect(h.configs).toHaveLength(1);

    // THE REGRESSION. These two were EQUAL (20_000 === 20_000), which is why
    // the server could never win the race and explain itself.
    expect(h.configs[0].connectionTimeoutMillis).toBe(RISINGWAVE_CONNECT_TIMEOUT_MS);
    expect(RISINGWAVE_CONNECT_TIMEOUT_MS).toBeLessThan(CLIENT_FETCH_TIMEOUT_MS);

    // A BARE `<` IS NOT THE PROPERTY. A reviewer set this to 19_999 — one
    // millisecond inside the client ceiling — and the suite stayed green at
    // RC=0 while functionally re-creating #3546: the server still has no time
    // to build and return its diagnosis before the browser aborts. The real
    // property is a MARGIN. The connect budget may consume at most HALF the
    // caller's budget, leaving the other half for the failure to be classified,
    // serialized and returned through the BFF.
    expect(RISINGWAVE_CONNECT_TIMEOUT_MS).toBeLessThanOrEqual(CLIENT_FETCH_TIMEOUT_MS / 2);
    // …and a floor, so the margin cannot be "won" by shrinking the connect
    // budget to something that flaps on a cold in-VNet TCP + Postgres handshake.
    expect(RISINGWAVE_CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(3_000);
  });

  it('does NOT shrink the statement budget while bounding the connect budget', async () => {
    // The fix must not "solve" the timeout by capping the query — a 120s DDL is
    // legitimate. connect and statement are independent budgets.
    const { executeStreamingDdl } = await import('../risingwave-client');
    await executeStreamingDdl('CREATE MATERIALIZED VIEW v AS SELECT 1');
    expect(h.configs[0].statement_timeout).toBe(120_000);
    expect(h.configs[0].connectionTimeoutMillis).toBeLessThan(h.configs[0].statement_timeout);
  });
});

describe('#3546 — phase attribution is POSITIONAL, not message-sniffing', () => {
  it('labels a connect TIMEOUT as the connect phase', async () => {
    h.connectError = timeoutErr();
    const { runStreamingQuery } = await import('../risingwave-client');
    await expect(runStreamingQuery('SELECT 1')).rejects.toMatchObject({ phase: 'connect' });
    // No statement was sent — the message's central claim must be true.
    expect(h.calls.query).toBe(0);
  });

  it('labels a REFUSED connect (no timeout wording) as the connect phase', async () => {
    // THE NARROW-BYPASS KILLER. A fix that greps the driver message for
    // /timeout/ passes the case above and FAILS here.
    h.connectError = refusedErr();
    const { runStreamingQuery } = await import('../risingwave-client');
    const err: any = await runStreamingQuery('SELECT 1').catch((e) => e);
    expect(err.phase).toBe('connect');
    expect(String(err.message)).not.toMatch(/timeout/i);
    expect(h.calls.query).toBe(0);
  });

  it('labels a STATEMENT failure as the statement phase', async () => {
    h.queryError = Object.assign(new Error('syntax error at or near "SELCT"'), { code: '42601' });
    const { runStreamingQuery } = await import('../risingwave-client');
    await expect(runStreamingQuery('SELECT 1')).rejects.toMatchObject({ phase: 'statement', code: '42601' });
    expect(h.calls.connect).toBe(1);
    expect(h.calls.query).toBe(1);
  });

  it('tells the two phases apart even when the driver message is BYTE-IDENTICAL', async () => {
    // The strongest form of the same point: give both phases the exact same
    // Error. Any message-derived attribution is now provably impossible.
    const identical = () => Object.assign(new Error('timeout expired'), { code: 'X' });
    const mod = await import('../risingwave-client');

    h.connectError = identical();
    const a: any = await mod.runStreamingQuery('SELECT 1').catch((e) => e);

    h.connectError = null;
    h.queryError = identical();
    const b: any = await mod.runStreamingQuery('SELECT 1').catch((e) => e);

    expect(a.phase).toBe('connect');
    expect(b.phase).toBe('statement');
    expect(a.phase).not.toBe(b.phase);
  });

  it('applies to the DDL (Materialize) path too — the reported symptom', async () => {
    h.connectError = timeoutErr();
    const { executeStreamingDdl } = await import('../risingwave-client');
    await expect(executeStreamingDdl('CREATE MATERIALIZED VIEW v AS SELECT 1'))
      .rejects.toMatchObject({ phase: 'connect' });
  });

  it('applies to the status path too', async () => {
    h.connectError = timeoutErr();
    const { readStreamingStatus } = await import('../risingwave-client');
    await expect(readStreamingStatus()).rejects.toMatchObject({ phase: 'connect' });
  });
});

describe('#3546 — the connect message states only what was established (R7)', () => {
  it('says CONNECT phase, names the target, and says no statement ran', async () => {
    h.connectError = timeoutErr();
    const { runStreamingQuery } = await import('../risingwave-client');
    const err: any = await runStreamingQuery('SELECT 1').catch((e) => e);
    const m = String(err.message);
    expect(m).toContain('loom-risingwave.internal:4566');
    expect(m).toMatch(/CONNECT phase/);
    expect(m).toMatch(/no statement was sent/i);
  });

  it('explicitly records what is NOT established, rather than asserting a cause', async () => {
    // The rule this encodes: a cold scale-to-zero replica, a blocked VNet path
    // and a stopped container are indistinguishable from here. Picking one and
    // asserting it is exactly the R7 violation that sent two investigations down
    // the wrong path on 2026-08-05.
    h.connectError = timeoutErr();
    const { runStreamingQuery } = await import('../risingwave-client');
    const err: any = await runStreamingQuery('SELECT 1').catch((e) => e);
    const m = String(err.message);
    expect(m).toMatch(/NOT established/);
    expect(m).toMatch(/whether the engine is running/i);
    // Must NOT flatly assert the tier is down / scaled to zero as a fact.
    expect(m).not.toMatch(/\bis (?:down|stopped|scaled to zero)\b/i);
  });

  it('closes the half-open client so a failed connect does not leak a socket', async () => {
    h.connectError = timeoutErr();
    const { runStreamingQuery } = await import('../risingwave-client');
    await runStreamingQuery('SELECT 1').catch(() => { /* asserted elsewhere */ });
    expect(h.calls.end).toBeGreaterThanOrEqual(1);
  });
});
