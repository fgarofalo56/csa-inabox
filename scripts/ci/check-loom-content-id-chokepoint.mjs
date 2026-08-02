#!/usr/bin/env node
/**
 * GUARDRAIL: loom-content-id-chokepoint  (merge-blocker — issue #2830)
 * ---------------------------------------------------------------------------
 * RULE:
 *
 *   A bundle-installed item is surfaced by its LIST route under the synthetic id
 *   `loom:<cosmosItemId>`, and the editor threads whatever the list route handed
 *   it into EVERY sub-route of that type. Cosmos stores the item under the BARE
 *   id, so any lookup that runs `WHERE c.id = @id` with the prefixed form matches
 *   NOTHING and 404s on an item that exists.
 *
 *   That is not a bug, it is a CLASS. It shipped four times:
 *
 *     #2649  semantic-model detail            404 on a bundle model
 *     #2818  semantic-model /refreshes        404 + a crossed namespace
 *     #2822  semantic-model /roles            404, Security tab dead
 *     #2830  report /pages                    404 on a freshly created report
 *
 *   Each fix resolved the id inside ONE route and left the siblings, because the
 *   rule lived in a comment. This turns it into a red build:
 *
 *     1. The two Cosmos-by-id CHOKEPOINTS resolve the prefix, so no route has to
 *        remember: `loadOwnedItem` (and through it updateOwnedItem /
 *        deleteOwnedItem / softDeleteOwnedItem / readModelState / writeModelState
 *        / the checkpoint, prep-for-ai, verified-queries + scorecard-goal stores)
 *        and `getModelItem` (listTables / listMeasures / evalDax /
 *        warmSemanticModel).
 *     2. The `loom:` vocabulary is DEFINED in exactly one dependency-free module.
 *        A second definition is a second thing to forget to update.
 *     3. Every `[id]` sub-route of a `loom:`-emitting item type that reaches
 *        Cosmos by id OUTSIDE those chokepoints must resolve the prefix itself.
 *        The emitting types are DISCOVERED from the list routes, so a new type
 *        is swept the day it is added — nobody has to update this file.
 *     4. No caller invents a workspace id to satisfy a parameter the handler
 *        never reads (`?workspaceId=loom-native`, the second smell in #2830's
 *        URL — a backend NAME where a workspace GUID belongs).
 *
 * WHY A GUARD AND NOT A CONVENTION: convention was tried three times. #2818's own
 * notes enumerate the siblings it knowingly left; #2822 fixed one of them; #2830
 * found the next. `tsc` cannot see any of this — a `loom:` id and a Cosmos id are
 * both `string`.
 *
 * ANTI-PATTERNS AVOIDED (per check-tid-boundary-chokepoint's three rewrites):
 * comments and string literals are MASKED before any scan, so a doc comment that
 * mentions `cosmosIdFromLoomId` cannot satisfy a check; the chokepoint assertions
 * brace-match the named function body rather than substring-testing the file; and
 * every exemption carries a reason and is reported when stale.
 *
 * ## PROVEN TO FAIL. Each mutation was applied to the tree and the exit code
 * recorded. A guard nobody has tried to defeat is a comment.
 *
 *   M1  loadOwnedItem passes `itemId` raw to the `@id` parameter        exit 1
 *   M2  getModelItem matches on `modelId` instead of the resolved id    exit 1
 *   M3  a new sub-route queries `c.id = @id` with the raw path id       exit 1
 *   M4  a client sends `?workspaceId=loom-native`                       exit 1
 *   M5  a second module redefines `LOOM_ID_PREFIX = 'loom:'`            exit 1
 *   M6  NEGATIVE CONTROL — a doc comment naming cosmosIdFromLoomId      exit 0
 *
 * Usage: node scripts/ci/check-loom-content-id-chokepoint.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CONSOLE_ROOT = 'apps/fiab-console';
const ITEMS_ROOT = `${CONSOLE_ROOT}/app/api/items`;
const VOCAB_FILE = `${ITEMS_ROOT}/_lib/loom-content-id.ts`;
const SCAN_DIRS = [`${CONSOLE_ROOT}/app`, `${CONSOLE_ROOT}/lib`];

/** The Cosmos-by-id chokepoints, and the resolver each MUST apply. */
const CHOKEPOINTS = [
  {
    file: `${ITEMS_ROOT}/_lib/item-crud.ts`,
    fn: 'loadOwnedItem',
    why:
      'every per-type sub-route reaches Cosmos through it (directly, or via updateOwnedItem / ' +
      'readModelState / writeModelState / the checkpoint + prep-for-ai + verified-queries stores)',
  },
  {
    file: `${CONSOLE_ROOT}/lib/azure/tabular-eval-client.ts`,
    fn: 'getModelItem',
    why: 'listTables / listMeasures / evalDax / warmSemanticModel all resolve the model through it',
  },
];

