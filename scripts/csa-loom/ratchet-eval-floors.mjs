#!/usr/bin/env node
/**
 * ratchet-eval-floors — RAISE-ONLY floor ratchet for the Copilot eval floors
 * (E3, loom-next-level; mirrors the vitest coverage-floor convention,
 * commit 14a16d8e).
 *
 * Reads a streak of eval runs (run-artifact JSONs — the E2 HTTP-trigger
 * responses — or Cosmos `loom-copilot-evals` directly), computes the observed
 * MINIMUM per surface/metric over the streak, and proposes
 * `min(observed) − margin` as the new floor — capped, rounded, and applied
 * ONLY when it is HIGHER than the current floor. Floors never move down here;
 * lowering one requires an explicit hand-edit commit with a justification.
 *
 * Grounding runs that were judge-'deferred' (null groundingAvg) contribute no
 * grounding evidence — an all-deferred window leaves the grounding floor
 * untouched (per the E2 cap contract).
 *
 * Usage (artifact mode):
 *   node scripts/csa-loom/ratchet-eval-floors.mjs \
 *     --artifact run1.json --artifact run2.json --artifact run3.json [--write]
 *   node scripts/csa-loom/ratchet-eval-floors.mjs --runs-dir path/to/artifacts [--write]
 *
 * Usage (Cosmos mode — last N runs per surface):
 *   LOOM_COSMOS_ENDPOINT=… [LOOM_COSMOS_DATABASE=loom] \
 *   node scripts/csa-loom/ratchet-eval-floors.mjs --cosmos [--window 5] [--write]
 *
 * Flags:
 *   --min-runs N   streak length required before a surface's floors move (default 3)
 *   --write        apply to content/evals/eval-floors.json (default: dry-run print)
 *
 * Convention: run --write on a dedicated branch and open it as its own ratchet
 * PR (like the coverage-floor ratchet PRs) — never fold a ratchet into a
 * feature PR.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRuns, ratchetFloors, RATCHET_RULES } from './eval-regression-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..', '..');
const FLOORS_PATH = path.join(repo, 'content', 'evals', 'eval-floors.json');

const args = process.argv.slice(2);
const optAll = (name) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const opt = (name) => optAll(name)[0];
const has = (name) => args.includes(name);

const minRuns = Number(opt('--min-runs') ?? '3');
if (!Number.isFinite(minRuns) || minRuns < 1) {
  console.error('ratchet-eval-floors: --min-runs must be >= 1');
  process.exit(2);
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.error(`ratchet-eval-floors: cannot read ${p}: ${e.message}`);
    process.exit(2);
  }
}

/** Collect observations: surface → one normalized entry per RUN. */
async function collectObservations() {
  const observations = new Map();
  const add = (map) => {
    for (const [surface, entry] of map) {
      const list = observations.get(surface) ?? [];
      list.push(entry);
      observations.set(surface, list);
    }
  };

  if (has('--cosmos')) {
    const endpoint = process.env.LOOM_COSMOS_ENDPOINT;
    if (!endpoint) {
      console.error('ratchet-eval-floors: --cosmos requires LOOM_COSMOS_ENDPOINT');
      process.exit(2);
    }
    const windowN = Number(opt('--window') ?? '5');
    const db = process.env.LOOM_COSMOS_DATABASE || 'loom';
    const { CosmosClient } = await import('@azure/cosmos');
    const { DefaultAzureCredential } = await import('@azure/identity');
    const client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
    const { resources } = await client
      .database(db)
      .container('loom-copilot-evals')
      .items.query(
        `SELECT c.surface, c.startedAt, c.totals FROM c WHERE c.docType = 'eval-run' ORDER BY c.startedAt DESC OFFSET 0 LIMIT 1000`,
      )
      .fetchAll();
    // newest-first per surface, keep the window
    const bySurface = new Map();
    for (const d of resources) {
      const list = bySurface.get(d.surface) ?? [];
      if (list.length < windowN) list.push(d);
      bySurface.set(d.surface, list);
    }
    for (const [, docs] of bySurface) for (const d of docs) add(normalizeRuns(d));
    return observations;
  }

  const files = optAll('--artifact');
  const dir = opt('--runs-dir');
  if (dir) {
    for (const f of fs.readdirSync(path.resolve(repo, dir)).sort()) {
      if (f.endsWith('.json')) files.push(path.join(path.resolve(repo, dir), f));
    }
  }
  if (files.length === 0) {
    console.error('ratchet-eval-floors: pass --artifact <run.json> (repeatable), --runs-dir <dir>, or --cosmos');
    process.exit(2);
  }
  for (const f of files) add(normalizeRuns(readJson(f)));
  return observations;
}

const floorsDoc = readJson(FLOORS_PATH);
const observations = await collectObservations();
const { next, changes, skipped } = ratchetFloors(floorsDoc, observations, { minRuns });

for (const s of skipped) console.log(`  skip: ${s}`);
if (changes.length === 0) {
  console.log('ratchet-eval-floors: no raises — every observed floor-candidate is at or below the current floor (raise-only; nothing to do).');
  process.exit(0);
}
console.log(`ratchet-eval-floors: ${changes.length} raise(s) over a ${minRuns}+-run streak:`);
for (const c of changes) {
  const rule = RATCHET_RULES[c.metric];
  console.log(`  ${c.surface}.${c.metric}: ${c.from ?? '(none)'} → ${c.to}  (min observed − ${rule.margin}, cap ${rule.cap})`);
}

if (!has('--write')) {
  console.log('\nDry-run. Re-run with --write to apply, then open the change as its OWN ratchet PR.');
  process.exit(0);
}

next._meta = next._meta ?? {};
next._meta.lastRatchet = new Date().toISOString();
fs.writeFileSync(FLOORS_PATH, JSON.stringify(next, null, 2) + '\n');
console.log(`\nWrote ${path.relative(repo, FLOORS_PATH)} — commit this on its own branch as a ratchet PR (raise-only).`);
