/**
 * The data-agent editor's ADOPTION of the #4092 repair — the join nothing watched.
 *
 * WHY THIS FILE EXISTS. `data-agent-source-candidates.test.tsx` covers the pure
 * functions well. It does not cover their only CONSUMER, and an independent
 * review measured what that costs: with all 68 specs of #4096 green, you could
 *
 *   1. put the literal `'None found'` back as the Dropdown placeholder,
 *   2. delete the `<SourceCandidateError/>` element entirely, and
 *   3. make `SourceCandidateError` return `null` unconditionally,
 *
 * and every one of those specs stayed green. The whole user-visible half of the
 * PR could be reverted at the point of use with no test moving. The PR body
 * meanwhile asserted two properties — that the placeholder distinguishes
 * "None in this workspace" from "Couldn't load — retry", and that a failure
 * surfaces a RETRYABLE MessageBar — that nothing established.
 *
 * So these specs mount the REAL `DataAgentEditor`, drive the REAL hook through
 * a stubbed `clientFetch`, and read what the user reads. Each of the three
 * reverts above turns at least one of them red.
 *
 * The pre-existing `lib/editors/__tests__/data-agent.test.tsx` cannot serve this
 * purpose and is not relied on here: it wraps `render` in try/catch, swallows
 * the failure, and then asserts only that the swallowed message matches a broad
 * regex — a test that cannot fail.
 *
 * Runs in jsdom (`*.test.tsx` per vitest.config environmentMatchGlobs).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The editor's ONLY transport: `useItemState`, `useSourceCandidates` and the
// Genie/conversation effects all go through it. Routing it here means the
// picker is driven by a real hook over a real response, not by a stubbed hook.
vi.mock('@/lib/client-fetch', () => ({ clientFetch: vi.fn() }));

import { clientFetch } from '@/lib/client-fetch';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import { DataAgentEditor } from '../data-agent-editor';

const WS = 'ws-casino-analytics';
const ITEM: FabricItemType = {
  slug: 'data-agent',
  displayName: 'Data agent',
  restType: 'DataAgent',
  category: 'Data Science',
  description: 'Data agent test fixture',
};

/** The doc shape `GET /api/items/data-agent/[id]` emits — `workspaceId` included. */
const doc = (workspaceId: string) => ({
  id: 'agent-1', workspaceId, displayName: 'Casino Data Agent', description: '',
  state: { sources: [], instructions: '' }, updatedAt: null,
});

type ByTypeReply = { ok: boolean; status: number; body: unknown };
const REPLY_500: ByTypeReply = { ok: false, status: 500, body: { ok: false, error: 'cosmos unavailable' } };
const REPLY_EMPTY: ByTypeReply = { ok: true, status: 200, body: { ok: true, items: [] } };
const REPLY_ONE: ByTypeReply = { ok: true, status: 200, body: { ok: true, items: [{ id: '335e10ae', displayName: 'Casino Data Warehouse' }] } };

/** Every candidate lookup the editor makes for the picker's own item type. */
let byTypeCalls: string[] = [];

