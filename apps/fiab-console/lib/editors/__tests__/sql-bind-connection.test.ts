/**
 * #2723 — the editor-side half of the authority binding. The /query route
 * derives its target from the item's bound connection, so the editor MUST
 * persist the current selection before running; these specs pin that contract
 * (and the "don't re-bind" cache) without a network.
 */
import { describe, it, expect, vi } from 'vitest';
import { bindItemConnection, connectionKey } from '../sql-bind-connection';

const SEL = { id: 'item1', family: 'azure-sql', server: 'srv', database: 'db' };

describe('connectionKey', () => {
  it('is stable per selection and distinguishes every field', () => {
    expect(connectionKey('azure-sql', 'srv', 'db')).toBe('azure-sql|srv|db');
    expect(connectionKey('azure-sql', 'srv', 'db')).not.toBe(connectionKey('azure-sql', 'other', 'db'));
    expect(connectionKey('azure-sql', 'srv', 'db')).not.toBe(connectionKey('azure-sql', 'srv', 'other'));
  });
});

describe('bindItemConnection', () => {
  it('POSTs the selection to /connect and returns the key to cache', async () => {
    const postJson = vi.fn(async () => ({ ok: true }));
    const r = await bindItemConnection({ ...SEL, cachedKey: '', postJson });
    expect(r).toEqual({ ok: true, key: 'azure-sql|srv|db' });
    expect(postJson).toHaveBeenCalledTimes(1);
    const [url, init] = postJson.mock.calls[0] as any[];
    expect(url).toBe('/api/items/azure-sql-database/item1/connect');
    expect(JSON.parse(init.body)).toEqual({ family: 'azure-sql', server: 'srv', database: 'db' });
  });

  it('skips the round-trip when the item is already bound to this selection', async () => {
    const postJson = vi.fn(async () => ({ ok: true }));
    const r = await bindItemConnection({ ...SEL, cachedKey: 'azure-sql|srv|db', postJson });
    expect(r).toEqual({ ok: true, key: 'azure-sql|srv|db' });
    expect(postJson).not.toHaveBeenCalled();
  });

  it('re-binds when the selection CHANGES (a stale cache must not pin the old target)', async () => {
    const postJson = vi.fn(async () => ({ ok: true }));
    const r = await bindItemConnection({ ...SEL, server: 'srv2', cachedKey: 'azure-sql|srv|db', postJson });
    expect(r).toEqual({ ok: true, key: 'azure-sql|srv2|db' });
    expect(postJson).toHaveBeenCalledTimes(1);
  });

  it('FAILS CLOSED when the bind is refused — the caller must not execute', async () => {
    const postJson = vi.fn(async () => ({ ok: false, error: 'item not found or not owned by your tenant' }));
    const r = await bindItemConnection({ ...SEL, cachedKey: '', postJson });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/not owned/);
  });

  it('FAILS CLOSED when the bind request throws (offline / 500)', async () => {
    const postJson = vi.fn(async () => { throw new Error('network down'); });
    const r = await bindItemConnection({ ...SEL, cachedKey: '', postJson });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/could not bind/);
  });

  it('refuses an unsaved item (id=new) without calling the route', async () => {
    const postJson = vi.fn(async () => ({ ok: true }));
    const r = await bindItemConnection({ ...SEL, id: 'new', cachedKey: '', postJson });
    expect(r.ok).toBe(false);
    expect(postJson).not.toHaveBeenCalled();
  });
});
