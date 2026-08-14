#!/usr/bin/env node
/**
 * converge-role-assignment.mjs — the platform performs the RoleAssignmentExists
 * remediation instead of printing it. (issue #3439, refs #3039)
 *
 * ── WHAT BROKE, MEASURED ───────────────────────────────────────────────────
 *
 *   deploy-fiab-commercial run 31780698652 (scheduled, head 5aa9a00b,
 *   2026-08-14). Step "Provision (idempotent)", exit 15:
 *
 *     RoleAssignmentExists: The role assignment already exists. The ID of the
 *     existing role assignment is 0a2b7dc58eb449709418694f83a6c164.
 *     [Microsoft.Authorization/roleAssignments '54ecee13-3330-50e1-9ba9-314abdca3540']
 *
 *   The what-if in the same run names the leaf exactly:
 *
 *     + Microsoft.ContainerRegistry/registries/acrloom…/providers/
 *       Microsoft.Authorization/roleAssignments/54ecee13-3330-50e1-9ba9-314abdca3540
 *         properties.principalId:      [reference('…/uami-loom-directlake-<region>').principalId]
 *         properties.roleDefinitionId: …/roleDefinitions/7f951dda-4ed3-4680-a7ca-43fe172d538d
 *
 *   i.e. AcrPull for the Direct Lake UAMI on the admin-plane ACR, declared at
 *   admin-plane/main.bicep:7218 as
 *   `guid(acrForScriptRunner.id, directLakeUami.id, '7f951dda-…')`.
 *
 *   ARM enforces uniqueness on the (scope, principalId, roleDefinitionId)
 *   TRIPLE, not on the assignment NAME. The estate already held that triple
 *   under a different name, so the template's create can never succeed. It is
 *   DETERMINISTIC: every scheduled run fails identically until the names
 *   converge.
 *
 * ── WHERE THE STRAY CAME FROM (established, not assumed) ───────────────────
 *
 *   Every one of the 15 template-computed role-assignment names in that run's
 *   what-if output is a UUID **v5** (version nibble 5) — ARM's `guid()` is a
 *   name-based hash. Both recorded strays are UUID **v4**:
 *
 *     0a2b7dc5-8eb4-4970-9418-694f83a6c164   (this run)
 *     2f9290b0-1a82-44fe-a959-b441c49c84cb   (#3039, 2026-08-06)
 *
 *   `az role assignment create` with no `--name` mints a random v4. The repo
 *   has 40 such call sites and NOT ONE passes `--name`. The specific generator
 *   for this triple is full-app-deploy-commercial.yml's "Grant AcrPush to
 *   deploy SP + AcrPull to all app UAMIs (idempotent)" step, which loops
 *   `az identity list … [?starts_with(name,'uami-loom-')]` and calls
 *   `az role assignment create … --role 7f951dda-… --scope $ACR_ID` for EVERY
 *   match — a wildcard that necessarily intersects the six AcrPull grants the
 *   template declares on the same registry. Whichever writer lands first wins
 *   the triple; the other is blocked forever. The step is labelled
 *   "(idempotent)" and is — with respect to ITSELF, not to the template.
 *
 * ── WHAT THIS DOES ─────────────────────────────────────────────────────────
 *
 *   Given the assignment name ARM printed, it resolves that assignment, proves
 *   it is a Loom-owned managed-identity grant, deletes it, and verifies the
 *   delete landed. The next deploy attempt recreates the SAME triple under the
 *   template's deterministic name, so the effective permission set is unchanged
 *   and the estate converges on the template as the single owner.
 *
 *   deploy-retry.mjs --remediate invokes it automatically and then retries the
 *   deploy ONCE (auto-bind-by-default.md §5: a remediation the platform could
 *   have executed is a defect, not a helpful message). All six cloud lanes —
 *   commercial, gcc, gcch, il5, gov — already pass --remediate, so this reaches
 *   every boundary (cloud-parity.md), not just the one that broke.
 *
 * ── WHAT IT REFUSES TO DO (fail closed — deploy-integrity.md R6/R7) ────────
 *
 *   Deleting a role assignment removes access. Every one of these is a REFUSAL,
 *   never a warning-and-continue:
 *
 *     - the name ARM printed resolves to no assignment in scope of this read
 *       (it says the read found nothing, NOT that the assignment is absent);
 *     - it resolves to more than one;
 *     - principalType is anything other than ServicePrincipal, or is absent —
 *       a user or group grant is never touched, and an unknown type is not
 *       assumed to be safe;
 *     - the principal is not a user-assigned managed identity in this
 *       subscription (so a foreign SP's grant is never deleted);
 *     - the delete reported success but the assignment is still readable.
 *
 *   Without --apply it only reports. deploy-retry passes --apply; a human
 *   running it by hand gets a dry run first, matching
 *   migrate-private-dns-zone-owner.mjs.
 *
 *   It does NOT delete a grant that is genuinely missing from the template.
 *   The only assignments it can reach are ones ARM itself named as blocking a
 *   create the template is performing in the same run — the delete is
 *   immediately followed by that create.
 *
 * USAGE
 *   node scripts/csa-loom/converge-role-assignment.mjs \
 *     --assignment-name <guid ARM printed> [--subscription <id>] [--apply] [--json]
 *
 *   Exit: 0 converged / nothing to do | 1 refused | 2 usage | 3 could not read.
 *
 * Tests: node --test scripts/csa-loom/__tests__/converge-role-assignment.test.mjs
 */

