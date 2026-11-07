// End-to-end check of the PUBLISHED artifact (not the policy source): builds a per-stamp
// bundle exactly as the pipeline does (CP inputs CLI -> stage -> opa build, ES256-signed ->
// verify -> publish to a dir), then loads the signed tarball into a real OPA with signature
// verification ON and asks for decisions. Proves the property the unit tests cannot: a
// served bundle ALLOWS a legitimate request and still denies the rest. All keys are
// generated here, live in a temp dir, and are discarded; nothing is read from the repo's
// secret stores. Needs: opa on PATH (or OPA env), bash, and
// apps/loom-health-cp built (`npm run build` there -> dist/pdp/pdp-stamp-inputs-cli.js).
// Usage: node tools/e2e-published-bundle.mjs
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const opa = process.env.OPA ?? 'opa';
const cli = resolve(here, '../loom-health-cp/dist/pdp/pdp-stamp-inputs-cli.js');
if (!existsSync(cli)) { console.error(`e2e: ${cli} missing; run \`npm run build\` in apps/loom-health-cp first`); process.exit(2); }

const tmp = mkdtempSync(join(tmpdir(), 'lhds-e2e-'));
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` -- ${detail}`}`);
  if (!cond) failures++;
};
const b64 = (b) => Buffer.from(b).toString('base64url');
const run = (cmd, args, env = {}) => execFileSync(cmd, args, { env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

try {
  // Throwaway keys: AS token key (ES384, JWKS goes into the bundle) and bundle signing key (ES256).
  const as = generateKeyPairSync('ec', { namedCurve: 'P-384' });
  const jwks = JSON.stringify({ keys: [{ ...as.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES384', use: 'sig' }] });
  const bsign = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const priv = join(tmp, 'sign.pem'); const pub = join(tmp, 'verify.pem'); const wrongPub = join(tmp, 'wrong.pem');
  writeFileSync(priv, bsign.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(pub, bsign.publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(wrongPub, other.publicKey.export({ type: 'spki', format: 'pem' }));

  const ISS = 'https://health-cp.example.test';
  const STAMP = 'e2e-stamp';
  const ROOT = 'https://e2e-stamp.health.example.test';
  const entry = (tenantSlug, stampId, status) => ({ tenantSlug, stampId, stampBaseUrl: ROOT, status, maxRequestsPerMinute: 60 });
  writeFileSync(join(tmp, 'routing.json'), JSON.stringify({
    id: 'current', version: 'v', generatedAt: '2026-11-03T00:00:00Z', cacheTtlSeconds: 60,
    entries: [entry('visn-01', STAMP, 'active'), entry('visn-02', STAMP, 'paused'), entry('visn-09', 'other-stamp', 'active')],
  }));
  writeFileSync(join(tmp, 'jwks.json'), jwks);
  run(process.execPath, [cli, join(tmp, 'routing.json'), STAMP, ISS, join(tmp, 'jwks.json'), join(tmp, 'inputs.json')]);

  const publishDir = join(tmp, 'published');
  run('bash', [join(here, 'tools/build-bundle.sh'), priv, pub, 'e2e-rev', join(tmp, 'out')], { OPA: opa, STAMP_INPUTS: join(tmp, 'inputs.json'), PUBLISH_DIR: publishDir });
  const published = join(publishDir, `${STAMP}.tar.gz`);
  check('build-bundle.sh published <stamp>.tar.gz', existsSync(published));
  // The control: the same pipeline WITHOUT stamp inputs (what a served bundle was before this work).
  const policyOnly = join(tmp, 'policy-only');
  run('bash', [join(here, 'tools/build-bundle.sh'), priv, pub, 'e2e-rev', policyOnly], { OPA: opa });

  const now = Math.floor(Date.now() / 1000);
  const token = (over = {}) => {
    const h = { alg: 'ES384', typ: 'at+jwt', kid: 'k1' };
    const c = {
      iss: ISS, aud: `${ROOT}/visn-01/fhir`, jti: 'j-e2e', lhds_ver: 'lhds-at/1', tenant: 'visn-01',
      sub: 'oid-1', sub_type: 'user', idp_tid: 'tid-1', client_id: 'app-1', scope: 'user/Observation.rs',
      lhds_roles: [], lhds_map_ver: 'lhds-scope-map/1', pou: ['TREAT'], iat: now - 10, exp: now + 290, ...over,
    };
    const si = `${b64(JSON.stringify(h))}.${b64(JSON.stringify(c))}`;
    return `${si}.${b64(sign('sha384', Buffer.from(si), { key: as.privateKey, dsaEncoding: 'ieee-p1363' }))}`;
  };
  const request = (tenant) => ({ service: 'fhir', interaction: 'read', tenant, base: `${ROOT}/${tenant}/fhir`, resource_type: 'Observation' });

  // Run a real OPA the way the stamp does: it PULLS the tarball from a bundle service and
  // verifies the ES256 signature against `keyPem` (config shape = config/opa-config.yaml).
  // `ready` = OPA reports the bundle activated; `fetched` = OPA actually requested it, so a
  // not-ready result for a bad bundle is a REJECTION, not an OPA that never started.
  const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const serve = async (bundleFile, keyPem, waitMs) => {
    let fetched = 0;
    const svc = createServer((req, res) => { fetched++; res.writeHead(200, { 'content-type': 'application/gzip' }); res.end(readFileSync(bundleFile)); });
    await new Promise((r) => svc.listen(0, '127.0.0.1', r));
    const port = await freePort();
    const cfg = join(tmp, `opa-${port}.yaml`);
    writeFileSync(cfg, [
      'services:', '  cp:', `    url: http://127.0.0.1:${svc.address().port}`,
      'bundles:', '  lhds:', '    service: cp', '    resource: bundle.tar.gz', '    signing:', '      keyid: global',
      '    polling:', '      min_delay_seconds: 1', '      max_delay_seconds: 2',
      'keys:', '  global:', '    algorithm: ES256', '    key: |', ...readFileSync(keyPem, 'utf8').trimEnd().split('\n').map((l) => `      ${l}`), '',
    ].join('\n'));
    const proc = spawn(opa, ['run', '-s', '-a', `127.0.0.1:${port}`, '-c', cfg], { stdio: 'ignore' });
    let ready = false;
    for (let i = 0; i < Math.ceil(waitMs / 250) && !ready; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try { ready = (await fetch(`http://127.0.0.1:${port}/health?bundles`)).status === 200; } catch { /* OPA still starting */ }
    }
    return {
      ready, fetched: () => fetched,
      decide: async (input) => (await (await fetch(`http://127.0.0.1:${port}/v1/data/lhds/authz/decision`, { method: 'POST', body: JSON.stringify({ input }) })).json()).result ?? {},
      stop: async () => { proc.kill(); svc.close(); },
    };
  };
  const inputFor = (tenant, tok) => ({ access_token: tok, request: request(tenant) });
  const withPdp = async (bundleFile, keyPem, waitMs, fn) => { const p = await serve(bundleFile, keyPem, waitMs); try { return await fn(p); } finally { await p.stop(); } };

  await withPdp(published, pub, 15000, async (pdp) => {
    check('OPA pulled and activated the signed published bundle', pdp.ready, `fetched=${pdp.fetched()}`);
    const ok = await pdp.decide(inputFor('visn-01', token()));
    check('published bundle ALLOWS a valid token for a tenant homed on the stamp', ok.allow === true && ok.reason === 'permit', JSON.stringify(ok));
    const paused = await pdp.decide(inputFor('visn-02', token({ tenant: 'visn-02', aud: `${ROOT}/visn-02/fhir` })));
    check('published bundle denies a tenant whose route is paused (tenant-not-on-stamp)', paused.allow === false && paused.reason === 'tenant-not-on-stamp', JSON.stringify(paused));
    const foreign = await pdp.decide(inputFor('visn-09', token({ tenant: 'visn-09', aud: 'https://other.health.example.test/visn-09/fhir' })));
    check('published bundle denies a tenant homed on another stamp', foreign.allow === false && foreign.reason === 'tenant-not-on-stamp', JSON.stringify(foreign));
    const wrongScope = await pdp.decide(inputFor('visn-01', token({ scope: 'user/Condition.rs' })));
    check('published bundle denies a scope that does not cover the resource (scope-denied)', wrongScope.allow === false && wrongScope.reason === 'scope-denied', JSON.stringify(wrongScope));
  });

  await withPdp(join(policyOnly, 'lhds-pdp.tar.gz'), pub, 15000, async (pdp) => {
    check('OPA activated the policy-only control bundle (so its deny below is the policy, not a failed load)', pdp.ready, `fetched=${pdp.fetched()}`);
    const control = await pdp.decide(inputFor('visn-01', token()));
    check('the SAME request against a policy-only bundle is denied (the deny-everything state this pipeline removes)', control.allow === false, JSON.stringify(control));
  });

  // Fail closed: a damaged or wrongly-keyed bundle must be refused by OPA, which did request it.
  const flip = Buffer.from(readFileSync(published)); flip[Math.floor(flip.length / 2)] ^= 0xff;
  const tampered = join(tmp, 'tampered.tar.gz');
  writeFileSync(tampered, flip);
  await withPdp(tampered, pub, 4000, async (pdp) => {
    check('a corrupted tarball is requested but never activated', !pdp.ready && pdp.fetched() > 0, `ready=${pdp.ready} fetched=${pdp.fetched()}`);
  });
  await withPdp(published, wrongPub, 4000, async (pdp) => {
    check('the published bundle is requested but never activated under a different verification key', !pdp.ready && pdp.fetched() > 0, `ready=${pdp.ready} fetched=${pdp.fetched()}`);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (failures) { console.error(`e2e: ${failures} check(s) failed`); process.exit(1); }
console.log('e2e: all checks passed');
