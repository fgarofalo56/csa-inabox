#!/usr/bin/env node
/**
 * WS-D3 — API route inventory / taxonomy generator.
 * ------------------------------------------------------------------------
 * Scans apps/fiab-console/app/api/**\/route.ts and emits a diffable taxonomy at
 * docs/fiab/route-inventory.md classifying every route by:
 *   - area          — the top-level /api/<area> segment (owner domain),
 *   - methods        — exported HTTP verbs (GET/POST/PUT/PATCH/DELETE),
 *   - auth scope     — public | session-only | owner-scoped | admin,
 *   - gate behavior  — whether the route honest-gates on a backend config,
 *   - backends       — the Azure/data-plane client modules it depends on.
 *
 * The session / admin / gate / backend heuristics deliberately MIRROR
 * scripts/ci/check-route-guards.mjs (same signals, same classic + WS-D1 toolkit
 * `export const GET = withWorkspaceOwner(…)` export styles) so the two agree on
 * what a route is.
 *
 * ── THE OWNER COLUMN IS NO LONGER A NAME LIST (#3625) ──────────────────────
 * `OWNER_RE` used to decide `owner-scoped` from a regex over the file, and one
 * of its alternatives was the bare token `claims\.oid`. Measured on `main` at
 * 9cc1a397: **271 of the 773 published `owner-scoped` rows rested on a
 * `claims.*` token and NOTHING else** — a caller oid used as a log field, a
 * FinOps attribution field, or a Cosmos partition key, none of which is an
 * authorization decision. Four were confirmed by hand, including
 * `items/azure-sql-database/[id]/mirroring`, which published `owner-scoped`
 * while it was an ACTIVE P0 data-exfiltration primitive: the column an operator
 * would scan reported the hole as fixed.
 *
 * That verdict now comes from `_route-auth-scope.mjs`, which DERIVES the
 * authorization-resolver set from the tree (import closure from a seeded root
 * primitive, plus the inline owner-comparison form) and asks whether the route
 * REACHES one, rather than whether a name appears. The derived set is published
 * in this document, so adding a resolver shows up in the diff naming its module.
 *
 * ── THE BACKEND COLUMN IS NO LONGER A NAME MAP EITHER (#3592) ──────────────
 * `BACKEND_LABEL` was the same construct one column over: a hand-maintained
 * `<loom module name> -> <backend tag>` object literal, consumed as
 * `.map((m) => BACKEND_LABEL[m[1]]).filter(Boolean)`. That `.filter(Boolean)`
 * SILENTLY DROPPED every module the map did not know, and the route then
 * published `—`, i.e. "touches no backend". Measured on `main` at b9ca620b:
 * the map held 26 entries against **378** distinct `@/lib/azure/*` modules that
 * routes import, and **one of its entries (`keyvault-client`) was imported by
 * zero routes** while the module 19 routes actually use to reach Key Vault was
 * absent — so it looked like it covered Key Vault while covering none of it.
 * It published a false document four times (#3499, #3529, Wave 0, #3581), every
 * one found by a human reading a regenerated diff and none by the gate.
 *
 * That column now comes from `_route-backends.mjs`, which derives the reach
 * from the CALL graph seeded on identifiers MICROSOFT owns — ARM resource
 * provider namespaces, data-plane DNS suffixes, client SDK packages. A new Loom
 * client needs no entry anywhere; a new AZURE SERVICE is detected generically
 * and FAILS this generator naming itself. "Touches no backend" is asserted, not
 * defaulted to: a client module that makes a network call and cannot be named
 * stops the build (deploy-integrity.md R7).
 *
 * A route whose scope cannot be ESTABLISHED is reported as `unknown` and this
 * generator EXITS 1 (deploy-integrity.md R7) — it does not fall back to the
 * reassuring answer, which is exactly what the old default did.
 *
 * USAGE:
 *   node scripts/ci/generate-route-inventory.mjs            # (re)write the doc
 *   node scripts/ci/generate-route-inventory.mjs --check    # CI drift gate (exit 1 if stale)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripCommentsAndStrings } from './_gate-consumption.mjs';
import {
  buildGraph,
  deriveResolvers,
  deriveSessionFns,
  assertSeedsExist,
  classifyRouteOwnership,
  ROOT_AUTHORIZERS,
  SESSION_ROOTS,
  AUTH_SHAPED_EXEMPT,
  selfTest,
} from './_route-auth-scope.mjs';
import {
  deriveBackendReach,
  classifyRouteBackends,
  unnamedClientModules,
  unpopulatedSeeds,
  staleModuleReferences,
  labelFor,
  ARM_PROVIDER_BACKEND,
  HOST_SUFFIX_BACKEND,
  PACKAGE_BACKEND,
  NOT_A_BACKEND,
  PROPAGATION_CUTS,
  CLIENT_WITHOUT_AZURE_IDENTIFIER,
  selfTest as backendSelfTest,
} from './_route-backends.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONSOLE_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');
const API_ROOT = path.join(CONSOLE_ROOT, 'app', 'api');
const DOC_PATH = path.join(REPO_ROOT, 'docs', 'fiab', 'route-inventory.md');

// ── detection (mirrors check-route-guards.mjs) ───────────────────────────────
const METHOD_RES = {
  GET: /export\s+(?:async\s+function\s+GET\b|const\s+GET\s*=)/,
  POST: /export\s+(?:async\s+function\s+POST\b|const\s+POST\s*=)/,
  PUT: /export\s+(?:async\s+function\s+PUT\b|const\s+PUT\s*=)/,
  PATCH: /export\s+(?:async\s+function\s+PATCH\b|const\s+PATCH\s*=)/,
  DELETE: /export\s+(?:async\s+function\s+DELETE\b|const\s+DELETE\s*=)/,
};
const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * A route is session-checked if it calls getSession() or is wrapped by one of the
 * toolkit HOCs.
 *
 * `(?:<[^(]*>)?` matters: the toolkit wrappers are GENERIC, and the real call
 * shape is often `withSession<{ id: string }>(...)`. Without it the regex sees
 * `withSession` followed by `<` rather than `(`, fails to match, and the route
 * is classified **public** — i.e. the inventory reports a PROTECTED route as
 * unprotected.
 *
 * Caught live: the boy-scout codemod migrated 34 routes to `withSession<T>(`
 * and this table's "Public (no session)" count jumped 117 -> 124, naming seven
 * genuinely-authenticated routes as public. A security inventory that
 * under-reports protection is not merely noisy — it trains readers to ignore
 * the `public` column, which is the column that matters. `[^(]*` rather than
 * `[^>]*` so nested generics (`<Foo<Bar>>`) still match.
 *
 * C22 (#3088): check-route-guards.mjs had the SAME bug and had NOT learned this
 * lesson — its `GETSESSION_RE` was still the bare `\s*\(` form, so the 104
 * routes calling `withSession<{ id: string }>(…)` were in its remit only via
 * their header COMMENTS ("Route-toolkit: withSession (R1/R3)"). Fixed there
 * too; the note is left here because this file caught it first and the checker
 * did not, which is the whole argument for keeping the two in lockstep.
 */
