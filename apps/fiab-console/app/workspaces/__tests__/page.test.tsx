/**
 * /workspaces — vitest jsdom render tests for the primitive-based redesign.
 *
 * The page was rebuilt on the shared Loom UI primitives (Section/Toolbar,
 * ViewToggle, TileGrid+ItemTile, LoomDataTable). These specs mount the real
 * page (no mocked render) inside a QueryClientProvider + FluentProvider —
 * exactly like app/providers.tsx — with the data layer (@/lib/api/workspaces)
 * stubbed to deterministic fixtures, and assert:
 *   - both views render the workspace rows,
 *   - the Tile | List ViewToggle switches between TileGrid and LoomDataTable,
 *   - a pinned workspace floats into its own "Pinned" Section above "All
 *     workspaces",
 *   - the admin multi-select affordance ("Select") appears only for admins.
 *
 * Per .claude/rules/no-vaporware.md, the data functions are stubbed (this is a
 * client-only UI swap) but the component tree mounts for real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const WS_FIXTURES = [
  {
    id: 'ws-a',
    name: 'Alpha workspace',
    description: 'First workspace',
    itemCount: 3,
    capacity: 'F64',
    domain: 'Sales',
    createdAt: '2026-01-02T00:00:00Z',
    lastAccessedAt: '2026-06-01T00:00:00Z',
    createdBy: 'a@example.com',
  },
  {
    id: 'ws-b',
    name: 'Beta workspace',
    description: 'Second workspace',
    itemCount: 0,
    createdAt: '2026-02-02T00:00:00Z',
    createdBy: 'b@example.com',
  },
];

let adminStatus = { isAdmin: false, canBulkDelete: false };

vi.mock('@/lib/api/workspaces', () => ({
  listWorkspacesWithCounts: vi.fn(async () => WS_FIXTURES),
  getWorkspaceAdminStatus: vi.fn(async () => adminStatus),
  createWorkspace: vi.fn(),
  bulkDeleteWorkspaces: vi.fn(),
}));

// Imported AFTER the mock so the page picks up the stubbed data layer.
import WorkspacesPage from '../page';

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <FluentProvider theme={webLightTheme}>
        <WorkspacesPage />
      </FluentProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  adminStatus = { isAdmin: false, canBulkDelete: false };
  window.localStorage.clear();
  // /api/auth/me + any other fetch → empty ok JSON.
  vi.spyOn(global, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as any,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('WorkspacesPage redesign', () => {
  it('renders both workspaces in the default tile view', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Alpha workspace')).toBeInTheDocument(), {
      timeout: 5000,
    });
    expect(screen.getByText('Beta workspace')).toBeInTheDocument();
  });

  it('switches to the LoomDataTable list view via the ViewToggle', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Alpha workspace')).toBeInTheDocument(), {
      timeout: 5000,
    });
    fireEvent.click(screen.getByRole('button', { name: /list view/i }));
    // Column headers are unique to the LoomDataTable list view. "Last accessed"
    // is a date column, so it appears as both a header cell AND a date-filter
    // label — assert at least one. "Description" is a free-text column whose
    // filter uses a placeholder (attribute, not text), so it stays unique.
    await waitFor(() => expect(screen.getAllByText('Last accessed').length).toBeGreaterThan(0));
    expect(screen.getByText('Description')).toBeInTheDocument();
    expect(screen.getByText('Alpha workspace')).toBeInTheDocument();
  });

  it('floats a pinned workspace into its own Pinned section', async () => {
    window.localStorage.setItem('loom.workspaces.pinned.v1', JSON.stringify(['ws-a']));
    renderPage();
    // "Pinned" renders as both the Section title and the pinned tile's badge;
    // "All workspaces" is the unique heading proving the pinned/all split.
    await waitFor(() => expect(screen.getByText('All workspaces')).toBeInTheDocument(), {
      timeout: 5000,
    });
    expect(screen.getAllByText('Pinned').length).toBeGreaterThan(0);
  });

  it('hides the admin multi-select control for non-admins', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Alpha workspace')).toBeInTheDocument(), {
      timeout: 5000,
    });
    expect(screen.queryByRole('button', { name: 'Select' })).toBeNull();
  });

  it('shows the admin multi-select control for tenant admins', async () => {
    adminStatus = { isAdmin: true, canBulkDelete: true };
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select' })).toBeInTheDocument(), {
      timeout: 5000,
    });
  });
});
