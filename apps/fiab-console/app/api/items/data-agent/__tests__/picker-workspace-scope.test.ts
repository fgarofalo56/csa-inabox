/**
 * #4092 — THE PICKER-SCOPE CONTRACT.
 *
 * ## What broke, and why a route test is the right place to pin it
 *
 * The data-agent source picker rendered Type=Warehouse, Item="None found" and a
 * disabled **Add** on a workspace that demonstrably contained a compatible
 * warehouse. `/api/items/by-type` was serving that item correctly in three
 * different query shapes — the picker never asked it.
 *
 * The whole defect is HERE, in one omitted projection field:
 *
 *   `useItemState` (lib/editors/phase4/shared.tsx) sets its `workspaceId` from
 *   `doc.workspaceId` on THIS GET's body. The data-agent editor's candidate
 *   effect is `if (workspaceId && !available[pickerType]) loadAvailable(...)`.
 *   `loadOwnedItem` does `SELECT *`, so the field was always in hand — the
 *   route just never put it on the wire. The guard was therefore permanently
 *   false, `loadAvailable` never ran, and the Dropdown fell through to its
 *   empty-list placeholder.
 *
 * A component test could not have caught it (the component is correct given a
 * workspaceId) and a by-type test could not either (that route is correct).
 * The contract that was broken is exactly "this GET tells the editor which
 * workspace the item is in", so that is what these pin.
 *
 * ## It is a CLASS, not a data-agent quirk
 *
 * Five editors scope a picker on `useItemState().workspaceId`: agent-flow,
 * data-agent, map, operations-agent, plan. Only agent-flow's GET projected the
 * field. The class walk below runs the SAME assertion over all five, so the
 * next per-type CRUD route that forgets it fails here instead of shipping a
 * dead-end dropdown.
 *
 * ## Auto-bind (auto-bind-by-default.md §1)
 *
 * Rendering the list is the lesser half. The rule forbids the dead end AND
 * requires the platform to have done the binding, so the picker exists to
 * CHANGE the source rather than to make it. `autoBindDataAgentSources` is
 * mocked here — its own logic is covered in
 * `lib/azure/__tests__/data-agent-autobind.test.ts`; what these pin is that the
 * two lifecycle routes actually INVOKE it, and that GET serialises the binding
 * it established in memory.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

vi.mock('@/app/api/items/_lib/item-crud', () => ({
  createOwnedItem: vi.fn(),
  listOwnedItems: vi.fn(),
  loadOwnedItem: vi.fn(),
  updateOwnedItem: vi.fn(),
  deleteOwnedItem: vi.fn(),
  jerr: (error: string, status = 500) => ({ status, json: async () => ({ ok: false, error }) }) as any,
}));

vi.mock('@/lib/azure/data-agent-autobind', () => ({ autoBindDataAgentSources: vi.fn() }));

// The [id] route's DELETE reaches these; GET/POST do not. Stubbed so importing
// the module never opens a client.
vi.mock('@/lib/azure/foundry-agent-client', () => ({ deleteAgent: vi.fn() }));
vi.mock('@/lib/azure/copilot-studio-client', () => ({ deleteAgent: vi.fn() }));

import { getSession } from '@/lib/auth/session';
import { createOwnedItem, loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { autoBindDataAgentSources } from '@/lib/azure/data-agent-autobind';

import { GET as DA_GET } from '../[id]/route';
import { POST as DA_CREATE } from '../route';

const AUTH = { claims: { oid: 'tenant-1', upn: 'u@x' } };
const WS = 'ws-casino-analytics';

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}
function item(over: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    workspaceId: WS,
    itemType: 'data-agent',
    displayName: 'Casino Data Agent',
    description: 'd',
    state: { sources: [], instructions: '' },
    createdBy: 'u@x',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    ...over,
  } as any;
}

beforeEach(() => { vi.resetAllMocks(); });

describe('GET /api/items/data-agent/[id] — the picker-scope projection (#4092)', () => {
  it('projects workspaceId, which is what arms the source picker', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (loadOwnedItem as any).mockResolvedValue(item());
    (autoBindDataAgentSources as any).mockResolvedValue(null);

    const res = await DA_GET({} as any, ctx('agent-1'));
    const body = await res.json();

    expect(res.status).toBe(200);
    // THE ASSERTION THE BUG WOULD HAVE FAILED. Both halves matter: the key must
    // be present (not `undefined`, which JSON drops and `if (workspaceId)`
    // reads as false) AND it must carry the item's real partition.
    expect(body).toHaveProperty('workspaceId');
    expect(body.workspaceId).toBe(WS);
    // Guard the exact falsy shapes the editor's `if (workspaceId && …)` treats
    // as "no workspace" — a route that projected '' or null would satisfy a
    // naive toHaveProperty and still render "None found".
    expect(body.workspaceId).toBeTruthy();
  });

  it('still returns the fields the editor already depended on', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (loadOwnedItem as any).mockResolvedValue(item());
    (autoBindDataAgentSources as any).mockResolvedValue(null);

    const body = await (await DA_GET({} as any, ctx('agent-1'))).json();
    expect(body.id).toBe('agent-1');
    expect(body.displayName).toBe('Casino Data Agent');
    expect(body.state).toEqual({ sources: [], instructions: '' });
    expect(body.updatedAt).toBe('2026-08-02T00:00:00.000Z');
  });

  it('runs auto-bind on open and serialises the binding it established', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const doc = item();
    (loadOwnedItem as any).mockResolvedValue(doc);
    // Mirror the real function's in-memory mutation contract.
    (autoBindDataAgentSources as any).mockImplementation(async (it: any) => {
      it.state = { ...it.state, sources: [{ id: 'warehouse:wh-1:auto', type: 'warehouse', name: 'Casino Data Warehouse' }] };
      return { persisted: true };
    });

    const body = await (await DA_GET({} as any, ctx('agent-1'))).json();

    expect(autoBindDataAgentSources).toHaveBeenCalledTimes(1);
    expect(autoBindDataAgentSources).toHaveBeenCalledWith(doc);
    // The editor opens on a BOUND agent — the response must carry the sources
    // auto-bind just attached, not the pre-bind empty list.
    expect(body.state.sources).toHaveLength(1);
    expect(body.state.sources[0].name).toBe('Casino Data Warehouse');
  });

  it('404s without calling auto-bind when the item is not the caller\'s', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (loadOwnedItem as any).mockResolvedValue(null);

    const res = await DA_GET({} as any, ctx('agent-1'));
    expect(res.status).toBe(404);
    expect(autoBindDataAgentSources).not.toHaveBeenCalled();
  });

  it('401s before any load', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await DA_GET({} as any, ctx('agent-1'));
    expect(res.status).toBe(401);
    expect(loadOwnedItem).not.toHaveBeenCalled();
  });
});

describe('POST /api/items/data-agent — auto-bind on create (rule §1)', () => {
  it('binds the new agent before returning it', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const created = item({ id: 'agent-new', state: { sources: [], instructions: '' } });
    (createOwnedItem as any).mockResolvedValue({ ok: true, item: created });
    (autoBindDataAgentSources as any).mockImplementation(async (it: any) => {
      it.state = { ...it.state, sources: [{ id: 'warehouse:wh-1:auto', type: 'warehouse', name: 'Casino Data Warehouse' }] };
      return { persisted: true };
    });

    const res = await DA_CREATE({ json: async () => ({ workspaceId: WS, displayName: 'A' }) } as any);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(autoBindDataAgentSources).toHaveBeenCalledWith(created);
    // "No second step, no wizard the user must find" — the 201 already reports
    // a bound agent.
    expect(body.item.state.sources).toHaveLength(1);
  });

  it('does not attempt a bind when the create itself failed', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (createOwnedItem as any).mockResolvedValue({ ok: false, status: 400, error: 'workspaceId and displayName are required' });

    const res = await DA_CREATE({ json: async () => ({}) } as any);
    expect(res.status).toBe(400);
    expect(autoBindDataAgentSources).not.toHaveBeenCalled();
  });
});

/**
 * THE CLASS WALK. Every per-type CRUD GET behind an editor that scopes a picker
 * on `useItemState().workspaceId` must project the field. Driven off a table so
 * adding the sixth such editor is a one-line change here rather than a
 * copy-pasted spec — and so a route that drops the field again fails on the
 * assertion that names WHY it matters.
 */
