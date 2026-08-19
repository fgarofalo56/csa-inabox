#!/usr/bin/env node
/**
 * GUARDRAIL: installed-content-reachable  (merge-blocker)  — issues #3549 / #3551
 * ===========================================================================
 * RULE
 *
 *   IF AN INSTALL REPORTS AN ITEM AS `created` USING COUNTS TAKEN FROM BUNDLE
 *   CONTENT, SOMETHING MUST BE ABLE TO GIVE THAT CONTENT BACK TO THE EDITOR.
 *
 * Not "the provisioner ran". Not "the Azure object exists". The property is
 * REACHABILITY: an app install stamps the bundle's authored definition onto the
 * Cosmos item at `state.content` (`app/api/apps/[id]/install/route.ts`) and each
 * provisioner then reports `status:'created'` with counts read off that same
 * content. If nothing can serve the content back, the receipt states as fact
 * something the user can never see — `no-vaporware.md`'s named failure mode, and
 * `deploy-integrity.md` R7's "an error must not state what it did not establish"
 * applied to a success message.
 *
 * ---------------------------------------------------------------------------
 * THE INCIDENT THIS ENCODES
 * ---------------------------------------------------------------------------
 * Measured live on the Commercial estate, 2026-08-15 → 2026-08-18: FIVE item
 * types across FOUR storage layers and at least THREE app bundles all reported
 * `created` with accurate counts and all landed empty. The clearest instance:
 * `Real-Time Analytics Semantic Model` showed the install banner
 * "2 tables · 4 measures" directly above an editor body reading "This
 * Loom-native tabular model has no tables yet", with every storage action
 * disabled.
 *
 * The content was NOT missing and was NOT dropped at write time. The install
 * wrote it; the provisioner counted it; `loadModelContext` — the only source of
 * `tables` for the route the editor reads — consulted `state.content` ONLY when
 * the id carried the synthetic `loom:` list-route prefix. Editors open items by
 * their BARE Cosmos id, so every bundle-installed model fell through to a live
 * Power BI branch that has no dataset for that id and returns zero tables.
 *
 * That is why this guard has TWO rules. Rule 1 asks whether ANY mechanism can
 * serve an item type's content. Rule 2 asks whether the mechanism is reachable
 * by the id the editor actually uses — because #3551's instance PASSED rule 1
 * (six routes under `app/api/items/semantic-model/` read `state.content`) and
 * was still broken.
 *
 * ---------------------------------------------------------------------------
 * POPULATION MEMBERSHIP IS INDEPENDENT OF THE FIX
 * ---------------------------------------------------------------------------
 * A guard keyed to the UNSAFE spelling goes quiet on exactly the files that
 * adopt the fix; this repo has already paid for that. So neither rule keys on a
 * defect token:
 *
 *   Rule 1 — an item type is judged because it is registered in `PROVISIONERS`
 *            and its provisioner reads `input.content`. Adopting any fix removes
 *            neither. A fix changes the item type's VERDICT, never its
 *            membership.
 *   Rule 2 — a site is judged because a `loom:`-gated branch resolves content.
 *            The fix adds a bare-id path OUTSIDE that branch; the branch — and
 *            therefore the site — stays.
 *
 * Proved mechanically on every invocation by the embedded controls at the
 * bottom, which include a planted regression of each rule.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CANNOT SEE (stated, not implied)
 * ---------------------------------------------------------------------------
 * Rule 1's `content-read-route` mechanism proves a route exists that CAN serve
 * the content; it does not prove the editor calls it, nor that it calls it with
 * an id that resolves. Rule 2 covers the one id-shape mismatch that has actually
 * bitten (`loom:` vs bare). A different mismatch — a route reading `state.spec`
 * while the install writes `state.content` — is NOT detected structurally; the
 * `materialized-lake-view` instance of exactly that was found by hand during
 * #3549 triage and is pinned by a unit test, not by this guard.
 *
 * Anything the analyser cannot resolve is reported as UNJUDGED and FAILS. An
 * unjudged item is not a clean item: it means nobody has checked it. The counts
 * printed on a pass name the judged AND the unjudged population, so a guard that
 * silently narrowed its own reach is visible rather than reassuring.
 *
 * No dependency is available — the guardrails job runs `node scripts/ci/*.mjs`
 * on a bare checkout with no `pnpm install` — so the analysis is a hand-written
 * structural pass over blanked source, never a TypeScript AST.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const CONSOLE_DIR = join('apps', 'fiab-console');
const ENGINE = join(CONSOLE_DIR, 'lib', 'install', 'provisioning-engine.ts');
const PROVISIONER_DIR = join(CONSOLE_DIR, 'lib', 'install', 'provisioners');
const AUTO_BIND = join(CONSOLE_DIR, 'lib', 'azure', 'auto-bind-providers.ts');

/**
 * Item types whose bundle content is authored INTO A BACKING SERVICE that is
 * itself the source of truth, so no Cosmos-readable projection is required.
 *
 * WHY THIS IS NOT A BARE ALLOWLIST. A reason that is merely PLAUSIBLE is
 * un-falsifiable, and an allowlist entry whose reason stayed true of a sibling
 * branch has already cost this repo a real defect. So every entry must name a
 * `proof` symbol that the provisioner is required to still call. Delete the
 * backing write and the entry goes STALE and this guard FAILS — the entry
 * cannot quietly outlive the behaviour it describes.
 */
