/**
 * HealthCheckNotifications — the Azure Function and Logic App receivers render
 * as BINDINGS, never as a secret-bearing text field (#4740, #4748).
 *
 * WHAT MAKES THESE FAIL (assertion-design.md):
 *   • Reverting the Azure Function block to the old `<Input value={r.functionUrl}
 *     placeholder="…?code=…">` puts an input whose placeholder contains `?code=`
 *     back in the DOM → the `?code=` query fails; and the `function-app-id`
 *     picker stub would be absent → the positive query fails.
 *   • A legacy row arrives from the server as `{ legacyEndpoint }` and must show
 *     that endpoint in a re-bind MessageBar beside the picker — dropping the
 *     notice fails the endpoint/title queries. That the KEY never reaches the
 *     browser is a server property, pinned where it can fail: the route test
 *     `action-group/__tests__/receivers.test.ts` (a DOM absence check here
 *     could not fail — the fixture has no key in it to leak).
 *   • A Logic App whose trigger report says it has no request trigger must show
 *     that problem on the surface before save — deleting the problem MessageBar
 *     fails the text query.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const fetchMock = vi.fn();
vi.mock('@/lib/client-fetch', () => ({ clientFetch: (...a: any[]) => fetchMock(...a) }));
// The picker's own discovery is covered by azure-backed-field.test.tsx; here only
// WHICH kind the surface asks for matters.
vi.mock('@/lib/components/azure/azure-backed-field', () => ({
  AzureBackedField: (p: { kind: string; value?: string }) => <div data-testid={`abf-${p.kind}`} data-value={p.value || ''} />,
}));

import { HealthCheckNotifications } from '../health-check-editor';

const SITE = '/subscriptions/sub-1/resourceGroups/rg-fn/providers/Microsoft.Web/sites/alerts-fn';
const WF = '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Logic/workflows/Nightly';

function jsonRes(body: unknown, status = 200) { return { status, json: async () => body } as any; }

function route(current: unknown, extra: Record<string, unknown> = {}) {
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.startsWith('/api/items/health-check/hc-1/action-group')) return jsonRes({ ok: true, groups: [], current });
    for (const [prefix, body] of Object.entries(extra)) if (u.startsWith(prefix)) return jsonRes(body);
    return jsonRes({ ok: false, error: `unexpected ${u}` }, 404);
  });
}

function wrap() {
  return render(<FluentProvider theme={webLightTheme}><HealthCheckNotifications id="hc-1" itemName="orders" /></FluentProvider>);
}

afterEach(cleanup);
beforeEach(() => { fetchMock.mockReset(); });

const base = { name: 'orders-ag', shortName: 'orders', emails: [], sms: [], webhooks: [], logicApps: [] };

describe('HealthCheckNotifications — Azure Function receiver (#4740)', () => {
  it('renders the function-app-id picker and NO hand-typed trigger URL field', async () => {
    route({ ...base, functions: [{ functionAppResourceId: SITE, functionName: 'OnAlert', useCommonAlertSchema: true }] }, {
      '/api/azure/function-apps/functions': { ok: true, functions: [{ name: 'OnAlert', httpTrigger: true, authLevel: 'function', isDisabled: false, usable: true }] },
    });
    const { container } = wrap();
    await waitFor(() => expect(screen.getByTestId('abf-function-app-id')).toBeTruthy());
    expect(screen.getByTestId('abf-function-app-id').getAttribute('data-value')).toBe(SITE);
    expect(container.querySelector('input[placeholder*="?code="]')).toBeNull();
    expect(screen.queryByText(/include the function key/i)).toBeNull();
    // The functions of the picked app are read from the server route, by app id.
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]) === `/api/azure/function-apps/functions?siteId=${encodeURIComponent(SITE)}`)).toBe(true));
  });

  it('a legacy hand-typed row is surfaced for re-binding with its key-free endpoint only', async () => {
    route({ ...base, functions: [{ legacyEndpoint: 'https://old-fn.azurewebsites.net/api/alert', useCommonAlertSchema: true }] });
    wrap();
    await waitFor(() => expect(screen.getByTestId('hc-function-legacy')).toBeTruthy());
    expect(screen.getByTestId('hc-function-legacy').textContent).toContain('https://old-fn.azurewebsites.net/api/alert');
    expect(screen.getByText('Re-bind this Azure Function')).toBeTruthy();
    expect(screen.getByTestId('abf-function-app-id')).toBeTruthy();
  });
});

describe('HealthCheckNotifications — Logic App receiver (#4748)', () => {
  it('reports on pick, before save, that a workflow has no HTTP-request trigger', async () => {
    const problem = "Logic App 'Nightly' cannot be notified by Azure Monitor: it has no HTTP-request trigger. Triggers found: 'Recurrence' (Recurrence).";
    route({ ...base, functions: [], logicApps: [{ resourceId: WF, useCommonAlertSchema: true }] }, {
      '/api/monitor/logic-app-triggers': { ok: true, workflowName: 'Nightly', triggers: [{ name: 'Recurrence', type: 'Recurrence', callbackCapable: false }], problem },
    });
    wrap();
    await waitFor(() => expect(screen.getByTestId('hc-logic-app-trigger-problem')).toBeTruthy());
    expect(screen.getByTestId('hc-logic-app-trigger-problem').textContent).toContain("Triggers found: 'Recurrence' (Recurrence)");
  });

  it('names the resolved trigger when it is not `manual`', async () => {
    route({ ...base, functions: [], logicApps: [{ resourceId: WF, useCommonAlertSchema: true }] }, {
      '/api/monitor/logic-app-triggers': { ok: true, workflowName: 'Nightly', triggers: [{ name: 'When_a_HTTP_request_is_received', type: 'Request', callbackCapable: true }], triggerName: 'When_a_HTTP_request_is_received', chosenBy: 'only' },
    });
    wrap();
    await waitFor(() => expect(screen.getByTestId('hc-logic-app-trigger-resolved')).toBeTruthy());
    expect(screen.getByTestId('hc-logic-app-trigger-resolved').textContent).toContain('When_a_HTTP_request_is_received');
    expect(screen.getByTestId('hc-logic-app-trigger-resolved').textContent).toContain('its only HTTP-request trigger');
  });
});
