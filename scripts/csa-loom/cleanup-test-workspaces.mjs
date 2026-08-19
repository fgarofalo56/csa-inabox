/**
 * Delete throwaway UAT / E2E test workspaces from a Loom tenant.
 *
 * UAT and live-validation runs create one fresh workspace per app/test
 * (name = `<prefix>-<Date.now()>`). This script lists the caller's
 * workspaces, classifies each as TEST (a known test prefix + a trailing
 * timestamp, or any `-e2e-` infix) vs KEEP, prints both, and deletes the
 * TEST ones via the real BFF DELETE /api/workspaces/[id].
 *
 * SCOPE — READ THIS BEFORE TRUSTING A "0 found" RESULT.
 *
 * This tool is OWNER-SCOPED and cannot be otherwise: GET /api/workspaces
 * filters on `session.claims.oid` (apps/fiab-console/app/api/workspaces/route.ts:22)
 * because `workspaces` is partitioned by /tenantId == the creator's oid. So it
 * only ever sees debris created by the SAME oid it mints as. Point it at the
 * wrong identity and it enumerates an empty partition, finds nothing, and
 * exits 0 — indistinguishable from a clean estate.
 *
 * That is not hypothetical. Until #3804 this script defaulted to
 * `…00000000000e` while the harnesses that created the debris defaulted to
 * `…000000000000` — two different fake partitions. The result: 24 `tut-app-*`
 * workspaces sat unreachable for five weeks (#3801) while this script reported
 * "Total workspaces: 0" every time it ran. The identity is now required, so a
 * zero here means a genuinely empty partition for THAT oid — nothing more.
 *
 * For debris whose owner is unknown or unreachable, use the operator-side
 * scripts/csa-loom/purge-test-workspaces.sh, which goes at Cosmos directly and
 * is not owner-scoped.
 *
 * Usage:
 *   SESSION_SECRET=<from kv/container secret> UAT_OID=<owner oid> \
 *     node scripts/csa-loom/cleanup-test-workspaces.mjs [--apply]
 *     (default is DRY-RUN — prints what it would delete; pass --apply to delete)
 *   LOOM_URL   override base (default the live Commercial FD)
 *   UAT_OID    REQUIRED — the oid that OWNS the workspaces to clean up
 */
import { mintLoomSessionCookie, requireAutomationOid, requireSessionSecret } from '../../apps/fiab-console/e2e/auth/mint-cookie.mjs';

const BASE = process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net';
const APPLY = process.argv.includes('--apply');

const claims = {
  oid: process.env.UAT_OID,
  name: 'Cleanup', email: 'cleanup@loom', upn: 'cleanup@loom',
};
try {
  requireSessionSecret();
  requireAutomationOid(claims);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
const COOKIE = `loom_session=${mintLoomSessionCookie(claims, 3600)}`;

// A workspace is a TEST artifact when its name carries an auto-generated
// timestamp/date/id, OR a test keyword. A KEEPER is a clean human name with
// neither (e.g. "RAG Builder"). Conservative: anything ambiguous WITHOUT a
// timestamp or keyword is kept — use the admin bulk-delete UI for those.
const TS = /\d{8,}|\d{4}-\d{2}-\d{2}|T\d{2}[:\-]\d{2}/;
const KW = /(\buat\b|uat-|uat_|\be2e\b|e2e-|-e2e-|use-case|validate|verify|\bgate\b|gates|smoke|probe|cleanup|uc-validate|apps-install|-kql-|-tally-|-nb-|-detail-|dlfinal|dlafter|dlfull|^ctrl-|iot-verify|maa-|\bmao\b|\bfdm\b|\bcfp\b|\brta\b|\brtd\b)/i;
const isTest = (name = '') => TS.test(name) || KW.test(name);

const r = await fetch(`${BASE}/api/workspaces`, { headers: { cookie: COOKIE } });
const d = await r.json();
const list = Array.isArray(d) ? d : (d.workspaces || []);
const test = list.filter((w) => isTest(w.name));
const keep = list.filter((w) => !isTest(w.name));

console.log(`Total workspaces: ${list.length}`);
console.log(`KEEP (${keep.length}): ${keep.map((w) => w.name).join(', ') || '(none)'}`);
console.log(`TEST to delete (${test.length})`);
if (!APPLY) { console.log('\nDRY-RUN. Re-run with --apply to delete the TEST workspaces.'); process.exit(0); }

let ok = 0, fail = 0;
for (const w of test) {
  try {
    const dr = await fetch(`${BASE}/api/workspaces/${w.id}`, { method: 'DELETE', headers: { cookie: COOKIE } });
    if (dr.ok) { ok++; } else { fail++; console.error(`  FAIL ${w.name}: HTTP ${dr.status}`); }
  } catch (e) { fail++; console.error(`  ERR ${w.name}: ${e.message}`); }
  if ((ok + fail) % 25 === 0) console.log(`  …${ok + fail}/${test.length}`);
}
console.log(`\nDeleted ${ok} test workspace(s); ${fail} failed. ${keep.length} kept.`);
