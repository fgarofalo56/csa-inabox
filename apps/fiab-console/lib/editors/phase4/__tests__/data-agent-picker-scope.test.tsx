/**
 * #4092 — THE JOIN between the two halves of the defect, exercised with the
 * REAL hook against the REAL route handler.
 *
 * `picker-workspace-scope.test.ts` pins that the data-agent GET puts
 * `workspaceId` on the wire. That is only half a proof: it says nothing about
 * WHICH field the editor reads, and the bug lived exactly in that join. If
 * `useItemState` had read (say) `doc.parentWorkspaceId`, the route test would
 * be green and the picker would still render "None found".
 *
 * So this file wires the two together — no re-implementation of either side:
 *
 *   the REAL `useItemState` from lib/editors/phase4/shared.tsx
 *      → its own `clientFetch(/api/items/data-agent/<id>)`, stubbed to return
 *        whatever the REAL route handler produced for a mocked Cosmos item
 *      → assert the hook exposes a TRUTHY `workspaceId`.
 *
 * Truthiness is the assertion that matters, not equality: the editor's gate is
 * `if (workspaceId && !available[pickerType]) loadAvailable(pickerType)`, so
 * `''`/`undefined` is what silences the candidate fetch and produces the dead
 * end. The second spec states that consequence directly by running the real
 * guard expression over the hook's real output.
 *
 * Runs in jsdom (`*.test.tsx` per vitest.config environmentMatchGlobs).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  createOwnedItem: vi.fn(), listOwnedItems: vi.fn(), loadOwnedItem: vi.fn(),
  updateOwnedItem: vi.fn(), deleteOwnedItem: vi.fn(),
  jerr: (error: string, status = 500) => ({ status, json: async () => ({ ok: false, error }) }) as any,
}));
vi.mock('@/lib/azure/data-agent-autobind', () => ({ autoBindDataAgentSources: vi.fn(async () => null) }));
vi.mock('@/lib/azure/foundry-agent-client', () => ({ deleteAgent: vi.fn() }));
vi.mock('@/lib/azure/copilot-studio-client', () => ({ deleteAgent: vi.fn() }));

// The hook's transport. Routed into the REAL route handler below, so the body
// the hook parses is the body the route actually emits.
vi.mock('@/lib/client-fetch', () => ({ clientFetch: vi.fn() }));

import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { clientFetch } from '@/lib/client-fetch';
import { GET as DA_GET } from '@/app/api/items/data-agent/[id]/route';
import { useItemState } from '@/lib/editors/phase4/shared';

const WS = 'ws-casino-analytics';

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'tenant-1', upn: 'u@x' } });
  (loadOwnedItem as any).mockResolvedValue({
    id: 'agent-1', workspaceId: WS, itemType: 'data-agent',
    displayName: 'Casino Data Agent', description: '',
    state: { sources: [], instructions: '' },
    createdBy: 'u@x', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z',
  });
  // Every hook fetch is served by the real route module.
  (clientFetch as any).mockImplementation(async (url: string) => {
    const id = decodeURIComponent(String(url).split('/').pop() || '');
    return DA_GET({} as any, { params: Promise.resolve({ id }) } as any);
  });
});

describe('useItemState ← data-agent GET (#4092 join)', () => {
  it('surfaces a truthy workspaceId from the route body', async () => {
    const { result } = renderHook(() =>
      useItemState<Record<string, unknown>>('data-agent', 'agent-1', { sources: [], instructions: '' }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.workspaceId).toBe(WS);
    expect(result.current.workspaceId).toBeTruthy();
    // The state round-tripped too, so the hook genuinely parsed this body.
    expect(result.current.state.sources).toEqual([]);
  });

  it("arms the editor's candidate-fetch guard — the expression that was dead", async () => {
    const { result } = renderHook(() =>
      useItemState<Record<string, unknown>>('data-agent', 'agent-1', { sources: [], instructions: '' }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Verbatim shape of data-agent-editor.tsx's effect guard. With the route's
    // projection missing this is `false` forever, /api/items/by-type is never
    // called, and the Dropdown renders its empty-list placeholder over a
    // workspace that does contain a compatible warehouse.
    const available: Record<string, unknown[]> = {};
    const pickerType = 'warehouse';
    const willFetchCandidates = Boolean(result.current.workspaceId) && !available[pickerType];
    expect(willFetchCandidates).toBe(true);
  });

  it('leaves workspaceId empty for an unsaved /new item (no fetch to read it from)', async () => {
    const { result } = renderHook(() =>
      useItemState<Record<string, unknown>>('data-agent', 'new', { sources: [], instructions: '' }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    // Not a regression: there is no item yet, so there is no workspace to scope
    // to. Pinned so the "truthy" assertion above is understood as conditional on
    // a SAVED item rather than universal.
    expect(result.current.workspaceId).toBe('');
    expect(clientFetch).not.toHaveBeenCalled();
  });
});
