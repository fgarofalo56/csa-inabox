#!/usr/bin/env node
/**
 * check-azd-service-paths.mjs
 *
 * RULE. Every `services.<name>.project` in an azd `azure.yaml` must resolve to a
 * directory that exists, relative to the azure.yaml itself.
 *
 * WHY. `azd provision` validates the whole project file before it does anything,
 * so ONE bad path stops the entire sovereign deploy — and it stops it with a
 * message about a service, which reads like an application problem rather than a
 * path typo.
 *
 * Measured 2026-08-11 on deploy-fiab-gcch run 31483332001:
 *
 *     ERROR: initializing service 'activator-engine',
 *     stat …/csa-inabox/platform/apps/fiab-activator-engine: no such file or directory
 *
 * platform/fiab/azd/azure.yaml declared `../../apps/<name>` for ALL SEVEN
 * services. From that file, `../..` is `platform/`, so every one resolved to
 * `platform/apps/<name>` — a directory that has never existed. The azd branch of
 * the Gov lanes could therefore never have provisioned anything, and nobody knew,
 * because three earlier defects (#3217 empty azd env var, #3221 missing azd auth,
 * and before those a disabled lane) each stopped the run before it got this far.
 *
 * This is the fourth defect uncovered in the same code path by fixing the one in
 * front of it. A path that is checked statically cannot hide behind the next one.
 *
 * SELF-DEFENCE. Fails if no azure.yaml is found, or if one declares no services —
 * a rule that checks nothing must not report a pass.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, relative, join, sep } from 'node:path';

const ROOT = process.cwd();

/**
 * The population is what GIT TRACKS, not what is on disk.
 *
 * The first version walked the tree and found 1939 "problems" — every one inside
 * .claude/worktrees/, the local scratch checkouts this repo's agent fan-out
 * leaves behind. Those are not repo content, they are copies, and judging them
 * turned a 7-line finding into a 1939-line wall that buried it. A guard that
 * cries wolf about files the repo does not own is a guard that gets skimmed.
 */
function trackedAzureYamls() {
  let out;
  try {
    out = execFileSync('git', ['ls-files', '--', '*azure.yaml', '*azure.yml'], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    console.error(
      `::error::azd-service-paths: could not ask git for the tracked azure.yaml files (${(e.message || '').slice(0, 160)}). ` +
        'Refusing to fall back to a filesystem walk, which would judge untracked scratch checkouts.',
    );
    process.exit(1);
  }
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => join(ROOT, l));
}

/**
 * Minimal reader for `services:` -> `<name>:` -> `project:`.
 *
 * Deliberately not a YAML dependency: this guard runs in the guardrails lane with
 * nothing installed, and the shape it reads is two levels of plain mapping.
 */
function servicesOf(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inServices = false;
  let current = null;
  for (const raw of lines) {
    if (/^\s*#/.test(raw)) continue;
    if (/^services:\s*$/.test(raw)) { inServices = true; continue; }
    if (inServices && /^\S/.test(raw)) { inServices = false; current = null; continue; }
    if (!inServices) continue;
    const svc = /^\s{2}([A-Za-z0-9._-]+):\s*$/.exec(raw);
    if (svc) { current = svc[1]; continue; }
    const proj = /^\s{4}project:\s*['"]?([^'"\s#]+)['"]?\s*$/.exec(raw);
    if (proj && current) out.push({ name: current, project: proj[1] });
  }
  return out;
}

const files = trackedAzureYamls();
if (files.length === 0) {
  console.error('::error::azd-service-paths: git tracks NO azure.yaml. Refusing to report a pass on an empty population.');
  process.exit(1);
}

const problems = [];
let checked = 0;

for (const file of files) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  const rel = relative(ROOT, file).split(sep).join('/');
  const services = servicesOf(text);
  if (services.length === 0) {
    console.error(
      `::error::azd-service-paths: ${rel} declares NO services this rule can read. Either the file uses a shape ` +
        'the reader does not understand, in which case the rule is silently checking nothing, or the project has no ' +
        'services. Refusing to guess which.',
    );
    process.exit(1);
  }
  for (const s of services) {
    checked++;
    const abs = resolve(dirname(file), s.project);
    const exists = existsSync(abs) && statSync(abs).isDirectory();
    if (!exists) {
      problems.push({ file: rel, name: s.name, project: s.project, resolved: relative(ROOT, abs).split(sep).join('/') });
    }
  }
}

if (problems.length > 0) {
  console.error(
    `::error::azd-service-paths: ${problems.length} azd service path(s) do not resolve to a directory. ` +
      '`azd provision` validates the whole project file before it does anything, so ONE bad path stops the entire ' +
      'deploy — with a message about a SERVICE, which reads like an application problem rather than a path typo.',
  );
  for (const p of problems) {
    console.error(`::error file=${p.file}::service '${p.name}' project: ${p.project}  ->  ${p.resolved}  (no such directory)`);
  }
  process.exit(1);
}

console.log(`azd-service-paths OK — ${checked} service path(s) across ${files.length} azure.yaml file(s), all resolve.`);
