#!/usr/bin/env node
/**
 * Every API route that RETURNS live credential material to the caller must
 * AUTHORIZE, not merely authenticate.
 *
 * WHY THIS EXISTS. `/api/ai-search/service` already carries the rule in a
 * comment — "a getSession-only gate would let any authenticated user read admin
 * keys + rescale the shared service" — and gates itself with
 * `denyIfNoDlzAccess`. That reasoning was never applied to its siblings. An
 * audit of the credential-bearing routes found 5 returning live keys or
 * connection strings for SHARED, env-pinned deployment infrastructure (Event
 * Hubs namespace SAS, Service Bus namespace SAS, Event Grid topic keys, the
 * navigator Cosmos account) behind a session check alone. They are gated now;
 * this guard stops the 6th from shipping.
 *
 * WHAT COUNTS AS AUTHORIZATION. A `getSession()` null-check is authentication:
 * it distinguishes anonymous from signed-in, and nothing else. The same applies
 * to `requireSession()` in app/api/cosmos/_shared, which 401s an anonymous
 * caller and returns null for every signed-in one. Authorization means one of
 * AUTHZ_GUARDS below — a tier, ownership, or policy decision.
 *
 * SCOPE — deliberately narrow, to stay honest. Only routes that put credential
 * material in a RESPONSE are in scope. A route that calls listKeys() and uses
 * the key server-side (to mount a share, to seed a fixture) is NOT exposure, and
 * is exempted by name below with the reason. Widening this to "any route that
 * mentions a key" would produce noise that gets ignored, which is worse than no
 * guard.
 *
 * Usage: node scripts/ci/check-credential-route-authz.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'apps/fiab-console/app/api';

/** Client calls whose return value IS credential material. */
const CREDENTIAL_SINKS = [
  'listAccountKeys', 'listConnectionStrings', 'listNamespaceKeys', 'listEventHubKeys',
  'listTopicKeys', 'listAdminKeys', 'listQueryKeys',
  'regenerateKey', 'regenerateTopicKey', 'regenerateAdminKey',
  'regenerateNamespaceKeys', 'regenerateEventHubAuthRuleKeys', 'regenerateNamespaceAuthRuleKeys',
  'regeneratePrimaryKey', 'regenerateSecondaryKey',
];

/**
 * A real authorization decision — tier, ownership, or policy.
 *
 * Includes the route-toolkit WRAPPERS, not just the bare helpers. This guard
 * originally listed only the helpers and immediately reported three false
 * FAILures when the route-toolkit codemod rewrote `denyIfNoDlzAccess(...)` into
 * `withDlzAccess('scaling', ...)` — the same authorization, expressed the
 * canonical way. A guard that fails the codebase for adopting its own preferred
 * primitive trains people to ignore it.
 *
 * `withSession` is deliberately ABSENT: it is authentication only.
 */
const AUTHZ_GUARDS = [
  'denyIfNoDlzAccess', 'requireTenantAdmin', 'isTenantAdmin', 'canAccessDlzPanes',
  'requireAuthorize', 'requireWorkspace', 'assertOwner', 'assertUserLinkedServiceTarget',
  'withDlzAccess', 'withTenantAdmin', 'withWorkspaceOwner',
];

/**
 * Routes that touch a sink but do NOT return credential material. Each needs a
 * reason that a reviewer can check against the file, not a bare path.
 */
const NOT_EXPOSURE = new Map([
  ['azure/iothub/policies/route.ts',
   'Strips primaryKey/secondaryKey before responding — only policy name + rights leave the server (see the comment at the parse site).'],
  ['admin/mcp-servers/deploy/route.ts',
   'Uses the storage account key server-side to mount the MCP share; the key is never in a response body.'],
  ['lakehouse/shortcuts/route.ts',
   'accountKey here is CALLER-SUPPLIED (creating a shortcut to a foreign account), not read back out of Azure.'],
  ['lakehouse/shortcuts/test/route.ts',
   'Same as shortcuts/route.ts — validates a caller-supplied key, returns only ok/error.'],
  ['items/data-pipeline/practice-seed/route.ts',
   'Seeds fixture data with a server-side key; assertOwner-scoped and returns no key material.'],
  ['items/eventstream/[id]/source/route.ts',
   'Returns the endpoint hostname only; the connection string is consumed server-side.'],
]);

/**
 * Recursive readdir rather than fs.globSync: globSync landed in Node 22 and CI
 * runs Node 20, where the import is a hard SyntaxError. (It failed loudly there,
 * which is the right failure mode for a guard — a scanner that silently matched
 * zero files would have "passed".)
 * Returns POSIX-style paths relative to `dir` so keys compare equal on Windows.
 */
function walk(dir, prefix = '') {
  const out = [];
  for (const e of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, rel));
    else if (e.name === 'route.ts') out.push(rel);
  }
  return out;
}

const offenders = [];
const exempted = [];
const used = new Set();
let scanned = 0;

for (const rel of walk(ROOT)) {
  const path = join(ROOT, rel).replaceAll('\\', '/');
  const src = readFileSync(path, 'utf8');
  const hits = CREDENTIAL_SINKS.filter((s) => new RegExp(`\\b${s}\\s*\\(`).test(src));
  if (hits.length === 0) continue;
  scanned += 1;

  const key = rel.replaceAll('\\', '/');
  if (NOT_EXPOSURE.has(key)) { exempted.push(key); used.add(key); continue; }

  const guarded = AUTHZ_GUARDS.some((g) => src.includes(g));
  if (!guarded) offenders.push([key, hits.slice(0, 3).join(', ')]);
}

console.log(`[credential-route-authz] credential-bearing routes: ${scanned}  ` +
            `(${exempted.length} exempt as non-exposure, ${offenders.length} unguarded)`);

// An exemption that matches nothing is dead config. It is not a failure — a
// route can legitimately be deleted or renamed — but an unreported stale entry
// would quietly grant a future file at that path a free pass.
const stale = [...NOT_EXPOSURE.keys()].filter((k) => !used.has(k));
if (stale.length > 0) {
  console.log(`[credential-route-authz] NOTE — ${stale.length} exemption(s) match no scanned route ` +
              '(the file has no CREDENTIAL_SINKS call). Harmless today; remove when confirmed obsolete:');
  for (const k of stale) console.log(`    ${k}`);
}

if (offenders.length > 0) {
  console.error('\n[credential-route-authz] FAIL — route(s) return credential material behind a session check alone.\n');
  console.error('  getSession()/requireSession() is AUTHENTICATION. Returning live keys for shared,');
  console.error('  env-pinned infrastructure needs AUTHORIZATION — add:\n');
  console.error('      const denied = await denyIfNoDlzAccess(session, \'scaling\');');
  console.error('      if (denied) return denied;\n');
  console.error('  If the route only USES a key server-side and never returns it, add it to');
  console.error('  NOT_EXPOSURE in this guard WITH the reason — that is a security review.\n');
  for (const [f, sinks] of offenders) console.error(`    ${f}\n      sinks: ${sinks}`);
  console.error('');
  process.exit(1);
}

console.log('[credential-route-authz] OK — every credential-returning route authorizes.');
