/**
 * Unit tests for resolveCaller — the dual-auth (cookie session OR headless CI
 * Bearer token) gate on the Loom deployment-pipeline routes. This is the
 * security boundary that lets the CSA Loom Azure DevOps task drive deploys
 * without an MSAL session, so the fail-closed token path is load-bearing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// session — default to "no cookie" so the token path is exercised; individual
// tests override the mock to simulate a logged-in Console user.
const getSessionMock = vi.fn<[], any>(() => null);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

// pipeline-store imports the cosmos-client for its store helpers; the gate
// itself never touches Cosmos, so a hollow mock keeps the module importable.
vi.mock('@/lib/azure/cosmos-client', () => ({
  loomPipelinesContainer: vi.fn(),
  pipelineStageRulesContainer: vi.fn(),
  workspacesContainer: vi.fn(),
}));

import { resolveCaller } from '../_lib/pipeline-store';

function req(headers: Record<string, string>) {
  return { headers: new Headers(headers) } as any;
}

const ORIG_ENABLED = process.env.LOOM_PIPELINE_CI_ENABLED;
const ORIG_CI = process.env.LOOM_CI_TOKEN;
const ORIG_INTERNAL = process.env.LOOM_INTERNAL_TOKEN;

beforeEach(() => {
  getSessionMock.mockReturnValue(null);
  delete process.env.LOOM_PIPELINE_CI_ENABLED;
  delete process.env.LOOM_CI_TOKEN;
  delete process.env.LOOM_INTERNAL_TOKEN;
});
afterEach(() => {
  process.env.LOOM_PIPELINE_CI_ENABLED = ORIG_ENABLED;
  process.env.LOOM_CI_TOKEN = ORIG_CI;
  process.env.LOOM_INTERNAL_TOKEN = ORIG_INTERNAL;
});

describe('resolveCaller — cookie session', () => {
  it('resolves the session oid as the tenant (token path not consulted)', () => {
    getSessionMock.mockReturnValue({
      claims: { oid: 'tenant-123', upn: 'user@contoso.com' },
      exp: Date.now() / 1000 + 3600,
    });
    const c = resolveCaller(req({}));
    expect(c).not.toBeNull();
    expect(c!.mode).toBe('session');
    expect(c!.tenantId).toBe('tenant-123');
    expect(c!.actor).toBe('user@contoso.com');
  });
});

describe('resolveCaller — headless CI token', () => {
  it('fails closed when LOOM_PIPELINE_CI_ENABLED is not true', () => {
    process.env.LOOM_INTERNAL_TOKEN = 'secret';
    const c = resolveCaller(req({ authorization: 'Bearer secret', 'x-user-oid': 'oid-1' }));
    expect(c).toBeNull();
  });

  it('rejects a bad Bearer even when enabled', () => {
    process.env.LOOM_PIPELINE_CI_ENABLED = 'true';
    process.env.LOOM_INTERNAL_TOKEN = 'secret';
    expect(resolveCaller(req({ authorization: 'Bearer wrong', 'x-user-oid': 'oid-1' }))).toBeNull();
    expect(resolveCaller(req({ 'x-user-oid': 'oid-1' }))).toBeNull(); // no Authorization
  });

  it('rejects a valid token with no x-user-oid', () => {
    process.env.LOOM_PIPELINE_CI_ENABLED = 'true';
    process.env.LOOM_INTERNAL_TOKEN = 'secret';
    expect(resolveCaller(req({ authorization: 'Bearer secret' }))).toBeNull();
  });

  it('accepts a valid LOOM_INTERNAL_TOKEN fallback + x-user-oid → token mode', () => {
    process.env.LOOM_PIPELINE_CI_ENABLED = 'true';
    process.env.LOOM_INTERNAL_TOKEN = 'secret';
    const c = resolveCaller(req({ authorization: 'Bearer secret', 'x-user-oid': 'oid-7' }));
    expect(c).not.toBeNull();
    expect(c!.mode).toBe('token');
    expect(c!.tenantId).toBe('oid-7');
    expect(c!.session.claims.oid).toBe('oid-7');
    expect(c!.actor).toContain('ci-pipeline');
  });

  it('prefers a dedicated LOOM_CI_TOKEN over the shared internal token', () => {
    process.env.LOOM_PIPELINE_CI_ENABLED = 'true';
    process.env.LOOM_CI_TOKEN = 'ci-only';
    process.env.LOOM_INTERNAL_TOKEN = 'secret';
    // the internal token must NOT be accepted once a dedicated CI token is set
    expect(resolveCaller(req({ authorization: 'Bearer secret', 'x-user-oid': 'oid-1' }))).toBeNull();
    const c = resolveCaller(req({ authorization: 'Bearer ci-only', 'x-user-oid': 'oid-1' }));
    expect(c).not.toBeNull();
    expect(c!.mode).toBe('token');
  });
});
