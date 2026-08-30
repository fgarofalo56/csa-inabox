/**
 * #4102 — a source type with `itemType: ''` could never be added, and the
 * picker's reason for offering nothing was not true.
 *
 * WHAT WAS MEASURED on the pre-fix editor. `DA_SOURCE_TYPES` declares TWO kinds
 * with `itemType: ''` — `microsoft-graph` and `metric-view` — but the editor's
 * "this kind has no item picker" branch was the literal
 *
 *     pickerType === 'microsoft-graph' ? <Scope caption/> : <Item dropdown/>
 *
 * so `metric-view` rendered an Item dropdown. `useSourceCandidates` short-
 * circuits on an empty `itemType`, so that dropdown could never populate, and
 * with a real workspace loaded `deferred` was false — leaving the placeholder to
 * fall through to **"None in this workspace"**: a positive claim about the
 * workspace's contents, made having queried nothing (deploy-integrity.md R7,
 * the same defect #4096 fixed one door down).
 *
 * And the Add button was gated
 *
 *     disabled={(pickerType !== 'microsoft-graph' && !pickSel) || …}
 *
 * — for `metric-view` the first conjunct is permanently true and `pickSel` can
 * never be set, so **the button was disabled forever**. `addSource` carried a
 * working `metric-view` branch that nothing could reach.
 *
 * These specs mount the REAL editor and read what the user reads. Both fail
 * against the pre-fix editor; the counterfactual at the bottom re-introduces the
 * name-keyed branch and requires the failure back.
 *
 * Runs in jsdom (`*.test.tsx` per vitest.config environmentMatchGlobs).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/client-fetch', () => ({ clientFetch: vi.fn() }));

import { clientFetch } from '@/lib/client-fetch';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import { DataAgentEditor } from '../data-agent-editor';
import { sourceTypeBindsLoomItem } from '../data-agent-source-candidates';

const WS = 'ws-casino-analytics';
const ITEM: FabricItemType = {
  slug: 'data-agent',
  displayName: 'Data agent',
  restType: 'DataAgent',
  category: 'Data Science',
  description: 'Data agent test fixture',
};

/** The doc shape `GET /api/items/data-agent/[id]` emits — `workspaceId` included. */
const doc = () => ({
  id: 'agent-1', workspaceId: WS, displayName: 'Casino Data Agent', description: '',
  state: { sources: [], instructions: '' }, updatedAt: null,
});

/** Every `/api/items/by-type` URL the editor asked for. */
let byTypeCalls: string[] = [];

function stubTransport() {
  (clientFetch as any).mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes('/api/items/by-type')) {
      byTypeCalls.push(u);
      // A NON-EMPTY answer on purpose. If the editor ever did query for an
      // unbound kind, this would populate its dropdown and the "no item to pick"
      // assertions would pass for the wrong reason.
      return { ok: true, status: 200, json: async () => ({ ok: true, items: [{ id: 'w-1', displayName: 'Casino Data Warehouse' }] }) };
    }
    if (u.includes('/api/items/data-agent/agent-1/')) return { ok: true, status: 200, json: async () => ({ ok: true, conversations: [] }) };
    if (u.includes('/api/items/data-agent/agent-1')) return { ok: true, status: 200, json: async () => doc() };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><DataAgentEditor item={ITEM} id="agent-1" /></QueryClientProvider>,
  );
}

/** Switch the add-bar's Type dropdown to `label`. */
async function pickType(label: string) {
  const main = await screen.findByTestId('main-panel', undefined, { timeout: 8000 });
  const typeBox = within(main).getAllByRole('combobox').find((b) => b.textContent === 'Warehouse');
  expect(typeBox, 'the source-Type dropdown should start on Warehouse').toBeTruthy();
  fireEvent.click(typeBox!);
  fireEvent.click(await screen.findByRole('option', { name: label }));
}

const addButton = () => screen.getByRole('button', { name: /Add source/ });

beforeEach(() => {
  vi.clearAllMocks();
  byTypeCalls = [];
});

describe('DataAgentEditor — a source kind with itemType:"" (#4102)', () => {
  it('renders NO Item dropdown for metric-view, and never claims the workspace is empty', async () => {
    stubTransport();
    mount();
    await pickType('Metric view');

    const main = screen.getByTestId('main-panel');
    // The R7 half. The forbidden sentence is a claim about the workspace's
    // contents; nothing here ever asked about them.
    await waitFor(() => {
      expect(main.textContent || '').not.toMatch(/None in this workspace/);
    }, { timeout: 8000 });
    expect(main.textContent || '').not.toMatch(/None found/);
    // …and it must not print the DEFERRED sentence either: this wait never ends.
    expect(main.textContent || '').not.toMatch(/Waiting for the workspace/);

    // The picker offers the honest alternative instead: what IS configured.
    expect(main.textContent).toContain('Governed view name');

    // Structural: the only combobox left in the add-bar is the Type one. An Item
    // dropdown that merely showed better copy would still be a control that can
    // never do anything.
    const boxes = within(main).getAllByRole('combobox');
    expect(boxes.filter((b) => (b.textContent || '').startsWith('No item to pick'))).toHaveLength(0);
    expect(boxes.some((b) => b.textContent === 'Metric view')).toBe(true);

    // Nothing was queried for a kind with no item type to query.
    expect(byTypeCalls.filter((u) => u.includes('types=metric-view'))).toEqual([]);
  });

  it('lets metric-view actually be ADDED — the button was disabled forever', async () => {
    stubTransport();
    mount();
    await pickType('Metric view');

    await waitFor(() => expect(addButton()).not.toBeDisabled(), { timeout: 8000 });
    fireEvent.click(addButton());

    // A source really landed in state — the Build tab counts them.
    expect(await screen.findByText(/Build \(1\/5 sources\)/, undefined, { timeout: 8000 })).toBeInTheDocument();
    // …and it is the METRIC-VIEW card, not just any card: that field label is
    // rendered only by the `src.type === 'metric-view'` arm of the source list.
    expect(await screen.findByText('Governed metric view', undefined, { timeout: 8000 })).toBeInTheDocument();
  });

  it('still requires a selection for a kind that DOES bind a Loom item', async () => {
    // The discriminating negative. If the Add button were simply un-gated, this
    // would let a warehouse source be added with no item chosen.
    stubTransport();
    mount();
    await screen.findByTestId('main-panel', undefined, { timeout: 8000 });
    await waitFor(() => expect(byTypeCalls.some((u) => u.includes('types=warehouse'))).toBe(true), { timeout: 8000 });
    expect(addButton()).toBeDisabled();
  });

  it('still shows the Microsoft 365 scope caption — the kind that always worked', async () => {
    // Regression guard on the branch that was correct before the change.
    stubTransport();
    mount();
    await pickType('Microsoft 365 (Graph)');
    const main = screen.getByTestId('main-panel');
    await waitFor(() => expect(main.textContent).toContain('SharePoint site / OneDrive drive / mailbox'), { timeout: 8000 });
    await waitFor(() => expect(addButton()).not.toBeDisabled(), { timeout: 8000 });
  });
});

describe('the rule is the SHAPE, so the next itemType:"" kind is covered too', () => {
  it('sourceTypeBindsLoomItem is what both branches consult', () => {
    // Keyed on the declaration, a new unbound kind needs no edit to the picker.
    // This is the property the name-keyed branch did not have.
    expect(sourceTypeBindsLoomItem('')).toBe(false);
    expect(sourceTypeBindsLoomItem('metric-view-item')).toBe(true);
  });
});
