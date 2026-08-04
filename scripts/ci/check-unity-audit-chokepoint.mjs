/**
 * GUARDRAIL: unity-audit-chokepoint  (merge-blocker — loom-apex LU-3)
 * ---------------------------------------------------------------------------
 * RULE:
 *
 *   EVERY Unity Catalog call the Console BFF makes must go through an AUDITED
 *   transport whose `finally` writes the WHO / WHAT / WHEN / OUTCOME (including
 *   DENIALS) row to the Cosmos `_auditLog` trail and the `LoomAudit_CL` SIEM
 *   stream. There are exactly FIVE such transports ({@link AUDITED_TRANSPORTS}):
 *
 *     apps/fiab-console/lib/azure/unity-catalog-client.ts  →  ucFetch
 *         the backend-agnostic UC REST client (Loom Unity / OSS UC in Gov,
 *         Databricks UC in Commercial). Records via `recordUnityAccess(...)`.
 *     apps/fiab-console/lib/azure/databricks-client.ts     →  dbxFetch
 *         the Databricks workspace client. The Commercial DEFAULT routes call
 *         it DIRECTLY for catalog owner change (patchUcCatalog), catalog delete
 *         (deleteUcCatalog) and grant mutation (updateUcPermissions —
 *         `PATCH /api/2.1/unity-catalog/permissions/...`). Records via
 *         `recordDatabricksUnityAccess(...)`, which filters to catalog paths.
 *     apps/fiab-console/lib/azure/uc-sql.ts                →  ucSql
 *         the Databricks **SQL Statement Execution** transport — the governance
 *         DDL half (GRANT/REVOKE, ABAC CREATE/DROP POLICY, ALTER … SET MASK /
 *         SET ROW FILTER, governed tags, SET TAGS). Records via
 *         `recordUnitySqlAccess(...)`, which NEVER copies the statement text.
 *     apps/fiab-console/lib/azure/unity-catalog-account-client.ts → acctFetch
 *         the Databricks ACCOUNT plane — metastore assignment, an account-admin
 *         mutation on a non-`unity-catalog/` path. Records via
 *         `recordUnityAccountAccess(...)`.
 *     apps/fiab-console/lib/azure/uc-securable.ts          →  ucSecurable
 *         the audited FACADE over storage-credential + external-location
 *         CREATE/DELETE — the securables that hand a workload access to a
 *         storage account. Records via `recordUnitySecurableAccess(...)`. It is
 *         a facade rather than a `try/finally` because the module that holds the
 *         transport (`shortcut-credentials.ts`) is covered by a repo-level
 *         credential-path read/write deny and cannot be edited; check 8 makes
 *         the facade the only door to it.
 *
 * WHY A GUARD AND NOT JUST A COMMENT:
 *   An audit choke point is only a choke point if bypassing it is HARD. A
 *   convention ("please call ucFetch") silently degrades the first time someone
 *   adds `fetch(process.env.LOOM_UNITY_URL + '/api/2.1/...')` to a new route —
 *   and an audit trail with a hole in it is worse than none, because it is
 *   trusted. This guard turns that mistake into a red build.
 *
 * ## HISTORY — why this file was rewritten (2026-07-28 adversarial review)
 *
 * The first version of this guard PASSED three demonstrated bypasses, which is
 * worse than having no guard because the docs asserted coverage:
 *
 *   1. Its "recordUnityAccess is inside the ucFetch finally" check was
 *      `src.indexOf('} finally {')` followed by `src.slice(idx).includes(...)`
 *      — a substring test over the remaining ~2600 lines of the file. Gutting
 *      the real finally and leaving one decoy `recordUnityAccess({} as never)`
 *      500 lines below passed. FIXED: the check now brace-matches the named
 *      function body, then brace-matches each `finally` block INSIDE it, and
 *      requires the recorder call to be inside one of those blocks (comments and
 *      string literals masked first, so a mention in a doc comment cannot
 *      satisfy it).
 *   2. Its bypass scan only recognised OSS addresses
 *      (`/LOOM_UNITY_URL|ossUcBase\(/`), so an unaudited
 *      `PATCH /api/2.1/unity-catalog/permissions/... {add:['ALL_PRIVILEGES']}`
 *      appended to databricks-client.ts — a privilege grant on the backend
 *      ~every Commercial estate runs — exited 0. FIXED: `UNITY_ADDRESS_RE` now
 *      also matches a Unity Catalog REST path literal, so a Databricks-side
 *      bypass trips the same wire.
 *   3. It said nothing about the ~25 `executeStatement(` exits in
 *      unity-catalog-client.ts (Databricks SQL Statement Execution — a
 *      DIFFERENT API from UC REST, including governance DDL:
 *      createUcPolicy/dropUcPolicy/mutateUcGovernedTag/setUcTags). Those are
 *      genuinely NOT covered by this trail. They are now RATCHETED: the count
 *      may go DOWN (each one routed through an audited path) but never UP.
 *
 * ## HISTORY — round 3 (2026-07-28). Three MORE demonstrated bypasses.
 *
 * The round-2 rewrite above still exited 0 on all three of these:
 *
 *   4. `.tsx` BLIND SPOT. `referencesCatalogAddress()` applied the UC-REST-path
 *      arm to non-`.tsx` files only, justified by "a .tsx component holds no
 *      credential". False for App Router SERVER components, which are `.tsx`.
 *      A reviewer made app/admin/rogue/page.tsx an async server component that
 *      PATCHed `/api/2.1/unity-catalog/permissions/table/a.b.c`; zero failures.
 *      FIXED: the exemption now keys off the `'use client'` DIRECTIVE
 *      ({@link isClientComponent}), not the file extension.
 *   5. WHOLE-FILE EXEMPTIONS. `KNOWN_UNAUDITED` (and every CHOKEPOINT_FILES
 *      entry except databricks-client.ts) had no per-file ceiling, so a declared
 *      or allowlisted file could grow ARBITRARY new un-audited catalog calls.
 *      A reviewer appended a fresh unaudited permissions PATCH to
 *      shortcut-credentials.ts; zero failures. FIXED: {@link OUTBOUND_BASELINE}
 *      pins every exempted file, and a file exempted WITHOUT a pin now fails.
 *   6. TRANSPORT BLIND SPOT. `REQUEST_RE` matched only fetch/axios/http.request,
 *      so `import { request } from 'undici'` passed — as did a UC path assembled
 *      by concatenation (`'/api/2.1/' + 'unity-catalog/...'`), which defeated
 *      `UNITY_REST_PATH_RE`. FIXED (partially — see LIMITS): the transport set
 *      now covers the HTTP clients resolvable here and counts a bare IMPORT of
 *      one, and the path regex has a second arm matching the bare
 *      `unity-catalog/` segment.
 *
 * ## HISTORY — round 4 (2026-07-29). The ratchet measured less than the scan.
 *
 *   7. TWO VOCABULARIES. Round 3 widened `REQUEST_RE` (check 4) but left
 *      `countOutbound()` (check 2) matching only `fetchWithTimeout(` and a bare
 *      `fetch(`. Check 4 SKIPS every exempted file, so on the allowlist and on
 *      the declared gaps the ratchet is the ONLY control — and it was measuring
 *      a strictly narrower thing than the waived scan. Three transports walked
 *      through it with ZERO failures: undici `request` and `https.request`
 *      appended to the allowlisted `databricks-client.ts` (a
 *      `PATCH …/unity-catalog/permissions/… ALL_PRIVILEGES`), and `axios.post`
 *      appended to the declared-gap `shortcut-credentials.ts`.
 *      FIXED, as a CLASS: {@link TRANSPORTS} is now the single vocabulary and
 *      BOTH consumers derive from it ({@link hasTransport},
 *      {@link countOutbound}), so they cannot disagree. Every entry carries a
 *      `sample`, and the spec asserts per entry that both consumers see it —
 *      that invariant is what stops a future transport being pasted into one
 *      consumer and not the other. Regression tests: guard spec #15–#18.
 *      Side effect: the code arms are now matched against comment+string-masked
 *      source instead of raw text, which drops the prose false positive in
 *      `lib/admin/env-checks/data-plane.ts` ("…on the request (in addition to a
 *      session)") without dropping any real call.
 *
 *   8. A DECOMPOSITION NARROWED A RATCHET. Same round, found while fixing #7.
 *      `unity-catalog-client.ts` sits AT its `check-file-size` ceiling, so LU-3's
 *      audit `try/finally` forced the 165-line Databricks system-table block out
 *      into `lib/azure/uc-system-tables.ts` — carrying ONE `executeStatement(`
 *      (the shared `runSystemTableRead`) out of view of a ratchet that was
 *      scoped to a single file. FIXED: {@link SQL_EXIT_BASELINES} is a per-file
 *      Map (24 + 1, still 25 in total), and a pinned file that DISAPPEARS fails,
 *      so a rename cannot drop a ceiling either. Lesson worth keeping: any
 *      refactor that moves code out of a ratcheted file must move the ratchet
 *      with it, or the refactor IS the bypass.
 *
 * ## HISTORY — round 5 (2026-08-02, issue #2622). Two declared gaps CLOSED.
 *
 *   9. THE SQL HALF WAS RATCHETED, NOT AUDITED. Rounds 2–4 froze the
 *      `executeStatement(` count and called that coverage. A frozen count is not
 *      a trail: 25 governance-DDL exits — `GRANT`/`REVOKE`, ABAC
 *      `CREATE POLICY` / `DROP POLICY`, `ALTER … SET MASK` / `SET ROW FILTER`,
 *      `CREATE`/`ALTER`/`DROP GOVERNED TAG`, `SET TAGS` — still produced NO Loom
 *      row. Worse, the ratchet only pinned TWO files: the UC granular-security
 *      route (`app/api/items/[type]/[id]/security/route.ts`), which is the
 *      column-mask + row-filter wizard and therefore the SAME governance class,
 *      had TEN un-audited exits and was not pinned at all.
 *      FIXED: {@link SQL_CHOKEPOINT} (`ucSql`) wraps the transport and records
 *      from a `finally`; every UC-governance file is pinned at ZERO raw exits;
 *      the security route is now pinned too.
 *  10. THE ACCOUNT PLANE WAS INVISIBLE BY CONSTRUCTION.
 *      `unity-catalog-account-client.ts` targets `/api/2.0/accounts/{id}`, which
 *      matches neither {@link UNITY_ADDRESS_RE} nor {@link UNITY_REST_PATH_RE},
 *      so check 4 never saw it and it was not even in KNOWN_UNAUDITED — a gap
 *      the guard could not report. Metastore ASSIGNMENT decides which metastore
 *      an entire workspace sees and requires account admin.
 *      FIXED: {@link ACCOUNT_CHOKEPOINT} records from `acctFetch`'s `finally`.
 *      Lesson worth keeping: "the scan found nothing" is not "there is nothing"
 *      when the scan's address vocabulary cannot express the surface.
 *  11. FOUR TRANSPORTS, ONE CHECK. Checks 1 and 3 were two hand-written copies
 *      of the same `finally` assertion; adding a third and fourth by copy would
 *      invite the drift that produced bypass #7 (two vocabularies). Both are now
 *      derived from {@link AUDITED_TRANSPORTS}, and the spec asserts per entry
 *      that gutting THAT transport's finally fails the build.
 *
 * ## HISTORY — round 6 (2026-08-04, issue #2622). The LAST declared gap closed.
 *
 *  12. AN UN-INSTRUMENTABLE FILE IS NOT AN UN-AUDITABLE SURFACE.
 *      Rounds 2–5 recorded `shortcut-credentials.ts` as gap 1 and left it, twice,
 *      for the same stated reason: the path is covered by a repo-level
 *      credential-path read/write deny (the glob that protects `.env` and
 *      `secrets/` also matches `*credentials*`), so the `try/finally` every other
 *      transport got could not be added INSIDE it. That reasoning silently
 *      assumed the only place to audit a call is at its transport.
 *      It is not. Those five exports have exactly ONE production consumer
 *      (`shortcut-engines.ts`), so an audited FACADE — {@link SECURABLE_CHOKEPOINT}
 *      — puts every real call site behind the recorder without touching the
 *      denied file. FIXED: `ucSecurable` is the fifth {@link AUDITED_TRANSPORTS}
 *      entry, so check 1 holds its `finally` to the same brace-accurate standard
 *      as the other four.
 *  13. A FACADE NOBODY MUST USE IS A COMMENT. #12 on its own is a convention:
 *      any module could keep importing the raw functions, and the audit row
 *      would simply not happen — the "audit call that is added but never
 *      reached" failure. FIXED: check 8 (SECURABLE IMPORT CHOKE POINT) makes the
 *      facade the ONLY module allowed to import a UC-mutating symbol from
 *      {@link SECURABLE_RAW}. It is stated as an ALLOWLIST of the two non-catalog
 *      exports ({@link SECURABLE_RAW_PUBLIC}) rather than a denylist of today's
 *      five, because this is the one file in the tree the guard's author cannot
 *      READ: a new un-audited export added to it by someone who does have write
 *      access must be denied by DEFAULT, not by having been anticipated.
 *      {@link securableRawImports} counts namespace and dynamic imports as `*`,
 *      since either hands over every export at once.
 *      The `KNOWN_UNAUDITED` entry is deliberately KEPT: no un-audited call PATH
 *      remains, but the transport is still un-instrumented, and the honest
 *      statement of that is the entry, not its removal.
 *
 * ## LIMITS — what this guard is NOT *
 * READ THIS BEFORE CITING THE GUARD AS COVERAGE. It is a lexical scan over the
 * source tree. It raises the cost of an ACCIDENTAL bypass to "red build" and
 * makes a deliberate one leave a diff a reviewer can see. It is NOT an
 * adversary-proof control and cannot become one:
 *
 *   - a path assembled from enough pieces (`'unity' + '-catalog/'`), built from
 *     a variable, or read from config defeats the address regexes;
 *   - a transport reached through an indirection this file does not name
 *     defeats {@link TRANSPORTS}. The named set covers fetch /
 *     fetchWithTimeout / `new Request` / XHR / axios / node `http(s).request` /
 *     undici dispatchers / a bare `request(` / an import|require|import() of
 *     any HTTP client package — every transport PRESENT in this workspace, plus
 *     the shapes an author would reach for next. A hand-rolled `net.Socket`
 *     that speaks HTTP itself, or a helper in a third file whose own module has
 *     no catalog address, still gets through;
 *   - it proves the recorder is CALLED, never that the row is CORRECT or that
 *     it reached Cosmos;
 *   - and it proves the call is INSIDE the `finally`, never that it is
 *     UNCONDITIONAL. `finally { if (ok) record(…) }` satisfies check 1 while
 *     dropping every denied call — demonstrated, and caught instead by
 *     `lib/azure/__tests__/unity-audit-sql.test.ts` ("records the DENIED row
 *     even though it re-throws"). Guard and spec cover different halves; citing
 *     either alone as coverage is the mistake this section exists to prevent.
 *
 * The un-bypassable half of this control is the transport itself: there is one
 * credential resolver (uc-backend.ts) and two audited transports, and code that
 * does not go through them has to build a credential of its own. The guard is
 * the tripwire on that, not the wall.
 *
 * ## STILL NOT COVERED BY THE TRAIL (declared, not fixed)
 *
 *   - `lib/azure/shortcut-credentials.ts` — its storage-credential +
 *     external-location exits ARE audited as of round 6 (every one is wrapped by
 *     {@link SECURABLE_CHOKEPOINT}, and check 8 makes that the only door), but
 *     the file's own TRANSPORT is still un-instrumented, so it remains in
 *     KNOWN_UNAUDITED. What is genuinely left of #2622 gap 1 is moving the
 *     `try/finally` inside the file, which needs write access to a
 *     credential-path-denied path.
 *   - `lib/azure/iceberg-catalog-client.ts`'s `ircFetch` namespace/table
 *     CREATE + DROP: audited, but into a DIFFERENT trail
 *     (`logIcebergAccess` → `_auditLog itemType:'iceberg-catalog'`), so they do
 *     NOT appear in the system-tables pane. See docs/fiab/unity-gov.md.
 *
 * THE CHECKS
 *   1. TRANSPORT INTEGRITY   — for EVERY entry of {@link AUDITED_TRANSPORTS}:
 *      its recorder is called from inside a `finally` block of its transport
 *      function, and the file imports from lib/azure/unity-audit.
 *   2. OUTBOUND RATCHET      — EVERY file this guard exempts from check 4
 *      (allowlisted OR declared-gap) has a frozen count of outbound TRANSPORT
 *      SITES (OUTBOUND_BASELINE), counted with the SAME {@link TRANSPORTS}
 *      vocabulary check 4 uses. A file exempted without a pin FAILS.
 *   3. (folded into 1.)
 *   4. NO BYPASS             — no file outside the ALLOWLIST may combine a Loom
 *      Unity address OR a Unity Catalog REST path with outbound-request code.
 *      Reading those for a GATE/CAPABILITY check is fine; issuing a REQUEST is not.
 *      Only a `'use client'` component is exempt from the REST-path arm.
 *   5. ALLOWLISTED CALLERS MUST AUDIT.
 *   6. SINK REACHABILITY     — `unity-audit.ts` writes both sinks and still
 *      classifies denials.
 *   7. SQL-EXIT RATCHET      — the raw `executeStatement(` count in EVERY file
 *      pinned by SQL_EXIT_BASELINES must not grow, and a pinned file that
 *      disappears FAILS (see history #3, #8 and #9). Every UC-governance file
 *      is pinned at ZERO; the only permitted exit is `ucSql`'s own.
 *   8. SECURABLE IMPORT CHOKE POINT — only {@link SECURABLE_CHOKEPOINT} may
 *      import a UC-mutating symbol from {@link SECURABLE_RAW} (allowlist:
 *      {@link SECURABLE_RAW_PUBLIC}). This is what makes the facade in history
 *      #12 a control rather than a convention (#13).
 *
 * ALLOWLIST — a file that legitimately needs the catalog address AND makes
 *   requests must be added to CHOKEPOINT_FILES below WITH a justification, and
 *   must itself audit. Adding an entry is a security review, not a formality.
 *
 * MODE:
 *   node scripts/ci/check-unity-audit-chokepoint.mjs
 *
 * NO SHEBANG — DO NOT RE-ADD ONE. This module is `import`ed by
 * `apps/fiab-console/lib/azure/__tests__/unity-audit-guard.test.ts`, and
 * vite-node evaluates an out-of-root `.mjs` through `vm.Script`, which does NOT
 * strip `#!`. With the shebang the whole spec died at COLLECTION with
 * `SyntaxError: Invalid or unexpected token` — so the 14 negative tests that are
 * this item's main deliverable had never executed even once. It is always
 * invoked as `node scripts/ci/…`, so the shebang bought nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');

/** The backend-agnostic catalog client — its ucFetch is the primary choke point. */
export const CHOKEPOINT = 'lib/azure/unity-catalog-client.ts';
/** The Databricks workspace client — its dbxFetch audits the UC REST subset. */
export const DBX_CHOKEPOINT = 'lib/azure/databricks-client.ts';
/** The audited SQL Statement Execution transport — its ucSql records the DDL half. */
export const SQL_CHOKEPOINT = 'lib/azure/uc-sql.ts';
/** The Databricks ACCOUNT-plane client — its acctFetch records metastore assignment. */
export const ACCOUNT_CHOKEPOINT = 'lib/azure/unity-catalog-account-client.ts';
/** The AUDITED facade over the storage-credential / external-location surface. */
export const SECURABLE_CHOKEPOINT = 'lib/azure/uc-securable.ts';
/** The write-denied module whose UC exports the facade above is the only door to. */
export const SECURABLE_RAW = 'lib/azure/shortcut-credentials.ts';
/** The recorder both choke points delegate to. */
export const RECORDER = 'lib/azure/unity-audit.ts';

