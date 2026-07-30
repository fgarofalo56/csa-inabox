/**
 * The copy-job control database must be unreachable as a user source/sink even
 * when the caller renames the linked service.
 *
 * The round-2 fix reserved the NAME `loom-copy-control-sql`. The round-3 review
 * pointed out that keys on the ADF artifact name, not the connection TARGET —
 * nothing stops a caller creating their own linked service, under any name they
 * like, whose connection string points at the same control server. The name
 * reservation passes and the SQL still runs against `dbo.copy_watermark` as the
 * factory managed identity, which holds every tenant's watermarks and CDC LSNs.
 *
 * These are ATTACK tests: the rename must NOT buy access.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertUserLinkedServiceTarget } from '../copy-job-sql';

const CONTROL = 'sql-loom-control.database.windows.net';

/** A linked service whose connection string points wherever we say. */
const lsPointingAt = (server: string) => async () => ({
  properties: {
    typeProperties: {
      connectionString: `Server=tcp:${server},1433;Database=loomcontrol;Encrypt=True;`,
    },
  },
});

describe('assertUserLinkedServiceTarget', () => {
  const prev = process.env.LOOM_COPYJOB_CONTROL_SQL_SERVER;
  beforeEach(() => { process.env.LOOM_COPYJOB_CONTROL_SQL_SERVER = CONTROL; });
  afterEach(() => {
    if (prev === undefined) delete process.env.LOOM_COPYJOB_CONTROL_SQL_SERVER;
    else process.env.LOOM_COPYJOB_CONTROL_SQL_SERVER = prev;
  });

  it('ATTACK: a RENAMED linked service pointing at the control server is refused', async () => {
    // The name is innocuous — this is precisely the bypass the name check misses.
    await expect(
      assertUserLinkedServiceTarget('my-totally-normal-source', 'source.linkedService', lsPointingAt(CONTROL)),
    ).rejects.toThrow(/control server/i);
  });

  it('ATTACK: case-differing server spelling is still refused', async () => {
    await expect(
      assertUserLinkedServiceTarget('src', 'source.linkedService', lsPointingAt(CONTROL.toUpperCase())),
    ).rejects.toThrow(/control server/i);
  });

  it('ATTACK: the discrete `server` field shape is also checked', async () => {
    const ls = async () => ({ properties: { typeProperties: { server: CONTROL, database: 'loomcontrol' } } });
    await expect(
      assertUserLinkedServiceTarget('src', 'sink.linkedService', ls),
    ).rejects.toThrow(/control server/i);
  });

  it('FAILS CLOSED when the definition cannot be read', async () => {
    // Proceeding on an unknown target is the gap; refusing is the whole point.
    const boom = async () => { throw new Error('ARM 403'); };
    await expect(
      assertUserLinkedServiceTarget('src', 'source.linkedService', boom),
    ).rejects.toThrow(/Refusing rather than running SQL/i);
  });

  it('permits a linked service that points at the tenant own data', async () => {
    await expect(
      assertUserLinkedServiceTarget('src', 'source.linkedService', lsPointingAt('sql-customer.database.windows.net')),
    ).resolves.toBeUndefined();
  });

  it('is a no-op when no control server is configured (nothing to protect)', async () => {
    delete process.env.LOOM_COPYJOB_CONTROL_SQL_SERVER;
    await expect(
      assertUserLinkedServiceTarget('src', 'source.linkedService', lsPointingAt(CONTROL)),
    ).resolves.toBeUndefined();
  });
});
