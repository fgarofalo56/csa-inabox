#!/usr/bin/env node
/**
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
 * Free-text SITES the extractor must still find. MEASURED 2,298 today, from
 * 2,742 raw tag matches; the 444-site gap is accounted for and is not silent
 * loss — ~408 carry a non-text `type=` (number/checkbox/date/file/…), ~64 are
 * `readOnly`, ~33 are unconditionally `disabled`, and 20 are prose inside a
 * comment or a string that the mask correctly removed.
 *
 * This is the control on SITE EXTRACTION, and it is the floor that matters
 * most: the classifier reports a subset of these, so if the tag matcher, the
 * mask or the JSX open-tag reader breaks, this collapses BEFORE a classifier
 * zero can be mistaken for a clean tree. That ordering is the whole lesson of
 * the version this replaces.
 */
const MIN_FREETEXT_SITES = 1800;
/** Classified violations the guard must still find; measured 250 today.
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
  { id: 'storage-loc', re: /\bstorage\s*(?:account|location|root|path|container|url|uri)\b|\bmount\s*(?:point|path)\b|\bcontainer\s*name\b/i, why: 'a storage location' },
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
    if (hasTruthyProp(tagCode, 'readOnly') || hasTruthyProp(tagCode, 'readonly')) continue;
    if (/(?:^|[\s{])disabled\b(?!\s*=)/i.test(tagCode) || /(?:^|[\s{])disabled\s*=\s*\{?\s*true/i.test(tagCode)) continue;

    const field = enclosingField(code, start);
    const label = field ? attrValue(code, src, field.start, field.end, 'label') : null;
    const hint = field ? attrValue(code, src, field.start, field.end, 'hint') : null;
    const adjacent = adjacentLabel(code, start);

    const placeholder = attrValue(code, src, start, end, 'placeholder');
    const defaultValue = attrValue(code, src, start, end, 'defaultValue');
    const aria = attrValue(code, src, start, end, 'aria-label') ?? attrValue(code, src, start, end, 'ariaLabel');
    const id = attrValue(code, src, start, end, 'id');
    const nameAttr = attrValue(code, src, start, end, 'name');
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
export const TOUCH_EXEMPT = new Map();

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
  { files, current, detail = [], sites },
  { argv = process.argv, baselineFile = BASELINE_FILE, touchedFiles } = {},
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
  const total = Object.values(current).reduce((a, b) => a + b, 0);
  if (total < MIN_LIVE_SITES && !regen) {
    console.error(
      `::error::no-freeform: the classifier found only ${total} site(s) (floor ${MIN_LIVE_SITES}). ` +
        'A ratchet only fails on a RISE, so a detector that stopped detecting reads as a clean sweep — ' +
        'which is the exact history of this guard. If the sites were genuinely fixed, lower MIN_LIVE_SITES ' +
        'in the same PR that removes them.',
    );
    return 1;
  }

  console.log(
    `no-freeform: ${files.length} tracked .tsx, ${sites} free-text input site(s) extracted, ` +
      `${total} asking for an infrastructure value across ${Object.keys(current).length} file(s), ` +
      `${CONTROLS.length} embedded control(s) passed.`,
  );

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
  const verbose = argv.includes('--report');
  for (const b of detail) {
    const overBaseline = !regen && (current[b.f] ?? 0) > (baseline[b.f] ?? 0);
    const body =
      `no-freeform [${b.kind}:${b.ids.join(',')}]: this free-text ${b.tag} asks the user for ${b.why}. ` +
      'Configuration is authored through a picker fed by a real discovery call; the platform provisions ' +
      'and binds the backing resource (auto-bind-by-default.md §5) rather than asking for its address. ' +
      `Evidence: ${b.evidence}`;
    if (overBaseline) console.error(`::error file=${b.f},line=${b.line}::${body}\n  ${b.text}`);
    else if (verbose) console.log(`  ${b.f}:${b.line} [${b.kind}:${b.ids.join(',')}] ${b.evidence}`);
  }
  if (!verbose) {
    console.log('no-freeform: re-run with --report to list the full baselined population.');
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