/**
 * The four audited transports, as `[file, transport function, recorder symbol]`.
 *
 * The integrity check is the SAME brace-accurate `finally` match for all four —
 * pasting a fifth transport in here is what wires it up, so a new choke point
 * cannot be added with a weaker check than the existing ones.
 */
export const AUDITED_TRANSPORTS = [
  {
    file: CHOKEPOINT,
    fn: 'ucFetch',
    recorder: 'recordUnityAccess',
    why:
      'Recording only on the success path drops every DENIED call — the highest-value audit row. '
      + '(A call elsewhere in the file does NOT satisfy this check.)',
  },
  {
    file: DBX_CHOKEPOINT,
    fn: 'dbxFetch',
    recorder: 'recordDatabricksUnityAccess',
    why:
      'Catalog OWNER CHANGE (patchUcCatalog), catalog DELETE (deleteUcCatalog) and GRANT MUTATION '
      + '(updateUcPermissions) issue from this client on the Commercial default backend — without this '
      + 'they reach Unity Catalog UNAUDITED.',
  },
  {
    file: SQL_CHOKEPOINT,
    fn: 'ucSql',
    recorder: 'recordUnitySqlAccess',
    why:
      'The SQL half of the surface carries the governance DDL — GRANT/REVOKE, ABAC CREATE POLICY / '
      + 'DROP POLICY, ALTER … SET MASK / SET ROW FILTER, governed tags, SET TAGS. Before #2622 none of '
      + 'it produced a Loom row. Recording outside the finally would drop exactly the DENIED statements.',
  },
  {
    file: ACCOUNT_CHOKEPOINT,
    fn: 'acctFetch',
    recorder: 'recordUnityAccountAccess',
    why:
      'Metastore ASSIGNMENT is an account-ADMIN mutation deciding which metastore a whole workspace '
      + 'sees. Its path is not a /api/2.x/unity-catalog/** path, so no other choke point can ever see it.',
  },
  {
    file: SECURABLE_CHOKEPOINT,
    fn: 'ucSecurable',
    recorder: 'recordUnitySecurableAccess',
    why:
      'Storage-credential and external-location CREATE/DELETE are the securables that hand a workload '
      + 'access to a storage account — the closest thing in Unity Catalog to minting access. They issue from '
      + `${SECURABLE_RAW}'s OWN private transport, which no other choke point can see and which cannot be `
      + 'instrumented in place (repo-level credential-path write deny), so this facade is the audited door to '
      + 'them. Recording outside the finally would drop exactly the DENIED mint attempts.',
  },
];

