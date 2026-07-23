#!/usr/bin/env node
/**
 * Lint the golden Copilot eval sets (E1 — loom-next-level).
 *
 * Validates every `content/evals/<surface>.jsonl` row against
 * `content/evals/_schema.json` AND asserts every `expectedChunks` entry
 * resolves to a REAL corpus document:
 *   1. the doc path exists in the repo tree (docs/** or PRPs/**);
 *   2. when the staged corpus manifest exists
 *      (apps/fiab-console/copilot-corpus/.corpus-manifest.json, written by
 *      scripts/csa-loom/stage-copilot-corpus.sh) the path must be a manifest
 *      key too — so a set can never reference a doc the image won't carry;
 *   3. a `#anchor` suffix must match a real heading slug in the doc
 *      (GitHub-style slugs, fenced code blocks excluded) — dangling anchors
 *      FAIL the lint.
 *
 * Extra deterministic checks: unique ids, id prefix == file surface,
 * mustMention/mustNotMention may not share an identical (case-insensitive)
 * phrase, and each set needs >= MIN_ROWS rows.
 *
 * Usage:
 *   node scripts/csa-loom/lint-eval-sets.mjs                # lint (exit 1 on error)
 *   node scripts/csa-loom/lint-eval-sets.mjs --anchors docs/fiab/parity/lakehouse.md
 *                                                          # debug: dump heading slugs
 *
 * Dependency-free on purpose (runs from the repo root, which has no
 * package.json): the tiny validator below covers exactly the JSON-Schema
 * subset `_schema.json` uses (type/object/array/string, required,
 * additionalProperties, properties, items, enum, pattern, min/maxLength,
 * min/maxItems) while still READING the schema file, so schema edits are
 * honored without code changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..', '..');
const EVALS_DIR = path.join(repo, 'content', 'evals');
const SCHEMA_PATH = path.join(EVALS_DIR, '_schema.json');
const MANIFEST_PATH = path.join(
  repo, 'apps', 'fiab-console', 'copilot-corpus', '.corpus-manifest.json',
);
const MIN_ROWS = 12;

// ── GitHub-style heading slugs (fenced code excluded, dedup -1/-2/…) ─────────
export function headingSlugs(markdown) {
  const slugs = new Map(); // base slug -> count
  const out = new Set();
  let inFence = false;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^(```|~~~)/.test(line.trimStart())) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!m) continue;
    // strip markdown emphasis/code/link syntax before slugging
    const text = m[2]
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*`~]/g, '')
      .trim();
    const base = text
      .toLowerCase()
      .replace(/[^a-z0-9 _-]/g, '')
      .replace(/ /g, '-');
    const n = slugs.get(base) ?? 0;
    slugs.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

// ── Minimal JSON-Schema (draft-07 subset) validator ──────────────────────────
function validate(schema, value, at, errors) {
  const fail = (msg) => errors.push(`${at}: ${msg}`);
  if (schema.enum) {
    if (!schema.enum.includes(value)) fail(`must be one of ${JSON.stringify(schema.enum)} (got ${JSON.stringify(value)})`);
    return;
  }
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('must be an object');
      for (const req of schema.required ?? []) {
        if (!(req in value)) fail(`missing required property "${req}"`);
      }
      for (const [k, v] of Object.entries(value)) {
        const sub = schema.properties?.[k];
        if (!sub) {
          if (schema.additionalProperties === false) fail(`unknown property "${k}"`);
          continue;
        }
        validate(sub, v, `${at}.${k}`, errors);
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) return fail('must be an array');
      if (schema.minItems != null && value.length < schema.minItems) fail(`needs >= ${schema.minItems} items`);
      if (schema.maxItems != null && value.length > schema.maxItems) fail(`needs <= ${schema.maxItems} items`);
      if (schema.items) value.forEach((v, i) => validate(schema.items, v, `${at}[${i}]`, errors));
      return;
    }
    case 'string': {
      if (typeof value !== 'string') return fail('must be a string');
      if (schema.minLength != null && value.length < schema.minLength) fail(`shorter than minLength ${schema.minLength}`);
      if (schema.maxLength != null && value.length > schema.maxLength) fail(`longer than maxLength ${schema.maxLength}`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(`does not match pattern ${schema.pattern}`);
      return;
    }
    default:
      return; // subset: no other types used by _schema.json
  }
}

// ── Debug mode: dump heading anchors for a doc ───────────────────────────────
const args = process.argv.slice(2);
const anchorsIdx = args.indexOf('--anchors');
if (anchorsIdx >= 0) {
  const rel = args[anchorsIdx + 1];
  const md = fs.readFileSync(path.join(repo, rel), 'utf-8');
  for (const s of headingSlugs(md)) console.log(`${rel}#${s}`);
  process.exit(0);
}

// ── Lint ─────────────────────────────────────────────────────────────────────
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
const manifest = fs.existsSync(MANIFEST_PATH)
  ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'))
  : null;

const files = fs.existsSync(EVALS_DIR)
  ? fs.readdirSync(EVALS_DIR).filter((f) => f.endsWith('.jsonl')).sort()
  : [];
if (files.length === 0) {
  console.error(`lint-eval-sets: no .jsonl sets found under ${EVALS_DIR}`);
  process.exit(1);
}

const slugCache = new Map(); // doc path -> Set<slug> | null (missing file)
function slugsFor(relPath) {
  if (!slugCache.has(relPath)) {
    const abs = path.join(repo, relPath);
    slugCache.set(relPath, fs.existsSync(abs) ? headingSlugs(fs.readFileSync(abs, 'utf-8')) : null);
  }
  return slugCache.get(relPath);
}

const errors = [];
let totalRows = 0;

for (const file of files) {
  const surface = path.basename(file, '.jsonl');
  const lines = fs.readFileSync(path.join(EVALS_DIR, file), 'utf-8')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length < MIN_ROWS) {
    errors.push(`${file}: only ${lines.length} rows (need >= ${MIN_ROWS})`);
  }
  const seenIds = new Set();
  lines.forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    let row;
    try {
      row = JSON.parse(line);
    } catch (e) {
      errors.push(`${at}: invalid JSON — ${e.message}`);
      return;
    }
    totalRows += 1;
    validate(schema, row, at, errors);
    if (typeof row.id === 'string') {
      if (seenIds.has(row.id)) errors.push(`${at}: duplicate id "${row.id}"`);
      seenIds.add(row.id);
      if (!row.id.startsWith(`${surface}-`)) {
        errors.push(`${at}: id "${row.id}" must be prefixed "${surface}-"`);
      }
    }
    // mention guards may not contradict each other
    if (Array.isArray(row.mustMention) && Array.isArray(row.mustNotMention)) {
      const not = new Set(row.mustNotMention.map((s) => String(s).toLowerCase()));
      for (const m of row.mustMention) {
        if (not.has(String(m).toLowerCase())) {
          errors.push(`${at}: "${m}" appears in BOTH mustMention and mustNotMention`);
        }
      }
    }
    // chunk-path + anchor existence
    for (const chunk of Array.isArray(row.expectedChunks) ? row.expectedChunks : []) {
      if (typeof chunk !== 'string') continue;
      const [rel, anchor] = chunk.split('#');
      const slugs = slugsFor(rel);
      if (slugs === null) {
        errors.push(`${at}: expectedChunks path does not exist in the repo: ${rel}`);
        continue;
      }
      if (manifest && !(rel in (manifest.files ?? {}))) {
        errors.push(`${at}: ${rel} exists in the repo but is NOT in the staged corpus manifest (run scripts/csa-loom/stage-copilot-corpus.sh)`);
      }
      if (anchor && !slugs.has(anchor)) {
        errors.push(`${at}: dangling anchor "#${anchor}" in ${rel} (known: ${[...slugs].slice(0, 8).join(', ')}…)`);
      }
    }
  });
}

// ── SRCH1 — federated-search relevance sets (content/evals/search/*.jsonl) ────
// Schema-validated against content/evals/search/_schema.json; the corpus/anchor
// checks above are Copilot-RAG-only (search rows reference item ids/names, not
// doc chunks), so these get id/prefix/uniqueness + row-count checks instead.
const SEARCH_DIR = path.join(EVALS_DIR, 'search');
const SEARCH_SCHEMA_PATH = path.join(SEARCH_DIR, '_schema.json');
let searchFiles = 0;
let searchRows = 0;
if (fs.existsSync(SEARCH_DIR) && fs.existsSync(SEARCH_SCHEMA_PATH)) {
  const searchSchema = JSON.parse(fs.readFileSync(SEARCH_SCHEMA_PATH, 'utf-8'));
  const sfiles = fs.readdirSync(SEARCH_DIR).filter((f) => f.endsWith('.jsonl')).sort();
  for (const file of sfiles) {
    searchFiles += 1;
    const domain = path.basename(file, '.jsonl');
    const lines = fs.readFileSync(path.join(SEARCH_DIR, file), 'utf-8')
      .split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < MIN_ROWS) {
      errors.push(`search/${file}: only ${lines.length} rows (need >= ${MIN_ROWS})`);
    }
    const seenIds = new Set();
    lines.forEach((line, i) => {
      const at = `search/${file}:${i + 1}`;
      let row;
      try { row = JSON.parse(line); } catch (e) { errors.push(`${at}: invalid JSON — ${e.message}`); return; }
      searchRows += 1;
      validate(searchSchema, row, at, errors);
      if (typeof row.id === 'string') {
        if (seenIds.has(row.id)) errors.push(`${at}: duplicate id "${row.id}"`);
        seenIds.add(row.id);
        if (!row.id.startsWith(`${domain}-`)) errors.push(`${at}: id "${row.id}" must be prefixed "${domain}-"`);
      }
      if (row.domain && row.domain !== domain) {
        errors.push(`${at}: domain "${row.domain}" must equal the file basename "${domain}"`);
      }
    });
  }
}

if (errors.length > 0) {
  console.error(`lint-eval-sets: ${errors.length} error(s)\n`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log(
  `lint-eval-sets: OK — ${files.length} Copilot sets, ${totalRows} rows, ` +
  `${slugCache.size} corpus docs referenced` +
  (searchFiles ? `; ${searchFiles} search sets, ${searchRows} rows (SRCH1)` : '') +
  (manifest ? ` (manifest ${String(manifest.sourceCommit).slice(0, 8)}, ${manifest.fileCount} files)` : ' (no staged manifest — repo-tree check only)'),
);
