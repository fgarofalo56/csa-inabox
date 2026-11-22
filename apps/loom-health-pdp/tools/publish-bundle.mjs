// Publishes a built, UNSIGNED PDP bundle (the control plane signs it with its Key Vault key) to the stamp's control plane
// (PUT /api/health/pdp/stamps/<stamp>/bundle) and READS IT BACK: the PUT status is not
// the verdict, the served bytes' sha256 is. Fails closed (exit 1) with a message that
// states only what was established. Prints ids, revision, sizes and hashes; never the
// token, never bundle contents.
// Usage: LHDS_CP_TOKEN=<bearer> node tools/publish-bundle.mjs <bundle.tar.gz> <stamp-id> <cp-base-url> <revision>
// The token comes from the environment (pipeline: `az account get-access-token`), never argv.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [file, stamp, base, revision] = process.argv.slice(2);
const die = (m) => { console.error(`publish-bundle: ${m}`); process.exit(1); };
if (!file || !stamp || !base || !revision) die('usage: publish-bundle.mjs <bundle.tar.gz> <stamp-id> <cp-base-url> <revision>');
const token = process.env.LHDS_CP_TOKEN ?? '';
if (!token) die('LHDS_CP_TOKEN is not set (nothing was sent)');
if (!/^[a-z0-9-]{2,40}$/.test(stamp)) die('stamp id must match [a-z0-9-]{2,40}');
let url;
try { url = new URL(base); } catch { die('control plane base URL is not a URL'); }
const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) die('control plane base URL must be https (http only for localhost)');

let bytes;
try { bytes = readFileSync(file); } catch (e) { die(`cannot read bundle file (${e.code ?? 'error'})`); }
if (bytes.length < 3 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) die('bundle file is not a gzip tarball (nothing was sent)');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const path = `${url.origin}${url.pathname.replace(/\/+$/, '')}/api/health/pdp/stamps/${stamp}`;
const auth = { authorization: `Bearer ${token}` };

// Only the error envelope's authored code/message is echoed; a non-JSON body is not.
async function describe(res) {
  try {
    const j = await res.json();
    return `${j?.error?.code ?? 'unknown'}: ${j?.error?.message ?? 'no message'}`;
  } catch { return 'response was not JSON'; }
}

let put;
try {
  put = await fetch(`${path}/bundle`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ revision, sha256, bundleBase64: bytes.toString('base64') }),
    signal: AbortSignal.timeout(30_000),
  });
} catch (e) { die(`could not reach the control plane (${e.name}); the bundle was NOT published`); }
if (!put.ok) die(`publish rejected, HTTP ${put.status} ${await describe(put)}`);
// The control plane SIGNS the upload (Key Vault, #5422) and stores the signed archive, so the read-back must equal the
// STORED archive's sha256 it reports, not the unsigned bytes sent. A response without one cannot be verified: fail.
let stored;
try { stored = (await put.json())?.data?.sha256; } catch { stored = undefined; }
if (typeof stored !== 'string' || !/^[0-9a-f]{64}$/.test(stored)) die('published, but the control plane did not report the stored sha256; UNVERIFIED');

let got;
try {
  got = await fetch(`${path}/bundle.tar.gz`, { headers: auth, signal: AbortSignal.timeout(30_000) });
} catch (e) { die(`published, but the read-back could not reach the control plane (${e.name}); UNVERIFIED`); }
if (!got.ok) die(`published, but the read-back failed, HTTP ${got.status} ${await describe(got)}; UNVERIFIED`);
const served = createHash('sha256').update(Buffer.from(await got.arrayBuffer())).digest('hex');
if (served !== stored) die(`read-back mismatch: the control plane stored ${stored} but serves ${served}`);
console.log(`published stamp=${stamp} revision=${revision} uploaded_bytes=${bytes.length} uploaded_sha256=${sha256} stored_sha256=${stored} (signed by the control plane, read back identical)`);
