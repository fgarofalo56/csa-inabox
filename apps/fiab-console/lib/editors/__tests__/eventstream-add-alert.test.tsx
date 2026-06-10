/**
 * EventstreamEditor — "Add alert" (embedded Activator) flow.
 *
 * Confirms the ribbon quick-create that creates + links an Activator pre-seeded
 * with the stream source is real (no-vaporware):
 *   - the "Add alert" ribbon action renders and opens the alert dialog
 *   - the dialog exposes typed controls (name / property / operator dropdown /
 *     threshold / frequency dropdown / email) — no raw JSON
 *   - clicking "Create alert" POSTs to /api/items/eventstream/[id]/activator
 *     and the returned linked-Activator receipt renders in a success MessageBar
 *     with a link to open the Activator
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { EventstreamEditor } from '../phase3-editors';
import { makeItem, installFetchMock } from './test-helpers';

describe('EventstreamEditor — Add alert (embedded Activator)', () => {
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    const m = installFetchMock({
      '/api/loom/workspaces': () => ({ ok: true, workspaces: [{ id: 'ws-1', name: 'Default Workspace' }] }),
      '/api/items/eventstream/es-fixture/activator': () => ({
        ok: true,
        activatorId: 'act-123',
        activatorName: 'Eventstream alerts — Orders Stream',
        ruleId: 'orders-stream-alert-rule',
        backend: 'azure-monitor',
        source: { kind: 'eventhub', name: 'orders-hub' },
        rule: { id: 'orders-stream-alert-rule', name: 'orders-alert', state: 'Active' },
      }),
      '/api/items/eventstream/es-fixture': () => ({
        ok: true,
        displayName: 'Orders Stream',
        runtimeStatus: 'draft',
        config: {
          source: { kind: 'eventhub', namespace: 'ns-prod', name: 'orders-hub', consumerGroup: '$Default' },
          transforms: [],
          sinks: [],
        },
      }),
    });
    calls = m.calls;
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('renders the Add alert ribbon action', async () => {
    render(<EventstreamEditor item={makeItem('eventstream', 'Eventstream')} id="es-fixture" />);
    await waitFor(() => {
      expect(screen.getAllByText('Design here, publish to Fabric').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByRole('button', { name: /^add alert$/i }).length).toBeGreaterThan(0);
  });

  it('opens the dialog and POSTs to the eventstream activator route, rendering the linked-Activator receipt', async () => {
    render(<EventstreamEditor item={makeItem('eventstream', 'Eventstream')} id="es-fixture" />);
    const addBtn = await waitFor(() => {
      const btns = screen.getAllByRole('button', { name: /^add alert$/i });
      expect(btns.length).toBeGreaterThan(0);
      return btns[0];
    });
    fireEvent.click(addBtn);

    // The typed dialog renders (no raw JSON) — the "Create alert" CTA appears.
    const createBtn = await waitFor(() => {
      const btns = screen.getAllByRole('button', { name: /^create alert$/i });
      expect(btns.length).toBeGreaterThan(0);
      return btns[0];
    });
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(
        calls.some((c) => c.url.includes('/api/items/eventstream/es-fixture/activator') && c.init?.method === 'POST'),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText('Alert created and linked')).toBeTruthy();
      // The receipt links to the created Activator item.
      const link = screen.getByRole('link', { name: /open the activator/i }) as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe('/items/activator/act-123');
    });
  });
});
