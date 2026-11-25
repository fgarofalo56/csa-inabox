#!/usr/bin/env node
/**
 * Decision logic for .github/workflows/ops-kv-secret-sync.yml, extracted so it
 * can be tested (scripts/ci/__tests__/kv-secret-sync-plan.test.mjs).
 *
 * WHY (#5483): the in-VNet runner's GitHub PAT lived ONLY as the secret
 * `github-pat` on the Container Apps JOB gh-aca-runner, with no expiry on
 * record anywhere the secret-expiry monitor reads. When it died every
 * `loom-aca` workflow plausibly queued for ~10 h with nothing watching. The
 * sync workflow now mirrors a JOB secret too and stamps a Key Vault expiry on
 * the mirror, so the monitor's 60/30/7-day bands cover the PAT.
 *
 * Nothing here touches a secret VALUE. It decides:
 *   - which `az` command group reads the source (`containerapp` vs
 *     `containerapp job`);
 *   - whether an `expires_on` input is a real, future YYYY-MM-DD date, and the
 *     instant to stamp (00:00:00Z of that date: the START of the day, so the
 *     monitor alerts no later than the credential actually dies);
 *   - whether the expiry read back from the vault equals the one requested.
 *
 * CLI (used by the workflow):
 *   node scripts/ci/kv-secret-sync-plan.mjs source-group <containerapp|job>
 *       -> prints "containerapp" or "containerapp job"; exit 2 on any other kind
 *   node scripts/ci/kv-secret-sync-plan.mjs expiry <YYYY-MM-DD|"">
 *       -> prints the ISO instant to stamp (empty line when unset); exit 2 when
 *          the value is malformed or not after today's UTC date
 *   node scripts/ci/kv-secret-sync-plan.mjs effective-exp <validated-iso|""> <current-expires|"">
 *       -> prints "<input|carried|none> <iso>"; a blank input carries the
 *          current version's expiry forward instead of erasing it
 *   node scripts/ci/kv-secret-sync-plan.mjs check-exp <expected-iso> <read-back>
 *       -> exit 0 when the two denote the same instant, exit 1 otherwise
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GROUPS = Object.freeze({
  containerapp: ['containerapp'],
  job: ['containerapp', 'job'],
});

/** @param {string} kind */
export function sourceGroup(kind) {
  if (!Object.prototype.hasOwnProperty.call(GROUPS, kind)) {
    throw new Error(`source_kind '${kind}' is not one of: ${Object.keys(GROUPS).join(', ')}`);
  }
  return GROUPS[kind];
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * @param {string} value  the raw workflow input ('' = no expiry requested)
 * @param {number} nowMs
 * @returns {{ ok: true, iso: string | null } | { ok: false, reason: string }}
 */
export function validateExpiresOn(value, nowMs) {
  const v = (value ?? '').trim();
  if (v === '') return { ok: true, iso: null };
  const m = DATE_RE.exec(v);
  if (!m) return { ok: false, reason: `expires_on '${v}' does not match YYYY-MM-DD` };
  const [, y, mo, d] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  const iso = new Date(ms).toISOString();
  // Round-trip: Date.UTC silently rolls 2027-02-30 into March.
  if (iso.slice(0, 10) !== v) {
    return { ok: false, reason: `expires_on '${v}' is not a real calendar date` };
  }
  const today = new Date(nowMs).toISOString().slice(0, 10);
  if (v <= today) {
    return { ok: false, reason: `expires_on '${v}' is not after today's UTC date ${today}` };
  }
  return { ok: true, iso: iso.replace('.000Z', 'Z') };
}

/**
 * @param {string} expectedIso
 * @param {string} readBack  `attributes.expires` as az prints it, e.g. 2027-01-31T00:00:00+00:00
 */
export function expiryMatches(expectedIso, readBack) {
  const a = Date.parse(expectedIso);
  const b = Date.parse((readBack ?? '').trim());
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

/**
 * Which expiry to stamp on the new KV secret version.
 *
 * A blank `expires_on` must NOT erase an expiry stamped by an earlier run:
 * `az keyvault secret set` without `--expires` creates a version with no
 * expiry, and the monitor would silently stop counting down. So a blank input
 * carries the CURRENT version's `attributes.expires` forward.
 *
 * @param {string|null} requestedIso  validated `expires_on` instant, or null/'' when blank
 * @param {string|null} currentExpires  current version's attributes.expires as az prints it ('' = none)
 * @returns {{ iso: string | null, source: 'input' | 'carried' | 'none' }}
 */
export function effectiveExpiry(requestedIso, currentExpires) {
  if (requestedIso) return { iso: requestedIso, source: 'input' };
  const ms = Date.parse((currentExpires ?? '').trim());
  if (Number.isFinite(ms)) {
    return { iso: new Date(ms).toISOString().replace('.000Z', 'Z'), source: 'carried' };
  }
  return { iso: null, source: 'none' };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'source-group') {
    try {
      process.stdout.write(`${sourceGroup(rest[0] ?? '').join(' ')}\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      return 2;
    }
  }
  if (cmd === 'expiry') {
    const r = validateExpiresOn(rest[0] ?? '', Date.now());
    if (!r.ok) {
      process.stderr.write(`${r.reason}\n`);
      return 2;
    }
    process.stdout.write(`${r.iso ?? ''}\n`);
    return 0;
  }
  if (cmd === 'effective-exp') {
    const r = effectiveExpiry(rest[0] ?? '', rest[1] ?? '');
    process.stdout.write(`${r.source} ${r.iso ?? ''}\n`);
    return 0;
  }
  if (cmd === 'check-exp') {
    return expiryMatches(rest[0] ?? '', rest[1] ?? '') ? 0 : 1;
  }
  process.stderr.write('usage: kv-secret-sync-plan.mjs source-group|expiry|check-exp ...\n');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
