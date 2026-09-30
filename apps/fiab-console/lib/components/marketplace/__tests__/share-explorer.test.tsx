/**
 * ShareExplorerPanel (UX-706) — render smoke after the UX-baseline lift.
 *
 * Mounts the panel against a mocked catalog-browse (returns no schemas) so the
 * query pane settles into its empty state, then asserts the new guided launcher
 * ("Explore this share" with real-action cards) and the TeachingBanner render.
 *
 * clientFetch + the Monaco editor are mocked at the module boundary so no
 * network / worker is touched and the subtree settles deterministically.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

vi.mock('@/lib/client-fetch', () => ({
  clientFetch: vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ ok: true, nodes: [] }),
  })),
}));

vi.mock('@/lib/components/editor/monaco-textarea', () => ({
  MonacoTextarea: () => <textarea aria-label="SQL query editor" />,
}));

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

async function renderPanel() {
  const { ShareExplorerPanel } = await import('../share-explorer');
  return render(
    <FluentProvider theme={webLightTheme}>
      <ShareExplorerPanel catalog="shared_gold" host="adb-123.azuredatabricks.net" />
    </FluentProvider>,
  );
}

describe('ShareExplorerPanel — UX-baseline lift (UX-706)', () => {
  it('renders the teaching banner and the guided empty-state launcher', async () => {
    await renderPanel();
    expect(await screen.findByText('Explore this share')).toBeInTheDocument();
    // Guided launcher real-action cards from the lift.
    expect(screen.getByText('List schemas')).toBeInTheDocument();
    expect(screen.getByText('Sample a table')).toBeInTheDocument();
  });
});

/**
 * #4776 — the query route's gate renders through the registry HonestGate
 * (cause + remediation + Fix-it), not a bare MessageBar. Breaks if the panel
 * stops routing the body through surfaceGateFrom → HonestGate: the gate title
 * and the Fix-it button are both absent.
 */
describe('ShareExplorerPanel — query gate is the HonestGate (#4776)', () => {
  async function runListSchemasAgainst(body: unknown) {
    const { clientFetch } = await import('@/lib/client-fetch');
    (clientFetch as any).mockImplementation(async (url: string) => ({
      ok: true, status: 200,
      json: async () => (url === '/api/marketplace/sharing/query' ? body : { ok: true, nodes: [] }),
    }));
    await renderPanel();
    fireEvent.click(await screen.findByText('List schemas'));
  }

  it('a classified permission failure → the gate with its cause, remediation and a Fix-it', async () => {
    await runListSchemasAgainst({
      ok: false, gate: true, code: 'warehouse_permission', gateId: 'svc-databricks-sql', kind: 'permission',
      error: 'Databricks refused the Console identity\'s list call (HTTP 403).',
      remediation: 'A workspace admin grants the databricks-sql-access entitlement.', entitlement: 'databricks-sql-access',
    });
    expect(await screen.findByText(/Share explorer: .* — permission refused/)).toBeInTheDocument();
    expect(screen.getByText('A workspace admin grants the databricks-sql-access entitlement.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fix it/i })).toBeInTheDocument();
  });

  it('no workspace bound (the route\'s not_configured body) → the svc-databricks gate naming the var', async () => {
    await runListSchemasAgainst({
      ok: false, gate: true, code: 'not_configured', missing: 'LOOM_DATABRICKS_HOSTNAME',
      error: 'Databricks workspace not configured. Set LOOM_DATABRICKS_HOSTNAME on the Loom Console.',
    });
    expect(await screen.findByText(/Share explorer needs Azure Databricks/)).toBeInTheDocument();
    expect(screen.getByText('LOOM_DATABRICKS_HOSTNAME')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fix it/i })).toBeInTheDocument();
  });
});
