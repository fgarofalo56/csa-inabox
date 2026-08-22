#!/usr/bin/env node
/**
 * deploy-arm-errors.mjs — drill an ARM deployment failure down to its LEAF
 * errors, so the taxonomy is handed the real cause instead of linter noise.
 *
 * WHY THIS EXISTS (issue #3039, deploy-integrity.md R6/R7)
 *
 *   deploy-fiab-commercial run 31069329802 failed and the classifier reported,
 *   correctly and uselessly:
 *
 *     "Could not classify this failure … No cause is asserted: nothing in the
 *      output matched a known Azure failure signal."
 *
 *   That verdict was RIGHT. The input was wrong. `az deployment sub create`
 *   emits the bicep linter's warnings on stderr — 200+ lines of BCP318 and
 *   no-unused-params — and the ARM failure itself is content-free:
 *
 *     DeploymentFailed: At least one resource deployment operation failed.
 *     Please list deployment operations for details.
 *
 *   The two real causes were TWO LEVELS DOWN, reachable only by doing what that
 *   message says. Measured on that run:
 *
 *     sub deployment csa-loom-ci-31069329802
 *       └─ group deployment admin-plane            DeploymentFailed (content-free)
 *            ├─ group deployment network           DeploymentFailed (content-free)
 *            │    └─ privatelink.azuredatabricks.net/link-hub
 *            │         BadRequest: A virtual network cannot be linked to multiple
 *            │         zones with overlapping namespaces. …
 *            └─ group deployment swa-publish-rbac  DeploymentFailed (content-free)
 *                 └─ roleAssignments/<guid>
 *                      RoleAssignmentExists: The role assignment already exists.
 *
 *   Adding taxonomy signals without this would have been decoration: no signal
 *   can match a string that is not in the input.
 *
 * FAILING CLOSED — the whole point (R7)
 *
 *   This has THREE outcomes, never two:
 *     found      ARM answered and at least one leaf error was read.
 *     none       ARM answered, operations were listed, and none had failed.
 *     unreadable ARM did not answer, or answered in a shape this could not
 *                parse. NOTHING is asserted about the cause.
 *
 *   `unreadable` must never be rendered as `none`, and neither may ever be
 *   rendered as "the deployment succeeded". The caller keeps whatever it had:
 *   an empty drill-down leaves the original stderr unchanged, so an unclassified
 *   failure stays unclassified and stays RED. This addition can only ever ADD
 *   evidence; it can never turn a failure into a pass.
 *
 *   There is no `2>/dev/null`, no `|| true` and no swallowed exit status here.
 *   az's stderr is captured and reported as the reason for `unreadable`.
 *
 * USAGE
 *   node scripts/ci/deploy-arm-errors.mjs --name csa-loom-ci-123 --scope sub
 *   node scripts/ci/deploy-arm-errors.mjs --name admin-plane --scope group \
 *        --resource-group rg-… [--subscription <id-or-name>] [--json]
 *
 *   Exit: 0 found | 4 none | 3 unreadable | 2 usage.
 *
 * Tests: node --test scripts/ci/__tests__/deploy-arm-errors.test.mjs
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { redact, redactedLine, unredactedByDesign } from './_azure-redact.mjs';

export const STATUS = Object.freeze({
  FOUND: 'found',
  NONE: 'none',
  UNREADABLE: 'unreadable',
});

export const EXIT = Object.freeze({
  FOUND: 0,
  USAGE: 2,
  UNREADABLE: 3,
  NONE: 4,
});

/** How deep the nested-deployment walk may go before it stops and says so. */
export const DEFAULT_MAX_DEPTH = 6;

const NESTED_TYPE = 'microsoft.resources/deployments';

/**
 * Every LEAF of an ARM error tree — the nodes with no `details[]` children.
 *
 * ARM nests the real cause under repeated
 * `DeploymentFailed → ResourceDeploymentFailure → …` wrappers whose messages
 * are boilerplate. Taking `error.code` at the top is how "At least one resource
 * deployment operation failed" became the whole diagnosis.
 */
export function errorLeaves(err, acc = []) {
  if (!err || typeof err !== 'object') return acc;
  const kids = Array.isArray(err.details) ? err.details.filter(Boolean) : [];
  if (kids.length === 0) {
    if (err.code || err.message) {
      acc.push({
        code: typeof err.code === 'string' ? err.code : null,
        message: typeof err.message === 'string' ? err.message : '',
        target: typeof err.target === 'string' ? err.target : null,
      });
    }
    return acc;
  }
  for (const k of kids) errorLeaves(k, acc);
  return acc;
}

