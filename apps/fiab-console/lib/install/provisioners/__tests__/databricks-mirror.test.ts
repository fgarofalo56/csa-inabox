/**
 * Unit tests for the Databricks-UC-mirror pairing helpers (audit H8).
 *
 * Covers splitAbfss (the abfss/https → external-data-source root + relative path
 * parser used to register one EXTERNAL DATA SOURCE per storage account) and the
 * mirrored-databricks → synapse-serverless-sql-pool pairing rule's deriveContent
 * (the gate that only pairs when real UC Delta tables were resolved).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const resolveUcMirrorTables = vi.fn();
const selfGrantUcMirrorPrivileges = vi.fn();

// Only the two functions the provisioner CALLS are stubbed. `UC_MIRROR_PRIVILEGES`
// is re-exported verbatim so the assertions below read the real privilege list —
// a hand-copied one would keep passing after the real list changed.
vi.mock('@/lib/azure/databricks-uc-mirror', () => ({
  resolveUcMirrorTables: (...a: unknown[]) => resolveUcMirrorTables(...a),
  selfGrantUcMirrorPrivileges: (...a: unknown[]) => selfGrantUcMirrorPrivileges(...a),
  UC_MIRROR_PRIVILEGES: ['USE_CATALOG', 'USE_SCHEMA', 'SELECT'],
}));

import { splitAbfss } from '../synapse-serverless-sql-pool';
import { ITEM_PAIRING_RULES } from '@/lib/items/registry';
import { mirroredDatabricksProvisioner } from '../mirrored-databricks';

describe('splitAbfss', () => {
  it('parses an abfss:// Delta location into root + relative', () => {
    const r = splitAbfss('abfss://unity@dbxstore.dfs.core.windows.net/catalogs/main/sales/_external');
    expect(r).toEqual({
      root: 'abfss://unity@dbxstore.dfs.core.windows.net/',
      relative: 'catalogs/main/sales/_external',
    });
  });

  it('parses an https dfs location into an abfss root + relative', () => {
    const r = splitAbfss('https://dbxstore.dfs.core.windows.net/unity/catalogs/main/orders');
    expect(r).toEqual({
      root: 'abfss://unity@dbxstore.dfs.core.windows.net/',
      relative: 'catalogs/main/orders',
    });
  });

  it('groups tables in the same container under one root', () => {
    const a = splitAbfss('abfss://unity@acct.dfs.core.windows.net/a/t1');
    const b = splitAbfss('abfss://unity@acct.dfs.core.windows.net/b/t2');
    expect(a?.root).toBe(b?.root);
  });

  it('returns null for an unparseable URI (caller falls back to absolute BULK)', () => {
    expect(splitAbfss('s3://bucket/path')).toBeNull();
  });
});

describe("ITEM_PAIRING_RULES['mirrored-databricks'] deriveContent", () => {
  const rule = ITEM_PAIRING_RULES['mirrored-databricks'][0];
  const input: any = { cosmosItemId: 'mdbx-1', displayName: 'Unity main', content: { catalogName: 'main' } };

  it('pairs when UC Delta tables were resolved', () => {
    const tables = [{ schema: 'sales', table: 'orders', storageLocation: 'abfss://u@a.dfs.core.windows.net/orders' }];
    const result: any = { secondaryIds: { ucTablesJson: JSON.stringify(tables), catalogName: 'main' } };
    const out = rule.deriveContent(result, input);
    expect(out).not.toBeNull();
    expect(out!.databricksMirrorItemId).toBe('mdbx-1');
    expect(out!.ucCatalogName).toBe('main');
    expect(Array.isArray(out!.ucTables)).toBe(true);
    expect((out!.ucTables as unknown[]).length).toBe(1);
  });

  it('honest-skips (null) when Databricks resolved no tables', () => {
    const result: any = { secondaryIds: {} };
    expect(rule.deriveContent(result, input)).toBeNull();
  });

  it('honest-skips (null) on an empty table list', () => {
    const result: any = { secondaryIds: { ucTablesJson: '[]' } };
    expect(rule.deriveContent(result, input)).toBeNull();
  });
});

/**
 * #3509 — the mirror GRANTS its own Unity Catalog privileges.
 *
 * THE DEFECT. This item type's only path answered a privilege-shaped failure
 * with status:'remediation' telling the operator to grant USE CATALOG / USE
 * SCHEMA / SELECT to the Console UAMI by hand, while `unity-catalog-client` had
 * exported `updatePermissions()` and `grantPrivilegesSQL()` the whole time and
 * `/api/catalog/permissions` called them in production. auto-bind-by-default.md:
 * a gate over an action the platform could perform is a defect.
 *
 * THE TRIGGER IS SYMPTOM-SHAPED, and that is the load-bearing detail. Unity
 * Catalog HIDES securables the caller cannot see, so a missing SELECT surfaces
 * as NO_TABLES ("catalog has no queryable Delta tables"), not as a 403. A
 * self-heal keyed only to a 403 would look correct and never fire on the case
 * that actually happens.
 *
 * MUTATION-PROVEN: delete the `selfGrantUcMirrorPrivileges` call and both
 * self-heal tests go RED; make the post-grant gate re-print "grant USE CATALOG /
 * USE SCHEMA / SELECT" and the R7 test goes RED.
 *
 * NOT A COMPLETION RECEIPT: the UC client is mocked, so this pins control flow,
 * not a live Databricks grant (ux-baseline.md G1).
 */
