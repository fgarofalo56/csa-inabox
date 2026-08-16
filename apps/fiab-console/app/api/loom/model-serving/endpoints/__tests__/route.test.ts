/**
 * GET /api/loom/model-serving/endpoints — the backend-agnostic serving-endpoint
 * lister behind the feature-table picker.
 *
 * The property that matters: it lists the SAME population `invokeServingEndpoint`
 * will call. `model-serving-client` dispatches on `resolveServingBackend()` —
 * Azure ML by default, Databricks Mosaic only on explicit opt-in — so a route
 * that hard-wired the Databricks lister would offer names the invoke path cannot
 * use on the default backend, and would be dead in Azure Government where
 * Databricks model serving is not GA (`cloud-parity.md`).
 *
 * The second property: an unconfigured backend returns the STRUCTURED 503 gate,
 * not `{ok:true, endpoints:[]}`. An empty list is a claim ("there are none");
 * the gate is the truth ("I could not ask") — `deploy-integrity.md` R7.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/model-serving-client', () => ({
  listServingEndpoints: vi.fn(),
  servingConfigGate: vi.fn(() => null),
  resolveServingBackend: vi.fn(() => 'aml'),
  ServingError: class ServingError extends Error { status = 502; },
}));

import { GET } from '../route';
import { getSession } from '@/lib/auth/session';
import {
  listServingEndpoints, servingConfigGate, resolveServingBackend,
} from '@/lib/azure/model-serving-client';

const sess = { claims: { oid: 'user-1', tid: 'tenant-1', groups: [] } };

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue(sess);
  (servingConfigGate as any).mockReturnValue(null);
  (resolveServingBackend as any).mockReturnValue('aml');
  (listServingEndpoints as any).mockResolvedValue([
    { name: 'fraud-scorer', backend: 'aml', state: 'Succeeded' },
  ]);
});

describe('GET /api/loom/model-serving/endpoints', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await GET()).status).toBe(401);
  });

  it('lists through the BACKEND-AGNOSTIC client and reports which backend answered', async () => {
    const j = await (await GET()).json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('aml');
    expect(j.endpoints.map((e: any) => e.name)).toEqual(['fraud-scorer']);
    // The dispatching lister — not a Databricks-only call.
    expect((listServingEndpoints as any).mock.calls.length).toBe(1);
  });

  it('follows the resolved backend when Mosaic is opted into', async () => {
    (resolveServingBackend as any).mockReturnValue('databricks');
    (listServingEndpoints as any).mockResolvedValue([{ name: 'mosaic-ep', backend: 'databricks' }]);
    const j = await (await GET()).json();
    expect(j.backend).toBe('databricks');
    expect(j.endpoints[0].name).toBe('mosaic-ep');
  });

  it('an unconfigured backend is a STRUCTURED 503 gate, never an empty list', async () => {
    (servingConfigGate as any).mockReturnValue({
      backend: 'aml',
      missing: 'LOOM_AML_WORKSPACE (or LOOM_FOUNDRY_NAME)',
      hint: 'Set LOOM_AML_WORKSPACE so model-serving endpoints have an Azure ML workspace.',
      fixEnvVar: 'LOOM_AML_WORKSPACE',
      gateId: 'svc-model-serving',
    });
    const res = await GET();
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('svc-model-serving');
    expect(j.missing).toContain('LOOM_AML_WORKSPACE');
    // The two fields the CLIENT actually reads to mount the shared HonestGate.
    // Asserting only `fixEnvVar` here is what let a fully-wired route feed a
    // bare MessageBar for a while: the payload was right and nothing consumed
    // it. The consumer side is asserted in
    // lib/editors/__tests__/feature-table-serving-picker.test.tsx.
    expect(j.gate.gateId).toBe('svc-model-serving');
    expect(j.gate.missing).toContain('LOOM_AML_WORKSPACE');
    expect(j.gate.fixEnvVar).toBe('LOOM_AML_WORKSPACE');
    // And the model plane was never called.
    expect((listServingEndpoints as any).mock.calls.length).toBe(0);
  });

  it('an upstream failure surfaces verbatim rather than resolving to []', async () => {
    (listServingEndpoints as any).mockRejectedValue(Object.assign(new Error('AML 403 Forbidden'), { status: 403 }));
    const res = await GET();
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toContain('AML 403 Forbidden');
  });
});
