#!/usr/bin/env node
/**
 * GUARDRAIL: every `apps/<name>/Dockerfile` must have a CI IMAGE PRODUCER.
 *
 * WHY THIS EXISTS (#2619). `apps/loom-sharing` shipped a Dockerfile, a bicep
 * module that deploys it, a threat model, a runbook, and a CI job that unit-tests
 * its entrypoint — and NOTHING built the image. `git grep loom-sharing
 * .github/workflows` returned exactly one hit, the `node --test` job. The only
 * documented way to produce the artifact was a hand-typed `az acr build` in
 * docs/fiab/delta-sharing-gov.md, i.e. a workstation with `az` write access.
 *
 * This is the image-layer sibling of check-deploy-script-reachability.mjs
 * (#2816) and of the "merged != deployed" watchdog (#2775): a deploy path that
 * only a laptop can run is undeployable in practice and untested in fact. Here
 * it is worse than undeployable — a Container App pointing at an image nobody
 * built fails its ARM PUT with MANIFEST_UNKNOWN, which this repo has been bitten
 * by twice.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 * For each `apps/<name>/Dockerfile`, at least one workflow must
 *   a) contain a real image-BUILD invocation (`az acr build`, `docker build`, or
 *      `docker/build-push-action`), and
 *   b) name that app's build context `apps/<name>` on a line that is not a YAML
 *      comment, not an `echo`, and not a `::warning::`/`::notice::` annotation.
 *
 * (b) is the load-bearing half, and it is deliberately narrow for the same
 * reason check-deploy-script-reachability.mjs is: a MENTION IS NOT A BUILD.
 * `gov-provision-dbx-sql-invnet.yml` names `apps/loom-dbx-init` twice — once in
 * a prose comment on line 9, once as the `az acr build` context on line 75. A
 * naive `grep -c` scores both. Only the second produces an artifact.
 *
 * ── WHAT THIS DELIBERATELY DOES *NOT* COUNT ────────────────────────────────
 * `build-fiab-images-acr-tasks.yml` has a GENERIC resolver: dispatch it with
 * `apps: <x>` and, if `./apps/<x>/Dockerfile` exists, it builds it. So in a
 * narrow sense every app here is "buildable". That is not a producer:
 *   - the app is in no default matrix, so no push and no from-scratch deploy
 *     ever builds it;
 *   - nothing in the tree records that the incantation works, so the knowledge
 *     lives in whoever read the resolver;
 *   - and a capability nobody has ever exercised is not a tested path.
 * Counting it would make this guard green while the artifact still never exists
 * — the precise "control that measures nothing" shape it is here to prevent.
 *
 * Usage: node scripts/ci/check-image-producer-coverage.mjs [--root <dir>]
 *
 * `--root` exists ONLY so scripts/ci/__tests__/image-producer-coverage.test.mjs
 * can point the real checker at fixture trees and prove it goes red for the
 * right reasons. CI never passes it. It cannot be used to hollow the check out:
 * the two self-checks below fail on an empty apps set and on a workflow set with
 * no build invocation, which is what a bogus root produces.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const rootFlag = process.argv.indexOf('--root');
const ROOT = rootFlag >= 0 ? process.argv[rootFlag + 1] : process.cwd();
const APPS_DIR = 'apps';
const WORKFLOW_DIR = '.github/workflows';

/** A workflow that runs one of these actually produces an image. */
const BUILD_INVOCATION = /(az\s+acr\s+build|docker\s+build|docker\/build-push-action)/;

/** Workflow-command markers. A line carrying one of these is OUTPUT, not a build. */
const ANNOTATION = /::(?:warning|notice|error|debug)::/;

/**
 * KNOWN-UNBUILT — apps with a Dockerfile and no CI producer, each with the
 * reason it is tolerated. An entry is a LOAN, not a fix: it is here so the gap
 * is NAMED and counted instead of invisible, which is how loom-sharing sat
 * unbuilt through a full feature PR, a review, and a runbook.
 *
 * Every one of these is currently SAFE ONLY because its bicep module is a
 * standalone entrypoint that `admin-plane/main.bicep` does not invoke — verified
 * by grepping main.bicep for each module name, which returns nothing. The day
 * one of them is wired into the orchestrator, a from-scratch deploy will fail
 * its Container App PUT with MANIFEST_UNKNOWN. Wire the producer FIRST.
 */
