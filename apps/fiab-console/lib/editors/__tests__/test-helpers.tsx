/**
 * Shared helpers for editor Vitest specs.
 *
 * Each spec mounts an editor, mocks `global.fetch`, and exercises at
 * least one primary action. These helpers keep the per-spec boilerplate
 * minimal.
 */
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import { vi } from 'vitest';

export function makeItem(slug: string, displayName: string): FabricItemType {
  return {
    slug,
    displayName,
    restType: displayName.replace(/\s+/g, ''),
    category: 'Data Engineering',
    description: `${displayName} test fixture`,
  };
}

/** Install a fetch mock keyed by URL substring. */
export function installFetchMock(handlers: Record<string, (url: string, init?: RequestInit) => unknown>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : (url as any).toString();
    calls.push({ url: u, init });
    for (const key of Object.keys(handlers)) {
      if (u.includes(key)) {
        const body = handlers[key](u, init);
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.spyOn(global, 'fetch').mockImplementation(fetchMock as any);
  return { fetchMock, calls };
}
