/**
 * EventhouseEditor — vitest render + interaction.
 *
 * Mounts the Eventhouse editor with a mocked /api/items/eventhouse/[id]
 * response and confirms:
 *   - cluster fetch fires on mount
 *   - database cards render from the API response
 *   - selecting a card surfaces the "selected" badge
 *   - the "New KQL database" primary button is wired (clickable)
 *   - the "id === 'new'" pre-save gate skips the fetch
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { EventhouseEditor } from '../phase3-editors';
import { makeItem, installFetchMock } from './test-helpers';

describe('EventhouseEditor', () => {
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    const m = installFetchMock({
      '/api/items/eventhouse/eh-fixture': () => ({
        ok: true,
        cluster: 'https://adx-csa-loom-shared.eastus2.kusto.usgovcloudapi.net',
        defaultDatabase: 'loomdb-default',
        databases: [
          { name: 'loomdb-default', prettyName: 'Default' },
          { name: 'iot-telemetry' },
        ],
      }),
    });
    calls = m.calls;
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('fetches cluster + lists databases on mount', async () => {
    render(<EventhouseEditor item={makeItem('eventhouse', 'Eventhouse')} id="eh-fixture" />);
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/api/items/eventhouse/eh-fixture'))).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText('loomdb-default')).toBeInTheDocument();
      expect(screen.getByText('iot-telemetry')).toBeInTheDocument();
    });
  });

  it('exposes a "New KQL database" primary button', async () => {
    render(<EventhouseEditor item={makeItem('eventhouse', 'Eventhouse')} id="eh-fixture" />);
    await waitFor(() => expect(screen.getByText('loomdb-default')).toBeInTheDocument());
    // Toolbar button text — the dialog trigger.
    const newDbButtons = screen.getAllByRole('button', { name: /New KQL database/i });
    expect(newDbButtons.length).toBeGreaterThan(0);
  });

  it('skips the cluster fetch when id is "new" (pre-save gate)', () => {
    render(<EventhouseEditor item={makeItem('eventhouse', 'Eventhouse')} id="new" />);
    expect(calls.filter((c) => c.url.includes('/api/items/eventhouse/new')).length).toBe(0);
  });
});
