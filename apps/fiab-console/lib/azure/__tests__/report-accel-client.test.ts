/**
 * PR #4776 — the Databricks-SQL (Photon) report accelerator stays OPT-IN.
 *
 * #3744 made `warehouseConfigGate()` pass on a bound workspace alone (the
 * Console can produce `loom-default`). The accel path must NOT inherit that:
 * a bound workspace with no explicit `LOOM_DATABRICKS_SQL_WAREHOUSE_ID` pin
 * keeps reports on Synapse Serverless, exactly as before this PR.
 *
 * What breaks these tests: `reportAccelConfigured` returning
 * `!databricksConfigGate() && !warehouseConfigGate()` (the head-of-PR default-on
 * shape) turns the hostname-only case TRUE; dropping the hostname check turns
 * the pin-only case TRUE.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { reportAccelConfigured, reportAccelGate } from '../report-accel-client';

afterEach(() => { vi.unstubAllEnvs(); });

describe('reportAccelConfigured — opt-in on an explicit warehouse pin', () => {
  it('bound workspace, NO pin -> false (not default-on)', () => {
    vi.stubEnv('LOOM_DATABRICKS_HOSTNAME', 'adb-1.azuredatabricks.net');
    vi.stubEnv('LOOM_DATABRICKS_SQL_WAREHOUSE_ID', '');
    expect(reportAccelConfigured()).toBe(false);
  });

  it('bound workspace + pin -> true', () => {
    vi.stubEnv('LOOM_DATABRICKS_HOSTNAME', 'adb-1.azuredatabricks.net');
    vi.stubEnv('LOOM_DATABRICKS_SQL_WAREHOUSE_ID', 'abc123');
    expect(reportAccelConfigured()).toBe(true);
  });

  it('whitespace-only pin -> false', () => {
    vi.stubEnv('LOOM_DATABRICKS_HOSTNAME', 'adb-1.azuredatabricks.net');
    vi.stubEnv('LOOM_DATABRICKS_SQL_WAREHOUSE_ID', '   ');
    expect(reportAccelConfigured()).toBe(false);
  });

  it('pin but NO workspace -> false', () => {
    vi.stubEnv('LOOM_DATABRICKS_HOSTNAME', '');
    vi.stubEnv('LOOM_DATABRICKS_SQL_WAREHOUSE_ID', 'abc123');
    expect(reportAccelConfigured()).toBe(false);
  });

  it('gate copy names BOTH env vars', () => {
    const g = reportAccelGate();
    expect(g).toMatch(/LOOM_DATABRICKS_HOSTNAME/);
    expect(g).toMatch(/LOOM_DATABRICKS_SQL_WAREHOUSE_ID/);
  });
});
