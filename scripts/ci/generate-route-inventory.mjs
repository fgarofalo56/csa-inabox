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
import { stripCommentsAndStrings } from './_gate-consumption.mjs';

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

const OWNER_RE = new RegExp([
  'loadOwnedItem', 'updateOwnedItem', 'deleteOwnedItem', 'createOwnedItem',
  'softDeleteOwnedItem', 'restoreOwnedItem', 'purgeRecycledItem', 'loadRecycledItem',
  // #2977 — `assertOwner` was here and is deliberately gone: PR #2973 deleted the
  // function, so every remaining occurrence is PROSE in a migration comment and
  // this list was classifying 34 routes `owner-scoped` on a comment rather than
  // on code. `authorizeItemWorkspace` is the real successor signal (canonical
  // owner → tenant-admin → shared-ACL ladder). Kept in lockstep with
  // GUARD_SIGNAL_RE in check-route-guards.mjs — the two must not drift.
  'authorizeItemWorkspace',
  // #2988 — the databricks-notebook execution family's guard wrapper, matched AS
  // A CALL so a `{@link authorizeNotebookItem}` in prose cannot classify a route
  // owner-scoped. Before this, moving `getSession()` into that wrapper made four
  // genuinely-authorized routes report as `public` — the exact under-reporting
  // this file's header warns trains readers to ignore the `public` column.
  // Its substance is asserted by check-route-guards.assertGuardWrappersAreReal().
  'authorizeNotebookItem\\s*\\(',
  // #2996/#2997 - sibling guard wrappers for the databricks-job and
  // databricks-pipeline families. Matched AS CALLS, never as prose.
  'authorizeDatabricksJobItem\\s*\\(',
  'authorizeDatabricksPipelineItem\\s*\\(',
  // #3572 — bounds WHICH storage account a caller may drive the Console UAMI
  // at (deployment lake / DLZ authority / an account this tenant's lakehouse is
  // bound to). Matched AS A CALL. Lockstep with GUARD_SIGNAL_RE in
  // check-route-guards.mjs — the two must not drift.
  'authorizeStorageAccount\\s*\\(',
  // GHSA-v2g8-gp3r-rg4r — the ADX item-route guard (`app/api/items/_lib/
  // adx-item-scope.ts`), the item-route form of `guardAdxRequest` below. Matched
  // AS A CALL for the same reason its siblings are. Adding it to BOTH regexes at
  // once is deliberate: on first run without it, four routes that had just been
  // HARDENED — graph-model materialize + query, eventhouse purge + database,
  // lakehouse query — flipped from `session-only` to `public`, because their
  // session moved into the wrapper. That is the exact under-reporting this
  // file's header warns about, reproduced by the very change that fixed them.
  'guardAdxItemRequest\\s*\\(',
  // ...and MEASURED AGAIN, on the third pass, which is why the note above is
  // worth keeping. Adopting `guardSynapseItemRequest` on the shared-Synapse /
  // Databricks-UC / AAS routes flipped FOUR of them from `session-only` to
  // **public** in the generated inventory —
  //   items/[type]/[id]/optimize, items/[type]/[id]/statistics,
  //   items/databricks-sql-warehouse/[id]/ctas,
  //   items/semantic-model/[id]/refresh-policy
  // — i.e. the published doc would have described a newly OWNER-SCOPED route as
  // unauthenticated, because the session moved inside a wrapper this file did
  // not know. Exactly the same failure the ADX pass hit. Both regexes are
  // updated together; do not add a guard wrapper to one without the other.
  'guardSynapseItemRequest\\s*\\(',
  // GHSA-v8r7-c2p5-mjf2 — the Azure SQL / PostgreSQL item-route guard
  // (`app/api/items/_lib/sql-server-scope.ts`). Matched AS A CALL for the same
  // reason its siblings are. Added to BOTH regexes here and to GETSESSION_RE /
  // GUARD_SIGNAL_RE in check-route-guards.mjs in ONE change, deliberately:
  // measured on the six routes this advisory hardened, listing the name nowhere
  // dropped them out of the guard checker's remit entirely (1526 → 1520 scanned
  // routes) — the same under-reporting the ADX entry above records, reproduced
  // by the very change that fixed them. THIRD independent reproduction of the
  // lockstep rule in this one file; it is not theoretical.
  'withBoundSqlServer\\s*\\(',
  // The wrapper's OWNER-RESOLUTION half, for the routes in that family that
  // resolve the item themselves rather than through the wrapper's ctx —
  // `[id]/connect` (it WRITES the binding the wrapper reads), `[id]/query` and
  // `[id]/copilot`. Matched AS A CALL; its substance is asserted by
  // check-route-guards.assertGuardWrappersAreReal(), which pins it to
  // `loadOwnedItem(id, itemType, session.claims.oid, …)`.
  //
  // FOURTH reproduction of the lockstep rule, and this one is only visible if
  // you MEASURE rather than eyeball the generated diff. Moving `[id]/query` off
  // `withWorkspaceOwner` and onto `withSession` + `loadOwnedSqlItem` took every
  // OWNER_RE token out of that route's CODE. The generated inventory did not
  // change — because `loadOwnedItem` still appears TWICE in the file, both times
  // inside a COMMENT. Measured on the post-change file:
  //
  //     whole file  WITHOUT this token = true   (matches the prose)
  //     code only   WITHOUT this token = FALSE  (no code signal at all)
  //     code only   WITH    this token = true
  //
  // So a byte-identical inventory would have been resting entirely on a comment
  // — the same shape as the deleted-`assertOwner` incident recorded above, which
  // classified 34 routes on a word in a migration note. The identical diff was
  // the trap, not the reassurance. This token is what makes the classification
  // rest on the code again. (Related: #3625, presence vs enforcement.)
  'loadOwnedSqlItem\\s*\\(',
  // The LAYER-1-ONLY wrapper from the same module, for the three routes whose
  // server is a caller PICK rather than the item's binding — `[id]/create-db`
  // and the two `[id]/databases` discovery GETs (see `sql-server-scope.ts`
  // §admitPickedServer). Those routes call NEITHER `withBoundSqlServer` NOR
  // `loadOwnedSqlItem` in their own source, so this file cannot see their
  // ownership check without this token.
  //
  // FIFTH reproduction of the lockstep rule, MEASURED rather than assumed.
  // Regenerating with the token removed publishes all three as **public**:
  //
  //     Public (no session)  104 → 107
  //     items/azure-sql-database/[id]/create-db          session-only → public
  //     items/azure-sql-server/[id]/databases            session-only → public
  //     items/postgres-flexible-server/[id]/databases    session-only → public
  //
  // i.e. the doc would describe three routes that had just gained an OWNER
  // check as unauthenticated — strictly worse than the `session-only` they were
  // published as while they genuinely were unowned. `[id]/firewall` is absent
  // from that list because it adopted `withBoundSqlServer`, already registered
  // above; the gap is exactly the names this file does not know.
  'withOwnedSqlItem\\s*\\(',
  'listOwnedItems', 'listAllOwnedItems', 'authorizeWorkspace',
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
  // C22 (#3088): withCapability runs enforceCapability internally — the
  // NON-DISCARDABLE form of `const gate = await enforceCapability(…);
  // if (gate) return gate;`, whose branch could be deleted while the name (and
  // therefore this classification) survived. Its substance is asserted by
  // check-route-guards.assertGuardWrappersAreReal().
  'withCapability',
].join('|'));

