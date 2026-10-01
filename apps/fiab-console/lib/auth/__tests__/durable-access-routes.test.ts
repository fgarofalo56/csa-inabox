/**
 * #4805 — operator decision 2026-09-30, "Guardrails in-product" (d): a session
 * minted by the CLI / VS Code device-code sign-in cannot create, reveal or
 * rotate a durable credential, or grant anyone standing access.
 *
 * What each block pins, and the value that breaks it:
 *   1. the middleware's literal `config.matcher` is EXACTLY the admin trees plus
 *      every DURABLE_ACCESS_ROUTES matcher — RED if a row is added to the table
 *      and not to the matcher (the middleware would never run there);
 *   2. Next's OWN matcher (`unstable_doesMiddlewareMatch`) agrees with the
 *      table's derived regex on a concrete URL per row, and on nested,
 *      trailing-slash, query, case and look-alike URLs;
 *   3. per ROW, through the REAL middleware and REAL session crypto: a
 *      device-code session is refused with that row's action, the SAME claims in
 *      a browser session pass, and a method the row does not list passes;
 *   4. discovery: every route file that calls a credential- or grant-minting
 *      primitive is covered — by a table row, by the DLZ admin-tier gate, by an
 *      in-route withhold, or by a reasoned exemption — and the discovered set is
 *      pinned as a literal, so a new minting route (or a primitive that stops
 *      being found) turns this RED;
 *   5. the DLZ gate and the two in-route withholds, behaviourally.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';

process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0123456789';

let domainLoads = 0;
vi.mock('@/lib/auth/load-domains', () => ({
  loadTenantDomains: async () => {
    domainLoads += 1;
    return [];
  },
}));

import { encodeSessionCookie, type SessionPayload } from '../session';
import {
  DURABLE_ACCESS_ROUTES,
  durableAccessRouteFor,
  matcherToRegExp,
  nonInteractiveRefusalReason,
  refuseNonInteractive,
  INTERACTIVE_SIGN_IN_HINT,
  INTERACTIVE_SIGN_IN_REQUIRED_REASON,
} from '../device-code-policy';
import { denyIfNoDlzAccess } from '../dlz-gate';
import { middleware, config as middlewareConfig } from '@/middleware';
import { codeOnly } from '../../../../../scripts/ci/_code-only.mjs';

const OID = 'aaaaaaaa-0000-0000-0000-00000000ad01';
const TENANT = 'bbbbbbbb-0000-0000-0000-000000000002';
const claims = { oid: OID, tid: TENANT, name: 'Ada', upn: 'ada@contoso.com', groups: ['g-admin'] };
const exp = () => Math.floor(Date.now() / 1000) + 600;
const browser = (): SessionPayload => ({ claims: { ...claims }, exp: exp() });
const deviceCode = (): SessionPayload => ({ claims: { ...claims }, exp: exp(), authVia: 'device_code' });

const env0 = { ...process.env };
beforeEach(() => {
  domainLoads = 0;
  process.env.LOOM_TENANT_ADMIN_OID = OID;
});
afterEach(() => {
  process.env = { ...env0 };
});

const ADMIN_MATCHERS = ['/admin', '/admin/:path*', '/api/admin', '/api/admin/:path*'];
/** A concrete URL for a matcher: every `:param` becomes a sample segment. */
const sampleOf = (matcher: string) => matcher.replace(/:([a-zA-Z]+)/g, (_m, p) => `x-${p}`);
const req = (url: string, method: string, s: SessionPayload | null) =>
  new NextRequest(`https://loom.example${url}`, {
    method,
    headers: s ? { cookie: `loom_session=${encodeSessionCookie(s)}` } : {},
  });

describe('#4805 (d) the matcher is the table, and Next agrees', () => {
  it('config.matcher is exactly the admin trees plus every table matcher', () => {
    const want = [...ADMIN_MATCHERS, ...DURABLE_ACCESS_ROUTES.map((r) => r.matcher)].sort();
    expect([...(middlewareConfig.matcher as string[])].sort()).toEqual(want);
    expect(middlewareConfig.runtime).toBe('nodejs');
    // Each matcher appears once, so no row can shadow another's methods.
    expect(new Set(DURABLE_ACCESS_ROUTES.map((r) => r.matcher)).size).toBe(DURABLE_ACCESS_ROUTES.length);
  });

  it.each(DURABLE_ACCESS_ROUTES.map((r) => [r.matcher]))('Next matches %s on a concrete URL, and so does the derived regex', (m) => {
    const url = sampleOf(m);
    expect(unstable_doesMiddlewareMatch({ config: middlewareConfig, url }), url).toBe(true);
    expect(matcherToRegExp(m).test(url), url).toBe(true);
    // One segment deeper is NOT this row (e.g. /api/developer/tokens/<id> is the
    // revoke route): RED if the regex lets a `:param` span segments.
    expect(matcherToRegExp(m).test(`${url}/extra`)).toBe(false);
  });

  it('admin trees: nested, trailing slash and query match; look-alikes, assets, other case and non-admin do not', () => {
    const match = (url: string) => unstable_doesMiddlewareMatch({ config: middlewareConfig, url });
    for (const url of ['/admin', '/admin/', '/admin/a/b/c?x=1', '/api/admin', '/api/admin/', '/api/admin/env-config?x=1&y=2', '/api/admin/domains/d1/networking']) {
      expect(match(url), url).toBe(true);
    }
    for (const url of ['/administrator', '/api/administrator', '/_next/static/chunks/x.js', '/', '/api/auth/cli-session', '/ADMIN', '/API/ADMIN/x', '/api/workspaces']) {
      expect(match(url), url).toBe(false);
    }
  });
});

