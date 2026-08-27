/**
 * THE SIXTH SURFACE — `captureSourceSchema` dialled the source after the engine
 * had already refused, which made the refusal message FALSE.
 *
 * The message this platform now shows on a source-type/connection mismatch says:
 *
 *   "no request was sent to either system — this is not a network, DNS, or
 *    firewall problem"
 *
 * That claim is only true if EVERY path honours it. `captureSourceSchema` did
 * not: the CDC connector Start route called it unconditionally, after
 * `runMirrorSnapshot` had returned `Gated`, and it reaches
 * `captureSql → executeParameterized → azure-sql-client`, whose
 * `server.includes('.') ? server : `${server}.${suffix}`` invents the hostname.
 * CDC kind `sqlserver` maps into MIRROR_SQL_FAMILY, and connector validation
 * checks `connectionId` FORMAT only — never its type — so the mismatched pair is
 * creatable there.
 *
 * Fixed in two places, deliberately:
 *   1. the caller stops capturing after a `Gated` verdict, and
 *   2. capture refuses a mis-typed source ITSELF, at the point of dial, so a
 *      SEVENTH caller cannot reintroduce it.
 *
 * (2) is what this file pins. A message whose truth depends on which caller ran
 * is not a fix.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  executeParameterized: vi.fn(async () => [] as any[]),
  executePostgresQuery: vi.fn(async () => ({ columns: [] as string[], rows: [] as unknown[][], executionMs: 1 })),
}));

vi.mock('@/lib/azure/azure-sql-client', () => ({ executeParameterized: h.executeParameterized }));
vi.mock('@/lib/azure/postgres-flex-client', () => ({ executePostgresQuery: h.executePostgresQuery }));

import { captureSourceSchema } from '../schema-capture';
import type { EngineSourceConfig } from '../connector-plane';

/** A CDC connector typed `sqlserver` with a Snowflake connection bound. */
const MISTYPED: EngineSourceConfig = {
  sourceType: 'MSSQL',
  // The Snowflake ACCOUNT IDENTIFIER — no dot, which is precisely why
  // azure-sql-client would bolt the Azure SQL suffix onto it. Obviously fake.
  server: 'fakeorg-fakeacct999',
  database: 'SALES_DB',
  tables: [],
  connType: 'snowflake',
};

beforeEach(() => {
  h.executeParameterized.mockClear();
  h.executePostgresQuery.mockClear();
});

describe('captureSourceSchema refuses a mis-typed source before dialling', () => {
  it('EMBEDDED CONTROL: the same source WITHOUT the mismatch does dial', async () => {
    // Without this the assertions below pass vacuously — a capture that never
    // dialled anything would satisfy them for the wrong reason.
    const { connType, ...compatible } = MISTYPED;
    await captureSourceSchema({ ...compatible, server: 'srv.database.windows.net' });
    expect(h.executeParameterized).toHaveBeenCalled();
  });

  it('sends NO TDS query for a Snowflake connection under a SQL source type', async () => {
    const out = await captureSourceSchema(MISTYPED);
    expect(h.executeParameterized, 'capture dialled a hostname the platform constructed').not.toHaveBeenCalled();
    expect(out).toEqual({});
  });

  it('sends NO pg query for a mismatched PostgreSQL connector either', async () => {
    const out = await captureSourceSchema({
      ...MISTYPED, sourceType: 'AzurePostgreSql', connType: 'snowflake',
    });
    expect(h.executePostgresQuery).not.toHaveBeenCalled();
    expect(out).toEqual({});
  });

  it('the account identifier never reaches the SQL client at all', async () => {
    await captureSourceSchema(MISTYPED);
    const everyArg = h.executeParameterized.mock.calls.flat();
    expect(everyArg).not.toContain('fakeorg-fakeacct999');
  });

  it('still captures normally when a MATCHING connection is bound', async () => {
    h.executeParameterized.mockResolvedValueOnce([
      { s: 'dbo', t: 'Orders', c: 'Id' }, { s: 'dbo', t: 'Orders', c: 'Total' },
    ] as any);
    const out = await captureSourceSchema({
      ...MISTYPED, server: 'srv.database.windows.net', connType: 'generic-sql',
    });
    expect(h.executeParameterized).toHaveBeenCalled();
    expect(out).toEqual({ 'dbo.Orders': ['Id', 'Total'] });
  });

  it('an UNKNOWN connection type is not a mismatch — the UAMI path still captures', async () => {
    // R7 both ways. A connector with no connection bound authenticates as the
    // Console UAMI by design; refusing it because we could not establish a type
    // would be the same class of false claim the guard exists to remove.
    const { connType, ...noConn } = MISTYPED;
    await captureSourceSchema({ ...noConn, server: 'srv.database.windows.net' });
    expect(h.executeParameterized).toHaveBeenCalled();
  });
});
