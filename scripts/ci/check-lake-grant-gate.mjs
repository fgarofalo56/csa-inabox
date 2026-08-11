#!/usr/bin/env node
/**
 * GUARDRAIL: a module that reaches INTO the lake account must gate on
 * `loomStorageGrantable`, never on `!empty(loomStorageAccount)` alone.
 *
 * WHY THIS EXISTS (2026-08-10, run 31435481880)
 * ---------------------------------------------
 * `loomStorageAccount` used to serve two incompatible purposes at once:
 *
 *   1. a STRING the Console binds (LOOM_ADLS_ACCOUNT and every derived URL), and
 *   2. the enable-condition for modules that create role assignments or take
 *      `existing` references INSIDE `loomDlzRg`.
 *
 * (1) is safe across subscriptions. (2) is not — a subscription-scoped
 * deployment cannot touch a resource group in another subscription. So on a
 * multi-sub estate the name had to stay EMPTY purely to keep (2) from firing,
 * which is why such an estate could not bind its own lake at all and 25
 * capabilities sat blocked on resources it already owned.
 *
 * #3196 split them: `loomStorageGrantable = !empty(loomStorageAccount) &&
 * loomStorageAccountSameSub`. But it converted only FOUR of the seven
 * consumers, and the three it missed took the estate's first real apply down:
 *
 *   aas.bicep:52                    storageAccounts            existing
 *     -> ResourceNotFound: '…/saloomdefaulttr4nm4dcgsq' under resource group
 *        'rg-csa-loom-admin-centralus' was not found
 *   org-visuals-rbac.bicep:47       blobServices/containers    existing
 *     -> ParentResourceNotFound on the blobServices write
 *   risingwaveLakeRbac              role assignment on the lake
 *
 * A partial split is worse than no split: it makes the multi-sub path LOOK
 * wired right up to the point ARM refuses.
 *
 * THE RULE
 * --------
 * In modules/admin-plane/main.bicep, no `module … = if (…)` condition may test
 * `!empty(loomStorageAccount)`. Use `loomStorageGrantable`. Binding sites (env
 * vars, string interpolation) are unaffected and unrestricted — this only
 * governs MODULE ACTIVATION, which is what reaches into the resource group.
 *
 * On a single-sub estate `loomStorageAccountSameSub` is true, so
 * `loomStorageGrantable` is exactly equivalent to the old condition and nothing
 * changes. The rule costs single-sub nothing.
 *
 * SELF-DEFENCE: refuses to pass vacuously. If it cannot find the
 * `loomStorageGrantable` definition, or finds zero consumers of it, it FAILS —
 * a scanner that stopped matching is the defect it exists to catch.
 *
 * Usage: node scripts/ci/check-lake-grant-gate.mjs [admin-plane-main.bicep]
 */
import { readFileSync } from 'node:fs';

const DEFAULT_FILE = 'platform/fiab/bicep/modules/admin-plane/main.bicep';
const FILE = process.argv[2] || DEFAULT_FILE;
const IS_DEFAULT = FILE === DEFAULT_FILE;

const src = readFileSync(FILE, 'utf8');
const lines = src.split(/\r?\n/);

/** A module activation condition testing the raw emptiness check. */
const RAW_GATED = /^\s*module\s+\S+\s+'[^']+'\s*=\s*if\s*\(.*!empty\(loomStorageAccount\)/;

const violations = [];
lines.forEach((line, i) => {
  if (RAW_GATED.test(line)) {
    violations.push({ line: i + 1, text: line.trim().slice(0, 120) });
  }
});

const hasDefinition = /var\s+loomStorageGrantable\s*=\s*!empty\(loomStorageAccount\)\s*&&\s*loomStorageAccountSameSub/.test(src);
const consumers = (src.match(/loomStorageGrantable/g) || []).length - (hasDefinition ? 1 : 0);

if (violations.length > 0) {
  console.error(
    `\n[lake-grant-gate] ${violations.length} module(s) activate on !empty(loomStorageAccount):\n`,
  );
  for (const v of violations) console.error(`  ${FILE}:${v.line}\n      ${v.text}`);
  console.error(
    '\n  Those modules create role assignments or take `existing` references INSIDE\n' +
      '  loomDlzRg, which on a multi-sub estate is the ADMIN resource group — the lake\n' +
      '  is in another subscription entirely. Measured on run 31435481880:\n' +
      "    ResourceNotFound      storageAccounts/saloomdefaulttr4nm4dcgsq\n" +
      "    ParentResourceNotFound storageAccounts/blobServices\n" +
      '\n  Use `loomStorageGrantable`. On single-sub it is exactly equivalent, so this\n' +
      '  costs a single-sub estate nothing. Binding sites (env vars, string\n' +
      '  interpolation) are unaffected — only MODULE ACTIVATION is governed.\n',
  );
  process.exit(1);
}

if (IS_DEFAULT && (!hasDefinition || consumers === 0)) {
  console.error(
    `[lake-grant-gate] REFUSING TO PASS: definition found=${hasDefinition}, consumers=${consumers}. ` +
      'This file defines loomStorageGrantable and several modules use it. The matcher has ' +
      'stopped matching — fix the scanner, do not ship a green check that measures nothing.',
  );
  process.exit(1);
}

console.log(
  `[lake-grant-gate] OK — 0 modules activate on the raw check; ${consumers} consumer(s) use loomStorageGrantable.`,
);
