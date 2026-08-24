/**
 * #3611 — a user-writable item field reached a Key Vault deletion.
 *
 * The generic item PATCH replaced `state` WHOLESALE from the request body with
 * no field validation, and `items/lakehouse-shortcut` DELETE then fed
 * `state.secretRef` to `deleteShortcutSecret()`. Because LOOM_SHORTCUT_KEYVAULT
 * points at the admin-plane vault in every shipped deployment, that let any
 * authenticated user with a shortcut in their OWN workspace soft-delete
 * `loom-msal-client-secret` — the 2026-07-19 sign-in outage, on demand.
 *
 * These tests pin the WRITE-side half. They are written so that the NARROW
 * versions of the fix — the ones that pass a naive test — fail here:
 *
 *   • top-level-only scan            → caught by the NESTED gitAuth.secretName case
 *   • scoped to itemType lakehouse-shortcut → caught by the loom-app-runtime case
 *   • reject-on-presence (too broad) → caught by the unchanged-round-trip case
 *   • key-order/array-order sensitivity → caught by the reorder case
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/items/record-open', () => ({ recordItemOpen: vi.fn(async () => {}) }));

const store = new Map<string, any>();
let lastReplaced: any = null;

vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: vi.fn(async () => ({ items: { create: vi.fn(async () => ({})) } })),
  workspacesContainer: vi.fn(async () => ({
    // A point read in the caller's partition, mirroring Cosmos: the workspace
    // resolves and its tenantId equals the partition key it was read under.
    item: (id: string, pk: string) => ({ read: async () => ({ resource: { id, tenantId: pk } }) }),
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  })),
  itemsContainer: vi.fn(async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const p = (spec?.parameters || []) as Array<{ name: string; value: string }>;
          const id = p.find((x) => x.name === '@id')?.value;
          const t = p.find((x) => x.name === '@t')?.value;
          const hit = [...store.values()].filter((d) => d.id === id && (t === undefined || d.itemType === t));
          return { resources: hit };
        },
      }),
    },
    item: (id: string) => ({
      read: async () => ({ resource: store.get(id) }),
      replace: async (doc: any) => { lastReplaced = doc; store.set(doc.id, doc); return { resource: doc }; },
      delete: async () => { store.delete(id); return {}; },
    }),
  })),
}));

import { PATCH } from '../route';
import { getSession } from '@/lib/auth/session';

const OID = 'caller-oid';
const sess = { claims: { oid: OID, upn: 'u@x', email: 'u@x' } };

/** The exact secret whose deletion took production down on 2026-07-19. */
const PLATFORM_SECRET = 'loom-msal-client-secret';

function seed(id: string, itemType: string, state: Record<string, unknown>) {
  store.set(id, { id, itemType, workspaceId: 'ws1', displayName: 'x', state, createdAt: 'a', updatedAt: 'a' });
}

function patch(type: string, id: string, body: any) {
  const req = { json: async () => body } as any;
  return PATCH(req, { params: Promise.resolve({ type, id }) });
}

beforeEach(() => {
  store.clear();
  lastReplaced = null;
  vi.clearAllMocks();
  (getSession as any).mockReturnValue(sess);
});

