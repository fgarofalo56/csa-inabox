#!/usr/bin/env node
/**
 * GUARDRAIL: file-size / monolith-creep  (merge-blocker, RATCHETING)  — WS-E E3
 * ------------------------------------------------------------------------
 * RULE (remediation WS-E — Monolith Decomposition / Maintainability): multiple
 *   3k–5k+ LOC editors impede maintainability. There is no preventive guard
 *   against files growing monolithic again. This guard adds one.
 *
 * WHAT IT DOES (ratchet, not full-clean — same shape as check-no-raw-px):
 *   Scans git-tracked `.ts` / `.tsx` source under apps/fiab-console/{lib,app}
 *   (excluding tests, generated .d.ts, .next, node_modules) and measures LOC.
 *
 *   Three signals:
 *     • WARN_THRESHOLD (1500 LOC) — a file above this is "large". Large files
 *       are ADVISORY (printed) and only BLOCK when NEW (see FAIL rule 1).
 *     • Ratchet ceiling (per-file, in ALLOWLIST) — every file already above the
 *       warn line today is frozen at its current LOC. A file entering the
 *       allowlist for the first time is rounded up to the next 100 for a little
 *       churn slack (a file landing exactly ON a multiple of 100 therefore gets
 *       none — ceilTo100(1600) is 1600); ~a fifth of the entries are instead
 *       pinned at their EXACT LOC (each says so in its own `reason`), which is a
 *       ceiling with zero headroom BY DESIGN — the next line of growth has to be
 *       argued rather than absorbed. Growth past the ceiling BLOCKS either way.
 *     • HARD_MAX (6000 LOC) — an absolute backstop. Any file above it that is
 *       not `bundleExempt` (a generated content bundle) BLOCKS regardless.
 *
 *   NET EFFECT: CI is green on today's tree (all current offenders are
 *   allowlisted at their real LOC), but (a) NO new file may cross 1500 LOC
 *   without an explicit, reviewed allowlist entry, and (b) NO allowlisted
 *   monolith may grow past its frozen ceiling. Decompose a file and its ceiling
 *   drops on the next --update-baseline; grow one and the ceiling can only rise
 *   with a HUMAN justification (FAIL rule 4 below).
 *
 * FAIL conditions:
 *   1. A file > WARN_THRESHOLD that is NOT in ALLOWLIST  → new monolith.
 *   2. An ALLOWLISTED file whose LOC > its ceiling       → monolith grew.
 *   3. Any file > HARD_MAX that is not `bundleExempt`     → absolute backstop.
 *   4. An ALLOWLIST entry whose `reason` still carries the `TODO(bump):` marker
 *      --update-baseline stamps on a RAISED ceiling      → unargued bump.
 *
 * ESCALATION POLICY (documented per E3 acceptance criteria):
 *   - Preferred fix for a new failure: split the file by bounded context
 *     (UI sections / hooks / service adapters / validators) below 1500 LOC.
 *     See docs/fiab/decomposition-plan.md for the WS-E extraction blueprint of
 *     the five priority editors.
 *   - If a large file is genuinely unavoidable (e.g. a generated bundle, a
 *     single exhaustive catalog), add it to ALLOWLIST with a one-line reason.
 *     Reviewers gate new allowlist entries — an entry IS the exception request.
 *   - After decomposing a file, refresh the baseline so the ratchet tightens:
 *       node scripts/ci/check-file-size.mjs --update-baseline
 *     and paste the emitted JSON into ALLOWLIST below. THE PASTE CANNOT HAND
 *     BACK HEADROOM, and it cannot make a RAISED ceiling green on its own:
 *       · a file that fits gets the TIGHTER of its recorded ceiling and the
 *         rounded count — never a looser one;
 *       · a file that genuinely outgrew its ceiling rises to the EXACT LOC and
 *         no further, AND its `reason` is stamped `TODO(bump): …`, which is FAIL
 *         rule 4 above. The tree stays RED until a human replaces that marker
 *         with the justification. That is deliberate: a bump IS an exception
 *         request, so the tool computes the number and refuses to write the
 *         argument.
 *     See updateBaseline()/planBaseline() for the invariant and
 *     scripts/ci/__tests__/file-size-ratchet.test.mjs for the tests that hold
 *     it — until 2026-09-10 the paste silently LOOSENED 12 ceilings and DROPPED
 *     8 entries; until 2026-09-11 a rise was emitted carrying the OLD entry's
 *     justification verbatim and went green unargued.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_REL = path.join('apps', 'fiab-console');
const APP_ROOT = path.join(REPO_ROOT, APP_REL);
const SCOPE_DIRS = ['lib', 'app'];

export const WARN_THRESHOLD = 1500; // "large file" line — new files above this block
const HARD_MAX = 6000;       // absolute backstop — non-bundle files above this block

/** Round a LOC up to the next 100 to give a small churn slack on the ratchet. */
export function ceilTo100(loc) {
  return Math.ceil(loc / 100) * 100;
}

/**
 * The ratchet rule, as one pure function (see updateBaseline for the incident
 * it was extracted from). `prevMax` is the ceiling already recorded for this
 * file, or `undefined` for a file the allowlist has never seen.
 *
 *   - NEW file      -> ceilTo100(n): a little churn slack, once.
 *   - EXISTING, fits under its ceiling -> min(prevMax, ceilTo100(n)). Never
 *     looser than what is already recorded, so an entry deliberately pinned at
 *     its exact LOC stays pinned; a decomposed file drops to the rounded count.
 *   - EXISTING, outgrew its ceiling    -> exactly n. A bump has to happen for
 *     the tree to be green, and the smallest one that works is the exact count,
 *     so the NEXT line of growth is argued too.
 */
