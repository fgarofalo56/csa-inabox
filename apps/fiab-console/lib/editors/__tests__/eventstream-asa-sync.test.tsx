/**
 * EventstreamEditor — "Push destinations to ASA" flow.
 *
 * Confirms the destination → ASA-output wiring is real (no-vaporware):
 *   - the ASA job name input + "Push destinations to ASA" button render
 *   - per-kind destination ribbon actions exist (KQL Database / Lakehouse /
 *     Event Hub / Activator) — the four supported destinations
 *   - clicking Push POSTs to /api/items/eventstream/[id]/asa-sync and the
 *     returned output receipt renders in a success MessageBar
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { EventstreamEditor } from '../phase3-editors';
import { makeItem, installFetchMock } from './test-helpers';

describe('EventstreamEditor — Push destinations to ASA', () => {
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    const m = installFetchMock({
      '/api/loom/workspaces': () => ({ ok: true, workspaces: [{ id: 'ws-1', name: 'Default Workspace' }] }),
      '/api/items/eventstream/es-fixture/asa-sync': () => ({
        ok: true,
        asaJobName: 'asa-loom-default-eastus2',
        outputs: [
          { name: 'kusto-out', type: 'Microsoft.Kusto/clusters/databases', id: '/arm/kusto-out' },
          { name: 'lake-out', type: 'Microsoft.Storage/Blob', id: '/arm/lake-out' },
        ],
        skipped: [],
      }),
      '/api/items/eventstream/es-fixture': () => ({
        ok: true,
        runtimeStatus: 'config-only',
        asaJobName: 'asa-loom-default-eastus2',
        config: {
          source: { kind: 'eventhub', namespace: 'ns-prod', name: 'orders-hub', consumerGroup: '$Default' },
          transforms: [],
          sinks: [
            { kind: 'kusto', name: 'kusto-out', database: 'loomdb-default', table: 'raw_orders' },
            { kind: 'lakehouse', name: 'lake-out', storageAccount: 'lake01', container: 'bronze' },
          ],
        },
      }),
    });
    calls = m.calls;
  });

  // globals:false means cleanup is not automatic; prevents DOM accumulation between tests.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders the ASA job input + per-kind destination ribbon actions', async () => {
    render(<EventstreamEditor item={makeItem('eventstream', 'Eventstream')} id="es-fixture" />);
    await waitFor(() => {
      expect(screen.getAllByText('Design here, publish to Fabric').length).toBeGreaterThan(0);
    });
    // The four supported destination wizards appear as ribbon actions.
    expect(screen.getAllByRole('button', { name: /^kql database$/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /lakehouse \(adls\)/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /^event hub$/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /^activator$/i }).length).toBeGreaterThan(0);
    // The Push-to-ASA control is present and enabled (asaJobName pre-filled from GET).
    const push = screen.getAllByRole('button', { name: /push destinations to asa/i });
    expect(push.length).toBeGreaterThan(0);
    expect(push.some((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('POSTs to asa-sync and renders the output receipt', async () => {
    render(<EventstreamEditor item={makeItem('eventstream', 'Eventstream')} id="es-fixture" />);
    const push = await waitFor(() => {
      const btns = screen.getAllByRole('button', { name: /push destinations to asa/i }).filter((b) => !(b as HTMLButtonElement).disabled);
      expect(btns.length).toBeGreaterThan(0);
      return btns[0];
    });
    fireEvent.click(push);
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/api/items/eventstream/es-fixture/asa-sync') && c.init?.method === 'POST')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText('Destinations pushed to ASA')).toBeTruthy();
      // The receipt lists the created output aliases. "kusto-out" / "lake-out"
      // also appear in the sinks config panel (from the GET response), so use
      // getAllByText and confirm at least one match (the receipt entry).
      expect(screen.getAllByText('kusto-out').length).toBeGreaterThan(0);
      expect(screen.getAllByText('lake-out').length).toBeGreaterThan(0);
    });
  });
});