const BACKING_IS_TRUTH = {
  warehouse: {
    proof: 'synapseExec',
    reason:
      'the bundle DDL is executed into the Synapse dedicated SQL pool over TDS; the pool schema is the '
      + 'artifact and the editor queries it live, so there is nothing to project onto the Cosmos item',
  },
  'synapse-serverless-sql-pool': {
    proof: 'synapseExec',
    reason:
      'creates the Serverless external data source / views over the lake root via real TDS; the SQL '
      + 'endpoint is the artifact and is queried live',
  },
};

// ── source blanking ────────────────────────────────────────────────────────

/**
 * Blank comments and string/template TEXT while preserving every byte offset,
 * so a rule can never be satisfied by a COMMENT (a rule a comment satisfies
 * measures nothing) and every reported line number stays true. Code inside a
 * `${...}` template hole is deliberately preserved.
 */
export function blankSource(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = i + 2;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j); i = j; continue;
    }
    if (c === '/' && d === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      blank(i, Math.min(j + 2, n)); i = j + 2; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      blank(i + 1, j); i = j + 1; continue;
    }
    if (c === '`') {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') { depth++; j += 2; continue; }
        if (depth > 0 && src[j] === '}') { depth--; j++; continue; }
        if (depth === 0 && src[j] === '`') break;
        if (depth === 0) out[j] = out[j] === '\n' ? '\n' : ' ';
        j++;
      }
      i = j + 1; continue;
    }
    i++;
  }
  return out.join('');
}

/** Index of `{` -> matching `}` over blanked source. */
function braceMap(src) {
  const stack = [];
  const close = new Map();
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '{') stack.push(i);
    else if (src[i] === '}') { const o = stack.pop(); if (o !== undefined) close.set(o, i); }
  }
  return close;
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

// ── content-read detection ─────────────────────────────────────────────────

/**
 * A DIRECT read of an item's bundle content. `state.content` is the key the
 * install writes; the `*FromContent` / `*ContentFromItem` / `contentOf<>`
 * families are the shared projections built over it.
 */