const KNOWN_UNBUILT = new Map([
  ['fiab-prpt-renderer', 'integration/prpt-renderer.bicep is a standalone entrypoint not invoked by admin-plane/main.bicep, so no deploy references the image yet. Needs a producer before it is wired.'],
  ['loom-capacity-broker', 'compute/loom-capacity-broker-app.bicep is a standalone entrypoint not invoked by admin-plane/main.bicep. Needs a producer before it is wired.'],
  // loom-directlake was here. REMOVED (#3291): the HYP-5 Direct Lake columnar
  // scan/frame service now has real producers — full-app-deploy-commercial.yml
  // (Commercial), build-fiab-images-acr-tasks.yml (both matrices), and
  // gov-provision-dataplane-images.yml (GCC-High / IL5) — because
  // admin-plane/main.bicep now INVOKES compute/loom-directlake-app.bicep
  // (directLakeSvcActive, default-ON) and binds LOOM_DIRECTLAKE_URL from its
  // fqdn output. This entry was the loan; the producers are the repayment, and
  // they landed in the SAME change as the wiring precisely because this file's
  // header says a wired-but-unbuilt image fails the Container App PUT with
  // MANIFEST_UNKNOWN.
  ['loom-onelake', 'compute/loom-onelake-app.bicep is a standalone entrypoint not invoked by admin-plane/main.bicep — its own header still carries the "TODO wire into main.bicep" block. Needs a producer before it is wired.'],
  ['loom-mcp', 'Dev-tool stdio MCP server (loom-devtools). Distributed via npm + the loom-skills marketplace and run locally / self-hosted (`claude mcp add` or the optional Dockerfile). By design it is NOT a platform-deployed Container App — no bicep references its image, so there is no admin-plane deploy to hit MANIFEST_UNKNOWN. The Dockerfile is a self-host convenience, not an estate image; this entry is permanent, not a pending-wiring gap.'],
]);

