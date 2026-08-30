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
 *   it is a MANAGED IDENTITY's grant — user- OR system-assigned — owned by a
 *   resource in a subscription this deployment can reach, deletes it, and
 *   verifies the delete landed. The next deploy attempt recreates the SAME
 *   triple under the template's deterministic name, so the effective permission
 *   set is unchanged and the estate converges on the template as the single
 *   owner.
 *
 * ── THE OWNERSHIP PROOF HAS TWO SOURCES, BECAUSE ONE ENUMERATION CANNOT SEE
 *    HALF THE POPULATION (#4037) ───────────────────────────────────────────────
 *
 *   Source 1 — `az identity list`, the original check. It enumerates EVERY
 *   USER-assigned managed identity in the subscription, and STRUCTURALLY CANNOT
 *   return a system-assigned one: a system-assigned identity is not a
 *   Microsoft.ManagedIdentity resource, it is a property of the resource that
 *   owns it. So the check's IMPLEMENTATION was a strict subset of its own stated
 *   INTENT ("a managed identity the template grants to"), and #4041 put a case in
 *   the gap: modules/admin-plane/adf-keyvault-rbac.bicep grants Key Vault Secrets
 *   User to a Data Factory's SYSTEM-assigned identity. A stray for that triple
 *   reached the refusal branch and the deploy stayed wedged on a failure the
 *   platform is otherwise able to fix — the shape auto-bind-by-default.md §5
 *   calls a defect.
 *
 *   Source 2 — `az ad sp show`, consulted ONLY when source 1 does not already
 *   answer. Microsoft Entra reports `servicePrincipalType: ManagedIdentity` for
 *   both flavours and carries the OWNING Azure resource id in `alternativeNames`
 *   (Graph documents that field as "used to … identify resource group and full
 *   resource IDs for managed identities"). That resolves the principal's KIND
 *   rather than inferring it from one enumeration.
 *
 *   THE PROOF WAS EXTENDED, NOT RELAXED. "Any ServicePrincipal" would let this
 *   script delete a foreign application's access, which is exactly what the
 *   refusal exists to prevent. The accepted class is still a managed identity,
 *   and it is still SCOPED: the owning resource's subscription must be one this
 *   deployment's credentials can enumerate (`az account list`), or the
 *   subscription the blocking assignment itself lives in. A system-assigned MI
 *   owned by a resource in a subscription this deployment cannot reach is
 *   UNRELATED and is refused.
 *
 *   THE CROSS-SUBSCRIPTION CASE IS THE POINT, NOT AN EDGE. #4041's factory sits
 *   in a landing-zone RG in a DIFFERENT subscription from the vault the grant is
 *   scoped to, so "the owner must be in the same subscription as the assignment"
 *   would have refused the exact case this change exists to fix. That is why the
 *   bound is the deployment's subscription SET and not the assignment's scope.
 *
 *   NOTE ON THE STRENGTH OF ALL OF THIS (R7). `az identity list` is not filtered
 *   to `uami-loom-*`, and `az account list` is not filtered to Loom's estate.
 *   Under deploy-integrity.md R5 a brownfield tenant contains identities and
 *   subscriptions Loom does not own, so what is established is "a managed
 *   identity whose owner sits in a subscription these credentials can see" and
 *   NOT "a Loom identity" — and it says exactly that, in the code and in the
 *   operator-facing message. Narrowing to a name prefix was considered and not
 *   done: the template's grantees are not guaranteed to carry one, and a
 *   converger that silently refuses a legitimate collision would leave the
 *   deploy wedged for a reason nobody could see.
 *
 *   GRAPH IS NEVER ON THE PATH THAT ALREADY WORKS. Source 2 runs only after
 *   source 1 has failed to match, so the #3439 collision this script was written
 *   for (a Loom UAMI on the admin-plane ACR) converges with no directory read at
 *   all. A deploy identity without Entra directory read therefore loses nothing
 *   it had; it gets EXIT_UNREADABLE with the role to grant, never a guess.
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
 *     - the principal is neither a user-assigned managed identity in this
 *       subscription NOR a managed identity whose owning resource sits in a
 *       subscription this deployment can reach (so a foreign application's
 *       grant, and an unrelated tenant's managed identity, are never deleted);
 *     - the directory could not be read, or the subscription list could not be
 *       read — an unreadable control plane is EXIT_UNREADABLE, never "assume it
 *       is fine";
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
import { redactedLine } from '../ci/_azure-redact.mjs';

/**
 * THE ONE PUBLICATION BOUNDARY for this script (#3861).
 *
 * Every byte this file puts on a public stream crosses here. That is the shape
 * #3835 spent four rounds arriving at, and this file was the counter-example
 * left outside it: redaction was applied PER SITE, at each `${…}` that its
 * author happened to be thinking about, so the completeness claim went stale the
 * moment a line was added — and one already had. `run()`'s parse-error branch
 * interpolated `e.message` raw, and `parseArgs` throws `unknown argument: <the
 * argument>`, so a GUID handed to the wrong flag reached the run log verbatim.
 *
 * WHY IT MATTERS MORE HERE THAN IN A SCRIPT THAT LOGS FOR ITSELF: deploy-retry
 * spawns this file with `stdio: ['inherit', 'inherit', 'pipe']`, which hands it
 * the PARENT's stdout file descriptor. These bytes land in the public Actions run
 * log with no `process.stdout.write` anywhere in deploy-retry's source, so no
 * write-based assertion in that file can see them
 * (`csa_loom_inherited_fd_is_an_invisible_publication_surface`). The boundary has
 * to be here, on the child, or it does not exist for that path at all.
 *
 * The per-site `redact()` calls were REMOVED rather than left alongside it: a
 * boundary with a bypass beside it is decorative, and two rules for the same
 * bytes is one rule that stops being applied.
 *
 * `redactedLine` is the shared primitive every other boundary in this lane is —
 * `String()` first, so a non-string degrades to visible garbage instead of a
 * silently blank line.
 *
 * APPLIED TWICE ON THE DEFAULT PATH, DELIBERATELY. `run()` crosses this boundary
 * when a message becomes a log line, and the default sink crosses it again at the
 * `process.stdout.write`. That is not redundancy to tidy away: the first
 * application bounds an INJECTED logger (the test seam, and any future caller —
 * a boundary a dependency can bypass is decorative), and the second is the one a
 * structural enumerator can see on the write itself. `redact()` is idempotent by
 * contract — `<guid>` and `<redacted>` contain nothing it matches — which is
 * exactly what lets this lane redact at stacked boundaries.
 *
 * @param {unknown} text
 * @returns {string} the exact bytes that may be published
 */
export function formatStdout(text) {
  return redactedLine(text);
}

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
 * correlation is printed through `shortName()` instead.
 *
 * An 8-hex prefix followed by `…` is NOT a GUID and survives {@link formatStdout}
 * intact, which is what makes correlation possible at all once the boundary
 * redacts everything else. */
export function shortName(guid) {
  const c = canonicalGuid(guid);
  return c ? `${c.slice(0, 8)}…` : '<unreadable>';
}

/**
 * The owning Azure resource id carried on a managed identity's service
 * principal. Entra populates `alternativeNames` with two entries for a managed
 * identity — an `isExplicit=<bool>` marker and the FULL RESOURCE ID of the
 * owner:
 *
 *   system-assigned  ["isExplicit=False",
 *                     "/subscriptions/<s>/resourcegroups/<rg>/providers/
 *                      Microsoft.DataFactory/factories/<name>"]
 *   user-assigned    ["isExplicit=True",
 *                     "/subscriptions/<s>/resourcegroups/<rg>/providers/
 *                      Microsoft.ManagedIdentity/userAssignedIdentities/<name>"]
 *
 * Matched by SHAPE (a `/subscriptions/<guid>/…/providers/<ns>/<type>/<name>`
 * id), never by position in the array and never by the `isExplicit` marker:
 * position is not contractual, and gating on the marker would re-introduce the
 * exact "one flavour is invisible" defect #4037 records. Returns null when no
 * entry is a resource id — a ManagedIdentity with no resolvable owner is
 * refused rather than assumed.
 */
export function ownerResourceId(alternativeNames) {
  const list = Array.isArray(alternativeNames) ? alternativeNames : [];
  for (const raw of list) {
    const s = String(raw ?? '').trim();
    if (/^\/subscriptions\/[0-9a-f-]{36}\/[^/]+\/[^/]+\/providers\/[^/]+\/.+$/i.test(s)) return s;
  }
  return null;
}

/**
 * The subscription an Azure resource id (or a role-assignment id, or a scope)
 * lives in, lower-cased for comparison. null when the string is not scoped to a
 * subscription — a management-group or tenant-scoped id has no answer here, and
 * inventing one would be an R7 violation.
 */
export function subscriptionOf(resourceId) {
  const m = /^\/subscriptions\/([0-9a-f-]{36})(?:\/|$)/i.exec(String(resourceId ?? '').trim());
  return m ? m[1].toLowerCase() : null;
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
 *   listAssignments()      -> {status, assignments|null, error}
 *   listIdentities()       -> {status, principalIds|null, error}
 *   describePrincipal(pid) -> {status, principal|null, error}
 *                             principal: {servicePrincipalType, alternativeNames}
 *   listSubscriptions()    -> {status, subscriptionIds|null, error}
 *
 * describePrincipal and listSubscriptions DEFAULT TO FAILING, not to absent. An
 * omitted resolver is a caller that cannot establish ownership, and the only
 * safe reading of "cannot establish" is EXIT_UNREADABLE — never an accept. That
 * default is asserted by its own test, because a fail-OPEN default is how a
 * proof silently stops being one.
 *
 * ── THE VERDICT CROSSES THE PUBLICATION BOUNDARY EXACTLY ONCE (#3861) ───────
 *
 * `reason` is written for an operator and is published by every caller, so it is
 * redacted — but ONCE, HERE, over the whole composed string, rather than at each
 * `${…}` inside `decideBranches` below. The per-field spelling is what #3861
 * reported: every new interpolation is a fresh opportunity to forget, and the
 * claim "the enumeration is complete" goes stale the moment a line is added.
 *
 * There is exactly one `return` in this function, so no verdict can reach a
 * caller without crossing it — a property a reader can check by looking, and one
 * the structural test in `__tests__/converge-publication-surfaces-3861.test.mjs`
 * asserts mechanically.
 */
export function decide(io) {
  const v = decideBranches(io);
  return { ...v, reason: formatStdout(v.reason) };
}

function decideBranches({
  assignmentName,
  listAssignments,
  listIdentities,
  describePrincipal = () => ({ status: 1, principal: null, error: 'no directory resolver was supplied to decide()' }),
  listSubscriptions = () => ({ status: 1, subscriptionIds: null, error: 'no subscription resolver was supplied to decide()' }),
}) {
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
        `an unreadable control plane is not an empty one. ${ra.error ?? ''}`.trim(),
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
        `to a managed identity in this subscription. ${ids.error ?? ''}`.trim(),
    };
  }

  const pid = String(hit.principalId).toLowerCase();
  const isUserAssigned = ids.principalIds.some((p) => String(p).toLowerCase() === pid);

  if (isUserAssigned) {
    return {
      exit: EXIT_OK,
      action: 'delete',
      assignmentId: hit.id,
      identityKind: 'user-assigned',
      reason:
        `${hit.id} grants roleDefinitionId ${hit.roleDefinitionId ?? 'unknown'} to a user-assigned ` +
        `managed identity IN THIS SUBSCRIPTION at ${hit.scope ?? 'unknown scope'} under a ` +
        `v${uuidVersion(hit.name) ?? '?'} name. (That is what the read establishes: "az identity list" is not ` +
        'filtered to uami-loom-*, so this is not a claim that Loom owns it.) ' +
        'The template declares the same triple under its own deterministic name and cannot create it while this ' +
        'one exists. Deleting it lets the retry recreate the identical grant under the name the template owns.',
    };
  }

  // SECOND SOURCE (#4037). `az identity list` cannot return a SYSTEM-assigned
  // principal — it is a property of the owning resource, not a
  // Microsoft.ManagedIdentity resource — so a miss above is not evidence that
  // this is a foreign service principal. Resolve the principal's KIND before
  // saying anything about it.
  const sp = describePrincipal(hit.principalId);
  if (sp.status !== 0 || !sp.principal || typeof sp.principal !== 'object') {
    return {
      exit: EXIT_UNREADABLE,
      action: 'none',
      reason:
        'the principal is not a user-assigned managed identity in this subscription, and its DIRECTORY object ' +
        'could not be READ, so its kind is NOT established — an unreadable directory is not an absent one. It may ' +
        'be a system-assigned managed identity this deploy is entitled to converge. Remediation: grant the deploy ' +
        'identity Entra directory read (the Directory Readers role, or Application.Read.All) so "az ad sp show" ' +
        `resolves it; until then this collision must be cleared by hand. ${sp.error ?? ''}`.trim(),
    };
  }

  const spType = sp.principal.servicePrincipalType ?? null;
  if (spType !== 'ManagedIdentity') {
    return {
      exit: EXIT_REFUSED,
      action: 'none',
      reason:
        `the grant belongs to a service principal whose directory type is ${JSON.stringify(spType)}, not ` +
        '"ManagedIdentity", and it is not a user-assigned managed identity in this subscription either. The ' +
        'template only ever grants managed identities, so this assignment is not the one it is blocked on, and ' +
        "deleting a foreign principal's access is never this script's job.",
    };
  }

  const owner = ownerResourceId(sp.principal.alternativeNames);
  if (!owner) {
    return {
      exit: EXIT_REFUSED,
      action: 'none',
      reason:
        'the directory reports this principal as a ManagedIdentity but carries no owning Azure resource id on it, ' +
        'so WHICH resource it belongs to is not established. Nothing is deleted on an identity whose owner could ' +
        'not be named.',
    };
  }

  const ownerSub = subscriptionOf(owner);
  const subs = listSubscriptions();
  if (subs.status !== 0 || !Array.isArray(subs.subscriptionIds)) {
    return {
      exit: EXIT_UNREADABLE,
      action: 'none',
      reason:
        'this grant belongs to a managed identity, but the subscriptions these credentials can reach could not be ' +
        'READ, so it is NOT established that its owning resource is inside this deployment. Remediation: run where ' +
        '"az account list" succeeds (a completed az login), or clear this collision by hand. ' +
        `${subs.error ?? ''}`.trim(),
    };
  }

  // The blocking assignment's own subscription is by definition one this
  // deployment touches — it is the subscription being deployed into. Union it
  // with what the credentials can enumerate.
  const reachable = new Set(
    subs.subscriptionIds.map((s) => String(s ?? '').trim().toLowerCase()).filter(Boolean),
  );
  const assignmentSub = subscriptionOf(hit.id) ?? subscriptionOf(hit.scope);
  if (assignmentSub) reachable.add(assignmentSub);

  if (!ownerSub || !reachable.has(ownerSub)) {
    return {
      exit: EXIT_REFUSED,
      action: 'none',
      reason:
        `the grant belongs to a managed identity owned by ${owner}, which is NOT in any subscription these ` +
        'credentials can reach. An unrelated tenant-mate\'s managed identity is not this deployment\'s to converge, ' +
        'so nothing is deleted. If that resource IS part of this estate, give the deploy identity access to its ' +
        'subscription and re-run; otherwise remove the colliding assignment deliberately, by hand.',
    };
  }

  return {
    exit: EXIT_OK,
    action: 'delete',
    assignmentId: hit.id,
    identityKind: 'resource-owned',
    reason:
      `${hit.id} grants roleDefinitionId ${hit.roleDefinitionId ?? 'unknown'} to the MANAGED ` +
      `IDENTITY of ${owner} at ${hit.scope ?? 'unknown scope'} under a ` +
      `v${uuidVersion(hit.name) ?? '?'} name. (That is what the reads establish: the directory reports the ` +
      'principal as a ManagedIdentity and its owning resource is in a subscription these credentials can reach — ' +
      'not a claim that Loom owns it.) ' +
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

/**
 * The principal's DIRECTORY object — its kind and, for a managed identity, the
 * resource that owns it. Reached only when `az identity list` did not already
 * answer, so a deploy identity with no Entra directory read keeps every
 * behaviour it had before #4037.
 *
 * NOT SUBSCRIPTION-SCOPED, deliberately: Entra is tenant-scoped, and a managed
 * identity's SP is resolvable regardless of which subscription `az` has
 * selected. The subscription bound is applied to the OWNER, in decide().
 */
function describePrincipalVia(az, principalId) {
  const r = az([
    'ad',
    'sp',
    'show',
    '--id',
    String(principalId),
    '--query',
    '{servicePrincipalType:servicePrincipalType,alternativeNames:alternativeNames}',
    '-o',
    'json',
  ]);
  if (r.status !== 0) return { status: r.status, principal: null, error: r.stderr || r.stdout };
  try {
    const parsed = JSON.parse(r.stdout || 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 1, principal: null, error: 'az returned no service-principal object' };
    }
    return { status: 0, principal: parsed, error: '' };
  } catch (e) {
    return { status: 1, principal: null, error: `az output was not JSON: ${e.message}` };
  }
}

/** The subscriptions these credentials can enumerate — the bound on "inside this deployment". */
function listSubscriptionsVia(az) {
  const r = az(['account', 'list', '--query', '[].id', '-o', 'json']);
  if (r.status !== 0) return { status: r.status, subscriptionIds: null, error: r.stderr || r.stdout };
  try {
    const parsed = JSON.parse(r.stdout || '[]');
    if (!Array.isArray(parsed)) return { status: 1, subscriptionIds: null, error: 'az returned a non-array' };
    return { status: 0, subscriptionIds: parsed.filter(Boolean), error: '' };
  } catch (e) {
    return { status: 1, subscriptionIds: null, error: `az output was not JSON: ${e.message}` };
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
  // THE ONLY WRITE TO A PUBLIC STREAM IN THIS FILE, and its argument crosses
  // formatStdout().
  const sink = deps.log ?? ((line) => process.stdout.write(formatStdout(`${line}\n`)));
  // …and the boundary is crossed AGAIN here, wrapping whatever sink is in play,
  // so an injected logger is bounded too. Every `log(...)` below is therefore
  // bounded by construction — including ones added later, which is exactly the
  // property per-site redaction did not have (#3861).
  const log = (text) => sink(formatStdout(text));

  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    // `parseArgs` throws `unknown argument: <the argument itself>`, so a GUID
    // handed to the wrong flag arrives here. It used to be interpolated raw into
    // a public run log; it now crosses the boundary like everything else.
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
    describePrincipal: (principalId) => describePrincipalVia(az, principalId),
    listSubscriptions: () => listSubscriptionsVia(az),
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
    log(`converge-role-assignment: the delete FAILED, so the collision is unchanged. ${del.stderr || del.stdout}`);
    return EXIT_REFUSED;
  }

  // R6/R7: `az role assignment delete` exits 0 on a no-op. Success is the
  // assignment being GONE, re-read — not the exit code of the command that
  // claimed to remove it.
  const after = listAssignmentsVia(az, args.subscription);
  if (after.status !== 0 || !Array.isArray(after.assignments)) {
    log(
      'converge-role-assignment: the delete reported success but the verifying re-read FAILED, so it is NOT ' +
        `established that the assignment is gone. ${after.error ?? ''}`,
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
