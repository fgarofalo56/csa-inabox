/**
 * Delete throwaway UAT / E2E test workspaces from a Loom tenant.
 *
 * UAT and live-validation runs create one fresh workspace per app/test
 * (name = `<prefix>-<Date.now()>`). This script lists the caller's
 * workspaces, classifies each as TEST (a known test prefix + a trailing
 * timestamp, or any `-e2e-` infix) vs KEEP, prints both, and deletes the
 * TEST ones via the real BFF DELETE /api/workspaces/[id].
 *
 * Usage:
 *   SESSION_SECRET=<from kv/container secret> node scripts/csa-loom/cleanup-test-workspaces.mjs [--apply]
 *     (default is DRY-RUN — prints what it would delete; pass --apply to delete)
 *   LOOM_URL   override base (default the live Commercial FD)
 *   UAT_OID    override the tenant oid the workspaces belong to
 */
import crypto from 'node:crypto';

const BASE = process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net';
const SECRET = process.env.SESSION_SECRET;
if (!SECRET) { console.error('SESSION_SECRET required (container-app session-secret or KV loom-session-secret)'); process.exit(2); }
const APPLY = process.argv.includes('--apply');

const KEY = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(SECRET, 'utf-8'), Buffer.alloc(32), Buffer.from('loom-session-v1'), 32));
const payload = {
  claims: {
    oid: process.env.UAT_OID || '866a2e12-0fee-4c99-923c-7cdfd61e08cd',
    name: 'Cleanup', email: 'cleanup@loom', upn: 'cleanup@loom',
  },
  exp: Math.floor(Date.now() / 1000) + 3600,
};
const iv = crypto.randomBytes(12);
const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
const enc = Buffer.concat([c.update(Buffer.from(JSON.stringify(payload))), c.final()]);
const COOKIE = `loom_session=${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url')}`;

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
