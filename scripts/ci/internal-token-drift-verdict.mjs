/**
 * internal-token drift verdict (#3056).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * `LOOM_INTERNAL_TOKEN` is held in four different places — the `loom-console`
 * Container Apps secret, the `loom-internal-token` secret on every consumer
 * Container Apps JOB, the `LOOM_INTERNAL_TOKEN` GitHub Actions secret, and
 * (opt-in tiers) sibling apps like `loom-copilot-maf`. Until now NOTHING
 * compared them. The only detector the estate had was a 401 storm in an
 * unrelated gate, which is how a mismatch introduced by a deploy went unnoticed
 * until 153/153 eval probes failed and #2929's reindex started rejecting.
 *
 * This module is the verdict half of that detector: pure, mutation-proved, and
 * fail-LOUD. It compares FINGERPRINTS (sha256, first 12 hex) — never values —
 * so a drift receipt can be pasted into an issue without leaking a secret.
 *
 * ── THE THREE FAILURE CLASSES IT MUST SEPARATE ───────────────────────────────
 * 1. `drift`   — two holders disagree. The 2026-08-06/07/08 outage.
 * 2. `missing` — a declared consumer holds NO token at all. This is the #3089
 *                class: bicep handed `LOOM_INTERNAL_TOKEN=secretref:…` to five
 *                always-deployed jobs while declaring the secret conditionally,
 *                and `isValidInternalToken()` does `if (!expected) return false`
 *                — so every callback failed closed on a healthy estate.
 * 3. `unknown` — a holder could NOT be read. Per the "UNKNOWN reported as
 *                NEGATIVE" class this must never collapse into either "matches"
 *                or "absent": a read that did not happen is not evidence about
 *                the value. It fails the run on its own.
 *
 * All three are non-zero exits. A guard whose verdict cannot change when a
 * holder diverges is not watching anything, so the tests in
 * `scripts/ci/__tests__/internal-token-drift-verdict.test.mjs` mutate each
 * holder in turn and assert the verdict flips.
 *
 * Usage:
 *   node scripts/ci/internal-token-drift-verdict.mjs <holders.json>
 * where holders.json is `{ "estate": "commercial", "holders": [ … ] }` and each
 * holder is `{ name, kind, state: 'present'|'absent'|'unknown', fingerprint?, detail? }`.
 */

/** @typedef {'present'|'absent'|'unknown'} HolderState */

/**
 * @typedef {object} Holder
 * @property {string} name         resource name, e.g. `loom-console`
 * @property {string} kind         `console` | `job` | `github-secret` | `app`
 * @property {HolderState} state
 * @property {string} [fingerprint] sha256 first-12, required when state==='present'
 * @property {string} [detail]      why it is absent/unknown (verbatim tool output)
 * @property {boolean} [required]   a declared consumer that MUST hold the token
 */

/**
 * Compare every holder's fingerprint and produce a fail-loud verdict.
 *
 * @param {{estate?: string, holders: Holder[]}} input
 * @returns {{verdict: 'ok'|'drift'|'missing'|'unknown'|'empty', exitCode: number,
 *            message: string, lines: string[], majority: string|null}}
 */
