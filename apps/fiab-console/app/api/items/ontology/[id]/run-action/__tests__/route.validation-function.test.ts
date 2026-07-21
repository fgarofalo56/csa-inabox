/**
 * WS-4.2 — POST /api/items/ontology/[id]/run-action: an action's validation
 * function is REALLY invoked before the write, and a non-`valid` verdict blocks
 * the run (422) without calling runActionType. Hermetic — all stores mocked; the
 * verdict interpreter (interpretVerdict) runs for real.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'o', tid: 't1', groups: [] }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  tenantScopeId: (s: any) => s.claims.tid || s.claims.oid,
}));
vi.mock('@/lib/auth/pdp/enforce', () => ({ pdpCheck: vi.fn(async () => null) }));
vi.mock('@/lib/auth/domain-role', () => ({ isTenantAdminTier: vi.fn(() => false) }));
vi.mock('@/lib/azure/object-security-audit', () => ({ auditObjectSecurity: vi.fn() }));

const loadOwnedItemMock = vi.fn();
vi.mock('@/app/api/items/_lib/item-crud', () => ({ loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a) }));

const runActionTypeMock = vi.fn(async () => ({ ok: true, kind: 'create', action: 'createCustomer', objectType: 'Customer', object: { id: '42', objectType: 'Customer', properties: {} } }));
vi.mock('@/lib/azure/weave-ontology-store', () => ({
  weaveGate: () => null,
  runActionType: (...a: any[]) => runActionTypeMock(...a),
}));
vi.mock('@/lib/azure/postgres-flex-client', () => ({ PostgresError: class PostgresError extends Error { status = 502; } }));
vi.mock('@/lib/azure/action-justification-store', () => ({
  recordActionJustification: vi.fn(async () => ({ id: 'j1' })),
  isValidReason: (r: unknown) => typeof r === 'string' && r.trim().length >= 4,
  MIN_JUSTIFICATION_LEN: 4,
}));
vi.mock('@/lib/thread/thread-edges', () => ({ recordThreadEdge: vi.fn(async () => {}) }));
vi.mock('@/lib/azure/action-approval-store', () => ({
  paramsHash: () => 'h', findUsableApproval: vi.fn(async () => ({ id: 'a1' })),
  requestApproval: vi.fn(async () => ({ id: 'r1' })), consumeApproval: vi.fn(async () => {}),
}));

const getRegisteredFunctionMock = vi.fn();
vi.mock('@/lib/azure/function-registry-store', () => ({ getRegisteredFunction: (...a: any[]) => getRegisteredFunctionMock(...a) }));

const functionRuntimeGateMock = vi.fn(() => null as any);
const invokeFunctionMock = vi.fn();
vi.mock('@/lib/azure/loom-function-runtime', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/azure/loom-function-runtime')>();
  return {
    ...actual,
    functionRuntimeGate: (...a: any[]) => functionRuntimeGateMock(...a),
    invokeFunction: (...a: any[]) => invokeFunctionMock(...a),
  };
});

import { POST } from '../route';

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: any) => ({ json: async () => body } as any);

const REG_FN = { name: 'validateCustomer', version: '1', runtime: 'udf', purpose: 'validation', functionPath: 'validateCustomer', params: [] };
const ONTO = {
  id: 'onto1', displayName: 'Onto',
  state: {
    objectTypes: [{ apiName: 'Customer', properties: [{ apiName: 'name', baseType: 'string' }] }],
    actionTypes: [{
      name: 'createCustomer', objectType: 'Customer', kind: 'create',
      parameters: [{ apiName: 'name', type: 'string' }],
      validationFunction: { name: 'validateCustomer' },
    }],
  },
};

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'o', tid: 't1', groups: [] }, exp: Date.now() / 1000 + 3600 } as any);
  loadOwnedItemMock.mockReset().mockResolvedValue(ONTO);
  runActionTypeMock.mockClear();
  getRegisteredFunctionMock.mockReset().mockResolvedValue(REG_FN);
  functionRuntimeGateMock.mockReset().mockReturnValue(null);
  invokeFunctionMock.mockReset();
});

describe('POST /run-action — WS-4.2 validation function', () => {
  it('invokes the registered function and BLOCKS (422) on an invalid verdict', async () => {
    invokeFunctionMock.mockResolvedValue({ ok: true, status: 200, value: { valid: false, message: 'name is on the deny list' }, body: '' });
    const r = await POST(post({ action: 'createCustomer', params: { name: 'x' } }), ctx('onto1'));
    expect(r.status).toBe(422);
    const j = await r.json();
    expect(j.code).toBe('validation_failed');
    expect(j.error).toContain('deny list');
    // The function was called with the coerced params + object context…
    expect(invokeFunctionMock).toHaveBeenCalledTimes(1);
    expect(invokeFunctionMock.mock.calls[0][1]).toMatchObject({ action: 'createCustomer', objectType: 'Customer', parameters: { name: 'x' } });
    // …and the write NEVER ran.
    expect(runActionTypeMock).not.toHaveBeenCalled();
  });

  it('proceeds to the write on a valid verdict', async () => {
    invokeFunctionMock.mockResolvedValue({ ok: true, status: 200, value: { valid: true }, body: '' });
    const r = await POST(post({ action: 'createCustomer', params: { name: 'x' } }), ctx('onto1'));
    expect(r.status).toBe(200);
    expect(invokeFunctionMock).toHaveBeenCalledTimes(1);
    expect(runActionTypeMock).toHaveBeenCalledTimes(1);
  });

  it('409s when the referenced function is not registered', async () => {
    getRegisteredFunctionMock.mockResolvedValue(null);
    const r = await POST(post({ action: 'createCustomer', params: { name: 'x' } }), ctx('onto1'));
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('validation_function_missing');
    expect(runActionTypeMock).not.toHaveBeenCalled();
  });

  it('503s an honest gate when the runtime is not configured', async () => {
    functionRuntimeGateMock.mockReturnValue({ missing: 'LOOM_UDF_FUNCTION_BASE', detail: 'set it', remediation: 'deploy udf-runtime' });
    const r = await POST(post({ action: 'createCustomer', params: { name: 'x' } }), ctx('onto1'));
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe('function_runtime_not_configured');
    expect(invokeFunctionMock).not.toHaveBeenCalled();
    expect(runActionTypeMock).not.toHaveBeenCalled();
  });

  it('502s when the function runtime errors', async () => {
    invokeFunctionMock.mockResolvedValue({ ok: false, status: 502, value: null, body: '', error: 'connect ECONNREFUSED' });
    const r = await POST(post({ action: 'createCustomer', params: { name: 'x' } }), ctx('onto1'));
    expect(r.status).toBe(502);
    expect((await r.json()).code).toBe('validation_function_error');
    expect(runActionTypeMock).not.toHaveBeenCalled();
  });
});
