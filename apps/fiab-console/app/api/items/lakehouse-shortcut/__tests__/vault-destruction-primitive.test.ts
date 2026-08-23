/**
 * #3611 — the VAULT DESTRUCTION PRIMITIVE at the sink.
 *
 * `items/lakehouse-shortcut` DELETE fed `state.secretRef` straight to
 * `deleteShortcutSecret()` and `state.engineObject` straight into
 * `DROP VIEW ${obj};`. Both values are item state, and item state is writable
 * by the caller. `admin-plane/main.bicep` points LOOM_SHORTCUT_KEYVAULT at the
 * admin-plane vault (no params file overrides it), so that name-space holds the
 * platform's own credentials.
 *
 * This file pins the SINK, which is the control that holds no matter HOW the
 * state got written — including via `createOwnedItem` (deliberately unguarded,
 * so the `.loomapp` import can carry nested env[].secretRef) or any route added
 * later. It follows the precedent this codebase already set for the identical
 * class in `lib/azure/loom-apps-runtime-templates.ts`.
 *
 * The tests are built so a NARROW fix fails:
 *   • an UNANCHORED engineObject regex → caught by the payload that EMBEDS a
 *     legal 3-part name (`db.schema.obj; DROP DATABASE loom--`)
 *   • "just never delete / never drop" → caught by the two POSITIVE cases,
 *     which assert the legitimate path still fires. A guard whose allow-set is
 *     empty is green and useless.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/workspace-guard', () => ({
  authorizeItemWorkspace: vi.fn(async () => null),
  authorizeWorkspace: vi.fn(async () => null),
}));

const store = new Map<string, any>();
vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: vi.fn(async () => ({
    item: (id: string, pk: string) => ({ read: async () => ({ resource: { id, tenantId: pk } }) }),
  })),
  itemsContainer: vi.fn(async () => ({
    items: {
      create: vi.fn(async (doc: any) => { store.set(doc.id, doc); return { resource: doc }; }),
      query: () => ({ fetchAll: async () => ({ resources: [...store.values()] }) }),
    },
    item: (id: string) => ({
      read: async () => ({ resource: store.get(id) }),
      delete: async () => { store.delete(id); return {}; },
    }),
  })),
}));
vi.mock('@/lib/azure/adls-client', () => ({
  getAccountName: vi.fn(() => 'loomlake'),
  hasConfiguredContainers: vi.fn(() => true),
}));
vi.mock('@/lib/azure/shortcut-client', () => {
  class ShortcutSourceError extends Error { code?: string; status?: number; }
  return {
    ShortcutSourceError,
    browseAdls: vi.fn(async () => ({ entries: [] })),
    listS3Objects: vi.fn(async () => ({ entries: [] })),
    listGcsObjects: vi.fn(async () => ({ entries: [] })),
    listAdlsWithSas: vi.fn(async () => ({ entries: [] })),
    listDataverseEntities: vi.fn(async () => ({ entries: [] })),
  };
});
vi.mock('@/lib/azure/kv-secrets-client', () => ({
  putShortcutSecret: vi.fn(async (name: string) => ({ name })),
  deleteShortcutSecret: vi.fn(async () => {}),
  shortcutKeyVaultConfigGate: vi.fn(() => null),
}));
vi.mock('@/lib/azure/shortcut-engines', () => ({
  pickTablesEngine: vi.fn(() => 'synapse'),
  createTablesShortcut: vi.fn(async () => ({ engine: 'synapse', engineObject: 'loom_lakehouse.shortcuts.sc_x' })),
  dropShortcutObject: vi.fn(async () => {}),
  dropExternalBinding: vi.fn(async () => {}),
  bindExternalSource: vi.fn(async () => ({ readUri: 's3://b/p', ucExternalLocation: 'loc' })),
}));
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  serverlessTarget: vi.fn((db: string) => ({ db })),
  executeQuery: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0 })),
}));

// NOTE: `@/lib/azure/kv-secret-purpose` is deliberately NOT mocked — the real
// name-space policy is the thing under test.
import { DELETE, POST } from '../route';
import { getSession } from '@/lib/auth/session';
import { deleteShortcutSecret } from '@/lib/azure/kv-secrets-client';
import { dropShortcutObject } from '@/lib/azure/shortcut-engines';
import { executeQuery } from '@/lib/azure/synapse-sql-client';

const sess = { claims: { oid: 'ws1', upn: 'u@x', email: 'u@x' } };
const delReq = (qs: string) => ({ nextUrl: { searchParams: new URLSearchParams(qs) } } as any);
const postReq = (body: any) => ({
  nextUrl: { searchParams: new URLSearchParams('workspaceId=ws1') },
  json: async () => body,
} as any);

function seedShortcut(id: string, state: Record<string, unknown>) {
  store.set(id, { id, workspaceId: 'ws1', itemType: 'lakehouse-shortcut', displayName: 'sc', state });
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  (getSession as any).mockReturnValue(sess);
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-ws';
});

describe('#3611 — DELETE may only destroy secrets this surface minted', () => {
  it('does NOT delete the platform MSAL secret', async () => {
    seedShortcut('sc1', { sourceType: 's3', secretRef: 'loom-msal-client-secret' });

    const res = await DELETE(delReq('workspaceId=ws1&id=sc1'));

    expect(res.status).toBe(200);
    expect(deleteShortcutSecret).not.toHaveBeenCalled();
    // The pointer is still removed — refusing the vault delete must not strand
    // the user's own item.
    expect(store.has('sc1')).toBe(false);
  });

  it("does NOT delete ANOTHER feature's minted secret", async () => {
    // `loom-conn-…` is the connection-secret name-space. Reaching it from here
    // would destroy an unrelated user's stored data-source credential.
    seedShortcut('sc2', { sourceType: 's3', secretRef: 'loom-conn-11111111-2222-3333-4444-555555555555' });

    await DELETE(delReq('workspaceId=ws1&id=sc2'));

    expect(deleteShortcutSecret).not.toHaveBeenCalled();
  });

  it('does NOT delete the session-signing secret', async () => {
    // Not `loom-`-prefixed at all, so a prefix-only check would miss it; it is
    // reserved by exact name in kv-secret-purpose.
    seedShortcut('sc3', { sourceType: 's3', secretRef: 'session-secret' });

    await DELETE(delReq('workspaceId=ws1&id=sc3'));

    expect(deleteShortcutSecret).not.toHaveBeenCalled();
  });

  it('DOES delete a secret this surface minted (the guard has a non-empty allow-set)', async () => {
    seedShortcut('sc4', { sourceType: 's3', secretRef: 'loom-shortcut-sc4' });

    await DELETE(delReq('workspaceId=ws1&id=sc4'));

    expect(deleteShortcutSecret).toHaveBeenCalledWith('loom-shortcut-sc4');
  });

  it('DOES delete the other minted shortcut name-space (loom-sc-)', async () => {
    seedShortcut('sc5', { sourceType: 'gcs', secretRef: 'loom-sc-abc' });

    await DELETE(delReq('workspaceId=ws1&id=sc5'));

    expect(deleteShortcutSecret).toHaveBeenCalledWith('loom-sc-abc');
  });
});

describe('#3611 — engineObject may not carry SQL into DROP', () => {
  it('does NOT drop an engineObject that EMBEDS a legal name plus injected SQL', async () => {
    // The payload contains `db.schema.obj`, which a NON-ANCHORED identifier
    // regex would happily match — that is the realistic weak version of this
    // fix, so it is the case that has to be red for it.
    seedShortcut('sc6', {
      kind: 'tables', engine: 'synapse',
      engineObject: 'db.schema.obj; DROP DATABASE loom--',
    });

    await DELETE(delReq('workspaceId=ws1&id=sc6'));

    expect(dropShortcutObject).not.toHaveBeenCalled();
  });

  it('does NOT drop an engineObject carrying a quoted-identifier escape', async () => {
    seedShortcut('sc7', {
      kind: 'tables', engine: 'synapse',
      engineObject: 'a.b.[c]; TRUNCATE TABLE dbo.audit',
    });

    await DELETE(delReq('workspaceId=ws1&id=sc7'));

    expect(dropShortcutObject).not.toHaveBeenCalled();
  });

  it('DOES drop the shape Loom mints (the guard has a non-empty allow-set)', async () => {
    seedShortcut('sc8', { kind: 'tables', engine: 'synapse', engineObject: 'loom_lakehouse.shortcuts.sc_abc12345' });

    await DELETE(delReq('workspaceId=ws1&id=sc8'));

    expect(dropShortcutObject).toHaveBeenCalledWith({
      engine: 'synapse', engineObject: 'loom_lakehouse.shortcuts.sc_abc12345',
    });
  });

  it('refuses to QUERY an injected engineObject, and never reaches the engine', async () => {
    // The read side of the same primitive: `SELECT TOP n * FROM ${obj}` runs as
    // the Console UAMI, a Synapse SQL admin — so this was an arbitrary-read
    // surface over every table the endpoint can see, not just a broken drop.
    seedShortcut('sc9', {
      kind: 'tables', engine: 'synapse',
      engineObject: 'db.schema.obj UNION ALL SELECT name, 1 FROM sys.databases--',
    });

    const res = await POST(postReq({ action: 'query', id: 'sc9' }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_engine_object' });
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('DOES query a well-formed engine object', async () => {
    seedShortcut('sc10', { kind: 'tables', engine: 'synapse', engineObject: 'loom_lakehouse.shortcuts.sc_ok' });

    const res = await POST(postReq({ action: 'query', id: 'sc10' }));

    expect(res.status).toBe(200);
    expect(executeQuery).toHaveBeenCalled();
  });
});