/**
 * Files allowed to spell the `loom:` prefix themselves, each with the reason a
 * reviewer can check against the file. Everything else must import the
 * vocabulary from `_lib/loom-content-id.ts`.
 */
const PREFIX_ALLOWLIST = new Map([
  [
    'lib/editors/phase3/semantic-model-editor/helpers.tsx',
    'CLIENT component — cannot import a server module that pulls in the Cosmos SDK. ' +
      'Declares LOOM_DATASET_ID_PREFIX for the dataset picker only; never resolves a Cosmos id.',
  ],
  [
    'lib/editors/phase3/report-editor.tsx',
    'CLIENT component — marks the report-copilot pages read as the Cosmos-content branch. ' +
      'Prefix-only (never strips), and guarded against double-application.',
  ],
]);

/**
 * Sub-routes exempt from rule 3, each with the reason. An entry here is a review:
 * it asserts the route CANNOT receive a `loom:` id, or that the prefixed form is
 * the correct key on its own store.
 */
const ROUTE_ALLOWLIST = new Map([
  [
    'semantic-model/[id]/datasource/route.ts',
    'Resolves the Cosmos item from the `itemId` QUERY parameter (the editor passes the plain ' +
      'item id there), not from the path `[id]` — the path id is the dataset identity and is ' +
      'only forwarded to the opt-in Power BI executeQueries call.',
  ],
]);

const failures = [];
const fail = (msg) => failures.push(msg);

// ── source masking ──────────────────────────────────────────────────────────
/**
 * Blank out line comments, block comments and string/template literal BODIES,
 * preserving byte offsets and newlines. A doc comment that says
 * `cosmosIdFromLoomId` must not satisfy a chokepoint assertion.
 */
function mask(src) {
  const out = src.split('');
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const end = src.indexOf('\n', i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
    } else if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      const q = src[i];
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === q) break;
        j += 1;
      }
      blank(i + 1, j);
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return out.join('');
}

/** Strip comments but KEEP string bodies — for patterns that live inside SQL text. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Brace-match a named function's BODY (masked). Null when absent.
 *
 * Skips the parameter list first. A signature like
 * `loadOwnedItem(…, opts: { allowReadRoles?: boolean } = {})` has braces INSIDE
 * its parens, and a naive `indexOf('{')` brace-matches the options TYPE instead
 * of the body — which made the chokepoint assertion below scan a few characters
 * of type declaration and report the resolution missing while it was right there.
 */
function functionBody(masked, name) {
  const decl = new RegExp(`function\\s+${name}\\s*[(<]`).exec(masked);
  if (!decl) return null;
  const paren = masked.indexOf('(', decl.index);
  if (paren === -1) return null;
  let depth = 0;
  let afterParams = -1;
  for (let i = paren; i < masked.length; i++) {
    if (masked[i] === '(') depth += 1;
    else if (masked[i] === ')') {
      depth -= 1;
      if (depth === 0) { afterParams = i + 1; break; }
    }
  }
  if (afterParams === -1) return null;
  const open = masked.indexOf('{', afterParams);
  if (open === -1) return null;
  depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '{') depth += 1;
    else if (masked[i] === '}') {
      depth -= 1;
      if (depth === 0) return masked.slice(open, i + 1);
    }
  }
  return null;
}

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__' || entry === '.next') continue;
      walk(p, acc);
    } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) {
      acc.push(p.replaceAll('\\', '/'));
    }
  }
  return acc;
}

const rel = (p) => p.replaceAll('\\', '/').slice(CONSOLE_ROOT.length + 1);

