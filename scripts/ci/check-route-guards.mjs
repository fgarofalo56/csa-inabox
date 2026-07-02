#!/usr/bin/env node
/**
 * GUARDRAIL: route-guards  (merge-blocker)
 * ------------------------------------------------------------------------
 * RULE: a BFF route that reads or mutates another user's / tenant's data
 *   must authorize the CALLER against that data — not merely confirm the
 *   caller is signed in. `getSession()` alone answers "is someone logged
 *   in", NOT "is THIS user allowed to touch THIS resource". A route that
 *   point-reads / writes a resource by an id taken from the URL with only a
 *   `getSession()` 401 check is a cross-tenant hole: any signed-in user can
 *   pass any id.  (This is exactly the security-roles cross-tenant read that
 *   shipped and was fixed by threading `loadOwnedItem`.)
 *
 * SCOPE (the two directories where this hole class lives):
 *   - apps/fiab-console/app/api/items/[type]/[id]/**\/route.ts
 *       the GENERIC per-item handlers — they operate on ANY Cosmos-owned
 *       item by (type, id) and MUST scope to the owner/tenant.
 *   - apps/fiab-console/app/api/admin/**\/route.ts
 *       admin surfaces — must gate on a tenant-admin / capability check, not
 *       just a logged-in session.
 *   (Per-item-TYPE routes like items/adf-dataset/[id] target a single shared
 *   Azure resource in the deployment — auth = signed-in + deployment RBAC —
 *   so they are intentionally out of scope here.)
 *
 * WHAT COUNTS AS AUTHORIZED (any one of these signals in the handler file):
 *   - a named owner/tenant/admin guard:
 *       loadOwnedItem, updateOwnedItem, deleteOwnedItem, assertOwner,
 *       authorizeWorkspace, requireWorkspace, requireTenantAdmin,
 *       isTenantAdmin, isTenantAdminTier, requireDomainRole, enforceCapability
 *   - the caller identity threaded into the data access:
 *       session.claims.oid / .tid / .tenantId  (owner-scoped Cosmos reads)
 *   - a domain / DLZ / policy gate:
 *       denyIfNoDlzAccess, pdpCheck, loadContentBackedItem
 *
 * A route is FLAGGED when it exports a mutating handler (POST/PUT/PATCH/
 * DELETE) OR a GET (returns data), calls getSession(), matches NONE of the
 * signals above, and is not in the ALLOWLIST below.
 *
 * HOW TO ADD AN ALLOWLIST ENTRY:
 *   Only for routes that legitimately need no per-resource authorization —
 *   e.g. a handler that operates on a SHARED Azure backend resolved purely by
 *   item TYPE (no per-tenant Cosmos ownership to check), or a self/public
 *   endpoint. Add the repo-relative path to ALLOWLIST with a one-line reason.
 *   Prefer FIXING the route (thread `loadOwnedItem` / an admin gate) over
 *   allowlisting — allowlisting an ownable resource re-opens the hole.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONSOLE_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');

const GENERIC_ITEM_DIR = path.join(CONSOLE_ROOT, 'app', 'api', 'items', '[type]', '[id]');
const ADMIN_DIR = path.join(CONSOLE_ROOT, 'app', 'api', 'admin');

const GUARD_SIGNAL_RE = new RegExp(
  [
    'loadOwnedItem', 'updateOwnedItem', 'deleteOwnedItem', 'assertOwner',
    'authorizeWorkspace', 'requireWorkspace', 'requireTenantAdmin',
    'isTenantAdmin', 'isTenantAdminTier', 'requireDomainRole', 'enforceCapability',
    'denyIfNoDlzAccess', 'pdpCheck', 'loadContentBackedItem',
    'claims\\.oid', 'claims\\.tid', 'claims\\.tenantId',
  ].join('|'),
);

const MUTATING_EXPORT_RE = /export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\b/;
const GET_EXPORT_RE = /export\s+async\s+function\s+GET\b/;
const GETSESSION_RE = /getSession\s*\(/;

// ── Allowlist: routes that legitimately need no per-resource authorization.
// Repo-relative POSIX paths. Each MUST carry a reason.
const ALLOWLIST = new Map([
  // Generic per-item handlers that operate on a SHARED Azure backend resolved
  // by item TYPE (warehouse/AOAI/etc.) — no per-tenant Cosmos ownership to
  // scope; gated by getSession + a type gate.
  ['apps/fiab-console/app/api/items/[type]/[id]/alerts/route.ts', 'analytics alerts over a shared Azure backend resolved by item type'],
  ['apps/fiab-console/app/api/items/[type]/[id]/assist/route.ts', 'AOAI assist resolved by item type; no per-tenant Cosmos read'],
  ['apps/fiab-console/app/api/items/[type]/[id]/monitoring/route.ts', 'read-only monitoring over a shared Azure backend resolved by item type'],
  ['apps/fiab-console/app/api/items/[type]/[id]/optimize/route.ts', 'optimize action over a shared Azure backend resolved by item type'],
  ['apps/fiab-console/app/api/items/[type]/[id]/security/route.ts', 'security-scan over a shared Azure backend resolved by item-type gate'],
  ['apps/fiab-console/app/api/items/[type]/[id]/sql-security/route.ts', 'SQL security over a shared Azure backend resolved by item-type gate'],
  ['apps/fiab-console/app/api/items/[type]/[id]/statistics/route.ts', 'read-only statistics over a shared Azure backend resolved by item type'],

  // Admin routes gated by getSession + org-scoped Cosmos queries (every read
  // binds the caller tenant) or reading deployment-wide config only.
  ['apps/fiab-console/app/api/admin/bootstrap-catalogs/route.ts', 'seeds deployment-wide catalogs; org-scoped, admin surface'],
  ['apps/fiab-console/app/api/admin/copilot-usage/route.ts', 'tenant-scoped usage read; org aggregate'],
  ['apps/fiab-console/app/api/admin/data-products-backend/route.ts', 'deployment-wide backend config read'],
  ['apps/fiab-console/app/api/admin/deploy-plan/cost-estimate/route.ts', 'stateless cost estimator; no per-tenant data'],
  ['apps/fiab-console/app/api/admin/domains/images/route.ts', 'org-scoped domain image read'],
  ['apps/fiab-console/app/api/admin/domains/purview-status/route.ts', 'deployment-wide Purview status read'],
  ['apps/fiab-console/app/api/admin/load-sample-data/route.ts', 'loads sample data into the deployment ADX; admin surface'],
  ['apps/fiab-console/app/api/admin/mcp-servers/bridge/route.ts', 'deployment-wide MCP bridge config'],
  ['apps/fiab-console/app/api/admin/mcp-servers/builtin/route.ts', 'static built-in MCP catalog read'],
  ['apps/fiab-console/app/api/admin/mcp-servers/test-connection/route.ts', 'stateless connectivity probe; no per-tenant data'],
  ['apps/fiab-console/app/api/admin/tenant-settings/groups/route.ts', 'ambient-tenant group read (Graph); tenant is from the token'],
]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
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

function rel(f) {
  return path.relative(REPO_ROOT, f).split(path.sep).join('/');
}

function main() {
  const files = [...walk(GENERIC_ITEM_DIR), ...walk(ADMIN_DIR)];
  const violations = [];
  let scanned = 0;

  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const hasMutating = MUTATING_EXPORT_RE.test(src);
    const hasGet = GET_EXPORT_RE.test(src);
    if (!hasMutating && !hasGet) continue; // no data surface to guard
    if (!GETSESSION_RE.test(src)) continue; // not session-based; out of this check's remit
    scanned++;
    if (GUARD_SIGNAL_RE.test(src)) continue; // authorized
    const r = rel(f);
    if (ALLOWLIST.has(r)) continue; // intentional shared/self route
    violations.push(r);
  }

  console.log(`[route-guards] scanned ${scanned} session-based item/admin routes`);
  console.log(`[route-guards] allowlisted intentional routes: ${ALLOWLIST.size}`);
  console.log(`[route-guards] violations: ${violations.length}`);
  if (violations.length) {
    console.error('\n[route-guards] FAIL — these routes are gated only by getSession() with no');
    console.error('owner/tenant/admin authorization (potential cross-tenant access):');
    for (const v of violations) console.error(`  - ${v}`);
    console.error('\nFix: thread `loadOwnedItem(id, type, session.claims.oid)` (item routes) or an');
    console.error('admin gate (`requireTenantAdmin` / `isTenantAdmin` / `enforceCapability`) so the');
    console.error('caller is authorized against the specific resource. If the route legitimately');
    console.error('needs no per-resource check (shared Azure backend resolved by type, or a self/');
    console.error('public endpoint), add it to ALLOWLIST in scripts/ci/check-route-guards.mjs with a reason.');
    process.exit(1);
  }
  console.log('[route-guards] OK — every session-based item/admin route is authorized or allowlisted.');
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