import { spawnSync } from 'node:child_process';
import { redact } from '../ci/_azure-redact.mjs';

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;
export const EXIT_UNREADABLE = 3;

/** 32 hex chars (the form ARM prints) or the canonical dashed form. */
const NAME_RE = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * ARM reports the existing assignment id as 32 undashed hex chars; the
 * Authorization API returns the canonical dashed form. Compare on the dashed
 * form so the two agree.
 */
export function canonicalGuid(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!NAME_RE.test(s)) return null;
  const hex = s.replace(/-/g, '');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Which UUID version a name carries. Reported, never gated on: a stray CAN be
 * v5 (an older template seed), so refusing to touch v5 would leave the exact
 * name-seed-change case #3039 recorded unfixable. It is evidence for the
 * operator, not a decision input — R7.
 */
export function uuidVersion(guid) {
  const c = canonicalGuid(guid);
  return c ? Number.parseInt(c[14], 16) : null;
}

/** Subscription ids never reach a log or an annotation from here. The shared
 * scripts/ci/_azure-redact.mjs is used rather than a local regex — two copies
 * of a redaction rule is one copy that stops being updated. It collapses EVERY
 * guid, including the assignment name, so a name that has to stay legible for
 * correlation is printed through `shortName()` instead. */
export function shortName(guid) {
  const c = canonicalGuid(guid);
  return c ? `${c.slice(0, 8)}…` : '<unreadable>';
}

function azRunner(argv) {
  const r = spawnSync('az', argv, { encoding: 'utf8', shell: false });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout ?? '',
    stderr: r.error ? `${r.stderr ?? ''}\n${r.error.message}` : (r.stderr ?? ''),
  };
}

/**
 * The decision, as a pure function of what Azure returned. Separated from the
 * process so every refusal branch is driven by a test without an Azure login —
 * a guard whose failure path has never executed is not a guard.
 *
 * @param {object} io
 *   listAssignments()  -> {status, assignments|null, error}
 *   listIdentities()   -> {status, principalIds|null, error}
 */
export function decide({ assignmentName, listAssignments, listIdentities }) {
  const wanted = canonicalGuid(assignmentName);
  if (!wanted) {
    return {
      exit: EXIT_USAGE,
      action: 'none',
      reason: `--assignment-name ${JSON.stringify(String(assignmentName ?? ''))} is not a GUID. Nothing is deleted on a name that was not established.`,
    };
  }

  const ra = listAssignments();
  if (ra.status !== 0 || !Array.isArray(ra.assignments)) {
    return {
      exit: EXIT_UNREADABLE,
      action: 'none',
      reason:
        'the role assignments could not be READ, so it is NOT established whether a stray exists — ' +
        `an unreadable control plane is not an empty one. ${redact(ra.error ?? '')}`.trim(),
    };
  }

  const hits = ra.assignments.filter((a) => canonicalGuid(a?.name) === wanted);
  if (hits.length === 0) {
    return {
      exit: EXIT_REFUSED,
      action: 'none',
      reason:
        `the read SUCCEEDED and returned ${ra.assignments.length} assignment(s), none named ${shortName(wanted)}. ` +
        'This read covers one subscription; the assignment ARM named is not asserted to be absent from the ' +
        'tenant, only absent from here. Nothing is deleted.',
    };
  }
  if (hits.length > 1) {
    return {
      exit: EXIT_REFUSED,
      action: 'none',
      reason: `${hits.length} assignments share the name ${shortName(wanted)}. Refusing to guess which one blocks the template.`,
    };
  }

  const hit = hits[0];
  if (hit.principalType !== 'ServicePrincipal') {
    return {
      exit: EXIT_REFUSED,
      action: 'none',
      reason:
        `the assignment's principalType is ${JSON.stringify(hit.principalType ?? null)}, not "ServicePrincipal". ` +
        'Only managed-identity grants the template owns may be converged; a user or group grant — or one whose ' +
        'type Azure did not report — is never deleted unattended.',
    };
  }
  if (!hit.id || !hit.principalId) {
    return {
      exit: EXIT_REFUSED,
      action: 'none',
      reason: 'the assignment came back without an id or a principalId, so there is nothing established to delete.',
    };
  }

  const ids = listIdentities();
  if (ids.status !== 0 || !Array.isArray(ids.principalIds)) {
    return {
      exit: EXIT_UNREADABLE,
      action: 'none',
      reason:
        'the user-assigned managed identities could not be READ, so it is NOT established that this grant belongs ' +
        `to a Loom identity. ${redact(ids.error ?? '')}`.trim(),
    };
  }
  if (!ids.principalIds.some((p) => String(p).toLowerCase() === String(hit.principalId).toLowerCase())) {
    return {
      exit: EXIT_REFUSED,
      action: 'none',
      reason:
        'the grant belongs to a service principal that is NOT a user-assigned managed identity in this ' +
        'subscription. The template only ever grants its own UAMIs, so this assignment is not the one it is ' +
        'blocked on, and deleting a foreign principal\'s access is never this script\'s job.',
    };
  }

  return {
    exit: EXIT_OK,
    action: 'delete',
    assignmentId: hit.id,
    reason:
      `${redact(hit.id)} grants roleDefinitionId ${redact(hit.roleDefinitionId ?? 'unknown')} to a Loom user-assigned ` +
      `managed identity at ${redact(hit.scope ?? 'unknown scope')} under a v${uuidVersion(hit.name) ?? '?'} name. ` +
      'The template declares the same triple under its own deterministic name and cannot create it while this ' +
      'one exists. Deleting it lets the retry recreate the identical grant under the name the template owns.',
  };
}

