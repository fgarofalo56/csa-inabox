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
 * The detection heuristics deliberately MIRROR scripts/ci/check-route-guards.mjs
 * (same session / owner-guard / admin signals, same classic + WS-D1 toolkit
 * `export const GET = withWorkspaceOwner(…)` export styles) so the two agree on
 * what a route is.
 *
 * USAGE:
 *   node scripts/ci/generate-route-inventory.mjs            # (re)write the doc
 *   node scripts/ci/generate-route-inventory.mjs --check    # CI drift gate (exit 1 if stale)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

const SESSION_RE = /getSession\s*\(|with(?:Session|WorkspaceOwner|BackendGate|TenantAdmin|DlzAccess)\s*\(/;

const OWNER_RE = new RegExp([
  'loadOwnedItem', 'updateOwnedItem', 'deleteOwnedItem', 'createOwnedItem',
  'softDeleteOwnedItem', 'restoreOwnedItem', 'purgeRecycledItem', 'loadRecycledItem',
  'listOwnedItems', 'listAllOwnedItems', 'assertOwner', 'authorizeWorkspace',
  'requireWorkspace', 'withWorkspaceOwner', 'loadKustoItem', 'guardAdxRequest',
  'resolveOwnedItemDatabase', 'loadContentBackedItem', 'resolveItemAccessByOid',
  'resolveWorkspaceAccessByOid', 'denyIfNoDlzAccess', 'pdpCheck',
  'claims\\.oid', 'claims\\.tid', 'claims\\.tenantId',
].join('|'));

const ADMIN_RE = new RegExp([
  'requireTenantAdmin', 'isTenantAdmin', 'isTenantAdminTier', 'requireDomainRole',
  'enforceCapability', 'canAccessDlzPanes', 'isAtLeastDomainAdmin',
  'isAtLeastDomainContributor', 'callerIsOpsAdmin',
  // R1 route-toolkit wrappers (mirror withWorkspaceOwner in OWNER_RE):
  // withTenantAdmin runs requireTenantAdmin internally; withDlzAccess runs
  // denyIfNoDlzAccess (tenant-admin-or-domain-admin) internally.
  'withTenantAdmin', 'withDlzAccess',
].join('|'));

const GATE_RE = /ConfigGate\s*\(|withBackendGate\s*\(|apiHonestGateError\s*\(|backendGateResponse\s*\(|gateStatus\s*\(|assertFabricFamilyAvailable|not_configured|not configured/;

// Azure / data-plane client modules → friendly backend tags.
const BACKEND_IMPORT_RE = /from\s+['"]@\/lib\/azure\/([a-z0-9-]+)['"]/g;
const BACKEND_LABEL = {
  'adf-client': 'ADF', 'synapse-sql-client': 'Synapse SQL', 'synapse-dev-client': 'Synapse',
  'synapse-pool-arm': 'Synapse pool', 'kusto-client': 'ADX', 'kusto-arm-client': 'ADX ARM',
  'adls-client': 'ADLS', 'search-index-client': 'AI Search', 'databricks-client': 'Databricks',
  'eventhubs-client': 'Event Hubs', 'stream-analytics-client': 'Stream Analytics',
  'cosmos-client': 'Cosmos', 'cosmos-account-client': 'Cosmos', 'aas-client': 'AAS',
  'aml-client': 'AML', 'apim-client': 'APIM', 'monitor-client': 'Azure Monitor',
  'purview-client': 'Purview', 'servicebus-client': 'Service Bus', 'batch-client': 'Batch',
  'maps-client': 'Azure Maps', 'keyvault-client': 'Key Vault',
};

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

function classify(src, relPath) {
  const methods = METHOD_ORDER.filter((m) => METHOD_RES[m].test(src));
  const isAdminPath = relPath.startsWith('admin/');
  const hasSession = SESSION_RE.test(src);
  const hasOwner = OWNER_RE.test(src);
  const hasAdmin = ADMIN_RE.test(src) || isAdminPath;
  const gated = GATE_RE.test(src);

  let scope;
  if (hasAdmin) scope = 'admin';
  else if (hasOwner) scope = 'owner-scoped';
  else if (hasSession) scope = 'session-only';
  else scope = 'public';

  const backends = [...new Set(
    [...src.matchAll(BACKEND_IMPORT_RE)].map((m) => BACKEND_LABEL[m[1]]).filter(Boolean),
  )].sort();

  const area = relPath.split('/')[0] || '(root)';
  return { relPath, area, methods, scope, gated, backends };
}

function buildRows() {
  const files = walk(API_ROOT).sort();
  return files.map((f) => classify(fs.readFileSync(f, 'utf8'), relApi(f)));
}

function esc(s) { return String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|'); }

function render(rows) {
  const byArea = new Map();
  const scopeCounts = { public: 0, 'session-only': 0, 'owner-scoped': 0, admin: 0 };
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
  lines.push('auth scope, gate behavior, and backend dependency. Detection mirrors');
  lines.push('`scripts/ci/check-route-guards.mjs` (same session / owner-guard / admin signals,');
  lines.push('same classic + WS-D1 toolkit export styles).');
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
  lines.push(`| Gated (backend config) | ${gatedCount} |`);
  lines.push(`| Areas | ${byArea.size} |`);
  lines.push('');
  lines.push('**Auth scope** — `public`: no session check; `session-only`: signed-in but');
  lines.push('no per-resource authz; `owner-scoped`: owner/workspace-ACL check on the');
  lines.push('target item; `admin`: tenant/domain-admin gate. **Gated** = the route honest-');
  lines.push('gates on a backend being configured (see `docs/fiab/gate-registry.md`).');
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
  return lines.join('\n');
}

function main() {
  const check = process.argv.includes('--check');
  const rows = buildRows();
  const content = render(rows);
  if (check) {
    let current = '';
    try { current = fs.readFileSync(DOC_PATH, 'utf8'); } catch { /* missing → stale */ }
    if (current !== content) {
      console.error('[route-inventory] FAIL — docs/fiab/route-inventory.md is out of date.');
      console.error('Run: node scripts/ci/generate-route-inventory.mjs');
      process.exit(1);
    }
    console.log(`[route-inventory] OK — inventory up to date (${rows.length} routes).`);
    process.exit(0);
  }
  fs.mkdirSync(path.dirname(DOC_PATH), { recursive: true });
  fs.writeFileSync(DOC_PATH, content, 'utf8');
  console.log(`[route-inventory] wrote ${path.relative(REPO_ROOT, DOC_PATH)} (${rows.length} routes).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