/**
 * `executeStatement(` occurrences allowed PER FILE that reaches Unity Catalog
 * over SQL.
 *
 * These are Databricks **SQL Statement Execution** calls, not UC REST. Until
 * #2622 they produced no row in this trail at all, so the ratchet froze the
 * count. They now route through `ucSql` ({@link SQL_CHOKEPOINT}), which records
 * from a `finally`, so every UC-governance file is pinned at ZERO raw exits and
 * the ONE remaining exit is the audited wrapper's own call.
 *
 * Lowering a ceiling is always welcome; raising one requires a security review
 * and a note here — a raw `executeStatement(` in any of these files is an
 * un-audited door to Unity Catalog governance DDL.
 *
 * ## Why this is a Map (round 4)
 *
 * It was a single number scoped to `unity-catalog-client.ts`. Splitting the
 * Databricks system-table readers out of that file (for the `check-file-size`
 * ratchet) carried ONE `executeStatement(` — the shared `runSystemTableRead` —
 * into `uc-system-tables.ts`, where a file-scoped ratchet could not see it. A
 * decomposition that silently narrows a security ratchet is the same defect
 * class as round 4's transport-vocabulary split, so both files are pinned and
 * {@link analyzeUnityChokepoint} FAILS if a pinned file disappears (a rename
 * must not drop its ceiling).
 */
export const SQL_EXIT_BASELINES = new Map([
  // Catalog REST client — the governance DDL (policies, governed tags, setUcTags).
  ['lib/azure/unity-catalog-client.ts', 0],
  // Databricks system-table readers — the shared runSystemTableRead.
  ['lib/azure/uc-system-tables.ts', 0],
  // The UC granular-security wizard (column masks + row filters) — the ABAC
  // CREATE FUNCTION + ALTER TABLE … SET MASK / SET ROW FILTER pair. It was never
  // pinned before #2622 even though it is the same governance-DDL class.
  ['app/api/items/[type]/[id]/security/route.ts', 0],
  // The AUDITED wrapper itself: exactly ONE exit, inside ucSql's try/finally.
  [SQL_CHOKEPOINT, 1],
]);

/** Back-compat scalar: the primary choke point's own ceiling. */
export const SQL_EXIT_BASELINE = SQL_EXIT_BASELINES.get('lib/azure/unity-catalog-client.ts');

