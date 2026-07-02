#!/usr/bin/env node
/**
 * GUARDRAIL: no-freeform-config  (merge-blocker)
 * ------------------------------------------------------------------------
 * RULE (loom_no_freeform_config — BLOCKING GLOBAL): all item configuration
 *   is authored through dropdowns / wizards / WYSIWYG / canvas surfaces —
 *   NEVER by editing the item's config as a raw JSON blob in a textarea /
 *   Monaco editor. The ONLY allowed free-text code surfaces are 1:1 with an
 *   Azure/Fabric surface: expression builders (ADF/Synapse), query editors
 *   (SQL/KQL/DAX), a portal "Code view" of a definition (Logic App / ADF
 *   pipeline / OpenAPI / ARM), data payloads (GeoJSON / sample events /
 *   documents / schema), and READ-ONLY definition views.
 *
 * WHAT IT DOES (default-deny):
 *   Scans apps/fiab-console/lib/editors/** for an EDITABLE `language="json"`
 *   (or language-less) Monaco/Textarea surface. Such a surface is a candidate
 *   raw-JSON-config violation UNLESS it is:
 *     - read-only (a Definition view), or
 *     - a recognized code language (sql/kql/dax/python/yaml/...), or
 *     - a recognized data/code artifact by intent (schema, sample, geojson,
 *       openapi/oas, definition, spec, pipeline, workflow, policy, arm,
 *       template, query, expression, ...) named in its ariaLabel / props, or
 *     - an allowlisted file below.
 *
 * HOW TO ADD AN ALLOWLIST ENTRY:
 *   Prefer making the surface self-describing: give the Monaco an ariaLabel
 *   that names the artifact (e.g. "OpenAPI document", "GeoJSON", "Workflow
 *   definition JSON") — that alone clears the check via ALLOW_INTENT.
 *   Only if a genuinely-legitimate JSON surface can't be described that way,
 *   add its repo-relative path to ALLOWLIST with a one-line reason.
 *   If the surface really is "edit the whole item config as JSON", it is a
 *   RULE VIOLATION — replace it with a form / wizard / canvas, do not
 *   allowlist it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EDITORS_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console', 'lib', 'editors');

// Recognized non-JSON code languages — free-text is fine (1:1 code surfaces).
const CODE_LANGS = new Set([
  'sql', 'tsql', 'kql', 'kusto', 'dax', 'python', 'py', 'm', 'yaml', 'yml',
  'csv', 'markdown', 'md', 'html', 'xml', 'bicep', 'plaintext', 'text',
  'javascript', 'typescript', 'shell', 'bash', 'sparql', 'cypher', 'graphql',
]);

// Data/code ARTIFACT intents — a JSON surface describing one of these is a
// legitimate document/payload/code-view, not a raw item-config blob.
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

// Files that legitimately need no per-surface intent tag. Repo-relative POSIX.
const ALLOWLIST = new Map([
  // ADX / Fabric real-time dashboards expose a raw JSON model view 1:1 (the
  // "Edit model (JSON)" advanced dialog). Primary authoring is the visual tile
  // canvas; this editable JSON dialog mirrors the portal's JSON view.
  ['apps/fiab-console/lib/editors/phase3/kql-dashboard-editor.tsx', 'ADX/Fabric dashboard raw-JSON model view (1:1 portal code view; canvas is primary)'],
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

const ELEMENT_START_RE = /<(MonacoTextarea|MonacoEditor|MonacoDiff|Textarea)\b/g;

/** Extract the JSX element attribute block starting at `from` (self-closing or open tag). */
function extractElementBlock(src, from) {
  // Find the first '>' that closes the opening tag, honoring '/>'.
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

function isReadOnly(block) {
  // readOnly prop present (boolean or ={true}) or an explicit no-op onChange.
  if (/\breadOnly\b(?!\s*=\s*\{?\s*false)/i.test(block)) return true;
  if (/\bdisabled\b(?!\s*=\s*\{?\s*false)/i.test(block)) return true;
  if (/onChange=\{\s*\(\s*\)\s*=>\s*\{\s*\/\*\s*read-?only/i.test(block)) return true;
  return false;
}

function isEditable(block) {
  if (isReadOnly(block)) return false;
  return /onChange\s*=/.test(block);
}

function main() {
  const files = walk(EDITORS_ROOT);
  const candidates = [];

  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    let m;
    ELEMENT_START_RE.lastIndex = 0;
    while ((m = ELEMENT_START_RE.exec(src)) !== null) {
      const tag = m[1];
      const block = extractElementBlock(src, m.index);
      // Context = up to 6 lines before the tag (captures a wrapping
      // <Field label> / <Caption> / <DialogTitle> that names the artifact)
      // plus the element block itself. ALLOW_INTENT is matched against this.
      const ctxStart = nthNewlineBefore(src, m.index, 6);
      const context = src.slice(ctxStart, m.index) + block;
      const lang = (getAttr(block, 'language') || '').toLowerCase();

      // Plain Fluent <Textarea> has no `language` prop; only treat it as a JSON
      // surface when it is clearly bound to a JSON blob (value/aria mentions json).
      const isJsonSurface =
        lang === 'json' ||
        (tag === 'Textarea' && /json/i.test(context)) ||
        (tag !== 'Textarea' && lang === '' && /json/i.test(context));
      if (!isJsonSurface) continue;
      if (CODE_LANGS.has(lang)) continue;
      if (!isEditable(block)) continue;
      if (ALLOW_INTENT_RE.test(context)) continue;

      const r = rel(f);
      if (ALLOWLIST.has(r)) continue;

      const line = src.slice(0, m.index).split('\n').length;
      const aria = getAttr(block, 'ariaLabel') || '(no ariaLabel)';
      candidates.push({ file: r, line, aria });
    }
  }

  console.log(`[no-freeform] scanned editor tree under lib/editors`);
  console.log(`[no-freeform] allowlisted files: ${ALLOWLIST.size}`);
  console.log(`[no-freeform] candidate raw-JSON-config surfaces: ${candidates.length}`);
  if (candidates.length) {
    console.error('\n[no-freeform] FAIL — these look like editable raw-JSON config surfaces');
    console.error('(edit-the-whole-config-as-JSON is forbidden; use a form/wizard/canvas):');
    for (const c of candidates) console.error(`  - ${c.file}:${c.line}  ariaLabel=${JSON.stringify(c.aria)}`);
    console.error('\nFix: replace with a structured editor, OR — if this is a legitimate data');
    console.error('payload / portal code-view (OpenAPI, GeoJSON, definition, schema, sample) —');
    console.error('give the Monaco an ariaLabel naming the artifact (clears ALLOW_INTENT), make it');
    console.error('readOnly if it is a view, or add the file to ALLOWLIST in check-no-freeform.mjs.');
    process.exit(1);
  }
  console.log('[no-freeform] OK — no editable raw-JSON config surfaces detected.');
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
