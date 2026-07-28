#!/usr/bin/env node
/**
 * B-N19b — dump the canonical OpenAPI document that BOTH SDKs are generated from.
 *
 * The single source of truth is `apps/fiab-console/lib/openapi/spec.ts`
 * (`buildOpenApiSpec()`), which is what `GET /api/openapi.json` serves verbatim.
 * This script imports that TypeScript module directly using Node's built-in
 * type-stripping (Node >= 22.6; on >= 22.18 the flag is a no-op) and writes the
 * document to `sdk/openapi.json`.
 *
 * `sdk/openapi.json` is COMMITTED on purpose:
 *   - the Python generator (`sdk/python/csa-loom/scripts/generate_client.py`)
 *     reads it without needing a Node toolchain;
 *   - the Go provider's contract test reads it without needing a live console;
 *   - a vitest assertion (`lib/openapi/__tests__/sdk-snapshot.test.ts`) pins it
 *     byte-for-byte against `buildOpenApiSpec('')`, so an API change that is not
 *     re-dumped fails the console test suite;
 *   - the `sdk-contract` CI lane re-runs this script and `git diff --exit-code`s,
 *     so drift fails CI in a second, independent place.
 *
 * Run:  node sdk/scripts/dump-openapi.mjs           (writes)
 *       node sdk/scripts/dump-openapi.mjs --check   (fails on drift, writes nothing)
 *
 * The server URL is deliberately dumped as the relative default (`/`) so the
 * snapshot is deployment-independent — a generated client resolves the base URL
 * at runtime from its own configuration (Commercial or Government), never from
 * a host baked into this file.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SDK_ROOT, '..');
const SPEC_TS = path.join(REPO_ROOT, 'apps', 'fiab-console', 'lib', 'openapi', 'spec.ts');
const OUT = path.join(SDK_ROOT, 'openapi.json');

async function loadSpec() {
  const url = `file://${SPEC_TS.split(path.sep).join('/')}`;
  const mod = await import(url);
  if (typeof mod.buildOpenApiSpec !== 'function') {
    throw new Error(`buildOpenApiSpec is not exported from ${SPEC_TS}`);
  }
  // Empty baseUrl -> the relative '/' server entry (deployment-independent).
  return mod.buildOpenApiSpec('');
}

async function main() {
  const check = process.argv.includes('--check');
  const spec = await loadSpec();
  const next = JSON.stringify(spec, null, 2) + '\n';

  if (check) {
    if (!fs.existsSync(OUT)) {
      console.error(`[sdk] MISSING ${path.relative(REPO_ROOT, OUT)} — run: node sdk/scripts/dump-openapi.mjs`);
      process.exit(1);
    }
    // Normalise line endings: `.gitattributes` pins sdk/** to LF, but a
    // pre-existing CRLF working copy must not make the drift gate lie.
    const current = fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
    if (current !== next) {
      console.error(
        `[sdk] DRIFT: ${path.relative(REPO_ROOT, OUT)} does not match buildOpenApiSpec().\n` +
          '      The API contract changed but the SDK snapshot was not re-dumped.\n' +
          '      Fix: node sdk/scripts/dump-openapi.mjs && python sdk/python/csa-loom/scripts/generate_client.py',
      );
      process.exit(1);
    }
    console.log(`[sdk] OK ${path.relative(REPO_ROOT, OUT)} matches buildOpenApiSpec()`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, next, 'utf8');
  const ops = Object.values(spec.paths).reduce(
    (n, item) =>
      n +
      Object.entries(item).filter(([verb, op]) => verb !== 'parameters' && op && typeof op === 'object' && 'operationId' in op)
        .length,
    0,
  );
  console.log(`[sdk] wrote ${path.relative(REPO_ROOT, OUT)} — ${Object.keys(spec.paths).length} paths, ${ops} operations`);
}

main().catch((e) => {
  console.error('[sdk] dump failed:', e);
  process.exit(1);
});
