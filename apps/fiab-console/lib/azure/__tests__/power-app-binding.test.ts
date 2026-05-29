/**
 * Contract tests for the Power App resource-binding model — the fix for the
 * 404 bug (GET https://api.powerapps.com/.../apps/<loom-guid> failed because
 * the Loom item GUID was sent as the Power Apps app id).
 *
 * Asserts:
 *   - resolvePowerAppBinding() returns state.appId/envId, NOT the route id
 *   - an unbound item throws UnboundPowerAppError (→ 412)
 *   - a missing item throws PowerAppItemNotFoundError (→ 404)
 *   - persistPowerAppBinding() writes envId/appId/appType into item.state
 *   - powerAppBindingErrorResponse() maps errors to the right HTTP status/body
 *
 * Cosmos is mocked so the test runs offline.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = {
  itemDoc: null as any,
  workspaceDoc: null as any,
  replaced: null as any,
};

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: () => ({ fetchAll: async () => ({ resources: state.itemDoc ? [state.itemDoc] : [] }) }),
    },
    item: (id: string, pk: string) => ({
      replace: async (doc: any) => { state.replaced = { id, pk, doc }; return { resource: doc }; },
    }),
  }),
  workspacesContainer: async () => ({
    item: (_wsId: string, _tenant: string) => ({ read: async () => ({ resource: state.workspaceDoc }) }),
  }),
}));

const TENANT = 'tenant-oid-1';

function makeItem(over: Partial<any> = {}) {
  return {
    id: 'loom-guid-aaaa',
    workspaceId: 'ws-1',
    itemType: 'power-app',
    displayName: 'My App',
    state: { envId: 'Default-1111', appId: 'app-2222', appType: 'CanvasApp' },
    createdBy: 'u', createdAt: 't', updatedAt: 't',
    ...over,
  };
}

beforeEach(() => {
  state.itemDoc = makeItem();
  state.workspaceDoc = { id: 'ws-1', tenantId: TENANT };
  state.replaced = null;
});

describe('resolvePowerAppBinding', () => {
  it('returns the real appId/envId from item.state, NOT the route id', async () => {
    const { resolvePowerAppBinding } = await import('../power-app-binding');
    const b = await resolvePowerAppBinding('loom-guid-aaaa', 'power-app', TENANT);
    expect(b.appId).toBe('app-2222');
    expect(b.envId).toBe('Default-1111');
    expect(b.appType).toBe('CanvasApp');
    expect(b.appId).not.toBe('loom-guid-aaaa');
  });

  it('throws UnboundPowerAppError when appId is missing', async () => {
    state.itemDoc = makeItem({ state: { envId: 'Default-1111' } });
    const { resolvePowerAppBinding, UnboundPowerAppError } = await import('../power-app-binding');
    await expect(resolvePowerAppBinding('loom-guid-aaaa', 'power-app', TENANT)).rejects.toBeInstanceOf(UnboundPowerAppError);
  });

  it('throws UnboundPowerAppError when envId is missing', async () => {
    state.itemDoc = makeItem({ state: { appId: 'app-2222' } });
    const { resolvePowerAppBinding, UnboundPowerAppError } = await import('../power-app-binding');
    await expect(resolvePowerAppBinding('loom-guid-aaaa', 'power-app', TENANT)).rejects.toBeInstanceOf(UnboundPowerAppError);
  });

  it('throws PowerAppItemNotFoundError when the item is absent', async () => {
    state.itemDoc = null;
    const { resolvePowerAppBinding, PowerAppItemNotFoundError } = await import('../power-app-binding');
    await expect(resolvePowerAppBinding('nope', 'power-app', TENANT)).rejects.toBeInstanceOf(PowerAppItemNotFoundError);
  });

  it('throws PowerAppItemNotFoundError when the workspace belongs to another tenant', async () => {
    state.workspaceDoc = { id: 'ws-1', tenantId: 'someone-else' };
    const { resolvePowerAppBinding, PowerAppItemNotFoundError } = await import('../power-app-binding');
    await expect(resolvePowerAppBinding('loom-guid-aaaa', 'power-app', TENANT)).rejects.toBeInstanceOf(PowerAppItemNotFoundError);
  });
});

describe('persistPowerAppBinding', () => {
  it('writes envId/appId/appType into item.state and replaces the Cosmos doc', async () => {
    state.itemDoc = makeItem({ state: { keepMe: 'yes' } });
    const { persistPowerAppBinding } = await import('../power-app-binding');
    const updated = await persistPowerAppBinding('loom-guid-aaaa', 'power-app', TENANT, {
      envId: 'Env-X', appId: 'App-Y', appType: 'ModelDrivenApp',
    });
    expect(updated.state?.appId).toBe('App-Y');
    expect(updated.state?.envId).toBe('Env-X');
    expect(updated.state?.appType).toBe('ModelDrivenApp');
    expect((updated.state as any)?.keepMe).toBe('yes'); // preserves other state
    expect(state.replaced.doc.state.appId).toBe('App-Y');
    expect(state.replaced.pk).toBe('ws-1'); // partition key = workspaceId
  });

  it('rejects when appId is empty', async () => {
    const { persistPowerAppBinding } = await import('../power-app-binding');
    await expect(persistPowerAppBinding('loom-guid-aaaa', 'power-app', TENANT, { envId: 'e', appId: '  ' })).rejects.toThrow();
  });

  it('rejects when envId is empty', async () => {
    const { persistPowerAppBinding } = await import('../power-app-binding');
    await expect(persistPowerAppBinding('loom-guid-aaaa', 'power-app', TENANT, { envId: ' ', appId: 'a' })).rejects.toThrow();
  });
});

describe('powerAppBindingErrorResponse', () => {
  it('maps UnboundPowerAppError → 412 with code "unbound"', async () => {
    const { powerAppBindingErrorResponse, UnboundPowerAppError } = await import('../power-app-binding');
    const r = powerAppBindingErrorResponse(new UnboundPowerAppError('power-app', 'guid'));
    expect(r.status).toBe(412);
    expect(r.body.code).toBe('unbound');
    expect(r.body.ok).toBe(false);
  });

  it('maps PowerAppItemNotFoundError → 404 with code "not_found"', async () => {
    const { powerAppBindingErrorResponse, PowerAppItemNotFoundError } = await import('../power-app-binding');
    const r = powerAppBindingErrorResponse(new PowerAppItemNotFoundError('power-app', 'guid'));
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('not_found');
  });

  it('maps any other error → 502', async () => {
    const { powerAppBindingErrorResponse } = await import('../power-app-binding');
    const r = powerAppBindingErrorResponse(new Error('powerapps 500'));
    expect(r.status).toBe(502);
    expect(r.body.error).toContain('powerapps 500');
  });
});
