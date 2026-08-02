#!/usr/bin/env node
/**
 * GUARDRAIL: tid-boundary-chokepoint  (merge-blocker — issue #2703)
 * ---------------------------------------------------------------------------
 * RULE:
 *
 *   The cross-tenant boundary in `resolveWorkspaceAccessByOid` (step 4: the
 *   caller's Entra `tid` must match the workspace doc's `tid`) must be
 *   IMPOSSIBLE TO SKIP BY OMISSION. Concretely:
 *
 *     1. `resolveWorkspaceAccessByOid` and `listAccessibleWorkspaces` take a
 *        REQUIRED `WorkspaceAccessOpts` — no `= {}` default. A new call site
 *        that forgets the tenant must be a COMPILE ERROR.
 *     2. `WorkspaceAccessOpts` keeps both arms: `callerTid` (enforce) and the
 *        explicit `skipTidBoundary` + `skipTidBoundaryReason` opt-out.
 *     3. The boundary is evaluated from `effectiveCallerTid(...)` — explicit tid
 *        first, then the ambient request session for the SAME principal — and it
 *        runs BEFORE the ACL grant and the admin-open bypass, not after.
 *     4. `ambientCallerTid` only borrows a tid when the ambient session's `oid`
 *        equals the oid being resolved (no cross-principal attribution).
 *     5. Every call site passes the options argument.
 *     6. `skipTidBoundary` — the one way to switch the boundary off — is pinned
 *        to an allowlist here, WITH a reason, so a new bypass is a review.
 *     7. `listAllOwnedItems` (the Copilot `item_list` backing) still accepts a
 *        session, so it CAN enforce the boundary.
 *
 * WHY A GUARD AND NOT JUST TYPES:
 *   `tsc` enforces (1) and (5) today, and that is the primary mechanism — but a
 *   single `as any` at a call site, or someone re-adding `= {}` "to unbreak the
 *   build", silently restores the exact hole #2703 filed: a security control
 *   that does nothing when an optional input is absent, while still READING as
 *   enforced. Items (3), (4) and (6) are not expressible in the type system at
 *   all. This turns each of those into a red build.
 *
 * ANTI-PATTERNS DELIBERATELY AVOIDED (learned from check-unity-audit-chokepoint's
 * three rewrites): comments and string literals are MASKED before any scan, so a
 * mention in a doc comment cannot satisfy a check; ordering assertions
 * brace-match the named function body rather than substring-testing the rest of
 * the file; and every exemption carries a reason and is reported when stale.
 *
 * ## PROVEN TO FAIL. Each of these was applied to the tree and the guard's exit
 * code recorded. A guard nobody has tried to defeat is a comment.
 *
 *   M1  `opts: WorkspaceAccessOpts = { callerTid: undefined }`      exit 1
 *   M2  `effectiveCallerTid` drops the `ambientCallerTid` fallback  exit 1
 *   M3  `ambientCallerTid` drops the `claims.oid !== oid` check     exit 1
 *   M4  `callerTid` made optional on the enforcing arm              exit 1
 *   M5  `listAllOwnedItems` loses its session parameter             exit 1
 *   M6  the tid comparison moved BELOW `resolveEffectiveRole`       exit 1
 *   M7  `await (resolveWorkspaceAccessByOid as any)(oid, ws)`       exit 1
 *   M8  an unpinned file passes `skipTidBoundary: true`             exit 1
 *   M10 `const f = resolveWorkspaceAccessByOid; f(oid, ws, …)`      exit 1
 *   M11 a plain 2-argument call (the original #2703 shape)          exit 1
 *   M9  NEGATIVE CONTROL — a comment mentioning skipTidBoundary     exit 0
 *
 * M7 and M10 exit 0 on the first draft of this file, which only matched
 * `name(`. That is why every MENTION of a guarded symbol is now classified, and
 * an indirect reference the guard cannot verify is itself a failure.
 *
 * Usage: node scripts/ci/check-tid-boundary-chokepoint.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CONSOLE_ROOT = 'apps/fiab-console';
const ACCESS_FILE = `${CONSOLE_ROOT}/lib/auth/workspace-access.ts`;
const ITEM_CRUD_FILE = `${CONSOLE_ROOT}/app/api/items/_lib/item-crud.ts`;
const SCAN_DIRS = [`${CONSOLE_ROOT}/app`, `${CONSOLE_ROOT}/lib`];

/** Functions whose options argument carries the tenant boundary. */
const GUARDED_CALLS = [
  // name                          minimum argument count (oid, …, opts)
  ['resolveWorkspaceAccessByOid', 3],
  ['listAccessibleWorkspaces', 2],
];