/** The resource-group segment of an ARM resource id, or null. */
export function resourceGroupOf(armId) {
  const m = /\/resourceGroups\/([^/]+)/i.exec(String(armId ?? ''));
  return m ? m[1] : null;
}

const opState = (op) => op?.properties?.provisioningState ?? null;
const opTarget = (op) => op?.properties?.targetResource ?? {};

/** Operations ARM reported as Failed. */
export function failedOperations(ops) {
  return (Array.isArray(ops) ? ops : []).filter((o) => String(opState(o)).toLowerCase() === 'failed');
}

/**
 * Failed child deployments worth recursing into, as `{resourceGroup, name}`.
 * An entry with no resolvable resource group is dropped from the walk and
 * reported as a warning by the collector — never silently.
 */
export function nestedDeploymentTargets(ops) {
  const out = [];
  for (const op of failedOperations(ops)) {
    const t = opTarget(op);
    if (String(t.resourceType ?? '').toLowerCase() !== NESTED_TYPE) continue;
    const name = t.resourceName ?? null;
    if (!name) continue;
    out.push({ resourceGroup: resourceGroupOf(t.id), name, id: t.id ?? null });
  }
  return out;
}

/** A resource-scoped description of one failed operation, for the report line. */
function describeOperation(op) {
  const t = opTarget(op);
  return {
    resourceType: t.resourceType ?? null,
    resourceName: t.resourceName ?? null,
    statusCode: op?.properties?.statusCode ?? null,
  };
}

/** The `az` argv for one enumeration. Exported so the test can assert it. */
export function azArgs({ scope, name, resourceGroup, subscription }) {
  const base =
    scope === 'group'
      ? ['deployment', 'operation', 'group', 'list', '-g', resourceGroup, '--name', name]
      : ['deployment', 'operation', 'sub', 'list', '--name', name];
  if (subscription) base.push('--subscription', subscription);
  return [...base, '-o', 'json'];
}

/**
 * Default runner. Real `az`, stderr CAPTURED (not discarded) so an `unreadable`
 * outcome can say WHY — a permission denial and a genuine absence must never
 * collapse to the same empty string (R7).
 */
