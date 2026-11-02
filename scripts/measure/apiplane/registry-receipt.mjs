#!/usr/bin/env node
/**
 * registry-receipt.mjs - drive the API Gateway registry on a LIVE console from a GitHub Actions
 * run, then hand the numbers to registry-probe.mjs. It exists for the W1-7 GCC-High receipt: the
 * Gov console is only reachable from Actions (cloud-parity.md), and the probe needs an admin
 * session that a workstation cannot mint.
 *
 * TWO MODES, so nothing is adopted without a person choosing it (deploy-integrity.md R5):
 *   RESOURCE_ID unset  -> DISCOVER only. Prints each candidate APIM (name, SKU, location, access,
 *                         already-registered). Registers nothing. Exits 0.
 *   RESOURCE_ID set    -> register that one service (observe mode), sync it, then run
 *                         registry-probe.mjs against it. Exits with the probe's code.
 *
 * ENV (all required unless noted; none is ever printed):
 *   SS            the console's session secret (decrypts/encrypts the loom_session cookie)
 *   OID           the automation identity's object id (a tenant admin of that console)
 *   BASE          console base URL, no trailing slash
 *   ARM_ENDPOINT  ARM endpoint of the boundary under test (passed to the probe)
 *   RESOURCE_ID   optional, see above
 *   DISPLAY_NAME  optional display name for the registration
 *
 * The cookie is minted exactly as gov-bff-verify.yml mints it (same HKDF info string, same
 * AES-256-GCM layout) and is only ever placed in a request header and the probe's environment.
 */
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const need = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`::error::${k} is not set`); process.exit(2); }
  return v;
};
const SS = need('SS');
const OID = need('OID');
const BASE = need('BASE').replace(/\/+$/, '');
const ARM = need('ARM_ENDPOINT');
const RESOURCE_ID = (process.env.RESOURCE_ID ?? '').trim();
const DISPLAY_NAME = (process.env.DISPLAY_NAME ?? '').trim();

function mintCookie() {
  const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(SS, 'utf-8'), Buffer.alloc(32), Buffer.from('loom-session-v1'), 32));
  const payload = { claims: { oid: OID, name: 'registry-receipt', email: 'receipt@automation.inv', upn: 'registry-receipt@automation' }, exp: Math.floor(Date.now() / 1000) + 3600 };
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(Buffer.from(JSON.stringify(payload))), c.final()]);
  return 'loom_session=' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url');
}
const cookie = mintCookie();

async function api(path, init = {}, timeoutMs = 60_000) {
  const res = await fetch(`${BASE}/api/admin/api-gateway/gateways${path}`, {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text };
}

const fail = (what, r) => {
  // R7: say what was observed. Status and the route's own error string only; never the raw body.
  console.error(`::error::${what}: HTTP ${r.status}${r.json?.error ? ` - ${String(r.json.error).slice(0, 300)}` : ''}`);
  process.exit(2);
};

const d = await api('/discover', {}, 120_000);
if (d.status !== 200 || !d.json?.ok) fail('discover', d);
const found = d.json.data;
console.log(`discovery: ${found.candidates.length} candidate(s) across ${found.subscriptionsScanned} subscription(s); partial=${found.partial}`);
for (const c of found.candidates) {
  console.log(`  - ${c.name} | ${c.sku} | ${c.location} | vnet=${c.networkMode} | read=${c.access.canRead} write=${c.access.canWrite} | registered=${c.alreadyRegistered}`);
  console.log(`      ${c.resourceId}`);
}
for (const f of found.failures) console.log(`  discovery failure: ${f.kind} status=${f.status} ${String(f.reason).slice(0, 160)}`);

if (!RESOURCE_ID) {
  console.log('No RESOURCE_ID given: discovery only. Re-run with the resource id of the service to register.');
  process.exit(0);
}

const chosen = found.candidates.find((c) => c.resourceId.toLowerCase() === RESOURCE_ID.toLowerCase());
console.log(chosen ? `chosen service was discovered (${chosen.name})` : 'chosen service was NOT in the discovery list; registering from the supplied id (R5 supplied-values path)');

let gwId = chosen?.registeredGatewayId;
if (!gwId) {
  const reg = await api('', { method: 'POST', body: JSON.stringify({ resourceId: RESOURCE_ID, ...(DISPLAY_NAME ? { displayName: DISPLAY_NAME } : {}) }) });
  if (reg.status >= 300 || !reg.json?.ok) fail('register', reg);
  gwId = reg.json.data.id;
  console.log(`registered ${gwId}: canRead=${reg.json.data.access?.canRead} canWrite=${reg.json.data.access?.canWrite} mode=${reg.json.data.managementMode}`);
} else {
  console.log(`already registered as ${gwId}`);
}

const t0 = Date.now();
const sync = await api(`/${encodeURIComponent(gwId)}/sync`, { method: 'POST' }, 240_000);
if (sync.status !== 200 || !sync.json?.ok) fail('sync', sync);
console.log(`sync ok in ${Math.round((Date.now() - t0) / 1000)}s: counts=${JSON.stringify(sync.json.data.counts)} partialTypes=${JSON.stringify(sync.json.data.partialTypes)}`);

const probe = fileURLToPath(new URL('./registry-probe.mjs', import.meta.url));
const r = spawnSync(process.execPath, [probe, '--resource-id', RESOURCE_ID, '--base-url', BASE, '--arm-endpoint', ARM], {
  stdio: 'inherit',
  env: { ...process.env, LOOM_SESSION_COOKIE: cookie.slice('loom_session='.length) },
});
process.exit(r.status ?? 2);