/**
 * Files permitted to use the `skipTidBoundary` opt-out, each with the reason a
 * reviewer can check against the file. EMPTY on purpose: no production call site
 * needs it today. Every caller either has the session (passes `callerTid`) or is
 * on-request (the resolver recovers the tid from the ambient session). Adding an
 * entry here is a security review, which is the point.
 */
const SKIP_ALLOWLIST = new Map([
  // ['lib/some/off-request-job.ts', 'reason a reviewer can verify against the file'],
]);

const failures = [];
const fail = (msg) => failures.push(msg);

// ── source masking ──────────────────────────────────────────────────────────
/**
 * Blank out line comments, block comments and string/template literals,
 * preserving byte offsets (so index comparisons below stay meaningful) and
 * newlines (so line numbers stay right). A doc comment that says
 * "skipTidBoundary" must not look like a call site.
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

/**
 * Brace-match a named function's body. Returns the masked body text, or null
 * when the function is absent (which the caller reports as a failure — a
 * renamed chokepoint must not silently pass).
 */
function functionBody(masked, name) {
  const decl = new RegExp(`function\\s+${name}\\s*[(<]`).exec(masked);
  if (!decl) return null;
  const open = masked.indexOf('{', decl.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '{') depth += 1;
    else if (masked[i] === '}') {
      depth -= 1;
      if (depth === 0) return masked.slice(open, i + 1);
    }
  }
  return null;
}

/** The masked parameter list of a named function (between its outer parens). */
function signature(masked, name) {
  const decl = new RegExp(`function\\s+${name}\\s*\\(`).exec(masked);
  if (!decl) return null;
  const open = masked.indexOf('(', decl.index);
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '(') depth += 1;
    else if (masked[i] === ')') {
      depth -= 1;
      if (depth === 0) return masked.slice(open + 1, i);
    }
  }
  return null;
}

/** Count TOP-LEVEL arguments of the call starting at `openParen`. */
function argCount(masked, openParen) {
  let depth = 0;
  let args = 0;
  let sawContent = false;
  for (let i = openParen; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') { depth += 1; continue; }
    if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return sawContent ? args + 1 : 0;
      continue;
    }
    if (depth === 1) {
      if (c === ',') { args += 1; continue; }
      if (!/\s/.test(c)) sawContent = true;
    }
  }
  return -1; // unbalanced
}

/**
 * The text of a `type X = …;` declaration. Stops at the first semicolon at brace
 * depth ZERO — the members inside the union arms are semicolon-separated too, so
 * a naive indexOf(';') truncates the declaration after its first field and makes
 * the arm assertions below silently vacuous.
 */
function typeDeclaration(masked, name) {
  const decl = new RegExp(`type\\s+${name}\\s*=`).exec(masked);
  if (!decl) return null;
  let depth = 0;
  for (let i = decl.index; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    else if (c === ';' && depth === 0) return masked.slice(decl.index, i);
  }
  return masked.slice(decl.index);
}

/**
 * Ranges covered by `import …;` / `export … from '…';` statements, so a symbol
 * mentioned in an import list is not mistaken for a reference. Computed on the
 * MASKED source (string bodies are already blanked, so the terminating `;` of an
 * import is unambiguous). Dynamic `import(` is not matched — it has no space.
 */
