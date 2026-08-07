/**
 * gate-consumption self-test — the C22 defect, pinned in both directions.
 *
 * WHAT THIS PROTECTS. Loom's returned-value authorization guards
 * (`enforceCapability`, `requireTenantAdmin`, `denyIfNoDlzAccess`, `pdpCheck`,
 * `authorizeItemWorkspace`, `authorizeWorkspace`, `requireWorkspace`) hand back
 * a `NextResponse | null` that the CALLER must short-circuit on. The whole
 * authorization is one line:
 *
 *     const gate = await enforceCapability(session, cap, 'Admin');
 *     if (gate) return gate;                 // ← delete this and it is OPEN
 *
 * Measured 2026-08-07: with that line removed from `app/api/setup/deploy/
 * route.ts` — the route that submits subscription-scoped ARM deployments —
 * `check-route-guards.mjs` still printed `violations: 0`, and so did
 * `check-route-toolkit.mjs` and `check-credential-route-authz.mjs`. The name
 * `enforceCapability` was still in the file, and name-presence was the whole
 * test. Same class as #2977 (`assertOwner` surviving as a COMMENT kept 34
 * routes green), fixed there for one symbol and left live for every other.
 *
 * MUTATION-PROVEN. The MUTANT cases below are the defect in each of its shapes;
 * every one is RED against the analyzer. The REAL cases are the exact
 * consumption shapes found in the shipped tree (transcribed from the routes,
 * not invented) and every one is GREEN — so an over-broad analyzer that simply
 * flags every gate call cannot pass this file either. Both directions matter:
 * a guard that flags everything gets allowlisted into uselessness.
 *
 * Run: node --test scripts/ci/__tests__/gate-consumption.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { findDiscardedGateResults, stripCommentsAndStrings } from '../_gate-consumption.mjs';

// ── The defect: a gate whose answer goes nowhere ─────────────────────────────

test('MUTANT: the `if (gate) return gate;` branch is cut (setup/deploy shape)', () => {
  const hits = findDiscardedGateResults(`
    import { enforceCapability } from '@/lib/auth/feature-gate';
    export async function POST(req) {
      const session = getSession();
      const gate = await enforceCapability(session, 'admin.deploy-dlz', 'Admin');
      const body = await req.json();
      return NextResponse.json({ ok: true, body });
    }`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].gate, 'enforceCapability');
  assert.match(hits[0].reason, /never returned\/thrown/);
});

test('MUTANT: the gate is called as a bare statement', () => {
  const hits = findDiscardedGateResults(`
    export async function POST(req) {
      await enforceCapability(session, 'admin.x', 'Admin');
      return NextResponse.json({ ok: true });
    }`);
  assert.equal(hits.length, 1);
  assert.match(hits[0].reason, /thrown away/);
});

test('MUTANT: tested, but the consequent does not return — the request proceeds', () => {
  const hits = findDiscardedGateResults(`
    export async function POST(req) {
      const gate = await enforceCapability(session, 'admin.x', 'Admin');
      if (gate) { logSafe('denied', { cap: 'admin.x' }); }
      return NextResponse.json({ ok: true });
    }`);
  assert.equal(hits.length, 1);
});

test('MUTANT: every returned-value gate is covered, not just enforceCapability', () => {
  // The #2977 lesson: fixing ONE symbol leaves the class live. These six share
  // the identical `NextResponse | null` contract and the identical hole.
  const shapes = [
    ['requireTenantAdmin', 'const g = requireTenantAdmin(session);'],
    ['denyIfNoDlzAccess', "const d = await denyIfNoDlzAccess(session, 'scaling');"],
    ['pdpCheck', "const p = await pdpCheck(session, res, 'read');"],
    ['authorizeItemWorkspace', "const a = await authorizeItemWorkspace(session, { itemId: id, itemType: 't', notFound: 'x' });"],
    ['authorizeWorkspace', 'const w = await authorizeWorkspace(session, workspaceId);'],
  ];
  for (const [name, line] of shapes) {
    const hits = findDiscardedGateResults(`
      export async function POST(req) {
        ${line}
        return NextResponse.json({ ok: true });
      }`);
    assert.equal(hits.length, 1, `${name} should be flagged when discarded`);
    assert.equal(hits[0].gate, name);
  }
});

test('MUTANT: requireWorkspace destructured with `resp` ignored', () => {
  const hits = findDiscardedGateResults(`
    export async function POST(req) {
      const { session, resp } = await requireWorkspace(workspaceId);
      return NextResponse.json({ ok: true, who: session.claims.oid });
    }`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].gate, 'requireWorkspace');
});

test('MUTANT: a sibling handler consuming its own gate does not cover this one', () => {
  // Scope-bounded: `const gate` in GET must be consumed IN GET. A whole-file
  // search would let a correct POST launder a broken GET.
  const hits = findDiscardedGateResults(`
    export async function GET(req) {
      const gate = await enforceCapability(session, 'admin.x', 'Admin');
      return NextResponse.json({ ok: true });
    }
    export async function POST(req) {
      const gate = await enforceCapability(session, 'admin.x', 'Admin');
      if (gate) return gate;
      return NextResponse.json({ ok: true });
    }`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 3);
});

// ── Not the defect: every consumption shape that exists in the shipped tree ──

test('REAL: `const gate = …; if (gate) return gate;` — the dominant idiom', () => {
  assert.deepEqual(findDiscardedGateResults(`
    export async function POST(req) {
      const gate = await enforceCapability(session, 'admin.deploy-dlz', 'Admin');
      if (gate) return gate;
      return NextResponse.json({ ok: true });
    }`), []);
});

test('REAL: audit the denial, then return it (catalog/unity/governance)', () => {
  assert.deepEqual(findDiscardedGateResults(`
    export const POST = withSession(async (req, { session }) => {
      const denied = await enforceCapability(session, GOVERNANCE_CAPABILITY, requiredRole);
      if (denied) {
        await writeUcGovernanceDenial({ tenantId, capability: GOVERNANCE_CAPABILITY });
        return denied;
      }
      return apiOk({});
    });`), []);
});

test('REAL: tested INLINE as the if condition (experience/warp/transforms)', () => {
  assert.deepEqual(findDiscardedGateResults(`
    export async function POST(req) {
      if (await authorizeWorkspace(session, workspaceId)) return err('Workspace not found', 404, 'not_found');
      return NextResponse.json({ ok: true });
    }`), []);
});

test('REAL: compound inline test whose consequent ASSIGNS (thread/kql-query-to-dashboard-tile)', () => {
  // The consequent adopts the item only when authorized — enforcement without a
  // `return`. Requiring a return here would have been a false positive.
  assert.deepEqual(findDiscardedGateResults(`
    export async function POST(req) {
      let src = await loadKustoItem(id, type, oid);
      if (!src) {
        const any = await loadKustoItemUnscoped(id, type);
        if (any && !(await authorizeWorkspace(session, any.workspaceId, { allowReadRoles: true }))) {
          src = any;
        }
      }
      return NextResponse.json({ ok: true, src });
    }`), []);
});

test('REAL: a ternary that WITHHOLDS data rather than rejecting (items/event-grid-topic)', () => {
  // The gate suppresses the access KEYS while the rest of the detail pane still
  // renders. The answer is consumed; it just is not consumed by a `return`.
  assert.deepEqual(findDiscardedGateResults(`
    export async function GET(req) {
      const s2 = getSession();
      const keysDenied = s2 ? await denyIfNoDlzAccess(s2, 'scaling') : null;
      const [t, keys] = await Promise.all([
        getEventGridTopic(topic),
        keysDenied ? Promise.resolve(null) : listTopicKeys(topic),
      ]);
      return NextResponse.json({ ok: true, t, keys, ...(keysDenied ? { keysWithheld: 'x' } : {}) });
    }`), []);
});

test('REAL: the gate is returned directly', () => {
  assert.deepEqual(findDiscardedGateResults(`
    export async function POST(req) {
      return (await enforceCapability(session, 'admin.x', 'Admin')) ?? NextResponse.json({ ok: true });
    }`), []);
});

test('REAL: requireWorkspace destructured with `resp` returned', () => {
  assert.deepEqual(findDiscardedGateResults(`
    export async function POST(req) {
      const { session, resp } = await requireWorkspace(workspaceId);
      if (resp) return resp;
      return NextResponse.json({ ok: true, who: session.claims.oid });
    }`), []);
});

// ── #2977: prose is not code ────────────────────────────────────────────────

test('a guard name in a COMMENT or a STRING is not a call and cannot be flagged', () => {
  assert.deepEqual(findDiscardedGateResults(`
    export const GET = withTenantAdmin(async (req, { session }) => {
      // Composition: withSession answers 401, enforceCapability(session, cap) answers 403.
      /* enforceCapability(session, 'admin.x', 'Admin') used to run here. */
      const msg = "call enforceCapability(session, cap) to gate this";
      const tpl = \`or enforceCapability(session, \${cap})\`;
      return NextResponse.json({ ok: true, msg, tpl });
    });`), []);
});

