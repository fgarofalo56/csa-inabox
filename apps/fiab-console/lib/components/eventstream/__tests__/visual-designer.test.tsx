/**
 * VisualDesigner — source-node provisioning wizard interaction (jsdom).
 *
 * Per .claude/rules/no-vaporware.md this asserts the source inspector is a REAL
 * provisioning wizard, not a passive form: adding a source + clicking
 * "Provision endpoint" POSTs to /api/items/eventstream/[id]/source, and the
 * returned ingest endpoint renders in the endpoint card (with copy affordances).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VisualDesigner, type PipelineConfig } from '../visual-designer';

const realFetch = global.fetch;
let calls: Array<{ url: string; init?: any }>;

function Harness({ itemId }: { itemId: string }) {
  const [cfg, setCfg] = useState<PipelineConfig>({});
  return <VisualDesigner config={cfg} onChange={setCfg} itemId={itemId} />;
}

beforeEach(() => {
  calls = [];
  global.fetch = vi.fn(async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u.includes('/source')) {
      return new Response(JSON.stringify({
        ok: true,
        endpoint: {
          fqdn: 'loom-evhns.servicebus.windows.net',
          entityPath: 'orders-hub',
          kafkaBootstrap: 'loom-evhns.servicebus.windows.net:9093',
          auth: 'entra',
          connectionString: null,
          localAuthDisabled: true,
        },
        hint: 'Console UAMI needs Azure Event Hubs Data Owner.',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as any;
});
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

describe('VisualDesigner source provisioning wizard', () => {
  it('provisions a real ingest endpoint and renders the endpoint card', async () => {
    render(<Harness itemId="es1" />);

    // Add a source — the palette button auto-selects the new node, opening the
    // inspector (no React Flow node-click needed).
    fireEvent.click(screen.getByRole('button', { name: /add source/i }));

    // The inspector exposes a real "Provision endpoint" action.
    const provisionBtn = await screen.findByRole('button', { name: /provision endpoint/i });
    fireEvent.click(provisionBtn);

    // It POSTs to the real source route…
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/api/items/eventstream/es1/source') && c.init?.method === 'POST')).toBe(true);
    });

    // …and the resolved ingest endpoint renders in the card.
    await waitFor(() => {
      expect(screen.getByTestId('source-endpoint')).toBeTruthy();
      expect(screen.getByText('loom-evhns.servicebus.windows.net')).toBeTruthy();
      expect(screen.getByText('orders-hub')).toBeTruthy();
    });

    // The send/preview actions appear once provisioned (live preview affordances).
    expect(screen.getByRole('button', { name: /send test event/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /preview events/i })).toBeTruthy();
  });
});
