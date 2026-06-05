/**
 * Contract tests for GET /api/governance/purview/status.
 *
 *   1. unauthenticated → 401
 *   2. not configured  → 200 { ok, configured:false, reason:'not_configured', hint }
 *   3. live            → 200 { ok, configured:true, reason:'live', account }
 *   4. always 200 + JSON content-type so the client renders a gate, never a throw.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/purview-client', () => ({ probePurview: vi.fn() }));

import { GET } from '../purview/status/route';
import { getSession } from '@/lib/auth/session';
import { probePurview } from '@/lib/azure/purview-client';

beforeEach(() => { vi.resetAllMocks(); });

describe('GET /api/governance/purview/status', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('200 + not_configured body when Purview env var unset', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (probePurview as any).mockResolvedValue({
      configured: false, account: null, reason: 'not_configured',
      hint: { missingEnvVar: 'LOOM_PURVIEW_ACCOUNT', rolesRequired: [] },
    });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.configured).toBe(false);
    expect(j.reason).toBe('not_configured');
    expect(j.hint.missingEnvVar).toBe('LOOM_PURVIEW_ACCOUNT');
    expect(j.purviewPortal).toContain('purview.microsoft.com');
  });

  it('200 + live body when the data plane is reachable', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (probePurview as any).mockResolvedValue({ configured: true, account: 'purview-test', reason: 'live' });
    const res = await GET();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.configured).toBe(true);
    expect(j.reason).toBe('live');
    expect(j.account).toBe('purview-test');
  });

  it('200 + role_missing body carries the message + hint (UAMI lacks a Data Map role)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (probePurview as any).mockResolvedValue({
      configured: true, account: 'purview-test', reason: 'role_missing',
      message: 'Purview answered 403 (UAMI lacks a Data Map role).', hint: { followUp: 'grant Data Curator' },
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.reason).toBe('role_missing');
    expect(j.message).toContain('403');
  });
});
