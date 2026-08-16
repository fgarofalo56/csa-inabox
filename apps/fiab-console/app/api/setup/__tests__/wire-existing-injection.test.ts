/**
 * Security regression tests for POST /api/setup/wire-existing (GHSA-fj7j-qq8g-hqj8).
 *
 * The defect: request fields (`domainName`, `location`, `subscriptionId`) were
 * concatenated into a resource-group name and interpolated into command strings
 * passed to `execSync()`. `execSync` evaluates its argument with `/bin/sh -c`, so
 * a `;`, `$(…)`, backtick or newline in any of those fields was parsed as shell
 * syntax and executed as the console process.
 *
 * These tests pin BOTH directions:
 *
 *   - a payload carrying shell metacharacters is REFUSED (400) and never reaches
 *     a child process, for every injection-relevant field;
 *   - a legitimate setup value still resolves and still runs the wiring scripts,
 *     with the coordinates arriving intact;
 *   - the values that DO cross the process boundary cross it as `env` entries on
 *     an argv-array spawn with `shell: false` — never inside a command string.
 *
 * NOTE ON PLATFORM (why the exec layer is asserted, not executed):
 * `execSync`/`spawnSync` pick the shell from the platform. On Windows that is
 * `cmd.exe`, where `;` is NOT a command separator — so a payload that is inert
 * on this developer workstation is live on the Linux runtime image the console
 * actually ships as. The assertions below therefore inspect the CALL SHAPE
 * (argv array, `shell: false`, values in `env`) rather than depending on the
 * host shell's grammar. That property is platform-independent: with no shell in
 * the loop there is no grammar in which a metacharacter can be re-parsed.
 *
 * No test in this file contacts Azure or runs a real wiring script.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── session: an authenticated tenant admin (so the capability gate passes and
//    the tests exercise the validation / resolution / exec path, not the 403) ──
const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'oid-test', upn: 'admin@t.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  tenantScopeId: (s: any) => s?.claims?.tid ?? s?.claims?.oid,
}));

// The route enforces `admin.deploy-dlz`, which reads the feature-permissions
// container. Default: no grants — tenant-admin bypass (LOOM_TENANT_ADMIN_OID)
// is what lets the happy-path tests through.
let featureGrants: any[] = [];
vi.mock('@/lib/azure/cosmos-client', () => ({
  featurePermissionsContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: featureGrants }) }) },
  }),
}));

vi.mock('@/lib/auth/obo', () => ({
  getArmTokenPreferUser: async () => ({ token: 'arm-token', identity: 'uami' }),
}));

// ── the sink under test: child_process is STUBBED, so nothing is ever executed ──
const spawnSyncMock = vi.fn(() => ({ status: 0, stdout: '', stderr: '', signal: null, error: undefined }) as any);
const execSyncMock = vi.fn(() => Buffer.from(''));
vi.mock('node:child_process', () => ({
  spawnSync: (...a: any[]) => spawnSyncMock(...a),
  execSync: (...a: any[]) => execSyncMock(...a),
  execFileSync: vi.fn(),
}));
vi.mock('child_process', () => ({
  spawnSync: (...a: any[]) => spawnSyncMock(...a),
  execSync: (...a: any[]) => execSyncMock(...a),
  execFileSync: vi.fn(),
}));

// The wiring scripts are not present in a test tree; make the existence check
// pass so the exec layer is genuinely reached and observable.
vi.mock('node:fs', async (orig) => {
  const actual = (await orig()) as any;
  return { ...actual, default: { ...actual.default, existsSync: () => true }, existsSync: () => true };
});

const ADMIN_SUB = '11111111-2222-3333-4444-555555555555';
const DLZ_SUB = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** A Resource Graph response listing one real DLZ resource group. */
function stubResourceGraph(rows: Array<{ name: string; subscriptionId: string; location: string }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ data: rows }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })),
  );
}

function postReq(body: any) {
  return { url: 'http://x/api/setup/wire-existing', json: async () => body } as any;
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    boundary: 'GCC',
    subscriptionId: ADMIN_SUB,
    location: 'eastus',
    selectedExistingDlzs: [{ subscriptionId: DLZ_SUB, domainName: 'finance' }],
    ...overrides,
  };
}

