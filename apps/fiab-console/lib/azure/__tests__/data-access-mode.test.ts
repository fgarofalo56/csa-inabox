/**
 * data-access-mode — verifies the DORMANT OBO switchboard:
 *   - off (default): shared UAMI, no OBO attempt
 *   - shadow: shared UAMI is still returned (creds never switch), OBO attempt logged
 *   - on (no assertion): shared UAMI fallback
 *   - obo-token-store honest gate when LOOM_OBO_CLIENT_ID/secret unset
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const SAVED = { ...process.env };

// uamiArmCredential is mocked so the test never touches @azure/identity / ACA.
vi.mock('../arm-credential', () => ({
  uamiArmCredential: () => ({ __shared: true, getToken: async () => ({ token: 'shared', expiresOnTimestamp: 0 }) }),
}));

async function load() {
  vi.resetModules();
  return import('../data-access-mode');
}

afterEach(() => {
  process.env = { ...SAVED };
  vi.restoreAllMocks();
});

describe('oboMode', () => {
  it('defaults to off and coerces unknown values to off', async () => {
    delete process.env.LOOM_OBO_DATA_PLANE;
    let m = await load();
    expect(m.oboMode()).toBe('off');
    process.env.LOOM_OBO_DATA_PLANE = 'bogus';
    m = await load();
    expect(m.oboMode()).toBe('off');
    process.env.LOOM_OBO_DATA_PLANE = 'shadow';
    m = await load();
    expect(m.oboMode()).toBe('shadow');
  });
});

describe('getDataPlaneCredential', () => {
  it('off → shared UAMI (default, identical)', async () => {
    delete process.env.LOOM_OBO_DATA_PLANE;
    const m = await load();
    const c: any = await m.getDataPlaneCredential({ userAssertion: 'a' }, 'scope');
    expect(c.__shared).toBe(true);
  });

  it('shadow → shared UAMI, logs without an assertion', async () => {
    process.env.LOOM_OBO_DATA_PLANE = 'shadow';
    const m = await load();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c: any = await m.getDataPlaneCredential({}, 'scope');
    expect(c.__shared).toBe(true);
    expect(spy).toHaveBeenCalled();
  });

  it('on without assertion → shared UAMI fallback', async () => {
    process.env.LOOM_OBO_DATA_PLANE = 'on';
    const m = await load();
    const c: any = await m.getDataPlaneCredential({}, 'scope');
    expect(c.__shared).toBe(true);
  });
});

describe('obo-token-store honest gate', () => {
  beforeEach(() => { delete process.env.LOOM_OBO_CLIENT_ID; delete process.env.LOOM_OBO_CLIENT_SECRET; });
  it('throws OboNotConfiguredError when OBO app reg unset', async () => {
    vi.resetModules();
    const s = await import('../obo-token-store');
    expect(s.isOboConfigured()).toBe(false);
    await expect(s.acquireOboToken('assertion', 'scope')).rejects.toThrow(/not configured/i);
  });
});
