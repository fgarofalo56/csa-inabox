#!/usr/bin/env node
/**
 * check-admin-page-reachability.mjs
 *
 * RULE. Every `app/admin/<slug>/page.tsx` is reachable by SOME route in: the
 * admin sidebar (`ADMIN_SECTIONS`), the folded-hub redirect table
 * (`ADMIN_LEGACY_REDIRECTS`), or its own in-page redirect.
 *
 * WHY. `/admin/brain` was a finished surface — canvas, synapse view, coverage
 * panel, recommendations, and its whole `app/api/admin/brain/**` tree — with
 * ZERO inbound references anywhere outside its own directory. It was in neither
 * list and did not self-redirect, so the only way to reach it was to type the
 * URL. The operator reported it on 2026-08-30 as "I don't see the brain", which
 * is what a finished surface looks like from outside when nothing links to it
 * (#4222). `/admin/classifications` and `/admin/sensitivity-labels` were the
 * same shape and had been open as #3724 since 2026-08-18.
 *
 * A page nothing routes to is indistinguishable from an unbuilt one. That is the
 * no-vaporware F/D boundary read from the user's side, and it is invisible to
 * every other gate here: the page compiles, its tests pass, its API responds.
 *
 * WHY THE THREE-WAY TEST, AND NOT "IS IT IN THE SIDEBAR". Most absences are
 * DELIBERATE. IA-03/IA-04/IA-06 folded eleven thin pages into tabbed hubs and
 * kept the old routes as redirect stubs so bookmarks and gate-registry deep
 * links survive; `/admin/add-landing-zone` does the same thing with an in-page
 * redirect rather than a table entry. A rule keyed to sidebar membership alone
 * reports 14 violations where there are 2 — measured, while writing this — and a
 * guard that cries wolf 12 times gets muted. So each of the three ways a page can
 * legitimately be reachable is checked, and the allowlist below is for the
 * genuinely-neither case, WITH a reason.
 *
 * SELF-DEFENCE. Fails on an empty page population and on an empty destination
 * list — either means the matcher has drifted off the code, and a guard that
 * reports a pass over nothing is the failure mode this repo has measured most
 * often.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const NAV = 'apps/fiab-console/lib/nav/admin-sections.ts';

/**
 * Pages that are reachable by none of the three routes and are allowed to be,
 * each with the reason. Empty today, on purpose: every current page is
 * reachable, so an entry here is a deliberate, reviewable exception rather than
 * a place to park the next one.
 */
const ALLOWLIST = new Map([]);

function tracked(pattern) {
  try {
    return execFileSync('git', ['ls-files', '--', pattern], {
      encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    console.error(
      `::error::admin-page-reachability: could not ask git for tracked files (${(e.message || '').slice(0, 160)}). ` +
        'Refusing to fall back to a filesystem walk.',
    );
    process.exit(1);
  }
}

const pages = tracked('apps/fiab-console/app/admin/*/page.tsx');
if (pages.length === 0) {
  console.error('::error::admin-page-reachability: found ZERO admin pages. Refusing to report a pass.');
  process.exit(1);
}

if (!existsSync(join(ROOT, NAV))) {
  console.error(`::error::admin-page-reachability: ${NAV} not found — the destination list cannot be read.`);
  process.exit(1);
}
const navSrc = readFileSync(join(ROOT, NAV), 'utf8');
const linked = new Set([...navSrc.matchAll(/href:\s*'([^']+)'/g)].map((m) => m[1].split('?')[0]));
const redirected = new Set([...navSrc.matchAll(/from:\s*'([^']+)'/g)].map((m) => m[1]));

if (linked.size === 0 || redirected.size === 0) {
  console.error(
    `::error::admin-page-reachability: parsed ${linked.size} sidebar href(s) and ${redirected.size} redirect(s) from ${NAV}. ` +
      'Both are non-empty in any healthy tree, so zero means this matcher has drifted off the file. ' +
      'Refusing to report a pass on an empty population.',
  );
  process.exit(1);
}

const unreachable = [];
for (const rel of pages) {
  const route = rel.replace('apps/fiab-console/app', '').replace('/page.tsx', '');
  if (linked.has(route) || redirected.has(route) || ALLOWLIST.has(route)) continue;
  // Third way in: the page redirects to a hub itself rather than via the table.
  const body = readFileSync(join(ROOT, rel), 'utf8');
  if (/\bredirect\s*\(/.test(body) || /\bpermanentRedirect\s*\(/.test(body)) continue;
  unreachable.push({ route, file: rel });
}

if (unreachable.length > 0) {
  console.error(
    `::error::admin-page-reachability: ${unreachable.length} admin page(s) are reachable by NO route — ` +
      'not in the sidebar, not a redirect stub, and they do not redirect themselves. A page nothing links to is ' +
      'indistinguishable from an unbuilt one (#4222 — /admin/brain shipped finished and invisible). ' +
      `Add an entry to ADMIN_SECTIONS in ${NAV}, or a redirect, or allowlist it here WITH a reason.`,
  );
  for (const u of unreachable) console.error(`::error file=${u.file},line=1::${u.route} has no route in`);
  process.exit(1);
}

console.log(
  `admin-page-reachability OK — ${pages.length} admin page(s): ` +
    `${pages.length - redirected.size} via the sidebar or self-redirect, ${redirected.size} legacy redirect stub(s), ` +
    `${ALLOWLIST.size} allowlisted. 0 unreachable.`,
);