/** Does `line` reference `context` in a position that can reach a build? */
function isBuildReference(line, context) {
  if (/^\s*#/.test(line)) return false;        // YAML comment
  if (!line.includes(context)) return false;
  if (ANNOTATION.test(line)) return false;     // ::warning:: etc.
  if (/\becho\b/.test(line)) return false;     // echoed, not built
  return true;
}

const appsRoot = join(ROOT, APPS_DIR);
const apps = existsSync(appsRoot)
  ? readdirSync(appsRoot)
    .filter((d) => {
      try {
        return statSync(join(appsRoot, d)).isDirectory() && existsSync(join(appsRoot, d, 'Dockerfile'));
      } catch {
        return false;
      }
    })
    .sort()
  : [];

// Self-check, same shape as check-deploy-script-reachability.mjs: a guard that
// silently finds nothing to check IS the failure mode it exists to prevent.
if (apps.length === 0) {
  console.error('[image-producer-coverage] FAIL — no apps/<name>/Dockerfile found.');
  console.error('  Either the tree moved or this check is pointed at the wrong directory.');
  process.exit(1);
}

const workflows = existsSync(join(ROOT, WORKFLOW_DIR))
  ? readdirSync(join(ROOT, WORKFLOW_DIR)).filter((f) => /\.ya?ml$/.test(f)).sort()
  : [];

const builders = [];
for (const wf of workflows) {
  const text = readFileSync(join(ROOT, WORKFLOW_DIR, wf), 'utf8');
  // PHYSICAL-LINES-OK: every predicate is single-token PRESENCE evaluated with
  // `.some()` over the whole file (a build invocation anywhere; the app's context
  // path anywhere). A continuation cannot hide a token from an any-line search,
  // and folding would let an `echo` elsewhere in a wrapped command suppress a real
  // build reference (#3420).
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines.some((l) => !/^\s*#/.test(l) && BUILD_INVOCATION.test(l))) builders.push({ wf, lines });
}

if (builders.length === 0) {
  console.error('[image-producer-coverage] FAIL — no workflow contains an image-build invocation at all.');
  console.error(`  Looked for ${BUILD_INVOCATION} across ${workflows.length} workflow(s). That cannot be right;`);
  console.error('  the matcher has drifted from how this repo builds images.');
  process.exit(1);
}

const rows = [];
const failures = [];

for (const app of apps) {
  const context = `${APPS_DIR}/${app}`;
  const producers = builders
    .filter(({ lines }) => lines.some((l) => isBuildReference(l, context)))
    .map(({ wf }) => wf);
  // Named only in prose/echo by a building workflow — reported distinctly,
  // because "the reference is real, the build is not" is the exact trap.
  const mentions = builders
    .filter(({ wf, lines }) => !producers.includes(wf) && lines.some((l) => l.includes(context)))
    .map(({ wf }) => wf);

  const allowed = KNOWN_UNBUILT.has(app);

  if (producers.length > 0) {
    if (allowed) {
      failures.push({
        app,
        kind: 'stale-allowlist',
        detail: `is in KNOWN_UNBUILT but IS now built by ${producers.join(', ')} — remove the entry. An allowlist that outlives its gap stops being a record and starts being noise.`,
      });
      rows.push({ app, status: 'STALE-ALLOW', via: producers.join(', ') });
      continue;
    }
    rows.push({ app, status: 'ok', via: producers.join(', ') });
    continue;
  }

  if (allowed) {
    rows.push({ app, status: 'known-unbuilt', via: mentions.length ? `mentioned only in ${mentions.join(', ')}` : '-' });
    continue;
  }

  failures.push({
    app,
    kind: 'unbuilt',
    detail: mentions.length
      ? `named in ${mentions.join(', ')} but only as text (comment / echo / ::warning::) — a mention is not a build`
      : 'no workflow builds it',
  });
  rows.push({ app, status: 'UNBUILT', via: mentions.join(', ') || '-' });
}

for (const app of KNOWN_UNBUILT.keys()) {
  // The allowlist describes THIS repo. Under --root the checker is aimed at a
  // fixture tree that legitimately contains none of these apps, so "the entry
  // names an app that is not here" is only a finding for the real tree.
  if (rootFlag < 0 && !apps.includes(app)) {
    failures.push({
      app,
      kind: 'phantom-allowlist',
      detail: `is in KNOWN_UNBUILT but apps/${app}/Dockerfile does not exist — remove the entry.`,
    });
  }
  if (!String(KNOWN_UNBUILT.get(app) || '').trim()) {
    failures.push({ app, kind: 'unreasoned-allowlist', detail: 'has an empty reason. An allowlist entry without a reason is a mute, not a record.' });
  }
}

console.log(`[image-producer-coverage] ${apps.length} app image(s), ${builders.length} building workflow(s):`);
for (const r of rows) {
  console.log(`  ${r.status === 'ok' ? 'ok           ' : r.status.padEnd(13)} ${r.app.padEnd(24)} ${r.via}`);
}
if (KNOWN_UNBUILT.size) {
  console.log(`\n  ${KNOWN_UNBUILT.size} app(s) are KNOWN-UNBUILT and tolerated only because no orchestrated deploy`);
  console.log('  references their image yet. Each needs a producer BEFORE it is wired into');
  console.log('  admin-plane/main.bicep, or the deploy fails its Container App PUT.');
}

if (failures.length === 0) {
  console.log('\n[image-producer-coverage] OK — every app image is either produced by a workflow or a recorded, reasoned gap.');
  process.exit(0);
}

console.error(`\n[image-producer-coverage] FAIL — ${failures.length} problem(s).\n`);
for (const f of failures) {
  console.error(`  apps/${f.app}`);
  console.error(`    ${f.detail}`);
}
console.error('\n  An image no workflow builds does not exist. The bicep module that deploys it');
console.error('  fails its Container App PUT with MANIFEST_UNKNOWN, and every fix merged into');
console.error('  that app is inert by construction.');
console.error('  Fix: add a workflow that BUILDS it (.github/workflows/deploy-loom-sharing.yml');
console.error('  is the template for a standalone out-of-band app), or — if it genuinely cannot');
console.error('  be built yet — add it to KNOWN_UNBUILT above WITH the reason.\n');
process.exit(1);
