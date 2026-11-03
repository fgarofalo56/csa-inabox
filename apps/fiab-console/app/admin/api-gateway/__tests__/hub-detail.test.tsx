/**
 * Gateway detail + hub (W1-5), jsdom. clientFetch is mocked at the transport.
 *
 * Breaking values (assertion-design.md):
 *  - Fix-it present: breaks if the gate list is not rendered (GatewayGates skipped) or the
 *    Fix-it button is dropped for a role-grant gate. Paired with the gate-free gateway, which
 *    breaks if a Fix-it button is rendered unconditionally.
 *  - no fui-MessageBar on first open: breaks if any banner renders for a fresh, healthy gateway.
 *    The control renders a hub whose deploy registration failed and requires the SAME selector to match.
 *  - sync: breaks if the control posts to anything other than /gateways/<id>/sync.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GatewayDoc } from '@/lib/api-gateway/registry/types';

const calls: Array<{ url: string; method: string }> = [];
let responses: Record<string, unknown> = {};

vi.mock('@/lib/client-fetch', () => ({
  clientFetch: async (url: string, init?: { method?: string }) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    const r = (responses[`${init?.method ?? 'GET'} ${url}`] ?? { ok: true, data: {} }) as { status?: number };
    return { status: r.status ?? 200, json: async () => r };
  },
}));
vi.mock('@/lib/components/shared/split-pane', () => ({
  SplitPane: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/components/admin/mcp-servers-panel', () => ({ McpServersPanel: () => <div>mcp-panel</div> }));
vi.mock('@/lib/components/admin/iq-mcp-panel', () => ({ IqMcpPanel: () => <div>iq-panel</div> }));
vi.mock('@/lib/components/admin-shell', () => ({ AdminShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { Hub } from '../hub';
import { GatewayDetail } from '../gateway-detail';

const B = '/api/admin/api-gateway/gateways';
const RID = '/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.ApiManagement/service/apim-x';
const MONITORING_READER = '43d0d8ad-25c7-4714-9337-8ba259a9fe05';

function gw(over: Partial<GatewayDoc> = {}): GatewayDoc {
  return {
    id: 'gw-x', tenantId: 't', docType: 'gateway', kind: 'gateway', displayName: 'apim-x', resourceId: RID,
    cloud: 'AzureCloud', managementMode: 'observe', environmentKey: null,
    access: { canRead: true, canWrite: true, checkedAt: '2026-10-30T00:00:00Z', source: 'permissions' },
    capabilities: { tier: 'unknown', mcpServers: 'unknown', llmPolicies: 'unknown' },
    inventory: { apis: 0, products: 0, subscriptions: 0, backends: 0, namedValues: 0, mcpServers: 0, partialTypes: [] },
    ownedBy: 'registered', createdAt: '2026-10-30T00:00:00Z', createdBy: 'u',
    ...over,
  } as GatewayDoc;
}

beforeEach(() => { calls.length = 0; responses = {}; });
afterEach(cleanup);

describe('gates with Fix-its', () => {
  it('a gateway the Console cannot read renders the gateway-role gate WITH a Fix it button and the az command', async () => {
    const g = gw({
      access: { canRead: false, canWrite: false, checkedAt: 'now', source: 'permissions', principalId: 'oid-1' },
    });
    render(<GatewayDetail gateway={g} onChanged={() => {}} />);
    expect(screen.getByTestId('gate-api-gateway.gateway-role')).toBeTruthy();
    const btn = screen.getByRole('button', { name: /Fix it/ });
    fireEvent.click(btn);
    const cmd = await screen.findByTestId('gate-az-command');
    expect(cmd.textContent).toContain('az role assignment create');
    expect(cmd.textContent).toContain(RID);
  });

  it('PAIRED: a healthy Commercial gateway renders no gate card and NO Fix it button', () => {
    render(<GatewayDetail gateway={gw()} onChanged={() => {}} />);
    expect(screen.getByTestId('gates-clear')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Fix it/ })).toBeNull();
    expect(screen.queryByTestId('gate-api-gateway.gateway-role')).toBeNull();
  });

  it('GCC-High renders the llm-logs gap as a declared gap with owner and NO Fix it button', () => {
    render(<GatewayDetail gateway={gw({ cloud: 'AzureUSGovernment' })} onChanged={() => {}} />);
    expect(screen.getByTestId('gate-api-gateway.llm-logs-unavailable')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Fix it/ })).toBeNull();
    expect(screen.getByTestId('readiness-gaps').textContent).toContain('GatewayLlmLogs absent');
    expect(screen.getByTestId('readiness-gaps').textContent).toContain('Owner: W4');
  });
});

describe('telemetry card', () => {
  it('lists read access only, never a logger or routing row', () => {
    render(<GatewayDetail gateway={gw()} onChanged={() => {}} />);
    const card = screen.getByTestId('telemetry-card');
    expect(card.textContent).toContain('Read access');
    expect(card.textContent).not.toMatch(/Logger|Routing/);
  });
});

describe('first open of a newly registered gateway', () => {
  it('shows no fui-MessageBar; counts are dashes (never synced), not zeros', async () => {
    render(<GatewayDetail gateway={gw()} onChanged={() => {}} />);
    expect(screen.getByText(/Not synced yet/)).toBeTruthy();
    expect(document.querySelector('[class*="fui-MessageBar"]')).toBeNull();
  });

  it('CONTROL: the same selector DOES match when the hub has an error to show', async () => {
    responses[`GET ${B}`] = {
      ok: true,
      data: { gateways: [], deployRegistration: { ok: false, code: 'invalid_deploy_gateway_id', error: 'bad id' } },
    };
    render(<Hub />);
    await screen.findByTestId('deploy-registration-error');
    expect(document.querySelector('[class*="fui-MessageBar"]')).not.toBeNull();
  });

  it('hub list with a healthy fresh gateway shows no MessageBar either', async () => {
    responses[`GET ${B}`] = { ok: true, data: { gateways: [gw()], deployRegistration: { ok: true } } };
    render(<Hub />);
    await waitFor(() => expect(calls.some((c) => c.url === B)).toBe(true));
    fireEvent.click(await screen.findByRole('tab', { name: 'Gateways' }));
    expect(await screen.findByTestId('gateway-detail')).toBeTruthy();
    expect(document.querySelector('[class*="fui-MessageBar"]')).toBeNull();
  });
});

describe('inventory sync control', () => {
  it('posts to /gateways/<id>/sync and shows endpoint count from the response', async () => {
    responses[`POST ${B}/gw-x/sync`] = {
      ok: true,
      data: { status: 'synced', gatewayId: 'gw-x', counts: { operation: 37, api: 4 }, partialTypes: [], swept: 0, mcp: 'unknown' },
    };
    const onChanged = vi.fn();
    render(<GatewayDetail gateway={gw()} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /Sync inventory/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([`${B}/gw-x/sync`]);
    expect(screen.getByText('37')).toBeTruthy();
  });

  it('a failed sync shows the API error text', async () => {
    responses[`POST ${B}/gw-x/sync`] = { ok: false, status: 409, error: 'A sync of gw-x is already running.' };
    render(<GatewayDetail gateway={gw()} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Sync inventory/ }));
    expect(await screen.findByText('A sync of gw-x is already running.')).toBeTruthy();
  });
});

describe('Manage section', () => {
  it('deploy-owned gateway mounts panes with no gateway param; registered gateway scopes them', async () => {
    const f = vi.fn(async (input: string) => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, service: { name: 's', sku: { name: 'Developer', capacity: 1 } } }), url: input }));
    vi.stubGlobal('fetch', f);
    const { unmount } = render(<GatewayDetail gateway={gw({ ownedBy: 'deploy' })} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Manage' }));
    await waitFor(() => expect(f).toHaveBeenCalledWith('/api/apim/service', undefined));
    unmount();
    f.mockClear();
    render(<GatewayDetail gateway={gw()} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Manage' }));
    await waitFor(() => expect(f).toHaveBeenCalledWith('/api/apim/service?gateway=gw-x', undefined));
    vi.unstubAllGlobals();
  });

  it('item-route panes on a registered gateway say they are not scoped instead of showing the default gateway data', () => {
    render(<GatewayDetail gateway={gw()} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Manage' }));
    fireEvent.click(screen.getByRole('tab', { name: 'APIs' }));
    expect(screen.getByTestId('manage-unscoped')).toBeTruthy();
  });
});

describe('registration', () => {
  it('surfaces the API remediation text and az command verbatim on gateway_role_missing', async () => {
    responses[`GET ${B}`] = { ok: true, data: { gateways: [], deployRegistration: { ok: true } } };
    responses[`POST ${B}`] = {
      ok: false, status: 422, code: 'gateway_role_missing',
      error: `The Console identity cannot read ${RID}. Grant Reader.`,
      data: { missingRole: { roleDefinitionId: MONITORING_READER, roleName: 'Reader', scope: RID, azCommand: 'az role assignment create --role Reader' } },
    };
    render(<Hub />);
    fireEvent.click((await screen.findAllByRole('button', { name: /Register gateway/ }))[0]);
    fireEvent.change(await screen.findByPlaceholderText(/subscriptions/), { target: { value: RID } });
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    const err = await screen.findByTestId('register-error');
    expect(err.textContent).toContain('Grant Reader.');
    expect(screen.getByText('az role assignment create --role Reader')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.url === B)).toBe(true);
  });
});
