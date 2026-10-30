/**
 * Settings -> Environments / Findings render against the real route envelope
 * (mocked at clientFetch). Pins: the six seeded environments and the 7x7 matrix
 * render from API data; a first open with no registry shows no error banner; a
 * refused reclassification surfaces the blocking publication by name; an
 * applied tag suggestion posts exactly the change the suggestion named.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { seedCatalog } from '@/lib/api-gateway/environments/seed';
import { compatibilityMatrix } from '@/lib/api-gateway/environments/permits';

const calls: Array<{ url: string; method: string; body?: string }> = [];
let responses: Record<string, unknown> = {};

vi.mock('@/lib/client-fetch', () => ({
  clientFetch: async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    const key = `${init?.method ?? 'GET'} ${url}`;
    const r = (responses[key] ?? { ok: true, data: {} }) as { status?: number };
    return { status: r.status ?? 200, json: async () => r };
  },
}));
vi.mock('@/lib/components/shared/split-pane', () => ({
  SplitPane: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/components/admin-shell', () => ({ AdminShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { EnvironmentsTab } from '../environments-tab';
import { FindingsTab } from '../findings-tab';
import Page from '../page';

const B = '/api/admin/api-gateway/environments';
const cat = seedCatalog('t');
const settings = { requireClassification: false, environments: cat.environments };

function seedResponses(over: { registryAvailable: boolean; suggestions?: unknown[] }) {
  responses = {
    [`GET ${B}`]: { ok: true, data: { environments: cat.environments, settings: cat.settings, usage: { development: 1 }, unclassified: over.registryAvailable ? 1 : 0, registryAvailable: over.registryAvailable } },
    [`GET ${B}/matrix`]: { ok: true, data: compatibilityMatrix(settings) },
    [`GET ${B}/suggestions`]: { ok: true, data: { suggestions: over.suggestions ?? [], registryAvailable: over.registryAvailable } },
    [`GET ${B}/findings`]: { ok: true, data: { findings: [], available: false } },
  };
}

beforeEach(() => { calls.length = 0; });
afterEach(cleanup);

describe('Environments tab', () => {
  it('first open with no registry: lists the six environments, the matrix, and shows NO error banner', async () => {
    seedResponses({ registryAvailable: false });
    render(<EnvironmentsTab />);
    expect(await screen.findByRole('option', { name: /Production/ })).toBeTruthy();
    for (const n of ['Development', 'Test', 'QC', 'Staging', 'Sandbox']) expect(screen.getAllByText(n).length).toBeGreaterThan(0);
    expect(screen.getByRole('table', { name: 'Environment compatibility matrix' })).toBeTruthy();
    // 7 body rows + 1 header row
    expect(screen.getAllByRole('row')).toHaveLength(8);
    expect(screen.getByText('No gateways registered yet')).toBeTruthy();
    expect(screen.queryByText('Could not load environments')).toBeNull();
    expect(document.querySelector('[class*="fui-MessageBar"]')).toBeNull();
  });

  it('applying a suggestion posts the exact change; a 409 refusal names the blocking publication', async () => {
    seedResponses({ registryAvailable: true, suggestions: [{ resourceKind: 'gateway', resourceId: 'g2', displayName: 'Gateway Two', environmentKey: 'production', tagName: 'env', tagValue: 'prod', matchedBy: 'alias' }] });
    responses[`POST ${B}/reclassify`] = { ok: false, status: 409, error: 'This change would block 1 applied publication: Orders MCP.', blocking: [{ id: 'pub-1', displayName: 'Orders MCP', reason: 'A Production gateway cannot front a Development resource.' }] };
    render(<EnvironmentsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(calls.some((c) => c.url === `${B}/reclassify`)).toBe(true));
    const post = calls.find((c) => c.url === `${B}/reclassify`)!;
    expect(post.method).toBe('POST');
    expect(JSON.parse(post.body!)).toEqual({ changes: [{ kind: 'gateway', id: 'g2', environmentKey: 'production' }] });
    expect(await screen.findByText(/Orders MCP: A Production gateway cannot front/)).toBeTruthy();
    // positive control for the first-open assertion above: the selector it uses does match a rendered MessageBar
    expect(document.querySelector('[class*="fui-MessageBar"]')).not.toBeNull();
  });
});

describe('Findings tab', () => {
  it('empty and unavailable: guided empty state, not an error; with data: advisory card', async () => {
    seedResponses({ registryAvailable: false });
    const { unmount } = render(<FindingsTab />);
    expect(await screen.findByText('Nothing to check yet')).toBeTruthy();
    unmount();
    responses[`GET ${B}/findings`] = { ok: true, data: { available: true, findings: [{ id: 'f1', producer: 'gateway-mcp', severity: 'advisory', gatewayId: 'g1', gatewayName: 'Gateway One', resourceKind: 'mcp', resourceId: 'm1', resourceName: 'Orders', message: 'MCP server tools points at Orders.' }] } };
    render(<FindingsTab />);
    expect(await screen.findByText('MCP server tools points at Orders.')).toBeTruthy();
    expect(screen.getByText('Advisory')).toBeTruthy();
  });
});

describe('Settings page', () => {
  it('shows the Environments and Findings tabs and switches between them', async () => {
    seedResponses({ registryAvailable: false });
    render(<Page />);
    expect(screen.getByRole('tab', { name: 'Environments' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Findings' }));
    expect(await screen.findByText('Nothing to check yet')).toBeTruthy();
  });
});
