// Stages the bundle tree: policies/ plus the W1-4 role-scope map as
// lhds/rolemap/data.json (single mapping source; never copied into git here).
// With --stamp-inputs <json> (PdpStampInputs, from loom-health-cp pdp-stamp-inputs-cli)
// it also writes lhds/config/data.json (data.lhds.config) and lhds/stamp/data.json
// (data.lhds.stamp); without it the bundle is policy-only and denies everything.
// Usage: node tools/stage-policies.mjs <outdir> [--root <pdp dir>] [--rolemap <path>] [--stamp-inputs <json>]
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? resolve(argv[i + 1]) : dflt; };
const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = opt('--root', here);
const rolemap = opt('--rolemap', join(root, '../loom-health-cp/src/auth/role-scope-map.v1.json'));
const inputsPath = opt('--stamp-inputs', undefined);
const outdir = resolve(argv[0] ?? '');
if (!argv[0]) { console.error('usage: stage-policies.mjs <outdir>'); process.exit(2); }

const map = JSON.parse(readFileSync(rolemap, 'utf8'));
if (map.version !== 'lhds-scope-map/1') { console.error(`unexpected role map version ${map.version}`); process.exit(1); }
rmSync(outdir, { recursive: true, force: true });
cpSync(join(root, 'policies'), outdir, { recursive: true });
mkdirSync(join(outdir, 'lhds/rolemap'), { recursive: true });
writeFileSync(join(outdir, 'lhds/rolemap/data.json'), JSON.stringify(map));
if (inputsPath) {
  const inp = JSON.parse(readFileSync(inputsPath, 'utf8'));
  const fail = (m) => { console.error(`stamp inputs invalid: ${m}`); process.exit(1); };
  const slug = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/;
  if (typeof inp.stampId !== 'string' || !/^[a-z0-9-]{2,40}$/.test(inp.stampId)) fail('stampId');
  if (typeof inp.config?.issuer !== 'string' || !inp.config.issuer.startsWith('https://')) fail('config.issuer must be https');
  let keys;
  try { keys = JSON.parse(inp.config?.jwks).keys; } catch { fail('config.jwks must be a JSON string'); }
  if (!Array.isArray(keys) || keys.length === 0) fail('config.jwks has no keys');
  const tenants = inp.stamp?.tenants;
  if (typeof tenants !== 'object' || tenants === null || Array.isArray(tenants)) fail('stamp.tenants');
  for (const [t, v] of Object.entries(tenants)) {
    if (!slug.test(t)) fail(`tenant slug ${t}`);
    if (!Array.isArray(v?.bases) || v.bases.length === 0 || !v.bases.every((b) => typeof b === 'string' && b.startsWith('https://'))) fail(`bases for ${t}`);
  }
  mkdirSync(join(outdir, 'lhds/config'), { recursive: true });
  mkdirSync(join(outdir, 'lhds/stamp'), { recursive: true });
  writeFileSync(join(outdir, 'lhds/config/data.json'), JSON.stringify(inp.config));
  writeFileSync(join(outdir, 'lhds/stamp/data.json'), JSON.stringify(inp.stamp));
  console.log(`stamp ${inp.stampId}: ${Object.keys(tenants).length} tenant(s)`);
}
console.log(`staged ${outdir} (role map ${map.version}, ${map.roles.length} roles)`);
