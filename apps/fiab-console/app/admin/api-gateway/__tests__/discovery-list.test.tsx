/**
 * W1-9 register dialog discovery list, jsdom (clientFetch mocked at the transport).
 *
 * Breaking values (assertion-design.md):
 *  - candidates render: breaks if the list is not mapped from data.candidates.
 *  - registered disabled: the registered card must be disabled and the free one enabled (paired);
 *    an always-enabled or always-disabled card fails one of the two.
 *  - partial warning: must contain the failing subscription id AND its HTTP status; dropping the
 *    failures list fails the toContain.
 *  - empty state: shown ONLY for partial:false + zero candidates. The partial:true + zero case
 *    must NOT show it (an empty state there is the R7 lie); the complete-empty case must show it.
 *  - pick registers only the chosen one: after clicking candidate B and Register, the POST body
 *    resourceId equals B's id and exactly one POST was made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const calls: Array<{ url: string; method: string; body?: string }> = [];
let responses: Record<string, unknown> = {};

vi.mock('@/lib/client-fetch', () => ({
  clientFetch: async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    const r = (responses[`${init?.method ?? 'GET'} ${url}`] ?? { ok: true, data: {} }) as { status?: number };
    return { status: r.status ?? 200, json: async () => r };
  },
}));

import { RegisterGatewayDialog } from '../register-dialog';

const B = '/api/admin/api-gateway/gateways';
const SUB_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const SUB_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const rid = (sub: string, name: string) =>
  `/subscriptions/${sub}/resourceGroups/rg/providers/Microsoft.ApiManagement/service/${name}`;

function cand(name: string, over: Record<string, unknown> = {}) {
  return {
    resourceId: rid(SUB_A, name), name, subscriptionId: SUB_A, resourceGroup: 'rg', sku: 'Developer', location: 'eastus2',
    networkMode: 'None', access: { canRead: true, canWrite: false, source: 'permissions' },
    alreadyRegistered: false, observeSummary: `observe ${name}`, ...over,
  };
}
const result = (over: Record<string, unknown>) => ({
  ok: true,
  data: { candidates: [], subscriptionsScanned: 2, partial: false, failures: [], scannedAt: 'x', ...over },
});

const mountDialog = () => render(<RegisterGatewayDialog open onClose={() => {}} onRegistered={() => {}} />);

beforeEach(() => { calls.length = 0; responses = {}; });
afterEach(() => cleanup());

describe('discovery list in the register dialog', () => {
  it('renders candidates; the registered one is disabled and marked, the free one is enabled', async () => {
    responses[`GET ${B}/discover`] = result({ candidates: [cand('apim-free'), cand('apim-taken', { alreadyRegistered: true })] });
    mountDialog();
    const free = (await screen.findByTestId('candidate-apim-free')) as HTMLButtonElement;
    const taken = screen.getByTestId('candidate-apim-taken') as HTMLButtonElement;
    expect(free.disabled).toBe(false);
    expect(taken.disabled).toBe(true);
    expect(taken.textContent).toContain('Already registered');
    expect(free.textContent).not.toContain('Already registered');
    expect(free.textContent).toContain('observe apim-free');
    expect(screen.queryByTestId('discovery-partial')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('partial scan names the failing subscription and its status, and never shows the empty state', async () => {
    responses[`GET ${B}/discover`] = result({
      partial: true, candidates: [],
      failures: [{ scope: SUB_B, kind: 'service-list', status: 403, reason: 'AuthorizationFailed: denied' }],
    });
    mountDialog();
    const warn = await screen.findByTestId('discovery-partial');
    expect(warn.textContent).toContain(SUB_B);
    expect(warn.textContent).toContain('HTTP 403');
    expect(screen.queryByText('No API Management services found')).toBeNull();
  });

  it('empty state appears for a COMPLETE scan with zero candidates (paired with the partial case)', async () => {
    responses[`GET ${B}/discover`] = result({});
    mountDialog();
    expect(await screen.findByText('No API Management services found')).toBeTruthy();
    expect(screen.queryByTestId('discovery-partial')).toBeNull();
  });

  it('discovery failure is stated as such and pasting a resource id still registers', async () => {
    responses[`GET ${B}/discover`] = { ok: false, status: 500, error: 'boom' };
    responses[`POST ${B}`] = { ok: true, status: 201, data: { id: 'gw-1' } };
    mountDialog();
    expect((await screen.findByTestId('discovery-unavailable')).textContent).toContain('boom');
    fireEvent.change(screen.getByPlaceholderText(/subscriptions/), { target: { value: rid(SUB_A, 'pasted') } });
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === 'POST')!.body!).resourceId).toBe(rid(SUB_A, 'pasted'));
  });

  it('picking a candidate registers exactly that one through the register call', async () => {
    responses[`GET ${B}/discover`] = result({ candidates: [cand('apim-one'), cand('apim-two')] });
    responses[`POST ${B}`] = { ok: true, status: 201, data: { id: 'gw-2' } };
    mountDialog();
    fireEvent.click(await screen.findByTestId('candidate-apim-two'));
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.url === B)).toHaveLength(1));
    const post = calls.find((c) => c.method === 'POST' && c.url === B)!;
    expect(JSON.parse(post.body!)).toEqual({ resourceId: rid(SUB_A, 'apim-two'), displayName: 'apim-two' });
  });

  it('nothing is registered just by opening the dialog (no POST on mount)', async () => {
    responses[`GET ${B}/discover`] = result({ candidates: [cand('apim-one')] });
    mountDialog();
    await screen.findByTestId('candidate-apim-one');
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});
