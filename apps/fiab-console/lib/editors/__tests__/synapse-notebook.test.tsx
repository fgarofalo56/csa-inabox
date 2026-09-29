/**
 * SynapseNotebookEditor — F15 authoring-surface contract test.
 *
 * Mounts the editor with a mocked Synapse workspace (notebooks list, Spark
 * pools, environments) and asserts the full authoring chrome renders: the
 * editor chrome, the left panel with the Outline navigation, the main pane,
 * and that the optional environment (Spark configuration) picker is fetched.
 *
 * Per .claude/rules/no-vaporware.md grading rubric this brings the F15
 * authoring surface to A-grade (functional + Vitest). Cell execution is out of
 * scope (T17) — these tests cover the authoring surface only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

// U3 — CodeCell reads the 'u3-notebook-cell-resize' runtime flag through a
// react-query hook; mock it so this editor mounts without a QueryClientProvider
// and the fetch log sees ONLY the Synapse routes under test.
vi.mock('@/lib/components/ui/use-runtime-flag', () => ({ useRuntimeFlag: () => true }));

import { SynapseNotebookEditor } from '../synapse-notebook-editor';
import { makeItem, installFetchMock } from './test-helpers';
import { boundNotebookName } from '@/lib/notebook/synapse-notebook-binding';

describe('SynapseNotebookEditor (F15 authoring)', () => {
  let log: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    log = installFetchMock({
      '/api/synapse/notebooks': () => ({ ok: true, notebooks: [{ name: 'test_nb', pool: 'pool1' }] }),
      '/api/items/synapse-spark-pool/list': () => ({ ok: true, pools: [{ name: 'pool1', properties: { nodeSize: 'Small' } }] }),
      '/api/synapse/environments': () => ({ ok: true, environments: [{ name: 'env1', sparkVersion: '3.3' }] }),
    });
  });
  // globals:false in vitest.config — register an explicit cleanup so the
  // first render unmounts before the next test (else getByTestId sees two).
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('mounts the authoring chrome (ribbon + left panel + main pane)', async () => {
    render(<SynapseNotebookEditor item={makeItem('synapse-notebook', 'Synapse notebook')} id="new" />);
    await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.getByTestId('left-panel')).toBeInTheDocument();
    expect(screen.getByTestId('main-panel')).toBeInTheDocument();
  });

  it('renders the Outline navigation panel', async () => {
    render(<SynapseNotebookEditor item={makeItem('synapse-notebook', 'Synapse notebook')} id="new" />);
    await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
    // The Outline pane is part of the left panel; the empty-state hint renders
    // when there are no markdown headings yet.
    expect(screen.getByRole('navigation', { name: /outline/i })).toBeInTheDocument();
    expect(screen.getByText(/No headings yet/i)).toBeInTheDocument();
  });

  it('fetches the optional environment (Spark configuration) picker source', async () => {
    render(<SynapseNotebookEditor item={makeItem('synapse-notebook', 'Synapse notebook')} id="new" />);
    await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
    await waitFor(() => {
      expect(log.calls.some((c) => c.url.includes('/api/synapse/environments'))).toBe(true);
    });
    // The Attach environment dropdown renders in the toolbar.
    expect(screen.getByLabelText(/Attach environment/i)).toBeInTheDocument();
  });

  it('surfaces the R4 wave-2 ribbon actions (undo/redo, session, import/export, snippets, shortcuts)', async () => {
    render(<SynapseNotebookEditor item={makeItem('synapse-notebook', 'Synapse notebook')} id="new" />);
    await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
    // R4-SYN-12 undo/redo, R4-SYN-6 session config, R4-SYN-10 import/export,
    // R4-SYN-11 snippets, R4-SYN-7 shortcuts — all present as ribbon buttons.
    for (const label of ['Undo', 'Redo', 'Configure session', 'Import', 'Export', 'Snippets', 'Shortcuts']) {
      expect(screen.getByRole('button', { name: new RegExp(label, 'i') })).toBeInTheDocument();
    }
  });

  it('mounts a hidden .ipynb import input (R4-SYN-10)', async () => {
    const { container } = render(<SynapseNotebookEditor item={makeItem('synapse-notebook', 'Synapse notebook')} id="new" />);
    await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input!.getAttribute('accept')).toContain('.ipynb');
  });

  it('#4619: an empty Create publishes the item-bound name WITH the item id, and Save and Delete send ?itemId=', async () => {
    // The write routes accept a non-admin only for a name bound to the item
    // they name. Breaks if: Create stays disabled with an empty input (no POST
    // is ever made), Create omits `itemId` or sends a name other than the bound
    // one, or Save drops `?itemId=` from the PUT URL.
    const ID = '3f2a9c1e-7b4d-4e8a-9f10-1234567890ab';
    const BOUND = boundNotebookName('Sales nb', ID)!;
    log = installFetchMock({
      '/api/synapse/notebooks': () => ({ ok: true, notebooks: [] }),
      '/api/synapse/notebooks/': () => ({ ok: true, notebook: { name: BOUND, properties: { cells: [] } } }),
      '/api/items/synapse-spark-pool/list': () => ({ ok: true, pools: [] }),
      '/api/synapse/environments': () => ({ ok: true, environments: [] }),
      '/api/cosmos-items/synapse-notebook/': () => ({ id: ID, displayName: 'Sales nb', workspaceId: 'ws1' }),
      '/api/items/synapse-notebook/': () => ({ ok: true, notebook: { properties: { cells: [] } } }),
    });
    render(<SynapseNotebookEditor item={makeItem('synapse-notebook', 'Synapse notebook')} id={ID} />);
    const create = await screen.findByRole('button', { name: 'Create notebook' }, { timeout: 5000 });
    await waitFor(() => expect(create).not.toBeDisabled());
    fireEvent.click(create);
    await waitFor(() => expect(log.calls.some((c) => c.init?.method === 'POST')).toBe(true));
    const postCall = log.calls.find((c) => c.init?.method === 'POST')!;
    expect(postCall.url).toBe('/api/synapse/notebooks');
    expect(JSON.parse(String(postCall.init!.body))).toEqual({ name: BOUND, itemId: ID });

    const saveBtn = await waitFor(() => {
      const b = screen.getAllByRole('button', { name: 'Save' }).find((el) => !(el as HTMLButtonElement).disabled);
      expect(b).toBeTruthy();
      return b!;
    });
    fireEvent.click(saveBtn);
    await waitFor(() => expect(log.calls.some((c) => c.init?.method === 'PUT')).toBe(true));
    const putCall = log.calls.find((c) => c.init?.method === 'PUT')!;
    expect(putCall.url).toBe(`/api/synapse/notebooks/${BOUND}?itemId=${encodeURIComponent(ID)}`);

    // Delete of the open notebook carries the item id too. Breaks if Delete
    // drops `?itemId=` from the DELETE URL (the route then answers a
    // non-admin with admin_only).
    const deleteBtn = screen.getAllByRole('button', { name: 'Delete' }).find((el) => !(el as HTMLButtonElement).disabled);
    expect(deleteBtn).toBeTruthy();
    fireEvent.click(deleteBtn!);
    await waitFor(() => expect(log.calls.some((c) => c.init?.method === 'DELETE')).toBe(true));
    const delCall = log.calls.find((c) => c.init?.method === 'DELETE')!;
    expect(delCall.url).toBe(`/api/synapse/notebooks/${BOUND}?itemId=${encodeURIComponent(ID)}`);
  });
});
