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
import { render, screen, cleanup } from '@testing-library/react';
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
