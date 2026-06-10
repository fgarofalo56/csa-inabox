import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SemanticModelWorkspacePane } from '../semantic-model';

// SignInRequired is fine; the pane uses useQuery so it must mount inside a
// QueryClientProvider (mirrors app/providers.tsx), with retries off so a failed
// mock query does not refetch in the background after assertions.
function renderPane() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <FluentProvider theme={webLightTheme}>
        <SemanticModelWorkspacePane />
      </FluentProvider>
    </QueryClientProvider>,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('SemanticModelWorkspacePane', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders an honest config gate when AAS is unconfigured', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({
      ok: true, serverName: '', region: '', aasDatabases: [],
      loomModels: [{ id: 'loom:m1', name: 'Sales model', tableCount: 3 }],
      deploy: { backend: 'unavailable', available: false, hint: 'Set LOOM_AAS_XMLA_ENDPOINT to deploy.' },
      gate: { kind: 'config', missing: 'LOOM_AAS_SERVER_NAME', detail: 'the Azure Analysis Services server name' },
    }));
    renderPane();
    await waitFor(() => expect(screen.getByText('Azure Analysis Services not configured')).toBeInTheDocument());
    // Loom-native list still renders behind the gate.
    expect(screen.getByText('Sales model')).toBeInTheDocument();
    // No fabricated database tiles — the deploy card is hidden behind the gate.
    expect(screen.queryByLabelText('Target tabular database')).not.toBeInTheDocument();
  });

  it('renders the database picker from the real fetch (no hard-coded tables)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({
      ok: true, serverName: 'aas-loom', region: 'eastus2',
      aasDatabases: [
        { name: 'AdventureWorks', storageMode: 'InMemory', state: 'Succeeded', compatibilityLevel: 1567 },
        { name: 'Finance', storageMode: 'DirectQuery', state: 'Succeeded' },
      ],
      loomModels: [{ id: 'loom:m1', name: 'Sales model', tableCount: 3 }],
      deploy: { backend: 'aas-xmla', available: true },
    }));
    renderPane();
    // Database names come from the fetch, not a constant. They appear both as a
    // tile and as a <option> in the target-database Select, so use getAllByText.
    await waitFor(() => expect(screen.getAllByText('AdventureWorks').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Finance').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Target tabular database')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /deploy/i })).toBeInTheDocument();
  });

  it('posts a real deploy request and surfaces the backend success', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') {
        return jsonResponse({ ok: true, backend: 'aas-xmla', database: 'AdventureWorks', tmslApplied: true });
      }
      return jsonResponse({
        ok: true, serverName: 'aas-loom', region: 'eastus2',
        aasDatabases: [{ name: 'AdventureWorks', storageMode: 'InMemory', state: 'Succeeded' }],
        loomModels: [{ id: 'loom:m1', name: 'Sales model', tableCount: 3 }],
        deploy: { backend: 'aas-xmla', available: true },
      });
    });
    renderPane();
    await waitFor(() => expect(screen.getByRole('button', { name: /^deploy$/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^deploy$/i }));
    await waitFor(() => expect(screen.getByText('Model deployed')).toBeInTheDocument());
    // The POST hit the workspace-pane route with the deploy action.
    const postCall = fetchSpy.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'POST');
    expect(postCall?.[0]).toBe('/api/items/semantic-model/workspace-pane');
    expect(String((postCall?.[1] as RequestInit)?.body)).toContain('"action":"deploy"');
    expect(String((postCall?.[1] as RequestInit)?.body)).toContain('"modelId":"loom:m1"');
  });

  it('hides the deploy controls in GCC-High / DoD (AAS not available)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({
      ok: true, serverName: '', region: '', aasDatabases: [],
      loomModels: [{ id: 'loom:m1', name: 'Sales model', tableCount: 3 }],
      deploy: { backend: 'unavailable', available: false, hint: '' },
      gate: { kind: 'unavailable', missing: 'AAS_NOT_IN_GOV', detail: 'Azure Analysis Services is not available in Azure Government (GCC-High / DoD).' },
    }));
    renderPane();
    await waitFor(() => expect(screen.getByText('Tabular deploy not available in this cloud')).toBeInTheDocument());
    // Deploy button must be ABSENT (not a disabled control with a false tooltip).
    expect(screen.queryByRole('button', { name: /deploy/i })).not.toBeInTheDocument();
    // Loom-native models still render.
    expect(screen.getByText('Sales model')).toBeInTheDocument();
  });
});
