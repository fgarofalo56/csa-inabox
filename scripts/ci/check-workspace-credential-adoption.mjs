#!/usr/bin/env node
/**
 * GUARDRAIL: workspace-credential-adoption (merge-blocker) — loom-next-level I5
 * ---------------------------------------------------------------------------
 * RULE (shrink-only adoption ratchet, same mechanic as check-no-raw-px /
 * the vitest coverage floor):
 *
 *   Server-side Azure clients must resolve credentials through the
 *   per-workspace credential FACTORY —
 *     apps/fiab-console/lib/azure/workspace-credential-factory.ts
 *       - credentialFor(ctx?)            (async, per-call resolution)
 *       - workspaceScopedCredential(ctx?) (lazy TokenCredential adapter — the
 *         drop-in replacement for a module-level ChainedTokenCredential)
 *
 *   Direct `new ChainedTokenCredential(…)` constructions resolve the identity
 *   ONCE at module load and can never carry a workspace context, so the
 *   I3 shadow audit and the I6 enforce flip cannot see those calls. The count
 *   of direct constructions may therefore only ever SHRINK. New code MUST use
 *   the factory (or `uamiArmCredential()` for pure admin/ARM-plane clients —
 *   that helper is itself factory-served and stays out of this count via the
 *   definition allowlist).
 *
 * BASELINE: set to the repo-wide count at I5 (post pilot migration). When you
 * migrate a client, re-run this script — it tells you the new lower number to
 * ratchet BASELINE down to. Raising the number is a rule violation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONSOLE_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');
const SCAN_ROOTS = [path.join(CONSOLE_ROOT, 'lib'), path.join(CONSOLE_ROOT, 'app')];

// Direct-construction count allowed. SHRINK-ONLY — lower it as clients migrate.
const BASELINE = 130;

// Files that legitimately construct the chain (they DEFINE the shared chain
// the factory serves) — POSIX repo-relative suffixes.
const DEFINITION_ALLOWLIST = [
  'apps/fiab-console/lib/azure/arm-credential.ts',
  'apps/fiab-console/lib/azure/aca-managed-identity.ts',
  'apps/fiab-console/lib/azure/workspace-credential-factory.ts',
];

const NEEDLE = 'new ChainedTokenCredential(';

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      yield* walk(p);
    } else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) {
      yield p;
    }
  }
}

const rel = (p) => path.relative(REPO_ROOT, p).split(path.sep).join('/');

let count = 0;
const perFile = new Map();
for (const root of SCAN_ROOTS) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    const r = rel(file);
    if (DEFINITION_ALLOWLIST.some((a) => r === a)) continue;
    const text = fs.readFileSync(file, 'utf8');
    let idx = 0; let n = 0;
    while ((idx = text.indexOf(NEEDLE, idx)) !== -1) { n++; idx += NEEDLE.length; }
    if (n > 0) { perFile.set(r, n); count += n; }
  }
}

console.log(`[ws-credential-adoption] direct ChainedTokenCredential constructions: ${count} (baseline ${BASELINE}, shrink-only)`);

if (count > BASELINE) {
  console.error(`\n[ws-credential-adoption] FAIL — ${count} direct constructions > baseline ${BASELINE}.`);
  console.error('New Azure-client code must resolve credentials through the factory:');
  console.error("  import { workspaceScopedCredential } from '@/lib/azure/workspace-credential-factory';");
  console.error("  const credential = workspaceScopedCredential(); // or credentialFor({ workspaceId })");
  console.error('(pure admin/ARM-plane clients may use uamiArmCredential() from lib/azure/arm-credential.)');
  console.error('\nOffending files (occurrences):');
  for (const [f, n] of [...perFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.error(`  ${String(n).padStart(3)}  ${f}`);
  }
  process.exit(1);
}

if (count < BASELINE) {
  console.log(`[ws-credential-adoption] NOTE — count dropped below baseline; ratchet it: set BASELINE = ${count} in scripts/ci/check-workspace-credential-adoption.mjs (this run still passes).`);
}
console.log('[ws-credential-adoption] OK.');