/**
 * FROZEN outbound-call count for EVERY file this guard exempts from the
 * no-bypass scan — both the audited allowlist (CHOKEPOINT_FILES) and the
 * declared gaps (KNOWN_UNAUDITED).
 *
 * ## Why this is a Map and not one `DBX_OUTBOUND_BASELINE` constant
 *
 * Round 2 ratcheted exactly one file. Everything else the guard exempted was a
 * WHOLE-FILE exemption with no per-file ceiling, so the claim "a NEW un-audited
 * path fails the build" only held at FILE granularity. A reviewer demonstrated
 * both halves of that hole:
 *
 *   - appending a brand-new unaudited
 *     `fetch(https://${h}/api/2.1/unity-catalog/permissions/table/a.b.c, {method:'PATCH'})`
 *     to `lib/azure/shortcut-credentials.ts` (a DECLARED gap) left the guard at
 *     zero failures — a declared file could grow arbitrary new privilege
 *     mutations silently;
 *   - `MUST_AUDIT` only requires the recorder symbol to appear ONCE anywhere in
 *     the file, so `iceberg-catalog-client.ts` — allowlisted for
 *     `listNamespaceGrants` — had its SECOND outbound call shielded too.
 *
 * Every exempted file now carries its own ceiling. The count may go DOWN freely
 * (routing a call through an audited transport). Raising one is a security
 * review: say in the commit which call was added and why it cannot use
 * `ucFetch` / `dbxFetch`.
 *
 * `analyzeUnityChokepoint` FAILS if an exempted file has no entry here, so a new
 * allowlist/declared-gap entry cannot be added without also pinning its count.
 */
export const OUTBOUND_BASELINE = new Map([
  // The choke point itself: exactly ONE exit, inside ucFetch.
  [CHOKEPOINT, 1],
  // dbxFetch + writeUcVolumesFile + deleteUcVolumesFile (raw-body Files-API
  // writes to /api/2.0/fs/files — not catalog calls).
  [DBX_CHOKEPOINT, 3],
  // The recorder and the backend resolver build no requests at all.
  [RECORDER, 0],
  ['lib/azure/uc-backend.ts', 0],
  // The audited SQL transport delegates to executeStatement — it builds no
  // request of its own, and pinning it at 0 stops it growing one.
  [SQL_CHOKEPOINT, 0],
  // The account plane: exactly ONE exit, inside acctFetch.
  [ACCOUNT_CHOKEPOINT, 1],
  // #2679: the one token-exchange POST to /api/1.0/unity-control/auth/tokens.
  ['lib/azure/uc-token-exchange.ts', 1],
  // The LU-2 anonymous probe + its two sibling probes.
  ['lib/admin/health-probes.ts', 3],
  // dq-monitor's own dbxFetch.
  ['lib/azure/dq-monitor-client.ts', 1],
  // ircFetch + the listNamespaceGrants UC read.
  ['lib/azure/iceberg-catalog-client.ts', 2],
  // DECLARED GAP: its own private ucFetch + one sibling. Its UC exits are now
  // audited at the facade (check 8), but the pin stays so the un-audited
  // TRANSPORT cannot grow new exits (issue #2622).
  [SECURABLE_RAW, 2],
  // NOT pinned: SECURABLE_CHOKEPOINT. It is deliberately NOT exempted from
  // check 4 — it references the two UC REST paths but issues no request of its
  // own (it delegates), so check 4 already fails the build the moment it grows a
  // transport. A pin here would be a ceiling that can never be reached, which
  // reads like coverage and measures nothing.
]);

/**
 * Back-compat alias — `DBX_CHOKEPOINT`'s entry in {@link OUTBOUND_BASELINE}.
 * The Databricks client must be allowlisted from the no-bypass scan (it HOLDS
 * dbxFetch), so this counter is what protects it from the exact bypass
 * demonstrated against the first version of this guard: appending a raw
 * `fetch(https://host/api/2.1/unity-catalog/permissions/...)` to the file.
 */
export const DBX_OUTBOUND_BASELINE = OUTBOUND_BASELINE.get(DBX_CHOKEPOINT);

/**
 * Files permitted to reference a catalog address / UC REST path alongside
 * request-shaped code. Each entry needs a reason; each must remain audited.
 */
export const CHOKEPOINT_FILES = new Map([
  [CHOKEPOINT, 'THE choke point — its single fetchWithTimeout is wrapped by recordUnityAccess in a finally block.'],
  [DBX_CHOKEPOINT, 'The Databricks workspace client. Its dbxFetch finally calls recordDatabricksUnityAccess, which audits the /api/2.x/unity-catalog/** subset (catalog owner change, catalog delete, grant mutation).'],
  [RECORDER, 'The recorder. Writes the audit sinks; issues no catalog requests.'],
  [
    SQL_CHOKEPOINT,
    'THE SQL choke point (#2622 gap 2) — `ucSql` wraps the Databricks SQL Statement Execution transport and '
    + 'records via recordUnitySqlAccess from a finally, so the governance DDL half (GRANT/REVOKE, ABAC '
    + 'CREATE POLICY / DROP POLICY, ALTER … SET MASK / SET ROW FILTER, governed tags, SET TAGS) lands in the '
    + 'same trail as UC REST. It NEVER copies the statement text onto the row: buildCreateConnection emits '
    + 'OPTIONS (password \'…\'), and a mutation row egresses to tenant-registered third-party webhooks.',
  ],
  [
    ACCOUNT_CHOKEPOINT,
    'THE account-plane choke point (#2622 gap 3) — `acctFetch` targets /api/2.0/accounts/{id}, which is NOT a '
    + '/api/2.x/unity-catalog/** path, so no other transport can see it. Metastore ASSIGNMENT is an '
    + 'account-ADMIN mutation deciding which metastore a whole workspace sees; it records via '
    + 'recordUnityAccountAccess from a finally, so the 403 "caller is not an account admin" is recorded too.',
  ],
  ['lib/azure/uc-backend.ts', 'Resolves the backend + base URL + credential. Builds no request of its own.'],
  [
    'lib/azure/uc-token-exchange.ts',
    '#2679: the RFC-8693 exchange that turns the Console UAMI\'s Entra token into the server-minted INTERNAL '
    + 'token upstream AuthDecorator actually accepts (it 403s any other issuer). It CANNOT route through ucFetch: '
    + 'ucFetch calls ossUcAuthHeader(), which calls this — the dependency is circular by construction. It targets '
    + '/api/1.0/unity-control/auth/tokens, not the catalog surface, so it reads and mutates no securable. It '
    + 'records its own row via recordExchange() on ALL FOUR outcomes (unreachable / rejected / non-JSON / '
    + 'no-access_token) plus success, mirroring probe-loom-unity-authz. 401/403 is logged as `denied` — the '
    + 'catalog refusing this principal — and everything else as `failure`.',
  ],
  [
    'lib/admin/health-probes.ts',
    'probe-loom-unity-authz (LU-2) sends ONE deliberately UNAUTHENTICATED read to prove the catalog rejects '
    + 'anonymous callers — routing it through the credentialed ucFetch would defeat the test. It records its own '
    + 'audit row via recordUnityAuthzProbe(), which is asserted below.',
  ],
  [
    'lib/azure/dq-monitor-client.ts',
    'Lakehouse Monitoring keeps its own Databricks transport (it predates the shared one). Two of its calls are '
    + 'UC REST reads (tables/schemas get) used to resolve a monitored table; its dbxFetch finally now records them '
    + 'via recordDatabricksUnityAccess, which ignores the quality-monitor paths.',
  ],
  [
    'lib/azure/iceberg-catalog-client.ts',
    'listNamespaceGrants issues a REAL UC grant read (GET /api/2.1/unity-catalog/permissions/schema/{full}) against '
    + 'the IRC server with the Iceberg auth header — it cannot use the Databricks-credentialed ucFetch. It records '
    + 'its own row via recordDatabricksUnityAccess on both the success and the unreachable path.',
  ],
]);

/**
 * Files in CHOKEPOINT_FILES that call the catalog (rather than merely resolving
 * its address) must still produce an audit row. Symbol each one must contain.
 */
export const MUST_AUDIT = new Map([
  ['lib/admin/health-probes.ts', 'recordUnityAccess'],
  [DBX_CHOKEPOINT, 'recordDatabricksUnityAccess'],
  [SQL_CHOKEPOINT, 'recordUnitySqlAccess'],
  [ACCOUNT_CHOKEPOINT, 'recordUnityAccountAccess'],
  ['lib/azure/dq-monitor-client.ts', 'recordDatabricksUnityAccess'],
  ['lib/azure/iceberg-catalog-client.ts', 'recordDatabricksUnityAccess'],
]);

