#!/usr/bin/env node
/**
 * check-setup-entrypoints — the deployment planner must stay REACHABLE.
 *
 * WHY THIS GUARD EXISTS (deploy-integrity.md R4/R5; design §1.3).
 *
 * `apps/fiab-console/app/setup/page.tsx` used to call
 * `redirect('/admin/landing-zones?from=setup')` whenever a hub already existed.
 * The consequence was not cosmetic: the ONLY surface in the product with
 * multi-subscription discovery, per-service adopt-or-deploy-new, and a
 * reviewable plan became unreachable on precisely the estate that needs it — an
 * existing one. Brownfield was, in effect, not shipped.
 *
 * The "second hub" invariant is enforced server-side in POST
 * /api/setup/deploy (topology='tenant' is rejected when a hub exists). The
 * redirect never was the guard. So it must not come back.
 *
 * This check therefore fails when:
 *   1. `app/setup/page.tsx` contains a `redirect(` call, or
 *   2. the page no longer renders `<SetupWizardPane`, i.e. the planner was
 *      removed or swapped for something else, or
 *   3. the page file is missing entirely.
 *
 * Rule 2 and 3 matter because rule 1 alone is trivially satisfiable by deleting
 * the wizard — a guard that can be satisfied by removing the thing it protects
 * is a guard that cannot fail.
 *
 * Self-test: `node scripts/ci/check-setup-entrypoints.mjs --self-test` runs the
 * detector over synthetic sources and asserts each rule fires. That is the
 * mutation proof: break what it protects, confirm RED.
 *
 * Exit codes: 0 pass, 1 violation, 2 the check itself could not run (which is
 * NOT a pass — an unreadable file is unknown, not clean).
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const PAGE = join(REPO, 'apps', 'fiab-console', 'app', 'setup', 'page.tsx');

/**
 * The detector. Pure over source text so the self-test exercises the SAME code
 * path the real check runs — not a re-implementation of it.
 *
 * @param {string} source
 * @returns {{id: string, message: string}[]}
 */
export function findViolations(source) {
  const out = [];

  // Strip block and line comments before looking for `redirect(` so the
  // explanatory comment in the file (which necessarily names the call) does not
  // trip the guard, while a real call still does.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  if (/\bredirect\s*\(/.test(code)) {
    out.push({
      id: 'setup-redirect',
      message:
        'app/setup/page.tsx calls redirect(). The deployment planner must stay reachable on an estate that already has a hub — that is the only estate brownfield planning applies to. The second-hub invariant is enforced in POST /api/setup/deploy, not here.',
    });
  }

  if (!/<\s*SetupWizardPane\b/.test(code)) {
    out.push({
      id: 'setup-wizard-missing',
      message:
        'app/setup/page.tsx no longer renders <SetupWizardPane />. The planner surface must be present — removing it satisfies the no-redirect rule while deleting the capability it protects.',
    });
  }

  return out;
}

function selfTest() {
  /** @type {{name: string, source: string, expect: string[]}[]} */
  const cases = [
    {
      name: 'compliant page',
      source: `import { SetupWizardPane } from '@/lib/panes/setup-wizard';
        // this comment mentions redirect( and must NOT trip the guard
        /* neither must this block comment about redirect('/somewhere') */
        export default function P() { return <PageShell><SetupWizardPane /></PageShell>; }`,
      expect: [],
    },
    {
      name: 'redirect reintroduced',
      source: `import { redirect } from 'next/navigation';
        import { SetupWizardPane } from '@/lib/panes/setup-wizard';
        export default function P() { if (x) { redirect('/admin/landing-zones'); } return <SetupWizardPane />; }`,
      expect: ['setup-redirect'],
    },
    {
      name: 'planner deleted',
      source: `export default function P() { return <PageShell>nothing here</PageShell>; }`,
      expect: ['setup-wizard-missing'],
    },
    {
      name: 'both',
      source: `import { redirect } from 'next/navigation';
        export default function P() { redirect('/elsewhere'); }`,
      expect: ['setup-redirect', 'setup-wizard-missing'],
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const got = findViolations(c.source).map((v) => v.id).sort();
    const want = [...c.expect].sort();
    const ok = got.length === want.length && got.every((g, i) => g === want[i]);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name} — expected [${want}], got [${got}]`);
    if (!ok) failed++;
  }
  if (failed > 0) {
    console.error(`\ncheck-setup-entrypoints self-test FAILED (${failed} case(s)).`);
    process.exit(1);
  }
  console.log('\ncheck-setup-entrypoints self-test passed.');
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest();

  if (!existsSync(PAGE)) {
    console.error(
      'check-setup-entrypoints: apps/fiab-console/app/setup/page.tsx does not exist. ' +
        'The deployment planner entry point is missing — this is a failure, not a pass.',
    );
    process.exit(2);
  }

  let source;
  try {
    source = readFileSync(PAGE, 'utf8');
  } catch (e) {
    // An unreadable file is UNKNOWN, never clean.
    console.error(`check-setup-entrypoints: could not read the setup page: ${e && e.message}`);
    process.exit(2);
  }

  const violations = findViolations(source);
  if (violations.length === 0) {
    console.log('check-setup-entrypoints: OK — the deployment planner is reachable and rendered.');
    return;
  }
  for (const v of violations) console.error(`check-setup-entrypoints: [${v.id}] ${v.message}`);
  process.exit(1);
}

main();