test('stripCommentsAndStrings preserves length and line structure', () => {
  const src = "const a = 1; // enforceCapability(x)\nconst b = 'enforceCapability(y)';\n/* z\n   z */\nconst c = 3;\n";
  const out = stripCommentsAndStrings(src);
  assert.equal(out.length, src.length, 'byte offsets must stay exact');
  assert.equal(out.split('\n').length, src.split('\n').length, 'line numbers must stay exact');
  assert.ok(!/enforceCapability/.test(out), 'the name must not survive in comments or strings');
  assert.match(out, /const a = 1;/);
  assert.match(out, /const c = 3;/);
});

test('a template-literal INTERPOLATION is code and is still analyzed', () => {
  // `${...}` is executable; blanking it would create a blind spot.
  const out = stripCommentsAndStrings('const s = `x ${await enforceCapability(a, b)} y`;');
  assert.match(out, /enforceCapability\(a, b\)/);
});

test('REGEX LITERALS are lexed — an odd number of quotes must not eat the file', () => {
  // apps/fiab-console/app/api/items/dataflow/profile/route.ts:176 carries
  // `/^"((?:[^"]|"")*)"$/` — FIVE quote characters. Treated as code, the 5th
  // opens a string state that blanked 40+ lines including that route's
  // getSession() and its `export async function POST`, silently dropping the
  // route from the checker's remit. Blanked code is invisible code.
  const src = [
    'function parseMStr(tok) {',
    '  const m = tok.trim().match(/^"((?:[^"]|"")*)"$/);',
    '  return m ? m[1].replace(/""/g, \'"\') : undefined;',
    '}',
    'export async function POST(req) {',
    '  const session = getSession();',
    '  const gate = await enforceCapability(session, "admin.x", "Admin");',
    '  if (gate) return gate;',
    '  return NextResponse.json({ ok: true });',
    '}',
  ].join('\n');
  const out = stripCommentsAndStrings(src);
  assert.match(out, /export async function POST/, 'the handler export must survive');
  assert.match(out, /getSession\(\)/, 'the session call must survive');
  assert.match(out, /enforceCapability\(session,/, 'the gate call must survive');
  assert.deepEqual(findDiscardedGateResults(src), [], 'and the consumed gate must not be flagged');
});

test('`return /re/` is a REGEX, not division — the keyword must survive the space', () => {
  // `prevWord` used to be cleared by the whitespace AFTER `return`, so
  // `return /[",\n]/.test(s)` lexed as division and the `"` inside the character
  // class opened a runaway string state.
  const out = stripCommentsAndStrings('function f(s) { return /[",\\n]/.test(s); }\nconst x = getSession();');
  assert.match(out, /const x = getSession\(\);/, 'code after the regex must survive');
});

test('division is NOT mistaken for a regex literal', () => {
  const out = stripCommentsAndStrings('const ratio = total / count; const y = getSession();');
  assert.match(out, /const ratio = total \/ count;/);
  assert.match(out, /getSession\(\)/);
});

test('keepStrings:true blanks comments ONLY — string data survives', () => {
  // GATE_RE (`'not_configured'`) and BACKEND_IMPORT_RE (`from '@/lib/azure/…'`)
  // legitimately match string literals: that is data the route really carries,
  // not prose about it. Blanking strings for those signals took the route
  // inventory's "Gated (backend config)" count from 531 to 308 — a 42% phantom
  // drop in a security-adjacent table.
  const src = [
    "// prose mentioning not_configured and @/lib/azure/adf-client",
    "import { runPipeline } from '@/lib/azure/adf-client';",
    "const err = { code: 'not_configured' };",
  ].join('\n');
  const kept = stripCommentsAndStrings(src, { keepStrings: true });
  assert.match(kept, /'@\/lib\/azure\/adf-client'/, 'import specifiers must survive');
  assert.match(kept, /'not_configured'/, 'error codes must survive');
  assert.doesNotMatch(kept.split('\n')[0], /not_configured|adf-client/, 'but the COMMENT must not');

  const stripped = stripCommentsAndStrings(src);
  assert.doesNotMatch(stripped, /not_configured/, 'default mode still blanks strings');
  assert.equal(kept.length, src.length, 'length is preserved in both modes');
});
