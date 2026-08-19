#!/usr/bin/env node
/**
 * GUARDRAIL: owner-only-workspace-guard  (merge-blocker, RATCHETING — #2947)
 * ---------------------------------------------------------------------------
 * RULE: a workspace authorization decision goes through the canonical ladder in
 *   `lib/auth/workspace-guard.ts` (`authorizeWorkspace` / `authorizeItemWorkspace`
 *   / `resolveAdminWorkspace`), NEVER an owner-only point read.
 *
 * THE DEFECT THIS RATCHETS. `workspacesContainer().item(<workspaceId>, <callerOid>)`
 *   is a PARTITION point read. The `workspaces` container is partitioned on
 *   `/tenantId` and `Workspace.tenantId` stores the workspace CREATOR's Entra oid
 *   (`lib/auth/workspace-access.ts`), so a workspace document exists ONLY in its
 *   creator's partition. That read can therefore only answer
 *
 *       "did this caller CREATE this workspace?"
 *
 *   and never "may this caller ACCESS it?". A tenant admin, a shared-ACL member,
 *   or any non-creator is refused. Two live editors shipped broken on exactly
 *   this (#2941 semantic-model — "Column metadata load failed"; #2942 pipeline
 *   canvas), and #2947 migrated 87 call sites off the shared `assertOwner`
 *   helper, which was then DELETED so tsc stops its return.
 *
 * WHY A RATCHET AND NOT A HARD ZERO. Deleting `assertOwner` does not stop the
 *   next author RE-INLINING its four-line body under a new name — which is
 *   precisely what five routes had already done before #2947
 *   (admin/workspaces/{connections,spark/environment,spark/pools},
 *   workspaces/{permissions,scm} each carried a private copy). This guard
 *   detects the SHAPE, not the name. A residual population of the same shape
 *   still exists on other route families (apps/, data-products/,
 *   deployment-pipelines/, external-shares/, …) — those are real candidates for
 *   the same bug but were deliberately OUT of #2947's scope, so they are
 *   baselined here rather than silently ignored or noisily failed.
 *
 * DETECTION — a file scores one violation per line that BOTH
 *   1. point-reads a container resolved from `workspacesContainer()` with a
 *      caller-oid / tenantId partition key, AND
 *   2. is in a file that also compares `.tenantId ===` / `.tenantId !==`
 *      (the "and it's mine" half of the owner-only idiom),
 *   plus one violation for any `assertOwner` identifier (the deleted helper).
 *
 * RATCHET SEMANTICS (shared mechanic — scripts/ci/_ratchet-count.mjs):
 *   1. per-key rise → FAIL (a net-new owner-only guard).
 *   2. touched-file (boy-scout) → a baselined file this PR MODIFIES must be
 *      migrated to the canonical ladder while you're there. Escape hatch:
 *      TOUCH_EXEMPT below, with a one-line reason.
 *
 * Baseline: scripts/ci/owner-only-workspace-guard-baseline.json (shrink-only;
 * regen with --update-baseline and a one-line justification in the PR body).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRatchet, gitTouchedFiles } from './_ratchet-count.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');
const BASELINE_FILE = path.join(__dirname, 'owner-only-workspace-guard-baseline.json');

/** The canonical guard module itself documents the deleted helper by name. */
const SELF = 'apps/fiab-console/lib/auth/workspace-guard.ts';

/**
 * Touched-file escape hatch: repo-relative path → one-line reason a PR may
 * modify a baselined file without migrating it. Keep SHORT.
 */
