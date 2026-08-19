/**
 * Workspace-identity enforce — I7 preflight + gated flip.
 *
 * The step-4/step-5 operator tool of the shadow → enforce migration runbook
 * (docs/fiab/runbooks/workspace-identity-migration.md). It:
 *   1. enumerates the tenant's workspaces (GET /api/admin/workspaces);
 *   2. reads each workspace's ENFORCE READINESS from the I6 identity route
 *      (GET /api/admin/workspaces/<id>/identity), which serves the I7
 *      preflightWorkspaceEnforce verdict (ready / uamiProvisioned /
 *      missingGrants / divergences / observedCalls / reasons) from REAL ARM +
 *      data-plane + the identity.shadow rollup;
 *   3. prints a readiness table;
 *   4. with `--apply --confirm`, flips the per-workspace enforce flag for the
 *      READY workspaces (idempotent) via PATCH …/identity { enforce: true }.
 *
 * Enforcement is OPERATOR-GATED. Default is DRY-RUN. `--apply` alone refuses —
 * you must also pass `--confirm`. Not-ready workspaces are always skipped.
 *
 * The I6 route is built separately; if this Console image predates it, the GET
 * degrades gracefully (prints a notice, exits 0 without flipping anything) —
 * use Admin → Workspace identity in that case.
 *
 * Usage:
 *   SESSION_SECRET=<loom-session-secret> node scripts/csa-loom/workspace-identity-enforce.mjs
 *     (DRY-RUN readiness for every workspace)
 *   SESSION_SECRET=<...> node scripts/csa-loom/workspace-identity-enforce.mjs --apply --confirm
 *     (flip the READY ones)
 *
 *   LOOM_URL   override base (default the live Commercial FD; point at the gov
 *              FD for GCC-High; run via ACA job exec in IL5)
 *   UAT_OID    REQUIRED — the tenant-admin oid the minted session represents.
 *              This tool FLIPS ENFORCEMENT FLAGS; the identity it acts as is
 *              the audit trail for who did it, so it fails closed rather than
 *              attribute an enforcement change to a placeholder (#3804).
 *   WS_ID      restrict to a single workspace id (preflight/flip just that one)
 */
import { mintLoomSessionCookie, requireAutomationOid, requireSessionSecret } from '../../apps/fiab-console/e2e/auth/mint-cookie.mjs';

const BASE = process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net';
const APPLY = process.argv.includes('--apply');
const CONFIRM = process.argv.includes('--confirm');
const ONLY = process.env.WS_ID || '';

// Mint a Loom session cookie via the shared minter (apps/fiab-console/e2e/auth/
// mint-cookie.mjs) — the same scheme lib/auth/session verifies. Both the secret
// and the identity fail closed there.
const claims = {
  oid: process.env.UAT_OID,
  name: 'IdentityEnforce',
  email: 'identity-enforce@loom',
  upn: 'identity-enforce@loom',
};
try {
  requireSessionSecret();
  requireAutomationOid(claims);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
const COOKIE = `loom_session=${mintLoomSessionCookie(claims, 3600)}`;

const jget = async (path) => {
  const r = await fetch(`${BASE}${path}`, { headers: { cookie: COOKIE } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const jsend = async (path, method, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie: COOKIE, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// 1. Enumerate workspaces.
const list = await jget('/api/admin/workspaces');
if (list.status === 403) {
  console.error('Forbidden — the minted session must be a tenant admin (set UAT_OID to a LOOM_TENANT_ADMIN_OID).');
  process.exit(3);
}
if (list.status !== 200) {
  console.error(`GET /api/admin/workspaces failed: HTTP ${list.status}`);
  process.exit(3);
}
let workspaces = list.body.workspaces || [];
if (ONLY) workspaces = workspaces.filter((w) => w.id === ONLY);
if (workspaces.length === 0) {
  console.log(ONLY ? `No workspace matched WS_ID=${ONLY}.` : 'No workspaces found.');
  process.exit(0);
}

// 2/3. Preflight each via the I6 identity route (serves the I7 verdict).
console.log(`Preflighting ${workspaces.length} workspace(s) against ${BASE}\n`);
const ready = [];
const notReady = [];
let routeAbsent = false;

for (const w of workspaces) {
  const res = await jget(`/api/admin/workspaces/${w.id}/identity`);
  if (res.status === 404) {
    routeAbsent = true;
    break;
  }
  if (res.status !== 200) {
    notReady.push({ w, reasons: [`identity route HTTP ${res.status}`] });
    continue;
  }
  // Defensive shape parse — the verdict may be at the root or under `preflight`.
  const p = res.body.preflight || res.body.readiness || res.body;
  const verdict = {
    ready: !!p.ready,
    uamiProvisioned: p.uamiProvisioned,
    missingGrants: p.missingGrants || [],
    divergences: p.divergences ?? 0,
    observedCalls: p.observedCalls ?? 0,
    reasons: p.reasons || [],
  };
  const line =
    `  ${verdict.ready ? 'READY    ' : 'NOT-READY'} ${w.name || w.id} (${w.id})` +
    `  uami=${verdict.uamiProvisioned ? 'yes' : 'no'}` +
    `  missing=[${verdict.missingGrants.join(',')}]` +
    `  divergences=${verdict.divergences}  observed=${verdict.observedCalls}`;
  console.log(line);
  if (!verdict.ready && verdict.reasons.length) {
    for (const reason of verdict.reasons) console.log(`             - ${reason}`);
  }
  (verdict.ready ? ready : notReady).push({ w, ...verdict });
}

if (routeAbsent) {
  console.log(
    '\nThe I6 identity route (GET /api/admin/workspaces/<id>/identity) is not present in this Console image.\n' +
      'Use Admin → Workspace identity for the readiness report + enforce toggle, or upgrade the Console image.',
  );
  process.exit(0);
}

console.log(`\nReady to enforce: ${ready.length}   Not ready: ${notReady.length}`);

// 4. Flip — gated. Dry-run by default; --apply needs --confirm.
if (!APPLY) {
  console.log('\nDRY-RUN. Re-run with --apply --confirm to flip the READY workspaces to enforce.');
  process.exit(0);
}
if (!CONFIRM) {
  console.error('\n--apply requires --confirm (enforcement is operator-gated). Nothing changed.');
  process.exit(4);
}
if (ready.length === 0) {
  console.log('\nNo READY workspaces — nothing to flip.');
  process.exit(0);
}

let ok = 0;
let fail = 0;
for (const { w } of ready) {
  // Idempotent: setting enforce:true on an already-enforced workspace is a no-op.
  const res = await jsend(`/api/admin/workspaces/${w.id}/identity`, 'PATCH', { enforce: true });
  if (res.status >= 200 && res.status < 300) {
    ok++;
    console.log(`  ENFORCED ${w.name || w.id}`);
  } else {
    fail++;
    console.error(`  FAIL     ${w.name || w.id}: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  }
}
console.log(`\nFlipped ${ok} workspace(s) to enforce; ${fail} failed. ${notReady.length} left in shadow (not ready).`);
process.exit(fail ? 5 : 0);