// ── 1: the chokepoints resolve the prefix ───────────────────────────────────
for (const { file, fn, why } of CHOKEPOINTS) {
  if (!existsSync(file)) { fail(`${file}: missing — the guard is pointed at the wrong module.`); continue; }
  const masked = mask(readFileSync(file, 'utf8'));
  const body = functionBody(masked, fn);
  if (body === null) {
    fail(`${file}: ${fn}() not found. If it was renamed, update CHOKEPOINTS in this guard — do not delete the resolution.`);
    continue;
  }
  if (!/cosmosIdFromLoomId\s*\(/.test(body)) {
    fail(
      `${file}: ${fn}() no longer resolves the \`loom:\` prefix (cosmosIdFromLoomId). ` +
      `This is THE chokepoint — ${why} — so dropping it re-opens #2830 for every one of them at once.`,
    );
  }
}

// ── 2: one definition of the vocabulary ─────────────────────────────────────
if (!existsSync(VOCAB_FILE)) {
  fail(`${VOCAB_FILE}: missing — the \`loom:\` vocabulary must live in ONE dependency-free module.`);
} else {
  const vocab = mask(readFileSync(VOCAB_FILE, 'utf8'));
  for (const sym of ['LOOM_ID_PREFIX', 'isLoomContentId', 'cosmosIdFromLoomId']) {
    if (!new RegExp(`export\\s+(?:const|function)\\s+${sym}\\b`).test(vocab)) {
      fail(`${VOCAB_FILE}: does not export ${sym}.`);
    }
  }
}

const allFiles = SCAN_DIRS.flatMap((d) => walk(d));
const prefixUsed = new Set();
/**
 * The shapes that RE-IMPLEMENT the vocabulary rather than mention the scheme.
 * Deliberately narrow: `loom://` lineage URIs, `loom:${…}` cache/pin/tab keys and
 * doc-comment mentions are a DIFFERENT namespace and flagging them would bury the
 * one signal that matters under ~28 unrelated hits.
 */
const PREFIX_REDEFINITION = [
  /=\s*['"`]loom:['"`]/,                  // const X = 'loom:'
  /startsWith\s*\(\s*['"`]loom:['"`]/,    // id.startsWith('loom:')
  /slice\s*\(\s*['"`]loom:['"`]\.length/, // id.slice('loom:'.length)
];
for (const file of allFiles) {
  const r = rel(file);
  if (r === rel(VOCAB_FILE)) continue;
  // Scanned on comment-stripped source (the literal IS a string body, so masking
  // would blank the very thing being looked for) — a doc comment cannot trip it.
  const noComments = stripComments(readFileSync(file, 'utf8'));
  const hit = PREFIX_REDEFINITION.find((re) => re.test(noComments));
  if (!hit) continue;
  if (PREFIX_ALLOWLIST.has(r)) { prefixUsed.add(r); continue; }
  const line = noComments.split('\n').findIndex((l) => hit.test(l)) + 1;
  fail(
    `${r}:${line}: RE-IMPLEMENTS the \`loom:\` item-id prefix. Import LOOM_ID_PREFIX / ` +
    `isLoomContentId / cosmosIdFromLoomId from app/api/items/_lib/loom-content-id instead, or pin ` +
    `it in PREFIX_ALLOWLIST in this guard WITH the reason. A second definition is a second thing ` +
    `to forget when the scheme changes.`,
  );
}

// ── 3: sweep every sub-route of every `loom:`-emitting item type ────────────
/**
 * DISCOVER the emitting types rather than hard-coding them: a list route that
 * maps items through a `*ListEntry` builder from pbi-content-fallback is exactly
 * the thing that mints `loom:<cosmosItemId>` ids for its type.
 */
const emittingTypes = [];
for (const entry of readdirSync(ITEMS_ROOT)) {
  const listRoute = join(ITEMS_ROOT, entry, 'route.ts');
  if (entry.startsWith('_') || entry.startsWith('[') || !existsSync(listRoute)) continue;
  const masked = mask(readFileSync(listRoute, 'utf8'));
  if (/\b\w+ListEntry\b/.test(masked) && /pbi-content-fallback/.test(readFileSync(listRoute, 'utf8'))) {
    emittingTypes.push(entry);
  }
}
if (emittingTypes.length === 0) {
  fail(
    `${ITEMS_ROOT}: no list route mints \`loom:\` ids any more. If the synthetic-id scheme was ` +
    `removed, delete this guard deliberately; if a list route was renamed, the sweep below is now ` +
    `vacuous and would pass while covering nothing.`,
  );
}

/**
 * Patterns that reach Cosmos by id OUTSIDE the resolving chokepoints.
 *
 * `on` selects the source view, and getting it wrong makes the pattern
 * unfalsifiable: the SQL predicate lives INSIDE a string literal, and masking
 * blanks string bodies — so scanning `c.id = @id` on the masked source matched
 * nothing anywhere and the rule silently covered zero routes.
 */
const RAW_LOOKUPS = [
  [/c\.id\s*=\s*@id/, 'a raw Cosmos `WHERE c.id = @id` query', 'text'],
  [/\bloadItemRaw\s*\(/, 'loadItemRaw() (no ownership check AND no prefix resolution)', 'code'],
  [/\.item\s*\(\s*id\s*,/, 'a point read `.item(id, …)` on the raw path id', 'code'],
];
/** Symbols that prove the file resolves the prefix itself. */
const RESOLVES = /\b(cosmosIdFromLoomId|isLoomContentId)\b/;

let swept = 0;
const routeUsed = new Set();
for (const type of emittingTypes) {
  const idDir = join(ITEMS_ROOT, type, '[id]');
  if (!existsSync(idDir)) continue;
  for (const file of walk(idDir)) {
    if (!file.endsWith('/route.ts')) continue;
    swept += 1;
    const key = file.slice(ITEMS_ROOT.length + 1);
    const src = readFileSync(file, 'utf8');
    const views = { code: mask(src), text: stripComments(src) };
    const hit = RAW_LOOKUPS.find(([re, , on]) => re.test(views[on]));
    if (!hit) continue;
    if (RESOLVES.test(views.code)) continue;
    if (ROUTE_ALLOWLIST.has(key)) { routeUsed.add(key); continue; }
    const view = views[hit[2]];
    const line = view.split('\n').findIndex((l) => hit[0].test(l)) + 1;
    fail(
      `${rel(file)}:${line}: reaches Cosmos by id through ${hit[1]}, bypassing the resolving ` +
      `chokepoints, and never calls cosmosIdFromLoomId. The \`${type}\` list route mints ` +
      `\`loom:<cosmosItemId>\` ids and the editor threads them into every sub-route, so this ` +
      `404s (or silently no-ops) on an item that exists (#2830). Use loadOwnedItem / ` +
      `loadContentBackedItem, resolve the id yourself, or pin it in ROUTE_ALLOWLIST WITH the reason.`,
    );
  }
}

// ── 4: no invented workspace id ─────────────────────────────────────────────
for (const file of allFiles) {
  // Comment-stripped: this guard's own explanation of the defect, and the route
  // doc comments that quote the offending URL, are not call sites.
  const src = stripComments(readFileSync(file, 'utf8'));
  const m = /workspaceId=loom-[a-z]/.exec(src);
  if (!m) continue;
  const line = src.slice(0, m.index).split('\n').length;
  fail(
    `${rel(file)}:${line}: sends a backend NAME as a workspace id (\`${m[0]}\`). That sentinel only ` +
    `exists to satisfy a \`workspaceId required\` check on a handler that never reads it (#2830). ` +
    `Make the parameter optional on the branch that ignores it instead of inventing a value — the ` +
    `next reader cannot tell a fake workspace from a real one, and a later owner check would fail it.`,
  );
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(
  `[loom-content-id-chokepoint] chokepoints: ${CHOKEPOINTS.length}  ` +
  `loom:-emitting item types: ${emittingTypes.join(', ') || '(none)'}  ` +
  `sub-routes swept: ${swept}  ` +
  `(prefix exemptions: ${prefixUsed.size}/${PREFIX_ALLOWLIST.size}, route exemptions: ${routeUsed.size}/${ROUTE_ALLOWLIST.size})`,
);

for (const [map, used, label] of [
  [PREFIX_ALLOWLIST, prefixUsed, 'prefix'],
  [ROUTE_ALLOWLIST, routeUsed, 'route'],
]) {
  const stale = [...map.keys()].filter((k) => !used.has(k));
  if (stale.length > 0) {
    console.log(`[loom-content-id-chokepoint] NOTE — ${stale.length} stale ${label} exemption(s); remove when confirmed obsolete:`);
    for (const k of stale) console.log(`    ${k}`);
  }
}

if (failures.length > 0) {
  console.error('\n[loom-content-id-chokepoint] FAIL — a `loom:` bundle id can 404 on an item that exists (#2830).\n');
  for (const f of failures) console.error(`    ${f}`);
  console.error('\n  The synthetic list id `loom:<cosmosItemId>` reaches EVERY sub-route of its type.');
  console.error('  Resolving it must be structural, not remembered: keep it at the chokepoints, and');
  console.error('  when a route must look Cosmos up itself, call cosmosIdFromLoomId on the path id.\n');
  process.exit(1);
}

console.log('[loom-content-id-chokepoint] OK — the `loom:` prefix is resolved where it cannot be forgotten.');