const GATE_RE = /ConfigGate\s*\(|withBackendGate\s*\(|apiHonestGateError\s*\(|backendGateResponse\s*\(|gateStatus\s*\(|assertFabricFamilyAvailable|not_configured|not configured/;

// Azure / data-plane client modules → friendly backend tags.
const BACKEND_IMPORT_RE = /from\s+['"]@\/lib\/azure\/([a-z0-9-]+)['"]/g;
const BACKEND_LABEL = {
  'adf-client': 'ADF', 'synapse-sql-client': 'Synapse SQL', 'synapse-dev-client': 'Synapse',
  'synapse-pool-arm': 'Synapse pool', 'kusto-client': 'ADX', 'kusto-arm-client': 'ADX ARM',
  // `data-quality-client` IS an ADX data-plane client — every rule it scores is
  // a live `executeQuery` KQL aggregate (it re-exports `kustoConfigGate` as
  // `adxConfigGate`). It was missing from this map, so a route reached ADX
  // through it and the inventory said the route touched no backend at all. Found
  // when #3499 moved a `defaultDatabase` import out of two data-product routes
  // into a shared helper: their ADX tag vanished while the ADX calls did not.
  // Six other routes were already mis-tagged the same way.
  'data-quality-client': 'ADX',
  // Same defect, same shape, found the same way (#3529). `azure-sql-client` is
  // the Azure SQL data-plane client — real TDS + AAD (`executeQuery`,
  // `executeParameterized`, `executeWithCredential`) plus the ARM control plane
  // — and it was missing here, so every route reaching Azure SQL through it
  // published "touches no backend" in a table whose stated job is to classify
  // backend dependency. Noticed because copy-job/[id]/watermark runs a live
  // `SELECT` against the dbo.copy_watermark control table and its row read `—`.
  'azure-sql-client': 'Azure SQL',
  // FOURTH instance of the same defect (found landing #3581 — a new route read
  // `—` in the regenerated diff). `model-serving-client` is the model data
  // plane: `listServingEndpoints` / `invokeServingEndpoint` / `setServingTraffic`
  // are real Azure ML online-endpoint ARM + scoring calls, or real Databricks
  // Mosaic serving REST. SIX routes reach it — including
  // `items/model-serving-endpoint/[id]/invoke` (a live inference) and
  // `.../traffic` (a live traffic-split mutation) — and ALL SIX published
  // "touches no backend" before this entry existed; five of them had shipped
  // that way.
  //
  // THE LABEL NAMES BOTH BACKENDS ON PURPOSE. This client DISPATCHES on
  // `resolveServingBackend()` — Azure ML by default, Databricks Mosaic when
  // `LOOM_MODEL_SERVING_BACKEND=databricks` — so which backend a row's route
  // actually reaches is deployment configuration, not a property of the code.
  // A single-backend label would be right in one boundary and wrong in the
  // other, which is the same class of false row this map keeps producing, just
  // smaller. ` / ` (not `, `) because the renderer joins multiple labels with
  // `, `.
  'model-serving-client': 'AML / Databricks Mosaic',
  'adls-client': 'ADLS', 'search-index-client': 'AI Search', 'databricks-client': 'Databricks',
  'eventhubs-client': 'Event Hubs', 'stream-analytics-client': 'Stream Analytics',
  'cosmos-client': 'Cosmos', 'cosmos-account-client': 'Cosmos', 'aas-client': 'AAS',
  'aml-client': 'AML', 'apim-client': 'APIM', 'monitor-client': 'Azure Monitor',
  'purview-client': 'Purview', 'servicebus-client': 'Service Bus', 'batch-client': 'Batch',
  'maps-client': 'Azure Maps', 'keyvault-client': 'Key Vault',
  // #3572 — the THIRD instance of the same defect, found the same way the two
  // above were. `kv-secrets-client` IS the Key Vault data-plane client (it is
  // what `vaultUrl` / `shortcutVaultUrl` / `certVaultUrl` come from, and the
  // routes using it issue real `GET {vault}/secrets?api-version=` calls). It was
  // absent, so 19 routes reaching Key Vault through it published `—` ("touches
  // no backend") in a table whose entire stated job is to classify backend
  // dependency. Noticed because this PR's new `keyvault/secret-names` route —
  // which does nothing BUT list Key Vault secret names — generated as `—`.
  //
  // Note the shape of the trap: `keyvault-client` sits in this map and is
  // imported by ZERO routes, so the map LOOKED like it covered Key Vault while
  // covering none of it. A label with no population verifies nothing.
  'kv-secrets-client': 'Key Vault',
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

function classify(raw, relPath) {
  // C22 (#3088): classify the AUTH signals from CODE, not from prose. Every one
  // is a NAME, and a name survives in a comment long after the code is gone —
  // that is #2977, which this file's own OWNER_RE note records for
  // `assertOwner`. Removing `assertOwner` fixed one symbol; stripping comments
  // and string literals closes the mechanism for all of them at once.
  const src = stripCommentsAndStrings(raw);
  // …but GATE_RE and BACKEND_IMPORT_RE legitimately match STRING LITERALS —
  // `code: 'not_configured'` and `from '@/lib/azure/adf-client'` are data the
  // route really carries, not prose about it. They get comments-only stripping.
  // MEASURED: blanking strings for these took "Gated (backend config)" from 531
  // to 308 by erasing every `'not_configured'` — a 42% phantom drop in a
  // security-adjacent table. A comment is never code; a string sometimes is.
  const dataSrc = stripCommentsAndStrings(raw, { keepStrings: true });
  const methods = METHOD_ORDER.filter((m) => METHOD_RES[m].test(src));
  const isAdminPath = relPath.startsWith('admin/');
  const hasSession = SESSION_RE.test(src);
  const hasOwner = OWNER_RE.test(src);
  const hasAdmin = ADMIN_RE.test(src) || isAdminPath;
  const gated = GATE_RE.test(dataSrc);

  let scope;
  if (hasAdmin) scope = 'admin';
  else if (hasOwner) scope = 'owner-scoped';
  else if (hasSession) scope = 'session-only';
  else scope = 'public';

  const backends = [...new Set(
    [...dataSrc.matchAll(BACKEND_IMPORT_RE)].map((m) => BACKEND_LABEL[m[1]]).filter(Boolean),
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
