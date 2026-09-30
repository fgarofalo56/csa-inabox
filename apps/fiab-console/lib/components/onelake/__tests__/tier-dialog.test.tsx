/**
 * #4619 — TierDialog sends the lakehouse id on both verbs, and gates the
 * change on the shell's admin flag.
 *
 * The tier route item-scopes GET by `lakehouseId`; PUT is tenant-admin for now
 * (it becomes item-scoped once server-owned lakehouse roots land). So a
 * non-admin still sees the current tier, with the change controls disabled and
 * the reason shown, and a 403 `admin_only` answer renders its envelope. Every
 * load-bearing assertion names the input that breaks it.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { SessionProvider } from '@/lib/components/session-context';
import { TIER_CHANGE_ADMIN_ONLY } from '@/lib/util/admin-only-copy';
import { TierDialog, tierQuery } from '../tier-dialog';

type Call = { url: string; method: string; body?: string };

const ENVELOPE = {
  ok: false, error: 'forbidden', code: 'admin_only',
  reason: 'SERVER-REASON-t41', remediation: 'SERVER-REMEDIATION-t41', gateId: 'bootstrap-admin',
};

function stubFetch(putAnswer: { status: number; body: unknown } = { status: 200, body: { ok: true, method: 'set' } }): Call[] {
  const calls: Call[] = [];
  vi.spyOn(global, 'fetch').mockImplementation((async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = (init?.method || 'GET').toUpperCase();
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
    const [status, body] = method === 'PUT' ? [putAnswer.status, putAnswer.body] : [200, { ok: true, tier: 'Hot' }];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as any);
  return calls;
}

function withSession(isTenantAdmin: boolean, node: ReactNode) {
  return (
    <SessionProvider value={{ authenticated: true, user: null, isTenantAdmin, loading: false }}>
      {node}
    </SessionProvider>
  );
}

const dialog = () => <TierDialog open onOpenChange={() => {}} lakehouseId="lh-7" container="bronze" path="Files/a.csv" />;

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
  it('tenant admin: GETs the current tier and PUTs the change with the lakehouse id', async () => {
    // Breaks if the dialog stops sending `lakehouseId` on either verb (the GET
    // URL or the PUT body would lack `lh-7`), or if admins were gated too
    // (Set to Cool would stay disabled and no PUT would be made).
    const calls = stubFetch();
    render(withSession(true, dialog()));
    await waitFor(() => expect(calls.some((c) => c.method === 'GET')).toBe(true));
    const get = calls.find((c) => c.method === 'GET')!;
    expect(new URL(get.url, 'http://x').searchParams.get('lakehouseId')).toBe('lh-7');
    expect(screen.queryByTestId('admin-only-notice')).toBeNull();

    fireEvent.click(await screen.findByRole('radio', { name: /^Cool/ }));
    const setBtn = screen.getByRole('button', { name: 'Set to Cool' });
    await waitFor(() => expect(setBtn).not.toBeDisabled());
    fireEvent.click(setBtn);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe('/api/onelake/tier');
    expect(JSON.parse(put.body!)).toEqual({ lakehouseId: 'lh-7', container: 'bronze', path: 'Files/a.csv', tier: 'Cool' });
  });

  it('non-admin: still reads the current tier, but the change is disabled and the reason is shown', async () => {
    // Breaks if `cannotWrite` is dropped from the radios or the Set button
    // (the Cool radio / Set button would be enabled), or the pre-emptive
    // notice is not rendered. The GET still runs: the read is item-scoped.
    const calls = stubFetch();
    render(withSession(false, dialog()));
    await waitFor(() => expect(calls.some((c) => c.method === 'GET')).toBe(true));
    expect((await screen.findByTestId('admin-only-notice')).textContent).toContain(TIER_CHANGE_ADMIN_ONLY.reason);
    expect(await screen.findByText('Hot')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /^Cool/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Set to/ })).toBeDisabled();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('a PUT answered with 403 admin_only renders the envelope reason + remediation', async () => {
    // The shell flag says admin but the route refuses (e.g. a stale session).
    // Breaks if submit() renders `refusalText` in the error bar instead of
    // passing the envelope to the notice (no admin-only-notice would appear).
    const calls = stubFetch({ status: 403, body: ENVELOPE });
    render(withSession(true, dialog()));
    fireEvent.click(await screen.findByRole('radio', { name: /^Cool/ }));
    const setBtn = screen.getByRole('button', { name: 'Set to Cool' });
    await waitFor(() => expect(setBtn).not.toBeDisabled());
    fireEvent.click(setBtn);
    const notice = await screen.findByTestId('admin-only-notice');
    expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    expect(notice.textContent).toContain('SERVER-REASON-t41');
    expect(notice.textContent).toContain('SERVER-REMEDIATION-t41');
  });
});