describe('mirroredDatabricksProvisioner self-grant (#3509)', () => {
  const TABLES = [{ schema: 'sales', table: 'orders', storageLocation: 'abfss://u@a.dfs.core.windows.net/orders' }];
  const okRes = { ok: true, catalogName: 'main', tables: TABLES, skipped: 0 };
  const noTables = { ok: false, code: 'NO_TABLES', error: 'no queryable Delta tables', catalogName: 'main', tables: [], skipped: 3 };

  const run = () =>
    mirroredDatabricksProvisioner({ displayName: 'Unity main', content: { catalogName: 'main' } } as never);

  let savedClientId: string | undefined;

  beforeEach(() => {
    savedClientId = process.env.LOOM_UAMI_CLIENT_ID;
    process.env.LOOM_UAMI_CLIENT_ID = 'uami-app-id';
    resolveUcMirrorTables.mockReset();
    selfGrantUcMirrorPrivileges.mockReset();
    selfGrantUcMirrorPrivileges.mockResolvedValue({ granted: true, principal: 'uami-app-id' });
  });

  afterEach(() => {
    if (savedClientId === undefined) delete process.env.LOOM_UAMI_CLIENT_ID;
    else process.env.LOOM_UAMI_CLIENT_ID = savedClientId;
  });

  it('grants and retries when the catalog resolves NO_TABLES — the shape a missing SELECT takes', async () => {
    // THE REGRESSION TEST. On main this returned status:'remediation' saying
    // "ensure the Console UAMI has USE CATALOG / USE SCHEMA / SELECT".
    resolveUcMirrorTables.mockResolvedValueOnce(noTables).mockResolvedValueOnce(okRes);

    const r = await run();

    expect(selfGrantUcMirrorPrivileges).toHaveBeenCalledTimes(1);
    expect(selfGrantUcMirrorPrivileges).toHaveBeenCalledWith('main');
    expect(r.status).toBe('created');
    expect(r.secondaryIds!.tableCount).toBe('1');
    expect((r.steps ?? []).join(' ')).toMatch(/Granted USE_CATALOG \/ USE_SCHEMA \/ SELECT on CATALOG main to uami-app-id/);
  });

  it('grants and retries on a hard ERROR too — a missing USE CATALOG throws on the schema list', async () => {
    resolveUcMirrorTables
      .mockResolvedValueOnce({ ok: false, code: 'ERROR', error: 'PERMISSION_DENIED', tables: [], skipped: 0 })
      .mockResolvedValueOnce(okRes);

    const r = await run();

    expect(selfGrantUcMirrorPrivileges).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('created');
  });

  it('does NOT grant when the catalog resolved cleanly the first time', async () => {
    resolveUcMirrorTables.mockResolvedValueOnce(okRes);
    const r = await run();
    expect(selfGrantUcMirrorPrivileges).not.toHaveBeenCalled();
    expect(r.status).toBe('created');
  });

  it('attempts the grant AT MOST ONCE — a still-empty catalog fails closed, it does not loop', async () => {
    resolveUcMirrorTables.mockResolvedValue(noTables);
    const r = await run();
    expect(selfGrantUcMirrorPrivileges).toHaveBeenCalledTimes(1);
    expect(resolveUcMirrorTables).toHaveBeenCalledTimes(2);
    expect(r.status).toBe('remediation');
  });

  it('post-grant, the gate does NOT tell the user to grant privileges it already holds (R7)', async () => {
    resolveUcMirrorTables.mockResolvedValue(noTables);
    const r = await run();
    expect(r.status).toBe('remediation');
    const text = `${r.gate!.reason} ${r.gate!.remediation}`;
    expect(text).toMatch(/already holds/i);
    expect(text).not.toMatch(/Console UAMI has USE CATALOG/i);
    expect(text).not.toMatch(/grant .*USE CATALOG \/ USE SCHEMA \/ SELECT/i);
  });

  it('gates HONESTLY when Databricks REFUSES the grant, quoting its refusal', async () => {
    // POPULATION FLOOR: if no path could gate, every "does not ask the user"
    // assertion above would be green over a provisioner that never gates.
    resolveUcMirrorTables.mockResolvedValue(noTables);
    selfGrantUcMirrorPrivileges.mockResolvedValue({
      granted: false,
      principal: 'uami-app-id',
      reason: 'Databricks refused the grant ... PERMISSION_DENIED: User is not an owner of Catalog main.',
    });

    const r = await run();

    expect(r.status).toBe('remediation');
    expect(r.gate!.reason).toMatch(/could not grant itself access/i);
    expect(r.gate!.remediation).toMatch(/PERMISSION_DENIED: User is not an owner of Catalog main/);
    expect(r.gate!.remediation).toMatch(/MANAGE on the catalog|catalog owner/i);
    // The retry must NOT have run — nothing changed, so re-reading proves nothing.
    expect(resolveUcMirrorTables).toHaveBeenCalledTimes(1);
  });

  it('still gates on NO_DATABRICKS without attempting a grant into thin air', async () => {
    resolveUcMirrorTables.mockResolvedValue({ ok: false, code: 'NO_DATABRICKS', error: 'x', tables: [], skipped: 0 });
    const r = await run();
    expect(r.status).toBe('remediation');
    expect(r.gate!.remediation).toMatch(/LOOM_DATABRICKS_HOSTNAME/);
    expect(selfGrantUcMirrorPrivileges).not.toHaveBeenCalled();
  });

  it('still gates when the item has no catalogName, before touching Databricks at all', async () => {
    const r = await mirroredDatabricksProvisioner({ displayName: 'x', content: {} } as never);
    expect(r.status).toBe('remediation');
    expect(resolveUcMirrorTables).not.toHaveBeenCalled();
    expect(selfGrantUcMirrorPrivileges).not.toHaveBeenCalled();
  });
});
