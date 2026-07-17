#!/usr/bin/env node
/**
 * GUARDRAIL: health-coverage  (merge-blocker)
 * ---------------------------------------------------------------------------
 * RULE (operator review 3.2 — auto-expanding health coverage):
 *   The Admin Health self-audit must cover EVERY Azure backend client and
 *   EVERY item-type workload family. Coverage is declared in ONE registry —
 *   apps/fiab-console/lib/admin/health-coverage-map.json — which the audit
 *   engine consumes at runtime (lib/admin/health-coverage.ts derives a health
 *   check per family) and this guard validates at CI time. Coverage therefore
 *   grows STRUCTURALLY: land a new lib/azure/*-client.ts or a new workload
 *   category with no mapping and this guard fails the build (and the health
 *   page shows a red "family unmapped" check).
 *
 * WHAT IT CHECKS:
 *   1. Every apps/fiab-console/lib/azure/*-client.ts basename has an entry in
 *      map.clients — either {"checks": [ids...]} or {"allow": "<reason>"}
 *      (allow = genuinely uncheckable / deliberately opt-in; reason required,
 *      ≥ 20 chars so it is a real justification, not "todo").
 *   2. Every workload category used in lib/catalog/item-types/*.ts has an
 *      entry in map.families with ≥ 1 check id.
 *   3. Every check id referenced anywhere in the map EXISTS in the audit
 *      engine (extracted from self-audit.ts + health-probes.ts).
 *   4. No stale map entries: a mapped client that no longer exists on disk,
 *      or a mapped family absent from the catalog, fails (keeps the registry
 *      honest in both directions).
 *   5. Gates-registry wiring: if lib/gates/registry.ts exists (built by a
 *      parallel workstream) but lib/admin/gate-registry.ts still says
 *      GATES_REGISTRY_WIRED = false, fail with the wiring instruction.
 *
 * Run: node scripts/ci/check-health-coverage.mjs   (repo root)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = path.join(ROOT, 'apps', 'fiab-console');
const MAP_PATH = path.join(APP, 'lib', 'admin', 'health-coverage-map.json');
const AZURE_DIR = path.join(APP, 'lib', 'azure');
const ITEM_TYPES_DIR = path.join(APP, 'lib', 'catalog', 'item-types');
const SELF_AUDIT = path.join(APP, 'lib', 'admin', 'self-audit.ts');
// The declarative ENV_CHECKS layer was split out of self-audit.ts into a pure,
// client-safe module (lib/admin/env-checks.ts) so the gate registry /
// HonestGate can import it without dragging the probes' lazy Azure/copilot
// imports (and next/headers) into a client bundle. The check-id universe spans
// all three files.
const ENV_CHECKS_FILE = path.join(APP, 'lib', 'admin', 'env-checks.ts');
const HEALTH_PROBES = path.join(APP, 'lib', 'admin', 'health-probes.ts');
const GATES_REGISTRY = path.join(APP, 'lib', 'gates', 'registry.ts');
const GATE_BRIDGE = path.join(APP, 'lib', 'admin', 'gate-registry.ts');

const errors = [];

// ── load the registry ────────────────────────────────────────────────────────
let map;
try {
  map = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
} catch (e) {
  console.error(`health-coverage: cannot read ${MAP_PATH}: ${e.message}`);
  process.exit(1);
}
const mapClients = map.clients || {};
const mapFamilies = map.families || {};

// ── 3. extract the check-id universe from the audit engine ──────────────────
function extractCheckIds(file) {
  const src = fs.readFileSync(file, 'utf8');
  const ids = new Set();
  // Matches `id: 'check-id'` in EnvSpec literals and probe `base` objects.
  for (const m of src.matchAll(/\bid:\s*'([a-z0-9][a-z0-9-]*)'/g)) ids.add(m[1]);
  // Matches the generic reachability probes: probeHttpService('check-id', ...).
  for (const m of src.matchAll(/probeHttpService\(\s*\n?\s*'([a-z0-9][a-z0-9-]*)'/g)) ids.add(m[1]);
  return ids;
}
const checkIds = new Set([
  ...extractCheckIds(SELF_AUDIT),
  ...extractCheckIds(ENV_CHECKS_FILE),
  ...extractCheckIds(HEALTH_PROBES),
]);

// ── 1 + 4a. clients ↔ map ────────────────────────────────────────────────────
const clientFiles = fs.readdirSync(AZURE_DIR)
  .filter((f) => f.endsWith('-client.ts'))
  .map((f) => f.replace(/\.ts$/, ''));

for (const c of clientFiles) {
  const entry = mapClients[c];
  if (!entry) {
    errors.push(
      `NEW Azure client with NO health coverage: lib/azure/${c}.ts — add an entry to ` +
      `lib/admin/health-coverage-map.json: either {"checks": [<self-audit check ids covering its backend>]} ` +
      `(add a real probe in lib/admin/health-probes.ts if none exists) or {"allow": "<why it is genuinely uncheckable / opt-in>"}.`,
    );
    continue;
  }
  if (entry.allow !== undefined) {
    if (typeof entry.allow !== 'string' || entry.allow.trim().length < 20) {
      errors.push(`clients["${c}"].allow must be a real justification (≥ 20 chars), got: ${JSON.stringify(entry.allow)}`);
    }
    continue;
  }
  if (!Array.isArray(entry.checks) || entry.checks.length === 0) {
    errors.push(`clients["${c}"] must declare a non-empty "checks" array or an "allow" reason.`);
    continue;
  }
  for (const id of entry.checks) {
    if (!checkIds.has(id)) {
      errors.push(`clients["${c}"] references check id "${id}" which does not exist in self-audit.ts / health-probes.ts.`);
    }
  }
}
for (const c of Object.keys(mapClients)) {
  if (!clientFiles.includes(c)) {
    errors.push(`STALE map entry: clients["${c}"] — lib/azure/${c}.ts no longer exists; remove the entry.`);
  }
}

// ── 2 + 4b. workload families ↔ map ─────────────────────────────────────────
const categories = new Set();
for (const f of fs.readdirSync(ITEM_TYPES_DIR).filter((f) => f.endsWith('.ts'))) {
  const src = fs.readFileSync(path.join(ITEM_TYPES_DIR, f), 'utf8');
  for (const m of src.matchAll(/\bcategory:\s*'([^']+)'/g)) categories.add(m[1]);
}
for (const cat of categories) {
  const entry = mapFamilies[cat];
  if (!entry || !Array.isArray(entry.checks) || entry.checks.length === 0) {
    errors.push(
      `NEW workload family with NO health coverage: "${cat}" (lib/catalog/item-types) — add a families["${cat}"] ` +
      `entry with the self-audit checks (env gate + live probe) guarding its backend to lib/admin/health-coverage-map.json.`,
    );
    continue;
  }
  for (const id of entry.checks) {
    if (!checkIds.has(id)) {
      errors.push(`families["${cat}"] references check id "${id}" which does not exist in self-audit.ts / health-probes.ts.`);
    }
  }
}
for (const cat of Object.keys(mapFamilies)) {
  if (!categories.has(cat)) {
    errors.push(`STALE map entry: families["${cat}"] — no item type uses this category anymore; remove the entry.`);
  }
}

// ── 5. gates-registry wiring ─────────────────────────────────────────────────
if (fs.existsSync(GATES_REGISTRY)) {
  const bridge = fs.readFileSync(GATE_BRIDGE, 'utf8');
  if (/GATES_REGISTRY_WIRED\s*=\s*false/.test(bridge)) {
    errors.push(
      'lib/gates/registry.ts EXISTS but lib/admin/gate-registry.ts is still the stub (GATES_REGISTRY_WIRED = false). ' +
      'Wire it per the instructions in the gate-registry.ts header so every registered gate becomes a health check.',
    );
  }
}

// ── report ───────────────────────────────────────────────────────────────────
if (errors.length) {
  console.error(`\nhealth-coverage guard FAILED — ${errors.length} problem(s):\n`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error(
    '\nCoverage doctrine: every Azure client + item-type family maps to REAL self-audit checks ' +
    '(docs/fiab/health-coverage-audit.md). Allowlist only what is genuinely uncheckable, with a reason.\n',
  );
  process.exit(1);
}
console.log(
  `health-coverage guard OK — ${clientFiles.length} Azure clients mapped ` +
  `(${Object.values(mapClients).filter((e) => e.allow).length} allowlisted with reasons), ` +
  `${categories.size} workload families mapped, ${checkIds.size} check ids in the engine.`,
);