export function azRunner(args) {
  // Linux/macOS (and every CI runner here) get a real executable and no shell.
  // Windows ships `az.cmd`, which Node 20+ refuses to spawn without one
  // (EINVAL) — reported by this function as status 127 with the real reason,
  // never as "ARM answered and there was nothing there".
  const bin = process.env.LOOM_AZ_BIN ?? (process.platform === 'win32' ? 'az.cmd' : 'az');
  const res = spawnSync(bin, args, {
    encoding: 'utf8',
    shell: /\.(cmd|bat)$/i.test(bin),
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    return { status: 127, stdout: '', stderr: `${res.error.message}` };
  }
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * Walk a failed deployment to its leaf errors.
 *
 * @param {object} o
 * @param {string} o.name             deployment name
 * @param {'sub'|'group'} o.scope
 * @param {string} [o.resourceGroup]  required when scope === 'group'
 * @param {string} [o.subscription]
 * @param {number} [o.maxDepth]
 * @param {(args:string[])=>{status:number,stdout:string,stderr:string}} [o.run]
 * @returns {{status:string, leaves:Array, warnings:string[], visited:string[], operationsSeen:number, reason:string|null}}
 */
export function collectArmLeafErrors({
  name,
  scope = 'sub',
  resourceGroup = null,
  subscription = null,
  maxDepth = DEFAULT_MAX_DEPTH,
  run = azRunner,
}) {
  const leaves = [];
  const warnings = [];
  const visited = [];
  const seen = new Map();
  let operationsSeen = 0;
  let rootReadable = false;
  let rootReason = null;

  const push = (leaf, opDesc) => {
    const key = `${leaf.code}|${leaf.message}|${leaf.target ?? ''}`;
    const existing = seen.get(key);
    if (existing) {
      // The SAME leaf is visible from several levels: once inside the nested
      // details[] of the parent deployment's operation, and again on the
      // operation of the resource that actually failed. Keep the specific
      // attribution. Without this the first sighting wins and every leaf is
      // reported as "[Microsoft.Resources/deployments 'admin-plane']", which
      // names the wrapper rather than the resource — true of the walk, useless
      // to the operator.
      const wasWrapper = String(existing.resourceType ?? '').toLowerCase() === NESTED_TYPE;
      const isWrapper = String(opDesc.resourceType ?? '').toLowerCase() === NESTED_TYPE;
      if (wasWrapper && !isWrapper) Object.assign(existing, opDesc);
      return;
    }
    const entry = { ...leaf, ...opDesc };
    seen.set(key, entry);
    leaves.push(entry);
  };

  const walk = (node, depth, isRoot) => {
    const key = `${node.scope}:${node.resourceGroup ?? '-'}:${node.name}`;
    if (visited.includes(key)) return;
    visited.push(key);
    if (depth > maxDepth) {
      warnings.push(
        `stopped at depth ${maxDepth} before expanding ${node.name}; deeper leaves were NOT read.`,
      );
      return;
    }

    const res = run(azArgs({ ...node, subscription }));
    if (res.status !== 0) {
      const why = redact((res.stderr || res.stdout || '').trim()).split(/\r?\n/).slice(0, 4).join(' ');
      const line = `could not list operations for ${node.scope} deployment "${node.name}"${
        node.resourceGroup ? ` in ${node.resourceGroup}` : ''
      } (az exit ${res.status}): ${why || 'az produced no output'}`;
      warnings.push(line);
      if (isRoot) rootReason = line;
      return;
    }

    let ops;
    try {
      ops = JSON.parse(res.stdout || 'null');
    } catch (e) {
      const line = `az returned output that is not JSON for "${node.name}": ${e.message}`;
      warnings.push(line);
      if (isRoot) rootReason = line;
      return;
    }
    if (!Array.isArray(ops)) {
      const line = `az returned a non-array operation list for "${node.name}" (got ${typeof ops}).`;
      warnings.push(line);
      if (isRoot) rootReason = line;
      return;
    }

    if (isRoot) rootReadable = true;
    operationsSeen += ops.length;

    for (const op of failedOperations(ops)) {
      const desc = describeOperation(op);
      // A nested deployment's OWN error is boilerplate; its children carry the
      // cause. Keep its leaves anyway — when the recursion is blocked (RBAC on
      // the child RG, say) the nested `details[]` chain is the only evidence
      // left, and on run 31069329802 it in fact already carried both causes.
      for (const leaf of errorLeaves(op?.properties?.statusMessage?.error)) push(leaf, desc);
    }

    for (const child of nestedDeploymentTargets(ops)) {
      if (!child.resourceGroup) {
        warnings.push(
          `nested deployment "${child.name}" has no resolvable resource group in its target id; not expanded.`,
        );
        continue;
      }
      walk({ scope: 'group', name: child.name, resourceGroup: child.resourceGroup }, depth + 1, false);
    }
  };

  walk({ scope, name, resourceGroup }, 0, true);

  // THE THREE-STATE RULE. `none` may only be claimed when the ROOT enumeration
  // actually succeeded. Anything else is `unreadable`, because a failure to read
  // establishes nothing about what is there.
  let status;
  if (leaves.length > 0) status = STATUS.FOUND;
  else if (rootReadable) status = STATUS.NONE;
  else status = STATUS.UNREADABLE;

  return {
    status,
    leaves,
    warnings,
    visited,
    operationsSeen,
    reason:
      status === STATUS.UNREADABLE
        ? rootReason ?? 'the root deployment operation list could not be read; no cause is asserted.'
        : null,
  };
}

/**
 * The block appended to the text handed to the classifier, and printed for the
 * operator. Every leaf is listed — a deployment can fail for more than one
 * reason at once, and on run 31069329802 it did.
 *
 * THIS FUNCTION IS A REDACTION BOUNDARY (#3829 round 2). deploy-retry.mjs writes
 * this string straight to process.stderr, and on a PUBLIC repo the Actions run
 * log is a publication surface exactly as an issue body is. The first cut
 * redacted `l.message` and nothing else, which left FOUR interpolations raw:
 * `l.resourceName` (`<server>/<objectId>` for the flexibleServers/administrators
 * leaf that opened #3829, the role-assignment GUID for a roleAssignments leaf),
 * the `warnings[]` lines, and `result.reason` — the last two of which embed a
 * deployment NAME, and this repo generates deployment names with `newGuid()`
 * seeds.
 *
 * So the redaction is applied ONCE, to the assembled render, at the single
 * return. A branch added later cannot reopen the hole, and a field added to a
 * branch cannot either. redact() is idempotent, so the per-field call on
 * `l.message` stays as defence in depth.
 *
 * SAFE FOR THE CLASSIFIER. This string is also `classifyText`. redact() rewrites
 * only GUID and `/subscriptions/<id>` substrings, which no taxonomy signal
 * matches on, and it deliberately does NOT touch an undashed 32-hex run — which
 * is the form ARM uses for the blocking role-assignment id that
 * deploy-retry.mjs's planRemediation() reads back to converge the grant (#3439).
 * Both properties are pinned by tests.
 */
export function renderLeaves(result) {
  let out;
  if (result.status === STATUS.FOUND) {
    const head = `ARM leaf failures (${result.leaves.length}) drilled from the failed deployment operations:`;
    const body = result.leaves.map((l) => {
      const where = l.resourceType
        ? ` [${l.resourceType}${l.resourceName ? ` '${l.resourceName}'` : ''}]`
        : '';
      return `  ${l.code ?? 'NoCode'}: ${redact(l.message)}${where}`;
    });
    const warn = result.warnings.map((w) => `  (partial) ${w}`);
    out = [head, ...body, ...warn].join('\n');
  } else if (result.status === STATUS.NONE) {
    out =
      `ARM leaf failures: none. ${result.operationsSeen} deployment operation(s) were listed and ` +
      'ARM reported none of them Failed. The cause is therefore NOT in the deployment operations.';
  } else {
    out =
      'ARM leaf failures: UNREADABLE — the deployment operations could not be listed, so nothing ' +
      `is asserted about the cause. ${result.reason}`;
  }
  // THE BOUNDARY. Do not move this back to the individual interpolations.
  return redact(out);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/**
 * THE STDOUT AND STDERR BOUNDARIES (#3829 round 5).
 *
 * renderLeaves() above is a redaction boundary for the string it BUILDS. It is
 * not a boundary for this file's process — the CLI also writes four usage
 * refusals to stderr, two of which interpolate operator-supplied argv
 * (`unknown argument: ${a}` and `--scope must be sub|group (got ${args.scope})`),
 * and every one of them lands in a public Actions run log if a workflow ever
 * calls this script. Rounds 1-4 of #3829 each bounded one surface and left its
 * neighbour bare; these two exist so that this file has no bare neighbour left.
 *
 * Exported and PURE so a pass-through mutation is visible in a DIRECT test:
 * renderLeaves() redacts as well, so an end-to-end assertion on the default
 * stdout path cannot say which of the two did the work
 * (csa_loom_mutation_that_does_not_move_the_verdict).
 */
export function formatStdout(text) {
  return redactedLine(text);
}

export function formatStderr(text) {
  return redactedLine(text);
}

export function parseArgs(argv) {
  const out = {
    name: null,
    scope: 'sub',
    resourceGroup: null,
    subscription: null,
    maxDepth: DEFAULT_MAX_DEPTH,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--name') out.name = argv[++i];
    else if (a === '--scope') out.scope = argv[++i];
    else if (a === '--resource-group' || a === '-g') out.resourceGroup = argv[++i];
    else if (a === '--subscription') out.subscription = argv[++i];
    else if (a === '--max-depth') out.maxDepth = Number(argv[++i]);
    else if (a === '--json') out.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(formatStderr(`deploy-arm-errors: ${e.message}\n`));
    process.exit(EXIT.USAGE);
  }
  if (!args.name) {
    process.stderr.write(formatStderr('deploy-arm-errors: --name <deploymentName> is required.\n'));
    process.exit(EXIT.USAGE);
  }
  if (args.scope !== 'sub' && args.scope !== 'group') {
    process.stderr.write(formatStderr(`deploy-arm-errors: --scope must be sub|group (got ${args.scope}).\n`));
    process.exit(EXIT.USAGE);
  }
  if (args.scope === 'group' && !args.resourceGroup) {
    process.stderr.write(formatStderr('deploy-arm-errors: --scope group requires --resource-group.\n'));
    process.exit(EXIT.USAGE);
  }

  const result = collectArmLeafErrors(args);
  if (args.json) {
    // DISCLOSED EXCEPTION, and the ONLY unredacted publication in this file.
    // `--json` emits the raw `result`, which carries the full ARM ids — the
    // subscription id, the resource id, and the object id in a
    // `flexibleServers/administrators` leaf name. That is deliberate: it exists
    // so an operator debugging their OWN subscription keeps the ids that the
    // remediations in docs/fiab/runbooks/deploy-failure.md actually need, and
    // the runbook says in as many words to treat its output as local-only.
    //
    // It is safe ONLY while no CI surface invokes it, because a workflow's
    // stdout is public on this public repo — so that is not left as a sentence
    // in a header. `RATCHET — no workflow invokes deploy-arm-errors.mjs with
    // --json` in the suite fails the day one does, and named rather than
    // commented so the structural test counts this exception as ONE.
    process.stdout.write(unredactedByDesign(`${JSON.stringify(result, null, 2)}\n`));
  } else {
    process.stdout.write(formatStdout(`${renderLeaves(result)}\n`));
  }
  process.exit(
    result.status === STATUS.FOUND
      ? EXIT.FOUND
      : result.status === STATUS.NONE
        ? EXIT.NONE
        : EXIT.UNREADABLE,
  );
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
