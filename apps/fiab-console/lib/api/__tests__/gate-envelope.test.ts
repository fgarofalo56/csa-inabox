/**
 * WS-D2 — gate envelope unit tests. The registry is mocked so we assert the
 * envelope SHAPE + status handling in isolation (no env / Azure).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/gates/registry', () => ({
  getGate: vi.fn(),
  gateStatus: vi.fn(),
}));

import { getGate, gateStatus } from '@/lib/gates/registry';
import {
  buildGateEnvelope, apiHonestGateError, backendGateResponse, gateFixItHref, GATE_HTTP_STATUS,
} from '../gate-envelope';

beforeEach(() => {
  vi.resetAllMocks();
  (getGate as any).mockReturnValue({ id: 'svc-aisearch', title: 'Azure AI Search (RAG indexes)', remediation: 'Set LOOM_AI_SEARCH_SERVICE.' });
  (gateStatus as any).mockReturnValue({ id: 'svc-aisearch', status: 'blocked', missing: ['LOOM_AI_SEARCH_SERVICE'] });
});

describe('gateFixItHref', () => {
  it('deep-links the admin gate registry with the gate id', () => {
    expect(gateFixItHref('svc-adf')).toBe('/admin/gates?gate=svc-adf');
    expect(gateFixItHref('a b')).toBe('/admin/gates?gate=a%20b');
  });
});

describe('buildGateEnvelope', () => {
  it('produces the normalized envelope + back-compat mirrors', () => {
    const env = buildGateEnvelope('svc-aisearch');
    expect(env.ok).toBe(false);
    expect(env.gated).toBe(true);
    expect(env.code).toBe('not_configured');
    expect(env.error).toBe('Set LOOM_AI_SEARCH_SERVICE.');
    expect(env.missing).toEqual(['LOOM_AI_SEARCH_SERVICE']);
    expect(env.gate).toEqual({
      id: 'svc-aisearch',
      title: 'Azure AI Search (RAG indexes)',
      remediation: 'Set LOOM_AI_SEARCH_SERVICE.',
      fixItHref: '/admin/gates?gate=svc-aisearch',
      missing: ['LOOM_AI_SEARCH_SERVICE'],
    });
  });

  it('honors message / missing / code overrides', () => {
    const env = buildGateEnvelope('svc-adf', { message: 'Data Factory not configured: set LOOM_ADF_FACTORY.', missing: ['LOOM_ADF_FACTORY'], code: 'adf_off' });
    expect(env.code).toBe('adf_off');
    expect(env.error).toBe('Data Factory not configured: set LOOM_ADF_FACTORY.');
    expect(env.missing).toEqual(['LOOM_ADF_FACTORY']);
    expect(env.gate.missing).toEqual(['LOOM_ADF_FACTORY']);
  });

  it('stays honest for an unknown gate id', () => {
    (getGate as any).mockReturnValue(undefined);
    (gateStatus as any).mockReturnValue(undefined);
    const env = buildGateEnvelope('svc-mystery');
    expect(env.gate.title).toBe('svc-mystery');
    expect(env.error).toMatch(/Configure svc-mystery/);
    expect(env.missing).toEqual([]);
  });
});

describe('apiHonestGateError', () => {
  it('returns a 503 by default with the envelope body', async () => {
    const res = apiHonestGateError('svc-aisearch');
    expect(res.status).toBe(GATE_HTTP_STATUS);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.gated).toBe(true);
    expect(body.gate.id).toBe('svc-aisearch');
  });
  it('honors a status override', () => {
    expect(apiHonestGateError('svc-aisearch', { status: 403 }).status).toBe(403);
  });
});

describe('backendGateResponse', () => {
  it('returns the 503 gate when blocked', async () => {
    const res = backendGateResponse('svc-aisearch');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
    const body = await res!.json();
    expect(body.missing).toEqual(['LOOM_AI_SEARCH_SERVICE']);
  });
  it('returns null when configured (caller proceeds)', () => {
    (gateStatus as any).mockReturnValue({ id: 'svc-aisearch', status: 'configured', missing: [] });
    expect(backendGateResponse('svc-aisearch')).toBeNull();
  });

  /**
   * #2624 — an id the registry does not know makes `gateStatus` return
   * undefined. That is UNEVALUATED, not "configured". Before this fix the
   * `if (status && …)` guard fell through to `return null`, so a mistyped or
   * deleted gate id produced a `withBackendGate` wrapper that could not fire —
   * a gate that reports itself as gating while gating nothing.
   */
  it('fails CLOSED for an id the registry does not know', async () => {
    (getGate as any).mockReturnValue(undefined);
    (gateStatus as any).mockReturnValue(undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = backendGateResponse('svc-typo-not-a-gate');
    expect(res, 'an unknown gate id must NOT be treated as configured').not.toBeNull();
    expect(res!.status).toBe(503);
    const body = await res!.json();
    expect(body.gated).toBe(true);
    expect(body.gate.id).toBe('svc-typo-not-a-gate');
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toMatch(/not in the registry/);
    err.mockRestore();
  });

  it('sanitizes the unknown gate id before logging it', () => {
    (gateStatus as any).mockReturnValue(undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    backendGateResponse('bad\nid\rINJECTED');
    expect(String(err.mock.calls[0][0])).not.toMatch(/[\n\r]/);
    expect(String(err.mock.calls[0][0])).toMatch(/bad\?id\?\?INJECTED/);
    err.mockRestore();
  });

  /**
   * CONTROL — passes BEFORE and AFTER the fail-closed change. If the new branch
   * were written too broadly (e.g. gating whenever `status` is falsy in a way
   * that also catches a configured gate), this would go red.
   */
  it('CONTROL: a KNOWN configured gate still proceeds, and a known blocked gate still gates', async () => {
    (gateStatus as any).mockReturnValue({ id: 'svc-adf', status: 'configured', missing: [] });
    expect(backendGateResponse('svc-adf')).toBeNull();
    (gateStatus as any).mockReturnValue({ id: 'svc-adf', status: 'blocked', missing: ['LOOM_ADF_FACTORY'] });
    const res = backendGateResponse('svc-adf');
    expect(res).not.toBeNull();
    expect((await res!.json()).missing).toEqual(['LOOM_ADF_FACTORY']);
  });
});
