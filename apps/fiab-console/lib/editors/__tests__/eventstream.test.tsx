/**
 * EventstreamEditor — vitest render + interaction.
 *
 * Mounts the editor with mocked /api/loom/workspaces + /api/items/eventstream/[id]
 * responses and confirms:
 *   - workspace list fetch fires
 *   - pipeline config GET fires on mount
 *   - the v2.1 "configuration only" MessageBar renders (no-vaporware: gap disclosure)
 *   - pre-save id === 'new' gate skips the config fetch
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { EventstreamEditor } from '../phase3-editors';
import { makeItem, installFetchMock } from './test-helpers';

describe('EventstreamEditor', () => {
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    const m = installFetchMock({
      '/api/loom/workspaces': () => ({
        ok: true,
        workspaces: [{ id: 'ws-1', name: 'Default Workspace' }],
      }),
      '/api/items/eventstream/es-fixture': () => ({
        ok: true,
        runtimeStatus: 'config-only',
        config: {
          source: { kind: 'eventhub', namespace: 'ns-prod', name: 'orders-hub', consumerGroup: '$Default' },
          transforms: [],
          sink: { kind: 'kusto', database: 'loomdb-default', table: 'raw_orders' },
        },
      }),
    });
    calls = m.calls;
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('fetches workspaces + pipeline config on mount', async () => {
    render(<EventstreamEditor item={makeItem('eventstream', 'Eventstream')} id="es-fixture" />);
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/api/loom/workspaces'))).toBe(true);
      expect(calls.some((c) => c.url.includes('/api/items/eventstream/es-fixture'))).toBe(true);
    });
  });

  it('surfaces the v2.1 configuration-only MessageBar (no-vaporware gap disclosure)', async () => {
    render(<EventstreamEditor item={makeItem('eventstream', 'Eventstream')} id="es-fixture" />);
    await waitFor(() => {
      expect(screen.getByText(/configuration only/i)).toBeInTheDocument();
    });
  });

  it('skips the config fetch when id is "new" (pre-save gate)', () => {
    render(<EventstreamEditor item={makeItem('eventstream', 'Eventstream')} id="new" />);
    expect(calls.filter((c) => c.url.includes('/api/items/eventstream/new')).length).toBe(0);
  });
});
