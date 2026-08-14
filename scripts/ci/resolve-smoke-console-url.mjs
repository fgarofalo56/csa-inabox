#!/usr/bin/env node
/**
 * Resolve the console URL an EXTERNAL smoke test may probe, from the azd
 * environment the provision step just wrote.
 *
 * WHY THIS EXISTS (#3137)
 * -----------------------
 * Both sovereign deploy lanes carried this on the smoke-test step:
 *
 *     env:
 *       CONSOLE_URL: $(azd env get-values | grep CONSOLE_URL | cut -d= -f2)
 *
 * A workflow `env:` value is a LITERAL. GitHub Actions substitutes `${{ }}`
 * expressions during workflow processing and hands the rest to the runner
 * verbatim; `$( … )` is shell syntax that nothing in that path ever evaluates.
 * So `fiab-smoke-test.sh` received that TEXT as its console URL. Its
 * `${CONSOLE_URL:?}` guard passed (the text is non-empty) and every probe then
 * curled a nonsense address — a step that runs and cannot pass, which is the
 * same class as the `-f`/`|| echo` defect documented in the smoke script's own
 * header.
 *
 * Two further defects sat behind that one, each independently fatal, and worth
 * recording because "fix the `$( )`" alone would have produced a second wrong
 * answer:
 *
 *   1. The smoke step has no `working-directory`, so `azd` would have run at the
 *      repo root where there is no `azure.yaml`.
 *   2. `platform/fiab/bicep/main.bicep` declares `output consoleUrl` — camelCase.
 *      Per Microsoft Learn ("Work with Azure Developer CLI environment
 *      variables" → Output from Bicep) azd writes an output back to the
 *      environment's `.env` under the name AS DECLARED, so `grep CONSOLE_URL`
 *      could never have matched. The same page shows values are written QUOTED
 *      (`API_BASE_URL="…"`), so `cut -d= -f2` would have kept the quotes too.
 *
 * WHICH URL — and why this refuses to answer with `consoleUrl`
 * ------------------------------------------------------------
 * `consoleUrl` is `https://loom-console.<caeDefaultDomain>`, and
 * `container-platform.bicep` creates the managed environment with
 * `internal: true`. That FQDN resolves through Private DNS inside the hub VNet
 * and nowhere else, so a GitHub-hosted runner cannot reach it — which is
 * exactly why `deploy-fiab-commercial.yml` marks its own smoke test
 * best-effort, and why `scripts/csa-loom/redeploy-gov.sh` Phase 4 refuses to
 * curl the `.csa-loom.internal` sentinel rather than reporting the resulting
 * curl failures as product failures.
 *
 * So the only honest answer for an external prober is a PUBLIC ingress:
 * `vanityPublicUrl` (what users actually type) or `frontDoorPublicUrl`. On
 * GCC-High both `frontDoorEnabled` and `deployAppsEnabled` are `true` in
 * `params/gcc-high.bicepparam`, so one exists by construction — its absence
 * after a successful provision is a real defect and is reported as one.
 *
 * Returning the internal URL "so the step has something" would move the failure
 * one line later and mislabel it as a broken Console. Unknown fails closed.
 *
 * SECRETS: the azd environment holds `AZURE_SUBSCRIPTION_ID` among other
 * values. This reads the object from STDIN (never argv, never a temp file) and
 * on failure prints KEY NAMES ONLY — never a value it did not select.
 *
 * Usage:
 *   azd env get-values --output json | node scripts/ci/resolve-smoke-console-url.mjs
 * Tests:
 *   node --test scripts/ci/__tests__/resolve-smoke-console-url.test.mjs
 */

/**
 * Keys that name a PUBLICLY reachable console ingress, most-preferred first.
 * These are the `output` names declared by platform/fiab/bicep/main.bicep.
 */
export const PUBLIC_KEYS = ['vanityPublicUrl', 'frontDoorPublicUrl'];

/** Keys that name a VNet-internal console ingress. Never a valid answer here. */
export const INTERNAL_KEYS = ['consoleUrl'];

/**
 * azd writes bicep outputs under the name as declared, and this repo declares
 * camelCase while every azd sample declares SCREAMING_SNAKE. Rather than bet on
 * one casing, keys are compared with case and separators removed — so
 * `frontDoorPublicUrl`, `FRONT_DOOR_PUBLIC_URL` and `frontdoorpublicurl` are one
 * key. This is a widening, not a guess: it cannot match a DIFFERENT output.
 */
