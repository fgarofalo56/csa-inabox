#!/usr/bin/env node
/**
 * check-uc-token-exchange-params.mjs — the client's token-exchange request MUST
 * match the live authz harness, param for param.
 *
 * ## Why this guard exists
 *
 * `lib/azure/uc-token-exchange.ts` carried a comment claiming its params were
 * "byte-identical to the ones the live harness uses against the real image".
 * They were not. The harness sends FOUR form params; the client sent THREE,
 * omitting `requested_token_type`. The header even said "the three form params
 * it expects" one line above "these four values are byte-identical" — the prose
 * had counted the harness correctly and the code implemented one fewer.
 *
 * Nothing caught it for months:
 *   - Every unit test doubled the exchange endpoint with a stub that returned an
 *     `access_token` for ANY request body, so the suite modelled the CODE, not
 *     the server (the `fixtures that model the code` failure class).
 *   - The exchange is only reachable with a real Entra token against a real
 *     catalog, so no CI job exercised it.
 *
 * Result: #2679's exchange had never once completed against a live server — for
 * the Unity path or the Iceberg path. Measured live 2026-08-07, warm, both:
 *   HTTP 400 {"error_code":"INVALID_ARGUMENT",
 *             "message":"Unsupported requested token type: null"}
 *
 * A unit test pinning the four params (added alongside this guard) stops the
 * client regressing on its own. This guard stops something a test cannot see:
 * the client and the HARNESS drifting apart. The harness is the only artifact in
 * the repo that has actually been run against the real image, so it — not the
 * client, and not a comment — is the source of truth for the wire contract.
 *
 * ## What it checks
 *
 * The set of `--data-urlencode` param NAMES in the harness's token-exchange
 * curl calls equals the set of param names the client puts in its URLSearchParams.
 *
 * Names only, deliberately: `subject_token` carries a runtime value in the
 * client and a shell variable in the harness, so comparing VALUES would compare
 * two things that are correctly different. The defect this exists to catch is a
 * MISSING param, which is a name-level fact.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const CLIENT = path.join(ROOT, 'apps/fiab-console/lib/azure/uc-token-exchange.ts');
const HARNESS = path.join(ROOT, 'apps/loom-unity/tests/authz/authz-e2e.sh');

/** The exchange endpoint both sides must be talking about. */
const EXCHANGE_PATH = '/api/1.0/unity-control/auth/tokens';

function fail(msg) {
  console.error(`[uc-token-exchange-params] FAIL — ${msg}`);
  process.exit(1);
}

for (const f of [CLIENT, HARNESS]) {
  if (!fs.existsSync(f)) {
    // Fail CLOSED. A guard that silently passes when its subject is missing is
    // the defect it exists to prevent, wearing a new hat.
    fail(`expected file not found: ${path.relative(ROOT, f)}. If it moved, update this guard — do not delete it.`);
  }
}

const clientSrc = fs.readFileSync(CLIENT, 'utf8');
const harnessSrc = fs.readFileSync(HARNESS, 'utf8');

// ---- client: the URLSearchParams literal in the exchange body ---------------
const bodyMatch = clientSrc.match(/new URLSearchParams\(\{([\s\S]*?)\}\)/);
if (!bodyMatch) fail('could not find the `new URLSearchParams({...})` exchange body in the client.');
const clientParams = new Set(
  [...bodyMatch[1].matchAll(/^\s*([a-z_]+)\s*:/gm)].map((m) => m[1]),
);
if (clientParams.size === 0) fail('parsed the client exchange body but found no params in it.');

// ---- harness: --data-urlencode names on the token-exchange curls ------------
// BOTH quote styles. The three constant params are single-quoted; `subject_token`
// is DOUBLE-quoted because it interpolates a shell variable
// (`--data-urlencode "subject_token=$TOK"`). A single-quote-only pattern reads
// that as absent and reports the client's own `subject_token` as an EXTRA param
// — which is how the first version of this guard failed, on a real file.
if (!harnessSrc.includes(EXCHANGE_PATH)) {
  fail(`the harness no longer references ${EXCHANGE_PATH} — this guard is comparing against the wrong thing.`);
}
const harnessParams = new Set(
  [...harnessSrc.matchAll(/--data-urlencode\s+['"]([a-z_]+)=/g)].map((m) => m[1]),
);
if (harnessParams.size === 0) fail('found no --data-urlencode params in the authz harness.');

// ---- compare ----------------------------------------------------------------
const missing = [...harnessParams].filter((p) => !clientParams.has(p)).sort();
const extra = [...clientParams].filter((p) => !harnessParams.has(p)).sort();

if (missing.length || extra.length) {
  const lines = [];
  if (missing.length) {
    lines.push(
      `  MISSING from the client: ${missing.join(', ')}\n`
      + `    The harness sends these against the REAL image and the client does not. `
      + `A missing param is answered 400 by the server (e.g. omitting `
      + `requested_token_type gives "Unsupported requested token type: null"), which `
      + `makes the exchange — and therefore ALL authenticated catalog access — fail.`,
    );
  }
  if (extra.length) {
    lines.push(
      `  EXTRA in the client: ${extra.join(', ')}\n`
      + `    The client sends these and the harness does not. Either the harness is `
      + `stale, or the client is guessing at the upstream contract. Reconcile them — `
      + `the harness is the artifact that has actually run against the real image.`,
    );
  }
  console.error('[uc-token-exchange-params] FAIL — the client and the live authz harness disagree:\n');
  console.error(lines.join('\n\n'));
  console.error(`\n  client:  ${path.relative(ROOT, CLIENT)}`);
  console.error(`  harness: ${path.relative(ROOT, HARNESS)}`);
  process.exit(1);
}

console.log(
  `✓ uc-token-exchange-params: client and live authz harness agree on all `
  + `${harnessParams.size} exchange params (${[...harnessParams].sort().join(', ')}).`,
);