describe('#3611 — the generic PATCH may not write server-owned state', () => {
  it('refuses to repoint state.secretRef at a platform Key Vault secret', async () => {
    seed('sc1', 'lakehouse-shortcut', { sourceType: 's3', secretRef: 'loom-shortcut-sc1' });

    const res = await patch('lakehouse-shortcut', 'sc1', {
      state: { sourceType: 's3', secretRef: PLATFORM_SECRET },
    });

    expect(res.status).toBe(400);
    // The write must not have happened at all — a refusal that still persists
    // the row would leave the vault primitive armed.
    expect(lastReplaced).toBeNull();
    expect(store.get('sc1').state.secretRef).toBe('loom-shortcut-sc1');
  });

  it('refuses to INTRODUCE a secretRef where the item had none', async () => {
    // The cheapest real attack: create an `internal` shortcut (no credential,
    // no Key Vault involvement at all), then graft a secretRef onto it.
    seed('sc2', 'lakehouse-shortcut', { sourceType: 'internal', container: 'bronze' });

    const res = await patch('lakehouse-shortcut', 'sc2', {
      state: { sourceType: 'internal', container: 'bronze', secretRef: PLATFORM_SECRET },
    });

    expect(res.status).toBe(400);
    expect(store.get('sc2').state.secretRef).toBeUndefined();
  });

  it('refuses a NESTED server-owned key — a top-level-only scan is not enough', async () => {
    // `state.appRuntime.gitAuth.secretName` reaches deleteKeyVaultSecret() from
    // items/loom-app-runtime/[id]/git-credential DELETE. A guard that only
    // inspected the first level of `state` would pass the two cases above and
    // still leave this one wide open.
    seed('app1', 'loom-app-runtime', { appRuntime: { templateId: 't', gitAuth: { secretName: 'loom-app-git-abc12345' } } });

    const res = await patch('loom-app-runtime', 'app1', {
      state: { appRuntime: { templateId: 't', gitAuth: { secretName: PLATFORM_SECRET } } },
    });

    expect(res.status).toBe(400);
    expect(store.get('app1').state.appRuntime.gitAuth.secretName).toBe('loom-app-git-abc12345');
  });

  it('refuses on an item type that is NOT lakehouse-shortcut', async () => {
    // Pins that the guard is keyed by KEY NAME across every item type. A fix
    // scoped to the reported item type would pass every other test in this file.
    seed('app2', 'loom-app-runtime', { appRuntime: { env: [{ name: 'A', value: '1' }] } });

    const res = await patch('loom-app-runtime', 'app2', {
      state: { appRuntime: { env: [{ name: 'A', secretRef: PLATFORM_SECRET }] } },
    });

    expect(res.status).toBe(400);
  });

  it('refuses to forge recycle-bin metadata', async () => {
    seed('i1', 'notebook', { code: 'print(1)' });

    const res = await patch('notebook', 'i1', {
      state: { code: 'print(1)', _recycled: { deletedAt: 'now', deletedBy: 'someone-else', purgeAfter: 'later' } },
    });

    expect(res.status).toBe(400);
  });

  it('refuses a prototype-polluting key', async () => {
    seed('i2', 'notebook', { code: 'x' });
    // JSON.parse gives __proto__ as an OWN enumerable property, so it survives
    // into the Cosmos doc and poisons the later `{ ...item, state }` spread.
    const body = JSON.parse('{"state":{"code":"x","__proto__":{"polluted":true}}}');

    const res = await patch('notebook', 'i2', body);

    expect(res.status).toBe(400);
    expect(({} as any).polluted).toBeUndefined();
  });

  // ── The other side of the guard: it must not break ordinary saves ─────────

  it('ALLOWS a round-trip that carries the same server-owned values through', async () => {
    // This is what every real editor does — GET the item, change one field,
    // PATCH the whole state back. If the guard rejected on PRESENCE rather than
    // on CHANGE, this would 400 and the fix would be unshippable.
    seed('sc3', 'lakehouse-shortcut', { sourceType: 's3', secretRef: 'loom-shortcut-sc3', path: 'old' });

    const res = await patch('lakehouse-shortcut', 'sc3', {
      state: { sourceType: 's3', secretRef: 'loom-shortcut-sc3', path: 'new' },
    });

    expect(res.status).toBe(200);
    expect(store.get('sc3').state.path).toBe('new');
    expect(store.get('sc3').state.secretRef).toBe('loom-shortcut-sc3');
  });

  it('ALLOWS reordering an array that carries server-owned values', async () => {
    // Pins that the comparison is by VALUE SET, not by path/position — a
    // path-keyed guard would see `env[0].secretRef` change and wrongly 400.
    seed('app3', 'loom-app-runtime', {
      appRuntime: { env: [{ name: 'A', secretRef: 'loom-conn-a' }, { name: 'B', secretRef: 'loom-conn-b' }] },
    });

    const res = await patch('loom-app-runtime', 'app3', {
      state: { appRuntime: { env: [{ name: 'B', secretRef: 'loom-conn-b' }, { name: 'A', secretRef: 'loom-conn-a' }] } },
    });

    expect(res.status).toBe(200);
  });

  it('ALLOWS omitting a server-owned key (fail-safe: orphans, never deletes)', async () => {
    seed('sc4', 'lakehouse-shortcut', { sourceType: 's3', secretRef: 'loom-shortcut-sc4' });

    const res = await patch('lakehouse-shortcut', 'sc4', { state: { sourceType: 's3' } });

    expect(res.status).toBe(200);
  });

  it('ALLOWS an ordinary rename with no state at all', async () => {
    seed('i3', 'notebook', { code: 'x' });

    const res = await patch('notebook', 'i3', { displayName: 'Renamed' });

    expect(res.status).toBe(200);
    expect(store.get('i3').displayName).toBe('Renamed');
  });
});