function importRanges(masked) {
  const ranges = [];
  const re = /\b(?:import|export)\s+[^;()]*?;/g;
  let m;
  while ((m = re.exec(masked)) !== null) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

function walk(dir, acc = []) {
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

// ── 1..4: the chokepoint module itself ──────────────────────────────────────
const accessSrc = readFileSync(ACCESS_FILE, 'utf8');
const access = mask(accessSrc);

if (!/export\s+type\s+WorkspaceAccessOpts\s*=/.test(access)) {
  fail(`${ACCESS_FILE}: WorkspaceAccessOpts is gone — the options type IS the compiler enforcement.`);
} else {
  const arms = typeDeclaration(access, 'WorkspaceAccessOpts') ?? '';
  if (!/callerTid\s*:\s*string\s*\|\s*undefined/.test(arms)) {
    fail(`${ACCESS_FILE}: WorkspaceAccessOpts lost its REQUIRED \`callerTid\` arm.`);
  }
  if (/callerTid\s*\?\s*:/.test(arms.split('|')[1] ?? arms)) {
    fail(`${ACCESS_FILE}: \`callerTid\` became OPTIONAL on the enforcing arm — omitting it is then legal again, which is #2703.`);
  }
  if (!/skipTidBoundary\s*:\s*true/.test(arms) || !/skipTidBoundaryReason\s*:\s*string/.test(arms)) {
    fail(`${ACCESS_FILE}: the opt-out arm must be \`skipTidBoundary: true\` WITH \`skipTidBoundaryReason: string\` — a bypass has to state its reason.`);
  }
}

for (const fn of ['resolveWorkspaceAccessByOid', 'listAccessibleWorkspaces']) {
  const sig = signature(access, fn);
  if (sig === null) { fail(`${ACCESS_FILE}: ${fn} not found — the guard is pointed at the wrong symbol.`); continue; }
  if (!/opts\s*:\s*WorkspaceAccessOpts/.test(sig)) {
    fail(`${ACCESS_FILE}: ${fn} must take \`opts: WorkspaceAccessOpts\`.`);
  }
  if (/opts\s*:\s*WorkspaceAccessOpts\s*=/.test(sig)) {
    fail(`${ACCESS_FILE}: ${fn} gave \`opts\` a DEFAULT. That restores #2703 exactly: omitting the argument silently switches the tenant boundary off.`);
  }
}

const resolverBody = functionBody(access, 'resolveWorkspaceAccessByOid');
if (!resolverBody) {
  fail(`${ACCESS_FILE}: could not read the body of resolveWorkspaceAccessByOid.`);
} else {
  const tidAt = resolverBody.indexOf('effectiveCallerTid(');
  const compareAt = resolverBody.search(/wsDoc\.tid\s*!==\s*callerTid/);
  const aclAt = resolverBody.indexOf('resolveEffectiveRole(');
  const adminAt = resolverBody.indexOf('opts.tenantAdmin');
  if (tidAt === -1 || compareAt === -1) {
    fail(`${ACCESS_FILE}: resolveWorkspaceAccessByOid no longer compares the workspace tid against effectiveCallerTid() — the boundary is gone.`);
  } else {
    if (aclAt !== -1 && compareAt > aclAt) {
      fail(`${ACCESS_FILE}: the tid boundary runs AFTER the ACL grant — a cross-tenant caller would already hold a role by then.`);
    }
    if (adminAt !== -1 && compareAt > adminAt) {
      fail(`${ACCESS_FILE}: the tid boundary runs AFTER the admin-open bypass.`);
    }
  }
}

const effBody = functionBody(access, 'effectiveCallerTid');
if (!effBody) {
  fail(`${ACCESS_FILE}: effectiveCallerTid is gone — nothing resolves the caller tenant.`);
} else if (!/opts\.callerTid\s*\?\?\s*\(?\s*await\s+ambientCallerTid\(/.test(effBody)) {
  fail(`${ACCESS_FILE}: effectiveCallerTid must fall back to ambientCallerTid() when the call site had no tid. Without it every session-less helper skips the boundary again (#2703).`);
}

const ambientBody = functionBody(access, 'ambientCallerTid');
if (!ambientBody) {
  fail(`${ACCESS_FILE}: ambientCallerTid is gone.`);
} else if (!/claims\.oid\s*!==\s*oid/.test(ambientBody)) {
  fail(`${ACCESS_FILE}: ambientCallerTid must only borrow the request session's tid when its oid MATCHES the principal being resolved — otherwise it attributes one user's tenant to another.`);
}

// ── 5..6: call sites ────────────────────────────────────────────────────────
const files = SCAN_DIRS.flatMap((d) => walk(d));
let callSites = 0;
const skipUsers = [];
const used = new Set();

for (const file of files) {
  const rel = file.slice(CONSOLE_ROOT.length + 1);
  const src = readFileSync(file, 'utf8');
  if (!GUARDED_CALLS.some(([n]) => src.includes(n)) && !src.includes('skipTidBoundary')) continue;
  const masked = mask(src);
  const imports = importRanges(masked);
  const inImport = (_s, idx) => imports.some(([a, b]) => idx >= a && idx < b);

  for (const [name, minArgs] of GUARDED_CALLS) {
    // EVERY mention of the identifier is classified. An earlier version matched
    // only `name(` and was demonstrated to pass
    // `await (resolveWorkspaceAccessByOid as any)(oid, ws)` — a real bypass that
    // drops the options argument while type-checking. Anything that is neither
    // an import nor a direct call is an INDIRECT reference the guard cannot
    // verify, and is reported rather than ignored.
    const re = new RegExp(`\\b${name}\\b`, 'g');
    let m;
    while ((m = re.exec(masked)) !== null) {
      if (inImport(masked, m.index)) continue;
      const after = masked.slice(m.index + name.length);
      const callAt = /^\s*\(/.test(after) ? masked.indexOf('(', m.index + name.length) : -1;
      const before = masked.slice(Math.max(0, m.index - 40), m.index);
      const isDeclaration = /\bfunction\s*$/.test(before);
      const line = masked.slice(0, m.index).split('\n').length;

      if (callAt === -1) {
        fail(`${rel}:${line}: ${name} is referenced INDIRECTLY (cast, alias or re-export). The guard cannot prove the tenant-boundary options argument is passed — call it directly.`);
        continue;
      }
      if (isDeclaration) continue;
      const n = argCount(masked, callAt);
      if (n === -1) continue;
      callSites += 1;
      if (n < minArgs) {
        fail(`${rel}:${line}: ${name}() called with ${n} argument(s) — the tenant-boundary options argument is missing.`);
      }
    }
  }

  if (/\bskipTidBoundary\b/.test(masked) && file !== ACCESS_FILE.replaceAll('\\', '/')) {
    skipUsers.push(rel);
    if (SKIP_ALLOWLIST.has(rel)) used.add(rel);
    else {
      const line = masked.split('\n').findIndex((l) => l.includes('skipTidBoundary')) + 1;
      fail(`${rel}:${line}: uses skipTidBoundary — the ONLY way to switch the cross-tenant boundary off. Add it to SKIP_ALLOWLIST in this guard WITH the reason, or pass \`callerTid\` instead.`);
    }
  }
}

// ── 7: listAllOwnedItems can enforce it ─────────────────────────────────────
const crud = mask(readFileSync(ITEM_CRUD_FILE, 'utf8'));
const listAllSig = signature(crud, 'listAllOwnedItems');
if (listAllSig === null) {
  fail(`${ITEM_CRUD_FILE}: listAllOwnedItems not found.`);
} else if (!/session\s*\?\s*:\s*SessionPayload/.test(listAllSig)) {
  fail(`${ITEM_CRUD_FILE}: listAllOwnedItems must accept a session (#2703) — it backs the Copilot item_list tool and without one it can never enforce the tenant boundary.`);
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`[tid-boundary-chokepoint] guarded call sites: ${callSites}  ` +
            `(skipTidBoundary users: ${skipUsers.length}, allowlisted: ${used.size})`);

const stale = [...SKIP_ALLOWLIST.keys()].filter((k) => !used.has(k));
if (stale.length > 0) {
  console.log(`[tid-boundary-chokepoint] NOTE — ${stale.length} allowlist entr(ies) match no file that uses skipTidBoundary. Harmless today; remove when confirmed obsolete:`);
  for (const k of stale) console.log(`    ${k}`);
}

if (failures.length > 0) {
  console.error('\n[tid-boundary-chokepoint] FAIL — the cross-tenant tid boundary can be skipped again (#2703).\n');
  for (const f of failures) console.error(`    ${f}`);
  console.error('\n  The boundary must be a decision every caller makes, not an option they can');
  console.error('  omit. Pass `{ callerTid: session?.claims.tid }` (undefined is fine — the');
  console.error('  resolver recovers it from the request session for the same principal), or');
  console.error('  declare `{ skipTidBoundary: true, skipTidBoundaryReason: "…" }` and pin it.\n');
  process.exit(1);
}

console.log('[tid-boundary-chokepoint] OK — the tenant boundary is required at every call site.');
