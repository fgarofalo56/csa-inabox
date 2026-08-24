/**
 * NO SHEBANG — DO NOT RE-ADD ONE. Every invocation of this guard is
 * `node scripts/ci/check-no-freeform.mjs` (the guardrails workflow, its own
 * `node --test` suite, the console's Wave-1A spec), so a `#!` buys nothing —
 * and it costs coverage: vite-node evaluates an out-of-root `.mjs` through
 * `vm.Script`, which does NOT strip `#!`, so any vitest spec that references
 * this file dies at COLLECTION with `SyntaxError: Invalid or unexpected token`
 * and reads as "Failed Suites 1 / no tests". Same class, and same fix, as the
 * header of `_ratchet-count.mjs`; `__tests__/spec-imported-scripts-have-no-shebang.test.ts`
 * is the class guard that keeps it closed.
 *
 * GUARDRAIL: no-freeform-config  (merge-blocker; PART 2 RATCHETS)
 * ===========================================================================
 * RULE (`loom_no_freeform_config`, BLOCKING GLOBAL; `.claude/rules/`): item and
 * infrastructure configuration is authored through DROPDOWNS, WIZARDS, PICKERS
 * and CANVAS surfaces. A user does not hand-type a resource id, an endpoint, a
 * cluster URI, a connection string, an account key or a password. Reinforced by
 * `auto-bind-by-default.md` §5 (the platform DEPLOYS and BINDS the backing
 * resource; it does not ask the operator for its address) and `ux-baseline.md`
 * G2 (zero day-one gates — an unavoidable gate needs an inline Fix-it that
 * SETS the value, not a text box that asks for it).
 *
 * ── THE DEFECT THIS REWRITE FIXES ──────────────────────────────────────────
 * On 2026-08-14 the operator walked the deployed estate and filed 13 defects.
 * SIX were direct violations of this rule — surfaces demanding a hand-typed
 * infrastructure value:
 *
 *   lib/editors/phase3/activator-editor.tsx      an ADX cluster URI
 *                                                (`https://<cluster>.<region>.kusto.windows.net`)
 *                                                and a Logic App ARM id
 *   lib/editors/palantir/health-check-editor.tsx a Logic App ARM id
 *   lib/editors/databricks/uc-dialogs.tsx        a Databricks UC credential:
 *                                                host FQDN + a clear-text password,
 *                                                plus `abfss://` storage locations
 *   app/catalog/unity/page.tsx                   an Access Connector ARM id and an
 *                                                `abfss://` external-location URL
 *   lib/editors/foundry-sub-editors.tsx          "New evaluation" — an
 *                                                `azureml://datastores/…` dataset id
 *   lib/editors/copilot-studio-editors.tsx       a knowledge-source "URI / location"
 *
 * Every one of them passed CI. This guard reported, on that same tree:
 *
 *     node scripts/ci/check-no-freeform.mjs
 *     [no-freeform] candidate raw-JSON-config surfaces: 0
 *     [no-freeform] OK — no editable raw-JSON config surfaces detected.   EXIT=0
 *
 * It was not wrong so much as it was answering a different question. It scanned
 * FOUR tags (`MonacoTextarea|MonacoEditor|MonacoDiff|Textarea`) in ONE directory
 * (`lib/editors/**`) for ONE sub-rule: "do not edit the whole item config as a
 * raw JSON blob". `<Input>` — the element every one of the six defects is built
 * from, 2,355 of them in `apps/fiab-console` — was not in its vocabulary, and
 * `app/**` (where the Unity page lives) was not in its scope. The zero was real
 * and meant nothing, which is the `csa_loom_gates_that_measure_nothing` shape:
 * a guard whose measured population EXCLUDES the class that motivated it.
 *
 * ONE CORRECTION TO THE FILED REPORT, recorded because a premise nobody checked
 * is how two other issues went wrong the same week. The Databricks item was
 * filed as "a credential dialog requiring a typed AccountKey". The dialog is
 * real and it is a violation, but it contains no `AccountKey` — it demands a
 * host FQDN, a clear-text `type="password"`, an Access Connector ARM id and
 * `abfss://` paths. The literal `AccountKey=` connection strings are in two
 * DIFFERENT files, `lib/components/pipeline/manage-panel.tsx` (twice) and
 * `lib/components/ai-search/ai-search-tree.tsx`. Both classes are controls
 * below, so the guard covers what was filed AND what was actually there.
 *
 * ── THE MEASURED POPULATION (2026-08-15, the output that motivates the shape) ─
 *   1,286 tracked `.tsx` under apps/fiab-console
 *   2,742 raw free-text tag matches -> 2,298 SITES after exclusions
 *         (~408 non-text `type=`, ~64 readOnly, ~33 disabled, 20 masked prose)
 *     250 classified as asking for an infrastructure value, across 110 files
 *         155 on SHAPE evidence, 95 on NAME evidence
 *         azure-host 67 · adls-uri 33 · bare-locator 32 · guid 23 ·
 *         password-field 22 · arm-id 22 · secret-ref 19 · locator 18 ·
 *         entra-id 17 · storage-loc 13 · templated-host 10 · secret-value 9 ·
 *         secret-descriptor 9 · resource-id 8 · connection-string 5 ·
 *         conn-scheme 3 · ml-uri 3 · object-store-uri 1
 *
 * A read-only inventory before this work put the number near 31. That was an
 * undercount by roughly 8x, and the gap is the point: it was a grep for a few
 * URI schemes, so it saw `abfss://` and missed `type="password"`, every ARM id,
 * every GUID, every Azure FQDN and every descriptor-driven form. The 250 is
 * measured, reproducible (`--report`), and frozen per file below.
 *
 * RESIDUAL FALSE POSITIVES, counted by reading all 250 rather than estimated:
 * roughly 10-15 (~5%), concentrated in the two WEAK patterns — an APIM
 * `Pagination next-URL`, a bare `URL` label on a report canvas action, an
 * `Outbound allow-list` of customer FQDNs, a `Shortcut name` whose HINT happens
 * to mention Key Vault. They are frozen in the baseline, cost nothing on a
 * green run, and surface for judgement the first time someone edits the file.
 * The direction was chosen deliberately: this guard's failure mode has always
 * been under-detection.
 *
 * ── THE azure-host LABEL BOUNDARY, AND WHY CodeQL WAS RIGHT FOR THE WRONG
 *    REASON (#3560) ───────────────────────────────────────────────────────
 * CodeQL raised 10 × js/incomplete-url-substring-sanitization ("Missing regular
 * expression anchor") on the azure-host suffix list. Its stated reasoning does
 * NOT apply here: that rule assumes the regex is a URL SANITIZER deciding
 * whether to trust a host, and this is a DETECTOR reading source text to decide
 * whether a form field asks a human to type an Azure address. There is no URL,
 * no trust decision and no security boundary; matching mid-string is the
 * requirement, because the evidence is prose like
 * `e.g. https://saloom.dfs.core.windows.net`.
 *
 * The finding was still worth acting on, because the patterns were loose FOR
 * THEIR OWN PURPOSE. Measured before the fix, all eight matched:
 *
 *     x.azconfig.iowa                y.azure-api.network
 *     z.cloudapp.azure.community     q.kusto.windows.network
 *     r.azurehdinsight.networking    s.azuredatalakestore.networks
 *     loom.kusto.windows.net.evil.test
 *     account.blob.core.windows.net.attacker.example
 *
 * None is an Azure host, and the pattern's own `why` claims "an Azure service
 * FQDN" — so a hint mentioning any of them would have been graded on evidence
 * that says the opposite. The DNS-label boundary makes the pattern mean what it
 * always claimed. Coverage on the real corpus is unchanged: 250 sites across
 * 110 files before and after, and the 12-case coverage probe still passes.
 *
 * THE ALERT DID NOT CLEAR, AND IS DISMISSED — alerts #961-970, rule
 * `js/regex/missing-regexp-anchor` (NOT `js/incomplete-url-substring-
 * sanitization`; the two share a message string and are easy to confuse). The
 * query inspects each host-shaped STRING LITERAL in isolation, so a boundary
 * applied to the wrapping group is invisible to it — which is also why the ten
 * entries that end in an alternation group (`…(?:com|us)`) were never flagged
 * and the ten that end in a bare TLD were. The split is syntactic, not semantic:
 * `\.azconfig\.io` and `\.documents\.azure\.(?:com|us)` are equally unanchored,
 * and only one is reported.
 *
 * Dismissed rather than restructured because every restructure available is
 * worse:
 *   - ending each entry in a dummy alternation group would silence the
 *     recognizer without changing behaviour — obfuscation, and it would hide a
 *     genuine finding here later;
 *   - swapping the regex for `indexOf`/`endsWith` over a suffix list trades this
 *     HIGH for `js/incomplete-url-substring-sanitization` in the same family;
 *   - tokenising host-shaped substrings first breaks on the templated
 *     placeholders that motivated the guard (`https://<cluster>.<region>.kusto.
 *     windows.net`), i.e. it costs detection coverage on fixture #1.
 *
 * The rule's premise does not hold here in any case: it assumes a regex used as
 * a FORMAT CHECK that an attacker-controlled value must pass. This regex reads
 * SOURCE TEXT from files in this repo to decide whether a form field asks a
 * human to type an Azure address. There is no URL, no trust decision, no
 * adversary and no bypass — and matching mid-string is the REQUIREMENT, because
 * the evidence is prose. That is the same judgement `check-regex-anchor.mjs`
 * already encodes one directory over: it deliberately fires only on SECRET
 * vocabulary because, run unrestricted, six of the eight sites it finds are
 * correct code.
 *
 * ── WAVE 1B (2026-08-15) — THE POLICY PASS: 250 -> 209 ─────────────────────
 * The 250 was a measurement, not a backlog: it counted every surface that ASKS
 * for an infrastructure value, which is the only thing a classifier can do, and
 * deliberately left "could the platform have supplied it?" to per-surface
 * judgement. That judgement has now been made for 41 of them, in two different
 * ways, and the distinction between the two is the point:
 *
 *   7 were CLASSIFIER DEFECTS and were fixed HERE, not excused. Two narrowings,
 *     each measured across all 1,286 tracked .tsx before it was written and each
 *     pinned by a control in both directions:
 *       `domKeyless`  — an `id`/`name` that is a template interpolation is a DOM
 *                       uniqueness key, not a field name. Exactly 5 sites carry
 *                       one; 3 produced no NAME hit either way, and the 2 that
 *                       did were a SQL login and a password wearing their row's
 *                       ARM id (add-existing-wizard.tsx). 2 sites.
 *       display rows  — a DESCRIPTOR carrying a bound `value:` and neither a
 *                       `placeholder:` nor a `secret:` renders a RESOLVED value.
 *                       That is the descriptor form of the shape a control here
 *                       already calls compliant ("a READ-ONLY display of a
 *                       resolved endpoint is a receipt, not an ask"). 5 sites,
 *                       all in read-only "Endpoints" lists. 26 descriptors were
 *                       examined; manage-panel's `accessKeyId` (no value:) and
 *                       every `secret: true` row are untouched.
 *     An exemption is a permanent cost and a classifier fix is not, so anything
 *     cheaply keyable was keyed.
 *
 *  34 were JUDGED and are declared in ACCEPTED below with a reason specific
 *     enough to argue with — 30 bring-your-own across 15 files (a customer's
 *     Snowflake account, their webhook receiver, an APIM origin, a git PAT,
 *     an external Delta Sharing provider's activation token) and 4 residual
 *     false positives across 4 files that no cheap classifier rule reaches.
 *     They leave the ratchet entirely and are watched by `applyAccepted`
 *     instead: the count must match EXACTLY, so a new hand-typed endpoint in a
 *     BYO file still fails the run.
 *
 * ZERO fields were deleted. The scoping proposed 13 deletions on the premise
 * that the value is derivable from session / item state / the deploy; three
 * were measured and the premise did not hold (`spnTenantId` is persisted and
 * read by nothing that mints a token; the Request-access dialog is PRE-AUTH so
 * there is no session; the report Parameters panel's tenant id is an explicit
 * override whose default the platform already supplies). The rest sit in files
 * that also carry later-wave sites, which the all-or-nothing ratchet forbids
 * touching. Those measurements are pinned as RECEIPT tests in
 * `__tests__/no-freeform.test.mjs` §7 rather than argued in prose.
 *
 * The 209 that remain are the actual work: a picker fed by a real discovery
 * call, per `auto-bind-by-default.md` §5.
 *
 * ── AND THEN THE EXTRACTOR TURNED OUT TO BE BLIND: 243 -> 246 (212 RATCHETED) ─
 * The wave-1C lane, adopting a picker, hit a live defect in the SITE EXTRACTOR
 * while this PR was in review. The skip test for a disabled control read the
 * identifier INSIDE its own braces (see `attrSkeleton` for the mechanism), so
 * `disabled={disabled}` — and, via the same hole in `hasTruthyProp`,
 * `readOnly={readOnly}` — marked a CONDITIONALLY off control as permanently
 * off and dropped it before classification.
 *
 * Measured through the real code path, one prop at a time, rather than
 * estimated:
 *
 *   both holes open (as shipped)    2,298 sites   243 classified   106 files
 *   `disabled` hole closed          2,325 sites   245 classified   108 files
 *   both closed (this PR)           2,350 sites   246 classified   109 files
 *
 * So +52 free-text sites and +3 classified violations, split 27/2 to `disabled`
 * and 25/1 to `readOnly`. All three new violations are GENUINE asks that were
 * structurally invisible — a Cosmos conflict-resolution sproc resource id, a
 * `type="password"` pipeline parameter default, and a Key Vault secret name —
 * and none falls in an ACCEPTED file, so the baseline absorbs them.
 *
 * THE COUNT WENT UP AND THAT IS THE FIX WORKING. A ratchet baseline that grows
 * because the detector stopped being blind is the opposite of a regression;
 * this file's entire history is the other failure. The honest statement of the
 * population is 246, not 243 and not the 250 this guard shipped with — 250 was
 * what the extractor could SEE, and reporting it as the population would be the
 * same class of error the wave exists to correct.
 *
 * ONE CORRECTION TO THE REPORT, recorded because an unchecked premise is how
 * this guard went wrong the first time. The defect was filed as also covering
 * `disabled={loading}` and `disabled={busy}` — "the ordinary React idiom", 31
 * sites. It does not: the regex needs the LITERAL word `disabled` after the
 * brace, so only the self-named form could ever trip it. `disabled={busy}` was
 * always visible. The real number is 27, and the difference matters because the
 * two framings imply different fixes.
 *
 * ── WHAT CHANGED ───────────────────────────────────────────────────────────
 * PART 1 (unchanged, still a HARD ZERO) — the raw-JSON-config detector.
 * PART 2 (new, RATCHETED) — every FREE-TEXT INPUT in `apps/fiab-console` that
 * asks the user for an infrastructure value, classified from the evidence the
 * surface itself carries.
 *
 * ── HOW PART 2 CLASSIFIES, AND WHAT THAT MISSES ────────────────────────────
 * The whole difficulty is that `<Input>` is not the defect. `<Input>` for
 * "Display name" is correct and there are thousands. `<Input>` for "ADX cluster
 * URI" is the defect. So the detector is POSITIVE and evidence-driven, not a
 * count of a tag:
 *
 *   SITE      a free-text element — `<Input>`, `<Textarea>`, `<TextField>`,
 *             `<input>`, `<textarea>` — that is not `readOnly`/`disabled` and
 *             whose `type` is not a non-text control (number/checkbox/radio/
 *             file/range/color/date/time/hidden). Pickers (`<Dropdown>`,
 *             `<Select>`, `<Combobox>`, `<Option>`) are the COMPLIANT shape and
 *             are deliberately not sites.
 *
 *   EVIDENCE  read off the site and its immediate surroundings: `placeholder`,
 *             `defaultValue`, `aria-label`, `id`, `name`, `type`, the bound
 *             expression (`value={form.datasetId}` -> `form.datasetId`), the
 *             enclosing `<Field label= hint=>`, and an immediately-preceding
 *             sibling label element (`<span>Dataset ID</span><Input …>`, which
 *             is how the "New evaluation" form is written and which a
 *             `<Field>`-only reader would have missed).
 *
 *   VERDICT   two tiers, both reported with the pattern that fired so a
 *             reviewer can judge the call rather than trust a number:
 *
 *     SHAPE  the evidence contains the value's own syntax — `abfss://`,
 *            `azureml://`, an Azure host suffix (`.kusto.windows.net`,
 *            `.dfs.core.windows.net`, `.database.windows.net`, … including the
 *            sovereign suffixes, per `cloud-parity.md`), `/subscriptions/…`,
 *            `AccountKey=`, `Endpoint=sb://`, a bare GUID, a `https://<…>`
 *            template — or the element is `type="password"`. This tier is high
 *            confidence: a placeholder showing the user the shape of an ADLS
 *            path is not ambiguous about what it is asking for.
 *
 *     NAME   the LABEL / hint / aria-label / binding name says it in words:
 *            "resource id", "connection string", "cluster URI", "endpoint",
 *            "access key", "client secret", "storage location", "key vault",
 *            "secret scope". Lower confidence than SHAPE and matched against a
 *            NARROWER evidence set (never the placeholder alone), because a
 *            placeholder is example data and a label is a promise.
 *
 * WHAT THIS DOES NOT SEE — stated, because an unstated limit reads as coverage:
 *
 *   - A DESCRIPTOR-DRIVEN form. `lib/components/pipeline/manage-panel.tsx`
 *     builds its fields from an array of `{ key, label, secret, placeholder }`
 *     objects rendered by a generic component; there is no `<Input placeholder=`
 *     to read. Part 2 therefore ALSO scans object literals that carry a
 *     `placeholder:`/`label:` pair and no `options:`/`choices:` — that recovers
 *     manage-panel's two `AccountKey=` connection strings — but a descriptor
 *     table that names its properties differently is invisible.
 *   - A CUSTOM WRAPPER. `<ExpressionField>`, `<NumField>`, `<ColField>`,
 *     `<LinkedServicePicker>` and ~20 siblings each wrap an Input or a Dropdown
 *     one file away. Only the wrapper's own definition file is scanned, so a
 *     wrapper that hard-codes an infra placeholder is caught once, at its
 *     definition, and never at its ~9 call sites. Cross-file resolution is not
 *     attempted.
 *   - A FLUENT `<Combobox freeform>`, which accepts typed text while looking
 *     like a picker. Zero in the tree today; recorded because it is the one
 *     way a compliant-looking element is not one.
 *   - A LABEL THAT LIVES SOMEWHERE ELSE — a `<Label htmlFor>` earlier in the
 *     file, a label from a translation table, or a column header above a grid
 *     of inputs. Only the enclosing `<Field>` and an immediately-adjacent
 *     sibling element are read.
 *   - WHETHER THE PLATFORM COULD HAVE SUPPLIED THE VALUE. That is the actual
 *     rule, and it needs per-surface product judgement (does a discovery API
 *     exist? is this a genuine tenant-consent input?). The guard measures the
 *     ASK. Some baselined members will turn out to be legitimate on triage —
 *     a Databricks "Secret scope"/"Secret key" pair, for instance, names a
 *     secret rather than carrying one, and is a weaker defect than the
 *     clear-text `type="password"` two lines below it. The guard's job is that
 *     none of them is INVISIBLE, not that every one is a P1.
 *
 * ── RATCHET, NOT A WALL ────────────────────────────────────────────────────
 * The measured live population is far past what a blocking guard can demand at
 * once, and every fix is product work — a picker backed by a real discovery
 * call, per `auto-bind-by-default.md`, not a CI change. So Part 2 freezes the
 * existing population PER FILE (same mechanic as check-route-toolkit.mjs and
 * check-external-origin-urls.mjs) with the boy-scout rule: touch a baselined
 * file and you fix its sites while you are there. A baseline entry that no
 * longer matches ANY site FAILS, because a drained entry is cover for the next
 * violation in that file.
 *
 * ── POPULATION FLOORS — a ratchet cannot tell "clean" from "broken" ─────────
 * A ratchet only fails on a RISE, so a detector that stops detecting reads as a
 * clean sweep — this guard's own history, one level up. Four floors, all
 * enforced BEFORE the repo verdict:
 *   1. embedded controls, INCLUDING the six operator-filed surfaces byte-for-
 *      byte, so a control set that cannot reproduce the incidents cannot pass;
 *   2. a floor on tracked files enumerated;
 *   3. a floor on free-text SITES found (if site extraction breaks, every
 *      downstream zero is meaningless and this collapses first);
 *   4. a floor on the classified population itself.
 *
 * NO `PHYSICAL-LINES-OK` PRAGMA: the corpus is `.ts`/`.tsx`, which has no
 * backslash line continuation, and this guard reads whole-file text and
 * balanced JSX tags rather than judging lines — a line number is computed from
 * a byte offset only to REPORT. check-guard-logical-lines.mjs classifies it
 * out-of-scope on the corpus test.
 *
 * ── WHY THE MASK IS LOCAL AND NOT check-external-origin-urls' `maskNonCode` ─
 * Reusing that lexer was the first attempt, on the `_logical-lines.mjs` (#3420)
 * principle that two private implementations of one idea will diverge. It was
 * MEASURED first, and it is wrong for this corpus:
 *
 *     maskNonCode('<Input value={a} onChange={f} /><Textarea value={b} … />')
 *     -> '<Input value={a} onChange={f} /                              />'
 *
 * Its regex-vs-division heuristic is correct for TypeScript — a `/` whose
 * previous significant character cannot END an expression starts a regex — and
 * `}` cannot end an expression, so the `/` of a JSX SELF-CLOSING TAG opens a
 * regex literal that runs to the next `/` and blanks every element between.
 * Two of this guard's own controls caught it, which is the only reason it is
 * not shipping as a silent false negative — the exact class this guard exists
 * to end. `maskJsx` below is the same one-pass state machine with three JSX
 * rules added (`/>`, `</`, and an intra-word apostrophe), and a control pins
 * the difference so a future "just reuse the sibling" cannot land quietly.
 *
 * Run:    node scripts/ci/check-no-freeform.mjs
 * Report: node scripts/ci/check-no-freeform.mjs --report
 * Regen:  node scripts/ci/check-no-freeform.mjs --update-baseline
 *         (regenerates the RATCHET baseline only — the ACCEPTED table below is
 *          hand-maintained on purpose, because an acceptance needs a human)
 * Tests:  node --test scripts/ci/__tests__/no-freeform.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runRatchet, gitTouchedFiles, loadBaseline } from './_ratchet-count.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCOPE = 'apps/fiab-console';
const EDITORS_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console', 'lib', 'editors');
const BASELINE_FILE = path.join(REPO_ROOT, 'scripts', 'ci', 'no-freeform-inputs-baseline.json');

/** Tracked `.tsx` under SCOPE today: 1,286. A collapse means the enumeration
 *  broke, not that the front end was deleted. */
