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
vi.mock('@/lib/azure/shortcut-engines', async () => {
  // `createTablesShortcut` delegates to the REAL implementation so the derived
  // positive control below mints its engine object through production code
  // (`synapseObject`/`synapseQualified`) instead of a hand-typed string. Only
  // its Azure egress is mocked — `@/lib/azure/synapse-sql-client`, below.
  const actual = await vi.importActual<typeof import('@/lib/azure/shortcut-engines')>(
    '@/lib/azure/shortcut-engines',
  );
  return {
    pickTablesEngine: vi.fn(() => 'synapse'),
    createTablesShortcut: vi.fn(actual.createTablesShortcut),
    dropShortcutObject: vi.fn(async () => {}),
    dropExternalBinding: vi.fn(async () => {}),
    bindExternalSource: vi.fn(async () => ({ readUri: 's3://b/p', ucExternalLocation: 'loc' })),
  };
});
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

/**
 * The positive controls above are HAND-TYPED (`…sc_abc12345`, `…sc_ok`), and a
 * hand-typed fixture models the CODE the author had in mind rather than the
 * SYSTEM. That gap shipped a real defect: the first version of this guard
 * required every dot-part to begin with `[A-Za-z_]`, while the object Loom
 * actually mints is `synapseQualified(synapseObject(`${uuid.slice(0,8)}_${name}`))`
 * — whose last part begins with a UUID's first hex character, a DIGIT 10 times
 * in 16. Measured over 10,000 mints: 6,178 of 10,000 legitimately-created
 * shortcuts were refused, so `POST action=query` returned a 400 telling the
 * user their object "is not a name Loom created" (false), and DELETE silently
 * skipped `dropShortcutObject`, orphaning the Synapse view forever.
 *
 * Every case below therefore DERIVES its object from the real mint path: it
 * drives a create through the route with the real `createTablesShortcut`, and
 * asserts against whatever that produced. Nothing here is typed by hand, so a
 * future narrowing of `ENGINE_OBJECT_RE` cannot pass by matching a fixture the
 * author also wrote.
 *
 * `crypto.randomUUID` is pinned per case so both head classes — digit-leading
 * and letter-leading — are covered DETERMINISTICALLY. Left random, this control
 * would pass ~38% of the time on the broken guard, which is a flaky test, i.e.
 * another guard that cannot be trusted to fail.
 */
describe('#3611 — the allow-set is DERIVED from the mint, not hand-typed', () => {
  /** Create a Tables shortcut through the route with `id` pinned; return the minted object. */
  async function mintViaRoute(uuid: string): Promise<{ id: string; engineObject: string }> {
    const spy = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(uuid as ReturnType<Crypto['randomUUID']>);
    try {
      const res = await POST(postReq({
        kind: 'tables', sourceType: 'internal', displayName: 'MyShortcut',
        container: 'bronze', path: 'sales',
      }));
      const body = await res.json();
      // A gate/error here means the mint never ran — fail loudly rather than
      // silently asserting on `undefined` (a control with no population).
      expect(body.shortcut?.engineObject, `create did not mint: ${JSON.stringify(body).slice(0, 300)}`)
        .toBeTruthy();
      return { id: uuid, engineObject: body.shortcut.engineObject as string };
    } finally {
      spy.mockRestore();
    }
  }

  // 10/16 of UUIDs begin with a digit — this is the majority case in production.
  const DIGIT_HEAD = '4f0278c7-1111-4222-8333-444455556666';
  const ALPHA_HEAD = 'af0278c7-1111-4222-8333-444455556666';

  it('mints an object whose last part begins with a DIGIT (the 62.5% case)', async () => {
    const { engineObject } = await mintViaRoute(DIGIT_HEAD);
    // Pin the shape so this control keeps its meaning if the mint is refactored:
    // if the object stops being digit-headed, this case is no longer the one the
    // guard used to refuse and the test says so instead of passing vacuously.
    expect(engineObject).toBe('loom_lakehouse.shortcuts.4f0278c7_MyShortcut');
  });

  it('DOES drop a digit-headed object that Loom itself minted', async () => {
    const { id, engineObject } = await mintViaRoute(DIGIT_HEAD);

    await DELETE(delReq(`workspaceId=ws1&id=${id}`));

    expect(dropShortcutObject).toHaveBeenCalledWith({ engine: 'synapse', engineObject });
  });

  it('DOES query a digit-headed object that Loom itself minted', async () => {
    const { id, engineObject } = await mintViaRoute(DIGIT_HEAD);
    (executeQuery as any).mockClear();

    const res = await POST(postReq({ action: 'query', id }));

    expect(await res.json()).not.toMatchObject({ code: 'invalid_engine_object' });
    expect(res.status).toBe(200);
    expect(executeQuery).toHaveBeenCalled();
    expect(String((executeQuery as any).mock.calls[0][1])).toContain(engineObject);
  });

  it('DOES drop a letter-headed object that Loom itself minted', async () => {
    const { id, engineObject } = await mintViaRoute(ALPHA_HEAD);

    await DELETE(delReq(`workspaceId=ws1&id=${id}`));

    expect(dropShortcutObject).toHaveBeenCalledWith({ engine: 'synapse', engineObject });
  });

  it('still refuses injection when the object is digit-headed (widening the head class widened NOTHING else)', async () => {
    // The fix that makes the four cases above pass is a single character class
    // (`[A-Za-z0-9_]` in the head position). This case proves that relaxation
    // did not become a hole: a digit-headed payload carrying a separator is
    // still refused, so the head class is the only thing that moved.
    // Two rows, because DELETE removes the row the query case needs.
    const injected = 'loom_lakehouse.shortcuts.4f0278c7_x; DROP DATABASE loom--';
    seedShortcut('scD1', { kind: 'tables', engine: 'synapse', engineObject: injected });
    seedShortcut('scD2', { kind: 'tables', engine: 'synapse', engineObject: injected });

    await DELETE(delReq('workspaceId=ws1&id=scD1'));
    const res = await POST(postReq({ action: 'query', id: 'scD2' }));

    expect(dropShortcutObject).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_engine_object' });
    expect(executeQuery).not.toHaveBeenCalled();
  });
});