function listAssignmentsVia(az, subscription) {
  const argv = ['role', 'assignment', 'list', '--all', '-o', 'json'];
  if (subscription) argv.push('--subscription', subscription);
  const r = az(argv);
  if (r.status !== 0) return { status: r.status, assignments: null, error: r.stderr || r.stdout };
  try {
    const parsed = JSON.parse(r.stdout || '[]');
    if (!Array.isArray(parsed)) return { status: 1, assignments: null, error: 'az returned a non-array' };
    return { status: 0, assignments: parsed, error: '' };
  } catch (e) {
    return { status: 1, assignments: null, error: `az output was not JSON: ${e.message}` };
  }
}

function listIdentitiesVia(az, subscription) {
  const argv = ['identity', 'list', '--query', '[].principalId', '-o', 'json'];
  if (subscription) argv.push('--subscription', subscription);
  const r = az(argv);
  if (r.status !== 0) return { status: r.status, principalIds: null, error: r.stderr || r.stdout };
  try {
    const parsed = JSON.parse(r.stdout || '[]');
    if (!Array.isArray(parsed)) return { status: 1, principalIds: null, error: 'az returned a non-array' };
    return { status: 0, principalIds: parsed.filter(Boolean), error: '' };
  } catch (e) {
    return { status: 1, principalIds: null, error: `az output was not JSON: ${e.message}` };
  }
}

export function parseArgs(argv) {
  const out = { assignmentName: null, subscription: null, apply: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--assignment-name') out.assignmentName = argv[++i];
    else if (a === '--subscription') out.subscription = argv[++i];
    else if (a === '--apply') out.apply = true;
    else if (a === '--json') out.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/**
 * @param {object} deps  az runner injected so the delete + the RE-READ that
 *                       verifies it are both exercised by the test suite.
 */
export function run(argv, deps = {}) {
  const az = deps.az ?? azRunner;
  const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));

  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    log(`converge-role-assignment: ${e.message}`);
    return EXIT_USAGE;
  }
  if (!args.assignmentName) {
    log('converge-role-assignment: --assignment-name <guid> is required.');
    return EXIT_USAGE;
  }

  const verdict = decide({
    assignmentName: args.assignmentName,
    listAssignments: () => listAssignmentsVia(az, args.subscription),
    listIdentities: () => listIdentitiesVia(az, args.subscription),
  });

  if (verdict.action !== 'delete') {
    log(`converge-role-assignment: NOT converging — ${verdict.reason}`);
    return verdict.exit;
  }

  log(`converge-role-assignment: ${verdict.reason}`);
  if (!args.apply) {
    log('converge-role-assignment: dry run (no --apply); nothing was deleted.');
    return EXIT_OK;
  }

  const del = az(['role', 'assignment', 'delete', '--ids', verdict.assignmentId]);
  if (del.status !== 0) {
    log(`converge-role-assignment: the delete FAILED, so the collision is unchanged. ${redact(del.stderr || del.stdout)}`);
    return EXIT_REFUSED;
  }

  // R6/R7: `az role assignment delete` exits 0 on a no-op. Success is the
  // assignment being GONE, re-read — not the exit code of the command that
  // claimed to remove it.
  const after = listAssignmentsVia(az, args.subscription);
  if (after.status !== 0 || !Array.isArray(after.assignments)) {
    log(
      'converge-role-assignment: the delete reported success but the verifying re-read FAILED, so it is NOT ' +
        `established that the assignment is gone. ${redact(after.error ?? '')}`,
    );
    return EXIT_UNREADABLE;
  }
  const wanted = canonicalGuid(args.assignmentName);
  if (after.assignments.some((a) => canonicalGuid(a?.name) === wanted)) {
    log(
      `converge-role-assignment: the delete reported success and ${shortName(wanted)} is STILL present. ` +
        'The collision is unchanged; reporting it rather than letting the retry fail the same way.',
    );
    return EXIT_REFUSED;
  }

  log(`converge-role-assignment: converged — ${shortName(wanted)} removed; the template may now create its own name.`);
  return EXIT_OK;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (invokedDirectly || process.argv[1]?.endsWith('converge-role-assignment.mjs')) {
  process.exit(run(process.argv.slice(2)));
}
