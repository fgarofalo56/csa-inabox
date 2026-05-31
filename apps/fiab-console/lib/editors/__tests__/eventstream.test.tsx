/**
 * EventstreamEditor — vitest render + interaction.
 *
 * Mounts the editor with mocked /api/loom/workspaces + /api/items/eventstream/[id]
 * responses and confirms:
 *   - workspace list fetch fires
 *   - pipeline config GET fires on mount
 *   - the "Design here, publish to Fabric" guidance MessageBar renders AND a
 *     real, enabled "Publish to Fabric" action is wired (no-vaporware: the
 *     editor now ships a live publish workflow — info MessageBar + ribbon
 *     button + toolbar button + dialog — not a passive disclosure banner)
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

  it('surfaces the publish-to-Fabric guidance MessageBar + a live, enabled Publish action (no-vaporware)', async () => {
    render(<EventstreamEditor item={makeItem('eventstream', 'Eventstream')} id="es-fixture" />);
    // The editor mounts and shows the honest guidance MessageBar whose title is
    // the exact current copy. (The bare /publish to fabric/i text now matches in
    // several spots — info banner, ribbon button, toolbar button, dialog title —
    // so we anchor on the MessageBar title instead. ItemEditorChrome renders the
    // main content in more than one layout tree, so the title node appears more
    // than once; assert at least one is present.)
    await waitFor(() => {
      expect(screen.getAllByText('Design here, publish to Fabric').length).toBeGreaterThan(0);
    });
    // …and the publish workflow is real, not a passive banner: a "Publish to
    // Fabric" button is rendered and enabled (it opens the publish dialog that
    // POSTs to the real Fabric definition REST route). Both the ribbon and the
    // toolbar expose it, so assert at least one enabled instance exists.
    const publishButtons = screen.getAllByRole('button', { name: /^publish to fabric$/i });
    expect(publishButtons.length).toBeGreaterThan(0);
    expect(publishButtons.some((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('skips the config fetch when id is "new" (pre-save gate)', () => {
    render(<EventstreamEditor item={makeItem('eventstream', 'Eventstream')} id="new" />);
    expect(calls.filter((c) => c.url.includes('/api/items/eventstream/new')).length).toBe(0);
  });
});