describe('#4805 (d) each listed route refuses a device-code session through the real middleware', () => {
  const rows = DURABLE_ACCESS_ROUTES.flatMap((r) => r.methods.map((m) => [r.matcher, m, r.action] as const));

  it.each(rows)('%s %s', async (matcher, method, action) => {
    const url = sampleOf(matcher);
    const refused = middleware(req(url, method, deviceCode()));
    // RED if this row's method stops being refused.
    expect(refused.status).toBe(403);
    const b = await refused.json();
    expect(b.code).toBe('interactive_sign_in_required');
    // The row's own action — so the 403 came from THIS row, not a generic gate.
    expect(b.action).toBe(action);
    expect(b.reason).toBe(nonInteractiveRefusalReason(action));
    expect(b.hint).toBe(INTERACTIVE_SIGN_IN_HINT);
    // Control: the same claims in a browser session pass through to the route.
    expect(middleware(req(url, method, browser())).headers.get('x-middleware-next')).toBe('1');
    // Control: a method the row does not list passes for the device-code session.
    const other = ['GET', 'DELETE', 'OPTIONS'].find((m) => !DURABLE_ACCESS_ROUTES.find((r) => r.matcher === matcher)!.methods.includes(m))!;
    expect(middleware(req(url, other, deviceCode())).headers.get('x-middleware-next')).toBe('1');
  });

  it('no cookie, or an undecodable one, passes through to the route (which answers 401)', () => {
    expect(middleware(req('/api/developer/tokens', 'POST', null)).headers.get('x-middleware-next')).toBe('1');
    const garbage = new NextRequest('https://loom.example/api/developer/tokens', { method: 'POST', headers: { cookie: 'loom_session=nope' } });
    expect(middleware(garbage).headers.get('x-middleware-next')).toBe('1');
  });

  it('refuseNonInteractive: 403 for device code, null for a browser session or none', async () => {
    const r = refuseNonInteractive(deviceCode(), 'Doing X');
    expect(r?.status).toBe(403);
    const b = await r!.json();
    expect(b).toMatchObject({ ok: false, error: 'forbidden', code: 'interactive_sign_in_required', action: 'Doing X', hint: INTERACTIVE_SIGN_IN_HINT });
    expect(b.message).toMatch(/^Doing X requires an interactive browser sign-in\./);
    expect(refuseNonInteractive(browser(), 'Doing X')).toBeNull();
    expect(refuseNonInteractive(null, 'Doing X')).toBeNull();
  });
});

// ---- 4. discovery ---------------------------------------------------------

const APP = path.resolve(__dirname, '../../..');
/** Calls that create, reveal or rotate a credential, or grant access. */
const PRIMITIVES = [
  'createPatToken', 'getSubscriptionKeys', 'regenerateSubscriptionKey', 'createSubscription', 'updateSubscription',
  'getAccountKeys', 'getLogicAppCallbackUrl', 'createStorageCredential', 'updateStorageCredential',
  'createRecipient', 'loomCreateRecipient', 'loomSetRecipientDisabled', 'createShare', 'loomCreateShare',
  'updateSharePermissions', 'loomPatchShare', 'createExternalShare', 'acceptExternalShare',
  'addWorkspaceRole', 'grantItemPermission', 'upsertRole', 'applyRoleAcls', 'grantContainerRole', 'grantTableSelect',
  'createRlsPolicy', 'createRlsPolicyWithPredicate', 'grantDatabaseRole', 'updatePermissions', 'addWorkspaceRoleAssignment',
  'grantRgScopedRoles', 'enforceAccessGrant', 'subscribeToProduct', 'listEventHubKeys', 'listNamespaceKeys',
  'regenerate\\w*Keys?', 'listAccountKeys', 'listConnectionStrings', 'listAdminKeys', 'listQueryKeys', 'createQueryKey',
  'listTopicKeys', 'getUserDelegationKey', 'listKeys', 'createNamespaceAuthRule',
];
const PRIMITIVE_RE = new RegExp(`\\b(?:${PRIMITIVES.join('|')})\\s*\\(`);

