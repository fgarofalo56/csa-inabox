// CLI: routing-map JSON + stamp id + AS issuer + AS JWKS file -> PdpStampInputs JSON
// for apps/loom-health-pdp/tools/stage-policies.mjs --stamp-inputs. Holds no secrets
// (JWKS is public key material).
// Usage: node dist/pdp/pdp-stamp-inputs-cli.js <routing-map.json> <stamp-id> <issuer> <jwks.json> <out.json>

import { readFileSync, writeFileSync } from 'node:fs';
import type { RoutingMapDoc } from '../routing/types.js';
import { buildPdpStampInputs } from './pdp-stamp-data.js';

const [routing, stamp, issuer, jwksFile, out] = process.argv.slice(2);
if (!routing || !stamp || !issuer || !jwksFile || !out) {
  console.error('usage: pdp-stamp-inputs-cli <routing-map.json> <stamp-id> <issuer> <jwks.json> <out.json>');
  process.exit(2);
}
const map = JSON.parse(readFileSync(routing, 'utf8')) as RoutingMapDoc;
const inputs = buildPdpStampInputs(stamp, map.entries, issuer, readFileSync(jwksFile, 'utf8').trim());
writeFileSync(out, JSON.stringify(inputs));
console.log(`stamp inputs for ${stamp}: ${Object.keys(inputs.stamp.tenants).length} tenant(s)`);
