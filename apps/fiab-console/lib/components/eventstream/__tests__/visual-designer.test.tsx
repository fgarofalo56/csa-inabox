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

/** Harness that exposes the live config for topology assertions. */
let latestCfg: PipelineConfig = {};
function StatefulHarness({ initial }: { initial: PipelineConfig }) {
  const [cfg, setCfg] = useState<PipelineConfig>(initial);
  latestCfg = cfg;
  return <VisualDesigner config={cfg} onChange={setCfg} itemId="es1" />;
}

const STARTER: PipelineConfig = {
  sources: [{ kind: 'eventhub', name: 'source-1', namespace: '', consumerGroup: '$Default' } as any],
  transforms: [],
  sinks: [{ kind: 'kusto', name: 'destination-1', database: 'loomdb-default', table: '' } as any],
};

function sourceCount(): number {
  return Array.isArray(latestCfg.sources) ? latestCfg.sources.length : (latestCfg.source ? 1 : 0);
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

describe('VisualDesigner — add source really adds (operator defect #2)', () => {
  it('clicking "Add source" grows the topology and the node persists across re-renders', async () => {
    render(<StatefulHarness initial={STARTER} />);
    expect(sourceCount()).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: /add source/i }));

    // The topology REALLY grew (the old bug reverted it via a refiring load()).
    await waitFor(() => expect(sourceCount()).toBe(2));
    // …and the newly-added node is auto-selected: its inspector is open.
    expect(await screen.findByText('Source')).toBeTruthy();

    // Still 2 after settling (regression guard for the flash-and-disappear).
    await new Promise((r) => setTimeout(r, 50));
    expect(sourceCount()).toBe(2);
    expect(latestCfg.sources?.[1]?.name).toBe('source-2');
  });
});

describe('VisualDesigner — node deletion (all three paths)', () => {
  it('toolbar Delete removes the selected node', async () => {
    render(<StatefulHarness initial={STARTER} />);
    fireEvent.click(screen.getByRole('button', { name: /add source/i }));
    await waitFor(() => expect(sourceCount()).toBe(2));

    const deleteBtn = screen.getByRole('button', { name: /delete selected node/i });
    expect((deleteBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(deleteBtn);
    await waitFor(() => expect(sourceCount()).toBe(1));
  });

  it('keyboard Delete / Backspace on the canvas removes the selected node', async () => {
    const { container } = render(<StatefulHarness initial={STARTER} />);
    fireEvent.click(screen.getByRole('button', { name: /add source/i }));
    await waitFor(() => expect(sourceCount()).toBe(2));

    const canvas = container.querySelector('[data-canvas="eventstream"]') as HTMLElement;
    expect(canvas).toBeTruthy();
    fireEvent.keyDown(canvas, { key: 'Delete' });
    await waitFor(() => expect(sourceCount()).toBe(1));

    // Backspace path too — re-add then delete again.
    fireEvent.click(screen.getByRole('button', { name: /add source/i }));
    await waitFor(() => expect(sourceCount()).toBe(2));
    fireEvent.keyDown(canvas, { key: 'Backspace' });
    await waitFor(() => expect(sourceCount()).toBe(1));
  });

  it('keyboard Delete is ignored while typing in an input', async () => {
    render(<StatefulHarness initial={STARTER} />);
    fireEvent.click(screen.getByRole('button', { name: /add source/i }));
    await waitFor(() => expect(sourceCount()).toBe(2));

    // The source inspector's Name input lives OUTSIDE the canvas; keying Delete
    // inside canvas-hosted inputs must not nuke the node — simulate via an
    // input target inside the canvas wrapper.
    const canvas = document.querySelector('[data-canvas="eventstream"]') as HTMLElement;
    const input = document.createElement('input');
    canvas.appendChild(input);
    fireEvent.keyDown(input, { key: 'Delete' });
    await new Promise((r) => setTimeout(r, 20));
    expect(sourceCount()).toBe(2);
  });

  it('right-click context menu "Delete" removes the node', async () => {
    render(<StatefulHarness initial={STARTER} />);
    fireEvent.click(screen.getByRole('button', { name: /add source/i }));
    await waitFor(() => expect(sourceCount()).toBe(2));

    // Right-click the source-2 node card (React Flow node wrapper handles it).
    const nodeEl = document.querySelector('[data-es-name="source-2"]') as HTMLElement;
    expect(nodeEl).toBeTruthy();
    fireEvent.contextMenu(nodeEl);

    const menu = await screen.findByTestId('es-node-context-menu');
    expect(menu).toBeTruthy();
    fireEvent.click(screen.getByTestId('es-ctx-delete'));
    await waitFor(() => expect(sourceCount()).toBe(1));
    expect(screen.queryByTestId('es-node-context-menu')).toBeNull();
  });

  it('inspector "Remove source" removes the node', async () => {
    render(<StatefulHarness initial={STARTER} />);
    fireEvent.click(screen.getByRole('button', { name: /add source/i }));
    await waitFor(() => expect(sourceCount()).toBe(2));

    fireEvent.click(screen.getByRole('button', { name: /remove source/i }));
    await waitFor(() => expect(sourceCount()).toBe(1));
  });
});