describe('workspaceId projection — every picker-scoped item GET (#4092 class)', () => {
  const ROUTES: { slug: string; itemType: string; load: () => Promise<any> }[] = [
    { slug: 'agent-flow', itemType: 'agent-flow', load: () => import('@/app/api/items/agent-flow/[id]/route') },
    { slug: 'map', itemType: 'map', load: () => import('@/app/api/items/map/[id]/route') },
    { slug: 'operations-agent', itemType: 'operations-agent', load: () => import('@/app/api/items/operations-agent/[id]/route') },
    { slug: 'plan', itemType: 'plan', load: () => import('@/app/api/items/plan/[id]/route') },
  ];

  for (const r of ROUTES) {
    it(`${r.slug} GET projects workspaceId`, async () => {
      (getSession as any).mockReturnValue(AUTH);
      (loadOwnedItem as any).mockResolvedValue(item({ itemType: r.itemType, workspaceId: `ws-${r.slug}` }));
      const mod = await r.load();
      const body = await (await mod.GET({} as any, ctx('x-1'))).json();
      expect(body).toHaveProperty('workspaceId');
      expect(body.workspaceId).toBe(`ws-${r.slug}`);
    });

    // COMPENSATING CONTROL for the `TOUCH_EXEMPT` entry these routes carry in
    // scripts/ci/check-route-toolkit.mjs. The boy-scout ratchet wants a touched
    // route migrated onto the route-toolkit; the codemod REFUSES all five
    // ("getSession() without the exact 401 guard"), so they are exempted from
    // the touch rule and keep hand-rolled prologues. That is only acceptable
    // while something watches the prologue — so this does, per route: delete the
    // `if (!s) return 401` line and this fails.
    it(`${r.slug} GET 401s before loading anything`, async () => {
      (getSession as any).mockReturnValue(null);
      const mod = await r.load();
      const res = await mod.GET({} as any, ctx('x-1'));
      expect(res.status).toBe(401);
      expect(loadOwnedItem).not.toHaveBeenCalled();
    });
  }
});