/** Covered by the DLZ admin-tier gate (lib/auth/dlz-gate.ts refuses device-code sessions). */
const DLZ_GATED = new Set([
  'app/api/ai-search/service/route.ts',
  'app/api/eventhubs/authrules/[rule]/keys/route.ts',
  'app/api/eventhubs/authrules/[rule]/keys/regenerate/route.ts',
  'app/api/items/cosmos-db/[id]/keys/route.ts',
  'app/api/items/event-grid-topic/route.ts',
  'app/api/items/service-bus-namespace/route.ts',
]);
/** Only part of the answer is durable, so the route withholds that part itself. */
const IN_ROUTE = new Set([
  'app/api/catalog/request-access/route.ts',
  'app/api/items/eventstream/[id]/source/route.ts',
]);
/** THE POPULATION, as a literal: RED when a minting route appears or a primitive stops being found. */
const EXPECTED_DISCOVERED = [
  'app/api/access-governance/assignments/[id]/activate/route.ts',
  'app/api/access-governance/group-sync/route.ts',
  'app/api/access-requests/[id]/decision/route.ts',
  'app/api/ai-search/service/route.ts',
  'app/api/apim/subscriptions/[sid]/keys/route.ts',
  'app/api/apim/subscriptions/[sid]/route.ts',
  'app/api/apim/subscriptions/route.ts',
  'app/api/azure/iothub/policies/route.ts',
  'app/api/catalog/permissions/route.ts',
  'app/api/catalog/request-access/route.ts',
  'app/api/dab/[id]/publish/route.ts',
  'app/api/data-products/[id]/access-requests/route.ts',
  'app/api/databricks/unity-catalog/grants/route.ts',
  'app/api/databricks/unity-catalog/storage-credentials/route.ts',
  'app/api/developer/tokens/route.ts',
  'app/api/eventhubs/authrules/[rule]/keys/regenerate/route.ts',
  'app/api/eventhubs/authrules/[rule]/keys/route.ts',
  'app/api/external-shares/[id]/accept/route.ts',
  'app/api/external-shares/route.ts',
  'app/api/foundry/keys/route.ts',
  'app/api/governance/policies/route.ts',
  'app/api/items/[type]/[id]/onelake-security/[role]/cls/route.ts',
  'app/api/items/[type]/[id]/onelake-security/[role]/rls/route.ts',
  'app/api/items/[type]/[id]/permissions/route.ts',
  'app/api/items/[type]/[id]/security-roles/route.ts',
  'app/api/items/azure-sql-database/[id]/share/route.ts',
  'app/api/items/cosmos-db/[id]/keys/route.ts',
  'app/api/items/data-product/[id]/publish-api/route.ts',
  'app/api/items/event-grid-topic/route.ts',
  'app/api/items/eventstream/[id]/source/route.ts',
  'app/api/items/service-bus-namespace/route.ts',
  'app/api/lakehouse/permissions/route.ts',
  'app/api/marketplace/products/[id]/subscribe/route.ts',
  'app/api/marketplace/sharing/recipients/[name]/route.ts',
  'app/api/marketplace/sharing/recipients/route.ts',
  'app/api/marketplace/sharing/shares/[name]/route.ts',
  'app/api/marketplace/sharing/shares/route.ts',
  'app/api/marketplace/subscriptions/[sid]/keys/regenerate/route.ts',
  'app/api/marketplace/subscriptions/[sid]/keys/route.ts',
  'app/api/marketplace/subscriptions/[sid]/route.ts',
  'app/api/marketplace/subscriptions/route.ts',
  'app/api/monitor/logic-app-callback/route.ts',
  'app/api/onelake/security/route.ts',
  'app/api/setup/landing-zones/grant/route.ts',
  'app/api/workspaces/[id]/role-assignments/route.ts',
];

function routeFiles(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .map((p) => p.split(path.sep).join('/'))
    .filter((p) => p.endsWith('/route.ts') || p === 'route.ts')
    .map((p) => `app/api/${p}`);
}
const urlOf = (file: string) =>
  file
    .replace(/^app/, '')
    .replace(/\/route\.ts$/, '')
    .replace(/\[\.\.\.([^\]]+)\]/g, 'x-$1/y')
    .replace(/\[([^\]]+)\]/g, 'x-$1');
