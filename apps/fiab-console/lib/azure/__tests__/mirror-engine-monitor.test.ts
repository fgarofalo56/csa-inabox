/**
 * getMirrorStatus / restartMirrorSnapshot — unit tests.
 *
 * These exercise the new Monitor + lifecycle surface of the mirror engine
 * WITHOUT hitting Azure: with LOOM_BRONZE_URL and the ADF env vars unset,
 * getMirrorStatus() skips the ADLS landing probe and the ADF telemetry call,
 * reducing to a pure projection of the Cosmos `tablesStatus` into the Monitor
 * grid shape. restartMirrorSnapshot() is asserted to delegate through
 * runMirrorSnapshot() and honestly gate (rather than throw) for an unconfigured
 * source — no mocks, no fabricated data.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getMirrorStatus, restartMirrorSnapshot, type MirrorSource } from '../mirror-engine';

beforeEach(() => {
  // Ensure the ADLS + ADF best-effort probes are skipped so the test is
  // deterministic and offline (they degrade gracefully when unconfigured).
  delete process.env.LOOM_BRONZE_URL;
  delete process.env.LOOM_SUBSCRIPTION_ID;
  delete process.env.LOOM_DLZ_RG;
  delete process.env.LOOM_ADF_NAME;
});

describe('getMirrorStatus', () => {
  it('projects Cosmos tablesStatus into the Monitor grid shape', async () => {
    const state = {
      mirroringStatus: 'Running',
      lastStateChange: '2026-06-06T14:23:11.000Z',
      lastRun: { basePath: 'https://acct.dfs.core.windows.net/bronze/mirrors/ws/m/' },
      tablesStatus: [
        { schema: 'dbo', table: 'Orders', status: 'replicated', rows: 12450, bytes: 2340234, lastSync: '2026-06-06T14:23:11.000Z', mode: 'snapshot' },
        { schema: 'dbo', table: 'Items', status: 'error', rows: 0, bytes: 0, lastSync: '2026-06-06T14:00:00.000Z', error: 'boom' },
        { schema: 'sales', table: 'Leads', status: 'replicated', rows: 7, bytes: 99, lastSync: '2026-06-06T15:00:00.000Z', mode: 'incremental', note: 'No changes since the last sync.' },
      ],
    };
    const out = await getMirrorStatus('m', 'ws', state, 'prod_sales');

    expect(out.mirroringStatus).toBe('Running');
    expect(out.lastStateChange).toBe('2026-06-06T14:23:11.000Z');
    expect(out.basePath).toContain('/bronze/mirrors/ws/m/');
    expect(out.tables).toHaveLength(3);

    const orders = out.tables[0];
    expect(orders).toMatchObject({ schema: 'dbo', table: 'Orders', status: 'Replicated', rows: 12450, bytes: 2340234, mode: 'snapshot' });
    expect(orders.lastSync).toBe('2026-06-06T14:23:11.000Z');
    // No ADLS probe when LOOM_BRONZE_URL is unset.
    expect(orders.landingFiles).toBeUndefined();

    expect(out.tables[1]).toMatchObject({ status: 'Error', error: 'boom' });
    expect(out.tables[2]).toMatchObject({ status: 'Replicated', mode: 'incremental', note: 'No changes since the last sync.' });

    // ADF telemetry skipped when the factory env vars are unset.
    expect(out.adfLastRun).toBeUndefined();
    // The note embeds the derived provisioner pipeline name (adfSafeName + _to_bronze).
    expect(out.note).toContain('prod_sales_to_bronze');
  });

  it('defaults missing status/rows and maps unknown table status to NotStarted', async () => {
    const out = await getMirrorStatus('m', 'ws', { tablesStatus: [{ schema: 's', table: 't' }] }, 'My Mirror!');
    expect(out.mirroringStatus).toBe('NotStarted');
    expect(out.tables[0]).toMatchObject({ status: 'NotStarted', rows: 0, bytes: 0 });
    expect(out.tables[0].lastSync).toBeNull();
    // displayName 'My Mirror!' → adfSafeName 'My_Mirror_' → pipeline 'My_Mirror__to_bronze'.
    expect(out.note).toContain('My_Mirror__to_bronze');
  });

  it('handles empty state with no tables', async () => {
    const out = await getMirrorStatus('m', 'ws', {}, 'x');
    expect(out.mirroringStatus).toBe('NotStarted');
    expect(out.tables).toEqual([]);
  });
});

describe('restartMirrorSnapshot', () => {
  it('delegates to runMirrorSnapshot and gates honestly for an unconfigured source', async () => {
    const src: MirrorSource = { sourceType: 'AzureSqlDatabase', server: '', database: '' };
    const res = await restartMirrorSnapshot('m', 'ws', src);
    expect(res.status).toBe('Gated');
    expect(res.backend).toBe('azure-native-cdc');
    expect(res.gate?.missing).toContain('source server');
  });

  it('gates an unsupported source type without throwing', async () => {
    const src: MirrorSource = { sourceType: 'Snowflake', server: 's', database: 'd' };
    const res = await restartMirrorSnapshot('m', 'ws', src);
    expect(res.status).toBe('Gated');
    expect(res.ok).toBe(false);
  });
});