export function nextCeiling(prevMax, n) {
  if (prevMax === undefined || prevMax === null) return ceilTo100(n);
  return Math.max(n, Math.min(prevMax, ceilTo100(n)));
}

/**
 * The stamp `--update-baseline` puts on an entry whose ceiling it RAISED, and
 * that FAIL rule 4 refuses. It is a prefix on the entry's `reason`, so it
 * survives the copy-paste the FAIL text tells you to do and it is visible in the
 * allowlist diff a reviewer reads.
 *
 * WHY A MARKER AND NOT A REFUSAL TO EMIT: a file that legitimately outgrew its
 * pin is a real situation, and a `--update-baseline` that emitted the OLD number
 * for it would hand the author output that leaves CI red with no explanation —
 * a dead remediation. So the tool computes the smallest number that works and
 * then blocks on the part only a human can supply: the argument.
 */
export const BUMP_MARKER = 'TODO(bump):';
/** Separator between the marker sentence and the reason the entry carried before. */
export const BUMP_SEPARATOR = ' || PREVIOUS REASON: ';

/**
 * The reason text minus any `TODO(bump):` stamp — used ONLY to build the next
 * stamp, never to emit. Stripping a marker on the way OUT would launder a bump
 * in two runs (grow, paste, re-run, paste again, green), so `planBaseline` never
 * removes one: an entry that is not rising keeps its reason byte-for-byte.
 */
export function reasonWithoutBumpMarker(reason) {
  if (typeof reason !== 'string' || !reason.startsWith(BUMP_MARKER)) return reason;
  const at = reason.indexOf(BUMP_SEPARATOR);
  return at < 0 ? reason : reason.slice(at + BUMP_SEPARATOR.length);
}

/** Files whose allowlist entry still carries an unreplaced `TODO(bump):` stamp. */
export function unarguedBumps(allowlist = ALLOWLIST) {
  return Object.entries(allowlist)
    .filter(([, entry]) => typeof entry?.reason === 'string' && entry.reason.startsWith(BUMP_MARKER))
    .map(([file]) => file);
}