/**
 * #3611 (review round 2) — EVERY key in the deny-list, not just the reported one.
 *
 * The list has six entries. The cases above exercise three of them (`secretRef`,
 * `secretName`, `_recycled`) plus `__proto__`. The population for the other
 * three was ZERO, so deleting `'engineObject'`, `'patSecretRef'` or
 * `'keyVaultSecret'` from `SERVER_OWNED_STATE_KEYS` left the whole suite green —
 * a narrowly-scoped removal that no test could see. One case per key, keyed by
 * the key name, closes that: the population is now 6 of 6.
 *
 * Each asserts the write DID NOT HAPPEN (`lastReplaced` null / the stored value
 * unchanged), not merely that the status was 400 — a guard that 400s after
 * persisting would still leave the sink armed.
 */
describe('#3611 — every server-owned key is enforced, not only the reported one', () => {
  const CASES: Array<{ key: string; itemType: string; current: any; attacker: any; read: (s: any) => unknown }> = [
    {
      // Reaches `DROP VIEW ${obj}` / `SELECT TOP n * FROM ${obj}` as the Console
      // UAMI. Deleting this key from the list restored the original #3611 write
      // path exactly, and nothing failed.
      key: 'engineObject',
      itemType: 'lakehouse-shortcut',
      current: { kind: 'tables', engine: 'synapse', engineObject: 'loom_lakehouse.shortcuts.sc_a' },
      attacker: { kind: 'tables', engine: 'synapse', engineObject: 'finance_db.dbo.payroll' },
      read: (s) => s.engineObject,
    },
    {
      // A git PAT secret name. NOTE, stated rather than implied: the item-state
      // deny-list covers `patSecretRef` HELD IN ITEM STATE. It does NOT cover
      // `app/api/workspaces/[id]/scm/route.ts`, which reads `patSecretRef` from
      // the WORKSPACES container — a different document that never passes
      // through this guard. This case pins the half that is covered.
      key: 'patSecretRef',
      itemType: 'loom-app-runtime',
      current: { appRuntime: { git: { patSecretRef: 'loom-git-ws1-pat' } } },
      attacker: { appRuntime: { git: { patSecretRef: PLATFORM_SECRET } } },
      read: (s) => s.appRuntime.git.patSecretRef,
    },
    {
      // `ShortcutCredentialRef.keyVaultSecret` — what `bindExternalSource`
      // resolves to mint a UC storage credential / Synapse scoped credential.
      key: 'keyVaultSecret',
      itemType: 'lakehouse-shortcut',
      current: { credentialRef: { kind: 'awsKeys', keyVaultSecret: 'loom-sc-abc' } },
      attacker: { credentialRef: { kind: 'awsKeys', keyVaultSecret: PLATFORM_SECRET } },
      read: (s) => s.credentialRef.keyVaultSecret,
    },
  ];

  for (const c of CASES) {
    it(`refuses to CHANGE state.${c.key}`, async () => {
      seed(`k-${c.key}`, c.itemType, c.current);

      const res = await patch(c.itemType, `k-${c.key}`, { state: c.attacker });

      expect(res.status).toBe(400);
      expect(lastReplaced).toBeNull();
      expect(c.read(store.get(`k-${c.key}`).state)).toEqual(c.read(c.current));
    });

    it(`refuses to INTRODUCE state.${c.key} where the item had none`, async () => {
      // The cheaper attack: an item that never carried the key at all. A guard
      // comparing only "did the existing value change" would pass this.
      seed(`n-${c.key}`, c.itemType, { unrelated: true });

      const res = await patch(c.itemType, `n-${c.key}`, { state: c.attacker });

      expect(res.status).toBe(400);
      expect(lastReplaced).toBeNull();
    });

    it(`ALLOWS an unchanged round-trip of state.${c.key}`, async () => {
      // The matching positive control, per key. Without it, "refuse everything
      // named ${c.key}" would satisfy both cases above and break every editor
      // that saves the item back.
      seed(`r-${c.key}`, c.itemType, c.current);

      const res = await patch(c.itemType, `r-${c.key}`, {
        state: JSON.parse(JSON.stringify(c.current)),
      });

      expect(res.status).toBe(200);
    });
  }
});