const exportedMethods = (code: string) =>
  [...code.matchAll(/export\s+(?:async\s+function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
/**
 * The methods whose OWN handler text calls a primitive (from its `export` to the
 * next top-level declaration). When the call sits in a shared helper instead,
 * no handler contains it and every exported POST / PUT / PATCH is held to the
 * table (GET reads; DELETE revokes, which stays available by design).
 */
const TOP_LEVEL_DECL_RE = /\n(?:export\s|async\s+function\s|function\s|const\s|let\s|class\s)/g;
function handlerText(code: string, start: number): string {
  TOP_LEVEL_DECL_RE.lastIndex = start + 1;
  const next = TOP_LEVEL_DECL_RE.exec(code);
  return code.slice(start, next ? next.index : code.length);
}
function mintingMethods(code: string): string[] {
  const marks = [...code.matchAll(/export\s+(?:async\s+function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)];
  const own = marks.filter((m) => PRIMITIVE_RE.test(handlerText(code, m.index!))).map((m) => m[1]);
  return own.length ? own : exportedMethods(code).filter((m) => m !== 'GET' && m !== 'DELETE');
}

describe('#4805 (d) discovery: no minting route is left uncovered', () => {
  const files = routeFiles(path.join(APP, 'app/api'));
  const code = new Map(files.map((f) => [f, codeOnly(fs.readFileSync(path.join(APP, f), 'utf8'))]));
  const discovered = files.filter((f) => PRIMITIVE_RE.test(code.get(f)!)).sort();

  it('the scan reads the real tree (control)', () => {
    // RED if the walk finds nothing (a wrong root would make every check below vacuous).
    expect(files.length).toBeGreaterThan(1000);
    expect(files).toContain('app/api/developer/tokens/route.ts');
  });

  it('the discovered population is exactly the pinned set', () => {
    expect(discovered).toEqual([...EXPECTED_DISCOVERED].sort());
  });

  it.each(EXPECTED_DISCOVERED.map((f) => [f]))('%s is covered', (f) => {
    const src = code.get(f)!;
    if (DLZ_GATED.has(f)) {
      expect(src, 'a DLZ_GATED file no longer calls the DLZ gate').toMatch(/\b(?:denyIfNoDlzAccess|withDlzAccess)\s*[<(]/);
      return;
    }
    if (IN_ROUTE.has(f)) {
      expect(src, 'an IN_ROUTE file no longer checks the device-code marker').toMatch(/\bisDeviceCodeSession\s*\(/);
      return;
    }
    const url = urlOf(f);
    const methods = mintingMethods(src);
    expect(methods.length, `${f}: no exported method found`).toBeGreaterThan(0);
    for (const m of methods) {
      // RED if the table covers this URL for a DIFFERENT method than the one
      // whose handler mints (e.g. role-assignments listed for GET, not POST).
      expect(durableAccessRouteFor(url, m), `${f} ${m} (${url}) mints a credential or grants access but no DURABLE_ACCESS_ROUTES row covers it`).toBeTruthy();
    }
  });

  it('controls: a primitive inside a comment is not a call, and an unlisted URL is not covered', () => {
    expect(PRIMITIVE_RE.test(codeOnly('// createPatToken(x)\nconst a = 1;'))).toBe(false);
    expect(PRIMITIVE_RE.test(codeOnly('await createPatToken({})'))).toBe(true);
    expect(durableAccessRouteFor('/api/workspaces', 'POST')).toBeNull();
    expect(durableAccessRouteFor('/api/developer/tokens/abc', 'DELETE')).toBeNull();
    // The minting METHOD is read from the handler that calls the primitive…
    const own = 'export const GET = w(async () => 1);\nexport const POST = w(async () => {\n  await addWorkspaceRole(x);\n});\n';
    expect(mintingMethods(own)).toEqual(['POST']);
    // …and a helper declared after a DELETE handler is not that handler's text:
    // the fallback holds POST (the write) to the table, not the DELETE (revoke).
    const helper = 'export async function POST(r) {\n  return h(r);\n}\nexport async function DELETE(r) {\n  return 1;\n}\nasync function h(r) {\n  await createPatToken({});\n}\n';
    expect(mintingMethods(helper)).toEqual(['POST']);
  });
});

// ---- 5. the DLZ gate and the in-route withholds ----------------------------

describe('#4805 the DLZ admin-tier gate (service access keys) refuses device code', () => {
  it('device code gets the admin refusal before any domain lookup; the browser tenant admin passes', async () => {
    const refused = await denyIfNoDlzAccess(deviceCode(), 'scaling');
    expect(refused?.status).toBe(403);
    const b = await refused!.json();
    // RED if the device-code check is removed: a tenant admin by oid would pass.
    expect(b.code).toBe('interactive_sign_in_required');
    expect(b.reason).toBe(INTERACTIVE_SIGN_IN_REQUIRED_REASON);
    expect(b.hint).toBe(INTERACTIVE_SIGN_IN_HINT);
    expect(domainLoads).toBe(0);
    expect(await denyIfNoDlzAccess(browser(), 'scaling')).toBeNull();
  });
});
