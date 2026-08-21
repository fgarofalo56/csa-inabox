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
 *     8. (#3825) THE GUARDS IN `lib/auth/workspace-guard.ts` DELEGATE THE
 *        TENANT-ADMIN DECISION TO THE RESOLVER RATHER THAN TAKING IT. They may
 *        COMPUTE `isTenantAdmin` and PASS IT DOWN; they may not ACT on it.
 *
 * WHY 8 EXISTS — THIS GUARD WAS MEASURED BLIND TO #3825, AND THAT IS RECORDED
 * RATHER THAN QUIETLY FIXED. Checks 1-7 verify that every call site SUPPLIES the
 * discriminant and that the comparison sits ahead of the ACL and admin steps.
 * None of them verifies that the BOUNDARY DECIDES. Proof, run against the tree
 * on 2026-08-20: with #3824's step-6 fix fully reverted to an unconditional
 * `if (opts.tenantAdmin) return { role:'Admin', canWrite:true }` — blob hash
 * moved 0398c3c -> 7ee89c1, and the #3823 spec went RED (5 of 17) — this guard
 * still printed "OK" and exited 0. A caller can therefore hand the resolver a
 * perfect `callerTid` and still be granted across tenants, and checks 1-7 see
 * nothing wrong, because from their point of view nothing IS wrong.
 *
 * #3825 was the same blindness one level up: `authorizeWorkspace` opened with
 * `if (isTenantAdmin(session)) return null;` — returning BEFORE any Cosmos read,
 * so it never called the resolver at all and there was no call site for this
 * guard to inspect. `resolveAdminWorkspace` did the same and then read the
 * workspace with an unfiltered cross-partition `SELECT *` (`loadWorkspaceAdmin`).
 * Section 8 keys on the SHAPE THAT WAS ACTUALLY WRONG — an admin flag ACTED ON
 * instead of PASSED DOWN — not on the presence of an argument.
 *
 * WHY A GUARD AND NOT JUST TYPES:
 *   `tsc` enforces (1) and (5) today, and that is the primary mechanism — but a
 *   single `as any` at a call site, or someone re-adding `= {}` "to unbreak the
 *   build", silently restores the exact hole #2703 filed: a security control
 *   that does nothing when an optional input is absent, while still READING as
 *   enforced. Items (3), (4), (6) and (8) are not expressible in the type system
 *   at all. This turns each of those into a red build.
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
 *   M12 (#3825) `authorizeWorkspace` re-adds the admin short-circuit exit 1
 *   M13 (#3825) `authorizeWorkspace` drops `tenantAdmin:` from opts  exit 1
 *   M14 (#3825) `resolveAdminWorkspace` restores `loadWorkspaceAdmin` exit 1
 *   M15 (#3825) `resolveAdminWorkspace` loses its isTenantAdmin gate exit 1
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
const GUARD_FILE = `${CONSOLE_ROOT}/lib/auth/workspace-guard.ts`;
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
 *
 * THE PARAMETER LIST IS SKIPPED EXPLICITLY, and that is load-bearing. This used
 * to take `indexOf('{', decl.index)` as the body brace, which is the FIRST brace
 * after the name — so a parameter carrying an inline object type
 * (`opts: { allowReadRoles?: boolean } = {}`, the exact signature of
 * `authorizeWorkspace`) made the "body" the type literal, one line long, and
 * every assertion over it either vacuous or wrong. Caught by section 8 reporting
 * "authorizeWorkspace does not call resolveWorkspaceAccessByOid" against a tree
 * where it plainly does. The three `workspace-access.ts` functions checked by
 * sections 1-4 have no braces in their signatures, so their results are
 * unchanged — but they were one inline type away from being silently vacuous.
 */
function functionBody(masked, name) {
  const decl = new RegExp(`function\\s+${name}\\s*[(<]`).exec(masked);
  if (!decl) return null;
  const paren = masked.indexOf('(', decl.index);
  if (paren === -1) return null;
  // 1) Balance the parameter list.
  let d = 0;
  let afterParams = -1;
  for (let i = paren; i < masked.length; i++) {
    if (masked[i] === '(') d += 1;
    else if (masked[i] === ')') {
      d -= 1;
      if (d === 0) { afterParams = i + 1; break; }
    }
  }
  if (afterParams === -1) return null;
  // 2) The body brace is the first `{` past the return-type annotation — i.e.
  //    the first one at angle-bracket depth ZERO, so `Promise<{ a: string }>`
  //    is not mistaken for it either.
  let ang = 0;
  let open = -1;
  for (let i = afterParams; i < masked.length; i++) {
    const c = masked[i];
    if (c === '<') ang += 1;
    else if (c === '>') { if (ang > 0) ang -= 1; }
    else if (c === '{' && ang === 0) { open = i; break; }
  }
  if (open === -1) return null;
  // 3) Balance the body.
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
 * `[start, end)` of the balanced argument list of the FIRST `name(` call in
 * `masked`, or null when there is none. Used by section 8 to ask whether an
 * `isTenantAdmin(...)` mention sits INSIDE the resolver call (passed down, fine)
 * or OUTSIDE it (acted on — the #3825 short-circuit).
 */
function callArgSpan(masked, name) {
  const m = new RegExp(`\\b${name}\\s*\\(`).exec(masked);
  if (!m) return null;
  const open = masked.indexOf('(', m.index);
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '(') depth += 1;
    else if (masked[i] === ')') {
      depth -= 1;
      if (depth === 0) return [open, i + 1];
    }
  }
  return null;
}

/** Every index at which `re` matches, on already-masked source. */
function indicesOf(masked, re) {
  const out = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m;
  while ((m = g.exec(masked)) !== null) out.push(m.index);
  return out;
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

// ── 8: the workspace GUARDS delegate the tenant-admin decision (#3825) ──────
//
// Sections 1-7 verify that call sites SUPPLY the discriminant. They are blind to
// a guard that never becomes a call site at all — which is exactly what
// `authorizeWorkspace` was: `if (isTenantAdmin(session)) return null;` ahead of
// every read. The rule here is one sentence: A GUARD MAY COMPUTE THE ADMIN FLAG
// AND PASS IT DOWN; IT MAY NOT ACT ON IT.
const ISADMIN = /\bisTenantAdmin\s*\(/;
const guardSrc = readFileSync(GUARD_FILE, 'utf8');
const guard = mask(guardSrc);

// 8a. `authorizeWorkspace` — every isTenantAdmin mention must be INSIDE the
//     resolver call's arguments. One outside it is an admin verdict taken here.
const awBody = functionBody(guard, 'authorizeWorkspace');
if (!awBody) {
  fail(`${GUARD_FILE}: authorizeWorkspace not found — the guard is pointed at the wrong symbol.`);
} else {
  const span = callArgSpan(awBody, 'resolveWorkspaceAccessByOid');
  if (!span) {
    fail(
      `${GUARD_FILE}: authorizeWorkspace does not call resolveWorkspaceAccessByOid. ` +
        'It is then deciding workspace access on its own, which is #3825.',
    );
  } else {
    const args = awBody.slice(span[0], span[1]);
    if (!/tenantAdmin\s*:/.test(args)) {
      fail(
        `${GUARD_FILE}: authorizeWorkspace does not pass \`tenantAdmin\` to the resolver. ` +
          'The repaired boundary (step 6) then never runs for an admin, so the admin-open ' +
          'path is either dead or decided somewhere else.',
      );
    }
    for (const at of indicesOf(awBody, ISADMIN)) {
      if (at < span[0] || at >= span[1]) {
        fail(
          `${GUARD_FILE}: authorizeWorkspace ACTS on isTenantAdmin outside the resolver call. ` +
            'That is the #3825 short-circuit: a tenant admin is answered with no workspace ' +
            'document read and therefore no tenant compared. Compute the flag and pass it ' +
            'to resolveWorkspaceAccessByOid; let the resolver decide.',
        );
      }
    }
  }
}

// 8b. `resolveAdminWorkspace` — the isTenantAdmin GATE stays (without it a
//     shared-ACL member reaches the admin plane), but it must sit IN FRONT of
//     the resolver, never conclude the decision after it.
const rawBody = functionBody(guard, 'resolveAdminWorkspace');
if (!rawBody) {
  fail(`${GUARD_FILE}: resolveAdminWorkspace not found — the guard is pointed at the wrong symbol.`);
} else {
  const span = callArgSpan(rawBody, 'resolveWorkspaceAccessByOid');
  const gates = indicesOf(rawBody, ISADMIN);
  if (!span) {
    fail(
      `${GUARD_FILE}: resolveAdminWorkspace does not call resolveWorkspaceAccessByOid — it is ` +
        'resolving a workspace document for a tenant admin without the tenant boundary (#3825).',
    );
  } else {
    if (!/tenantAdmin\s*:/.test(rawBody.slice(span[0], span[1]))) {
      fail(`${GUARD_FILE}: resolveAdminWorkspace does not pass \`tenantAdmin\` to the resolver.`);
    }
    for (const at of gates) {
      if (at > span[0]) {
        fail(
          `${GUARD_FILE}: resolveAdminWorkspace consults isTenantAdmin AFTER the resolver. ` +
            'The flag may gate who reaches the admin plane; it must not be what answers ' +
            'whether this workspace is theirs.',
        );
      }
    }
  }
  if (gates.length === 0) {
    fail(
      `${GUARD_FILE}: resolveAdminWorkspace lost its isTenantAdmin gate. Every non-null ` +
        'resolver verdict is accepted inside that gate, so removing it newly admits a ' +
        'shared-ACL member to /git, /cmk, /identity, /networking and /storage-metrics.',
    );
  }
}

// 8c. The unfiltered cross-partition loader must not be reachable from an
//     authorization decision in this module. `loadWorkspaceAdmin` is a bare
//     `SELECT * FROM c WHERE c.id = @id`; returning its result past the boundary
//     is what made `resolveAdminWorkspace` cross-tenant. The resolver performs
//     the identical read and then SUBJECTS it to the tid comparison.
if (/\bloadWorkspaceAdmin\b/.test(guard)) {
  fail(
    `${GUARD_FILE}: references loadWorkspaceAdmin — an unfiltered cross-partition workspace ` +
      'read inside the module that authorizes workspace access (#3825). Resolve through ' +
      'resolveWorkspaceAccessByOid so the document is filtered by the tenant boundary.',
  );
}

// 8d. Repo-wide shape scan: no WORKSPACE-scoped function may grant purely on the
//     admin flag. The scope test is PER FUNCTION, on its signature — not per
//     file. `requireTenantAdmin` (feature-gate.ts) is the legitimate use of this
//     shape: an org-wide surface with no workspace in play, so nothing to
//     compare a tenant against. `assertItemAccess`
//     (items/[type]/[id]/security-roles/route.ts) takes `(session, itemId,
//     itemType)` and is likewise out of THIS guard's subject — it is an
//     item-scoped sibling of the same class, reported separately rather than
//     smuggled into a tenant-boundary guard behind an excuse.
//
//     KNOWN LIMIT, stated rather than implied: this walks `function NAME(…)`
//     declarations only. The same shape inside an arrow-function const is not
//     seen. 8a-8c cover the module that actually matters; this is the net for
//     the next one.
const ADMIN_GRANTS_ALONE = /if\s*\(\s*isTenantAdmin\s*\([^)]*\)\s*\)\s*return\s+null\s*;/;
const WORKSPACE_PARAM = /\bworkspace(Id|_id)?\b/i;
let adminShapeScanned = 0;
for (const file of files) {
  const rel = file.slice(CONSOLE_ROOT.length + 1);
  const src = readFileSync(file, 'utf8');
  if (!ISADMIN.test(src)) continue;
  const masked = mask(src);
  if (!ADMIN_GRANTS_ALONE.test(masked)) continue;
  for (const m of masked.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*[(<]/g)) {
    const fnName = m[1];
    const sig = signature(masked, fnName);
    const body = functionBody(masked, fnName);
    if (sig === null || body === null) continue;
    adminShapeScanned += 1;
    if (!WORKSPACE_PARAM.test(sig)) continue; // not a workspace-scoped decision
    if (!ADMIN_GRANTS_ALONE.test(body)) continue;
    const line = masked.slice(0, m.index).split('\n').length;
    fail(
      `${rel}:${line}: ${fnName}() grants access on isTenantAdmin ALONE in a ` +
        'workspace-scoped function (#3825). A tenant admin must still be shown to be in ' +
        "the workspace's tenant — route the decision through resolveWorkspaceAccessByOid.",
    );
  }
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`[tid-boundary-chokepoint] guarded call sites: ${callSites}  ` +
            `(skipTidBoundary users: ${skipUsers.length}, allowlisted: ${used.size})`);
console.log(`[tid-boundary-chokepoint] admin-shape scan: ${adminShapeScanned} named function(s) ` +
            `carrying the isTenantAdmin-grants-alone shape classified by signature (#3825)`);

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
