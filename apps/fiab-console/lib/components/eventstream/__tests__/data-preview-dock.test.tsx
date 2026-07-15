/**
 * DataPreviewDock — preview-on-unconfigured-node + deferred-validation (jsdom).
 *
 * Operator-reported defect: a brand-new eventstream immediately showed
 * "Preview failed: source node not found" plus red authoring errors. The dock
 * must (a) NEVER fetch the preview against an unconfigured / nonexistent
 * source — it renders a friendly guided empty state instead — and (b) defer
 * validation: while `pristine`, the errors tab is a neutral "Set up" checklist
 * with no danger badge.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DataPreviewDock, sourceNeedsSetup } from '../data-preview-dock';

const realFetch = global.fetch;
let calls: string[];

beforeEach(() => {
  calls = [];
  global.fetch = vi.fn(async (url: any) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ ok: true, events: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;
});
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

const UNCONFIGURED_TOPOLOGY = {
  sources: [{ kind: 'eventhub', name: 'source-1', namespace: '', consumerGroup: '$Default' }],
  transforms: [],
  sinks: [{ kind: 'kusto', name: 'destination-1', database: 'loomdb-default', table: '' }],
};

describe('DataPreviewDock — preview on an unconfigured node', () => {
  it('does NOT fetch and shows the friendly configure-a-source state (no crash, no "source node not found")', async () => {
    render(<DataPreviewDock itemId="es1" topology={UNCONFIGURED_TOPOLOGY} pristine />);

    // Friendly guided state renders…
    expect(await screen.findByTestId('preview-setup-state')).toBeTruthy();
    expect(screen.getByTestId('preview-setup-state').textContent).toMatch(/configure a source to preview/i);

    // …and the events endpoint is never hit (the old bug auto-fetched and 404'd).
    await waitFor(() => {
      expect(calls.filter((u) => u.includes('/events'))).toHaveLength(0);
    });
    // No error MessageBar.
    expect(screen.queryByText(/preview failed/i)).toBeNull();
  });

  it('shows the add-a-source guidance when the topology has NO source node', async () => {
    render(<DataPreviewDock itemId="es1" topology={{ sources: [], transforms: [], sinks: [] }} />);
    expect(await screen.findByTestId('preview-setup-state')).toBeTruthy();
    expect(screen.getByTestId('preview-setup-state').textContent).toMatch(/no source yet/i);
    expect(calls.filter((u) => u.includes('/events'))).toHaveLength(0);
  });

  it('DOES fetch for a provisioned source', async () => {
    const topology = {
      sources: [{
        kind: 'eventhub', name: 'source-1', eventHubName: 'orders-hub',
        provisionedEndpoint: { entityPath: 'orders-hub', fqdn: 'ns.servicebus.windows.net' },
      }],
      transforms: [],
      sinks: [],
    };
    render(<DataPreviewDock itemId="es1" topology={topology} />);
    await waitFor(() => {
      expect(calls.some((u) => u.includes('/api/items/eventstream/es1/events'))).toBe(true);
    });
    expect(screen.queryByTestId('preview-setup-state')).toBeNull();
  });

  it('maps a server source_unconfigured response to the friendly state, not an error', async () => {
    (global.fetch as any).mockImplementation(async (url: any) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({ ok: false, code: 'source_unconfigured', error: 'Source has no provisioned ingest endpoint yet.' }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      );
    });
    // Config LOOKS previewable client-side (has a hub name) but the server's
    // persisted state disagrees — the dock must still land on the guided state.
    const topology = {
      sources: [{ kind: 'eventhub', name: 'source-1', eventHubName: 'orders-hub' }],
      transforms: [],
      sinks: [],
    };
    render(<DataPreviewDock itemId="es1" topology={topology} />);
    expect(await screen.findByTestId('preview-setup-state')).toBeTruthy();
    expect(screen.queryByText(/preview failed/i)).toBeNull();
  });
});

describe('DataPreviewDock — deferred validation (pristine)', () => {
  it('pristine: no danger badge; errors tab is a neutral guided setup checklist', async () => {
    render(<DataPreviewDock itemId="es1" topology={UNCONFIGURED_TOPOLOGY} pristine />);

    // Tab reads "Set up" with NO danger count badge.
    const setupTab = screen.getByRole('tab', { name: /set up/i });
    expect(setupTab.textContent).not.toMatch(/\d/);

    setupTab.click();
    const guided = await screen.findByTestId('authoring-guided-setup');
    expect(guided.textContent).toMatch(/validation turns on once you edit or save/i);
    // The findings render as numbered neutral steps, not red error rows.
    expect(guided.textContent).toMatch(/event hub name is required/i);
    expect(screen.queryByTestId('authoring-errors')).toBeNull();
  });

  it('touched: the errors tab shows real authoring errors with the danger badge', async () => {
    render(<DataPreviewDock itemId="es1" topology={UNCONFIGURED_TOPOLOGY} pristine={false} />);
    const errTab = screen.getByRole('tab', { name: /authoring errors/i });
    // Two errors (source hub name + sink table) → danger count badge present.
    expect(errTab.textContent).toMatch(/2/);
    errTab.click();
    expect(await screen.findByTestId('authoring-errors')).toBeTruthy();
  });
});

describe('sourceNeedsSetup', () => {
  it('classifies nodes correctly', () => {
    expect(sourceNeedsSetup(undefined)).toBe(true);
    expect(sourceNeedsSetup({ kind: 'eventhub' })).toBe(true);
    expect(sourceNeedsSetup({ kind: 'eventhub', eventHubName: 'h1' })).toBe(false);
    expect(sourceNeedsSetup({ kind: 'sample' })).toBe(false);
    expect(sourceNeedsSetup({ kind: 'iothub' })).toBe(true);
    expect(sourceNeedsSetup({ kind: 'iothub', iotHub: 'hub' })).toBe(false);
    expect(sourceNeedsSetup({ kind: 'kafka', topic: 't' })).toBe(false);
    expect(sourceNeedsSetup({ kind: 'eventhub', provisionedEndpoint: { entityPath: 'e' } })).toBe(false);
    expect(sourceNeedsSetup({ kind: 'mirror-cdf' })).toBe(true);
    expect(sourceNeedsSetup({ kind: 'mirror-cdf', mirrorItemId: 'm1' })).toBe(false);
  });
});