function stubTransport(reply: () => ByTypeReply, workspaceId = WS) {
  (clientFetch as any).mockImplementation(async (url: string) => {
    const u = String(url);
    // The picker's lookup. (The editor also lists sub-agents through the same
    // endpoint; that call asks for `data-agent,operations-agent` and is not
    // this surface — keyed out so it cannot stand in for the one under test.)
    if (u.includes('/api/items/by-type') && u.includes('types=warehouse')) {
      byTypeCalls.push(u);
      const r = reply();
      return { ok: r.ok, status: r.status, json: async () => r.body };
    }
    if (u.includes('/api/items/by-type')) return { ok: true, status: 200, json: async () => ({ ok: true, items: [] }) };
    if (u.includes('/api/items/data-agent/agent-1/')) return { ok: true, status: 200, json: async () => ({ ok: true, conversations: [] }) };
    if (u.includes('/api/items/data-agent/agent-1')) return { ok: true, status: 200, json: async () => doc(workspaceId) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
}

function mount(id = 'agent-1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><DataAgentEditor item={ITEM} id={id} /></QueryClientProvider>,
  );
}

/**
 * The Item dropdown, by the surface the user sees. Fluent v9 renders a
 * `role="combobox"` whose text content IS the placeholder while nothing is
 * selected — so this reads exactly what is on screen, not a prop.
 *
 * There are two comboboxes in the add-bar (Type, then Item); the Item one is
 * the one that is NOT the source-type list.
 */
async function itemPickerText(): Promise<string> {
  const main = await screen.findByTestId('main-panel', undefined, { timeout: 8000 });
  const boxes = Array.from(main.querySelectorAll('[role="combobox"]')) as HTMLElement[];
  const item = boxes.find((b) => (b.textContent || '') !== 'Warehouse');
  if (!item) throw new Error(`Item picker not found. comboboxes=${JSON.stringify(boxes.map((b) => b.textContent))}`);
  return item.textContent || '';
}

beforeEach(() => {
  vi.clearAllMocks();
  byTypeCalls = [];
});

describe('DataAgentEditor — the picker placeholder is the SHARED function, not a literal', () => {
  it('renders the FAILURE placeholder, not "None found" and not "None in this workspace"', async () => {
    stubTransport(() => REPLY_500);
    mount();
    await waitFor(async () => expect(await itemPickerText()).toBe("Couldn't load — retry"), { timeout: 8000 });
    // The two literals this editor must never print for a failed lookup: the
    // one #4092 replaced, and the one that replaced it too eagerly.
    const text = await itemPickerText();
    expect(text).not.toMatch(/None found/);
    expect(text).not.toBe('None in this workspace');
  });

  it('renders the DEFERRED placeholder on /new, where there is no workspace to query', async () => {
    // Reachable on every open, not only here: the editor renders the picker
    // beside its load Spinner with no early return. On /new it is permanent —
    // `useItemState` never fetches, so `workspaceId` stays ''.
    stubTransport(() => REPLY_EMPTY);
    mount('new');
    await screen.findByTestId('main-panel', undefined, { timeout: 8000 });
    await waitFor(async () => expect(await itemPickerText()).toBe('Waiting for the workspace…'), { timeout: 8000 });
    expect(byTypeCalls).toEqual([]); // nothing was asked …
    const text = await itemPickerText();
    expect(text).not.toBe('None in this workspace'); // … so nothing is claimed
    expect(text).not.toMatch(/None/);
  });

  it('renders the EMPTY placeholder only after a real query came back empty', async () => {
    stubTransport(() => REPLY_EMPTY);
    mount();
    await waitFor(() => expect(byTypeCalls.length).toBe(1), { timeout: 8000 });
    await waitFor(async () => expect(await itemPickerText()).toBe('None in this workspace'), { timeout: 8000 });
  });

  it('renders the SELECT placeholder once candidates exist', async () => {
    stubTransport(() => REPLY_ONE);
    mount();
    await waitFor(async () => expect(await itemPickerText()).toBe('Select…'), { timeout: 8000 });
    // …and the candidate the API returned is genuinely offered.
    const main = screen.getByTestId('main-panel');
    fireEvent.click(within(main).getAllByRole('combobox').find((b) => b.textContent === 'Select…')!);
    expect(await screen.findByRole('option', { name: 'Casino Data Warehouse' })).toBeInTheDocument();
  });
});

describe('DataAgentEditor — a failed lookup surfaces the RETRYABLE gate', () => {
  it('renders SourceCandidateError with the real reason, labelled for the picked type', async () => {
    stubTransport(() => REPLY_500);
    mount();
    // The MessageBar title carries `pickerCfg.label`, so this pins the label
    // wiring as well as the element's presence.
    expect(await screen.findByText("Couldn't list Warehouse items", undefined, { timeout: 8000 })).toBeInTheDocument();
    // The REAL reason, not a generic one — the R7 half of the repair.
    expect(screen.getByTestId('main-panel').textContent).toContain('cosmos unavailable');
  });

  it('its Retry button is wired to the hook and re-issues the lookup', async () => {
    stubTransport(() => REPLY_500);
    mount();
    const retry = await screen.findByRole('button', { name: /Retry/ }, { timeout: 8000 });
    await waitFor(() => expect(byTypeCalls.length).toBe(1));

    // Presence is not enough: `onRetry` must reach `candidates.reload`. Flip the
    // endpoint healthy, click, and require the surface to actually recover.
    (clientFetch as any).mockClear();
    let healthy = false;
    stubTransport(() => (healthy ? REPLY_ONE : REPLY_500));
    healthy = true;
    fireEvent.click(retry);

    await waitFor(() => expect(byTypeCalls.length).toBe(2), { timeout: 8000 });
    await waitFor(async () => expect(await itemPickerText()).toBe('Select…'), { timeout: 8000 });
    // The gate clears itself rather than accusing a healthy endpoint.
    expect(screen.queryByText("Couldn't list Warehouse items")).toBeNull();
  });

  it('shows NO failure gate when the lookup succeeds', async () => {
    // The discriminating negative: a gate rendered unconditionally would pass
    // every assertion above.
    stubTransport(() => REPLY_ONE);
    mount();
    await waitFor(async () => expect(await itemPickerText()).toBe('Select…'), { timeout: 8000 });
    expect(screen.queryByText("Couldn't list Warehouse items")).toBeNull();
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  });
});
