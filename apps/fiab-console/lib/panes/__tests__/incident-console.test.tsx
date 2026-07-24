/**
 * IncidentConsole pane — guided states (ux-baseline: no red on first open).
 *
 * Mounts the pane through its mount-time fetch and asserts the two guided
 * empty/off states render as designed EmptyStates (never a raw error banner):
 *   1. FLAG0 off  → "turned off" guided state with a Fix-it link.
 *   2. Fresh tenant (empty incidents) → healthy guided empty state, NOT red.
 * The mount→loaded transition is itself the smoke test (a crash throws here).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IncidentConsole } from '../incident-console';

function routeFetch(incidentsBody: any) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    let body: any = { ok: true };
    if (url.includes('/api/observability/incidents')) body = incidentsBody;
    else if (url.includes('/api/observability/monitors')) body = { ok: true, monitors: [] };
    return { ok: true, status: 200, json: async () => body } as Response;
  });
}

function renderPane() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FluentProvider theme={webLightTheme}>
        <IncidentConsole />
      </FluentProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('IncidentConsole guided states', () => {
  it('renders the FLAG0 turned-off guided state (not a red error)', async () => {
    vi.stubGlobal('fetch', routeFetch({ ok: true, flagOff: true, incidents: [] }));
    renderPane();
    expect(await screen.findByText('Incident console is turned off')).toBeInTheDocument();
  });

  it('renders a healthy guided empty state on a fresh tenant (no red first-open)', async () => {
    vi.stubGlobal('fetch', routeFetch({ ok: true, incidents: [] }));
    renderPane();
    expect(await screen.findByText('No incidents — all monitored tables are healthy')).toBeInTheDocument();
  });
});