export function internalTokenDriftVerdict(input) {
  const estate = input?.estate ?? 'unknown-estate';
  const holders = Array.isArray(input?.holders) ? input.holders : [];
  const lines = [];

  if (holders.length === 0) {
    return {
      verdict: 'empty',
      exitCode: 1,
      majority: null,
      lines,
      message:
        `[internal-token-drift] FAIL (${estate}) — ZERO holders were collected. ` +
        'A drift check over an empty set passes trivially and measures nothing, ' +
        'which is the exact defect class this guard exists to catch. Fix the collector.',
    };
  }

  // A holder that claims `present` with no fingerprint is a broken collector,
  // not a passing holder — treat it as unknown rather than silently skipping it.
  const normalized = holders.map((h) => {
    if (h.state === 'present' && !h.fingerprint) {
      return { ...h, state: /** @type {HolderState} */ ('unknown'), detail: 'collector reported present with no fingerprint' };
    }
    return h;
  });

  for (const h of normalized) {
    const fp = h.state === 'present' ? h.fingerprint : h.state.toUpperCase();
    lines.push(`  ${h.kind.padEnd(14)} ${h.name.padEnd(34)} ${fp}${h.detail ? `  (${h.detail})` : ''}`);
  }

  const unknown = normalized.filter((h) => h.state === 'unknown');
  if (unknown.length > 0) {
    return {
      verdict: 'unknown',
      exitCode: 1,
      majority: null,
      lines,
      message:
        `[internal-token-drift] FAIL (${estate}) — ${unknown.length} holder(s) could NOT be read: ` +
        `${unknown.map((h) => `${h.kind}/${h.name}`).join(', ')}. ` +
        'A read that did not happen is NOT evidence that the token matches. ' +
        'Resolve the access/tooling error and re-run rather than treating this as a pass.',
    };
  }

  const missing = normalized.filter((h) => h.state === 'absent' && h.required !== false);
  if (missing.length > 0) {
    return {
      verdict: 'missing',
      exitCode: 1,
      majority: null,
      lines,
      message:
        `[internal-token-drift] FAIL (${estate}) — ${missing.length} declared consumer(s) hold NO internal token: ` +
        `${missing.map((h) => `${h.kind}/${h.name}`).join(', ')}. ` +
        'isValidInternalToken() fails closed on an empty expected value, so every internal callback ' +
        'from these holders 401s on an otherwise healthy estate (the #3089 class).',
    };
  }

  const present = normalized.filter((h) => h.state === 'present');
  const distinct = [...new Set(present.map((h) => h.fingerprint))];

  if (distinct.length <= 1) {
    return {
      verdict: 'ok',
      exitCode: 0,
      majority: distinct[0] ?? null,
      lines,
      message:
        `[internal-token-drift] OK (${estate}) — all ${present.length} holder(s) agree ` +
        `at fingerprint ${distinct[0] ?? 'n/a'}.`,
    };
  }

  // Drift. Name the console's fingerprint as the reference: the console is the
  // owner of record (#3056) — every other holder is supposed to follow it.
  const console_ = present.find((h) => h.kind === 'console');
  const reference = console_?.fingerprint ?? null;
  const off = present.filter((h) => h.fingerprint !== reference);

  return {
    verdict: 'drift',
    exitCode: 1,
    majority: reference,
    lines,
    message:
      `[internal-token-drift] FAIL (${estate}) — the internal token DIVERGED across holders. ` +
      `Owner of record is the console secret (${reference ?? 'NOT COLLECTED'}); ` +
      `off-reference: ${off.map((h) => `${h.kind}/${h.name}=${h.fingerprint}`).join(', ')}. ` +
      'Every internal callback from an off-reference holder will 401 the moment the console replica ' +
      'serving the old value cycles. Re-converge with scripts/csa-loom/resolve-internal-token.sh and ' +
      'see docs/fiab/runbooks/internal-token-ownership.md.',
  };
}

/** CLI entry — reads the collector's JSON and exits non-zero on any non-ok verdict. */
async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/ci/internal-token-drift-verdict.mjs <holders.json>');
    process.exit(2);
  }
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(file, 'utf8');
  const result = internalTokenDriftVerdict(JSON.parse(raw));
  console.log('[internal-token-drift] holders (fingerprints only — no values):');
  for (const l of result.lines) console.log(l);
  console.log(result.message);
  if (result.exitCode !== 0 && process.env.GITHUB_ACTIONS) {
    console.log(`::error::${result.message}`);
  }
  process.exit(result.exitCode);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`[internal-token-drift] FAIL — verdict could not be computed: ${e.message}`);
    process.exit(1);
  });
}
