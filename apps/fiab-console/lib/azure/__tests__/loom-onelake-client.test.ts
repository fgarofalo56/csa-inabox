import { describe, it, expect } from 'vitest';
import {
  parseLoomUri,
  buildLoomUri,
  safeRelPath,
  onelakeConfigGate,
  isOneLakeServiceConfigured,
} from '../loom-onelake-client';

describe('loom-onelake-client pure helpers', () => {
  it('parses a canonical 4-segment loom uri', () => {
    const p = parseLoomUri('loom://acme/sales-ws/orders/Tables/fact');
    expect(p).not.toBeNull();
    expect(p!.tenant).toBe('acme');
    expect(p!.workspace).toBe('sales-ws');
    expect(p!.item).toBe('orders');
    expect(p!.itemType).toBeNull();
    expect(p!.path).toBe('Tables/fact');
  });

  it('splits an item.type suffix', () => {
    const p = parseLoomUri('loom://acme/ws/sales.lakehouse/Tables/x');
    expect(p!.item).toBe('sales');
    expect(p!.itemType).toBe('lakehouse');
  });

  it('resolves an item root with no path', () => {
    const p = parseLoomUri('loom://acme/ws/orders');
    expect(p!.path).toBe('');
  });

  it('strips path-traversal segments', () => {
    const p = parseLoomUri('loom://acme/ws/orders/../../etc/passwd');
    expect(p!.path).toBe('etc/passwd');
  });

  it('rejects malformed / non-loom / too-short uris', () => {
    expect(parseLoomUri('')).toBeNull();
    expect(parseLoomUri('https://onelake.dfs.fabric.microsoft.com/ws/x')).toBeNull();
    expect(parseLoomUri('loom://acme/ws')).toBeNull();
    // @ts-expect-error runtime guard for non-string
    expect(parseLoomUri(null)).toBeNull();
  });

  it('round-trips build → parse', () => {
    const uri = buildLoomUri({ tenant: 'acme', workspace: 'ws', item: 'sales', itemType: 'lakehouse', path: 'Tables/orders' });
    expect(uri).toBe('loom://acme/ws/sales.lakehouse/Tables/orders');
    const p = parseLoomUri(uri)!;
    expect(p.item).toBe('sales');
    expect(p.itemType).toBe('lakehouse');
    expect(p.path).toBe('Tables/orders');
  });

  it('safeRelPath normalises separators + drops empties', () => {
    expect(safeRelPath('/a//b/../c/')).toBe('a/b/c');
    expect(safeRelPath('a\\b\\c')).toBe('a/b/c');
  });

  it('honest config gate reflects LOOM_ONELAKE_URL', () => {
    const prev = process.env.LOOM_ONELAKE_URL;
    delete process.env.LOOM_ONELAKE_URL;
    expect(onelakeConfigGate()).toEqual({ missing: 'LOOM_ONELAKE_URL' });
    expect(isOneLakeServiceConfigured()).toBe(false);
    process.env.LOOM_ONELAKE_URL = 'https://loom-onelake.internal';
    expect(onelakeConfigGate()).toBeNull();
    expect(isOneLakeServiceConfigured()).toBe(true);
    if (prev === undefined) delete process.env.LOOM_ONELAKE_URL;
    else process.env.LOOM_ONELAKE_URL = prev;
  });
});
