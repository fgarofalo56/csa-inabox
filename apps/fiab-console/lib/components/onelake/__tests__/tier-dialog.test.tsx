/**
 * #4619 — TierDialog sends the lakehouse id on both verbs. The tier route
 * item-scopes a request by `lakehouseId` (read role for GET, write role for
 * PUT, path under the item's storage root); without it only a tenant admin is
 * served. A dialog that drops the id turns every non-admin tier change into a
 * 403. Every load-bearing assertion names the input that breaks it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { TierDialog, tierQuery } from '../tier-dialog';

type Call = { url: string; method: string; body?: string };

function stubFetch(): Call[] {
  const calls: Call[] = [];
  vi.spyOn(global, 'fetch').mockImplementation((async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = (init?.method || 'GET').toUpperCase();
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
    const body = method === 'PUT' ? { ok: true, method: 'set' } : { ok: true, tier: 'Hot' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any);
  return calls;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('tierQuery', () => {
  it('carries lakehouseId when given, and omits it when not', () => {
    // Breaks if the `lakehouseId` set is removed: the first result would lack it.
    const withId = new URLSearchParams(tierQuery('lh-7', 'bronze', 'Files/a.csv'));
    expect(withId.get('lakehouseId')).toBe('lh-7');
    expect(withId.get('container')).toBe('bronze');
    expect(withId.get('path')).toBe('Files/a.csv');
    // The admin-only form: no empty `lakehouseId=` the route would read as an id.
    expect(new URLSearchParams(tierQuery(undefined, 'bronze', 'Files/a.csv')).has('lakehouseId')).toBe(false);
  });
});

describe('TierDialog', () => {
  it('GETs the current tier and PUTs the change with the lakehouse id', async () => {
    // Breaks if the dialog stops sending `lakehouseId` on either verb: the GET
    // URL or the PUT body would lack `lh-7`.
    const calls = stubFetch();
    render(<TierDialog open onOpenChange={() => {}} lakehouseId="lh-7" container="bronze" path="Files/a.csv" />);
    await waitFor(() => expect(calls.some((c) => c.method === 'GET')).toBe(true));
    const get = calls.find((c) => c.method === 'GET')!;
    expect(new URL(get.url, 'http://x').searchParams.get('lakehouseId')).toBe('lh-7');

    fireEvent.click(await screen.findByRole('radio', { name: /^Cool/ }));
    const setBtn = screen.getByRole('button', { name: 'Set to Cool' });
    await waitFor(() => expect(setBtn).not.toBeDisabled());
    fireEvent.click(setBtn);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe('/api/onelake/tier');
    expect(JSON.parse(put.body!)).toEqual({ lakehouseId: 'lh-7', container: 'bronze', path: 'Files/a.csv', tier: 'Cool' });
  });
});