beforeEach(() => {
  featureGrants = [];
  process.env.LOOM_TENANT_ADMIN_OID = 'oid-test';
  process.env.LOOM_WIRE_SCRIPTS_DIR = '/tmp/loom-test-scripts';
  spawnSyncMock.mockClear();
  execSyncMock.mockClear();
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test', upn: 'admin@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
  stubResourceGraph([{ name: 'rg-csa-loom-dlz-finance-eastus', subscriptionId: DLZ_SUB, location: 'eastus' }]);
});

afterEach(() => {
  delete process.env.LOOM_TENANT_ADMIN_OID;
  delete process.env.LOOM_WIRE_SCRIPTS_DIR;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('POST /api/setup/wire-existing — command injection (GHSA-fj7j-qq8g-hqj8)', () => {
  // Each payload is the shape that escaped the `az group show …` command string
  // in the vulnerable revision. `;` terminates a command, `$(…)` and backticks
  // substitute one, `\n` starts one, `|`/`&&` chain one.
  const INJECTION_PAYLOADS: Array<[string, string]> = [
    ['semicolon', 'x;echo pwned'],
    ['command substitution', 'x$(echo pwned)'],
    ['backticks', 'x`echo pwned`'],
    ['newline', 'x\necho pwned'],
    ['pipe', 'x|echo pwned'],
    ['logical and', 'x&&echo pwned'],
    ['redirect', 'x>/tmp/pwned'],
    ['quote break-out', "x' ; echo pwned ; '"],
  ];

  it.each(INJECTION_PAYLOADS)(
    'refuses a domainName carrying %s, and spawns nothing',
    async (_label, payload) => {
      const { POST } = await import('../wire-existing/route');
      const res = await POST(postReq(validBody({
        selectedExistingDlzs: [{ subscriptionId: DLZ_SUB, domainName: payload }],
      })));

      expect(res.status).toBe(400);
      const j = await res.json();
      expect(j.ok).toBe(false);
      expect(String(j.error)).toMatch(/domainName/);
      // The load-bearing assertion: no child process was created at all.
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(execSyncMock).not.toHaveBeenCalled();
    },
  );

  it.each(INJECTION_PAYLOADS)(
    'refuses a location carrying %s, and spawns nothing',
    async (_label, payload) => {
      const { POST } = await import('../wire-existing/route');
      const res = await POST(postReq(validBody({ location: payload })));

      expect(res.status).toBe(400);
      const j = await res.json();
      expect(String(j.error)).toMatch(/location/);
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(execSyncMock).not.toHaveBeenCalled();
    },
  );

  it.each(INJECTION_PAYLOADS)(
    'refuses a subscriptionId carrying %s, and spawns nothing',
    async (_label, payload) => {
      const { POST } = await import('../wire-existing/route');
      const res = await POST(postReq(validBody({ subscriptionId: `${ADMIN_SUB}${payload}` })));

      expect(res.status).toBe(400);
      const j = await res.json();
      expect(String(j.error)).toMatch(/subscriptionId/);
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(execSyncMock).not.toHaveBeenCalled();
    },
  );

  it('refuses the exact advisory payload (`x;id>/tmp/poc_output;#`) before any exec', async () => {
    const { POST } = await import('../wire-existing/route');
    const res = await POST(postReq(validBody({
      selectedExistingDlzs: [{ subscriptionId: DLZ_SUB, domainName: 'x;id>/tmp/poc_output;#' }],
    })));

    expect(res.status).toBe(400);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('never calls execSync — the shell-interpreting sink is gone from the route', async () => {
    const { POST } = await import('../wire-existing/route');
    await POST(postReq(validBody()));
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).toHaveBeenCalled();
  });
});

describe('POST /api/setup/wire-existing — legitimate setup values still work', () => {
  it('resolves a real DLZ and runs both wiring scripts', async () => {
    const { POST } = await import('../wire-existing/route');
    const res = await POST(postReq(validBody()));

    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.wireResults).toHaveLength(1);
    expect(j.wireResults[0].success).toBe(true);
    // The resource group is the one Resource Graph returned.
    expect(j.wireResults[0].dlzRg).toBe('rg-csa-loom-dlz-finance-eastus');
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it('passes coordinates as env on an argv-array spawn with shell:false', async () => {
    const { POST } = await import('../wire-existing/route');
    await POST(postReq(validBody()));

    // Assert the population FIRST. A `for` loop over zero recorded calls passes
    // every assertion inside it vacuously, which would make this a check that
    // cannot fail — the exact shape of gate this repo has been bitten by before.
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);

    for (const call of spawnSyncMock.mock.calls) {
      const [cmd, args, opts] = call as unknown as [string, string[], any];

      // argv form: the command is a bare binary name and the arguments are a
      // pre-split array — no command string exists for a shell to re-parse.
      expect(cmd).toBe('bash');
      expect(Array.isArray(args)).toBe(true);
      expect(opts.shell).toBe(false);

      // The coordinates travel as environment values, not as argv text.
      expect(opts.env.SUB).toBe(ADMIN_SUB);
      expect(opts.env.DLZ_RG).toBe('rg-csa-loom-dlz-finance-eastus');
      expect(args.join(' ')).not.toContain(ADMIN_SUB);
      expect(args.join(' ')).not.toContain('DLZ_RG=');
    }
  });

  it('runs exactly the two allow-listed wiring scripts', async () => {
    const { POST } = await import('../wire-existing/route');
    await POST(postReq(validBody()));

    const scripts = spawnSyncMock.mock.calls.map((c: any) => String(c[1][0]));
    expect(scripts.some((s) => s.endsWith('grant-navigator-rbac.sh'))).toBe(true);
    expect(scripts.some((s) => s.endsWith('patch-navigator-env.sh'))).toBe(true);
    expect(scripts).toHaveLength(2);
  });

  it('accepts a hyphenated domain name (a legitimate value the allow-list must not reject)', async () => {
    stubResourceGraph([
      { name: 'rg-csa-loom-dlz-supply-chain-eastus2', subscriptionId: DLZ_SUB, location: 'eastus2' },
    ]);
    const { POST } = await import('../wire-existing/route');
    const res = await POST(postReq(validBody({
      location: 'eastus2',
      selectedExistingDlzs: [{ subscriptionId: DLZ_SUB, domainName: 'supply-chain' }],
    })));

    expect(res.status).toBe(200);
    expect((await res.json()).wireResults[0].dlzRg).toBe('rg-csa-loom-dlz-supply-chain-eastus2');
  });
});

describe('POST /api/setup/wire-existing — resolution against real estate state', () => {
  it('refuses a DLZ that Resource Graph does not report, and spawns nothing', async () => {
    stubResourceGraph([]); // the caller can see no DLZ resource groups
    const { POST } = await import('../wire-existing/route');
    const res = await POST(postReq(validBody()));

    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.wireResults[0].success).toBe(false);
    expect(j.wireResults[0].dlzRg).toBe('');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('uses the Azure-reported resource group even when it differs from the concatenated guess', async () => {
    // Resource Graph reports the DLZ in eastus2; the request says eastus. The
    // old code would have built `…-finance-eastus` from request text. The fix
    // uses what Azure actually returned.
    stubResourceGraph([
      { name: 'rg-csa-loom-dlz-finance-eastus2', subscriptionId: DLZ_SUB, location: 'eastus2' },
    ]);
    const { POST } = await import('../wire-existing/route');
    const res = await POST(postReq(validBody({ location: 'eastus' })));

    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.wireResults[0].dlzRg).toBe('rg-csa-loom-dlz-finance-eastus2');
    expect(spawnSyncMock.mock.calls[0][2].env.DLZ_RG).toBe('rg-csa-loom-dlz-finance-eastus2');
  });
});

describe('POST /api/setup/wire-existing — authorization', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('../wire-existing/route');
    const res = await POST(postReq(validBody()));

    expect(res.status).toBe(401);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('403 when an authenticated caller lacks admin.deploy-dlz — the advisory\'s "any signed-in user" path', async () => {
    delete process.env.LOOM_TENANT_ADMIN_OID; // not a tenant admin
    featureGrants = []; // and no delegated grant
    getSessionMock.mockReturnValue({
      claims: { oid: 'ordinary-user', upn: 'user@t.com' },
      exp: Date.now() / 1000 + 3600,
    } as any);

    const { POST } = await import('../wire-existing/route');
    const res = await POST(postReq(validBody()));

    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.error).toBe('forbidden');
    expect(j.capability).toBe('admin.deploy-dlz');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