export function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[_-]/g, '');
}

/** A value is usable only if it is a non-empty absolute http(s) URL. */
export function isUsableUrl(value) {
  if (typeof value !== 'string') return false;
  return /^https?:\/\/[^\s]+$/.test(value.trim());
}

function lookup(values, wanted) {
  const target = normalizeKey(wanted);
  for (const [key, value] of Object.entries(values)) {
    if (normalizeKey(key) !== target) continue;
    if (isUsableUrl(value)) return { key, url: String(value).trim() };
    // Present but empty/garbage is NOT a match — an empty `frontDoorPublicUrl`
    // is precisely the "Front Door did not deploy" state this must not hide.
    return null;
  }
  return null;
}

/**
 * @returns {{url:string,key:string,kind:'public'}|{url:string,key:string,kind:'internal'}|{url:null,key:null,kind:null}}
 */
export function pickSmokeUrl(values) {
  for (const wanted of PUBLIC_KEYS) {
    const hit = lookup(values, wanted);
    if (hit) return { ...hit, kind: 'public' };
  }
  for (const wanted of INTERNAL_KEYS) {
    const hit = lookup(values, wanted);
    if (hit) return { ...hit, kind: 'internal' };
  }
  return { url: null, key: null, kind: null };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main() {
  const raw = (await readStdin()).trim();
  if (raw === '') {
    console.error(
      '[resolve-smoke-console-url] STDIN was EMPTY. Expected the JSON object from\n' +
        '  azd env get-values --output json\n' +
        'Nothing is asserted about the estate: this run did not read the azd environment at all.',
    );
    process.exit(1);
  }

  let values;
  try {
    values = JSON.parse(raw);
  } catch (err) {
    console.error(
      `[resolve-smoke-console-url] STDIN is not JSON (${err.message}). ` +
        '`azd env get-values --output json` is the documented machine-readable form; ' +
        'the bare `azd env get-values` KEY="value" stream is not parsed here.',
    );
    process.exit(1);
  }
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    console.error('[resolve-smoke-console-url] STDIN parsed to a non-object; expected a JSON object of environment values.');
    process.exit(1);
  }

  const picked = pickSmokeUrl(values);
  // KEY NAMES ONLY. The azd environment holds AZURE_SUBSCRIPTION_ID and other
  // values that must never reach a log.
  const keyList = Object.keys(values).sort().join(', ') || '(none)';

  if (picked.kind === 'public') {
    console.error(`[resolve-smoke-console-url] public ingress resolved from output \`${picked.key}\`.`);
    process.stdout.write(picked.url);
    return;
  }

  if (picked.kind === 'internal') {
    console.error(
      `[resolve-smoke-console-url] REFUSING to answer with \`${picked.key}\`.\n` +
        '  The only console URL this environment carries is the VNet-INTERNAL one: the Container Apps\n' +
        '  managed environment is created with `internal: true`, so that FQDN resolves through Private\n' +
        '  DNS inside the hub VNet and nowhere else. A GitHub-hosted runner cannot reach it, and\n' +
        '  probing it would report connection failures as Console failures.\n' +
        `  No public ingress output (${PUBLIC_KEYS.join(' / ')}) carries a usable URL.\n` +
        '  On GCC-High that is a DEFECT, not a configuration choice: params/gcc-high.bicepparam sets\n' +
        '  frontDoorEnabled = true and deployAppsEnabled = true, so Front Door should have produced one.\n' +
        '  Check the Front Door module output and the "Approve the Front Door -> ACA private-endpoint\n' +
        '  connection" step.\n' +
        `  Keys present in the azd environment: ${keyList}`,
    );
    process.exit(1);
  }

  console.error(
    '[resolve-smoke-console-url] NO console URL of any kind in the azd environment.\n' +
      `  Looked for (case/separator-insensitive): ${[...PUBLIC_KEYS, ...INTERNAL_KEYS].join(', ')}\n` +
      '  This does NOT establish that the deploy failed — it establishes that the provision wrote back\n' +
      '  no console output, which means the smoke test has no target and must not invent one.\n' +
      `  Keys present in the azd environment: ${keyList}`,
  );
  process.exit(1);
}

// Run only as the process entrypoint — importing this from a test must NOT
// block on stdin.
import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
