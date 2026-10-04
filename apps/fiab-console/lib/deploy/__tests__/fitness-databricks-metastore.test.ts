/**
 * #3342 — `databricks.metastoreAssignment` is READ, and its blocker names the
 * grant that clears it.
 *
 * Before this the probe never read the assignment, so the check was `unknown`
 * on every Databricks adopt and its remediation ("grant the scanning identity
 * Reader on this resource") could not clear it: the assignment lives on the
 * Databricks ACCOUNT plane, not on the Azure resource. Every test drives the
 * REAL `probeAdoption` → `evaluateFitness`; only ARM and the account API are
 * stubbed.
 */
import { describe, expect, it } from 'vitest';
import {
  probeAdoption,
  readDatabricksMetastore,
  regionalMetastoreId,
  type AccountAdminValues,
  type MetastoreRead,
  type MetastoreReader,
  type ProbeContext,
} from '../fitness-probe';
import { DATABRICKS_ACCOUNT_ADMIN_GATE } from '../fitness';
import type { DiscoveryTransport, HttpResult } from '../discovery-scanner';

const TARGET = { name: 'dbw-existing', rg: 'rg-existing', sub: '11111111-2222-3333-4444-555555555555' };
const CTX: ProbeContext = { hubRegion: 'eastus2', hubTenantId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
const VALUES: AccountAdminValues = {
  consoleClientId: 'c1d2e3f4-0000-1111-2222-333344445555',
  consolePrincipalId: 'a9b8c7d6-0000-1111-2222-333344445555',
  accountId: 'acct-0f0f',
  accountConsoleUrl: 'https://accounts.azuredatabricks.net',
};

function transport(): DiscoveryTransport {
  const dbw: HttpResult = {
    status: 200,
    body: { location: 'eastus2', sku: { name: 'premium' }, properties: { workspaceId: '4242', publicNetworkAccess: 'Enabled' } },
  };
  return {
    async argQuery(): Promise<HttpResult> { throw new Error('unused'); },
    async armGet(_t: string, url: string): Promise<HttpResult> {
      if (url.includes('databricks/workspaces/dbw-existing?')) return dbw;
      return { status: 200, body: { value: [] } };
    },
  };
}

function reader(read: MetastoreRead, values: AccountAdminValues = VALUES): MetastoreReader & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async values() { return values; },
    async read(ws: string, region: string) { asked.push(`${ws}@${region}`); return read; },
  };
}

const metastoreCheck = async (r: MetastoreReader) =>
  (await probeAdoption('databricks', TARGET, CTX, 'tok', transport(), r)).fitness.checks
    .find((c) => c.id === 'databricks.metastoreAssignment');

describe('regionalMetastoreId — the same pick enable-unity-catalog.sh makes', () => {
  const ms = [{ metastore_id: 'm-west', region: 'westus' }, { metastore_id: 'm-east2', region: 'eastus2' }];
  // Breaks if the region filter is dropped (would return m-west, the first).
  it('picks the metastore in the hub region, normalising spelling', () => {
    expect(regionalMetastoreId(ms, 'East US 2')).toBe('m-east2');
  });
  it('is null when the account has no metastore in that region', () => {
    expect(regionalMetastoreId(ms, 'northeurope')).toBeNull();
  });
});

describe('readDatabricksMetastore', () => {
  it('asks the account API nothing when the account id is unset, and says so', async () => {
    const r = reader({ ok: true, metastoreId: null, loomMetastoreId: null }, { ...VALUES, accountId: null });
    const out = await readDatabricksMetastore({ properties: { workspaceId: 1 } }, 'eastus2', r);
    expect(r.asked).toEqual([]);
    expect((out.properties.metastoreReadBlocked as any).reason).toBe('account-id-unset');
    expect(out.properties).not.toHaveProperty('metastoreId');
  });

  it('asks about the numeric workspace id ARM returned, in the hub region', async () => {
    const r = reader({ ok: true, metastoreId: 'm1', loomMetastoreId: 'm1' });
    const out = await readDatabricksMetastore({ properties: { workspaceId: 4242 } }, 'eastus2', r);
    expect(r.asked).toEqual(['4242@eastus2']);
    expect(out.properties).toEqual({ metastoreId: 'm1', loomMetastoreId: 'm1' });
  });
});

describe('databricks.metastoreAssignment through the real probe', () => {
  it('a refused read is UNKNOWN, names the account-admin grant with live values, and carries the gate', async () => {
    const c = await metastoreCheck(reader({ ok: false, reason: 'not-account-admin', detail: 'the Databricks account API refused the Console identity (HTTP 403: not an account admin)' }));
    expect(c?.verdict).toBe('unknown');
    expect(c?.established).toContain('HTTP 403');
    const rem = c?.remediation as any;
    // Breaks if this falls back to the generic unknownProp remediation: that
    // one has no gateId and tells the operator to grant Reader on the resource.
    expect(rem.gateId).toBe(DATABRICKS_ACCOUNT_ADMIN_GATE);
    expect(rem.description).toContain(VALUES.consoleClientId);
    expect(rem.description).toContain(VALUES.consolePrincipalId);
    expect(rem.description).not.toContain('Reader on this resource');
    expect(rem.portalUrl).toBe(VALUES.accountConsoleUrl);
    expect(rem.role.scope).toContain(VALUES.accountId);
  });

  /**
   * THE CONTROL: same workspace, same ARM body — only the account API's answer
   * changes, and the blocker CLEARS. This is the "re-check clears itself" claim:
   * if the probe stopped reading the account plane, this stays `unknown`.
   */
  it('once the account answers "no assignment", the check passes', async () => {
    const c = await metastoreCheck(reader({ ok: true, metastoreId: null, loomMetastoreId: 'm-east2' }));
    expect(c?.verdict).toBe('pass');
  });

  it('a workspace on the regional (Loom) metastore passes; one on another metastore fails', async () => {
    expect((await metastoreCheck(reader({ ok: true, metastoreId: 'm-east2', loomMetastoreId: 'm-east2' })))?.verdict).toBe('pass');
    expect((await metastoreCheck(reader({ ok: true, metastoreId: 'm-other', loomMetastoreId: 'm-east2' })))?.verdict).toBe('fail');
  });

  it('an inconclusive read stays unknown and records exactly what was observed', async () => {
    const c = await metastoreCheck(reader({ ok: false, reason: 'inconclusive', detail: 'the Databricks account API read did not complete (HTTP 503: unavailable)' }));
    expect(c?.verdict).toBe('unknown');
    expect(c?.established).toContain('HTTP 503');
    expect((c?.remediation as any).gateId).toBe(DATABRICKS_ACCOUNT_ADMIN_GATE);
  });
});
