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
});
