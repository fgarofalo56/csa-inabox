#!/usr/bin/env node
/**
 * check-acr-buildable-dockerfiles.mjs
 *
 * RULE. A Dockerfile this repo ships must be parseable by ACR Tasks. Concretely:
 * no platform flag on FROM (`FROM --platform=… image AS name`).
 *
 * WHY. `az acr build` is the ONLY mechanism that can push to these registries.
 * They are provisioned `publicNetworkAccess=Disabled` (private endpoint only),
 * so a client-side `docker push` from a GitHub runner cannot reach them —
 * doubly so in Gov, where the registry has never been publicly reachable. ACR
 * Tasks run INSIDE Azure, which is the whole reason build-fiab-images-acr-tasks
 * exists.
 *
 * ACR Tasks' dependency scanner does not understand a platform flag on FROM, and
 * it fails the build BEFORE the first layer. Measured on the first-ever run of
 * deploy-loom-sharing.yml (31503836350, 2026-08-11):
 *
 *   unable to understand line FROM --platform=linux/arm64 \
 *     deltaio/delta-sharing-server:0.7.8 AS payload
 *   failed to run step ID: build: failed to scan dependencies: exit status 1
 *   Run ID: cj3sv failed after 4s.
 *
 * So `docker build` accepting a Dockerfile proves nothing about whether this
 * platform can ship it. That gap is what made deploy-loom-sharing.yml read
 * "NEVER RUN" in deploy-staleness — not neglect, but a workflow that COULD NOT
 * SUCCEED as written. The image it builds is the OSS Delta Sharing server, i.e.
 * Azure Government's only open-protocol sharing endpoint, so the lane mattering
 * and the lane being impossible had been true simultaneously for weeks.
 *
 * A local `docker build` is not the gate. This is.
 *
 * SELF-DEFENCE. Fails if it scans no Dockerfiles at all — this repo ships many,
 * so zero means the matcher drifted rather than that the repo is clean.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();

function trackedDockerfiles() {
  try {
    return execFileSync('git', ['ls-files', '--', '*Dockerfile', '*Dockerfile.*', '*/Dockerfile'], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (e) {
    console.error(
      `::error::acr-buildable-dockerfiles: could not ask git for tracked Dockerfiles (${(e.message || '').slice(0, 160)}). ` +
        'Refusing to fall back to a filesystem walk.',
    );
    process.exit(1);
  }
}

/** A platform flag on FROM — the shape ACR Tasks' scanner rejects outright. */
const FROM_PLATFORM = /^\s*FROM\s+--platform[=\s]/i;

const files = trackedDockerfiles();
if (files.length === 0) {
  console.error(
    '::error::acr-buildable-dockerfiles: git tracks ZERO Dockerfiles. This repo ships many, so this means the ' +
      'matcher has drifted off the code. Refusing to report a pass on an empty population.',
  );
  process.exit(1);
}

const violations = [];
for (const rel of files) {
  let text;
  try {
    text = readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  text.split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*#/.test(raw)) return; // prose about the rule is not the rule
    if (!FROM_PLATFORM.test(raw)) return;
    violations.push({ file: rel, line: i + 1, text: raw.trim().slice(0, 140) });
  });
}

if (violations.length > 0) {
  console.error(
    `::error::acr-buildable-dockerfiles: ${violations.length} Dockerfile line(s) put a platform flag on FROM. ` +
      "ACR Tasks' dependency scanner cannot parse that and fails the build before the first layer " +
      '(`unable to understand line FROM --platform=…`). `az acr build` is the ONLY way to push to these ' +
      'registries — they are publicNetworkAccess=Disabled — so such a Dockerfile can NEVER ship, however ' +
      'happily `docker build` accepts it. Express the platform constraint in a comment instead; for a ' +
      'payload-only stage consumed via COPY --from, the flag changes nothing that is pulled.',
  );
  for (const v of violations) console.error(`::error file=${v.file},line=${v.line}::${v.text}`);
  process.exit(1);
}

console.log(
  `acr-buildable-dockerfiles OK — ${files.length} tracked Dockerfile(s) scanned, 0 platform flags on FROM.`,
);
