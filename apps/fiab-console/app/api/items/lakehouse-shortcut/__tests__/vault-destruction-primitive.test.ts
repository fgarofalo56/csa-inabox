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
    // The name-space POLICY is the thing under test, so it comes from the real
    // module — mocking it would make every assertion below a test of the mock.
    isMintedEngineObject: actual.isMintedEngineObject,
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

/** Seed a row of a DIFFERENT item type carrying the same state shape. */
function seedOtherType(id: string, itemType: string, state: Record<string, unknown>) {
  store.set(id, { id, workspaceId: 'ws1', itemType, displayName: 'agent', state });
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

/**
 * #3611 (review round 2) — SEPARATOR-FREE objects OUTSIDE the minted name-space.
 *
 * The first revision of this guard tested only "is this a well-formed 1–3 part
 * identifier". Every payload below is a perfectly well-formed identifier with no
 * separator to escape, so all of them PASSED it — while `dropShortcutObject`
 * reads its target DATABASE out of `parts[0]` and both sinks run as the Console
 * UAMI, a Synapse SQL admin. Escaping was never the whole problem; WHICH OBJECT
 * is, and only a name-space check answers that.
 *
 * These are the cases that separate a name-space check from an identifier
 * check. An identifier-shaped guard is GREEN on every one of them.
 */
describe('#3611 — engineObject must be inside the name-space Loom registers into', () => {
  const OUTSIDE = [
    // A system catalog view on the built-in database: SELECT here enumerates
    // every SQL login the endpoint can see.
    ['master.sys.sql_logins', 'a system catalog on the built-in database'],
    // Someone else's database entirely — `parts[0]` picks the target DB.
    ['finance_db.dbo.payroll', "another database's table"],
    // The RIGHT database, the WRONG schema: this is the case a check anchored
    // only on the database prefix would still admit.
    ['loom_lakehouse.dbo.someone_elses_view', 'the minted DB but a foreign schema'],
    // The right database AND a schema that merely CONTAINS the minted one.
    ['loom_lakehouse.shortcuts_evil.v', 'a schema that only looks like `shortcuts`'],
    // A 2-part legacy-shaped name in a foreign schema.
    ['dbo.audit', 'a foreign 2-part object'],
  ] as const;

  for (const [obj, why] of OUTSIDE) {
    it(`does NOT drop ${why} (${obj})`, async () => {
      seedShortcut('n1', { kind: 'tables', engine: 'synapse', engineObject: obj });

      await DELETE(delReq('workspaceId=ws1&id=n1'));

      expect(dropShortcutObject).not.toHaveBeenCalled();
    });

    it(`does NOT query ${why} (${obj})`, async () => {
      seedShortcut('n2', { kind: 'tables', engine: 'synapse', engineObject: obj });

      const res = await POST(postReq({ action: 'query', id: 'n2' }));

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid_engine_object' });
      expect(executeQuery).not.toHaveBeenCalled();
    });
  }

  it('DOES accept the Databricks minted name-space (loom.<schema>.<table>)', async () => {
    // Positive control for the OTHER engine: without it, a guard that simply
    // refused everything non-Synapse would pass every case above.
    seedShortcut('n3', { kind: 'tables', engine: 'databricks', engineObject: 'loom.sc_abc12345.mytable' });

    await DELETE(delReq('workspaceId=ws1&id=n3'));

    expect(dropShortcutObject).toHaveBeenCalledWith({
      engine: 'databricks', engineObject: 'loom.sc_abc12345.mytable',
    });
  });

  it('does NOT accept a foreign Databricks catalog (unity.finance.payroll)', async () => {
    seedShortcut('n4', { kind: 'tables', engine: 'databricks', engineObject: 'unity.finance.payroll' });

    await DELETE(delReq('workspaceId=ws1&id=n4'));

    expect(dropShortcutObject).not.toHaveBeenCalled();
  });

  it('does NOT let a Databricks-shaped name reach the SYNAPSE arm', async () => {
    // Cross-engine: `loom.x.y` is minted-looking, but not by the engine named on
    // the row. Passing the engine makes the check strictly tighter, and this is
    // the case that proves the engine argument is actually consulted.
    seedShortcut('n5', { kind: 'tables', engine: 'synapse', engineObject: 'loom.dbo.payroll' });

    await DELETE(delReq('workspaceId=ws1&id=n5'));

    expect(dropShortcutObject).not.toHaveBeenCalled();
  });

  it('honours LOOM_SERVERLESS_DB — the name-space follows the deployment, not a literal', async () => {
    // The minted database is `process.env.LOOM_SERVERLESS_DB || 'loom_lakehouse'`.
    // A guard that hard-codes `loom_lakehouse` would refuse every real object in
    // a deployment that overrides it — the same class of defect as the head-class
    // bug this file already records, so it gets its own control.
    process.env.LOOM_SERVERLESS_DB = 'custom_lh';
    try {
      seedShortcut('n6', { kind: 'tables', engine: 'synapse', engineObject: 'custom_lh.shortcuts.sc_x' });
      seedShortcut('n7', { kind: 'tables', engine: 'synapse', engineObject: 'loom_lakehouse.shortcuts.sc_x' });

      await DELETE(delReq('workspaceId=ws1&id=n6'));
      expect(dropShortcutObject).toHaveBeenCalledWith({
        engine: 'synapse', engineObject: 'custom_lh.shortcuts.sc_x',
      });

      // ...and the DEFAULT name is no longer in the name-space once overridden.
      (dropShortcutObject as any).mockClear();
      await DELETE(delReq('workspaceId=ws1&id=n7'));
      expect(dropShortcutObject).not.toHaveBeenCalled();
    } finally {
      delete process.env.LOOM_SERVERLESS_DB;
    }
  });
});

/**
 * #3611 (review round 2) — the DELETE row read had NO itemType check.
 *
 * `authorizeItemWorkspace` takes an `itemType` argument but does not consult it
 * when `workspaceId` is supplied: it authorizes the WORKSPACE. The `action=query`
 * path re-checked `row.itemType` after its point read; DELETE did not. So an id
 * belonging to an item of a DIFFERENT type, in a workspace the caller may write,
 * was read here and its `state` fed to the vault-delete and DROP sinks — and
 * `createOwnedItem` passes `state` through wholesale, so that state bag is
 * caller-authored on item types that use it.
 *
 * `data-agent` is the concrete instance: `app/api/items/data-agent/route.ts`
 * passes `body.state` straight into `createOwnedItem`.
 */
describe('#3611 — DELETE only ever acts on a lakehouse-shortcut row', () => {
  it('refuses an id belonging to another item type, and touches NOTHING', async () => {
    seedOtherType('ag1', 'data-agent', {
      engine: 'synapse', engineObject: 'finance_db.dbo.revenue_view',
      secretRef: 'loom-shortcut-anything',
    });

    const res = await DELETE(delReq('workspaceId=ws1&id=ag1'));

    expect(res.status).toBe(404);
    expect(dropShortcutObject).not.toHaveBeenCalled();
    expect(deleteShortcutSecret).not.toHaveBeenCalled();
    // ...and the foreign row is NOT deleted through this route either. A type
    // check that deleted the row anyway would have swapped one defect (a DROP)
    // for another (cross-type deletion).
    expect(store.has('ag1')).toBe(true);
  });

  it('refuses even when the state would have passed BOTH name-space guards', async () => {
    // The engineObject and secretRef here are inside the minted name-spaces, so
    // neither value-level guard fires. Only the TYPE check can refuse this, which
    // is what makes it a distinct control rather than a duplicate of the two above.
    seedOtherType('ag2', 'data-agent', {
      engine: 'synapse', engineObject: 'loom_lakehouse.shortcuts.4f0278c7_x',
      secretRef: 'loom-shortcut-4f0278c7',
    });

    const res = await DELETE(delReq('workspaceId=ws1&id=ag2'));

    expect(res.status).toBe(404);
    expect(dropShortcutObject).not.toHaveBeenCalled();
    expect(deleteShortcutSecret).not.toHaveBeenCalled();
    expect(store.has('ag2')).toBe(true);
  });

  it('still deletes a real shortcut (the type check has a non-empty allow-set)', async () => {
    seedShortcut('ok1', { sourceType: 's3', secretRef: 'loom-shortcut-ok1' });

    const res = await DELETE(delReq('workspaceId=ws1&id=ok1'));

    expect(res.status).toBe(200);
    expect(store.has('ok1')).toBe(false);
    expect(deleteShortcutSecret).toHaveBeenCalledWith('loom-shortcut-ok1');
  });

  it('stays idempotent for an id that does not exist at all', async () => {
    const res = await DELETE(delReq('workspaceId=ws1&id=nope'));

    expect(res.status).toBe(200);
  });
});

/**
 * #3611 (review round 2) — the secret guard must be an ALLOW-list.
 *
 * The five original cases (`loom-msal-client-secret`, `loom-conn-…`,
 * `session-secret` refused; `loom-shortcut-…`, `loom-sc-…` allowed) are all
 * satisfied by a three-pattern DENY-list, so they cannot tell an allow-list from
 * its inversion. The two names below are refused ONLY by an allow-list: neither
 * is a platform-reserved name and neither matches any plausible deny pattern,
 * yet both belong to OTHER features' minted name-spaces.
 */
describe('#3611 — the secret guard is an allow-list, not a deny-list', () => {
  const FOREIGN_MINTED = [
    // `loom-app-git-<id8>` — the Loom App git credential name-space, named in
    // this PR's own threat table (kv-secret-purpose.ts MINTED_NAMESPACES).
    'loom-app-git-abc12345',
    // A plausible future/adjacent Loom name that no deny pattern covers.
    'loom-dbx-pat',
    // Another feature's minted space, exact prefix from MINTED_NAMESPACES.
    'loom-git-ws1-pat',
  ];

  for (const name of FOREIGN_MINTED) {
    it(`refuses "${name}" — outside loom-sc-/loom-shortcut-, so a deny-list would MISS it`, async () => {
      seedShortcut('s1', { sourceType: 's3', secretRef: name });

      await DELETE(delReq('workspaceId=ws1&id=s1'));

      expect(deleteShortcutSecret).not.toHaveBeenCalled();
    });
  }

  it('refuses a name that merely CONTAINS the minted prefix rather than starting with it', async () => {
    seedShortcut('s2', { sourceType: 's3', secretRef: 'evil-loom-shortcut-x' });

    await DELETE(delReq('workspaceId=ws1&id=s2'));

    expect(deleteShortcutSecret).not.toHaveBeenCalled();
  });
});