const TOUCH_EXEMPT = new Map([
  // #3549/#3551 touched this route ONLY inside Phase-1 item creation, to backfill
  // the bundle definition onto a name-matched EXISTING item that carries none.
  // It reads and replaces THAT ITEM through the already-resolved `items`
  // container and `workspaceId`; it adds no workspace-ownership decision, and the
  // baselined occurrence (the install's own workspace check) is untouched.
  // Migrating this route's workspace gate to `authorizeWorkspace` WIDENS who may
  // install an app into a workspace — a deliberate access change that belongs in
  // its own PR, not inside a content-reachability fix.
  ['apps/fiab-console/app/api/apps/[id]/install/route.ts',
   '#3549/#3551: Phase-1 content backfill only; migrating the install workspace gate WIDENS who may install — separate PR'],
  // #3549/#3551 split `loadContentBackedItem` into `readContentBackedItem`
  // (three outcomes) + a compatible wrapper, so a caller can tell "no such owned
  // item" from "the Cosmos read FAILED". Without that distinction a transient
  // 429/403 while opening a LOOM-NATIVE model read as "no Loom item here" and
  // fell through to Power BI, rendering "Select a Power BI workspace" over an
  // item that has nothing to do with Power BI (no-fabric-dependency.md, reached
  // through UNKNOWN-reported-as-NEGATIVE).
  //
  // The baselined occurrence is the `resource.tenantId !== tenantId` check, which
  // MOVED but is otherwise byte-identical — the ratchet still counts it, and the
  // total is unchanged at 69. It is deliberately still owner-only: this helper
  // backs ~40 bundle-content read sites, and `authorizeWorkspace` would newly
  // admit tenant admins and shared-ACL members to every one of them.
  ['apps/fiab-console/app/api/items/_lib/pbi-content-fallback.ts',
   '#3549/#3551: ownership check moved verbatim, count unchanged; widening it would newly admit admins/ACL to ~40 read sites — separate PR'],
  // #3549/#3551 touched this file for ONE pure function, `specFromItem`, which
  // performs no I/O and takes no authorization decision: it reads the MLV
  // definition out of an ALREADY-LOADED item, and the change adds the
  // `state.content.spec` / `state.content.mlv` keys the install-time provisioner
  // writes (materialized-lake-view.ts:29) so a bundle-installed MLV does not
  // open with an empty definition. `loadMlvItem` — the baselined owner-only
  // point read, and the only authorization code in the file — is untouched, and
  // migrating it to `authorizeItemWorkspace` WIDENS access (it would newly admit
  // tenant admins and shared-ACL members) across the six `/api/items/
  // materialized-lake-view/*` routes that depend on it. That is a real
  // authorization change and needs its own review and tests, not a drive-by
  // inside a content-reachability fix.
  ['apps/fiab-console/app/api/items/materialized-lake-view/_lib/load.ts',
   '#3549/#3551: pure specFromItem only; migrating loadMlvItem WIDENS access for 6 MLV routes — separate PR'],
  // GHSA-v2g8-gp3r-rg4r touched this file for +10 LOC that are UNRELATED to the
  // baselined line: `createDatabase` now reports whether ARM returned 201
  // (created) or 200 (updated), so a caller cannot bind a database that already
  // existed. The baselined occurrence is `loadKustoItem`'s owner-only point
  // read, which 13 `/api/adx/*` routes depend on; migrating it to
  // `authorizeItemWorkspace` WIDENS access (it would newly admit tenant admins
  // and shared-ACL members) and so needs its own review and its own tests, not
  // a drive-by inside a security fix.
  ['apps/fiab-console/lib/azure/kusto-client.ts',
   'GHSA-v2g8-gp3r-rg4r: +10 LOC on createDatabase only; migrating loadKustoItem WIDENS access for 13 /api/adx routes — separate PR'],
  // #3697/#3698 touched this file ONLY to fix `accessOptsFor`, which is itself a
  // correction IN THIS GUARD'S DIRECTION: the helper hand-built the
  // workspace-access options and DROPPED `tenantAdmin`, so the ~345 routes behind
  // `loadOwnedItem` / `listOwnedItems` / `listAllOwnedItems` refused a tenant
  // admin who did not personally CREATE the workspace — the #2941/#2942 defect
  // this ratchet exists for, reached through the shared helper rather than an
  // inline point read. It now delegates to `ambientAccessOptsFor`, and (after
  // review) applies the SAME principal match that helper does.
  //
  // NONE OF THE FOUR BASELINED OCCURRENCES IS IN THIS PR'S DIFF. That is
  // measured — re-run the detector's own predicate over this file and it names
  // the four sites — and it is stated by FUNCTION rather than by line number on
  // purpose: an earlier revision of this entry cited line numbers inside a
  // sentence claiming "measured, not assumed", and adding comments to the file
  // immediately falsified them. The functions do not move:
  //   mirrorGovernanceDoc    reads the workspace NAME/domain to label an AI
  //                          Search doc. Not an authorization decision at all;
  //                          the read is try/catch'd and falls back to the raw
  //                          workspace id. Shape-detector false positive.
  //   applyLabelInheritance  confirms an upstream SOURCE item's workspace is in
  //                          the caller's own partition before inheriting its
  //                          sensitivity label. Owner-only, and CONSERVATIVE: it
  //                          under-inherits for a shared or admin-reached
  //                          source. A governance-completeness gap, not an
  //                          access hole.
  //   createOwnedItem        this is the OWNER FAST PATH, and it already falls
  //                          through to the canonical ladder: the branch below
  //                          it re-resolves the workspace cross-partition and
  //                          authorizes with `authorizeWorkspace(session,
  //                          workspaceId)` (write-scoped).
  //   loadRecycledItem       the one genuine #2941-shaped read: recycle-bin
  //                          restore/purge is limited to the workspace CREATOR,
  //                          so a tenant admin or write-capable ACL member
  //                          cannot restore. It fails CLOSED, and migrating it
  //                          WIDENS who can restore and purge items — an
  //                          authorization change that needs its own review and
  //                          its own tests, not a drive-by inside a 404 fix.
  //
  // The PR's edits are confined to `accessOptsFor` and the five call sites that
  // await it; none of them is one of the four above.
  ['apps/fiab-console/app/api/items/_lib/item-crud.ts',
   "#3697/#3698: the diff is confined to accessOptsFor + its five call sites (a correction in THIS guard's direction — it restores the dropped tenantAdmin AND adds the principal match) and touches none of the four baselined sites; mirrorGovernanceDoc is a name lookup, applyLabelInheritance fails closed, createOwnedItem already falls through to authorizeWorkspace, and migrating loadRecycledItem would WIDEN recycle-bin restore/purge — separate PR"],
]);

