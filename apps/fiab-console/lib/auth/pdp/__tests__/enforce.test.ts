/**
 * pdpCheck() GATE contract tests (EH Phase-1 P0).
 *
 * Asserts the gate's BEHAVIOR contract — NOT Cosmos. `authorize` and the audit
 * container accessor are mocked, so these run in the vitest node env with no
 * Azure in the import graph:
 *
 *   - off                       → returns null, NEVER calls authorize().
 *   - shadow + deny decision    → returns null (does NOT block) + attempts the
 *                                 audit write (reuses auditLogContainer()).
 *   - shadow + authorize THROW  → returns null (never throws) — log-and-swallow.
 *   - enforce + deny            → returns a 403 NextResponse { ok:false }.
 *   - enforce + allow           → returns null.
 *   - enforce + authorize THROW → fail-closed 403.
 *   - pdpEnforceMode()          → parsing + default-off.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Decision } from '../resource-ref';

// --- mock the PDP authorize() + the audit container accessor ----------------
const authorizeMock = vi.fn();
vi.mock('../authorize', () => ({
  authorize: (...args: unknown[]) => authorizeMock(...args),
}));

const createMock = vi.fn().mockResolvedValue({});
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: vi.fn(async () => ({ items: { create: createMock } })),
}));

import { pdpCheck, pdpEnforceMode } from '../enforce';
import { auditLogContainer } from '@/lib/azure/cosmos-client';

const SESSION = {
  claims: { oid: 'oid-alice', name: 'Alice', upn: 'alice@contoso.com', groups: ['g1'] },
  exp: Math.floor(Date.now() / 1000) + 3600,
} as any;

const REF = { level: 'item' as const, id: 'item-1', itemType: 'lakehouse' };

function allow(): Decision {
  return { effect: 'allow', reason: 'workspace Admin', source: 'workspace-role:Admin', obligations: [] };
}
function deny(): Decision {
  return { effect: 'deny', reason: 'no grant', source: 'default-deny', obligations: [] };
}

const ORIG = process.env.LOOM_PDP_ENFORCE;

beforeEach(() => {
  authorizeMock.mockReset();
  createMock.mockReset().mockResolvedValue({});
  (auditLogContainer as any).mockClear?.();
});
afterEach(() => {
  if (ORIG === undefined) delete process.env.LOOM_PDP_ENFORCE;
  else process.env.LOOM_PDP_ENFORCE = ORIG;
});

describe('pdpEnforceMode()', () => {
  it('defaults to off when unset', () => {
    delete process.env.LOOM_PDP_ENFORCE;
    expect(pdpEnforceMode()).toBe('off');
  });
  it('parses shadow/enforce case-insensitively, unknown → off', () => {
    process.env.LOOM_PDP_ENFORCE = 'Shadow';
    expect(pdpEnforceMode()).toBe('shadow');
    process.env.LOOM_PDP_ENFORCE = 'ENFORCE';
    expect(pdpEnforceMode()).toBe('enforce');
    process.env.LOOM_PDP_ENFORCE = 'whatever';
    expect(pdpEnforceMode()).toBe('off');
  });
});

describe('pdpCheck() — off', () => {
  it('returns null and NEVER calls authorize', async () => {
    delete process.env.LOOM_PDP_ENFORCE;
    const res = await pdpCheck(SESSION, REF, 'read');
    expect(res).toBeNull();
    expect(authorizeMock).not.toHaveBeenCalled();
  });
});

describe('pdpCheck() — shadow', () => {
  it('with a DENY decision returns null (does not block) and writes an audit row', async () => {
    process.env.LOOM_PDP_ENFORCE = 'shadow';
    authorizeMock.mockResolvedValue(deny());
    const res = await pdpCheck(SESSION, REF, 'read', { legacyAllowed: true });
    expect(res).toBeNull(); // shadow NEVER blocks
    expect(authorizeMock).toHaveBeenCalledOnce();
    expect(createMock).toHaveBeenCalledOnce();
    // divergence: legacy allowed but PDP denied → true
    const row = createMock.mock.calls[0][0];
    expect(row.effect).toBe('deny');
    expect(row.divergence).toBe(true);
    expect(row.kind).toBe('pdp.shadow');
  });

  it('NEVER throws even if authorize() throws — returns null', async () => {
    process.env.LOOM_PDP_ENFORCE = 'shadow';
    authorizeMock.mockRejectedValue(new Error('PDP exploded'));
    const res = await pdpCheck(SESSION, REF, 'read');
    expect(res).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('pdpCheck() — enforce', () => {
  it('with a DENY returns a 403 NextResponse', async () => {
    process.env.LOOM_PDP_ENFORCE = 'enforce';
    authorizeMock.mockResolvedValue(deny());
    const res = await pdpCheck(SESSION, REF, 'admin');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await res!.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('forbidden');
  });

  it('with an ALLOW returns null', async () => {
    process.env.LOOM_PDP_ENFORCE = 'enforce';
    authorizeMock.mockResolvedValue(allow());
    const res = await pdpCheck(SESSION, REF, 'read');
    expect(res).toBeNull();
  });

  it('fails CLOSED (403) when authorize() throws', async () => {
    process.env.LOOM_PDP_ENFORCE = 'enforce';
    authorizeMock.mockRejectedValue(new Error('PDP down'));
    const res = await pdpCheck(SESSION, REF, 'read');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});
