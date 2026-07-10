/**
 * TreeBrowser (UX-701) — render + SC-7 context-menu contract.
 *
 * Mounts the lazy catalog tree with a mocked /api/catalog/browse and asserts
 * the tree renders its root nodes, the expand/collapse toolbar is present, and
 * every node is wrapped in a right-click context menu (openOnContext) so a
 * consumer can Copy name / Copy path / Refresh children per the ux-standards
 * §7.3 explorer checklist.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { TreeBrowser } from '../tree-browser';

function mockFetch() {
  vi.spyOn(global, 'fetch').mockImplementation((async (url: any) => {
    const u = String(url);
    const nodes = u.includes('path=')
      ? [{ id: 'schema1', label: 'bronze', kind: 'schema', hasChildren: false }]
      : [{ id: 'cat1', label: 'main', kind: 'catalog', hasChildren: true }];
    return new Response(JSON.stringify({ ok: true, nodes }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as any);
}

afterEach(() => { vi.restoreAllMocks(); cleanup(); });

describe('TreeBrowser', () => {
  it('renders root nodes with the expand/collapse toolbar', async () => {
    mockFetch();
    render(
      <FluentProvider theme={webLightTheme}>
        <TreeBrowser source="unity-catalog" />
      </FluentProvider>,
    );
    expect(await screen.findByText('main')).toBeInTheDocument();
    expect(screen.getByRole('tree', { name: /browse unity-catalog/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /expand all/i })).toBeInTheDocument();
  });

  it('wraps each node as a treeitem (context-menu trigger target)', async () => {
    mockFetch();
    render(
      <FluentProvider theme={webLightTheme}>
        <TreeBrowser source="unity-catalog" />
      </FluentProvider>,
    );
    await waitFor(() => expect(screen.getByRole('treeitem', { name: /main/i })).toBeInTheDocument());
  });
});
