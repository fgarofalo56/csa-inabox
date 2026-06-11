/**
 * McpServersPanel — Rules-of-Hooks regression (React #310).
 *
 * Background: McpServersPanel previously called a `useMemo` (filteredServers)
 * AFTER an `if (loading) return <Spinner/>` early return. On the very first
 * render `loading` is true so only 10 hooks ran and the useMemo was skipped;
 * once `/api/admin/mcp-servers` resolved, `loading` flipped to false and the
 * useMemo ran, taking the hook count 10 -> 11. React threw minified error #310
 * ("Rendered more hooks than during the previous render"), crashing
 * /admin/tenant-settings (this panel is always rendered by CopilotAgentsConfig).
 *
 * The fix hoists the useMemo above the early return so all hooks run
 * unconditionally on every render. The render that exercises the bug is the
 * loading->loaded transition driven by the fetch resolving; therefore mounting
 * the component and awaiting that transition (via findBy*) IS the #310
 * assertion — a hooks-order regression makes React throw during the update and
 * fails the test. We assert both the EMPTY and POPULATED loaded states because
 * the bug fires on the transition regardless of the server list contents.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { McpServersPanel } from '../mcp-servers-panel';

// Route the component's mount-time fetches by URL. McpServersPanel itself plus
// its always-rendered children (BuiltinMcpCard, BridgeMcpCard, McpCatalogPanel)
// each fetch on mount; this stub answers every one with a structured
// {ok:...} body so the subtree settles deterministically.
function routeFetch(serversBody: any) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    let body: any = { ok: true };
    if (url.includes('/api/admin/mcp-servers/builtin')) {
      body = { ok: false }; // BuiltinMcpCard renders null when not configured
    } else if (url.includes('/api/admin/mcp-servers/bridge')) {
      body = { ok: false }; // BridgeMcpCard renders null when not configured
    } else if (url.includes('/api/admin/mcp-catalog')) {
      body = { ok: true, catalog: [], deployed: [] };
    } else if (url.includes('/api/admin/mcp-servers')) {
      body = serversBody; // the panel's own server list
    }
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as Response;
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPanel() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <McpServersPanel />
    </FluentProvider>,
  );
}

describe('McpServersPanel — Rules-of-Hooks (React #310 regression)', () => {
  it('mounts through the loading->loaded transition with an EMPTY server list', async () => {
    vi.stubGlobal('fetch', routeFetch({ ok: true, servers: [] }));
    renderPanel();
    // Awaiting the empty-state text forces the post-fetch render where the
    // extra hook used to fire. If hooks order regressed, React throws here.
    expect(await screen.findByText('No MCP servers registered yet')).toBeInTheDocument();
  });

  it('mounts through the loading->loaded transition with a POPULATED server list', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        ok: true,
        servers: [
          {
            serverId: 'srv-1',
            name: 'Acme Tools',
            endpoint: 'https://acme.example.com/mcp',
            enabled: true,
            description: 'Acme MCP server',
          },
        ],
      }),
    );
    renderPanel();
    // The registered-servers table row only renders after the loaded transition
    // and through the previously-buggy useMemo (filteredServers.map).
    expect(await screen.findByText('Acme Tools')).toBeInTheDocument();
    expect(screen.getByText('Registered servers')).toBeInTheDocument();
  });
});