/** Owner-partition point read: `.item(<x>, <oid-ish>)` on a workspaces handle. */
const POINT_READ_RE =
  /\.item\(\s*[A-Za-z0-9_.[\]]+\s*,\s*(?:[A-Za-z0-9_]*\.)*(?:claims\.oid|oid|tenantId|ownerOid)\s*\)/;
/** The "…and it's mine" comparison that makes the read an OWNERSHIP test. */
const OWNER_CMP_RE = /\.tenantId\s*[!=]==/;
/** The deleted helper, by name (identifier use, not prose). */
const ASSERT_OWNER_RE = /(?:^|[^\w.])assertOwner\s*[(=:]/;

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name === '__tests__') continue;
      walk(p, acc);
    } else if (/\.tsx?$/.test(e.name)) {
      acc.push(p);
    }
  }
  return acc;
}

/** Drop comment lines so documentation of the deleted helper is not a hit. */
const isComment = (l) => {
  const t = l.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
};

const current = {};
for (const abs of [...walk(path.join(APP_ROOT, 'app')), ...walk(path.join(APP_ROOT, 'lib'))]) {
  const rel = path.relative(REPO_ROOT, abs).replace(/\\/g, '/');
  if (rel === SELF) continue;
  const raw = fs.readFileSync(abs, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => !isComment(l));
  const code = lines.join('\n');
  const usesWorkspaces = /workspacesContainer\s*\(/.test(code);
  const comparesOwner = OWNER_CMP_RE.test(code);
  let n = 0;
  for (const l of lines) {
    if (usesWorkspaces && comparesOwner && POINT_READ_RE.test(l)) n++;
    if (ASSERT_OWNER_RE.test(l)) n++;
  }
  if (n > 0) current[rel] = n;
}

process.exit(
  runRatchet({
    name: 'owner-only-workspace-guard',
    baselineFile: BASELINE_FILE,
    meta: {
      owner: 'CSA Loom platform / security',
      why:
        'An owner-only workspace point read answers "did you CREATE this workspace", ' +
        'not "may you ACCESS it" — it refuses tenant admins and shared-ACL members ' +
        '(#2941/#2942/#2947). Use authorizeWorkspace / authorizeItemWorkspace / ' +
        'resolveAdminWorkspace from lib/auth/workspace-guard.ts, read/write scoped.',
      unblock:
        'node scripts/ci/check-owner-only-workspace-guard.mjs --update-baseline ' +
        '(run in the blocked PR with a one-line justification)',
    },
    current,
    touched: {
      files: gitTouchedFiles({ cwd: REPO_ROOT }),
      exempt: TOUCH_EXEMPT,
      message: () =>
        'migrate this file to authorizeWorkspace / authorizeItemWorkspace / resolveAdminWorkspace ' +
        '(read-only handlers pass { allowReadRoles: true }; mutating handlers MUST NOT)',
    },
  }),
);