const SESSION_RE = /getSession\s*\(|with(?:Session|WorkspaceOwner|BackendGate|TenantAdmin|DlzAccess|Capability|BoundSqlServer|OwnedSqlItem)\s*(?:<[^(]*>)?\s*\(|(?:authorize(?:NotebookItem|DatabricksJobItem|DatabricksPipelineItem)|guardAdxItemRequest|guardSynapseItemRequest)\s*(?:<[^(]*>)?\s*\(/;

/**
 * OWNER_RE IS GONE (#3625) — READ THIS BEFORE ADDING A NAME LIST BACK.
 *
 * It was a 30-name regex, and three of the names were the bare tokens
 * `claims.oid` / `claims.tid` / `claims.tenantId`. Measured on `main` at
 * 9cc1a397, over comment-stripped code, with ADMIN precedence already applied:
 *
 *     owner-scoped rows                              773
 *     …resting ONLY on a claims.* token              271
 *
 * i.e. 35% of this document's owner column was reporting a LOG FIELD, a FinOps
 * attribution field or a Cosmos partition key as an authorization check. The
 * four hand-confirmed cases are recorded in _route-auth-scope.mjs's header; the
 * worst was `items/azure-sql-database/[id]/mirroring`, which read `owner-scoped`
 * while it was an active P0 exfiltration primitive.
 *
 * The list ALSO under-reported, and that half is why the replacement DERIVES
 * rather than lists: a dozen `_lib/*` and `_shared` modules wrap the canonical
 * guards under local names, and every one had to be hand-added here AFTER a
 * route using it published the wrong scope. This file's own history carries four
 * such notes in a row — `guardAdxItemRequest`, `guardSynapseItemRequest`,
 * `withBoundSqlServer`, `loadOwnedSqlItem` — each recording the same lesson and
 * each learned only once the damage was visible.
 *
 * The replacement is `_route-auth-scope.mjs`: it derives the resolver set from
 * the import graph, asks whether the route REACHES one, and FAILS on a route it
 * cannot establish instead of defaulting to the reassuring answer. The derived
 * set is published in this document (§Authorization resolvers), so a new wrapper
 * appears in the diff naming its module rather than silently moving 27 rows.
 *
 * Do not reintroduce a name list here. If a resolver is missing it is missing
 * from the DERIVATION — seed it, or make it consume a seeded root.
 *
 * LOCKSTEP with check-route-guards.mjs still holds for SESSION_RE / ADMIN_RE
 * below, which are unchanged. `GUARD_SIGNAL_RE` over there answers a different
 * question ("is this route guarded at all"); a control in
 * __tests__/route-auth-scope.test.mjs asserts every ownership name that file
 * lists is present in the set this one derives, so the two cannot drift APART
 * without failing.
 */
const ADMIN_RE = new RegExp([
  'requireTenantAdmin', 'isTenantAdmin', 'isTenantAdminTier', 'requireDomainRole',
  'enforceCapability', 'canAccessDlzPanes', 'isAtLeastDomainAdmin',
  'isAtLeastDomainContributor', 'callerIsOpsAdmin',
  // R1 route-toolkit wrappers (mirror withWorkspaceOwner in OWNER_RE):
  // withTenantAdmin runs requireTenantAdmin internally; withDlzAccess runs
  // denyIfNoDlzAccess (tenant-admin-or-domain-admin) internally.
  'withTenantAdmin', 'withDlzAccess',
  // C22 (#3088): withCapability runs enforceCapability internally — the
  // NON-DISCARDABLE form of `const gate = await enforceCapability(…);
  // if (gate) return gate;`, whose branch could be deleted while the name (and
  // therefore this classification) survived. Its substance is asserted by
  // check-route-guards.assertGuardWrappersAreReal().
  'withCapability',
].join('|'));

const GATE_RE = /ConfigGate\s*\(|withBackendGate\s*\(|apiHonestGateError\s*\(|backendGateResponse\s*\(|gateStatus\s*\(|assertFabricFamilyAvailable|not_configured|not configured/;

/**
 * BACKEND_LABEL IS GONE (#3592) — READ THIS BEFORE ADDING A NAME MAP BACK.
 *
 * It was `{ 'adf-client': 'ADF', 'kusto-client': 'ADX', … }` — 26 entries keyed
 * on LOOM MODULE NAMES — consumed as:
 *
 *     [...dataSrc.matchAll(BACKEND_IMPORT_RE)].map((m) => BACKEND_LABEL[m[1]]).filter(Boolean)
 *
 * Measured on `main` at b9ca620b, over `app/api/**\/route.ts`:
 *
 *     distinct @/lib/azure modules imported by routes      378
 *     BACKEND_LABEL entries                                 26
 *     …imported by at least one route                        25
 *     …imported by ZERO routes                                1   (`keyvault-client`)
 *
 * The `.filter(Boolean)` is the mechanism: an unmapped module yielded
 * `undefined` and was dropped with no signal, so the row read `—` — "touches no
 * backend". It shipped a false document FOUR times (#3499 `data-quality-client`,
 * #3529 `azure-sql-client`, Wave 0 `kv-secrets-client` on 19 routes, #3581
 * `model-serving-client` on 6), each found by a human reading a regenerated
 * diff. And it could not follow a delegation at all (#3545): 24 routes reached
 * Azure SQL through `sql-objects-client` -> `azure-sql-client` and published `—`
 * even though the latter WAS in the map.
 *
 * The replacement is `_route-backends.mjs`: the seeds are identifiers Microsoft
 * owns (ARM provider namespaces, data-plane DNS suffixes, SDK packages), the
 * reach is derived over the CALL graph, and an Azure identifier the vocabulary
 * does not know FAILS this generator naming the module it was seeded in. The
 * derived module→backend set is published in this document, so a client that
 * starts reaching a new service appears in the diff.
 *
 * Do not reintroduce a module-name map here. If a backend is missing it is
 * missing from the DERIVATION — the client's endpoint is assembled somewhere the
 * call graph cannot follow, and that is what `CLIENT_WITHOUT_AZURE_IDENTIFIER`
 * (and the B2 assertion that polices it) is for.
 */

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.next') continue;
      walk(full, out);
    } else if (e.name === 'route.ts') {
      out.push(full);
    }
  }
  return out;
}

function relApi(f) {
  // repo-relative POSIX path from app/api, e.g. 'items/copy-job/[id]/route.ts'
  return path.relative(API_ROOT, f).split(path.sep).join('/');
}

function classify(raw, relPath, ownership, backendsOf) {
  // C22 (#3088): classify the AUTH signals from CODE, not from prose. Every one
  // is a NAME, and a name survives in a comment long after the code is gone —
  // that is #2977, which this file's own OWNER_RE tombstone records for
  // `assertOwner`. Removing `assertOwner` fixed one symbol; stripping comments
  // and string literals closes the mechanism for all of them at once.
  const src = stripCommentsAndStrings(raw);
  // …but GATE_RE legitimately matches STRING LITERALS — `code: 'not_configured'`
  // is data the route really carries, not prose about it. It gets comments-only
  // stripping. MEASURED: blanking strings for it took "Gated (backend config)"
  // from 531 to 308 by erasing every `'not_configured'` — a 42% phantom drop in
  // a security-adjacent table. A comment is never code; a string sometimes is.
  const dataSrc = stripCommentsAndStrings(raw, { keepStrings: true });
  const methods = METHOD_ORDER.filter((m) => METHOD_RES[m].test(src));
  const isAdminPath = relPath.startsWith('admin/');
  // SESSION_RE is the lockstep signal shared with check-route-guards.mjs;
  // `ownership.session` is the DERIVED one, which only ever adds. Removing the
  // bogus `claims.oid` owner token dropped 13 `app/api/adx/*` routes to
  // **public** because their session lives inside `guardAdxRequest`, a wrapper
  // SESSION_RE does not know — a false claim in the most safety-critical column,
  // created by the fix. See SESSION_ROOTS in _route-auth-scope.mjs.
  const hasSession = SESSION_RE.test(src) || ownership.session;
  const hasAdmin = ADMIN_RE.test(src) || isAdminPath;
  const gated = GATE_RE.test(dataSrc);

  let scope;
  if (hasAdmin) scope = 'admin';
  else if (ownership.owner) scope = 'owner-scoped';
  else if (ownership.unknowns.length) scope = 'unknown';
  else if (hasSession) scope = 'session-only';
  else scope = 'public';

  // An unknown that lands on a route the ADMIN column already covers cannot
  // change what a reader concludes, so it is not raised. `admin/workspaces/
  // [id]/networking/*` is the live instance: `authorizeNetworking` resolves
  // through `resolveAdminWorkspace`, and those 14 routes publish `admin` either
  // way. Reporting them would be an annotation that fires when nothing is wrong.
  const unknowns = scope === 'unknown' ? ownership.unknowns : [];

  const area = relPath.split('/')[0] || '(root)';
  return {
    relPath,
    area,
    methods,
    scope,
    gated,
    backends: backendsOf.backends,
    identifiers: backendsOf.identifiers,
    backendUnknowns: backendsOf.unknowns,
    unknowns,
    why: ownership.why,
  };
}

/**
 * Build the module graph ONCE, derive the resolver set AND the backend reach,
 * then classify.
 *
 * The graph covers every tracked `.ts`/`.tsx` under `apps/fiab-console`, not
 * just the routes, because the whole point of both columns is that what a route
 * does usually lives one or more modules away.
 */
function buildRows() {
  const graph = buildGraph({ repoRoot: REPO_ROOT });

  // The seeds are asserted BEFORE anything is derived from them. #2977 is what
  // happens when a signal name outlives the function it names: the derivation
  // would quietly produce a tiny resolver set and every route would drop a tier.
  const badSeeds = [...assertSeedsExist(graph), ...staleModuleReferences(graph)];
  if (badSeeds.length) {
    for (const b of badSeeds) console.error(`::error::[route-inventory] SEED MISSING — ${b}`);
    console.error(
      '::error::[route-inventory] the owner and backend columns are derived FROM these primitives. With one ' +
        'missing the derivation cannot be trusted, so this generator refuses to publish rather than emit a ' +
        'document in which every route looks less protected, or less connected, than it is (#2977, #3625, #3592).',
    );
    process.exit(1);
  }

  const resolvers = deriveResolvers(graph);
  const sessionFns = deriveSessionFns(graph);
  const backendReach = deriveBackendReach(graph);
  const files = walk(API_ROOT).sort();
  const routeKeys = files.map((f) => path.relative(REPO_ROOT, f).split(path.sep).join('/'));
  const rows = files.map((f, i) => {
    const rel = routeKeys[i];
    return classify(
      fs.readFileSync(f, 'utf8'),
      relApi(f),
      classifyRouteOwnership(graph, resolvers, rel, sessionFns),
      classifyRouteBackends(graph, backendReach, rel),
    );
  });
  return { rows, resolvers, sessionFns, backendReach, routeKeys, graph, routeCount: files.length, graphSize: graph.files.length };
}

function esc(s) { return String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|'); }

function render(rows, resolvers, backendReach) {
  const byArea = new Map();
  const scopeCounts = { public: 0, 'session-only': 0, 'owner-scoped': 0, admin: 0, unknown: 0 };
  let gatedCount = 0;
  for (const r of rows) {
    if (!byArea.has(r.area)) byArea.set(r.area, []);
    byArea.get(r.area).push(r);
    scopeCounts[r.scope] += 1;
    if (r.gated) gatedCount += 1;
  }

  const lines = [];
  lines.push('# CSA Loom — API route inventory (WS-D3)');
  lines.push('');
  lines.push('> GENERATED — do not edit by hand.');
  lines.push('> Regenerate: `node scripts/ci/generate-route-inventory.mjs`.');
  lines.push('> CI drift gate: `node scripts/ci/generate-route-inventory.mjs --check`.');
  lines.push('');
  lines.push('Taxonomy of every `apps/fiab-console/app/api/**/route.ts` — classified by');
  lines.push('auth scope, gate behavior, and backend dependency. Session / admin / gate /');
  lines.push('backend detection mirrors `scripts/ci/check-route-guards.mjs`. The **owner**');
  lines.push('verdict is DERIVED, not name-matched — see "How the owner column is decided".');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('| --- | ---: |');
  lines.push(`| Total routes | ${rows.length} |`);
  lines.push(`| Public (no session) | ${scopeCounts.public} |`);
  lines.push(`| Session-only | ${scopeCounts['session-only']} |`);
  lines.push(`| Owner-scoped | ${scopeCounts['owner-scoped']} |`);
  lines.push(`| Admin | ${scopeCounts.admin} |`);
  lines.push(`| Unknown (generator fails) | ${scopeCounts.unknown} |`);
  lines.push(`| Gated (backend config) | ${gatedCount} |`);
  lines.push(`| Areas | ${byArea.size} |`);
  lines.push('');
  lines.push('**Auth scope** — `public`: no session check; `session-only`: signed-in but');
  lines.push('no per-resource authz; `owner-scoped`: the route reaches an owner/workspace-ACL');
  lines.push('decision about the caller; `admin`: tenant/domain-admin gate; `unknown`: the');
  lines.push('generator could not establish the scope and FAILED rather than guess.');
  lines.push('**Gated** = the route honest-gates on a backend being configured (see');
  lines.push('`docs/fiab/gate-registry.md`).');
  lines.push('**Backends** = every backend the route REACHES through the call graph. `—` is');
  lines.push('an assertion, not a default — see "How the backend column is decided".');
  lines.push('');
  lines.push('## How the owner column is decided');
  lines.push('');
  lines.push('Until #3625 this column came from a regex of ~30 names, three of which were');
  lines.push('the bare tokens `claims.oid` / `claims.tid` / `claims.tenantId`. Measured on');
  lines.push('`main` at 9cc1a397: **271 of 773 `owner-scoped` rows rested on a `claims.*`');
  lines.push('token and nothing else** — a log field, a FinOps attribution field or a Cosmos');
  lines.push('partition key reported as an authorization check. One of them,');
  lines.push('`items/azure-sql-database/[id]/mirroring`, read `owner-scoped` while it was an');
  lines.push('active P0 exfiltration primitive.');
  lines.push('');
  lines.push('A route is now `owner-scoped` when it **reaches** an authorization decision:');
  lines.push('');
  lines.push('1. it calls a symbol that resolves — module-qualified, through the import');
  lines.push('   graph — to a member of the derived resolver set below, from a span');
  lines.push('   reachable from an exported HTTP verb, and the answer is not discarded');
  lines.push('   (`scripts/ci/_gate-consumption.mjs`); **or**');
  lines.push('2. it compares the caller identity against a stored owner field and refuses.');
  lines.push('');
  lines.push('The resolver set is DERIVED, not listed: a function qualifies when its body');
  lines.push('reaches a seeded root primitive and consumes the answer, or makes the same');
  lines.push('comparison itself. Seeds:');
  lines.push('');
  for (const r of ROOT_AUTHORIZERS) lines.push(`- owner: \`${esc(r.module)}::${esc(r.symbol)}\``);
  for (const r of SESSION_ROOTS) lines.push(`- session: \`${esc(r.module)}::${esc(r.symbol)}\``);
  lines.push('');
  lines.push('The **session** signal is derived the same way, in addition to the shared');
  lines.push('`SESSION_RE` list. It only ever adds: removing the bogus owner token dropped 13');
  lines.push('`adx/*` routes to `public` because their session lives inside `guardAdxRequest`,');
  lines.push('a wrapper that list does not name.');
  lines.push('');
  lines.push('What this does NOT claim: that the decision is the RIGHT one (correct item,');
  lines.push('correct role) — that needs a per-route read. Scope is per FILE, not per method.');
  lines.push('Full statement of limits: `scripts/ci/_route-auth-scope.mjs` header.');
  lines.push('');
  lines.push('## How the backend column is decided');
  lines.push('');
  lines.push('Until #3592 this column came from `BACKEND_LABEL`, a hand-maintained map from a');
  lines.push('Loom client MODULE NAME to a backend tag, consumed through `.filter(Boolean)` —');
  lines.push('so a module absent from the map was **silently dropped** and its route published');
  lines.push('`—`, "touches no backend". Measured on `main` at b9ca620b: the map held **26');
  lines.push('entries against 378 distinct `@/lib/azure/*` modules that routes import**, and');
  lines.push('one of its entries (`keyvault-client`) was imported by **zero** routes while the');
  lines.push('module 19 routes use to reach Key Vault was absent — it looked like it covered');
  lines.push('Key Vault while covering none of it. It published a false document four times');
  lines.push('(#3499, #3529, Wave 0, #3581), each found by a human reading a regenerated diff.');
  lines.push('');
  lines.push('A route now reaches a backend when a function reachable from an exported HTTP');
  lines.push('verb **names that backend**, or calls a function that does. "Names" means one of');
  lines.push('three identifiers that belong to Microsoft, not to Loom:');
  lines.push('');
  lines.push('1. an ARM resource-provider namespace (`providers/Microsoft.Kusto/…`);');
  lines.push('2. a data-plane / AAD-scope DNS suffix (`*.kusto.windows.net`);');
  lines.push('3. a client SDK package (`@azure/cosmos`, `mssql`).');
  lines.push('');
  lines.push('So adding a Loom client requires **no edit to any table** — a new');
  lines.push('`lib/azure/*-client.ts` that builds a `Microsoft.Kusto` path derives ADX on the');
  lines.push('commit that adds it. What DOES stop the build is Loom reaching an Azure service');
  lines.push('this vocabulary has never seen: the detector is generic (any `Microsoft.*`, any');
  lines.push('host under a Microsoft cloud DNS namespace, any `@azure/*` package), so it is');
  lines.push('SEEN, fails to translate, and names itself.');
  lines.push('');
  lines.push('**`—` is an assertion.** A route publishes it only when every module it reaches');
  lines.push('that makes a network call has been named — by the derivation, or in the table');
  lines.push('below with the verdict read at its definition. A client that talks to something');
  lines.push('the analyzer cannot name FAILS this generator (`deploy-integrity.md` R7). That');
  lines.push('remit is the whole route-reachable set, not one directory: scoped to');
  lines.push('`lib/azure/**` it missed a client under `lib/integrations/` calling a real IoT');
  lines.push('Hub data plane. It is per MODULE, though — a route that reaches only the');
  lines.push('config-reading function of a module whose OTHER functions name a backend can');
  lines.push('still publish `—` without tripping anything.');
  lines.push('');
  lines.push('Two string-level filters keep help text out of the column, and both were');
  lines.push('measured rather than assumed. **Prose**: a host preceded by whitespace is a');
  lines.push('sentence, not an endpoint. **Placeholder examples**: a host in a string that');
  lines.push('also carries a `<template-token>` is an admin fill-in-the-blank. The second');
  lines.push('was the larger — `lib/admin/env-checks/core.ts`\'s `VALUE_HINT` table put a');
  lines.push('backend on **92 routes** attributable to nothing else, including **Power BI on');
  lines.push('79 routes** from the single literal');
  lines.push('`powerbi://api.powerbi.com/v1.0/myorg/<workspace>`.');
  lines.push('');
  lines.push('What this does NOT claim: that the route calls the backend on EVERY request — a');
  lines.push('branch behind a feature flag or an error path counts, which is the honest');
  lines.push('direction for a dependency column. Reach is per FILE, not per method. Dynamic');
  lines.push('dispatch is invisible to it. Full limits: `scripts/ci/_route-backends.mjs`.');
  lines.push('');

  for (const area of [...byArea.keys()].sort()) {
    const areaRows = byArea.get(area).slice().sort((a, b) => a.relPath.localeCompare(b.relPath));
    lines.push(`## ${esc(area)}`);
    lines.push('');
    lines.push('| Route | Methods | Auth scope | Gated | Backends |');
    lines.push('| --- | --- | --- | :---: | --- |');
    for (const r of areaRows) {
      lines.push(
        `| \`${esc(r.relPath)}\` | ${r.methods.join(' ') || '—'} | ${r.scope} | ${r.gated ? '●' : ''} | ${esc(r.backends.join(', ')) || '—'} |`,
      );
    }
    lines.push('');
  }

  // The derived resolver set, PUBLISHED. This is what makes "someone added an
  // authorization helper" visible: the set changes, the drift gate fails, and
  // the diff names the module. A set that lived only in memory would move rows
  // with no reviewable artifact — which is how 27 ADX rows carried
  // `guardAdxRequest`'s name for months without anyone reading its body.
  const byModule = new Map();
  for (const key of resolvers) {
    const i = key.lastIndexOf('::');
    const [mod, sym] = [key.slice(0, i), key.slice(i + 2)];
    if (!byModule.has(mod)) byModule.set(mod, []);
    byModule.get(mod).push(sym);
  }
  lines.push('## Authorization resolvers (derived)');
  lines.push('');
  lines.push(`${resolvers.size} function(s) across ${byModule.size} module(s) reach an owner / workspace-ACL`);
  lines.push('decision. Derived by `scripts/ci/_route-auth-scope.mjs` from the seeds above —');
  lines.push('nothing here is hand-maintained. A change to this list in a diff means the');
  lines.push('authorization surface moved.');
  lines.push('');
  lines.push('| Module | Resolvers |');
  lines.push('| --- | --- |');
  for (const mod of [...byModule.keys()].sort()) {
    lines.push(`| \`${esc(mod)}\` | ${byModule.get(mod).sort().map((s) => `\`${esc(s)}\``).join(', ')} |`);
  }
  lines.push('');
  lines.push('### Authorization-shaped names that are NOT owner checks');
  lines.push('');
  lines.push('Each was read at its definition. A call to an authorization-shaped name that is');
  lines.push('neither derived nor listed here fails the generator (#3625) rather than');
  lines.push('silently downgrading the route.');
  lines.push('');
  lines.push('| Symbol | Why it is not an owner check |');
  lines.push('| --- | --- |');
  for (const name of [...AUTH_SHAPED_EXEMPT.keys()].sort()) {
    lines.push(`| \`${esc(name)}\` | ${esc(AUTH_SHAPED_EXEMPT.get(name))} |`);
  }
  lines.push('');

  // ── The derived BACKEND sets, PUBLISHED (#3592, same reason as above) ─────
  // A module that starts reaching a new service shows up HERE, in a diff,
  // naming itself — instead of a row quietly gaining or losing a label.
  const originModules = new Map();
  for (const [id, files] of backendReach.origins) {
    const label = labelFor(id);
    if (!label) continue;
    for (const f of files) {
      if (!originModules.has(f)) originModules.set(f, new Set());
      originModules.get(f).add(label);
    }
  }
  lines.push('## Backend signals (derived)');
  lines.push('');
  lines.push(`${originModules.size} module(s) ORIGINATE a backend label — the derivation read an`);
  lines.push('Azure identifier out of them. Every other route/module below inherits through the');
  lines.push('call graph. Nothing in this section is a Loom module name someone typed: the');
  lines.push('modules are derived, and only the Microsoft-owned identifier vocabulary is seeded.');
  lines.push('');
  lines.push('### The seeded vocabulary');
  lines.push('');
  lines.push('| Identifier | Backend |');
  lines.push('| --- | --- |');
  for (const [k, v] of [...ARM_PROVIDER_BACKEND].sort()) lines.push(`| \`${esc(k)}\` (ARM provider) | ${esc(v)} |`);
  for (const [k, v] of [...HOST_SUFFIX_BACKEND].sort()) lines.push(`| \`*.${esc(k)}\` (host) | ${esc(v)} |`);
  for (const [k, v] of [...PACKAGE_BACKEND].sort()) lines.push(`| \`${esc(k)}\` (package) | ${esc(v)} |`);
  lines.push('');
  lines.push('An identifier of one of those THREE SHAPES that is in neither this table nor the');
  lines.push('next fails the generator naming the module it was found in. Every entry above is');
  lines.push('asserted to have at least one occurrence in the tree — a signal with no');
  lines.push('population verifies nothing, which is exactly how `keyvault-client` sat in the');
  lines.push('old map covering zero routes while Key Vault went unreported on 19.');
  lines.push('');
  lines.push('### Detected identifiers that are NOT a backend dependency');
  lines.push('');
  lines.push('| Identifier | What it actually is |');
  lines.push('| --- | --- |');
  for (const [k, v] of [...NOT_A_BACKEND].sort()) lines.push(`| \`${esc(k)}\` | ${esc(v)} |`);
  lines.push('');
  lines.push('### Clients whose backend the code does not name');
  lines.push('');
  lines.push('The B2 residue: modules that make a network call and carry no Azure identifier,');
  lines.push('because the host only exists in deployment configuration — or because they are');
  lines.push('not an Azure service at all. Each was read at its definition. **A module in');
  lines.push('this state that is NOT listed here fails the generator** — which is what makes');
  lines.push('`—` an assertion rather than the default an absent map entry fell into.');
  lines.push('');
  lines.push('| Module | Backend | Read at its definition |');
  lines.push('| --- | --- | --- |');
  for (const [k, v] of [...CLIENT_WITHOUT_AZURE_IDENTIFIER].sort()) {
    lines.push(`| \`${esc(k)}\` | ${v.backend ? esc(v.backend) : '— (none)'} | ${esc(v.why)} |`);
  }
  lines.push('');
  lines.push('### Propagation cuts');
  lines.push('');
  lines.push('A cut can only ever REMOVE a label, which is the direction that produced #3592,');
  lines.push('so there is one and its full measured effect is stated here — not just its');
  lines.push('headline. Emptying it and re-deriving over the whole tree: **1,213 row');
  lines.push('label-sets shrink** (Azure Monitor drops off 1,179, **Cosmos off 352**), **0');
  lines.push('labels are added**, and **0 rows publish `—` solely because of it**. The test');
  lines.push('caps the NUMBER of cuts at three; it does not bound what one cut can hide.');
  lines.push('');
  lines.push('| Module | Why its reach does not propagate to callers |');
  lines.push('| --- | --- |');
  for (const [k, v] of [...PROPAGATION_CUTS].sort()) lines.push(`| \`${esc(k)}\` | ${esc(v)} |`);
  lines.push('');
  lines.push('### Modules that originate a backend label (derived)');
  lines.push('');
  lines.push('| Module | Backends |');
  lines.push('| --- | --- |');
  for (const mod of [...originModules.keys()].sort()) {
    lines.push(`| \`${esc(mod)}\` | ${[...originModules.get(mod)].sort().map((b) => esc(b)).join(', ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Compare IGNORING `\r`. The generator always writes LF; on a Windows checkout
 * with `core.autocrlf=true` the working-tree file is CRLF, so a byte compare
 * failed on EVERY Windows tree regardless of content — a phantom the operator
 * chased more than once (#3550 item 2). Normalising cannot mask real drift:
 * both sides are compared after the same transform, and the writer never emits
 * CR, so a CR difference is a checkout artifact and nothing else.
 */
const eol = (s) => s.replace(/\r\n/g, '\n');

function main() {
  const check = process.argv.includes('--check');

  // CONTROLS FIRST. A taxonomy from a classifier that has stopped classifying is
  // not a taxonomy — and the controls that matter here are the NEGATIVE ones (an
  // oid used as a log field, a partition key, a name in a comment, a host in a
  // comment, a doc link, a credential SDK), because a control set without them
  // passes on the exact trees that produced #3625 and #3592.
  const controlFailures = [
    ...selfTest().map((f) => `[auth] ${f}`),
    ...backendSelfTest().map((f) => `[backend] ${f}`),
  ];
  if (controlFailures.length) {
    for (const f of controlFailures) console.error(`::error::[route-inventory] EMBEDDED CONTROL FAILED — ${f}`);
    console.error(
      '::error::[route-inventory] a classifier has drifted; a document produced by it would mean nothing. ' +
        'Refusing to publish (scripts/ci/_route-auth-scope.mjs + _route-backends.mjs CONTROLS).',
    );
    process.exit(1);
  }

  const { rows, resolvers, backendReach, routeKeys, graph, graphSize } = buildRows();

  // UNKNOWNS FAIL. deploy-integrity.md R7: a generator that cannot establish a
  // route's auth scope says so. The old default picked `session-only`, i.e. the
  // reassuring answer, and the whole of #3625 is what a reassuring default costs.
  const unknownRows = rows.filter((r) => r.scope === 'unknown');
  if (unknownRows.length) {
    for (const r of unknownRows) {
      for (const u of r.unknowns) {
        console.error(
          `::error file=apps/fiab-console/app/api/${r.relPath},line=${u.line}::[route-inventory] ` +
            `UNKNOWN auth scope — ${u.note} (module: ${u.module})`,
        );
      }
    }
    console.error(
      `::error::[route-inventory] ${unknownRows.length} route(s) have an auth scope this generator cannot ` +
        'establish. Resolve each one — seed a ROOT_AUTHORIZER, make the helper consume one, or record it in ' +
        'AUTH_SHAPED_EXEMPT with the reason you read at its definition — in scripts/ci/_route-auth-scope.mjs. ' +
        'Publishing a guess here is the defect #3625 exists to end.',
    );
    process.exit(1);
  }

  // B1 — an Azure identifier the vocabulary has never seen. The same rule, one
  // column over: an unrecognised backend must NAME ITSELF, never publish `—`.
  const backendUnknowns = new Map();
  for (const r of rows) {
    for (const u of r.backendUnknowns) {
      if (!backendUnknowns.has(u.identifier)) backendUnknowns.set(u.identifier, { note: u.note, module: u.module, routes: [] });
      backendUnknowns.get(u.identifier).routes.push(r.relPath);
    }
  }
  // B2 — a client that talks to the network and cannot be named.
  const unnamed = unnamedClientModules(graph, backendReach, routeKeys);
  // B3 — a seeded identifier NO ROUTE INHERITS, the `keyvault-client` shape.
  // Population is REACH, not textual occurrence: a seed kept alive by one
  // display string in a module no route reaches is the defect, not the control.
  const dead = unpopulatedSeeds(new Set(rows.flatMap((r) => r.identifiers)));

  if (backendUnknowns.size || unnamed.length || dead.length) {
    for (const [id, info] of backendUnknowns) {
      console.error(
        `::error file=${info.module}::[route-inventory] UNKNOWN BACKEND \`${id}\` — reaches ${info.routes.length} ` +
          `route(s), e.g. ${info.routes[0]}. ${info.note}`,
      );
    }
    for (const f of unnamed) {
      console.error(
        `::error file=${f}::[route-inventory] UNNAMED CLIENT — this module makes a network call, a route reaches ` +
          'it, and the derivation cannot name a backend for it. Publishing `—` here would be the #3592 defect. ' +
          'Read it at its definition and record it in CLIENT_WITHOUT_AZURE_IDENTIFIER (scripts/ci/' +
          '_route-backends.mjs) — with the backend it reaches, or with `backend: null` and why.',
      );
    }
    for (const id of dead) {
      console.error(
        `::error::[route-inventory] SIGNAL WITH ZERO POPULATION — \`${id}\` is seeded in _route-backends.mjs and ` +
          'occurs NOWHERE in the tree. That is the `keyvault-client` shape: a vocabulary entry that looks like ' +
          'coverage while covering nothing. Delete it — if the service comes back, the generic detector will ' +
          'name it as an unknown.',
      );
    }
    console.error(
      '::error::[route-inventory] the backend column cannot be published truthfully in this state (#3592).',
    );
    process.exit(1);
  }

  const content = render(rows, resolvers, backendReach);
  if (check) {
    let current = '';
    try { current = fs.readFileSync(DOC_PATH, 'utf8'); } catch { /* missing → stale */ }
    if (eol(current) !== eol(content)) {
      console.error('[route-inventory] FAIL — docs/fiab/route-inventory.md is out of date.');
      console.error('Run: node scripts/ci/generate-route-inventory.mjs');
      process.exit(1);
    }
    console.log(
      `[route-inventory] OK — inventory up to date (${rows.length} routes, ` +
        `${resolvers.size} derived resolvers, ${graphSize} console sources analysed).`,
    );
    process.exit(0);
  }
  fs.mkdirSync(path.dirname(DOC_PATH), { recursive: true });
  fs.writeFileSync(DOC_PATH, content, 'utf8');
  console.log(
    `[route-inventory] wrote ${path.relative(REPO_ROOT, DOC_PATH)} (${rows.length} routes, ` +
      `${resolvers.size} derived resolvers, ${graphSize} console sources analysed).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