const MIN_TRACKED_FILES = 1000;
/**
 * Free-text SITES the extractor must still find. MEASURED 2,350 today, from
 * 2,742 raw tag matches; the ~392-site gap is accounted for and is not silent
 * loss — ~408 carry a non-text `type=` (number/checkbox/date/file/…), 36 are
 * bare `readOnly`, 6 are bare or explicitly-`{true}` `disabled`, and 20 are
 * prose inside a comment or a string that the mask correctly removed.
 *
 * It was 2,298 until the `disabled`/`readOnly` brace hole was closed (see
 * `attrSkeleton`): 52 sites were being dropped because a CONDITIONALLY off
 * control read as a permanently off one. The `readOnly`/`disabled` line of this
 * accounting used to read "~64 readOnly, ~33 disabled" — those were the counts
 * of elements SKIPPED, not of elements legitimately skippable, and the gap
 * between the two is exactly the defect.
 *
 * This is the control on SITE EXTRACTION, and it is the floor that matters
 * most: the classifier reports a subset of these, so if the tag matcher, the
 * mask or the JSX open-tag reader breaks, this collapses BEFORE a classifier
 * zero can be mistaken for a clean tree. That ordering is the whole lesson of
 * the version this replaces.
 */
const MIN_FREETEXT_SITES = 1800;
/** Classified violations the guard must still find; 250 when this ratchet was
 *  bootstrapped, 246 today. Two movements, in opposite directions: -7 from the
 *  two WAVE-1B classifier narrowings (`domKeyless`, the descriptor display-row
 *  rule), then +3 from closing the `disabled`/`readOnly` brace hole in the site
 *  extractor, which had made 52 free-text sites structurally invisible.
 *
 *  This floor reads the MEASURED population, BEFORE ACCEPTED is applied. An
 *  acceptance is a judgement about a site the detector correctly found, so
 *  netting it off here would let the ACCEPTED table walk the floor down without
 *  anything having been fixed — the floor would then be measuring the table
 *  rather than the detector.
 *
 *  Deliberately NOT zero — a ratchet only fails on a RISE. Lower it in the SAME
 *  PR that actually removes the sites. */
const MIN_LIVE_SITES = 200;

// ═══════════════════════════════════════════════════════════════════════════
// PART 1 — raw-JSON-config surfaces (unchanged behaviour, HARD ZERO)
// ═══════════════════════════════════════════════════════════════════════════
//
// Scans apps/fiab-console/lib/editors/** for an EDITABLE `language="json"` (or
// language-less) Monaco/Textarea surface. Such a surface is a candidate raw-
// JSON-config violation UNLESS it is read-only (a Definition view), a
// recognized code language, a recognized data/code artifact by intent, or
// allowlisted below.
//
// HOW TO ADD AN ALLOWLIST ENTRY: prefer making the surface self-describing —
// give the Monaco an ariaLabel that names the artifact ("OpenAPI document",
// "GeoJSON", "Workflow definition JSON") and that alone clears ALLOW_INTENT.
// If the surface really is "edit the whole item config as JSON", it is a RULE
// VIOLATION — replace it with a form / wizard / canvas, do not allowlist it.

/** Recognized non-JSON code languages — free text is fine (1:1 code surfaces). */
const CODE_LANGS = new Set([
  'sql', 'tsql', 'kql', 'kusto', 'dax', 'python', 'py', 'm', 'yaml', 'yml',
  'csv', 'markdown', 'md', 'html', 'xml', 'bicep', 'plaintext', 'text',
  'javascript', 'typescript', 'shell', 'bash', 'sparql', 'cypher', 'graphql',
]);

/** Data/code ARTIFACT intents — a JSON surface describing one of these is a
 *  legitimate document/payload/code-view, not a raw item-config blob. */
const ALLOW_INTENT_RE = new RegExp(
  [
    'openapi', 'oas', 'swagger', 'geojson', 'geo\\s*json', 'schema', 'sample',
    'document', 'definition', '\\bspec\\b', 'policy', 'manifest', 'payload',
    'template', 'tmsl', 'topology', 'pipeline', 'workflow', 'query',
    'expression', 'arm', 'script', 'mapping', 'transform', 'event',
    'blocklist', '\\brai\\b', 'body', 'request', 'response', 'dataflow',
    'theme', 'header', 'predict', 'connection', 'binding',
    'key', 'secret', 'credential', 'account', 'token',
  ].join('|'),
  'i',
);

/** Files that legitimately need no per-surface intent tag. Repo-relative POSIX. */
export const JSON_ALLOWLIST = new Map([
  ['apps/fiab-console/lib/editors/palantir/aip-logic-studio-panels.tsx', 'AIP-Logic eval-case fields: a sample typed-inputs payload + a free-text NL pass-criteria for the LLM judge — per-case test data, not a config surface (the function itself is authored in the typed block graph)'],
  // ADX / Fabric real-time dashboards expose a raw JSON model view 1:1 (the
  // "Edit model (JSON)" advanced dialog). Primary authoring is the visual tile
  // canvas; this editable JSON dialog mirrors the portal's JSON view.
  ['apps/fiab-console/lib/editors/phase3/kql-dashboard-editor.tsx', 'ADX/Fabric dashboard raw-JSON model view (1:1 portal code view; canvas is primary)'],
  // The only free-text surface here is a natural-language "Custom prompt"
  // Textarea (a per-row instruction sent to Azure OpenAI) — NOT a raw item-config
  // JSON blob. It trips the Textarea heuristic only because an adjacent, unrelated
  // "Fields" hint mentions "returned as JSON" within the 6-line context window.
  ['apps/fiab-console/lib/editors/ai-enrichment-editor.tsx', 'Free-text natural-language custom-prompt Textarea (Azure OpenAI per-row instruction), not raw-JSON config; "JSON" only appears in an adjacent Fields hint'],
]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.next') continue;
      walk(full, out);
    } else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function rel(f) {
  return path.relative(REPO_ROOT, f).split(path.sep).join('/');
}

const JSON_ELEMENT_START_RE = /<(MonacoTextarea|MonacoEditor|MonacoDiff|Textarea)\b/g;