/**
 * KNOWN, DECLARED GAPS — files that reach Unity Catalog outside an audited
 * transport and are NOT yet fixed. This list exists so the hole is LOUD instead
 * of invisible: the guard prints every entry on a passing run, and FAILS if a
 * file joins the list without being declared here (the ratchet). It is not an
 * excuse list — every entry names the issue tracking its removal.
 *
 * An entry here is strictly worse than an entry in CHOKEPOINT_FILES. Removing
 * one (by adding the recorder) is always in scope.
 */
export const KNOWN_UNAUDITED = new Map([
  [
    SECURABLE_RAW,
    'Its own private ucFetch issues storage-credential + external-location CREATE/DELETE '
    + '(POST/DELETE /api/2.1/unity-catalog/storage-credentials|external-locations). The file sits under a '
    + 'repo-level credential-path read/write deny, so the recorder could NOT be added inside it. '
    + 'STATUS (#2622 round 6): those exits ARE now audited — every one of them is wrapped by '
    + `${SECURABLE_CHOKEPOINT}'s ucSecurable, and check 8 makes that facade the ONLY module permitted to import a `
    + 'UC-mutating symbol from here, so no un-audited call path remains. This entry stays because the TRANSPORT '
    + 'itself is still un-instrumented: a future export added inside this file could reach the catalog without a '
    + 'row of its own. Removing the entry requires the try/finally to move INTO the file. TRACKED: issue #2622.',
  ],
]);

/** Directories scanned for bypasses. */
const SCAN_DIRS = [
  path.join(APP_ROOT, 'lib'),
  path.join(APP_ROOT, 'app'),
  path.join(APP_ROOT, 'scripts'),
];

/**
 * A catalog address appearing in a file — the OSS / Loom Unity address. Applies
 * to EVERY scanned file.
 */
