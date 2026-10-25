// Stages the bundle tree: policies/ plus the W1-4 role-scope map as
// lhds/rolemap/data.json (single mapping source; never copied into git here).
// Usage: node tools/stage-policies.mjs <outdir> [--root <pdp dir>] [--rolemap <path>]
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? resolve(argv[i + 1]) : dflt; };
const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = opt('--root', here);
const rolemap = opt('--rolemap', join(root, '../loom-health-cp/src/auth/role-scope-map.v1.json'));
const outdir = resolve(argv[0] ?? '');
if (!argv[0]) { console.error('usage: stage-policies.mjs <outdir>'); process.exit(2); }

const map = JSON.parse(readFileSync(rolemap, 'utf8'));
if (map.version !== 'lhds-scope-map/1') { console.error(`unexpected role map version ${map.version}`); process.exit(1); }
rmSync(outdir, { recursive: true, force: true });
cpSync(join(root, 'policies'), outdir, { recursive: true });
mkdirSync(join(outdir, 'lhds/rolemap'), { recursive: true });
writeFileSync(join(outdir, 'lhds/rolemap/data.json'), JSON.stringify(map));
console.log(`staged ${outdir} (role map ${map.version}, ${map.roles.length} roles)`);