/** Extract the JSX element attribute block starting at `from` (self-closing or open tag). */
function extractElementBlock(src, from) {
  let depthBrace = 0;
  let inStr = null;
  for (let i = from; i < src.length && i < from + 4000; i++) {
    const c = src[i];
    if (inStr) {
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depthBrace++;
    else if (c === '}') depthBrace--;
    else if (c === '>' && depthBrace <= 0) return src.slice(from, i + 1);
  }
  return src.slice(from, Math.min(src.length, from + 800));
}

/** Index of the start of the line `n` newlines before `from`. */
function nthNewlineBefore(src, from, n) {
  let idx = from;
  for (let k = 0; k < n; k++) {
    const nl = src.lastIndexOf('\n', idx - 1);
    if (nl < 0) return 0;
    idx = nl;
  }
  return idx;
}

function getAttr(block, name) {
  const re = new RegExp(name + '\\s*=\\s*"([^"]*)"');
  const m = block.match(re);
  return m ? m[1] : null;
}

function isReadOnlyBlock(block) {
  if (/\breadOnly\b(?!\s*=\s*\{?\s*false)/i.test(block)) return true;
  if (/\bdisabled\b(?!\s*=\s*\{?\s*false)/i.test(block)) return true;
  if (/onChange=\{\s*\(\s*\)\s*=>\s*\{\s*\/\*\s*read-?only/i.test(block)) return true;
  return false;
}

function isEditableBlock(block) {
  if (isReadOnlyBlock(block)) return false;
  return /onChange\s*=/.test(block);
}

/** @returns {{file:string,line:number,aria:string}[]} */
export function findJsonBlobSurfaces() {
  const files = walk(EDITORS_ROOT);
  const candidates = [];

  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    let m;
    JSON_ELEMENT_START_RE.lastIndex = 0;
    while ((m = JSON_ELEMENT_START_RE.exec(src)) !== null) {
      const tag = m[1];
      const block = extractElementBlock(src, m.index);
      // Context = up to 6 lines before the tag (captures a wrapping
      // <Field label> / <Caption> / <DialogTitle> that names the artifact)
      // plus the element block itself. ALLOW_INTENT is matched against this.
      const ctxStart = nthNewlineBefore(src, m.index, 6);
      const context = src.slice(ctxStart, m.index) + block;
      const lang = (getAttr(block, 'language') || '').toLowerCase();

      // Plain Fluent <Textarea> has no `language` prop; only treat it as a JSON
      // surface when it is clearly bound to a JSON blob.
      const isJsonSurface =
        lang === 'json' ||
        (tag === 'Textarea' && /json/i.test(context)) ||
        (tag !== 'Textarea' && lang === '' && /json/i.test(context));
      if (!isJsonSurface) continue;
      if (CODE_LANGS.has(lang)) continue;
      if (!isEditableBlock(block)) continue;
      if (ALLOW_INTENT_RE.test(context)) continue;

      const r = rel(f);
      if (JSON_ALLOWLIST.has(r)) continue;

      const line = src.slice(0, m.index).split('\n').length;
      const aria = getAttr(block, 'ariaLabel') || '(no ariaLabel)';
      candidates.push({ file: r, line, aria });
    }
  }
  return candidates;
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 2 — typed-infrastructure-value inputs (RATCHETED)
// ═══════════════════════════════════════════════════════════════════════════

// ── 2a. the patterns ───────────────────────────────────────────────────────

/**
 * SHAPE evidence — the text shows the SYNTAX of an infrastructure value, so
 * what it is asking for is not in doubt. Matched against every evidence field
 * INCLUDING the placeholder, because a placeholder rendering an `abfss://` path
 * is the surface teaching the user to type one.
 *
 * Sovereign suffixes are listed alongside the commercial ones deliberately
 * (`cloud-parity.md`): a Gov-only surface asking for `.core.usgovcloudapi.net`
 * is the same defect and must not be invisible because the pattern list was
 * written from a Commercial checkout.
 */
export const SHAPE_PATTERNS = [
  { id: 'adls-uri', re: /\b(?:abfss?|adls?|wasbs?):\/\//i, why: 'an ADLS / blob URI the user must compose' },
  { id: 'ml-uri', re: /\bazureml:\/\//i, why: 'an Azure ML asset URI' },
  { id: 'object-store-uri', re: /\b(?:s3a?|gs|hdfs|dbfs):\/\//i, why: 'an object-store / DBFS URI' },
  {
    id: 'azure-host',
    re: new RegExp(
      // The suffix list, wrapped so the DNS-LABEL BOUNDARY below applies to
      // every alternative and not just the last one — the mixed-anchor trap
      // check-regex-anchor.mjs exists for (#2772), one level down.
      '(?:' +
        [
          '\\.(?:dfs|blob|table|queue|file|web)\\.core\\.(?:windows\\.net|usgovcloudapi\\.net|chinacloudapi\\.cn)',
          '\\.vault\\.(?:azure\\.net|usgovcloudapi\\.net|azure\\.cn)',
          '\\.database\\.(?:windows\\.net|usgovcloudapi\\.net)',
          '\\.kusto\\.(?:windows\\.net|usgovcloudapi\\.net)',
          '\\.servicebus\\.(?:windows\\.net|usgovcloudapi\\.net)',
          '\\.documents\\.azure\\.(?:com|us)',
          '\\.search\\.(?:windows\\.net|azure\\.us)',
          '\\.openai\\.azure\\.(?:com|us)',
          '\\.cognitiveservices\\.azure\\.(?:com|us)',
          '\\.azurecr\\.(?:io|us)',
          '\\.(?:azuredatabricks\\.net|databricks\\.azure\\.us)',
          '\\.(?:dev\\.|sql\\.)?azuresynapse\\.(?:net|usgovcloudapi\\.net)',
          '\\.azurewebsites\\.(?:net|us)',
          '\\.azconfig\\.io',
          '\\.azurehdinsight\\.net',
          '\\.(?:dfs\\.)?fabric\\.microsoft\\.com',
          '\\.azure-api\\.net',
          '\\.eventgrid\\.azure\\.net',
          '\\.azuredatalakestore\\.net',
          '\\.cloudapp\\.azure\\.com',
        ].join('|') +
        ')' +
        // DNS-LABEL BOUNDARY. Without it every entry above is a SUBSTRING test,
        // which is not what the pattern claims: `why` says "an Azure service
        // FQDN", and MEASURED before this was added, all eight of these matched —
        //   x.azconfig.iowa · y.azure-api.network · z.cloudapp.azure.community
        //   q.kusto.windows.network · r.azurehdinsight.networking
        //   s.azuredatalakestore.networks
        //   loom.kusto.windows.net.evil.test · acct.blob.core.windows.net.attacker.example
        // none of which is an Azure host. That is a real classifier defect: a
        // hint mentioning any of them would have been graded "asks for an Azure
        // FQDN" on evidence that says the opposite.
        //
        // `\\.?` before the class is what keeps SENTENCE-FINAL PROSE working. Hint
        // text in this tree ends sentences on a host ("…is a.dfs.core.windows.net.
        // Then click save."), so a bare `(?![A-Za-z0-9.-])` would have dropped it —
        // an anchor tightened past its own corpus is a false negative, which is
        // this guard's historic failure direction. The lookahead therefore rejects
        // only a FURTHER LABEL: `net.` + space passes, `net.evil` does not.
        '(?!\\.?[A-Za-z0-9-])',
      'i',
    ),
    why: 'an Azure service FQDN the user must know and type',
  },
  { id: 'arm-id', re: /\/subscriptions\/|\/providers\/Microsoft\./i, why: 'an ARM resource id' },
  {
    id: 'connection-string',
    re: /\b(?:AccountKey|AccountEndpoint|SharedAccessKey(?:Name)?|DefaultEndpointsProtocol|InstrumentationKey|IngestionEndpoint|EntityPath|Initial Catalog|Integrated Security)\s*=/i,
    why: 'a raw connection string (it carries a secret)',
  },
  { id: 'conn-scheme', re: /\bEndpoint\s*=\s*sb:\/\/|\bServer\s*=\s*tcp:|\bData\s+Source\s*=|\bjdbc:|\bmongodb(?:\+srv)?:\/\/|\bpostgres(?:ql)?:\/\/|\bmysql:\/\//i, why: 'a raw connection string / DSN' },
  {
    id: 'templated-host',
    // ONLY a placeholder that leaves a HOST SLOT for the user to fill —
    // `https://<cluster>.<region>.kusto.windows.net`. A bare `https://…` was in
    // this pattern for one revision and matched 11 image/link/embed/webhook
    // boxes in the report canvas and the app builders, which are user CONTENT,
    // not infrastructure. Measured, then removed.
    re: /https?:\/\/\s*[<{[]/i,
    why: 'a URL template with a host slot the user must fill in (`https://<host>/…`)',
  },
  { id: 'guid', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, why: 'a resource GUID' },
];

/**
 * NAME evidence — the surface says in WORDS that it wants an infrastructure
 * value. Matched against the LABEL / hint / aria-label / adjacent label text /
 * bound identifier ONLY, never the placeholder: a placeholder is example data
 * ("sales", "orders") and carries no promise, whereas a label does.
 */
export const NAME_PATTERNS = [
  { id: 'resource-id', re: /\b(?:resource|arm|workflow|connector)\s*(?:resource\s*)?id\b|\bresourceId\b/i, why: 'an ARM resource id' },
  { id: 'connection-string', re: /\bconnection\s*string\b|\bconnectionString\b/i, why: 'a connection string' },
  {
    id: 'locator',
    re: /\b(?:cluster|account|workspace|namespace|endpoint|server|vault|registry|instance|metastore|factory|warehouse|pool|hub|gateway|runtime|service|tenant|region|api)\s*(?:uri|url|endpoint|fqdn|host(?:name)?)\b/i,
    why: 'a service address (cluster URI / endpoint / host)',
  },
  { id: 'bare-locator', re: /^\s*(?:uri|url|endpoint|fqdn|hostname|host)\b|\b(?:uri|url|endpoint|fqdn|hostname)\s*(?:\/|\(|$)/i, why: 'a URI / endpoint / host' },
  {
    id: 'secret-value',
    // `primary`/`secondary` are NOT in the bare-key alternation. They were for
    // one revision and matched four DATABASE primary-key fields ("Primary key
    // column(s)", "Upsert key columns", "Primary-key column", "Key column") —
    // a whole FP category for no gain, because every real storage key in this
    // tree is labelled "Account key" / "Access key" / "Shared access key" and
    // most also carry `type="password"`.
    re: /\b(?:api|access|account|shared|instrumentation|subscription|encryption|signing|activation|license)[\s-]?keys?\b|\b(?:client|app|application)\s*secret\b|\bpassword\b|\b(?:sas|bearer|access|refresh|personal\s*access)\s*token\b|\bcredential\s*value\b/i,
    why: 'a secret typed in clear',
  },
  { id: 'secret-ref', re: /\bkey\s*vault\b|\bsecret\s*(?:scope|key|name|uri|identifier)\b|\bsecretName\b/i, why: 'a secret-store coordinate' },
  { id: 'entra-id', re: /\b(?:subscription|tenant|client|principal|object|application)\s*id\b|\b(?:tenantId|clientId|principalId|objectId|subscriptionId)\b/i, why: 'an Entra / ARM identifier' },
  {
    // #3594 — this pattern used to REQUIRE the literal token `storage`:
    //
    //   /\bstorage\s*(?:account|location|root|path|container|url|uri)\b|…/i
    //
    // so a field whose label names the SERVICE rather than the generic noun
    // carried no NAME evidence at all. Measured against the real classifier (by
    // running analyze() on each probe, not by reading the regex):
    //
    //   FLAGS    <Field label="Storage location">   <Input value={x} … /></Field>
    //   no flag  <Field label="ADLS Gen2 location"> <Input value={y} … /></Field>
    //   no flag  <Field label="ADLS subpath">       <Input value={z} … /></Field>
    //
    // Same ask, same class, same consequence for the user — one counted, two not.
    // And this codebase labels fields by SERVICE as a matter of routine ("ADLS
    // Gen2 location", "OneLake path", "Lakehouse path"), so the generic-noun
    // spelling was biased away from the population the guard exists to catch.
    //
    // Worse, an invisible site cannot even be recorded as an ACCEPTED exception:
    // applyAccepted() is keyed to the CLASSIFIED population and rejects an entry
    // whose file has zero classified sites. So the only available record was a
    // code comment — uncounted and never re-validated. Making the sites visible
    // is what lets them be tracked at all.
    //
    // The population is EXPECTED to rise. That is correct behaviour, exactly as
    // when #3579 closed the `disabled={expr}` blind spot (2,298 -> 2,350 sites,
    // 243 -> 246 classified); the newly-visible sites are then fixed or
    // explicitly ACCEPTED. Pinned by the three probes above in CONTROLS.
    id: 'storage-loc',
    re: /\b(?:storage|adls|onelake|lakehouse|blob|datalake|data\s*lake)\s*(?:gen2\s*)?(?:account|location|root|path|sub\s*path|container|url|uri)\b|\bmount\s*(?:point|path)\b|\bcontainer\s*name\b/i,
    why: 'a storage location',
  },
];

/**
 * The WEAK patterns. They key on a generic locator noun ("URL", "endpoint",
 * "host") rather than on anything Azure-specific, so they are the only ones
 * that can fire on a value the platform could never have supplied.
 */
const WEAK_IDS = new Set(['bare-locator', 'locator', 'templated-host']);

/**
 * NOT AN INFRASTRUCTURE VALUE — suppresses a WEAK-ONLY hit.
 *
 * This is the honest half of the classifier. The rule is about values LOOM
 * OWNS: the ADX cluster it deployed, the Logic App it created, the storage
 * account it provisioned. A user's own git remote, their webhook receiver, an
 * `<img src>` in a report they are designing, a documentation link, or an APIM
 * route template are none of those — no discovery call can supply them, so
 * demanding one is not the defect this rule describes.
 *
 * Measured on the tree before this list existed: the weak tier returned 48
 * `bare-locator` hits, of which roughly half were exactly these. A ratchet that
 * freezes a doc-link field makes the boy-scout rule punish an innocent edit,
 * which is how a guard gets ignored.
 *
 * A hit that ALSO matches a strong pattern is never suppressed — `<Field
 * label="Image URL"><Input placeholder="https://x.blob.core.windows.net/…">`
 * still fails on `azure-host`.
 */
const NOT_INFRA_RE = new RegExp(
  [
    '\\b(?:image|logo|icon|avatar|thumbnail|picture|embed|iframe|tile\\s*layer|link|banner)\\s*url\\b',
    '\\b(?:documentation|docs|help|learn|readme|homepage|website|support|contact|certification)\\s*(?:url|uri|link)\\b',
    '\\b(?:git|repo|repository|clone)\\s*url\\b',
    '\\bvanity\\s*(?:url|domain)\\b',
    '\\b(?:webhook|callback|navigate|redirect)\\s*url\\b',
    '\\burl\\s*(?:template|path|suffix)\\b',
    '\\b(?:path|url)\\s*suffix\\b',
    '\\brelative\\s*url\\b',
    '\\bspec\\s*url\\b',
    '\\bendpoint\\s*(?:name|vm\\s*size|sku|type|label)\\b',
  ].join('|'),
  'i',
);

// ── 2b. JSX site extraction ────────────────────────────────────────────────

/** Blank `n` characters at `i`, preserving newlines so line numbers hold. */
function blank(out, src, from, to) {
  for (let k = from; k < to && k < src.length; k++) out[k] = src[k] === '\n' ? '\n' : ' ';
}

/**
 * Replace every non-code region with spaces, IN PLACE (same length, same
 * newlines), so any offset found in the result indexes the true source. Handles
 * `//` and block comments, `'…'`/`"…"` strings, templates (with `${…}`
 * substitutions LEFT AS CODE, nested) and regex literals.
 *
 * STRING DELIMITERS ARE PRESERVED and only the BODY is blanked. That is what
 * lets `attrValue` locate an attribute's value span in the masked code and then
 * read the real text out of the ORIGINAL source at the same offsets — the guard
 * needs `placeholder="abfss://…"` to be simultaneously invisible to structural
 * matching and readable as evidence.
 *
 * THREE JSX RULES the TypeScript-only sibling does not have. Each was measured,
 * not guessed:
 *
 *   1. `/>` NEVER starts a regex. A self-closing tag's slash follows `}` or a
 *      quote, neither of which "can end an expression" under the standard
 *      lexer heuristic, so it reads as a regex opener and blanks forward to the
 *      next `/` — deleting whole elements. This is the failure that made the
 *      local copy necessary; see the header.
 *   2. `</` NEVER starts a regex, for the same reason on closing tags.
 *   3. AN INTRA-WORD APOSTROPHE IS NOT A STRING. JSX children are text, so
 *      `<Caption1>don't type this</Caption1>` would otherwise open a string
 *      literal and blank the rest of the line — losing any `<Field label>` that
 *      shares it. A letter-apostrophe-letter run cannot be a JS string opener
 *      (`x'` is a syntax error), so the exception is safe in both directions.
 *
 * KNOWN LIMIT, stated rather than hidden: a TRAILING apostrophe in JSX text
 * (`users' data`) is not covered by rule 3 and still opens a string, blanking
 * to end of line. The damage is line-local and costs a LABEL, i.e. a false
 * negative, never a fabricated violation. Full correctness needs a real JSX
 * parser that distinguishes children-context from expression-context; that is a
 * much larger dependency than this guard justifies, and the direction of the
 * error is the conservative one.
 */
export function maskJsx(src) {
  const s = String(src);
  const out = s.split('');
  let i = 0;
  let prev = ''; // last significant (non-space, non-blanked) character
  const tpl = [];

  const canEndExpression = (c) => /[A-Za-z0-9_$)\]]/.test(c);

  while (i < s.length) {
    const c = s[i];
    const c2 = s[i + 1];

    if (tpl.length && tpl[tpl.length - 1].inSub) {
      const top = tpl[tpl.length - 1];
      if (c === '{') top.depth++;
      else if (c === '}') {
        if (top.depth === 0) {
          top.inSub = false;
          prev = '}';
          i++;
          continue;
        }
        top.depth--;
      }
      // else: fall through to the generic handling below
    } else if (tpl.length) {
      const top = tpl[tpl.length - 1];
      if (c === '\\') { blank(out, s, i, i + 2); i += 2; continue; }
      if (c === '`') { tpl.pop(); prev = '`'; i++; continue; }
      if (c === '$' && c2 === '{') { top.inSub = true; top.depth = 0; prev = '{'; i += 2; continue; }
      blank(out, s, i, i + 1);
      i++;
      continue;
    }

    // ── line comment. `://` is NOT one: a bare `https://…` in JSX text is not
    // a comment, and truncating there deletes real code from the scan.
    if (c === '/' && c2 === '/' && prev !== ':') {
      let j = i;
      while (j < s.length && s[j] !== '\n') j++;
      blank(out, s, i, j);
      i = j;
      continue;
    }

    // ── block comment
    if (c === '/' && c2 === '*') {
      const end = s.indexOf('*/', i + 2);
      const j = end === -1 ? s.length : end + 2;
      blank(out, s, i, j);
      i = j;
      continue;
    }

    // ── string literal (JSX rule 3: an intra-word apostrophe is prose)
    if (c === "'" || c === '"') {
      if (c === "'" && /[A-Za-z]/.test(s[i - 1] ?? '') && /[A-Za-z]/.test(c2 ?? '')) {
        prev = c;
        i++;
        continue;
      }
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === c || s[j] === '\n') break;
        j++;
      }
      blank(out, s, i + 1, j);
      prev = c;
      i = j < s.length && s[j] === c ? j + 1 : j;
      continue;
    }

    // ── template literal
    if (c === '`') { tpl.push({ inSub: false, depth: 0 }); prev = '`'; i++; continue; }

    // ── regex literal (JSX rules 1 and 2)
    if (c === '/' && !canEndExpression(prev) && c2 !== '>' && prev !== '<') {
      let j = i + 1;
      let cls = false;
      let ok = false;
      while (j < s.length) {
        const d = s[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;
        if (d === '[') cls = true;
        else if (d === ']') cls = false;
        else if (d === '/' && !cls) { ok = true; break; }
        j++;
      }
      if (ok) {
        blank(out, s, i + 1, j);
        let k = j + 1;
        while (k < s.length && /[a-z]/.test(s[k])) k++;
        blank(out, s, j + 1, k);
        prev = '/';
        i = k;
        continue;
      }
      // not a regex after all — treat as an operator
    }

    if (!/\s/.test(c)) prev = c;
    i++;
  }

  return out.join('');
}

/** Elements that accept arbitrary typed text. Pickers are NOT here on purpose. */
const FREE_TEXT_TAGS = ['Input', 'Textarea', 'TextField', 'input', 'textarea'];
const SITE_RE = new RegExp(`<(${FREE_TEXT_TAGS.join('|')})(?=[\\s/>])`, 'g');
/** Cheap prefilter so `collect()` reads only files that can contain a site. */
const SITE_PREFILTER = new RegExp(`<(?:${FREE_TEXT_TAGS.join('|')})[\\s/>]`);

/** `type` values that are not a free-text ask. `password` is NOT here — it is
 *  the strongest SHAPE signal there is. */
const NON_TEXT_TYPES = new Set([
  'number', 'checkbox', 'radio', 'file', 'range', 'color', 'date', 'time',
  'datetime-local', 'month', 'week', 'hidden', 'submit', 'button', 'reset', 'image',
]);

const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = { ')': '(', ']': '[', '}': '{' };

/** Index of the bracket matching the one at `open`, or -1. Over MASKED code. */
function matchBracket(code, open) {
  const want = OPEN[code[open]];
  if (!want) return -1;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (OPEN[c]) depth++;
    else if (CLOSE[c]) {
      depth--;
      if (depth === 0) return c === want ? i : -1;
    }
  }
  return -1;
}

/**
 * Offset of the `>` closing the JSX open tag that starts at `from`, or -1.
 * Runs over MASKED code, so a `>` inside a string body cannot end the tag; a
 * `>` inside a `{…}` expression is skipped by brace depth (`onChange={(a) =>
 * …}` is the reason that matters — an arrow in a handler is the single most
 * common way a naive `indexOf('>')` truncates an element).
 */
function openTagEnd(code, from) {
  let depth = 0;
  for (let i = from; i < code.length && i < from + 8000; i++) {
    const c = code[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth <= 0) return i;
  }
  return -1;
}

/**
 * Read attribute `name` from the open tag spanning [start,end] of MASKED
 * `code`, returning the value read from the ORIGINAL `src` at the same offsets.
 * maskJsx preserves quote characters and all offsets, so the string body
 * span found in `code` is exactly the span to slice out of `src`.
 *
 * Handles `x="…"`, `x='…'`, `x={"…"}`, `x={'…'}`, `x={\`…\`}` and
 * `x={anExpression}` (the expression text is returned as-is, which is what
 * makes `value={form.datasetId}` usable as a NAME signal).
 */
function attrValue(code, src, start, end, name) {
  const re = new RegExp(`(?:^|[\\s{])${name}\\s*=\\s*`, 'gi');
  const region = code.slice(start, end + 1);
  let m;
  while ((m = re.exec(region)) !== null) {
    let at = start + m.index + m[0].length;
    let brace = false;
    if (code[at] === '{') {
      const close = matchBracket(code, at);
      if (close === -1) return null;
      brace = true;
      // step past the `{` and any whitespace
      let i = at + 1;
      while (i < close && /\s/.test(code[i])) i++;
      const inner = src.slice(i, close).trim();
      const q = code[i];
      if ((q === '"' || q === "'" || q === '`') && code[close - 1] === q) {
        return src.slice(i + 1, close - 1);
      }
      return inner;
    }
    const q = code[at];
    if (q === '"' || q === "'") {
      const end2 = code.indexOf(q, at + 1);
      if (end2 === -1) return null;
      return src.slice(at + 1, end2);
    }
    if (!brace) {
      // bare attribute (e.g. `required`) — no value
      return '';
    }
  }
  return null;
}

/** True when a boolean-ish prop is present and not explicitly `{false}`. */
function hasTruthyProp(tagCode, name) {
  return new RegExp(`(?:^|[\\s{])${name}\\b(?!\\s*=\\s*\\{?\\s*false)`, 'i').test(tagCode);
}

/**
 * Blank every BRACE EXPRESSION in an open tag, innermost-out, preserving length
 * so nothing downstream shifts. `disabled={disabled}` becomes `disabled=` plus
 * spaces; `onChange={(e) => f({a: 1})}` becomes `onChange=` plus spaces.
 *
 * ── THE DEFECT THIS EXISTS FOR (#3579, found by the wave-1C lane) ──────────
 * The skip test for a disabled control was
 *
 *     /(?:^|[\s{])disabled\b(?!\s*=)/
 *
 * and the `{` in that character class is the whole bug. On
 * `<Input disabled={disabled} …>` it matches the IDENTIFIER INSIDE THE BRACES:
 * `{` satisfies `[\s{]`, `disabled` satisfies the name, and the `(?!\s*=)`
 * lookahead passes because the next character is `}`. So a control that is
 * *conditionally* disabled — one the user CAN type into — was read as
 * permanently disabled and dropped before classification.
 *
 * MEASURED on this corpus rather than taken from the report: **26** free-text
 * sites were invisible this way, across 13 files (Cosmos policy editors, the
 * pipeline expression fields, the identity/group pickers, the Copilot tool
 * catalogue, uc-governance-pane, domain-settings-pane). The report described it
 * as also covering `disabled={loading}` and `disabled={busy}`; it does NOT —
 * the regex needs the literal word `disabled` SOMEWHERE INSIDE the braces, so
 * any expression MENTIONING it trips the skip. Measured against the old regex:
 *
 *     disabled={disabled}            -> true      disabled={loading}  -> false
 *     disabled={disabled || busy}    -> true      disabled={busy}     -> false
 *     disabled={busy || disabled}    -> true
 *
 * Stating that precisely matters, because "31 sites lost to any
 * expression-valued disabled" and "26 lost to an expression mentioning
 * `disabled`" imply different fixes. (An earlier revision of this comment said
 * "only the SELF-NAMED idiom could ever trip it" — narrower than the truth, as
 * rows 2 and 3 show: the bare identifier matches at any whitespace or brace
 * boundary inside the expression. Corrected under #3598; the population is
 * unchanged and the corrected count of 26 stands.)
 *
 * `readOnly` had the IDENTICAL hole via `hasTruthyProp`, and it was NOT latent:
 *
 *     git grep -c "readOnly={readOnly}" -- apps/fiab-console
 *     -> 16 occurrences across 7 files (.tsx only)
 *
 * An earlier revision of this comment asserted it "measured ZERO occurrences
 * today — a latent sibling … for whoever writes the first `readOnly={readOnly}`".
 * That was false, and it contradicted this file's own table twenty lines above:
 * closing the `readOnly` hole moved 2,325 -> 2,350 sites and 245 -> 246
 * classified, a delta that is arithmetically impossible against zero occurrences.
 * The table was right; the prose was wrong. It matters because a future reader
 * deciding whether the `readOnly` branch is load-bearing would have read "ZERO"
 * and concluded it is dead code — and because an unchecked premise reaching a
 * code comment inside the guard whose entire purpose is to stop unchecked
 * premises being reported as measurements is the defect class this file's own
 * header preaches against. Corrected under #3598, and now pinned by the five
 * `#3598 —` entries in CONTROLS below (which assert the BEHAVIOUR: a
 * conditionally read-only or disabled control still counts, a bare one does
 * not) plus the tree-count assertion in
 * `scripts/ci/__tests__/no-freeform.test.mjs`, so neither the prose nor the
 * branch can rot back silently.
 * Enumerating the siblings of a defect mechanically is the lesson of #3529 /
 * the seventh-consumer class.
 */
export function attrSkeleton(tagCode) {
  let flat = String(tagCode);
  for (let i = 0; i < 12; i++) {
    const next = flat.replace(/\{[^{}]*\}/g, (m) => ' '.repeat(m.length));
    if (next === flat) break;
    flat = next;
  }
  return flat;
}

/**
 * True when `name` marks the control as PERMANENTLY off — a display rather than
 * an ask. Two accepted shapes, and only two:
 *
 *   bare          `<Input readOnly />`      — the attribute with no value
 *   explicit true `<Input disabled={true}>` — or `disabled="true"`
 *
 * Anything expression-valued (`{busy}`, `{!canEdit}`, `{disabled}`) is
 * CONDITIONAL, therefore typable in at least one state, therefore a site. The
 * bare test runs over the SKELETON so an identifier inside braces cannot pose
 * as an attribute name; the explicit-true test runs over the raw tag because
 * that is where `{true}` still exists.
 */
export function isPermanentlyOff(skeleton, tagCode, name) {
  if (new RegExp(`(?:^|\\s)${name}\\b(?!\\s*=)`, 'i').test(skeleton)) return true;
  return new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:\\{\\s*true\\s*\\}|["']true["'])`, 'i').test(tagCode);
}

/**
 * The nearest ENCLOSING `<Field …>` open tag for a site, or null.
 * Walks backwards over `<Field`/`</Field>` in a bounded window so a sibling
 * Field that has already CLOSED cannot lend its label to the next input — the
 * contamination that would otherwise make one `<Field label="Logic App
 * resource id">` flag every input after it.
 */
function enclosingField(code, siteStart) {
  const from = Math.max(0, siteStart - 4000);
  const region = code.slice(from, siteStart);
  let depth = 0;
  for (let i = region.length - 1; i >= 0; i--) {
    if (region.startsWith('</Field>', i)) { depth++; i -= 7; continue; }
    if (region.startsWith('<Field', i) && /[\s/>]/.test(region[i + 6] ?? '')) {
      if (depth === 0) {
        const start = from + i;
        const end = openTagEnd(code, start);
        if (end === -1) return null;
        // A self-closing `<Field … />` cannot enclose anything.
        if (code[end - 1] === '/') return null;
        return { start, end };
      }
      depth--;
      i -= 5;
    }
  }
  return null;
}

/**
 * Text of a label-ish element sitting IMMEDIATELY before the site, e.g.
 * `<span>Dataset ID</span><Input …>`. This is how `foundry-sub-editors.tsx`
 * writes its "New evaluation" grid, and a `<Field>`-only reader scores that
 * whole form as label-less — one of the six surfaces would have been graded on
 * its placeholder alone.
 *
 * Read from MASKED code, so a comment cannot inject a label. The cost is that a
 * JSX text run containing an apostrophe is blanked by the mask's string lexer,
 * which LOSES a label (a false negative) and can never invent one.
 */
function adjacentLabel(code, siteStart) {
  const from = Math.max(0, siteStart - 240);
  const before = code.slice(from, siteStart);
  const m = before.match(/<([A-Za-z][\w.]*)(?:\s[^<>]*)?>([^<>{}]{1,80})<\/\1>\s*$/);
  return m ? m[2].trim() : null;
}

/** 1-based line number of a byte offset. */
function lineOf(src, offset) {
  let n = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') n++;
  return n;
}

/** Trimmed source line containing `offset`, for the annotation body. */
function srcLine(src, offset) {
  const from = src.lastIndexOf('\n', offset) + 1;
  let to = src.indexOf('\n', offset);
  if (to === -1) to = src.length;
  return src.slice(from, to).trim().slice(0, 180);
}

/**
 * Every free-text input SITE in a file, with its evidence.
 * @returns {{offset:number,tag:string,shape:string[],name:string[]}[]}
 */
export function extractSites(src) {
  const code = maskJsx(src);
  const sites = [];
  SITE_RE.lastIndex = 0;
  let m;
  while ((m = SITE_RE.exec(code)) !== null) {
    const tag = m[1];
    const start = m.index;
    const end = openTagEnd(code, start);
    if (end === -1) continue;
    const tagCode = code.slice(start, end + 1);

    const type = (attrValue(code, src, start, end, 'type') || '').trim().toLowerCase();
    if (NON_TEXT_TYPES.has(type)) continue;
    // A read-only / permanently disabled box is a display, not an ask.
    // BOTH tests read the ATTRIBUTE SKELETON, never the raw tag — see
    // `attrSkeleton`. `<Input disabled={disabled}>` is a CONDITIONALLY disabled
    // control, i.e. one the user can type into, and reading its own identifier
    // as the attribute name made 26 real sites structurally invisible.
    const skel = attrSkeleton(tagCode);
    if (isPermanentlyOff(skel, tagCode, 'readOnly') || isPermanentlyOff(skel, tagCode, 'readonly')) continue;
    if (isPermanentlyOff(skel, tagCode, 'disabled')) continue;

    const field = enclosingField(code, start);
    const label = field ? attrValue(code, src, field.start, field.end, 'label') : null;
    const hint = field ? attrValue(code, src, field.start, field.end, 'hint') : null;
    const adjacent = adjacentLabel(code, start);

    const placeholder = attrValue(code, src, start, end, 'placeholder');
    const defaultValue = attrValue(code, src, start, end, 'defaultValue');
    const aria = attrValue(code, src, start, end, 'aria-label') ?? attrValue(code, src, start, end, 'ariaLabel');
    const id = domKeyless(attrValue(code, src, start, end, 'id'));
    const nameAttr = domKeyless(attrValue(code, src, start, end, 'name'));
    const bound = attrValue(code, src, start, end, 'value');

    // NAME evidence is deliberately narrower than SHAPE evidence: it excludes
    // the placeholder, which is example data, and the bound expression is
    // de-camel-cased so `logicAppResourceId` reads as `logic App Resource Id`.
    const nameEvidence = [label, hint, adjacent, aria, id, nameAttr, decamel(bound)]
      .filter(Boolean)
      .join(' │ ');
    const shapeEvidence = [placeholder, defaultValue, label, hint, adjacent, aria].filter(Boolean).join(' │ ');

    const shape = SHAPE_PATTERNS.filter((p) => p.re.test(shapeEvidence)).map((p) => p.id);
    if (type === 'password') shape.push('password-field');
    const nameHits = NAME_PATTERNS.filter((p) => p.re.test(nameEvidence)).map((p) => p.id);
    const { shape: shapeKept, name: nameKept } = suppress(shape, nameHits, label ?? adjacent ?? aria, `${nameEvidence} │ ${shapeEvidence}`);

    sites.push({
      offset: start,
      tag,
      shape: shapeKept,
      name: nameKept,
      evidence: (nameEvidence || shapeEvidence || '(no label, hint, placeholder or aria-label)').slice(0, 200),
    });
  }
  return sites;
}

/** `logicAppResourceId` -> `logic App Resource Id`, so NAME patterns that are
 *  written in prose still match an identifier binding. */
function decamel(s) {
  if (!s) return s;
  return String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[._]/g, ' ');
}

/**
 * Strip TEMPLATE INTERPOLATIONS out of an `id`/`name` attribute, because an
 * interpolated segment is a DOM uniqueness key rather than a statement about
 * what the field wants. ``<Input id={`user-${row.armResourceId}`}>`` names the
 * ROW; the field under it is a SQL login.
 *
 * STRIPS rather than NULLS (review #3579). Dropping the whole attribute would
 * also discard the LITERAL half, so a future ``id={`endpoint-${i}`}`` would
 * lose "endpoint" as evidence — a false negative introduced by a narrowing
 * aimed at a false positive. Keeping the literal text costs nothing: measured
 * at 243 either way.
 *
 * MEASURED before it was written (probe over all 1,286 tracked .tsx): the tree
 * has exactly five templated `id`/`name` attributes on a free-text site. Three
 * (`${baseId}-name`, `${baseId}-title`, `${baseId}-name` in the report panes)
 * produce no NAME hit either way, so they are unaffected in both directions.
 * The other two are `add-existing-wizard.tsx`'s Username and Password rows,
 * which matched `resource-id` on the interpolated ARM id and on nothing else —
 * i.e. this narrowing changes exactly the two classifications it was written
 * for, and controls pin that it cannot widen.
 *
 * A LITERAL id is untouched: `id="cmk-uri"` on the AI Search CMK form is the
 * only label that site carries.
 */
function domKeyless(v) {
  if (!v || !v.includes('${')) return v;
  const stripped = v.replace(/\$\{[^{}]*\}/g, ' ').trim();
  return stripped || null;
}

/**
 * Drop a hit that is not about infrastructure, in strict precedence order.
 *
 *   1. Any SHAPE evidence that is not itself weak — an `abfss://`, an ARM id, a
 *      connection string, an Azure FQDN, a GUID, `type="password"` — WINS
 *      outright. No suppression can hide a value whose own syntax gave it away.
 *   2. Otherwise, if the LABEL says the field is not infrastructure, drop
 *      everything. A label is the surface's promise about what it wants; an
 *      adjacent hint is not. `<Field label="Git repository URL" hint="… store an
 *      access token below">` matched `secret-value` off that hint alone, which
 *      is contamination, not evidence.
 *   3. Otherwise, if the wider evidence says so, drop the WEAK ids only.
 */
function suppress(shape, name, label, evidence) {
  if (shape.some((id) => !WEAK_IDS.has(id))) return { shape, name };
  if (label && NOT_INFRA_RE.test(label)) return { shape: [], name: [] };
  if (!NOT_INFRA_RE.test(evidence)) return { shape, name };
  return { shape: shape.filter((id) => !WEAK_IDS.has(id)), name: name.filter((id) => !WEAK_IDS.has(id)) };
}

// ── 2c. descriptor-driven forms ────────────────────────────────────────────

/**
 * A generic form renderer fed by an array of field descriptors has no
 * `<Input placeholder=`. `lib/components/pipeline/manage-panel.tsx` is the live
 * example and it carries TWO `AccountKey=`/`AccountEndpoint=` connection-string
 * placeholders — i.e. the single worst member of the population is invisible to
 * an element-only scanner.
 *
 * A descriptor is an object literal with BOTH a `label:` (or `placeholder:`)
 * and a `key:`/`name:`/`id:`, and WITHOUT `options:`/`choices:`/`items:` (which
 * would make it a picker, the compliant shape). Matched over the masked code
 * for structure with values read from `src`, same as the JSX path.
 */
const DESCRIPTOR_RE = /\{[^{}]*\}/g;

export function extractDescriptors(src) {
  const code = maskJsx(src);
  const out = [];
  let m;
  DESCRIPTOR_RE.lastIndex = 0;
  while ((m = DESCRIPTOR_RE.exec(code)) !== null) {
    const start = m.index;
    const end = start + m[0].length - 1;
    const struct = m[0];
    if (!/\b(?:label|placeholder)\s*:/.test(struct)) continue;
    if (!/\b(?:key|name|id|field)\s*:/.test(struct)) continue;
    if (/\b(?:options|choices|items|values|children)\s*:/.test(struct)) continue;

    const read = (prop) => {
      const pm = struct.match(new RegExp(`\\b${prop}\\s*:\\s*`));
      if (!pm) return null;
      const at = start + pm.index + pm[0].length;
      const q = code[at];
      if (q !== '"' && q !== "'" && q !== '`') return null;
      const close = code.indexOf(q, at + 1);
      if (close === -1 || close > end) return null;
      return src.slice(at + 1, close);
    };

    const label = read('label');
    const placeholder = read('placeholder');
    const hint = read('hint') ?? read('description');
    const key = read('key') ?? read('name');
    const secret = /\bsecret\s*:\s*true\b/.test(struct);

    // A DISPLAY ROW, not an ask. `{ key: 'fqdn', label: 'Server FQDN', value:
    // cfg.server.fqdn }` is the descriptor form of the shape this guard's own
    // control already calls compliant — "a READ-ONLY display of a resolved
    // endpoint is a receipt, not an ask". The canonical instance is
    // `UriRow` in `lib/components/shared/details-panel.tsx`
    // (`{ key, label, value, href?, mono? }`), which `UriRowView` renders as a
    // caption plus a Copy button — no input of any kind.
    //
    // MEASURED before it was written: 26 descriptor hits, of which 5 have this
    // exact shape — the Event Hubs / Service Bus namespace endpoints, the
    // Lakebase server FQDN, the ML model artifact URI and the model-serving
    // scoring URI, all rendered into a read-only "Endpoints" list.
    //
    // FOUR DISQUALIFIERS, not one. Review (#3579) found that keying on `value:`
    // ALONE would also exempt a CONTROLLED INPUT bound to form state —
    // `{ key: 'conn', label: 'Connection string', value: form.conn, onChange:
    // setConn }` — because a bound expression looks identical either way. No
    // such descriptor exists in the tree today, so nothing was concealed, but a
    // permanent exemption on a shape that exists elsewhere in this codebase is
    // a hole waiting for its first occupant. The editable sibling of `UriRow`
    // proves the discriminator is structural rather than incidental: `PolicyRow`
    // in the same file is inline-editable and carries `onSave:`. So an
    // EDITABILITY MARKER of any kind disqualifies:
    //
    //   placeholder:  example data implies a box to type it into
    //   secret:       already the strongest descriptor signal there is
    //   on[A-Z]       any handler — onChange / onSave / onCommit / onBlur
    //   required:     only a field the user must FILL can be required
    //
    // Adding the last two costs ZERO sites (243 before and after) and closes
    // all four of the review's probes. `manage-panel.tsx`'s `{ key:
    // 'accessKeyId', label: 'Access key ID', required: true }` — a real ask
    // with no placeholder — was already untouched and stays so.
    //
    // `struct` is MASKED, so a quoted default (`value: 'prod'`) reads as `''`
    // and is correctly NOT treated as a resolved display.
    const valueProp = struct.match(/\bvalue\s*:\s*([^,}]*)/);
    const rendersResolvedValue =
      !!valueProp && valueProp[1].trim() !== '' && !/^['"`]/.test(valueProp[1].trim());
    const isEditableDescriptor =
      /\bplaceholder\s*:/.test(struct) ||
      /\bsecret\s*:/.test(struct) ||
      /\bon[A-Z]/.test(struct) ||
      /\brequired\s*:/.test(struct);
    if (rendersResolvedValue && !isEditableDescriptor) continue;

    const nameEvidence = [label, hint, decamel(key)].filter(Boolean).join(' │ ');
    const shapeEvidence = [placeholder, label, hint].filter(Boolean).join(' │ ');
    const shape = SHAPE_PATTERNS.filter((p) => p.re.test(shapeEvidence)).map((p) => p.id);
    if (secret) shape.push('secret-descriptor');
    const nameHits = NAME_PATTERNS.filter((p) => p.re.test(nameEvidence)).map((p) => p.id);
    const kept = suppress(shape, nameHits, label, `${nameEvidence} │ ${shapeEvidence}`);
    if (!kept.shape.length && !kept.name.length) continue;

    out.push({
      offset: start,
      tag: 'descriptor',
      shape: kept.shape,
      name: kept.name,
      evidence: (nameEvidence || shapeEvidence).slice(0, 200),
    });
  }
  return out;
}

// ── 2d. the file-level verdict ─────────────────────────────────────────────

/**
 * @returns {{sites:number, violations:{line:number,tag:string,kind:string,why:string,evidence:string,text:string}[]}}
 */
export function analyze(src) {
  const jsx = extractSites(src);
  const desc = extractDescriptors(src);
  const violations = [];
  const seen = new Set();

  for (const s of [...jsx, ...desc]) {
    if (!s.shape.length && !s.name.length) continue;
    if (seen.has(s.offset)) continue;
    seen.add(s.offset);
    const kind = s.shape.length ? 'shape' : 'name';
    const ids = s.shape.length ? s.shape : s.name;
    const table = s.shape.length ? SHAPE_PATTERNS : NAME_PATTERNS;
    const why = ids
      .map((id) => (id === 'password-field' ? 'a secret typed in clear (type="password")'
        : id === 'secret-descriptor' ? 'a descriptor field marked secret:true'
          : table.find((p) => p.id === id)?.why ?? id))
      .join('; ');
    violations.push({
      line: lineOf(src, s.offset),
      tag: s.tag,
      kind,
      ids,
      why,
      evidence: s.evidence,
      text: srcLine(src, s.offset),
    });
  }
  violations.sort((a, b) => a.line - b.line);
  return { sites: jsx.length, violations };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. EMBEDDED CONTROLS — run BEFORE the repo is judged.
//
// The first six are the operator-filed surfaces of 2026-08-14, byte-for-byte
// from the tree. A control set that cannot reproduce the incidents cannot prove
// the guard would have caught them — which is precisely how the previous
// version passed for months while all six shipped.
// ═══════════════════════════════════════════════════════════════════════════

/** activator-editor.tsx:883-885 — the ADX cluster URI. */
const OP_ACTIVATOR_ADX = `<Field label="Cluster (optional override)" style={{ flex: 1, minWidth: 240 }} hint={adxDefaultCluster ? \`Default: \${adxDefaultCluster}\` : 'Resolved from LOOM_KUSTO_CLUSTER_URI'}>
  <Input placeholder="https://<cluster>.<region>.kusto.windows.net" value={adxCluster} onChange={(_: unknown, d: any) => setAdxCluster(d.value)} />
</Field>`;

/** activator-editor.tsx:1085-1087 — the Logic App ARM id. */
const OP_ACTIVATOR_LOGICAPP = `<Field label="Logic App resource id" hint="Microsoft.Logic/workflows resource id (Consumption workflow with an HTTP trigger).">
  <Input placeholder="/subscriptions/.../providers/Microsoft.Logic/workflows/wf-alert" value={actLogicAppResourceId} onChange={(_: unknown, d: any) => setActLogicAppResourceId(d.value)} />
</Field>`;

/** health-check-editor.tsx:802-804 — the same ARM id, in a repeated row whose
 *  label is EMPTY for every row after the first. The placeholder is the only
 *  evidence there, which is why SHAPE reads the placeholder and NAME does not. */
const OP_HEALTHCHECK_LOGICAPP = `<Field label={i === 0 ? 'Logic App resource id' : ''} style={{ flex: 1, minWidth: 320 }}>
  <Input value={r.resourceId} onChange={(_, d) => setLogicApps((arr) => arr.map((x, j) => (j === i ? { ...x, resourceId: d.value } : x)))} placeholder="/subscriptions/…/providers/Microsoft.Logic/workflows/notify" />
</Field>`;

/** uc-dialogs.tsx:1972-1990 — the Databricks Unity Catalog credential dialog:
 *  a host FQDN and a clear-text password. */
const OP_UC_CREDENTIAL = `<Field label="Host" required style={{ flex: 1, minWidth: 240 }}><Input value={cHost} onChange={(_, d) => setCHost(d.value)} placeholder="myserver.database.windows.net" /></Field>
<Field label="Password value" required style={{ flex: 1, minWidth: 220 }}><Input type="password" value={cPassword} onChange={(_, d) => setCPassword(d.value)} /></Field>`;

/** catalog/unity/page.tsx:1166-1172 — the storage-credential dialog's Access
 *  Connector ARM id. The platform DEPLOYS that connector; asking for its id is
 *  `auto-bind-by-default.md` §5 verbatim. */
const OP_UC_STORAGE_CREDENTIAL = `<Field required label={oss ? 'Managed identity / connector resource id' : 'Access Connector ARM id'}
  hint={oss ? 'The identity loom-unity vends credentials for' : '/subscriptions/…/providers/Microsoft.Databricks/accessConnectors/…'}>
  <Input value={connector} onChange={(_, d) => setConnector(d.value)} placeholder="/subscriptions/…/accessConnectors/lake-connector" />
</Field>`;

/** foundry-sub-editors.tsx:743-746 — "New evaluation". NO `<Field>` anywhere:
 *  the label is an adjacent `<span>`, which is why `adjacentLabel` exists. */
const OP_NEW_EVALUATION = `<span>Display name</span><Input value={form.displayName} onChange={(_, d) => setForm((f) => ({ ...f, displayName: d.value }))} />
<span>Dataset ID</span><Input value={form.datasetId} onChange={(_, d) => setForm((f) => ({ ...f, datasetId: d.value }))} placeholder="azureml://datastores/.../paths/..." />`;

/** copilot-studio-editors.tsx:675-677 — the knowledge-source URI. */
const OP_COPILOT_STUDIO_URI = `<Field label="URI / location" hint="URL, file URI, SharePoint site URL, or Dataverse table logical name">
  <Input value={form.uri} onChange={(_, d) => setForm((f) => ({ ...f, uri: d.value }))} />
</Field>`;

/** pipeline/manage-panel.tsx:79 — a DESCRIPTOR, not an element. The worst
 *  member of the population (`AccountKey=` in clear) and structurally invisible
 *  to any scanner that only reads JSX attributes. */
const OP_DESCRIPTOR_CONNSTRING = `const LS = [
  { key: 'connectionString', label: 'Connection string', secret: true, required: true, placeholder: 'DefaultEndpointsProtocol=https;AccountName=…;AccountKey=…' },
];`;

export const CONTROLS = [
  // ── THE SIX OPERATOR-FILED SURFACES — MUST FLAG ────────────────────────
  { name: 'OPERATOR 2026-08-14 #1 — activator editor: typed ADX cluster URI', src: OP_ACTIVATOR_ADX, expect: true },
  { name: 'OPERATOR 2026-08-14 #1b — activator editor: typed Logic App ARM id', src: OP_ACTIVATOR_LOGICAPP, expect: true },
  { name: 'OPERATOR 2026-08-14 #2 — health-check editor: typed Logic App ARM id (label EMPTY on repeat rows)', src: OP_HEALTHCHECK_LOGICAPP, expect: true },
  { name: 'OPERATOR 2026-08-14 #3 — Databricks UC credential dialog: host FQDN + clear-text password', src: OP_UC_CREDENTIAL, expect: true },
  { name: 'OPERATOR 2026-08-14 #3b — UC storage credential: Access Connector ARM id', src: OP_UC_STORAGE_CREDENTIAL, expect: true },
  { name: 'OPERATOR 2026-08-14 #4 — "New evaluation": azureml:// dataset id, label in an adjacent <span>', src: OP_NEW_EVALUATION, expect: true },
  { name: 'OPERATOR 2026-08-14 #5 — Copilot Studio knowledge source: typed URI / location', src: OP_COPILOT_STUDIO_URI, expect: true },
  { name: 'OPERATOR 2026-08-14 #6 — descriptor-driven form: AccountKey= connection string', src: OP_DESCRIPTOR_CONNSTRING, expect: true },
  {
    // The filed report said the AccountKey was in the Databricks dialog. It is
    // not; it is here, as a JSX placeholder. Both shapes are controls so the
    // correction in the header cannot drift away from the code.
    name: 'OPERATOR 2026-08-14 #6b — the OTHER literal AccountKey: an ai-search JSX placeholder',
    src: '<Input size="small" value={cKsConn} onChange={(_, d) => setCKsConn(d.value)} placeholder="DefaultEndpointsProtocol=https;AccountName=…;AccountKey=…;" />',
    expect: true,
  },

  // ── other shapes that must flag ────────────────────────────────────────
  { name: 'bad: abfss:// storage location', src: '<Field label="Storage location" hint="abfss://… — must sit under a UC external location"><Input value={v} onChange={f} /></Field>', expect: true },
  { name: 'bad: a Key Vault URI', src: '<Input placeholder="https://myvault.vault.azure.net/secrets/x" value={v} onChange={f} />', expect: true },
  { name: 'bad: a Service Bus connection string', src: '<Input placeholder="Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=…" value={v} onChange={f} />', expect: true },
  { name: 'bad: a bare GUID placeholder (subscription / tenant id)', src: '<Input placeholder="00000000-0000-0000-0000-000000000000" value={v} onChange={f} />', expect: true },
  { name: 'bad: an <input> (lowercase HTML) with an ARM id placeholder', src: '<input placeholder="/subscriptions/abc/resourceGroups/rg" value={v} onChange={f} />', expect: true },
  { name: 'bad: a Textarea asking for a connection string', src: '<Field label="Connection string"><Textarea value={v} onChange={f} /></Field>', expect: true },
  { name: 'bad: NAME evidence only, via the bound identifier', src: '<Input value={form.logicAppResourceId} onChange={f} />', expect: true },
  { name: 'bad: sovereign host suffix (cloud-parity — a Gov-only ask is the same defect)', src: '<Input placeholder="https://c.eastus.kusto.usgovcloudapi.net" value={v} onChange={f} />', expect: true },
  { name: 'bad: an onChange arrow inside the tag must not truncate the element before its placeholder', src: '<Input onChange={(e) => setX(e.target.value > 0 ? 1 : 2)} placeholder="abfss://c@a.dfs.core.windows.net/p" />', expect: true },

  // ── MUST NOT FLAG ──────────────────────────────────────────────────────
  { name: 'good: a display name', src: '<Field label="Display name"><Input value={name} onChange={f} /></Field>', expect: false },
  { name: 'good: a description Textarea', src: '<Field label="Description"><Textarea value={d} onChange={f} /></Field>', expect: false },
  { name: 'good: a catalog name with an example placeholder', src: '<Field label="Catalog name" required><Input value={catName} onChange={f} placeholder="sales" /></Field>', expect: false },
  { name: 'good: a tag key/value row — bare "key" is NOT a secret', src: '<Input value={r.key} placeholder="key (e.g. team)" aria-label="Tag 1 key" onChange={f} />', expect: false },
  { name: 'good: a search box', src: '<Input placeholder="Search catalogs…" value={q} onChange={f} />', expect: false },
  { name: 'good: a comment field', src: '<Field label="Comment"><Input value={c} onChange={f} /></Field>', expect: false },
  {
    name: 'good: THE REMEDIATION SHAPE — a Dropdown fed by a discovery call is not a site at all',
    src: '<Field label="ADX cluster"><Dropdown placeholder="Select a cluster">{clusters.map((c) => <Option key={c.uri} value={c.uri}>{c.name}</Option>)}</Dropdown></Field>',
    expect: false,
  },
  {
    name: 'good: a READ-ONLY display of a resolved endpoint is a receipt, not an ask',
    src: '<Field label="Cluster URI"><Input readOnly value={resolvedClusterUri} /></Field>',
    expect: false,
  },
  {
    name: 'good: a picker DESCRIPTOR (has options:) is the compliant shape',
    src: "const F = [{ key: 'region', label: 'Region', options: REGIONS, placeholder: 'Select a region' }];",
    expect: false,
  },
  { name: 'prose in a // comment must not create a violation', src: '// never ask for an abfss:// path or a /subscriptions/ id in an <Input>', expect: false },
  {
    name: 'prose in a block comment must not create a violation',
    src: '/**\n * <Input placeholder="abfss://c@a.dfs.core.windows.net/p" /> is forbidden\n */\nconst a = 1;',
    expect: false,
  },
  {
    name: 'prose mentioning the pattern must not hide a REAL site on a later line',
    src: '// explains <Input placeholder="abfss://x" />\n<Input placeholder="abfss://c@a.dfs.core.windows.net/p" value={v} onChange={f} />',
    expect: true,
  },
  {
    name: 'a sibling Field that has already CLOSED must not lend its label to the next input',
    src: '<Field label="Logic App resource id"><Input value={a} onChange={f} /></Field>\n<Field label="Display name"><Input value={b} onChange={f} /></Field>',
    expect: true, // exactly ONE — asserted by count in selfTest()
  },
  {
    name: 'JSX LEXER — a self-closing `/>` before the violating element must not blank it (the TS-only sibling lexer does exactly this)',
    src: '<Input value={a} onChange={f} />\n<Input placeholder="abfss://c@a.dfs.core.windows.net/p" value={b} onChange={f} />',
    expect: true,
  },
  {
    name: 'JSX LEXER — an intra-word apostrophe in JSX text is prose, not a string opener that blanks the label after it',
    src: "<Caption1>don't type this</Caption1><Field label=\"Cluster URI\"><Input value={v} onChange={f} /></Field>",
    expect: true,
  },

  // ── #3594 — storage-loc must not need the generic noun `storage` ────────
  // The first of these already flagged before #3594; the rest did not, and they
  // are the same ask in this codebase's own vocabulary. Kept as controls so the
  // widening cannot silently regress back to the generic-noun spelling.
  { name: '#3594 — "Storage location" flags (it always did)', src: '<Field label="Storage location"><Input value={x} onChange={f} /></Field>', expect: true },
  { name: '#3594 — "ADLS Gen2 location" flags (it did NOT before)', src: '<Field label="ADLS Gen2 location"><Input value={shortcutLocation} onChange={f} /></Field>', expect: true },
  { name: '#3594 — "ADLS subpath" flags (it did NOT before)', src: '<Field label="ADLS subpath"><Input value={shortcutSubpath} onChange={f} /></Field>', expect: true },
  { name: '#3594 — "OneLake path" flags', src: '<Field label="OneLake path"><Input value={p} onChange={f} /></Field>', expect: true },
  { name: '#3594 — "Lakehouse path" flags', src: '<Field label="Lakehouse path"><Input value={p} onChange={f} /></Field>', expect: true },
  // …and the OTHER direction. A widening is only safe if it did not simply
  // start matching the word "storage" anywhere: a SKU/tier field names the
  // service without asking for an address.
  { name: '#3594 — "Storage tier" must NOT flag (widening did not become "any mention of storage")', src: '<Field label="Storage tier"><Input value={t} onChange={f} /></Field>', expect: false },
  { name: '#3594 — "Display name" must NOT flag', src: '<Field label="Display name"><Input value={n} onChange={f} /></Field>', expect: false },

  // ── #3598 — the `readOnly` branch is LOAD-BEARING, not dead code ────────
  // A comment in this file used to assert `readOnly={readOnly}` "measured ZERO
  // occurrences today". There are 16, across 7 files. These controls pin the
  // BEHAVIOUR the corrected prose describes, so the claim cannot rot back:
  // a CONDITIONALLY read-only control is one the user can type into, and must
  // still be classified; only a PERMANENTLY read-only one is a receipt.
  {
    name: '#3598 — readOnly={readOnly} is CONDITIONAL: the user can type, so the site still counts',
    src: '<Field label="Cluster URI"><Input readOnly={readOnly} value={v} onChange={f} /></Field>',
    expect: true,
  },
  {
    name: '#3598 — readOnly={false} is editable and must count',
    src: '<Field label="Cluster URI"><Input readOnly={false} value={v} onChange={f} /></Field>',
    expect: true,
  },
  // The corrected characterisation of the `disabled` hole: the old regex needed
  // the literal word SOMEWHERE INSIDE the braces, so ANY expression mentioning
  // it suppressed the site — not only the self-named idiom. Both shapes must
  // now be classified.
  {
    name: '#3598 — disabled={disabled} is conditional and must count',
    src: '<Field label="Cluster URI"><Input disabled={disabled} value={v} onChange={f} /></Field>',
    expect: true,
  },
  {
    name: '#3598 — disabled={busy || disabled} must count too (the old regex suppressed this as well)',
    src: '<Field label="Cluster URI"><Input disabled={busy || disabled} value={v} onChange={f} /></Field>',
    expect: true,
  },
  {
    name: '#3598 — a BARE `disabled` is still permanently off and must NOT count',
    src: '<Field label="Cluster URI"><Input disabled value={v} /></Field>',
    expect: false,
  },

  // ── the WEAK-tier suppression, both directions ─────────────────────────
  {
    name: 'good: an <img src> URL in a report the user is designing is CONTENT, not infrastructure',
    src: '<Field label="Image URL"><Input value={el.src} placeholder="https://…" onChange={f} /></Field>',
    expect: false,
  },
  {
    name: "good: the user's own git remote cannot be discovered, so asking is not this defect",
    src: '<Field label="Remote Git URL"><Input value={repoUrl} onChange={f} /></Field>',
    expect: false,
  },
  { name: 'good: an APIM route template is API design, not an address', src: '<Field label="URL template (appended to the API path)"><Input value={t} onChange={f} /></Field>', expect: false },
  {
    name: 'bad: the suppression must NOT cover a strong signal — an Image URL pointing at a storage account still fails',
    src: '<Field label="Image URL"><Input value={el.src} placeholder="https://acct.blob.core.windows.net/img/x.png" onChange={f} /></Field>',
    expect: true,
  },
  {
    name: 'good: a DB primary key is not a secret — "primary key" cost four FPs and caught nothing real',
    src: '<Field label="Primary key column(s)" hint="Comma-separated. Must match the source table\'s primary key."><Input value={pk} onChange={f} /></Field>',
    expect: false,
  },
  {
    name: "good: a git URL whose HINT mentions an access token — the LABEL is the promise, an adjacent hint is contamination",
    src: '<Field label="Git repository URL" hint="https repo on github.com. Private repos: store an access token below."><Input value={g} onChange={f} /></Field>',
    expect: false,
  },

  // ── the azure-host DNS-LABEL BOUNDARY, both directions (#3560 CodeQL) ───
  {
    name: 'good: a host that merely CONTAINS an Azure suffix is not one — `.azconfig.iowa` is not `.azconfig.io`',
    src: '<Input placeholder="x.azconfig.iowa" value={v} onChange={f} />',
    expect: false,
  },
  {
    name: 'good: suffix confusion — `kusto.windows.net.evil.test` is not an Azure host',
    src: '<Input placeholder="https://loom.kusto.windows.net.evil.test/steal" value={v} onChange={f} />',
    expect: false,
  },
  {
    name: 'bad: the boundary must not cost SENTENCE-FINAL prose — a host ending a hint still counts',
    src: '<Field label="Cluster" hint="the host is a.dfs.core.windows.net. Then click save."><Input value={v} onChange={f} /></Field>',
    expect: true,
  },

  // ── the two WAVE-1B narrowings, both directions ────────────────────────
  {
    // add-existing-wizard.tsx writes `id={`user-${row.armResourceId}`}` to keep
    // the <Label htmlFor> unique per adopted resource. That interpolation made
    // a SQL login and a password read as `resource-id` asks.
    name: 'good: a templated `id` is a DOM uniqueness key, not a field name',
    src: '<Label htmlFor={`user-${r.armResourceId}`}>Username</Label><Input id={`user-${r.armResourceId}`} value={st.username} placeholder="SQL login or AAD username" onChange={f} />',
    expect: false,
  },
  {
    name: 'bad: a LITERAL id is still the only label some sites carry — the narrowing must not reach it',
    src: '<Input id="cmk-uri" value={cmkKeyVaultUri} onChange={f} />',
    expect: true,
  },
  {
    // STRIPPING, not nulling: the literal half of a templated id is still
    // evidence. Nulling the attribute would turn this into a false negative.
    name: 'bad: the LITERAL half of a templated id survives — `endpoint-${i}` still reads as "endpoint"',
    src: '<Input id={`endpoint-${i}`} value={rows[i].v} onChange={f} />',
    expect: true,
  },
  {
    name: 'good: a descriptor rendering a RESOLVED value is a receipt, not an ask',
    src: "const rows = [{ key: 'fqdn', label: 'Server FQDN', value: cfg.server.fqdn }];",
    expect: false,
  },
  {
    name: 'bad: a descriptor with a placeholder still flags even though it also carries a value',
    src: "const F = [{ key: 'conn', label: 'Connection string', value: form.conn, placeholder: 'AccountKey=…' }];",
    expect: true,
  },
  {
    name: 'bad: a descriptor with no placeholder and no value is a real ask (manage-panel\'s access key id)',
    src: "const F = [{ key: 'accessKeyId', label: 'Access key ID', required: true }];",
    expect: true,
  },
  {
    name: 'bad: a descriptor whose `value` is a quoted DEFAULT is an ask with a default, not a display',
    src: "const F = [{ key: 'clusterUri', label: 'Cluster URI', value: 'https://c.kusto.windows.net' }];",
    expect: true,
  },

  // ── the descriptor EDITABILITY disqualifiers (#3579 review) ─────────────
  // A bound `value:` looks identical on a read-only display row and on a
  // CONTROLLED INPUT. Without these four probes the display-row rule would be a
  // permanent exemption on a shape that exists elsewhere in this codebase —
  // `PolicyRow` in details-panel.tsx is exactly it, marked by `onSave:`.
  {
    name: 'bad: a controlled-input descriptor (value + onChange) is an ASK, not a display',
    src: "const F = [{ key: 'conn', label: 'Connection string', value: form.conn, onChange: setConn }];",
    expect: true,
  },
  {
    name: 'bad: a controlled-input descriptor for a storage account key',
    src: "const F = [{ key: 'accountKey', label: 'Storage account key', value: form.accountKey, onChange: setK }];",
    expect: true,
  },
  {
    name: 'bad: a controlled-input descriptor for an ARM workspace id',
    src: "const F = [{ key: 'wsId', label: 'Workspace resource ID', value: form.wsId, onChange: setW }];",
    expect: true,
  },
  {
    name: 'bad: `required:` alone disqualifies a display row — only a field you FILL can be required',
    src: "const F = [{ key: 'clusterUri', label: 'Cluster URI', value: form.clusterUri, required: true }];",
    expect: true,
  },
  {
    name: 'bad: the inline-editable sibling shape — PolicyRow carries onSave, not onChange',
    src: "const P = [{ key: 'endpoint', label: 'Namespace endpoint', value: ns.endpoint, onSave: patch }];",
    expect: true,
  },
  {
    name: 'good: a DetailsPanel UriRow — value + href + mono, no editability marker anywhere',
    src: "const U = [{ key: 'fqdn', label: 'Server FQDN', value: cfg.server.fqdn, href: link, mono: true }];",
    expect: false,
  },

  // ── the disabled/readOnly BRACE HOLE, both directions (#3579, wave 1C) ───
  // `(?:^|[\s{])disabled\b(?!\s*=)` matched the IDENTIFIER INSIDE the braces of
  // `disabled={disabled}`, so a conditionally-disabled control read as a
  // permanently-disabled one and was dropped before classification. 27 sites.
  // The same hole existed on `readOnly` via hasTruthyProp — 25 more.
  {
    name: 'bad: `disabled={disabled}` is CONDITIONALLY disabled — the user can type in it',
    src: '<Field label="Cluster URI"><Input disabled={disabled} value={v} onChange={f} /></Field>',
    expect: true,
  },
  // The three shapes below are what make `attrSkeleton` LOAD-BEARING rather
  // than belt-and-braces. Re-anchoring the regex from `[\s{]` to `\s` alone
  // fixes the TIGHT `disabled={disabled}` and nothing else: put a space inside
  // the braces, use the spread shorthand, or write any compound expression
  // ending in the identifier, and the whitespace anchor matches again. Measured
  // by disabling the skeleton and watching the verdict NOT move — which is how
  // a "fix" that only covered one spelling nearly shipped here.
  {
    name: 'bad: `disabled={ disabled }` — a space inside the braces defeats a whitespace anchor',
    src: '<Field label="Cluster URI"><Input disabled={ disabled } value={v} onChange={f} /></Field>',
    expect: true,
  },
  {
    name: 'bad: `disabled={a && disabled}` — a compound expression, the common React shape',
    src: '<Field label="Cluster URI"><Input disabled={busy && disabled} value={v} onChange={f} /></Field>',
    expect: true,
  },
  {
    name: 'bad: `readOnly={ readOnly }` — the same, on the sibling prop',
    src: '<Field label="Cluster URI"><Input readOnly={ readOnly } value={v} onChange={f} /></Field>',
    expect: true,
  },
  {
    name: 'bad: `readOnly={readOnly}` is CONDITIONALLY read-only — same hole, sibling prop',
    src: '<Field label="Cluster URI"><Input readOnly={readOnly} value={v} onChange={f} /></Field>',
    expect: true,
  },
  {
    name: 'bad: an expression-valued disabled is a site — `{busy}` never tripped the old regex either',
    src: '<Field label="Storage account key"><Input disabled={busy} value={v} onChange={f} /></Field>',
    expect: true,
  },
  {
    name: 'good: a BARE `disabled` still skips — the fix must not cost the 6 real ones',
    src: '<Field label="Cluster URI"><Input disabled value={v} onChange={f} /></Field>',
    expect: false,
  },
  {
    name: 'good: a BARE `readOnly` still skips — 36 real ones in the tree depend on it',
    src: '<Field label="Cluster URI"><Input readOnly value={v} onChange={f} /></Field>',
    expect: false,
  },
  {
    name: 'good: an EXPLICIT `disabled={true}` is permanently off, not an ask',
    src: '<Field label="Cluster URI"><Input disabled={true} value={v} onChange={f} /></Field>',
    expect: false,
  },
  {
    name: 'bad: `disabled={false}` is enabled — it must NOT read as permanently off',
    src: '<Field label="Cluster URI"><Input disabled={false} value={v} onChange={f} /></Field>',
    expect: true,
  },
  {
    name: 'good: an onChange arrow body containing the word `disabled` must not disable the element',
    src: '<Field label="Display name"><Input value={v} onChange={(e) => setDisabled(e.disabled)} /></Field>',
    expect: false,
  },
];

export function selfTest() {
  const failures = [];
  for (const c of CONTROLS) {
    const got = analyze(c.src).violations.length > 0;
    if (got !== c.expect) failures.push(`${c.name} — expected violation=${c.expect}, got ${got}`);
  }

  // Contamination control: the second Field is clean, so the pair must yield
  // exactly ONE hit. A backwards label search that ignored `</Field>` would
  // report two and quietly inflate every baselined file.
  const pair = analyze(
    '<Field label="Logic App resource id"><Input value={a} onChange={f} /></Field>\n<Field label="Display name"><Input value={b} onChange={f} /></Field>',
  ).violations;
  if (pair.length !== 1 || pair[0].line !== 1)
    failures.push(`Field-scope contamination — expected 1 hit on line 1, got ${JSON.stringify(pair.map((p) => p.line))}`);

  // Line mapping: a comment-aware mask that silently shifted offsets would
  // point every annotation at the wrong line.
  const mixed = analyze(
    '// explains <Input placeholder="abfss://x" />\n<Input placeholder="abfss://c@a.dfs.core.windows.net/p" value={v} onChange={f} />',
  ).violations;
  if (mixed.length !== 1 || mixed[0].line !== 2)
    failures.push(`line mapping drifted — expected 1 hit on line 2, got ${JSON.stringify(mixed)}`);

  // Site extraction must count the COMPLIANT inputs too, or MIN_FREETEXT_SITES
  // could never fire: a floor computed from violations only is not a floor.
  const sites = extractSites('<Input value={a} onChange={f} /><Textarea value={b} onChange={f} /><Dropdown />');
  if (sites.length !== 2) failures.push(`site extraction — expected 2 free-text sites, got ${sites.length}`);

  // The JSX lexer difference, pinned as a PROPERTY of the mask rather than only
  // as an end-to-end expectation. check-external-origin-urls' maskNonCode
  // returns `<Input value={a} onChange={f} /` + spaces here; if maskJsx ever
  // regresses to that behaviour the count above drops silently to 1, and a
  // future "reuse the sibling lexer" would read as a clean refactor.
  const masked = maskJsx('<Input value={a} onChange={f} /><Textarea value={b} onChange={f} />');
  if (!masked.includes('<Textarea'))
    failures.push('maskJsx blanked a JSX element after a self-closing `/>` — the regex heuristic is TS-only again');

  // The ACCEPTED table must satisfy its own rules, and the validator must be
  // able to REJECT — a validator that passes everything is the shape this repo
  // has shipped before. Mirrors check-python-cve-floors.mjs' pair of checks.
  const realProblems = validateAccepted();
  if (realProblems.length)
    failures.push(`the real ACCEPTED table does not satisfy its own rules: ${realProblems.join(' | ')}`);
  if (validateAccepted([{ file: 'f.tsx', sites: 1, kind: 'byo', why: 'w' }]).length === 0)
    failures.push('validateAccepted() passed an entry with NO ref — the reference rule is not enforced.');
  if (validateAccepted([{ file: 'f.tsx', kind: 'byo', ref: '#1', why: 'w' }]).length === 0)
    failures.push('validateAccepted() passed an entry with NO site count — the acceptance would be a blanket amnesty.');

  // applyAccepted must FAIL on drift in both directions, or the accepted files
  // (which leave the ratchet entirely) would be unwatched.
  if (applyAccepted({}, [{ file: 'f.tsx', sites: 1, kind: 'byo', ref: '#1', why: 'w' }]).problems.length === 0)
    failures.push('applyAccepted() did not fail on a STALE acceptance (no live site).');
  if (applyAccepted({ 'f.tsx': 2 }, [{ file: 'f.tsx', sites: 1, kind: 'byo', ref: '#1', why: 'w' }]).problems.length === 0)
    failures.push('applyAccepted() did not fail on a RISE inside an accepted file — the acceptance is an amnesty.');
  if (applyAccepted({ 'f.tsx': 1 }, [{ file: 'f.tsx', sites: 1, kind: 'byo', ref: '#1', why: 'w' }]).problems.length !== 0)
    failures.push('applyAccepted() failed on an EXACT match — a correct acceptance must pass.');

  return failures;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. MAIN
// ═══════════════════════════════════════════════════════════════════════════

const META = {
  owner: 'CSA Loom platform / UX',
  why:
    'no-freeform-config (BLOCKING): configuration is authored through dropdowns, wizards, pickers and ' +
    'canvases — a user does not hand-type a resource id, endpoint, cluster URI, connection string or key. ' +
    'auto-bind-by-default.md §5 says the platform DEPLOYS and BINDS the backing resource and wires the ' +
    'value; ux-baseline.md G2 says an unavoidable gate gets an inline Fix-it that SETS it. The baseline is ' +
    'the pre-existing population measured on 2026-08-14, when the operator filed six of these from a live ' +
    'walk and this guard reported 0 because it only read 4 tags in lib/editors. Each fix is product work — ' +
    'a picker backed by a real discovery call — so the population is frozen per file and only shrinks.',
  unblock:
    'node scripts/ci/check-no-freeform.mjs --update-baseline (run in the blocked PR with a one-line justification)',
};

/**
 * Touched-file (boy-scout) escape hatch: repo-relative path -> one-line reason a
 * PR may modify a baselined file WITHOUT fixing its sites.
 */
export const TOUCH_EXEMPT = new Map([
  // GHSA-v8r7-c2p5-mjf2 — the SQL panels (scale / restore / replication / share
  // / Entra-admin) now derive their ARM target from the item's bound connection,
  // so the editor must persist the server+database selection ON CHANGE rather
  // than only when a query runs; without that the security fix 409s legitimate
  // users, which is not a fix. The boy-scout rule requires a touched file to be
  // FULLY cleared, and its four sites cannot be: the Entra `sid` picker is real
  // work (a `principal-search`-fed picker), the PostgreSQL admin PASSWORD is a
  // credential no discovery call can supply (it needs the platform to mint and
  // Key Vault it, per auto-bind-by-default.md §5), and the ADF run-id receipt
  // needs a run-history picker. Tracked with acceptance criteria — including
  // DELETING this entry — in #3626, so this is a dated exception rather than a
  // permanent amnesty.
  [
    'apps/fiab-console/lib/editors/unified-sql-database-editor.tsx',
    'GHSA-v8r7-c2p5-mjf2 required binding the server selection here; the 4 sites need UI work tracked in #3626',
  ],
]);

// ═══════════════════════════════════════════════════════════════════════════
// 4a. ACCEPTED — sites that are a REVIEWED decision, not a backlog item
// ═══════════════════════════════════════════════════════════════════════════
//
// The baseline answers "is this population growing?". It cannot answer "is this
// population a DEFECT?", and two classes in it are not:
//
//   byo             the value describes a system Loom does not own and cannot
//                   enumerate — a customer's Snowflake account, their webhook
//                   receiver, a credential minted on someone else's tenant. No
//                   discovery call could supply it, so `auto-bind-by-default.md`
//                   does not apply and a picker is not the remediation.
//   false-positive  the classifier fired on evidence that is not an
//                   infrastructure ask, and the correction is not cheap enough
//                   to key a classifier rule on (see the two that WERE keyed:
//                   `domKeyless` and the descriptor display-row rule).
//
// Leaving both in the baseline is not free: it makes the boy-scout rule punish
// an innocent edit to a compliant file, which is how a guard gets ignored, and
// it hides how much of the 250 is actually work. Removing them silently is
// worse. So they are declared HERE, with a reason specific enough to argue
// with, and the guard prints every one on a green run.
//
// ── THE CONVENTION, AND THE ONE PLACE IT DEVIATES ──────────────────────────
// #3533 / #3531 established the shape for an accepted exception in this repo:
// an entry PRINTS on every green run (an exception nobody is reminded of is an
// exception nobody reviews), a STALE acceptance is itself a failure (the list
// cannot rot into a graveyard the way an ignore-file does), and
// `validateAccepted()` makes an incomplete entry impossible rather than leaving
// it to a reviewer. All three are implemented below, deliberately in the same
// shape rather than a private variant.
//
// It deviates in ONE field, stated rather than smuggled. #3533 requires `ref`
// to be a GitHub issue "naming the issue that closes it", because ITS
// acceptances are temporary — a starlette cap pending a fastapi migration, with
// acceptance criteria requiring the entry to be DELETED. A BYO acceptance has
// no closing condition: nobody will ever ship the discovery call that
// enumerates a customer's on-prem Airflow. Demanding `#NNNN` on it would
// manufacture an issue that can only be closed by deciding the rule no longer
// applies, which is the exact "exception nobody revisits" #3531 was written
// against. So `ref` here is REQUIRED and validated, and must be either a
// tracking issue (`#3542`) for a deferred fix, or the rule clause that permits
// the exception (`auto-bind-by-default.md §Allowed`) for a permanent one.
//
// ── THE TEETH ──────────────────────────────────────────────────────────────
// An accepted file leaves `current` entirely, so it is NOT in the baseline and
// the boy-scout rule cannot fire on it. `sites` is what keeps that from being a
// blanket amnesty: it must EQUAL the file's live classified count, so a new
// hand-typed endpoint added to a BYO file fails the run, and a fix that drains
// one fails it too until the number is corrected by a human. `--update-baseline`
// deliberately does NOT rewrite this table.

/** @typedef {{file:string, sites:number, kind:'byo'|'false-positive', ref:string, why:string}} Acceptance */

/** @type {Acceptance[]} */
export const ACCEPTED = [
  // ── BYO: a system Loom does not own and cannot enumerate ────────────────
  {
    file: 'apps/fiab-console/app/admin/migrate/page.tsx',
    sites: 3,
    kind: 'byo',
    ref: '#3586',
    why:
      'A source estate in another VENDOR or another TENANT: :176 is the workspace-or-group id INSIDE that ' +
      'system and :185 is a token minted THERE — Loom holds no credential for the source until they are ' +
      'supplied, so nothing could enumerate either. The token is already the compliant secret shape: it ' +
      'accepts an `@Microsoft.KeyVault(SecretUri=…)` reference and its hint records that the value is ' +
      'resolved server-side and never rendered back. ' +
      'PARTIAL, AND TRACKED IN #3586 — this is a deferred fix, not a permanent exception, which is why the ' +
      'ref is an issue rather than a rule clause. :170 is one Input whose label switches on sourceType, and ' +
      'the SNOWFLAKE branch is genuinely un-enumerable, but the DATABRICKS branch is not: ' +
      '`lib/azure/databricks-discovery.ts` exports listDatabricksWorkspaces(), which returns ' +
      '`properties.workspaceUrl` for every Microsoft.Databricks/workspaces the deployment identity can ' +
      'read, and two live BFF routes already consume it. An earlier revision of this entry claimed "no ' +
      'discovery call could enumerate any of them"; review (#3579) established that is false for that ' +
      'branch, and the same reasoning is why setup-identity-step.tsx was DECLINED rather than accepted. ' +
      'The fix is the hybrid this repo already ships twice (api-marketplace, workspace-egress-pane): a ' +
      'picker plus "Other / not in this estate".',
  },
  {
    file: 'apps/fiab-console/lib/components/access/request-access-button.tsx',
    sites: 2,
    kind: 'byo',
    ref: 'auto-bind-by-default.md §Allowed',
    why:
      'The PRE-AUTH front door. This dialog renders to someone with no session and POSTs to the ' +
      'UNAUTHENTICATED /api/access-requests/public endpoint (the file says so in its header, and uses a ' +
      'plain fetch for exactly that reason). Both ids were scoped as "derive them from the session"; there ' +
      'is no session on this surface, and the requester is by definition not yet known to the tenant, so ' +
      'Graph cannot resolve them either. Both are optional, behind an "advanced" Accordion, and exist so a ' +
      'requester who knows their own ids can save the admin a lookup.',
  },
  {
    file: 'apps/fiab-console/lib/components/admin/apim-apis-pane.tsx',
    sites: 1,
    kind: 'byo',
    ref: 'auto-bind-by-default.md §Allowed',
    why:
      'The origin an API Management API forwards to. Fronting an arbitrary HTTP backend — including one ' +
      'outside the Azure estate entirely — is what APIM IS; no discovery call enumerates "every service ' +
      'the customer might proxy". The field is optional: a façade-only API leaves it blank. Rated the ' +
      'weakest of the BYO set on review (#3579) and improvable rather than wrong: ' +
      '`app/api/apim/backends/route.ts` does enumerate the Backend entities that exist, so the hybrid ' +
      'shape (picker + "Other / external origin") would cover the enumerable half — tracked in #3589 for ' +
      'this field and its four siblings.',
  },
  {
    file: 'apps/fiab-console/lib/components/admin/apim-backends-pane.tsx',
    sites: 3,
    kind: 'byo',
    ref: 'auto-bind-by-default.md §Allowed',
    why:
      'An APIM Backend entity IS the declaration of a third-party origin: its runtime URL plus the ' +
      'credential that origin issued (an Authorization scheme + parameter, or a header/query key). The ' +
      'credential is minted by the backend owner, not by Loom, and is written to APIM\'s own ' +
      'BackendCredentialsContract rather than to a Loom record — so a Key Vault indirection here would be ' +
      'APIM named-values, a different resource on a different pane, not a change to this form.',
  },
  {
    file: 'apps/fiab-console/lib/components/admin/mcp-servers-panel.tsx',
    sites: 4,
    kind: 'byo',
    ref: 'auto-bind-by-default.md §Allowed',
    why:
      'Endpoints and auth for MCP servers Loom does not host: :248/:274 register an arbitrary third-party ' +
      'server, :1105/:1125 override a Microsoft-hosted server whose endpoint is not yet GA (the hint names ' +
      'the env var it overrides). Both secret-side fields are ALREADY the compliant shape — the auth-method ' +
      'Dropdown beside :274 offers "Key Vault secret", which mcp-client.ts resolves through Key Vault REST, ' +
      'and :1125 takes a secret NAME with "never the value" written into its hint.',
  },
  {
    file: 'apps/fiab-console/lib/components/admin/webhooks-panel.tsx',
    sites: 2,
    kind: 'byo',
    ref: 'auto-bind-by-default.md §Allowed',
    why:
      'The customer\'s own receiver (the placeholder is an ops PagerDuty bridge) — an endpoint outside the ' +
      'estate, which nothing in Azure can enumerate — and the HMAC signing secret, which the platform ' +
      'GENERATES when the field is left blank (webhook-registry.ts generateWebhookSecret, 32 random bytes). ' +
      'That field exists only so a customer whose receiver already validates a known shared secret can ' +
      'supply theirs; the compliant default is to leave it empty.',
  },
  {
    file: 'apps/fiab-console/lib/components/apim/apim-tree.tsx',
    sites: 1,
    kind: 'byo',
    ref: 'auto-bind-by-default.md §Allowed',
    why:
      'The runtime URL of an APIM Backend created from the tree\'s "new" dialog — the same third-party ' +
      'origin declaration as apim-backends-pane.tsx, reached from the explorer instead of the pane.',
  },
  {
    file: 'apps/fiab-console/lib/components/marketplace/api-marketplace.tsx',
    sites: 1,
    kind: 'byo',
    ref: 'auto-bind-by-default.md §Allowed',
    why:
      'The try-it console\'s subscription-key OVERRIDE. The enumerable case is already a picker — the ' +
      'sibling Dropdown lists the caller\'s own APIM subscriptions — and this box exists for a key issued ' +
      'to a consumer this console cannot see. The value is transient: it is sent on the one try-it request ' +
      'and never persisted, so there is nothing for a Key Vault reference to point at.',
  },
  {
    file: 'apps/fiab-console/lib/components/marketplace/data-shares.tsx',
    sites: 2,
    kind: 'byo',
    ref: 'auto-bind-by-default.md §Allowed',
    why:
      'The endpoint and bearer token of an EXTERNAL Delta Sharing provider, taken from the activation file ' +
      'that provider issued. Both are fields of the Delta Sharing recipient-profile format and are posted ' +
      'verbatim as `recipient_profile_str`; the protocol carries the token in the profile and has no Key ' +
      'Vault indirection to point at instead. The compliant bulk path already sits under them — "Paste ' +
      'activation file (JSON) to auto-fill" parses the provider\'s own file into both fields.',
  },
  {
    file: 'apps/fiab-console/lib/editors/airflow-job-editor.tsx',
    sites: 2,
    kind: 'byo',
    ref: 'auto-bind-by-default.md §Allowed',
    why:
      'Both are labelled "BYO override" against a day-one managed Apache Airflow host this deployment runs ' +
      'on Container Apps, and the editor says so in a success MessageBar directly above the second one. ' +
      'Blank means the managed host — the platform already did the binding — and the field exists only to ' +
      'point a job at an Airflow the customer runs themselves.',
  },
  {
    file: 'apps/fiab-console/lib/editors/apim-editors/api-editor.tsx',
    sites: 2,
    kind: 'byo',
    ref: 'auto-bind-by-default.md §Allowed',
    why:
      ':677 is the backend origin (see apim-backends-pane.tsx). :922 is the URL of an OpenAPI / WSDL / ' +
      'GraphQL document to import — a spec published somewhere on the internet, chosen per import, which ' +
      'is why the sibling Dropdown offers "inline JSON" as the alternative rather than a picker.',
  },
  {
    file: 'apps/fiab-console/lib/editors/loom-app-runtime-editor.tsx',
    sites: 1,
    kind: 'byo',
    ref: 'auto-bind-by-default.md §Allowed',
    why:
      'A PAT for the user\'s own private git repository, used only at build time. Loom cannot mint a ' +
      'credential on a customer\'s GitHub / Azure DevOps / GitLab / Bitbucket account. Already the ' +
      'compliant storage shape: a dedicated Save / rotate / Remove flow writes it to Key Vault and the ' +
      'hint names the vault, the provider and the set time — the value is never stored on the item.',
  },
  {
    file: 'apps/fiab-console/lib/editors/phase4/graphql-api-editor.tsx',
    sites: 1,
    kind: 'byo',
    ref: 'auto-bind-by-default.md §Allowed',
    why:
      'The optional resolver target an APIM GraphQL API forwards to — the same third-party origin ' +
      'declaration as apim-backends-pane.tsx, in the GraphQL editor.',
  },
  {
    file: 'apps/fiab-console/lib/panes/git-integration.tsx',
    sites: 4,
    kind: 'byo',
    ref: 'auto-bind-by-default.md §Allowed',
    why:
      'The customer\'s Azure DevOps / GitHub credentials, plus the Entra tenant and application ids of a ' +
      'service principal THEY registered for THEIR ADO organization. The tenant id was scoped as a ' +
      'delete-it ("the deployment\'s own tenant") and that is wrong twice: nothing derives it — ' +
      '`spnTenantId` is persisted by git-binding-store.ts and read by nothing that builds a token — and ' +
      'this pane\'s own MessageBar records that Azure DevOps runs on commercial endpoints in EVERY Loom ' +
      'boundary, so for a GCC-High / IL5 deployment the ADO organization\'s directory is definitionally ' +
      'not the deployment\'s tenant (cloud-parity.md). The PAT / client secret is already Key Vault-backed: ' +
      'saveBinding() calls putKeyVaultSecret and Cosmos holds only the secretRef. SEPARATELY, and tracked ' +
      'in #3588: that the SPN ids are read by nothing which mints a token raises whether the ' +
      'service-principal option works at all. That is a no-vaporware question, not a no-freeform one, and ' +
      'is why the fields were investigated rather than quietly deleted.',
  },
  {
    file: 'apps/fiab-console/lib/power-platform/flow-builder.tsx',
    sites: 1,
    kind: 'byo',
    ref: 'auto-bind-by-default.md §Allowed',
    why:
      'The URI an HTTP action calls inside a flow the user is AUTHORING. It is automation content — the ' +
      'same class as the report canvas\'s webUrl button — not an address of this deployment\'s ' +
      'infrastructure, and the flow is meaningless if Loom picks it.',
  },

  // ── FALSE POSITIVE: the classifier fired on evidence that is not an ask ──
  {
    file: 'apps/fiab-console/app/admin/scaling/page.tsx',
    sites: 1,
    kind: 'false-positive',
    ref: 'check-no-freeform.mjs §RESIDUAL FALSE POSITIVES',
    why:
      'The container MOUNT PATH (`/data`) at which the loom-mcp container sees an Azure Files share — a ' +
      'path inside a container filesystem, not a storage address. The share name and storage account are ' +
      'rendered as resolved text immediately above it, which is the platform having already done the ' +
      'binding. It matched `storage-loc` on `mount path`, a pattern written for a Databricks DBFS mount ' +
      'point; narrowing the pattern would lose that, so the correction is recorded here instead.',
  },
  {
    file: 'apps/fiab-console/lib/editors/components/inline-attribute-panel.tsx',
    sites: 1,
    kind: 'false-positive',
    ref: 'check-no-freeform.mjs §RESIDUAL FALSE POSITIVES',
    why:
      'The target of a compliance link attached to a data asset — placeholder `https://contoso.gov/terms`, ' +
      'paired with a "Friendly name" of "Terms of service". NOT_INFRA_RE already suppresses this class ' +
      'when the label says "documentation"/"help"/"homepage"; this one is labelled bare "URL", so the weak ' +
      '`bare-locator` fires with no Azure-specific evidence anywhere on the site.',
  },
  {
    file: 'apps/fiab-console/lib/editors/report/canvas-elements.tsx',
    sites: 1,
    kind: 'false-positive',
    ref: 'check-no-freeform.mjs §RESIDUAL FALSE POSITIVES',
    why:
      'The destination of a report BUTTON whose action type is `webUrl` — content the report author is ' +
      'designing, the same class NOT_INFRA_RE already suppresses for image / embed / navigate URLs. The ' +
      'label is bare "URL" and the action type that would disambiguate it lives in a sibling Dropdown, ' +
      'outside the site-local evidence window this guard deliberately reads.',
  },
  {
    file: 'apps/fiab-console/lib/governance/workspace-egress-pane.tsx',
    sites: 1,
    kind: 'false-positive',
    ref: 'check-no-freeform.mjs §RESIDUAL FALSE POSITIVES',
    why:
      'The value cell of an outbound ALLOW-LIST row, whose whole purpose is an arbitrary customer ' +
      'destination. The enumerable case IS already a picker: choosing "Service tag" swaps this Input for a ' +
      'Dropdown fed by a service-tag discovery call, and this branch renders only for "IP / CIDR" and ' +
      '"FQDN". It matched `azure-host` on its own example placeholder, `*.blob.core.windows.net` — a ' +
      'wildcard allow-list pattern rather than an address.',
  },
];

/**
 * Where a rule-clause `ref` may name a file. A clause ref is only worth
 * anything if the thing it cites exists — `made-up.md §Nonexistent` passed a
 * shape-only check (#3579 review), which is a reference in form and not in
 * substance.
 */
const REF_SEARCH_DIRS = ['.claude/rules', 'scripts/ci', 'docs/fiab', 'docs'];

/**
 * Resolve a rule-clause ref (`<file> §<clause>`) against the tree. Returns null
 * when it resolves, or the reason it does not.
 *
 * Checks BOTH halves: the file must exist somewhere sensible, and the `§` text
 * must actually appear in it. A citation to a real file and an imaginary
 * section is the same failure as a citation to an imaginary file.
 */
function resolveClauseRef(ref) {
  const m = /^(\S+\.(?:md|mjs))\s+§\s*(.+?)\s*$/.exec(ref);
  if (!m) return `\`${ref}\` is not a resolvable clause reference (expected "<file>.md §<clause>")`;
  const [, fileName, clause] = m;
  for (const dir of REF_SEARCH_DIRS) {
    const p = path.join(REPO_ROOT, dir, fileName);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    if (text.includes(clause)) return null;
    return `\`${fileName}\` exists but contains no "${clause}" — the section named by the ref is not there`;
  }
  return `\`${fileName}\` was not found under ${REF_SEARCH_DIRS.join(', ')} — the ref names no real document`;
}

/**
 * An acceptance must be complete and must carry a reference. Returns the
 * problems so the driver can fail on them.
 *
 * Enforced here rather than left to review, on #3533's reasoning: a convention
 * that depends on a reviewer noticing is the one that rots. `ref` is either a
 * tracking issue (a deferred fix somebody owns closing) or the rule clause that
 * permits the exception (a permanent one) — see the deviation note above. A
 * clause ref is RESOLVED against the tree, not merely shape-checked.
 */
export function validateAccepted(accepted = ACCEPTED) {
  const problems = [];
  const seen = new Set();
  for (const a of accepted) {
    const label = a && a.file ? a.file : '(unnamed)';
    if (!a || !a.file || !a.why || !a.kind) {
      problems.push(`ACCEPTED entry for ${label} is incomplete — it must name a file, a kind and a reason.`);
      continue;
    }
    if (a.kind !== 'byo' && a.kind !== 'false-positive') {
      problems.push(`ACCEPTED entry for ${label} has kind '${a.kind}' — expected 'byo' or 'false-positive'.`);
    }
    if (!Number.isInteger(a.sites) || a.sites < 1) {
      problems.push(
        `ACCEPTED entry for ${label} must declare how many sites it covers (\`sites\`, a positive integer). ` +
          'Without it the entry is a blanket amnesty and a new violation in the file would be invisible.',
      );
    }
    if (!a.ref) {
      problems.push(
        `ACCEPTED entry for ${label} carries no reference. Every accepted exception needs a \`ref\`: a ` +
          "tracking issue that closes it (e.g. '#3586') for a deferred fix, or the clause that permits it " +
          "(e.g. 'auto-bind-by-default.md §Allowed', 'check-no-freeform.mjs §RESIDUAL FALSE POSITIVES') " +
          'for a permanent one — otherwise it is an exception nobody owns and nobody revisits.',
      );
    } else if (!/#\d+/.test(a.ref)) {
      const bad = resolveClauseRef(a.ref);
      if (bad) problems.push(`ACCEPTED entry for ${label} has an unresolvable ref: ${bad}.`);
    }
    if (seen.has(a.file)) problems.push(`ACCEPTED lists ${label} twice; one entry per file.`);
    seen.add(a.file);
  }
  return problems;
}

/**
 * Remove the accepted files from `current`, failing on any entry that has gone
 * stale or drifted. Mutates nothing — returns a new map plus the problems.
 */
export function applyAccepted(current, accepted = ACCEPTED) {
  const problems = [];
  const drifted = [];
  const remaining = { ...current };
  for (const a of accepted) {
    const live = current[a.file];
    if (live === undefined) {
      problems.push(
        `ACCEPTED entry for ${a.file} no longer matches ANY classified site. Either the sites were fixed ` +
          '(delete the entry) or the detector stopped seeing them (a silent regression). A dead acceptance ' +
          'is cover for the next violation in that file.',
      );
      continue;
    }
    if (live !== a.sites) {
      drifted.push(a.file);
      problems.push(
        `ACCEPTED entry for ${a.file} declares ${a.sites} site(s); the classifier now finds ${live}. ` +
          (live > a.sites
            ? 'A NEW hand-typed infrastructure value was added to an accepted file — judge it before ' +
              'raising the number, because the acceptance does not cover it. Every site in the file is ' +
              'annotated below, so the new one can be READ rather than hunted for.'
            : 'A site was cleared — lower the number in the same PR so the acceptance keeps its teeth. ' +
              'Every remaining site in the file is annotated below.'),
      );
      continue;
    }
    delete remaining[a.file];
  }
  return { remaining, problems, drifted };
}

export function collect() {
  const files = execFileSync('git', ['ls-files', SCOPE], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.tsx$/.test(f));

  const current = {};
  const detail = [];
  let sites = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
    if (!SITE_PREFILTER.test(src)) continue;
    const { sites: n, violations } = analyze(src);
    sites += n;
    if (!violations.length) continue;
    current[f] = violations.length;
    for (const v of violations) detail.push({ f, ...v });
  }
  return { files, current, detail, sites };
}

/**
 * The floors + the ratchet over an ALREADY-MEASURED population. Split out of
 * main() so the ratchet's properties can be proven against a synthetic
 * `current` map instead of by mutating tracked source files in a checkout other
 * suites are running against.
 *
 * @returns {number} exit code
 */
export function judge(
  { files, current: measured, detail = [], sites },
  { argv = process.argv, baselineFile = BASELINE_FILE, touchedFiles, accepted = ACCEPTED } = {},
) {
  const regen = argv.includes('--update-baseline');

  if (files.length < MIN_TRACKED_FILES) {
    console.error(
      `::error::no-freeform: enumerated only ${files.length} tracked .tsx under ${SCOPE} ` +
        `(floor ${MIN_TRACKED_FILES}). \`git ls-files\` sees only TRACKED files — the scan is broken, ` +
        'FAILING rather than reporting a clean sweep of nothing.',
    );
    return 1;
  }
  if (sites < MIN_FREETEXT_SITES) {
    console.error(
      `::error::no-freeform: site extraction found only ${sites} free-text input(s) (floor ${MIN_FREETEXT_SITES}). ` +
        'The tree carries thousands. The tag matcher or the JSX open-tag reader is broken, so every ' +
        'downstream zero is meaningless.',
    );
    return 1;
  }
  // The population floors read the MEASURED map, before acceptances. They are a
  // control on the DETECTOR, and an acceptance is a judgement about a site the
  // detector correctly found — netting them off here would let the table walk
  // the floor down without anything having been fixed.
  const total = Object.values(measured).reduce((a, b) => a + b, 0);
  if (total < MIN_LIVE_SITES && !regen) {
    console.error(
      `::error::no-freeform: the classifier found only ${total} site(s) (floor ${MIN_LIVE_SITES}). ` +
        'A ratchet only fails on a RISE, so a detector that stopped detecting reads as a clean sweep — ' +
        'which is the exact history of this guard. If the sites were genuinely fixed, lower MIN_LIVE_SITES ' +
        'in the same PR that removes them.',
    );
    return 1;
  }

  // ── accepted exceptions: validated, applied, and PRINTED every run ───────
  const acceptProblems = validateAccepted(accepted);
  const { remaining: current, problems: driftProblems, drifted } = applyAccepted(measured, accepted);
  const acceptedSites = accepted.reduce((n, a) => n + (Number.isInteger(a.sites) ? a.sites : 0), 0);
  const verbose = argv.includes('--report');
  const acceptedFiles = new Set(accepted.map((a) => a.file));

  /** `file:line [kind:ids] evidence` — the per-site line, one place. */
  const siteLine = (b) => `${b.f}:${b.line} [${b.kind}:${b.ids.join(',')}] ${b.evidence}`;

  console.log(
    `no-freeform: ${files.length} tracked .tsx, ${sites} free-text input site(s) extracted, ` +
      `${total} asking for an infrastructure value across ${Object.keys(measured).length} file(s), ` +
      `${CONTROLS.length} embedded control(s) passed.`,
  );
  console.log(
    `no-freeform [accepted]: ${accepted.length} reviewed exception(s) covering ${acceptedSites} site(s) — ` +
      `${accepted.filter((a) => a.kind === 'byo').length} bring-your-own, ` +
      `${accepted.filter((a) => a.kind === 'false-positive').length} classifier false-positive. ` +
      `${Object.values(current).reduce((a, b) => a + b, 0)} site(s) remain under the ratchet.`,
  );
  for (const a of accepted) {
    console.log(`  ACCEPTED [${a.kind}] (${a.ref}) ${a.file} — ${a.sites} site(s): ${a.why}`);
    // Under --report, list the SITES each acceptance covers. Without this the
    // 34 accepted sites have no `file:line` anywhere in the output and an
    // auditor has to instrument `collect()` to find out what was excused
    // (#3579 review). It is a `console.log`, never an annotation — the
    // judgement has been made, so it is a listing and not a finding.
    if (verbose) {
      for (const b of detail) if (b.f === a.file) console.log(`    [accepted] ${siteLine(b)}`);
    }
  }
  if (acceptProblems.length || driftProblems.length) {
    for (const p of [...acceptProblems, ...driftProblems]) console.error(`::error::no-freeform: ${p}`);
    // A count-only failure at the moment a reviewer most needs a pointer is the
    // worst time to withhold one. Annotate every site in each DRIFTED file so
    // the new (or removed) one is read off the log rather than hunted for.
    for (const b of detail) {
      if (!drifted.includes(b.f)) continue;
      console.error(
        `::error file=${b.f},line=${b.line}::no-freeform [accepted-file drift]: this site is in an ` +
          `ACCEPTED file whose declared count no longer matches. ${b.why}. Evidence: ${b.evidence}\n  ${b.text}`,
      );
    }
    console.error(
      '::error::no-freeform: the ACCEPTED table does not describe this tree. An exception that no longer ' +
        'matches what it excuses is not an exception, it is cover — same reasoning as #3531.',
    );
    return 1;
  }

  const { entries: baseline } = loadBaseline(baselineFile);

  // A baselined file with ZERO current sites is a dead entry, and a dead entry
  // is cover: the next real violation in that file inherits it silently.
  const stale = Object.keys(baseline).filter((k) => !(k in current));
  if (stale.length && !regen) {
    console.error(
      `::error::no-freeform: ${stale.length} baseline entr(ies) no longer contain ANY site: ` +
        `${stale.slice(0, 20).join(', ')}${stale.length > 20 ? ', …' : ''}. A drained entry is cover for the ` +
        'next violation in that file — regen with `node scripts/ci/check-no-freeform.mjs --update-baseline` ' +
        '(the ratchet then tightens).',
    );
    return 1;
  }

  // A GitHub `::error` annotation is reserved for sites ABOVE the baseline —
  // annotating the whole population on a green run would decorate every
  // innocent file on every unrelated PR, and an annotation that fires when
  // nothing is wrong trains reviewers to ignore it. `regen` suppresses them
  // outright: on a BOOTSTRAP regen the baseline is empty, so every site reads
  // as over-baseline and the run would emit the entire population as errors.
  for (const b of detail) {
    // An accepted file's sites are LISTED above under their acceptance (with a
    // `[accepted]` tag, when --report is on) and must never be ANNOTATED: the
    // judgement has been made, and re-filing it as a finding is what trains a
    // reviewer to stop reading annotations.
    if (acceptedFiles.has(b.f)) continue;
    const overBaseline = !regen && (current[b.f] ?? 0) > (baseline[b.f] ?? 0);
    const body =
      `no-freeform [${b.kind}:${b.ids.join(',')}]: this free-text ${b.tag} asks the user for ${b.why}. ` +
      'Configuration is authored through a picker fed by a real discovery call; the platform provisions ' +
      'and binds the backing resource (auto-bind-by-default.md §5) rather than asking for its address. ' +
      `Evidence: ${b.evidence}`;
    if (overBaseline) console.error(`::error file=${b.f},line=${b.line}::${body}\n  ${b.text}`);
    else if (verbose) console.log(`  ${siteLine(b)}`);
  }
  if (!verbose) {
    console.log(
      'no-freeform: re-run with --report to list the full baselined population and the sites each ' +
        'ACCEPTED entry covers.',
    );
  }

  return runRatchet({
    name: 'no-freeform',
    baselineFile,
    meta: META,
    current,
    argv,
    touched: {
      files: touchedFiles !== undefined ? touchedFiles : gitTouchedFiles({ cwd: REPO_ROOT }),
      exempt: TOUCH_EXEMPT,
      message: () =>
        'replace the free-text box with a picker fed by a real discovery call while you are in the file, ' +
        'or make the platform provision + bind the value so nothing is asked for at all ' +
        '(auto-bind-by-default.md §5)',
    },
  });
}

function main() {
  // 1. Controls first — a verdict from a scanner that has stopped scanning is
  //    not a verdict.
  const failures = selfTest();
  if (failures.length) {
    for (const f of failures) console.error(`::error::no-freeform: EMBEDDED CONTROL FAILED — ${f}`);
    console.error(
      '::error::no-freeform: the detector has drifted; a clean scan from it would mean nothing. That is ' +
        'this guard\'s own history — it passed for months while six hand-typed-infrastructure surfaces shipped.',
    );
    return 1;
  }

  // 2. PART 1 — raw-JSON-config surfaces. Still a HARD ZERO.
  const jsonBlobs = findJsonBlobSurfaces();
  console.log(`no-freeform [json-blob]: scanned lib/editors; ${JSON_ALLOWLIST.size} allowlisted file(s); ${jsonBlobs.length} candidate(s).`);
  if (jsonBlobs.length) {
    console.error('\n::error::no-freeform [json-blob]: editable raw-JSON config surfaces (edit-the-whole-config-as-JSON is forbidden; use a form/wizard/canvas):');
    for (const c of jsonBlobs) console.error(`::error file=${c.file},line=${c.line}::no-freeform [json-blob]: ariaLabel=${JSON.stringify(c.aria)}`);
    console.error('\nFix: replace with a structured editor, OR — if this is a legitimate data payload / portal');
    console.error('code-view (OpenAPI, GeoJSON, definition, schema, sample) — give the Monaco an ariaLabel naming');
    console.error('the artifact (clears ALLOW_INTENT), make it readOnly if it is a view, or add the file to');
    console.error('JSON_ALLOWLIST in check-no-freeform.mjs.');
    return 1;
  }

  // 3. PART 2 — typed-infrastructure-value inputs. Ratcheted.
  return judge(collect());
}

// Run as a script, not as an import side effect (#3436).
if (process.argv[1] && process.argv[1].endsWith('check-no-freeform.mjs')) {
  process.exitCode = main();
}
