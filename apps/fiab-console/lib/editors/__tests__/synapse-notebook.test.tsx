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
import { SessionProvider } from '@/lib/components/session-context';

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
    render(<SynapseNotebookEditor item={makeItem('synapse-notebook', 'Synapse notebook')} id="nb-1" />);
    await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.getByTestId('left-panel')).toBeInTheDocument();
    expect(screen.getByTestId('main-panel')).toBeInTheDocument();
  });

  it('renders the Outline navigation panel', async () => {
    render(<SynapseNotebookEditor item={makeItem('synapse-notebook', 'Synapse notebook')} id="nb-1" />);
    await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
    // The Outline pane is part of the left panel; the empty-state hint renders
    // when there are no markdown headings yet.
    expect(screen.getByRole('navigation', { name: /outline/i })).toBeInTheDocument();
    expect(screen.getByText(/No headings yet/i)).toBeInTheDocument();
  });

  it('fetches the optional environment (Spark configuration) picker source', async () => {
    render(<SynapseNotebookEditor item={makeItem('synapse-notebook', 'Synapse notebook')} id="nb-1" />);
    await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
    await waitFor(() => {
      expect(log.calls.some((c) => c.url.includes('/api/synapse/environments'))).toBe(true);
    });
    // The Attach environment dropdown renders in the toolbar.
    expect(screen.getByLabelText(/Attach environment/i)).toBeInTheDocument();
  });

  it('surfaces the R4 wave-2 ribbon actions (undo/redo, session, import/export, snippets, shortcuts)', async () => {
    render(<SynapseNotebookEditor item={makeItem('synapse-notebook', 'Synapse notebook')} id="nb-1" />);
    await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
    // R4-SYN-12 undo/redo, R4-SYN-6 session config, R4-SYN-10 import/export,
    // R4-SYN-11 snippets, R4-SYN-7 shortcuts — all present as ribbon buttons.
    for (const label of ['Undo', 'Redo', 'Configure session', 'Import', 'Export', 'Snippets', 'Shortcuts']) {
      expect(screen.getByRole('button', { name: new RegExp(label, 'i') })).toBeInTheDocument();
    }
  });

  it('mounts a hidden .ipynb import input (R4-SYN-10)', async () => {
    const { container } = render(<SynapseNotebookEditor item={makeItem('synapse-notebook', 'Synapse notebook')} id="nb-1" />);
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

  it('#4619: /new renders the create-item gate, not the authoring surface, and makes no notebook write', async () => {
    // Breaks if the `/new` branch is removed: the authoring surface would
    // mount (Outline navigation and the "New notebook name" field present, no
    // "Create Synapse notebook" button), and its notebook list fetch would run.
    render(<SynapseNotebookEditor item={makeItem('synapse-notebook', 'Synapse notebook')} id="new" />);
    // The create gate renders its primary action (more than one control can
    // carry the label, so this counts them rather than picking one).
    expect((await screen.findAllByRole('button', { name: /Create Synapse notebook/ }, { timeout: 5000 })).length).toBeGreaterThan(0);
    // The authoring surface's own controls are absent (the create gate has a
    // chrome of its own, so `left-panel` does not discriminate).
    expect(screen.queryByRole('navigation', { name: /outline/i })).toBeNull();
    expect(screen.queryByLabelText('New notebook name')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create notebook' })).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(log.calls.filter((c) => c.url.includes('/api/synapse/notebooks'))).toEqual([]);
    expect(log.calls.some((c) => c.url.includes('itemId=new'))).toBe(false);
  });

  describe('#4619: the Create name field', () => {
    const ID = '3f2a9c1e-7b4d-4e8a-9f10-1234567890ab';
    const BOUND = boundNotebookName('Sales nb', ID)!;
    beforeEach(() => {
      log = installFetchMock({
        '/api/synapse/notebooks': () => ({ ok: true, notebooks: [] }),
        '/api/synapse/notebooks/': () => ({ ok: true, notebook: { name: BOUND, properties: { cells: [] } } }),
        '/api/items/synapse-spark-pool/list': () => ({ ok: true, pools: [] }),
        '/api/synapse/environments': () => ({ ok: true, environments: [] }),
        '/api/cosmos-items/synapse-notebook/': () => ({ id: ID, displayName: 'Sales nb', workspaceId: 'ws1' }),
      });
    });
    const mount = (isTenantAdmin: boolean) => render(
      <SessionProvider value={{ authenticated: true, user: null, isTenantAdmin, loading: false }}>
        <SynapseNotebookEditor item={makeItem('synapse-notebook', 'Synapse notebook')} id={ID} />
      </SessionProvider>,
    );
    async function typeAndCreate(name: string) {
      const input = await screen.findByLabelText('New notebook name', {}, { timeout: 5000 });
      fireEvent.change(input, { target: { value: name } });
      const create = screen.getByRole('button', { name: 'Create notebook' });
      await waitFor(() => expect(create).not.toBeDisabled());
      fireEvent.click(create);
      await waitFor(() => expect(log.calls.some((c) => c.init?.method === 'POST')).toBe(true));
      return { input: input as HTMLInputElement, body: JSON.parse(String(log.calls.find((c) => c.init?.method === 'POST')!.init!.body)) };
    }

    it('non-admin: the field shows the bound name read-only, and a typed name is not sent', async () => {
      // Breaks if the field accepts a free name for a non-admin: the POST would
      // carry "other_name" (the route then refuses it), and the field would
      // show what was typed instead of the bound name.
      mount(false);
      await waitFor(() => expect((screen.getByLabelText('New notebook name') as HTMLInputElement).value).toBe(BOUND), { timeout: 5000 });
      const { input, body } = await typeAndCreate('other_name');
      expect(input.readOnly).toBe(true);
      expect(body).toEqual({ name: BOUND, itemId: ID });
    });

    it('tenant admin: the field is editable and the typed name is sent (positive pair)', async () => {
      // Breaks if the field were read-only for admins too: the POST would carry
      // the bound name instead of "admin_nb".
      mount(true);
      const { input, body } = await typeAndCreate('admin_nb');
      expect(input.readOnly).toBe(false);
      expect(body).toEqual({ name: 'admin_nb', itemId: ID });
    });

    it('a name typed as admin is not sent once admin standing is gone', async () => {
      // The field's onChange guard alone keeps a non-admin's typed name empty,
      // so this is the one input that reaches the send-side check: a name typed
      // while admin, then the session re-resolves as non-admin. Breaks if
      // Create sent the typed name regardless of standing: the POST would
      // carry "admin_nb" instead of the bound name.
      const tree = (isTenantAdmin: boolean) => (
        <SessionProvider value={{ authenticated: true, user: null, isTenantAdmin, loading: false }}>
          <SynapseNotebookEditor item={makeItem('synapse-notebook', 'Synapse notebook')} id={ID} />
        </SessionProvider>
      );
      const { rerender } = render(tree(true));
      const input = await screen.findByLabelText('New notebook name', {}, { timeout: 5000 });
      fireEvent.change(input, { target: { value: 'admin_nb' } });
      expect((input as HTMLInputElement).value).toBe('admin_nb');
      rerender(tree(false));
      await waitFor(() => expect((screen.getByLabelText('New notebook name') as HTMLInputElement).value).toBe(BOUND));
      const create = screen.getByRole('button', { name: 'Create notebook' });
      await waitFor(() => expect(create).not.toBeDisabled());
      fireEvent.click(create);
      await waitFor(() => expect(log.calls.some((c) => c.init?.method === 'POST')).toBe(true));
      const body = JSON.parse(String(log.calls.find((c) => c.init?.method === 'POST')!.init!.body));
      expect(body).toEqual({ name: BOUND, itemId: ID });
    });

    it('non-admin: the locked field carries a caption saying why; an admin sees none (pair)', async () => {
      // Breaks if the caption is dropped (a non-admin sees a locked field with
      // no reason), or shown to an admin, whose field is editable.
      mount(false);
      await waitFor(() => expect((screen.getByLabelText('New notebook name') as HTMLInputElement).value).toBe(BOUND), { timeout: 5000 });
      expect(screen.getByTestId('notebook-name-locked').textContent).toMatch(/Only a tenant admin can choose another name/);
      expect(screen.queryByTestId('notebook-unbound-notice')).toBeNull();
      cleanup();
      mount(true);
      await screen.findByLabelText('New notebook name', {}, { timeout: 5000 });
      expect(screen.queryByTestId('notebook-name-locked')).toBeNull();
    });

    const mountAt = (isTenantAdmin: boolean, itemId: string) => render(
      <SessionProvider value={{ authenticated: true, user: null, isTenantAdmin, loading: false }}>
        <SynapseNotebookEditor item={makeItem('synapse-notebook', 'Synapse notebook')} id={itemId} />
      </SessionProvider>,
    );

    it.each([
      // An id with fewer than 16 alphanumerics carries no binding token.
      ['an older item whose id is too short', 'nb-1', () => ({ id: 'nb-1', displayName: 'Sales nb', workspaceId: 'ws1' }), /older item/],
      ['an item with no workspace', ID, () => ({ id: ID, displayName: 'Sales nb' }), /not recorded in a workspace/],
      ['an item lookup that fails', ID, () => { throw new Error('lookup down'); }, /could not be looked up/],
    ])('non-admin, %s: a guided notice explains the empty locked field and Create stays off', async (_l, itemId, lookup, reason) => {
      // Breaks if a non-admin with no bound name is left at an empty, locked
      // field and a disabled Create with nothing on screen saying why (the
      // notice is missing), or if the notice names the wrong cause.
      log = installFetchMock({
        '/api/synapse/notebooks': () => ({ ok: true, notebooks: [] }),
        '/api/items/synapse-spark-pool/list': () => ({ ok: true, pools: [] }),
        '/api/synapse/environments': () => ({ ok: true, environments: [] }),
        '/api/cosmos-items/synapse-notebook/': lookup,
      });
      mountAt(false, itemId);
      const notice = await screen.findByTestId('notebook-unbound-notice', {}, { timeout: 5000 });
      expect(notice.textContent).toMatch(reason);
      expect((screen.getByLabelText('New notebook name') as HTMLInputElement).value).toBe('');
      expect(screen.getByRole('button', { name: 'Create notebook' })).toBeDisabled();
      expect(screen.queryByTestId('notebook-name-locked')).toBeNull();
    });

    it('a tenant admin on an older short-id item gets no notice and can name the notebook (positive pair)', async () => {
      // Breaks if the notice keys on the missing name alone: an admin, who may
      // type any name, would be told they cannot create.
      log = installFetchMock({
        '/api/synapse/notebooks': () => ({ ok: true, notebooks: [] }),
        '/api/items/synapse-spark-pool/list': () => ({ ok: true, pools: [] }),
        '/api/synapse/environments': () => ({ ok: true, environments: [] }),
        '/api/cosmos-items/synapse-notebook/': () => ({ id: 'nb-1', displayName: 'Sales nb', workspaceId: 'ws1' }),
      });
      mountAt(true, 'nb-1');
      const input = await screen.findByLabelText('New notebook name', {}, { timeout: 5000 });
      await new Promise((r) => setTimeout(r, 30));
      expect(screen.queryByTestId('notebook-unbound-notice')).toBeNull();
      fireEvent.change(input, { target: { value: 'admin_nb' } });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Create notebook' })).not.toBeDisabled());
    });
  });
});
