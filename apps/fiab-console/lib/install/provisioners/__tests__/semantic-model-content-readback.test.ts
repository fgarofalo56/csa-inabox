/**
 * #3549 / #3551 — the Loom-native semantic-model provisioner must not report
 * `created` for a model the editor cannot read.
 *
 * WHAT WAS WRONG. `provisionLoomNative` is validate-only: it authors no backing
 * Azure object, because on the Azure-native default the Cosmos item's
 * `state.content` IS the artifact. Its docstring asserted the tables/measures
 * "are the source of truth on the Cosmos item" — but the write that makes that
 * true happens in a different module (`app/api/apps/[id]/install/route.ts`), and
 * nothing here checked it. So the receipt could report "2 tables · 4 measures"
 * with no evidence whatsoever that the editor would ever see them. That is the
 * exact banner the operator measured live on 2026-08-18 over an editor reading
 * "no tables yet".
 *
 * Every test in the second describe FAILS against the pre-fix provisioner, which
 * returned `created` unconditionally once `tables.length > 0`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const read = vi.fn();
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({ item: vi.fn(() => ({ read })) })),
}));

// Keep the Power BI / Fabric / AAS opt-in paths out of this suite entirely —
// the default backend must need none of them (no-fabric-dependency.md).
vi.mock('@/lib/azure/fabric-client', () => ({
  FabricError: class extends Error { status = 500; },
  fabricHint: () => 'hint',
}));
vi.mock('@azure/identity', () => ({
  ChainedTokenCredential: class {},
  DefaultAzureCredential: class {},
  ManagedIdentityCredential: class {},
}));
vi.mock('@/lib/azure/aca-managed-identity', () => ({ AcaManagedIdentityCredential: class {} }));

import { semanticModelProvisioner } from '../semantic-model';

const CONTENT = {
  kind: 'semantic-model',
  tables: [
    { name: 'customer_daily_metrics', columns: [{ name: 'user_id', dataType: 'string' }] },
    { name: 'dim_product', columns: [{ name: 'product_id', dataType: 'string' }] },
  ],
  measures: [
    { table: 'customer_daily_metrics', name: 'Total Revenue', expression: 'SUM(x)' },
    { table: 'customer_daily_metrics', name: 'Active Users', expression: 'DISTINCTCOUNT(x)' },
    { table: 'customer_daily_metrics', name: 'Events', expression: 'SUM(x)' },
    { table: 'dim_product', name: 'Product Count', expression: 'DISTINCTCOUNT(x)' },
  ],
};

function input(overrides: any = {}) {
  return {
    session: { claims: { oid: 'o' } } as any,
    target: { mode: 'shared', semanticBackend: 'loom-native', warehouseServer: 'wh.sql.azuresynapse.net', warehouseDatabase: 'loom' },
    cosmosItemId: 'sm-1',
    workspaceId: 'ws-1',
    displayName: 'Real-Time Analytics Semantic Model',
    content: CONTENT,
    appId: 'app-azure-realtime-analytics',
    ...overrides,
  };
}

/** The healthy estate: the install stamped state.content and it reads back. */
function itemWithContent() {
  return { resource: { id: 'sm-1', workspaceId: 'ws-1', state: { content: CONTENT } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  read.mockResolvedValue(itemWithContent());
});

describe('semanticModelProvisioner — Loom-native default (no Fabric, no Power BI)', () => {
  it('reports created with the bundle table/measure counts when the content reads back', async () => {
    const res = await semanticModelProvisioner(input() as any);
    expect(res.status).toBe('created');
    expect(res.secondaryIds?.backend).toBe('loom-native');
    expect(res.secondaryIds?.tables).toBe('2');
    expect(res.secondaryIds?.measures).toBe('4');
    expect(res.secondaryIds?.contentReadable).toBe('true');
  });

  it('an empty model is an honest gate, not a green install', async () => {
    const res = await semanticModelProvisioner(input({ content: { kind: 'semantic-model', tables: [] } }) as any);
    expect(res.status).toBe('remediation');
    expect(res.gate?.reason).toMatch(/no tables defined/i);
    // Nothing to read back — the gate returns before the Cosmos read.
    expect(read).not.toHaveBeenCalled();
  });
});

describe('#3549/#3551 — the receipt may not claim content the item cannot serve', () => {
  it('the item exists but carries NO state.content → not created', async () => {
    read.mockResolvedValue({ resource: { id: 'sm-1', workspaceId: 'ws-1', state: {} } });

    const res = await semanticModelProvisioner(input() as any);

    expect(res.status).not.toBe('created');
    expect(res.status).not.toBe('exists');
    expect(res.secondaryIds?.contentReadable).toBe('false');
    // The receipt still says WHAT it validated and what it could not establish
    // (deploy-integrity.md R7 — never assert more than was measured).
    expect(res.secondaryIds?.tables).toBe('2');
    expect(res.steps?.some((s) => /could not be read back from the item/i.test(s))).toBe(true);
  });

  it('state.content present but stripped of its tables → not created', async () => {
    // The precise case a truthiness check would wave through.
    read.mockResolvedValue({
      resource: { id: 'sm-1', workspaceId: 'ws-1', state: { content: { kind: 'semantic-model', tables: [] } } },
    });

    const res = await semanticModelProvisioner(input() as any);

    expect(res.status).not.toBe('created');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('a Cosmos 403 on the read-back is a RETRYABLE remediation, not a code failure', async () => {
    // A real @azure/cosmos rejection puts the status on `code`, and its prose
    // need carry no infra keyword at all.
    const err: any = new Error('Request is blocked by the account policy.');
    err.code = 403;
    read.mockRejectedValue(err);

    const res = await semanticModelProvisioner(input() as any);

    expect(res.status).toBe('remediation');
    expect(res.gate?.remediation).toMatch(/idempotent/i);
    expect(res.gate?.remediation).toMatch(/Cosmos DB Built-in Data Contributor/);
    // And it must not blame Fabric / Power BI for an Azure-native defect.
    expect(res.gate?.remediation).toMatch(/No Microsoft Fabric or Power BI workspace is involved/i);
  });

  it('a TRANSIENT read failure is recovered by the retry → created', async () => {
    read
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValue(itemWithContent());

    const res = await semanticModelProvisioner(input() as any);

    expect(res.status).toBe('created');
    expect(read).toHaveBeenCalledTimes(2);
    expect(res.secondaryIds?.contentReadable).toBe('true');
  });

  it('the read-back never resolving a document → not created', async () => {
    read.mockResolvedValue({ resource: undefined });

    const res = await semanticModelProvisioner(input() as any);

    expect(res.status).not.toBe('created');
    expect(res.steps?.some((s) => /returned no document/i.test(s))).toBe(true);
  });
});