function isScanned(rel) {
  if (!/\.(ts|tsx)$/.test(rel)) return false;
  if (/\.d\.ts$/.test(rel)) return false;
  if (/(^|\/)__tests__\//.test(rel)) return false;
  if (/\.(test|spec)\.(ts|tsx)$/.test(rel)) return false;
  if (/(^|\/)(node_modules|\.next)\//.test(rel)) return false;
  return true;
}

/** LOC = number of newline-separated lines in the file. */
export function loc(abs) {
  const src = fs.readFileSync(abs, 'utf8');
  if (src.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
  // a trailing newline shouldn't inflate the count by one phantom line
  if (src.charCodeAt(src.length - 1) === 10) n--;
  return n;
}

function listFiles() {
  const out = execSync(`git ls-files ${SCOPE_DIRS.join(' ')}`, { cwd: APP_ROOT, encoding: 'utf8' });
  const files = [];
  for (const rel of out.split('\n').map((s) => s.trim())) {
    if (!rel) continue;
    if (!isScanned(rel)) continue;
    files.push(path.join(APP_ROOT, rel));
  }
  return files;
}

function rel(abs) {
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

function scan() {
  const counts = {};
  for (const abs of listFiles()) {
    let n;
    try { n = loc(abs); } catch { continue; }
    counts[rel(abs)] = n;
  }
  return counts;
}

// __ALLOWLIST_START__  (regenerate with --update-baseline)
// Every file already above WARN_THRESHOLD (1500 LOC) on 2026-07-20, frozen at
// its current LOC (rounded up to the next 100). `max` is the ratchet ceiling;
// growth past it fails CI. The five WS-E priority editors carry the
// decomposition reason; generated content bundles are `bundleExempt` (they are
// machine-emitted and are the WS-E E2 externalization target). Everything else
// is a pre-existing large module, ratchet-frozen so it cannot grow further.
export const ALLOWLIST = {
  // --- WS-E E1 priority editors (tracked for decomposition; do NOT grow) -----
  "apps/fiab-console/lib/editors/lakehouse/lakehouse-editor-shell.tsx": { max: 1200, reason: "WS-11.1 decomposed (5227→<1200 LOC); ratchet-frozen at 1200 post-decomp (R7 re-baseline)" },
  "apps/fiab-console/lib/editors/report-designer.tsx": { max: 1300, reason: "WS-11.1 decomposed (5135→1280 LOC); ratchet-frozen at 1300 post-decomp (R7 re-baseline)" },
  "apps/fiab-console/lib/editors/report-designer/use-report-mutations.tsx": { max: 1300, reason: "useReportMutations hook — all IO + mutation + ribbon callbacks extracted from report-designer (WS-11.1); ratchet-frozen" },
  "apps/fiab-console/lib/editors/phase3/semantic-model-editor.tsx": { max: 2500, reason: "WS-E1 decomposed (4617→3018 LOC); 9 sibling modules extracted (types/constants/styles/helpers/aas-panel/security-tab/copilot-pane/prep-for-ai-pane/loom-native-model-view). R10 slice 1 lifted 3 more self-contained tab clusters (aggregations / direct-lake shim / incremental-refresh) to sibling `use<Cluster>()` hook + presentational body modules (3025→2397 LOC). Ratchet re-baselined DOWN from 3050 to 2400 (loom-apex B-R10). Re-baselined 2400→2500 for #2649: the editor fed ONE `workspaceId` to two different id namespaces (Power BI groupId vs the item's Loom workspace), 404ing every assertOwner-guarded Loom item route on open; splitting it into `pbiWorkspaceId` / `loomWorkspaceId` costs +27 LOC, nearly all of it the namespace-boundary comment that keeps the two from being re-merged. The pure `defaultDatasetId` helper went to the sibling helpers.tsx rather than here." },
  "apps/fiab-console/lib/editors/notebook-editor.tsx": { max: 3500, reason: "WS-E1 decomposed (3875→3515); R9 extracted 6 self-contained explorer/compute dialogs to notebook-editor/dialogs/* (3521→3443 LOC). Ratchet re-baselined DOWN from 3550 to 3500 (loom-next-level WS-E R9). Pane/hook carving is the browser-verified follow-up per decomposition-plan.md §4." },
  "apps/fiab-console/lib/editors/apim-editors.tsx": { max: 100, reason: "WS-E1 decomposed (3581→25 LOC barrel); 4 editors moved to apim-editors/*. Ratchet-frozen." },
  "apps/fiab-console/lib/editors/apim-editors/data-product-editor.tsx": { max: 1400, reason: "R8 decomposed (1624→1343 LOC); pure-move extractions to ./data-product/* (types/content/hooks + PublishAsApiDialog). Ratchet re-baselined DOWN from 1650 to 1400 (loom-next-level WS-E R8)." },
  // --- Generated content bundles (WS-E E2 target; machine-emitted) -----------
  "apps/fiab-console/lib/apps/content-bundles/app-supercharge-gold.ts": { max: 300, reason: "generated by scripts/csa-loom/import-supercharge-notebooks.mjs; WS-E E2 externalized (6045→232 LOC); ratchet-frozen at 300 (R7 re-baseline)", bundleExempt: true },
  "apps/fiab-console/lib/apps/content-bundles/app-supercharge-silver.ts": { max: 200, reason: "generated by scripts/csa-loom/import-supercharge-notebooks.mjs; WS-E E2 externalized (5215→196 LOC); ratchet-frozen at 200 (R7 re-baseline)", bundleExempt: true },
  "apps/fiab-console/lib/apps/content-bundles/app-supercharge-bronze.ts": { max: 200, reason: "generated by scripts/csa-loom/import-supercharge-notebooks.mjs; WS-E E2 externalized (4104→196 LOC); ratchet-frozen at 200 (R7 re-baseline)", bundleExempt: true },
  // --- Pre-existing large modules (ratchet-frozen — decompose to lower) -------
  "apps/fiab-console/lib/azure/cosmos-client.ts": { max: 1846, reason: "the single exhaustive Cosmos container registry — one container decl + ensure() + accessor per feature (WS-4.2 function-registry; WS-5.2 a2a-tasks; WS-9 agent-registry; WS-10.1 autopilot; WS-10.3 time-branches; WS-10.4 marketplace; WS-10.5 parity-autopilot-runs; C3 loom-cost-anomaly-rules; N9 loom-semantic-contract; N10 loom-answer-receipts; N13 loom-prompt-registry + loom-token-budgets; N5 loom-assets); ratchet-frozen, decomposition tracked in decomposition-plan.md (extend-then-decompose: this registry grows ~4 LOC per new container — N13's two containers took it 1698→1702; N1's loom-lakehouse-interop took it 1720→1740; N5's loom-assets took it 1745→1758) 4b-batch2 adds N5 loom-assets + N6's contracts container in ONE wave (each agent bumped independently to 1758/1760; the COMBINED file is 1784, so the ceiling is 1790). N17 adds loom-monitors + loom-incidents (the observability incident console's two containers) in ONE wave: +4 LOC each → 1790→1798. M2 adds loom-migration-copy-jobs (the copy-in monitor's single-partition job store, MIG1): +12 LOC → 1798→1810. §P2 wave adds A14's collab-stream accessor growth (+6 combined across the wave's 9 parallel agents; real combined file 1816) → 1810→1820. LU-5 adds `uc-governance` (the Loom Unity governance-overlay row store, PK /tenantId): decl + ensure() + accessor + KNOWN_CONTAINER_IDS = +4 LOC → 1820→1832 (the 1830 the first LU-5 pass reached was held there by jamming the accessor and the NEXT function's JSDoc onto one physical line; that concatenation is undone here and the ceiling bumped instead — the sanctioned path). LU-9 adds `sharing` (ONE container holding published shares AND their recipients, ids `share:<name>`/`recipient:<name>`, so the recipient hot path resolves both in a single-partition read; its `/tenantId` key co-locates and is NOT a tenant boundary — #2620): decl + ensure() + accessor = +5 LOC -> 1832->1837. Adopt-or-create adds `deployment-plans` (the immutable per-tenant history of adopt/create decisions the deploy is supposed to have applied, PK /tenantId): decl + ensure() + accessor + KNOWN_CONTAINER_IDS = +9 LOC -> 1837->1846. Registering a Cosmos container REQUIRES editing this registry — that is what the file is — so the growth is structural, not sprawl." },
  "apps/fiab-console/lib/pipeline/connector-catalog.ts": { max: 3400, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/foundry-sub-editors.tsx": { max: 3762, reason: "pre-existing large module — ratchet-frozen. Re-baselined 3300→3394 for #3543: the 'New evaluation' form asked the operator to hand-type an `azureml://…` dataset id and a model-deployment name, and check-no-freeform.mjs's boy-scout rule requires a TOUCHED baselined file to be cleared COMPLETELY — so this change also had to convert the AI Search vectorizer's Azure OpenAI endpoint and the Dataset editor's data URI to pickers. Three free-text infrastructure inputs became discovery-fed Dropdowns (/api/items/dataset, /api/foundry/model-deployments, /api/foundry/accounts) plus the existing AdlsBrowseDialog, and the file's no-freeform baseline entry is DELETED (3 sites → 0). +96 LOC; comments were compressed first (the first pass landed at 3418). Ceiling set at the EXACT LOC, not ceilTo100, so it ratchets DOWN when this module is decomposed — the eight editors in it are eight bounded contexts. Re-baselined 3394→3666 on #4313 round 2+3: the Dataset editor's data URI picker grew from a single ADLS browse into `DataUriPickDialog`, a two-tab dialog whose second tab lists the AML `/datastores` and walks the picked one through the generic ADLS path lister — the `azureml://datastores/<name>/paths/<p>` half of the address space that the ADLS tab structurally cannot reach — plus the vectorizer-endpoint FAILURE-PATH branches (discovery failed vs genuinely zero accounts render different controls, and the failed one stays enterable rather than a disabled control asserting absence over a call that never answered). Round 3 adds the DatastoreBrowsePanel read-evidence gate (+9). Comments were compressed before the bump (the pass before compression landed at 3670). Ceiling remains the EXACT LOC, not ceilTo100 — the decomposition tracked in decomposition-plan.md should ratchet this DOWN, and slack pre-loaded here is slack the next PR spends. Re-baselined 3666→3682 on #4313 round 6: the review found that the ONE `<HonestGate>` this PR added (svc-aoai, for the vectorizer) had, via `scanSource`'s `honestGate > 0 ? [] : bareGates` short-circuit in check-honest-gate-coverage.mjs, MASKED the file's two remaining bare G2 remediation bars rather than fixing them — so the deleted honest-gate-coverage key read as 'fixed' when nothing about those two bars had changed. The `LOOM_AI_SEARCH_SERVICE` bar in AiSearchBindPicker is now a real `<HonestGate gateId=\"svc-aisearch\">` with the registry's Fix-it wizard (+16 LOC, mostly the two comments recording why). `LOOM_DRIFT_MONITOR` at ~3669 has no registry entry and stays bare — filed as #4359, disclosed in the PR body AND annotated at the site, not silently masked. Re-baselined 3682→3762 on #4313 round 7: the review found that BOTH pickers #3543 itself introduced — the evaluation form's Dataset and Model deployment — still carried the exact R7 defect the four preceding rounds had fixed for the vectorizer. `/api/items/dataset` and `/api/foundry/model-deployments` answer 401/502/503 with `{ ok:false }`, `useApi` flattens each to `{ data:null }`, so `No data assets` / `No model deployments in this account` rendered over a FAILED call, `assets.error` was rendered nowhere at all, and `disabled={!deploymentOptions.length}` removed an affordance `main` had as a free `<Input>`. Both now split discoveryFailed from pickable, print the route's own error + hint with a Retry (the 503 through `<HonestGate gateId=\"svc-aoai\">`), and keep the deployment name enterable via the same freeform-Combobox escape hatch the vectorizer uses (+80 LOC; comments were compressed before the bump). ON THE SHARED COMPONENT, since the round-7 review asked and the answer belongs here rather than in a PR comment: `lib/components/storage/adls-path-picker.tsx` exports `AdlsBrowseDialog`, which IS strictly more capable than this file's private ADLS browser (any storage account, plus a container-scope-RBAC fallback for Gov) — but it is a whole `<Dialog>`, and this site needs a PANEL BODY inside an existing two-tab dialog that writes one field from two address families, so it is not a drop-in; adopting it would also replace the current DLZ-containers-first first-open with an account-picker-first one, a behaviour change with its own tests. Promoting a `AdlsBrowsePanel` out of the shared dialog and deleting the ~112-line private copy is the change that ratchets this ceiling DOWN, and it is tracked as #4381 rather than left to the same 'whichever wave next opens that editor' the shared file's header assumed and this wave did not do." },
  "apps/fiab-console/lib/editors/databricks/uc-dialogs.tsx": { max: 3106, reason: "pre-existing large module — ratchet-frozen. Re-baselined 3100→3106 for #3540: the Unity Catalog storage-credential dialog asked the operator to PASTE an Access Connector ARM id and a managed-identity ARM id (`/subscriptions/…/providers/Microsoft.Databricks/accessConnectors/…`), which auto-bind-by-default.md §5 forbids where the platform can enumerate the value. Both are now `AzureBackedField` pickers. A picker is structurally more markup than an `<Input>` — it takes a kind, a surface and a value/onChange pair, and each needs a flex wrapper to keep the row layout — so the +6 is the fix, not sprawl; the file lost 2 free-text infrastructure sites (11→9) in exchange. Compressed first: the two fields were folded to one JSX line each and the explanatory Caption1 to four lines, which is where 6 of the original 19 LOC of growth went. Ceiling set at the exact LOC rather than ceilTo100 so it ratchets DOWN when this dialog file is decomposed (create-catalog, create-table, create-volume, external locations, storage credentials and federation connections are six dialogs in one module)." },
  "apps/fiab-console/lib/azure/aas-client.ts": { max: 3000, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/unity-catalog-client.ts": { max: 2905, reason: "pre-existing large module — ratchet-frozen. +2 LOC for the #2679 401/403 internal-token eviction in ucFetch: a security fix whose whole point is that it sits on the single choke point every catalog call passes through, so it cannot live elsewhere. Recorded rather than dodged — contorting the code to stay under a line counter would be worse than the two lines. Decomposition of this module is tracked separately; the ceiling should ratchet DOWN then, not up again." },
  "apps/fiab-console/lib/editors/phase4/plan-editor.tsx": { max: 2900, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/phase4/ontology-editor.tsx": { max: 2900, reason: "large module — WS-4.3 Security tab wiring; heavy markings UI extracted to ontology-security-panel.tsx" },
  "apps/fiab-console/lib/azure/purview-client.ts": { max: 2922, reason: "pre-existing large module — ratchet-frozen. L4 column lineage adds createAtlasColumnLineage/ensureColumnEntities/getProcessColumnMappings (they need the module-private purviewFetch/readJson/getAssetDetail/purviewAccount helpers, so cannot move out); the SDK-free column-map serialize/parse helpers WERE extracted to purview-column-lineage.ts (extend-then-decompose). +100 justified. LU-5 adds removeAssetClassification — the missing DELETE counterpart to addAssetClassification, without which any Loom-applied Atlas classification is unrevocable (a de-certified / re-tagged asset keeps a stale, contradictory sensitivity signal). It needs the module-private purviewFetch/purviewAccount helpers, so it cannot move out: 2900→2920. #2633 adds +2 LOC: one assertNamespacedBusinessMetadataName call at the top of ensureBusinessMetadataDef and one at the top of setBusinessMetadata. This file holds BOTH account-global Atlas typedef sinks, and only the classification one had the runtime backstop (assertNamespacedTypedefNames) that purview-typedef-namespace's header prescribes for 'the paths TypeScript cannot see' — the branded parameter #2846 added is erased at runtime. The weaker sink guards the MORE destructive call (isOverwrite=true replaces the whole bag). The assert must sit at the sink, which is here: 2920→2922." },
  "apps/fiab-console/lib/components/charts/loom-chart.tsx": { max: 2800, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/copilot-orchestrator.ts": { max: 2834, reason: "pre-existing large module — ratchet-frozen; +27 LOC (N10 answer-receipt assemble+persist on the two final-step paths, minimized via the shared assembleAndPersistReceipt helper); +4 LOC (#2663 cloud-boundary check now parses the host — 1 import + a 3-line why; the alternative was destructuring two consts onto one line to beat the counter, which trades readability for a number); decomposition target (WS-R)" },
  "apps/fiab-console/lib/editors/phase3/eventhouse-editor.tsx": { max: 2800, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/databricks-client.ts": { max: 2718, reason: "pre-existing large module — ratchet-frozen. +18 LOC for GHSA-v2g8-gp3r-rg4r: a `tasks` field on JobRun, and `listJobRunsPage` (limit clamped to the documented 25, plus page_token) which `listJobRuns` now delegates to. `items/databricks-notebook/[id]/runs` returned recent runs — and, via getRunOutput, notebook CELL OUTPUT — across the entire shared Databricks workspace; the only coordinate that attributes a run to a notebook is tasks[].notebook_task.notebook_path, which `runs/list` omits unless expand_tasks is requested, and Jobs 2.1 caps that request at 25 so the scoped route must PAGE. All of it sits on the client that owns the URL, so it cannot live elsewhere; doc comments were compressed rather than contorting the code to beat the counter. Decomposition of this module should ratchet the ceiling DOWN, not up again." },
  "apps/fiab-console/lib/components/deployment/deployment-pipelines-pane.tsx": { max: 2600, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/foundry-hub-editor.tsx": { max: 2620, reason: "pre-existing large module — ratchet-frozen. Re-baselined 2600→2620 by the #3518 re-review of 2026-09-07, for two defects in the connection dialog this wave had already touched. (1) The Category dropdown did not clear the cascade it owns: pick AzureBlob, choose an account and a container, switch to AzureOpenAI, and the composed blob endpoint was submitted as the AOAI target — the same class fixed in event-grid-topic-editor's Handler-type dropdown. (2) A stored target with a path below the container (`…/bronze/raw/2026`) was folded whole into the container control on edit-prefill, so an edit could silently repoint the connection at the container root; the dialog now carries `blobPath` and round-trips it. Both are behavioural, not markup: the fix is a fourth piece of dialog state plus its clears in the category handler, the account handler, the container handler, the edit prefill and reset. The file was compressed first — the two blob-state docblocks merged into one, the cascade-clear note cut from 11 lines to 8, and its five setters folded onto one line, which is where 11 of the original 32 LOC of growth went. Ceiling set at the exact LOC rather than ceilTo100 so it ratchets DOWN when this editor is decomposed (the hub page, the connection list, the create/edit dialog and the deployment panes are one module today). ZERO HEADROOM IS THE POINT, and it was re-decided here rather than inherited: measured over all 66 allowlist entries, 14 sit at exactly their ceiling at this head and 13 already did at this PR's merge base be792ecc137, so this PR moves that count by exactly one. The base 13 already included the other two entries this PR bumps: uc-dialogs was 3100 LOC under a 3100 ceiling and unified-sql-database-editor 2400 under 2400 on main before this wave touched either, so for those two a 0-headroom ceiling is preserved, not introduced. foundry-hub-editor is the only one of the three that spent real slack (2511 LOC under a 2600 ceiling at the base, 89 lines; 2620 under 2620 now). Rounding it to 2700 for churn room would hand back 80 lines of unargued growth in the one editor this wave just found two live cascade defects in, and would make this the odd entry out among the exact-LOC pins. So the next line of growth here fails CI ON PURPOSE, and the remediation is the decomposition above or a bump that says why — which is also why --update-baseline was fixed in this PR to stop quietly rounding pins like this one up (it would have written 2700 here)." },
  "apps/fiab-console/lib/editors/phase3/eventstream-editor.tsx": { max: 2600, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/foundry-client.ts": { max: 2600, reason: "pre-existing large module — ratchet-frozen; +WS-2.2 AI Search deleteDocuments + semantic-rerank config for Delta-synced vector search" },
  "apps/fiab-console/lib/editors/phase3/kql-database-editor.tsx": { max: 2500, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/unified-sql-database-editor.tsx": { max: 2407, reason: "pre-existing large module — ratchet-frozen. Re-baselined 2400→2407 for #3626: the PostgreSQL provisioning panel asked the operator to invent an admin PASSWORD and type it into a browser, while the platform holds a Key Vault and a Secrets Officer assignment on it. The password field is DELETED (net -3 LOC there: the Field, the state and the disabled-guard term all go); the route now mints the value and Key-Vaults it. The +7 is the replacement RECEIPT — a Caption1 saying the password is minted and never shown, plus the response's `adminSecretName` woven into the success message so the operator is told where it landed rather than left to guess. Removing an ask and saying nothing about where the credential went would be the worse trade. Comments were compressed first. Ceiling set at the exact LOC, not ceilTo100, so it ratchets DOWN when this editor — which serves azure-sql-database, postgres-flexible-server AND the ADF receipt panel from one file — is split." },
  "apps/fiab-console/lib/mcp/catalog.ts": { max: 2400, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/powerplatform-editors.tsx": { max: 2400, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/databricks/sql-warehouse-editor.tsx": { max: 2200, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/kusto-client.ts": { max: 2200, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/phase3/kql-dashboard-editor.tsx": { max: 2200, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/components/monitor/monitor-pane.tsx": { max: 2100, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/report/analytics-pane.tsx": { max: 2100, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/report-model-resolver.ts": { max: 2100, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/phase4/data-agent-editor.tsx": { max: 2100, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/adf-client.ts": { max: 2014, reason: "pre-existing large module — ratchet-frozen. Re-baselined 2001→2014 for #3513: `adfName()` now honours the LOOM_ADF_FACTORY alias that hub-console-dlz-env.bicep already emitted and gov-discover.yml already suggested (nothing read it — deploy-integrity R7), and `adfConfigGate()` mirrors the resolvers axis by axis instead of demanding only the platform-wide spelling (a FALSE RED on an estate pinned to a reused factory in another subscription). Both sit on the env resolvers every ADF call passes through, so they cannot live elsewhere; the comments were compressed first and the ceiling is set at the exact LOC, not ceilTo100, so it ratchets DOWN when this client is decomposed." },
  "apps/fiab-console/lib/azure/synapse-dev-client.ts": { max: 1530, reason: "EXCEPTION REQUEST (#3696). This file was NOT allowlisted because it sat at 1437 LOC; #3689 (Livy batch page-size clamp) took it to 1494 — 6 LOC under the warn line — so the next change to touch it at all was going to cross, and GHSA-class fix #3696 is that change. It adds `getArtifact` + the `getLinkedService`/`getDataset` reads that make the sibling `upsertLinkedService`/`upsertDataset` PUTs create-if-absent: without an existence check those PUTs are create-OR-UPDATE and a request-body-supplied `referenceName` overwrites a customer's linked service or dataset. The reads are deliberately kept in THIS module beside the PUTs they guard — the two Synapse clients derive their sovereign dev host through different code paths, and a read that resolved to a different host from its write would 404 and AUTHORIZE the blind overwrite it exists to prevent. Comments were compressed and the two getters folded onto one helper first; the irreducible code alone still lands ~1506. Ceiling set tight at 1530 rather than the ceilTo100 default: this module is a decomposition target (list/get/upsert artifacts, Livy sessions, Kusto pools, dedicated pools and integration runtimes are five bounded contexts in one file) and the ceiling should ratchet DOWN when that happens, not be pre-loaded with slack." },
  "apps/fiab-console/lib/editors/copilot-studio-editors.tsx": { max: 2000, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/components/admin/mcp-servers-panel.tsx": { max: 2000, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/components/eventstream/visual-designer.tsx": { max: 2000, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/powerplatform-client.ts": { max: 1900, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/synapse-notebook-editor.tsx": { max: 1930, reason: "pre-existing large module — ratchet-frozen. Re-baselined 1900→1930 for #3171: the editor stopped requiring the user to attach a Spark pool before Run-cell would work (three routes 400'd with 'pool is required'; the pool is now resolved server-side per auto-bind-by-default). +61 LOC, 23 of them the comment explaining why the client no longer passes a pool — deliberately kept, because the next person to 'simplify' this by reading the pool from the request body reintroduces the defect. NOTE: at 1921 LOC this file is already a monolith and wants the same pane/hook carving notebook-editor.tsx got; that is a tracked follow-up, not something to do inside a bug fix." },
  "apps/fiab-console/lib/editors/azure-sql-editors.tsx": { max: 1900, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/panes/setup-wizard.tsx": { max: 1900, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/monitor-client.ts": { max: 1900, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/data-pipeline-editor.tsx": { max: 1900, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/components/pipeline/activity-catalog.ts": { max: 1800, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/report/report-definition-sanitizer.ts": { max: 2200, reason: "pure format-whitelist sanitizer; grew for WS-3.1 Wave-6 persistence (axis/title/legend/effects/data-label cards). Follow-on: extract the card sub-sanitizers to report-format-sanitizer.ts (tracked in docs/fiab/decomposition-plan.md)" },
  "apps/fiab-console/lib/pipeline/dataflow-transform-catalog.ts": { max: 1800, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/workshop/workshop-app-builder.tsx": { max: 1800, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/powerbi-client.ts": { max: 1700, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/mirror-engine.ts": { max: 1700, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/components/admin-security/purview-panel.tsx": { max: 1700, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/azure-services-editors.tsx": { max: 1700, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/fabric-client.ts": { max: 1700, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/components/canvas/canvas-node-kit.tsx": { max: 1620, reason: "pre-existing large module — ratchet-frozen (+20: dark-theme readableAccent glyph boundary fix, 2026-07-22 sweep-2)" },
  "apps/fiab-console/lib/azure/apim-client.ts": { max: 1600, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/foundry-cs-client.ts": { max: 1600, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/components/onelake/shortcut-wizard.tsx": { max: 1600, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/sql-objects-client.ts": { max: 1600, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/data-api-builder-editor.tsx": { max: 1600, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/copilot-studio-client.ts": { max: 1600, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/spark-session-pool.ts": { max: 1700, reason: "A12 session-quota/vCore-budget accounting (sparkSessionQuotaStatus/enforceSparkQuota + budget-capped refill + hard-kill) + A13 chaos-drill injection hook (markPoolFaultedForDrill); bulk of the budget logic lives in the new spark-vcore-budget.ts, only the pool wiring is here (+~140 LOC, 1506→1647). Re-baselined 1600→1700 per the A11/A12/A13 item note." },
};
// __ALLOWLIST_END__

const WS_E_EDITORS = new Set([
  // lakehouse-editor-shell.tsx decomposed via WS-11.1 (2026-07-21)
  // report-designer.tsx decomposed via WS-11.1 (2026-07-21)
  "apps/fiab-console/lib/editors/phase3/semantic-model-editor.tsx",
  "apps/fiab-console/lib/editors/notebook-editor.tsx",
  "apps/fiab-console/lib/editors/apim-editors.tsx",
]);

/**
 * Plan the ALLOWLIST this tree ratchets to. Pure in `counts` and `allowlist`,
 * so a fixture population can drive every branch — including the one the real
 * tree can never exercise while it is green (a file OVER its ceiling; the tree
 * is red in that state, so the CLI-over-the-real-population arms cannot see it).
 *
 * THE INVARIANT, stated as what the code holds — all three clauses:
 *
 *   1. NO CEILING IS EVER HANDED BACK HEADROOM. For a file that fits under its
 *      recorded ceiling the emitted value is min(recorded, ceilTo100(loc)), so
 *      it either stays or falls. Never rises.
 *   2. A FILE THAT GENUINELY OUTGREW ITS CEILING RISES TO EXACTLY ITS LOC and no
 *      further — the smallest number that makes the tree green — and the entry
 *      is STAMPED `TODO(bump):`, on which the guard FAILS (rule 4). So the tool
 *      can compute a rise but cannot land one: `--update-baseline` output pasted
 *      verbatim is still RED until a human writes why the growth is justified.
 *      Nor can two runs launder it — a non-rising entry keeps its reason
 *      byte-for-byte, marker included.
 *   3. AN EXISTING ENTRY IS NEVER DROPPED while its file is still scanned.
 *
 * The header above stated a shorter version of clause 1 as the whole rule.
 * Before 2026-09-10 this function did not hold even that, and it is the
 * remediation the FAIL path tells you to run. Two measured leaks, on the tree at
 * that date (66 entries, 58 files above the warn line):
 *
 *   1. Every ceiling was rewritten to `ceilTo100(loc)` with no reference to the
 *      ceiling already recorded. 12 of the 58 got LOOSER — +38 to +94 LOC each
 *      (foundry-hub-editor 2620 -> 2700, unified-sql-database-editor 2407 ->
 *      2500, uc-dialogs 3106 -> 3200, purview-client 2922 -> 3000, ...). Those
 *      are exactly the entries pinned at their EXACT LOC on purpose, each one
 *      saying so in its own `reason`, so that the next line of growth has to be
 *      argued rather than absorbed. Pasting the output handed all of it back.
 *   2. Only files above WARN_THRESHOLD were emitted at all, so the 8 entries
 *      whose files are now at or below it were DROPPED — and a dropped entry is
 *      unratcheted up to the 1500 warn line. apim-editors.tsx is the loudest:
 *      a 3581-LOC editor decomposed to a 25-LOC barrel and frozen at 100, which
 *      the paste would have released to 1500.
 *
 * So: `ceilTo100` buys a NEW entry a little churn slack, and nothing else.
 * For an entry that already exists the ceiling can only fall (to the rounded
 * count) or, where the file genuinely outgrew it, rise to the EXACT LOC — the
 * minimum that makes the tree green, which is also the shape the hand-written
 * bumps in this allowlist already use. A rise carries the marker; the old
 * justification is kept AFTER it rather than presented as the new one, because
 * a reason that argues 2620 is not an argument for 2621.
 */
export function planBaseline(counts, allowlist = ALLOWLIST) {
  const files = new Set([
    ...Object.keys(counts).filter((f) => counts[f] > WARN_THRESHOLD),
    ...Object.keys(allowlist),
  ]);
  const rows = [];
  const dropped = [];
  for (const file of files) {
    const n = counts[file];
    const prev = allowlist[file];
    if (n === undefined) {
      // Not in the scan any more (deleted, renamed, or moved out of scope).
      // There is nothing to ratchet, but say so instead of dropping silently.
      if (prev) dropped.push(file);
      continue;
    }
    const max = nextCeiling(prev?.max, n);
    rows.push({ file, n, max, prev });
  }
  rows.sort((a, b) => b.n - a.n || a.file.localeCompare(b.file));
  const out = {};
  for (const { file, max, prev } of rows) {
    const carried = prev?.reason ?? 'pre-existing large module — ratchet-frozen';
    // A RISE is stamped. A non-rise carries `reason` byte-for-byte — including a
    // marker a previous run put there, which is what stops a two-run laundering.
    const reason =
      prev && max > prev.max
        ? `${BUMP_MARKER} --update-baseline raised this ceiling ${prev.max}->${max} because the file ` +
          `reached ${max} LOC. Replace this sentence with why that growth is justified — ` +
          `check-file-size FAILS while the marker is here, so the tool cannot hand you the headroom.` +
          `${BUMP_SEPARATOR}${reasonWithoutBumpMarker(carried)}`
        : carried;
    out[file] = { max, reason };
    if (prev?.bundleExempt) out[file].bundleExempt = true;
  }
  return { out, rows, dropped };
}

function updateBaseline(counts) {
  const { out, rows, dropped } = planBaseline(counts);
  const above = rows.filter((r) => r.n > WARN_THRESHOLD).length;
  const tightened = rows.filter((r) => r.prev && r.max < r.prev.max).length;
  const raised = rows.filter((r) => r.prev && r.max > r.prev.max);
  console.log(
    `// ${rows.length} ratchet entries (${above} above ${WARN_THRESHOLD} LOC); ` +
      `${tightened} tightened, ${raised.length} raised to their exact LOC and stamped ` +
      `${BUMP_MARKER}, 0 handed back headroom`,
  );
  for (const r of raised) {
    console.log(
      `// ${BUMP_MARKER} ${r.file} ${r.prev.max} -> ${r.max}. Pasting this leaves check-file-size RED ` +
        `until you replace the marker in its reason with the justification.`,
    );
  }
  for (const f of dropped) {
    console.log(`// DROPPED (no longer scanned — confirm the file is really gone): ${f}`);
  }
  console.log(JSON.stringify(out, null, 2));
}

function main() {
  const counts = scan();

  if (process.argv.includes('--update-baseline')) {
    updateBaseline(counts);
    process.exit(0);
  }

  const failures = [];
  const large = [];
  // FAIL rule 4 — an entry --update-baseline RAISED and nobody argued. This is
  // read off the ALLOWLIST itself, not off the scan, so it fires whether or not
  // the file is still over: the defect is the unwritten justification, and it
  // must not become green just because the ceiling now covers the file.
  for (const file of unarguedBumps()) {
    failures.push({ file, kind: 'unargued-bump', limit: ALLOWLIST[file].max });
  }
  for (const [file, n] of Object.entries(counts)) {
    if (n > WARN_THRESHOLD) large.push({ file, n });
    const entry = ALLOWLIST[file];
    if (!entry) {
      if (n > WARN_THRESHOLD) {
        failures.push({ file, n, kind: 'new-monolith', limit: WARN_THRESHOLD });
      }
      if (n > HARD_MAX) {
        failures.push({ file, n, kind: 'hard-backstop', limit: HARD_MAX });
      }
      continue;
    }
    if (n > entry.max) {
      failures.push({ file, n, kind: 'ratchet-regression', limit: entry.max });
    }
    if (n > HARD_MAX && !entry.bundleExempt) {
      failures.push({ file, n, kind: 'hard-backstop', limit: HARD_MAX });
    }
  }

  large.sort((a, b) => b.n - a.n);
  const allowlistedLarge = large.filter((l) => ALLOWLIST[l.file]);
  console.log(`[file-size] scanned git-tracked .ts/.tsx under ${APP_REL}/{${SCOPE_DIRS.join(',')}}`);
  console.log(`[file-size] warn threshold ${WARN_THRESHOLD} LOC, hard backstop ${HARD_MAX} LOC`);
  // Say the rule-4 count out loud even when it is zero: a check whose only
  // output is silence reads identically to a check that was never wired in.
  console.log(
    `[file-size] ${Object.keys(ALLOWLIST).length} allowlist entries, ` +
      `${unarguedBumps().length} carrying an unargued ${BUMP_MARKER} marker`,
  );
  console.log(`[file-size] ${large.length} large files (all ratchet-frozen in the allowlist):`);
  for (const { file, n } of allowlistedLarge) {
    const tag = WS_E_EDITORS.has(file) ? '  [WS-E priority]' : ALLOWLIST[file].bundleExempt ? '  [generated bundle]' : '';
    console.log(`    ${String(n).padStart(5)}  ${file}${tag}`);
  }

  if (failures.length) {
    console.error('\n[file-size] FAIL — monolith-creep detected:');
    for (const f of failures) {
      if (f.kind === 'new-monolith') {
        console.error(`  - NEW large file ${f.file}: ${f.n} LOC > ${f.limit} warn threshold`);
        console.error('      Fix: split by bounded context (< 1500 LOC) — see docs/fiab/decomposition-plan.md.');
        console.error('      Or, if unavoidable, add a reviewed ALLOWLIST entry with a one-line reason.');
      } else if (f.kind === 'ratchet-regression') {
        console.error(`  - GREW ${f.file}: ${f.n} LOC > ${f.limit} frozen ceiling`);
        console.error('      Fix (preferred): reduce below the ceiling — decompose, see docs/fiab/decomposition-plan.md.');
        console.error('      Fix (bump), TWO steps, because the tool will not argue for you:');
        console.error('        1. node scripts/ci/check-file-size.mjs --update-baseline');
        console.error(`           raises THIS entry to exactly ${f.n} and no further, leaves every other`);
        console.error(`           ceiling no looser than it is today, and stamps this one ${BUMP_MARKER}.`);
        console.error('        2. Paste the JSON, then REPLACE that marker with why the growth is');
        console.error('           justified. This guard stays RED while the marker is there.');
      } else if (f.kind === 'unargued-bump') {
        console.error(`  - UNARGUED BUMP ${f.file}: ceiling ${f.limit} still carries the ${BUMP_MARKER} marker`);
        console.error('      --update-baseline raised this ceiling and stamped it. Replace the marker');
        console.error('      sentence in its `reason` with why the growth is justified (the reason it');
        console.error('      carried before the rise is kept after "PREVIOUS REASON:" — it argued the OLD');
        console.error('      number, so it is not the argument for this one).');
      } else {
        console.error(`  - BACKSTOP ${f.file}: ${f.n} LOC > ${f.limit} absolute hard cap`);
        console.error('      A non-generated file this large must be decomposed before merge.');
      }
    }
    process.exit(1);
  }

  console.log('[file-size] OK — no new monoliths, no ratchet regressions, no backstop breaches.');
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