export const UNITY_ADDRESS_RE = /\bLOOM_UNITY_URL\b|\bossUcBase\s*\(/;
/**
 * The Unity Catalog REST families this API exposes — the second arm of
 * {@link UNITY_REST_PATH_RE} requires one of these directly after
 * `unity-catalog/`, so a Microsoft Learn documentation URL
 * (`.../unity-catalog/manage-privileges/`) is not mistaken for an API path.
 */
const UC_FAMILY = '(?:permissions|effective-permissions|catalogs|schemas|tables|volumes|functions'
  + '|models|registered-models|external-locations|storage-credentials|credentials|metastores'
  + '|shares|recipients|providers|connections|bindings|workspace-bindings|policies|securable-tags'
  + '|temporary-(?:table|path|volume)-credentials|online-tables|clean-rooms)';

/**
 * A Unity Catalog REST path literal — the Databricks side. Without this arm, a
 * hand-rolled `PATCH /api/2.1/unity-catalog/permissions/...` granting
 * ALL_PRIVILEGES on the Commercial default backend was invisible to the guard.
 *
 * TWO arms, because round 2 shipped only the first and a reviewer defeated it by
 * splitting the literal (`'/api/2.1/' + 'unity-catalog/permissions/...'`):
 *   (a) the whole versioned prefix, and
 *   (b) `unity-catalog/<uc-family>` (or `lineage-tracking/`) on its own, which
 *       survives that particular concatenation.
 * See LIMITS in the header: (b) narrows the crack, it does not close it.
 */
export const UNITY_REST_PATH_RE = new RegExp(
  '\\/api\\/2\\.\\d+\\/unity-catalog\\/'
  + '|\\/api\\/2\\.\\d+\\/lineage-tracking\\/'
  + `|\\bunity-catalog\\/${UC_FAMILY}\\b`
  + '|\\blineage-tracking\\/(?:table|column)-lineage\\b',
);

/**
 * THE TRANSPORT VOCABULARY — ONE definition, TWO consumers.
 *
 * ## Why this is a single exported list and not two regexes
 *
 * Round 3 shipped a broad {@link REQUEST_RE} for the no-bypass scan (check 4)
 * and a SEPARATE, two-shape `countOutbound()` (`fetchWithTimeout(` and a bare
 * `fetch(`) for the per-file ratchet (check 2). Check 4 SKIPS every exempted
 * file, so on the allowlist and on the declared gaps the ratchet is the ONLY
 * control — and it was measuring a strictly narrower thing than the scan that
 * had been waived. Three transports walked straight through it:
 *
 *   - `import { request as r } from 'undici'` + a `PATCH …/unity-catalog/
 *     permissions/table/…` appended to `databricks-client.ts` (allowlisted,
 *     ratchet 3) — outbound count stayed 3, guard exited 0;
 *   - `https.request({ path: '/api/2.1/unity-catalog/permissions/…' })` in the
 *     same file — same result;
 *   - `axios.post('…/unity-catalog/storage-credentials')` appended to
 *     `shortcut-credentials.ts` (a DECLARED gap, ratchet 2) — same result.
 *
 * All three are now regression tests (`unity-audit-guard.test.ts` #15–#18).
 *
 * The instance fix would have been to paste the extra shapes into
 * `countOutbound`. The CLASS fix is that the two consumers must not be able to
 * disagree at all: both are derived from this list, so a transport the scan
 * knows about is a transport the ratchet counts, by construction. The
 * `TRANSPORT VOCABULARY — one definition, two consumers` spec proves the
 * invariant per entry, and every entry carries a `sample` so the invariant is
 * checkable for anything added later.
 *
 * `scope`:
 *   'code'   — matched against source with comments AND string bodies masked,
 *              so a URL in a doc comment is not a call.
 *   'module' — an import/require/dynamic-import SPECIFIER, so it must be
 *              matched with string bodies INTACT (comments still masked). The
 *              import alone counts: the local binding can always be renamed
 *              (`request as r`), but the module name cannot be.
 */
export const TRANSPORTS = [
  { id: 'fetchWithTimeout', scope: 'code', re: /\bfetchWithTimeout\s*\(/, sample: "await fetchWithTimeout(url, { method: 'PATCH' });" },
  { id: 'bare-fetch', scope: 'code', re: /(?<![.\w])fetch\s*\(/, sample: 'await fetch(url);' },
  { id: 'new-Request', scope: 'code', re: /\bnew\s+Request\s*\(/, sample: 'const r = new Request(url);' },
  { id: 'xhr', scope: 'code', re: /\bXMLHttpRequest\b/, sample: 'const x = new XMLHttpRequest();' },
  { id: 'axios', scope: 'code', re: /\baxios\b/, sample: 'await axios.post(url, body);' },
  { id: 'node-http-request', scope: 'code', re: /\bhttps?\.request\s*\(/, sample: 'https.request(opts).end();' },
  { id: 'undici-dispatcher', scope: 'code', re: /\bnew\s+(?:undici\.)?(?:Client|Pool|Agent|ProxyAgent)\s*\(/, sample: 'const p = new undici.Pool(host);' },
  // A bare `request(…)` call — how undici/got/needle read after a destructure
  // or a rename. Method calls (`x.request(`) and longer identifiers
  // (`onRequest(`, `NextRequest(`) are excluded by the lookbehind + case.
  { id: 'bare-request-call', scope: 'code', re: /(?<![.\w])request\s*\(/, sample: 'await request(url, { method: "PATCH" });' },
  {
    id: 'http-module-specifier',
    scope: 'module',
    re: /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"](?:undici|node-fetch|got|ky|superagent|node:https?|https?|cross-fetch|phin|needle|axios)['"]/,
    sample: "import { request as r } from 'undici';",
  },
];

/**
 * Request-shaped code — the union of {@link TRANSPORTS}. Kept exported because
 * it names the whole vocabulary in one place; prefer {@link hasTransport},
 * which applies each arm to the haystack it belongs to.
 */
export const REQUEST_RE = new RegExp(TRANSPORTS.map((t) => t.re.source).join('|'));

/**
 * TRUE when the file contains outbound-transport CODE.
 *
 * Same vocabulary and same haystack rules as {@link countOutbound} — code
 * shapes read against comments+strings-masked source, module specifiers
 * against comments-masked source. Matching the code arms against masked source
 * (round 3 tested the union against RAW text) drops the prose false positives
 * — `env-checks/data-plane.ts` says "present a valid token on the request (in
 * addition to a session)" in a remediation string — without dropping any real
 * call, because a transport call is always code.
 */
export function hasTransport(src) {
  const haystacks = { code: maskCommentsAndStrings(src), module: maskComments(src) };
  return TRANSPORTS.some((t) => t.re.test(haystacks[t.scope]));
}

/**
 * TRUE for a Next.js CLIENT component (`'use client'`) — the one kind of file
 * that can legitimately reference a UC REST path without being able to call it.
 * It holds no Databricks/Entra credential and its `fetch` goes to the Loom BFF
 * (governed by check-no-bare-client-fetch), but it legitimately PRINTS these
 * paths as documentation: the UC dialogs tell the operator which REST call each
 * action makes and which privilege it needs.
 *
 * Round 2 keyed this exemption off the `.tsx` EXTENSION, which was wrong: in the
 * App Router a `.tsx` WITHOUT `'use client'` is a SERVER component running in
 * the Node runtime with full credential access. A reviewer proved it by turning
 * app/admin/rogue/page.tsx into an async server component that PATCHed
 * `/api/2.1/unity-catalog/permissions/table/a.b.c` — the guard exited 0.
 */
export function isClientComponent(src) {
  // The directive must be the first statement. Mask first so a license/doc
  // comment mentioning "use client" cannot satisfy it; the mask preserves both
  // offsets and the quote characters, so the directive is then read from the
  // ORIGINAL bytes at the same index.
  const masked = maskCommentsAndStrings(src);
  const firstCode = masked.search(/\S/);
  if (firstCode < 0) return false;
  return /^(['"])use client\1\s*;?/.test(src.slice(firstCode));
}

/**
 * True when the file names the catalog in a way that could address a request.
 *
 * ## Why the client-component test comes LAST
 *
 * The three conditions are ordered by COST, not by narrative. `isClientComponent`
 * masks the whole file — `maskSource` does `src.split('')`, so it allocates one
 * single-character string per byte — purely to read the first non-whitespace
 * token. Check 4 calls this for EVERY file in the tree, and only 69 of ~5,345
 * reference the catalog at all, so asking the expensive question first meant
 * masking ~55 MB of source to answer a question about 69 files.
 *
 * The two orders are equivalent, exhaustively:
 *
 *   ADDRESS  PATH  client │ before  after
 *   ─────────────────────────────────────
 *      T      -      -    │  true    true    (first arm, unchanged)
 *      F      T      T    │  false   false   (client exemption still applies)
 *      F      T      F    │  true    true
 *      F      F      T    │  false   false
 *      F      F      F    │  false   false
 *
 * That is not merely asserted-about: the guard's own spec keeps `#4 — fails on a
 * .tsx SERVER component` (the F/T/F row) and `#4 — but does NOT fire on a real
 * 'use client' component` (the F/T/T row), which are the only two rows the
 * reorder could possibly have changed. Both still pass.
 *
 * Measured effect on ONE whole-tree scan: check 4 went ~1.5 s -> ~0.16 s. That
 * matters beyond tidiness — see the note on the guard's spec: the spec runs 31
 * whole-tree scans and vitest's bundled birpc fails the WHOLE RUN if a worker
 * blocks its own event loop past the 60 s `onTaskUpdate` reply deadline (#2944).
 */
export function referencesCatalogAddress(rel, src) {
  if (UNITY_ADDRESS_RE.test(src)) return true;
  // Cheap raw-source regex first: no match here means no path arm can fire, so
  // the client-component exemption cannot change the answer.
  if (!UNITY_REST_PATH_RE.test(src)) return false;
  return !isClientComponent(src);
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 8 — the SECURABLE IMPORT CHOKE POINT (#2622 gap 1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exports of {@link SECURABLE_RAW} that any module may import: the two that do
 * NOT touch Unity Catalog. `getKeyVaultSecret` reads a Key Vault secret and
 * `keyVaultConfigGate` is a pure env check; both are consumed directly by the
 * lakehouse-shortcut routes.
 *
 * ## Why this is an ALLOWLIST of the harmless two, not a denylist of the five
 *
 * A denylist (`ensureUcAwsStorageCredential`, `ensureUcGcpStorageCredential`,
 * `ensureUcExternalLocation`, `deleteUcExternalLocation`,
 * `deleteUcStorageCredential`) would be exactly as strong as the guard author's
 * memory on the day it was written, and this is the one file in the tree the
 * guard's author CANNOT READ — it is covered by a repo-level credential-path
 * read/write deny. A new un-audited UC export could be added to it (by someone
 * who does have write access) and consumed anywhere, and a denylist would say
 * nothing. Stated in the affirmative, the default for anything new is DENIED:
 * either it is not a catalog call and belongs on this list after a review, or it
 * is, and it belongs behind {@link SECURABLE_CHOKEPOINT}.
 *
 * This is the same lesson as history #10 — "the scan found nothing" is not
 * "there is nothing" when the vocabulary cannot express the surface — applied to
 * a file whose surface cannot be read at all.
 */
export const SECURABLE_RAW_PUBLIC = new Set(['getKeyVaultSecret', 'keyVaultConfigGate']);

/**
 * The module BASENAME every specifier that resolves to {@link SECURABLE_RAW}
 * must contain. DERIVED from {@link SECURABLE_RAW} rather than re-typed, so the
 * specifier pattern below and the cheap pre-filter in
 * {@link securableRawImports} have ONE definition and cannot drift apart — the
 * same rule this file applies to {@link TRANSPORTS}. Renaming the raw module
 * therefore moves both at once.
 */
const SECURABLE_RAW_BASENAME = path.basename(SECURABLE_RAW, '.ts');

/** Module specifiers that resolve to {@link SECURABLE_RAW}. */
const SECURABLE_RAW_SPECIFIER =
  `(?:@/lib/azure/${SECURABLE_RAW_BASENAME}|(?:\\.{1,2}/)+${SECURABLE_RAW_BASENAME})`;

/**
 * Every binding a file imports from {@link SECURABLE_RAW}.
 *
 * Returns `['*']` for a namespace or dynamic import, because both hand the
 * importer EVERY export including the un-audited ones — a `import * as creds`
 * would otherwise be a one-token bypass of the named-import scan.
 *
 * Read against comments-masked source with STRING BODIES INTACT (the specifier
 * only exists inside a string), so a doc comment naming the module is not an
 * import. Exported for the guard's own spec.
 *
 * ## Why the pre-filter is safe (#2944)
 *
 * Check 8 runs this over EVERY file in the tree, and 14 of ~5,345 import from
 * that module — so ~5,331 files were paying a full {@link maskComments} pass
 * (one single-character string allocated per source byte) to be told `[]`.
 *
 * Skipping the mask when the RAW source does not contain the basename cannot
 * change any answer, because {@link maskSource} only ever REPLACES characters
 * with spaces; it never inserts one. So a substring absent from `src` is absent
 * from `maskComments(src)` too, and every pattern below embeds
 * {@link SECURABLE_RAW_SPECIFIER}, which embeds the basename — no match was
 * reachable. Proven empirically as well: identical output on all 5,345 real
 * files plus 21 synthetic payloads (renamed / namespace / dynamic / require /
 * type-only / in-comment / look-alike-module / empty).
 *
 * Measured: check 8 over one whole-tree scan, ~1.8 s -> ~0.03 s.
 */
export function securableRawImports(src) {
  if (!src.includes(SECURABLE_RAW_BASENAME)) return [];
  const masked = maskComments(src);
  const names = [];

  const namespaceRe = new RegExp(`\\bimport\\s+\\*\\s+as\\s+\\w+\\s+from\\s*['"]${SECURABLE_RAW_SPECIFIER}['"]`);
  const dynamicRe = new RegExp(`(?:\\bimport\\s*\\(|\\brequire\\s*\\()\\s*['"]${SECURABLE_RAW_SPECIFIER}['"]`);
  if (namespaceRe.test(masked) || dynamicRe.test(masked)) names.push('*');

  const namedRe = new RegExp(
    `\\bimport\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*['"]${SECURABLE_RAW_SPECIFIER}['"]`,
    'g',
  );
  let m;
  while ((m = namedRe.exec(masked)) !== null) {
    for (const raw of m[1].split(',')) {
      // `foo as bar` / `type foo` — the EXPORTED name is what matters, and a
      // rename is exactly how an author would try to slip one past a name scan.
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

// ─────────────────────────────────────────────────────────────────────────────
// Source analysis — brace-accurate, comment/string aware. Exported so the guard
// itself is unit-testable against synthetic bypasses (see
// apps/fiab-console/lib/azure/__tests__/unity-audit-guard.test.ts).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replace comments — and, when `strings` is true, string/template literal
 * BODIES — with spaces of the SAME length, so brace matching cannot be fooled
 * by a `{` in a doc comment or a template string, while every index still maps
 * 1:1 onto the original source. String delimiters are always preserved, so a
 * specifier match like `from '…'` still has its quotes.
 */
export function maskSource(src, { strings = true } = {}) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (from, to) => { for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' '; };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { let j = i; while (j < n && src[j] !== '\n') j++; blank(i, j); i = j; continue; }
    if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); const end = j < 0 ? n : j + 2; blank(i, end); i = end; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      if (strings) blank(i + 1, j);
      i = j + 1; continue;
    }
    i++;
  }
  return out.join('');
}

/** Comments AND string bodies blanked — the haystack for code-shaped patterns. */
export function maskCommentsAndStrings(src) { return maskSource(src, { strings: true }); }

/**
 * Comments blanked, string bodies INTACT — the haystack for module specifiers.
 * A doc comment saying `from 'undici'` must not count as an import, but the
 * real import must, and its module name only exists inside a string.
 */
export function maskComments(src) { return maskSource(src, { strings: false }); }

/** Index of the `}` matching the `{` at `open` in `masked`. -1 when unbalanced. */
function matchBrace(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** `{ start, end }` of the body of `function <name>` — or null when absent. */
export function functionBodyRange(masked, name) {
  const re = new RegExp(`\\bfunction\\s+${name}\\s*[<(]`);
  const m = re.exec(masked);
  if (!m) return null;
  // Skip PAST the parameter list before looking for the body brace: a parameter
  // typed with an inline object literal (`init?: { method?: 'GET' }`) would
  // otherwise be mistaken for the function body.
  let i = m.index;
  let depth = 0;
  let seenParen = false;
  for (; i < masked.length; i++) {
    if (masked[i] === '(') { depth++; seenParen = true; }
    else if (masked[i] === ')') { depth--; if (seenParen && depth === 0) { i++; break; } }
  }
  const open = masked.indexOf('{', i);
  if (open < 0) return null;
  const close = matchBrace(masked, open);
  if (close < 0) return null;
  return { start: open, end: close };
}

/**
 * TRUE when `symbol(` is CALLED from inside a `finally { … }` block belonging to
 * `fnName`. This is the check the original guard only approximated with a
 * substring scan — the approximation passed a gutted finally with a decoy call
 * elsewhere in the file.
 */
export function callsSymbolInFinallyOf(src, fnName, symbol) {
  const masked = maskCommentsAndStrings(src);
  const body = functionBodyRange(masked, fnName);
  if (!body) return false;
  const region = masked.slice(body.start, body.end + 1);
  const finallyRe = /\bfinally\s*\{/g;
  const callRe = new RegExp(`\\b${symbol}\\s*\\(`);
  let m;
  while ((m = finallyRe.exec(region))) {
    const open = region.indexOf('{', m.index);
    const close = matchBrace(region, open);
    if (close < 0) continue;
    // Test against the MASKED text: a mention inside a comment or string is not
    // a call. Whitespace is preserved by the mask, so `foo (` still matches.
    if (callRe.test(region.slice(open, close + 1))) return true;
  }
  return false;
}

/** Count occurrences of `symbol(` in real code (comments/strings masked out). */
export function countCalls(src, symbol) {
  const masked = maskCommentsAndStrings(src);
  return (masked.match(new RegExp(`\\b${symbol}\\s*\\(`, 'g')) || []).length;
}

/**
 * Outbound TRANSPORT SITES in real code — every construct in
 * {@link TRANSPORTS}, not just `fetch`.
 *
 * This is the per-file ceiling for the files check 4 waives, so it must
 * recognise everything check 4 would have caught. It does, by construction:
 * both read the same vocabulary. See the TRANSPORTS docstring for the three
 * bypasses that existed while this function had its own two-shape regex.
 *
 * De-duplicated per (scope, index) so two alternatives matching the same site
 * count once — the number in {@link OUTBOUND_BASELINE} stays readable.
 */
export function countOutbound(src) {
  const haystacks = { code: maskCommentsAndStrings(src), module: maskComments(src) };
  const seen = new Set();
  for (const t of TRANSPORTS) {
    const hay = haystacks[t.scope];
    const re = new RegExp(t.re.source, 'g');
    let m;
    while ((m = re.exec(hay)) !== null) {
      seen.add(`${t.scope}:${m.index}`);
      if (m.index === re.lastIndex) re.lastIndex++; // zero-width safety
    }
  }
  return seen.size;
}

/**
 * The whole rule set, as a pure function over `{ relPath -> source }`.
 * Returns an array of failure strings (empty === pass).
 */
export function analyzeUnityChokepoint(sources, opts = {}) {
  const sqlBaselines = new Map(SQL_EXIT_BASELINES);
  if (opts.sqlExitBaselines) for (const [k, v] of opts.sqlExitBaselines) sqlBaselines.set(k, v);
  // Back-compat: callers that only override the primary choke point's ceiling.
  if (opts.sqlExitBaseline != null) sqlBaselines.set(CHOKEPOINT, opts.sqlExitBaseline);
  const outboundBaseline = new Map(OUTBOUND_BASELINE);
  if (opts.outboundBaseline) for (const [k, v] of opts.outboundBaseline) outboundBaseline.set(k, v);
  // Back-compat: callers that only override the Databricks ceiling.
  if (opts.dbxOutboundBaseline != null) outboundBaseline.set(DBX_CHOKEPOINT, opts.dbxOutboundBaseline);
  const failures = [];

  // ── 1. THE AUDITED TRANSPORTS ─────────────────────────────────────────────
  // Same brace-accurate `finally` match for all four, driven off one table, so a
  // choke point cannot be added with a weaker check than its siblings.
  for (const t of AUDITED_TRANSPORTS) {
    const src = sources.get(t.file);
    if (src == null) {
      failures.push(
        `MISSING CHOKE POINT: ${t.file} does not exist. Its ${t.fn} is the audited transport for its half of `
        + `the Unity Catalog surface.`,
      );
      continue;
    }
    if (!/from\s+['"](?:@\/lib\/azure\/unity-audit|\.\/unity-audit)['"]/.test(src)) {
      failures.push(`${t.file}: does not import from lib/azure/unity-audit — the audit choke point has been disconnected.`);
    }
    if (!callsSymbolInFinallyOf(src, t.fn, t.recorder)) {
      failures.push(`${t.file}: ${t.recorder}( is not called from inside a \`finally\` block of ${t.fn}. ${t.why}`);
    }
  }

  // ── 7. SQL-EXIT RATCHET, per pinned file ──────────────────────────────────
  // Pinned per FILE, not once for the choke point: splitting the system-table
  // readers out of unity-catalog-client.ts carried one executeStatement( with
  // them, and a file-scoped ratchet stopped seeing it. A pinned file that
  // disappears FAILS, so a rename cannot drop a ceiling either.
  for (const [rel, base] of sqlBaselines) {
    const src = sources.get(rel);
    if (src == null) {
      failures.push(
        `${rel}: pinned in SQL_EXIT_BASELINES but not present. If it was renamed or merged away, move its ceiling to the ` +
        `new path in the same commit — a vanished pin silently un-ratchets its SQL exits.`,
      );
      continue;
    }
    const sqlExits = countCalls(src, 'executeStatement');
    if (sqlExits > base) {
      failures.push(
        `${rel}: ${sqlExits} raw executeStatement( exits (ratchet: ${base}). A raw call reaches Unity Catalog over ` +
        `the Databricks SQL Statement Execution API OUTSIDE the audited transport, so it produces NO row in the Loom ` +
        `Unity trail — that is exactly the hole #2622 closed. Call ucSql( from ${SQL_CHOKEPOINT} instead (same ` +
        `signature, plus an optional { target } for the securable). If it genuinely must be the raw transport, raise ` +
        `this file's SQL_EXIT_BASELINES entry with a security-review note. The count may go DOWN freely.`,
      );
    }
  }

  // ── 3. (folded into check 1 — AUDITED_TRANSPORTS covers dbxFetch, ucSql and
  //        acctFetch with the same brace-accurate finally match as ucFetch.)

  // ── 2. PER-FILE OUTBOUND RATCHET on every exempted file ───────────────────
  // Applies to the audited allowlist AND the declared gaps. Without it an
  // exemption is a whole-FILE hole: the file can grow arbitrary new un-audited
  // catalog exits and nothing fails. See OUTBOUND_BASELINE.
  for (const r of [...CHOKEPOINT_FILES.keys(), ...KNOWN_UNAUDITED.keys()]) {
    const src = sources.get(r);
    if (src == null) continue; // absence is reported by checks 4b / 5
    const base = outboundBaseline.get(r);
    if (base == null) {
      failures.push(
        `${r}: exempted from the no-bypass scan but has no OUTBOUND_BASELINE entry. Every exempted file must pin its ` +
        `outbound-call count, otherwise the exemption lets it grow new un-audited catalog exits silently.`,
      );
      continue;
    }
    const outbound = countOutbound(src);
    if (outbound > base) {
      failures.push(
        `${r}: ${outbound} outbound calls (ratchet: ${base}). This file is exempted from the no-bypass scan, so a new ` +
        `raw request here is an un-audited door to Unity Catalog. Route it through ucFetch (${CHOKEPOINT}) or dbxFetch ` +
        `(${DBX_CHOKEPOINT}), or raise this file's OUTBOUND_BASELINE with a security-review note. ` +
        `("Outbound" = any TRANSPORTS site — fetch, undici/axios/got, node http(s).request, XHR, or an import of an ` +
        `HTTP client — not just fetch(.)`,
      );
    }
  }

  // ── 4. NO BYPASS ──────────────────────────────────────────────────────────
  for (const [r, src] of sources) {
    if (CHOKEPOINT_FILES.has(r)) continue;
    if (isTestFile(r)) continue; // specs legitimately stub URLs + fetch
    if (!referencesCatalogAddress(r, src)) continue;
    if (!hasTransport(src)) continue; // env read for a gate/capability check — fine
    if (KNOWN_UNAUDITED.has(r)) continue; // declared gap — reported, not silent
    failures.push(
      `${r}: references a Unity Catalog address or REST path (LOOM_UNITY_URL / ossUcBase() / /api/2.x/unity-catalog/) ` +
      `AND issues outbound requests. Every catalog call must go through ucFetch (${CHOKEPOINT}) or dbxFetch ` +
      `(${DBX_CHOKEPOINT}) so it lands in _auditLog + LoomAudit_CL. If this file genuinely must call the catalog, add ` +
      `it to CHOKEPOINT_FILES in this guard with a justification AND make it record an audit row.`,
    );
  }

  // ── 4b. DECLARED GAPS MUST STILL EXIST ────────────────────────────────────
  // A stale entry would silently re-open the allowlist for a file that has since
  // been fixed or deleted, so the list is kept exact in both directions.
  for (const [file] of KNOWN_UNAUDITED) {
    if (!sources.has(file)) {
      failures.push(`${file}: listed in KNOWN_UNAUDITED but not present — remove the entry (the gap is closed).`);
    }
  }

  // ── 5. ALLOWLISTED CALLERS MUST STILL AUDIT ───────────────────────────────
  for (const [file, symbol] of MUST_AUDIT) {
    const src = sources.get(file);
    if (src == null) {
      failures.push(`${file}: allowlisted in CHOKEPOINT_FILES but missing — drop the entry or restore the file.`);
      continue;
    }
    if (!countCalls(src, symbol)) {
      failures.push(
        `${file}: allowlisted to call the catalog outside ucFetch but no longer calls ${symbol}( — ` +
        `its catalog access would be UNAUDITED. Restore the audit call or remove the allowlist entry.`,
      );
    }
  }

  // ── 8. SECURABLE IMPORT CHOKE POINT (#2622 gap 1) ─────────────────────────
  // `shortcut-credentials.ts` cannot be instrumented in place (credential-path
  // write deny), so the audit lives in a FACADE. A facade nobody is obliged to
  // use is a comment — this is what obliges them. Stated as an allowlist of the
  // two non-catalog exports, so a NEW un-audited export added to that file
  // (which this guard's author cannot even read) is denied by DEFAULT.
  if (sources.has(SECURABLE_RAW) && !sources.has(SECURABLE_CHOKEPOINT)) {
    failures.push(
      `MISSING CHOKE POINT: ${SECURABLE_CHOKEPOINT} does not exist, but ${SECURABLE_RAW} does. Its ucSecurable is the `
      + `only audited door to the storage-credential + external-location surface.`,
    );
  }
  for (const [r, src] of sources) {
    if (r === SECURABLE_CHOKEPOINT) continue; // THE facade — the one permitted importer
    if (isTestFile(r)) continue; // specs legitimately vi.mock the raw module
    for (const name of securableRawImports(src)) {
      if (SECURABLE_RAW_PUBLIC.has(name)) continue;
      failures.push(
        `${r}: imports \`${name}\` from ${SECURABLE_RAW}. That module writes NO Loom audit row — its private `
        + `transport issues storage-credential + external-location CREATE/DELETE, the securables that hand a workload `
        + `access to a storage account. Import it from ${SECURABLE_CHOKEPOINT} instead (same signature, audited via `
        + `recordUnitySecurableAccess from a finally). If \`${name}\` genuinely does not touch Unity Catalog, add it to `
        + `SECURABLE_RAW_PUBLIC in this guard — that is a security review, not a formality.`
        + (name === '*'
          ? ' (A namespace or dynamic import hands over EVERY export, so it can never be allowlisted by name.)'
          : ''),
      );
    }
  }

  // ── 6. SINK REACHABILITY ──────────────────────────────────────────────────
  const recSrc = sources.get(RECORDER);
  if (recSrc == null) {
    failures.push(`MISSING RECORDER: ${RECORDER} does not exist.`);
  } else {
    for (const [symbol, label] of [
      ['auditLogContainer', 'the Cosmos `_auditLog` trail'],
      ['emitAuditEvent', 'the `LoomAudit_CL` SIEM stream'],
    ]) {
      if (!recSrc.includes(symbol)) {
        failures.push(`${RECORDER}: no ${symbol} usage — ${label} is no longer written. LU-3 requires BOTH sinks.`);
      }
    }
    if (!/'denied'/.test(recSrc)) {
      failures.push(`${RECORDER}: the 'denied' outcome is gone. A denied access attempt is the single most valuable audit row.`);
    }
  }

  return failures;
}

export function isTestFile(rel) {
  return /(^|[\\/])__tests__[\\/]/.test(rel) || /\.(test|spec)\.(ts|tsx)$/.test(rel);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function isSourceFile(f) {
  if (!/\.(ts|tsx|mjs)$/.test(f)) return false;
  if (/\.d\.ts$/.test(f)) return false;
  return true;
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.next' || e.name === 'dist') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (isSourceFile(e.name)) out.push(full);
  }
  return out;
}

/**
 * Every source file the guard analyses, read from the REAL tree.
 *
 * EXPORTED so the guard's own spec can run check 4 (the no-bypass scan) across
 * `lib/` + `app/` + `scripts/` instead of a hand-listed handful. Round 2's spec
 * loaded 8 files by name and asserted "passes on the shipped sources", which
 * could not fail on a bypass anywhere else in the tree — a mislabelled
 * assertion, and exactly the kind of false assurance this item exists to stop.
 */
export function readSources() {
  const rel = (abs) => path.relative(APP_ROOT, abs).split(path.sep).join('/');
  const sources = new Map();
  for (const dir of SCAN_DIRS) {
    for (const abs of walk(dir)) sources.set(rel(abs), fs.readFileSync(abs, 'utf8'));
  }
  return sources;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const failures = analyzeUnityChokepoint(readSources());
  if (failures.length) {
    console.error('\n✗ unity-audit-chokepoint FAILED\n');
    for (const f of failures) console.error(`  - ${f}`);
    console.error(
      '\nWhy this rule: an audit trail with a hole in it is worse than no trail, because it is trusted.\n' +
      'See apps/fiab-console/lib/azure/unity-audit.ts and PRPs/active/loom-apex/research/loom-unity.md (LU-3).\n',
    );
    process.exit(1);
  }
  console.log(
    `✓ unity-audit-chokepoint: all ${AUDITED_TRANSPORTS.length} audited transports `
    + `(${AUDITED_TRANSPORTS.map((t) => t.fn).join(', ')}) record from a finally, `
    + 'no bypass, sinks reachable, raw SQL exits ratcheted.',
  );
  if (KNOWN_UNAUDITED.size) {
    console.log(`\n  ! ${KNOWN_UNAUDITED.size} DECLARED, UN-AUDITED catalog path(s) remain — the trail is NOT complete:`);
    for (const [file, why] of KNOWN_UNAUDITED) console.log(`      - ${file}: ${why}`);
    console.log('    These are ratcheted: a NEW un-audited path fails the build.\n');
  }
}