const DIRECT_CONTENT_READ =
  /state\s*\??\s*\.\s*content|loadContentBackedItem\s*\(|\w+FromContent\s*\(|\w+ContentFromItem\s*\(|contentOf\s*</;

/**
 * Local functions in this file whose own body performs a direct content read.
 * Calls to them count as content resolution — otherwise every route that wraps
 * its read in a one-line local helper (`loomDetail`, `loomNativeDetail`,
 * `loomScorecard`, `contextFromContentItem`, …) would read as having no content
 * path at all, and the guard would fail whole files that are perfectly correct.
 */
function contentReadingLocals(blanked, close) {
  const names = new Set();
  const decl =
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(|(?:^|\n)\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/g;
  let m;
  while ((m = decl.exec(blanked))) {
    const name = m[1] || m[2];
    const open = blanked.indexOf('{', m.index + m[0].length - 1);
    if (open < 0) continue;
    const end = close.get(open);
    if (end === undefined) continue;
    if (DIRECT_CONTENT_READ.test(blanked.slice(open, end))) names.add(name);
  }
  return names;
}

function resolvesContent(text, locals) {
  if (DIRECT_CONTENT_READ.test(text)) return true;
  for (const nm of locals) {
    if (new RegExp(`\\b${nm}\\s*\\(`).test(text)) return true;
  }
  return false;
}

/**
 * Does `text` reach the Loom ITEM for `idVar` — either by reading its content
 * directly, or by handing the id to a loader?
 *
 * THE DISCRIMINATOR, STATED PLAINLY. This is a heuristic, and it is the one
 * place this guard trades precision for reach, so it is worth being explicit
 * about what it keys on: a call that takes the item id as its FIRST argument is
 * loading THAT item, whereas the live-backend reads this defect falls through to
 * take a workspace/dataset context first (`getDataset(workspaceId, id)`,
 * `listDatasetTables(workspaceId, id)`). Combined with a loader-shaped name that
 * separates the two shapes cleanly across every site in the current population.
 *
 * Its failure mode is a FALSE NEGATIVE — a fall-through that happens to pass the
 * id first to something that is not a loader would be credited. It cannot
 * produce a false positive, which is the direction that would get the guard
 * disabled rather than fixed.
 */
function resolvesItemById(text, idVar, locals) {
  if (resolvesContent(text, locals)) return true;
  return new RegExp(
    `\\b(?:load|get|read|fetch|resolve)\\w*\\s*\\(\\s*(?:cosmosIdFromLoomId\\s*\\(\\s*)?${idVar}\\b`,
  ).test(text);
}

/** True when a block's control flow leaves the enclosing function. */
function blockTerminates(block) {
  return /\b(?:return|throw)\b/.test(block);
}

// ── file walking ───────────────────────────────────────────────────────────

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (e !== '__tests__' && e !== 'node_modules' && e !== '.next') walk(p, out);
    } else if ((p.endsWith('.ts') || p.endsWith('.tsx')) && !p.includes('.test.')) {
      out.push(p);
    }
  }
  return out;
}

// ── RULE 1 ─────────────────────────────────────────────────────────────────

/**
 * @returns {{rows: Array, unjudged: Array}}
 */
export function judgeItemTypes(io) {
  const engine = io.read(ENGINE);
  const start = engine.indexOf('export const PROVISIONERS');
  const rows = [];
  const unjudged = [];
  if (start < 0) {
    unjudged.push({ itemType: '(registry)', why: 'PROVISIONERS registry not found in provisioning-engine.ts' });
    return { rows, unjudged };
  }
  const regEnd = engine.indexOf('};', start);
  const registry = engine.slice(start, regEnd < 0 ? engine.length : regEnd);

  const sym2file = new Map();
  for (const m of engine.matchAll(
    /import\s*\{\s*(\w+)\s*\}\s*from\s*'\.\/provisioners\/([\w-]+)'/g,
  )) sym2file.set(m[1], m[2]);

  const seeded = new Set();
  const abp = io.exists(AUTO_BIND) ? io.read(AUTO_BIND) : '';
  for (const m of abp.matchAll(/itemTypes:\s*\[([^\]]+)\]/g)) {
    for (const t of m[1].matchAll(/'([\w-]+)'/g)) seeded.add(t[1]);
  }
  if (abp && seeded.size === 0) {
    unjudged.push({ itemType: '(auto-bind)', why: 'auto-bind-providers.ts parsed but yielded no itemTypes — the seeding mechanism cannot be credited' });
  }

  for (const m of registry.matchAll(/'([\w-]+)'\s*:\s*(\w+)/g)) {
    const itemType = m[1];
    const sym = m[2];
    const file = sym2file.get(sym);
    if (!file) { unjudged.push({ itemType, why: `provisioner symbol '${sym}' has no resolvable import` }); continue; }
    const path = join(PROVISIONER_DIR, `${file}.ts`);
    if (!io.exists(path)) { unjudged.push({ itemType, why: `provisioner module '${path}' not found` }); continue; }
    const src = io.read(path);
    if (!/input\s*\.\s*content/.test(src)) {
      rows.push({ itemType, verdict: 'not-judged', why: 'provisioner reads no bundle content', file });
      continue;
    }
    const mech = [];
    if (/itemsContainer\s*\(/.test(src)) mech.push('persists');
    if (seeded.has(itemType)) mech.push('seeds-backing');

    const dirs = [
      join(CONSOLE_DIR, 'app', 'api', 'items', itemType),
      join(CONSOLE_DIR, 'app', 'api', itemType),
      join(CONSOLE_DIR, 'app', 'api', `${itemType}s`),
    ].filter((d) => io.exists(d));
    let routeHits = 0;
    for (const d of dirs) {
      for (const f of io.walk(d)) if (DIRECT_CONTENT_READ.test(io.read(f))) routeHits++;
    }
    if (routeHits > 0) mech.push(`content-read-route(${routeHits})`);

    const declared = BACKING_IS_TRUTH[itemType];
    if (declared) {
      if (new RegExp(`\\b${declared.proof}\\s*\\(`).test(src)) mech.push('backing-is-truth');
      else {
        rows.push({
          itemType, file, verdict: 'stale-declaration',
          why: `declared backing-is-truth on '${declared.proof}', but the provisioner no longer calls it`,
        });
        continue;
      }
    }
    rows.push({ itemType, file, verdict: mech.length ? 'ok' : 'unreachable', mech });
  }
  return { rows, unjudged };
}

// ── RULE 2 ─────────────────────────────────────────────────────────────────

/**
 * Split the file into TOP-LEVEL DECLARATION SCOPES.
 *
 * WHY NOT BRACE-MATCH THE ENCLOSING FUNCTION. That was tried first and it
 * SILENTLY MISJUDGED A REAL REGRESSION. `loadBulkContext` in
 * `semantic-model/[id]/describe-bulk/route.ts` is declared with a multi-line
 * signature whose return type is `Promise<{ … }>`, so the brace walk could not
 * identify which `{` opened the body, fell back to whole-FILE scope, and then
 * credited the function with... its own call site further down the file (the
 * function is itself a content-reading local). The planted regression came back
 * `ok`. A guard that widens its scope on failure will quietly excuse the thing
 * it is watching for, so scope resolution is now positional and cannot fail
 * open: a site is judged only against the declaration it sits in.
 */
function topLevelScopes(blanked) {
  const starts = [];
  const re = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([\w$]+)/gm;
  let m;
  while ((m = re.exec(blanked))) starts.push({ index: m.index, name: m[1] });
  return starts.map((s, i) => ({
    name: s.name,
    start: s.index,
    end: i + 1 < starts.length ? starts[i + 1].index : blanked.length,
  }));
}

/**
 * Judge one file's `loom:`-gated content branches.
 * @returns Array<{line, verdict:'ok'|'unreachable'|'unknown', scope}>
 */
export function judgeLoomGatedFile(src) {
  const blanked = blankSource(src);
  const close = braceMap(blanked);
  const allLocals = contentReadingLocals(blanked, close);
  const scopes = topLevelScopes(blanked);
  const sites = [];

  const re = /if\s*\(\s*(!\s*)?isLoomContentId\s*\(\s*([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(blanked))) {
    const idVar = m[2];
    // The `if` header's closing paren, then its block.
    let depth = 0;
    let i = blanked.indexOf('(', m.index);
    let headerEnd = -1;
    for (; i < blanked.length; i++) {
      if (blanked[i] === '(') depth++;
      else if (blanked[i] === ')') { depth--; if (depth === 0) { headerEnd = i; break; } }
    }
    if (headerEnd < 0) { sites.push({ line: lineOf(src, m.index), verdict: 'unknown', scope: 'if-header unterminated' }); continue; }
    let j = headerEnd + 1;
    while (j < blanked.length && /\s/.test(blanked[j])) j++;
    let blockStart;
    let blockEnd;
    if (blanked[j] !== '{') {
      // A single-statement `if` body. Judge the statement up to its `;`.
      const semi = blanked.indexOf(';', j);
      if (semi < 0) { sites.push({ line: lineOf(src, m.index), verdict: 'unknown', scope: 'if-body unterminated' }); continue; }
      blockStart = j; blockEnd = semi + 1;
    } else {
      const end = close.get(j);
      if (end === undefined) { sites.push({ line: lineOf(src, m.index), verdict: 'unknown', scope: 'if-block unbalanced' }); continue; }
      blockStart = j; blockEnd = end + 1;
    }

    const block = blanked.slice(blockStart, blockEnd);

    // SCOPE FIRST — and a declaration may never credit ITSELF. `loadBulkContext`
    // reads content inside the very branch under judgement, which makes it a
    // "content-reading local"; letting its own name count as an independent
    // content path is circular and was the second half of the miss described on
    // `topLevelScopes`.
    const scope = scopes.find((s) => m.index >= s.start && m.index < s.end);
    if (!scope) {
      sites.push({ line: lineOf(src, m.index), verdict: 'unknown', scope: 'no enclosing top-level declaration' });
      continue;
    }
    const locals = new Set([...allLocals].filter((n) => n !== scope.name));
    const scopeStart = scope.start;
    const scopeEnd = scope.end;

    // POPULATION: only a branch that RESOLVES CONTENT is judged. A `loom:` test
    // used merely to skip a Power BI embed is not this defect and is not judged.
    if (!resolvesContent(block, locals)) continue;

    // AN `else` THAT LOADS THE SAME ITEM IS NOT THIS DEFECT.
    // `if (isLoomContentId(id)) { item = loadContentBackedItem(strip(id)) } else
    // { item = loadModelItem(id, …) }` is an ID-SHAPE fork: both branches
    // produce the item and everything downstream is shared, so a bare id
    // reaches the content by construction. The defect is the shape with NO such
    // path — the loom branch returns content and the fall-through goes to a
    // live Power BI read that has no dataset for that id. Requiring the else to
    // pass the SAME id variable into a call keeps this from crediting an else
    // that merely 404s.
    let k = blockEnd;
    while (k < blanked.length && /\s/.test(blanked[k])) k++;
    if (blanked.startsWith('else', k)) {
      let e = k + 4;
      while (e < blanked.length && /\s/.test(blanked[e])) e++;
      let elseEnd = -1;
      if (blanked[e] === '{') elseEnd = close.get(e) ?? -1;
      else { const semi = blanked.indexOf(';', e); elseEnd = semi < 0 ? -1 : semi; }
      if (elseEnd < 0) {
        sites.push({ line: lineOf(src, m.index), verdict: 'unknown', scope: 'else-branch unterminated' });
        continue;
      }
      const elseBlock = blanked.slice(e, elseEnd + 1);
      if (resolvesItemById(elseBlock, idVar, locals)) {
        sites.push({ line: lineOf(src, m.index), verdict: 'ok', scope: 'else-fork' });
        continue;
      }
    }

    const outside = blanked.slice(scopeStart, blockStart) + blanked.slice(blockEnd, scopeEnd);
    // An EARLY-RETURN fork is the `else`-less spelling of the same thing:
    //   if (isLoomContentId(id)) { return fromContent(strip(id)); }
    //   return loadModelItem(id, …);
    // When the loom branch leaves the function, the code after it IS the other
    // branch, so a loader taking the bare id there is the bare-id path.
    const after = blanked.slice(blockEnd, scopeEnd);
    if (blockTerminates(block) && resolvesItemById(after, idVar, locals)) {
      sites.push({ line: lineOf(src, m.index), verdict: 'ok', scope: 'early-return-fork' });
      continue;
    }
    sites.push({
      line: lineOf(src, m.index),
      verdict: resolvesContent(outside, locals) ? 'ok' : 'unreachable',
      scope: `decl:${scope.name}`,
    });
  }
  return sites;
}

// ── embedded controls ──────────────────────────────────────────────────────

const CONTROL_UNREACHABLE = `
import { isLoomContentId, cosmosIdFromLoomId, loadContentBackedItem } from './_lib/loom-content-id';
export async function loadThing(id: string, workspaceId: string | null, tenantId: string) {
  if (isLoomContentId(id)) {
    const item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'thing', tenantId);
    return { tables: item ? item.state.content.tables : [] };
  }
  const live = await getDataset(workspaceId, id);
  return { tables: live.tables };
}
`;

const CONTROL_REACHABLE = `
import { isLoomContentId, cosmosIdFromLoomId, loadContentBackedItem } from './_lib/loom-content-id';
async function fromContentItem(cosmosItemId: string, tenantId: string) {
  const item = await loadContentBackedItem(cosmosItemId, 'thing', tenantId);
  return item ? { tables: item.state.content.tables } : null;
}
export async function loadThing(id: string, workspaceId: string | null, tenantId: string) {
  const built = await fromContentItem(cosmosIdFromLoomId(id), tenantId);
  if (built) return built;
  if (isLoomContentId(id)) {
    const item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'thing', tenantId);
    return { tables: item ? item.state.content.tables : [] };
  }
  const live = await getDataset(workspaceId, id);
  return { tables: live.tables };
}
`;

/** A comment must never satisfy the rule. */
const CONTROL_COMMENT_ONLY = `
export async function loadThing(id: string, workspaceId: string | null, tenantId: string) {
  if (isLoomContentId(id)) {
    const item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'thing', tenantId);
    return { tables: item.state.content.tables };
  }
  // We also read state.content here via loadContentBackedItem(...) — or so this
  // comment claims. reportPagesFromContent(item) is likewise only prose.
  return { tables: [] };
}
`;

/**
 * The ID-SHAPE FORK: both branches produce the item, so a bare id reaches the
 * content. Must NOT be flagged.
 */
const CONTROL_ELSE_FORK = `
export async function handler(id: string, oid: string) {
  let item;
  if (isLoomContentId(id)) {
    item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'report', oid);
    if (!item) return notFound();
  } else {
    item = await loadModelItem(id, 'report', oid);
    if (!item) return notFound();
  }
  return respond(item);
}
`;

/**
 * An `else` that does NOT resolve the item is not a fork — it is a dead end,
 * and must still be flagged. Without this control the else-refinement above
 * could credit any `else` at all and quietly hollow out rule 2.
 */
const CONTROL_ELSE_DEAD_END = `
export async function handler(id: string, oid: string) {
  if (isLoomContentId(id)) {
    const item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'report', oid);
    return respond(item.state.content);
  } else {
    return { ok: true, pages: [] };
  }
}
`;

/**
 * The EARLY-RETURN fork — the `else`-less spelling of CONTROL E. Must NOT be
 * flagged.
 */
const CONTROL_EARLY_RETURN_FORK = `
async function loadReport(id: string, oid: string) {
  if (isLoomContentId(id)) {
    return loadContentBackedItem(cosmosIdFromLoomId(id), 'report', oid);
  }
  return loadModelItem(id, 'report', oid);
}
`;

/**
 * THE REAL PRE-FIX DEFECT, verbatim in shape: the loom branch returns content
 * and the fall-through is a LIVE-BACKEND read that takes a workspace context
 * first. This is `loadModelContext` before #3549/#3551 and it must be flagged —
 * it is the single case that distinguishes this guard from one that merely
 * credits any code after the branch.
 */
const CONTROL_LIVE_FALLTHROUGH = `
export async function loadModelContext(id: string, workspaceId: string | null, tenantId: string) {
  if (isLoomContentId(id)) {
    const item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'semantic-model', tenantId);
    const built = item ? semanticModelDetailFromContent(item) : null;
    return { tables: built ? built.tables : [], liveDataset: false };
  }
  if (!workspaceId) return { tables: [], liveDataset: true };
  const [dataset, tables, rels] = await Promise.all([
    getDataset(workspaceId, id),
    listDatasetTables(workspaceId, id),
    listDatasetRelationships(workspaceId, id),
  ]);
  return { modelName: dataset.name, tables, rels, liveDataset: true };
}
`;

/**
 * THE SELF-CREDIT / SCOPE-WIDENING MISS, planted verbatim.
 *
 * An earlier revision of this analyser brace-matched the enclosing function.
 * A multi-line signature returning `Promise<{ … }>` defeated that walk, it fell
 * back to whole-FILE scope, and then credited `loadBulkContext` with its OWN
 * call site in the handler below — returning `ok` for a genuine regression.
 * Both halves are pinned here: positional scoping, and a declaration never
 * counting as its own independent content path.
 */
const CONTROL_SELF_CREDIT = `
async function loadBulkContext(
  id: string, workspaceId: string | null, tenantId: string,
): Promise<{ modelName: string; tables: BulkTable[]; liveDataset: boolean; notice?: string }> {
  if (isLoomContentId(id)) {
    const item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'semantic-model', tenantId);
    const built = item ? semanticModelDetailFromContent(item) : null;
    return { modelName: 'm', tables: built ? built.tables : [], liveDataset: false };
  }
  if (!workspaceId) return { modelName: 'm', tables: [], liveDataset: true };
  const [dataset, pbiTables] = await Promise.all([
    getDataset(workspaceId, id),
    listDatasetTables(workspaceId, id),
  ]);
  return { modelName: dataset.name, tables: pbiTables, liveDataset: true };
}

export const POST = withSession(async (req, ctx) => {
  const model = await loadBulkContext(ctx.params.id, null, ctx.session.claims.oid);
  return NextResponse.json({ ok: true, model });
});
`;

function runControls(failures) {
  const unreachable = judgeLoomGatedFile(CONTROL_UNREACHABLE);
  if (unreachable.length !== 1 || unreachable[0].verdict !== 'unreachable') {
    failures.push(
      `CONTROL A BROKEN: the planted loom-gated-only resolver was judged `
      + `${JSON.stringify(unreachable)} — expected exactly one 'unreachable'. The analyser cannot see the `
      + 'defect it exists to catch, so a clean report from it means nothing.',
    );
  }
  const reachable = judgeLoomGatedFile(CONTROL_REACHABLE);
  if (reachable.length !== 1 || reachable[0].verdict !== 'ok') {
    failures.push(
      `CONTROL B BROKEN: the planted ADOPTER (bare-id path present) was judged `
      + `${JSON.stringify(reachable)} — expected exactly one 'ok'. A guard that also flags the fix would be `
      + 'discarded rather than adopted.',
    );
  }
  const commentOnly = judgeLoomGatedFile(CONTROL_COMMENT_ONLY);
  if (commentOnly.length !== 1 || commentOnly[0].verdict !== 'unreachable') {
    failures.push(
      `CONTROL C BROKEN: a file whose only bare-id "content read" is inside a COMMENT was judged `
      + `${JSON.stringify(commentOnly)} — expected 'unreachable'. Comment blanking has regressed.`,
    );
  }

  const elseFork = judgeLoomGatedFile(CONTROL_ELSE_FORK);
  if (elseFork.length !== 1 || elseFork[0].verdict !== 'ok' || elseFork[0].scope !== 'else-fork') {
    failures.push(
      `CONTROL E BROKEN: the planted id-shape fork (both branches load the item) was judged `
      + `${JSON.stringify(elseFork)} — expected one 'ok' with scope 'else-fork'.`,
    );
  }
  const elseDeadEnd = judgeLoomGatedFile(CONTROL_ELSE_DEAD_END);
  if (elseDeadEnd.length !== 1 || elseDeadEnd[0].verdict !== 'unreachable') {
    failures.push(
      `CONTROL F BROKEN: an \`else\` that resolves NOTHING was judged ${JSON.stringify(elseDeadEnd)} — expected `
      + "'unreachable'. The else-refinement is crediting any else branch and rule 2 has been hollowed out.",
    );
  }

  const earlyFork = judgeLoomGatedFile(CONTROL_EARLY_RETURN_FORK);
  if (earlyFork.length !== 1 || earlyFork[0].verdict !== 'ok' || earlyFork[0].scope !== 'early-return-fork') {
    failures.push(
      `CONTROL G BROKEN: the planted early-return fork was judged ${JSON.stringify(earlyFork)} — expected one `
      + "'ok' with scope 'early-return-fork'.",
    );
  }
  const liveFallthrough = judgeLoomGatedFile(CONTROL_LIVE_FALLTHROUGH);
  if (liveFallthrough.length !== 1 || liveFallthrough[0].verdict !== 'unreachable') {
    failures.push(
      `CONTROL H BROKEN: the REAL pre-#3551 shape (loom branch returns content; fall-through is a live Power BI `
      + `read) was judged ${JSON.stringify(liveFallthrough)} — expected 'unreachable'. This is the one control `
      + 'that separates this guard from one that credits any code after the branch; if it passes, the guard has '
      + 'stopped watching the defect it was written for.',
    );
  }

  const selfCredit = judgeLoomGatedFile(CONTROL_SELF_CREDIT);
  if (selfCredit.length !== 1 || selfCredit[0].verdict !== 'unreachable') {
    failures.push(
      `CONTROL I BROKEN: the planted scope-widening / self-credit regression was judged `
      + `${JSON.stringify(selfCredit)} — expected 'unreachable'. This exact miss shipped once during #3549: the `
      + 'analyser widened to file scope on a signature it could not parse and then let the function answer for '
      + 'itself. If this control passes, the guard is excusing the defect it watches for.',
    );
  }

  // Rule 1's control: a synthetic registry with a content-reading provisioner
  // and no mechanism at all must be flagged.
  const fakeIo = {
    read: (p) => {
      if (p === ENGINE) {
        return "import { thingProvisioner } from './provisioners/thing';\n"
          + "export const PROVISIONERS: Record<string, Provisioner> = {\n  'thing': thingProvisioner,\n};\n";
      }
      if (p === AUTO_BIND) return "itemTypes: ['something-else'],";
      if (p.endsWith(`thing.ts`)) return 'const c = input.content; return { status: "created" };';
      return '';
    },
    exists: (p) => p === ENGINE || p === AUTO_BIND || p.endsWith(`thing.ts`),
    walk: () => [],
  };
  const { rows, unjudged } = judgeItemTypes(fakeIo);
  const thing = rows.find((r) => r.itemType === 'thing');
  if (!thing || thing.verdict !== 'unreachable' || unjudged.length !== 0) {
    failures.push(
      `CONTROL D BROKEN: a synthetic content-consuming provisioner with NO reachability mechanism was judged `
      + `${JSON.stringify(thing)} (unjudged=${unjudged.length}) — expected 'unreachable'.`,
    );
  }
}

// ── main ───────────────────────────────────────────────────────────────────

function main() {
  const failures = [];
  runControls(failures);

  const io = {
    read: (p) => readFileSync(p, 'utf8'),
    exists: (p) => existsSync(p),
    walk: (d) => walk(d),
  };

  if (!existsSync(ENGINE)) {
    console.error(`check-installed-content-reachable: FAILED — ${ENGINE} not found; the population cannot be built.`);
    process.exit(1);
  }

  // RULE 1
  const { rows, unjudged } = judgeItemTypes(io);
  const judged = rows.filter((r) => r.verdict !== 'not-judged');
  const notJudged = rows.filter((r) => r.verdict === 'not-judged');
  const unreachableTypes = rows.filter((r) => r.verdict === 'unreachable');
  const staleDecls = rows.filter((r) => r.verdict === 'stale-declaration');

  // A registry that yields no judged item types means the parse drifted, not
  // that the codebase is clean (a guard with zero population measures nothing).
  if (judged.length === 0) {
    failures.push(
      'RULE 1 POPULATION IS EMPTY: no registered item type was judged. The PROVISIONERS registry parse has '
      + 'drifted — this is a broken analyser, not a clean codebase.',
    );
  }

  // RULE 2
  const files = walk(join(CONSOLE_DIR, 'app')).concat(walk(join(CONSOLE_DIR, 'lib')));
  const sites = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (!src.includes('isLoomContentId')) continue;
    for (const s of judgeLoomGatedFile(src)) sites.push({ ...s, path: f.split(sep).join('/') });
  }
  const badSites = sites.filter((s) => s.verdict === 'unreachable');
  const unknownSites = sites.filter((s) => s.verdict === 'unknown');
  if (sites.length === 0) {
    failures.push(
      'RULE 2 POPULATION IS EMPTY: no `loom:`-gated content branch was found anywhere. Either the vocabulary '
      + 'was renamed (in which case this guard now watches nothing) or the scan roots are wrong.',
    );
  }

  if (unreachableTypes.length || staleDecls.length || badSites.length || unknownSites.length || unjudged.length || failures.length) {
    console.error('\ncheck-installed-content-reachable: FAILED\n');

    for (const f of failures) console.error(`  ${f}\n`);

    for (const r of unreachableTypes) {
      console.error(`  RULE 1 UNREACHABLE — item type '${r.itemType}' (provisioners/${r.file}.ts)`);
      console.error(
        '    Its provisioner reads the bundle `input.content` and can report `created` with counts taken from '
        + 'it, but NOTHING can give that content back: it does not persist to Cosmos, it is not covered by the '
        + 'auto-bind seed registry, no route directory named for it reads `state.content`, and it is not '
        + 'declared backing-is-truth.',
      );
      console.error(
        '    Fix: persist the provisioned content onto the item (see provisioners/activator.ts), OR add the '
        + 'item type to the auto-bind seed registry so the backing object is authored, OR add a route under '
        + `app/api/items/${r.itemType}/ that serves \`state.content\`, OR — if the backing service genuinely IS `
        + 'the artifact — declare it in BACKING_IS_TRUTH in this file WITH the symbol that proves the backing '
        + 'write still happens.\n',
      );
    }
    for (const r of staleDecls) {
      console.error(`  RULE 1 STALE DECLARATION — '${r.itemType}': ${r.why}`);
      console.error(
        '    The backing-is-truth reason outlived the behaviour it described. Either restore the backing write '
        + 'or delete the declaration and give the item type a real reachability mechanism.\n',
      );
    }
    for (const s of badSites) {
      console.error(`  RULE 2 UNREACHABLE — ${s.path}:${s.line} (scope: ${s.scope})`);
      console.error(
        '    This branch serves an item\'s bundle content ONLY when the id carries the synthetic `loom:` '
        + 'list-route prefix, and the enclosing scope has no other content path. Editors open items by their '
        + 'BARE Cosmos id, so a bundle-installed item takes the other branch and renders empty while the '
        + 'install receipt reports it created (#3549/#3551).',
      );
      console.error(
        '    Fix: resolve the content by the bare id FIRST and fall through only when nothing resolves — see '
        + '`contextFromContentItem` in lib/semantic-model/model-context.ts.\n',
      );
    }
    for (const s of unknownSites) {
      console.error(`  RULE 2 UNJUDGED — ${s.path}:${s.line}: ${s.scope}`);
      console.error(
        '    UNKNOWN IS NOT SAFE: the analyser could not delimit this branch, so nobody has checked whether a '
        + 'bare id reaches the content. Simplify the branch or extend the analyser.\n',
      );
    }
    for (const u of unjudged) {
      console.error(`  RULE 1 UNJUDGED — '${u.itemType}': ${u.why}`);
      console.error('    An unjudged item type is not a clean one; it means nothing checked it.\n');
    }
    process.exit(1);
  }

  const declared = Object.keys(BACKING_IS_TRUTH).length;
  console.log(
    `check-installed-content-reachable: OK (RULE 1 — ${judged.length} registered item type(s) JUDGED, all with a `
    + `content-reachability mechanism, of which ${declared} declared backing-is-truth with a verified proof symbol; `
    + `${notJudged.length} further registered item type(s) read no bundle content and are NOT judged `
    + `[${notJudged.map((r) => r.itemType).join(', ') || 'none'}]; 0 unjudged. `
    + `RULE 2 — ${sites.length} \`loom:\`-gated content branch(es) JUDGED across ${files.length} scanned files, `
    + `0 unreachable, 0 unresolvable. 9 embedded controls intact.)`,
  );
}

// Run as a script, not as an import side effect (#3436) — importing this module
// to unit-test its helpers must not run the whole scan or process.exit() inside
// the test runner.
if (process.argv[1] && process.argv[1].endsWith('check-installed-content-reachable.mjs')) {
  main();
}
