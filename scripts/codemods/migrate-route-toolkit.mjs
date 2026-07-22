#!/usr/bin/env node
/**
 * codemod: migrate-route-toolkit  (loom-next-level WS-R R2)
 * ---------------------------------------------------------------------------
 * Migrates hand-rolled BFF route auth prologues onto the WS-D1/R1 route
 * toolkit (`apps/fiab-console/lib/api/route-toolkit.ts`):
 *
 *   P1  const s = getSession(); if (!s) return 401;          → withSession
 *   P2  …P1 + const item = await loadOwnedItem(id,'t',oid);
 *       if (!item) return 404;                               → withWorkspaceOwner
 *   P3  const s = getSession(); const g = requireTenantAdmin(s);
 *       if (g) return g;   (explicit 401 guard optional —
 *       requireTenantAdmin(null) returns the identical 401)  → withTenantAdmin
 *   P4  …P1 + const d = await denyIfNoDlzAccess(s,'pane');
 *       if (d) return d;                                     → withDlzAccess
 *
 * PROVABLY BEHAVIOR-PRESERVING: a handler is only migrated when its leading
 * statements match one of the shapes above EXACTLY (an AST allowlist — the
 * 401/404 bodies must be `apiUnauthorized()` / `apiNotFound()` or the literal
 * `{ ok:false, error:'unauthenticated'|'not found' }` envelope the wrappers
 * emit). Anything unusual is SKIPPED and reported, never guessed. Business
 * logic, config gates (`gate()` / `apiHonestGateError`), `runtime` / `dynamic`
 * exports, and error mapping are left byte-for-byte.
 *
 * One deliberate, documented delta: `withSession` wraps the handler body in a
 * try/catch → `apiServerError(e)` (safe 500 + server-side log). Hand-rolled
 * routes without their own try/catch previously bubbled uncaught throws to
 * Next's generic 500. Authorization semantics are identical; the uncaught-
 * throw path becomes the SAFER structured envelope.
 *
 * NEVER migrated: routes already on the toolkit, streaming/SSE handlers
 * (`text/event-stream` / `ReadableStream` / `getReader(`), prologues that
 * don't match, or bodies whose route-ctx usage can't be proven safe.
 *
 * Implementation note (deviation from the R2 spec's ts-morph suggestion): the
 * repo's shared node_modules does not ship ts-morph or a TS runner, and
 * worktree installs are prohibited (pnpm-worktree corruption gotcha). The
 * transform is written directly on the TypeScript compiler API (`typescript`
 * is already a devDependency) — the same declaration-level AST surgery,
 * applied as minimal text edits so untouched code keeps its exact bytes.
 *
 * Run (from the repo root):
 *   node scripts/codemods/migrate-route-toolkit.mjs                 # dry-run, whole tree
 *   node scripts/codemods/migrate-route-toolkit.mjs --family=copilot
 *   node scripts/codemods/migrate-route-toolkit.mjs --apply --family=copilot
 *   node scripts/codemods/migrate-route-toolkit.mjs --file=app/api/copilot/status/route.ts
 *
 * Reporting mirrors scripts/codemod-client-fetch.mjs:
 *   <file>: MIGRATED <n> handlers   |   SKIPPED (<reason>)
 *   summary: APPLIED|DRY-RUN: <handlers> across <files>; <skipped> skipped
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');

// typescript lives in apps/fiab-console's dependency graph — resolve from there.
const requireFromApp = createRequire(path.join(APP_ROOT, 'package.json'));
const ts = requireFromApp('typescript');

const VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const TOOLKIT_MODULE = '@/lib/api/route-toolkit';
const SESSION_MODULE = '@/lib/auth/session';
const WRAPPER_RE = /\bwith(?:Session|WorkspaceOwner|BackendGate|TenantAdmin|DlzAccess)\b/;
const STREAM_RE = /text\/event-stream|ReadableStream|getReader\(/;

// ── AST helpers ─────────────────────────────────────────────────────────────

function isExported(node) {
  return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;
}

/** Local alias for a named import (handles `getSession as getAuthSession`). */
function findNamedImportAlias(sf, moduleName, exportedName) {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier) || stmt.moduleSpecifier.text !== moduleName) continue;
    const named = stmt.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      const source = el.propertyName ? el.propertyName.text : el.name.text;
      if (source === exportedName) return { local: el.name.text, importDecl: stmt, element: el };
    }
  }
  return null;
}

function isIdent(node, name) {
  return node && ts.isIdentifier(node) && node.text === name;
}

/** `expr` is a bare call `<name>()` (no args). */
function isBareCall(expr, name) {
  return expr && ts.isCallExpression(expr) && isIdent(expr.expression, name) && expr.arguments.length === 0;
}

/** Object literal is EXACTLY { ok: false, error: '<text>' } (any prop order). */
function isOkFalseErrorLiteral(obj, errorText) {
  if (!obj || !ts.isObjectLiteralExpression(obj) || obj.properties.length !== 2) return false;
  let okFalse = false;
  let err = false;
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) return false;
    if (p.name.text === 'ok' && p.initializer.kind === ts.SyntaxKind.FalseKeyword) okFalse = true;
    else if (
      p.name.text === 'error' &&
      ts.isStringLiteralLike(p.initializer) &&
      p.initializer.text === errorText
    ) err = true;
    else return false;
  }
  return okFalse && err;
}

/** Object literal is EXACTLY { status: <code> }. */
function isStatusLiteral(obj, code) {
  if (!obj || !ts.isObjectLiteralExpression(obj) || obj.properties.length !== 1) return false;
  const p = obj.properties[0];
  return (
    ts.isPropertyAssignment(p) &&
    ts.isIdentifier(p.name) &&
    p.name.text === 'status' &&
    ts.isNumericLiteral(p.initializer) &&
    Number(p.initializer.text) === code
  );
}

/** `NextResponse.json({ ok:false, error:'<text>' }, { status:<code> })`. */
function isNextResponseError(expr, errorText, code) {
  if (!expr || !ts.isCallExpression(expr)) return false;
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!isIdent(callee.expression, 'NextResponse') || callee.name.text !== 'json') return false;
  if (expr.arguments.length !== 2) return false;
  return isOkFalseErrorLiteral(expr.arguments[0], errorText) && isStatusLiteral(expr.arguments[1], code);
}

function is401Unauthorized(expr) {
  return isBareCall(expr, 'apiUnauthorized') || isNextResponseError(expr, 'unauthenticated', 401);
}

function is404NotFound(expr) {
  return isBareCall(expr, 'apiNotFound') || isNextResponseError(expr, 'not found', 404);
}

/** The single return inside `if (…) return X;` / `if (…) { return X; }`. */
function soleReturn(thenStatement) {
  if (ts.isReturnStatement(thenStatement)) return thenStatement;
  if (
    ts.isBlock(thenStatement) &&
    thenStatement.statements.length === 1 &&
    ts.isReturnStatement(thenStatement.statements[0])
  ) {
    return thenStatement.statements[0];
  }
  return null;
}

/** `if (!<v>) return <401>;` (no else). */
function isNullSessionGuard(stmt, sessionVar) {
  if (!ts.isIfStatement(stmt) || stmt.elseStatement) return false;
  const cond = stmt.expression;
  if (
    !ts.isPrefixUnaryExpression(cond) ||
    cond.operator !== ts.SyntaxKind.ExclamationToken ||
    !isIdent(cond.operand, sessionVar)
  ) return false;
  const ret = soleReturn(stmt.thenStatement);
  return !!ret && is401Unauthorized(ret.expression);
}

/** `if (<v>) return <v>;` (no else) — gate/denied short-circuit. */
function isGateReturnGuard(stmt, varName) {
  if (!ts.isIfStatement(stmt) || stmt.elseStatement) return false;
  if (!isIdent(stmt.expression, varName)) return false;
  const ret = soleReturn(stmt.thenStatement);
  return !!ret && isIdent(ret.expression, varName);
}

/** `if (!<v>) return <404>;` (no else) — missing-item short-circuit. */
function isNotFoundGuard(stmt, varName) {
  if (!ts.isIfStatement(stmt) || stmt.elseStatement) return false;
  const cond = stmt.expression;
  if (
    !ts.isPrefixUnaryExpression(cond) ||
    cond.operator !== ts.SyntaxKind.ExclamationToken ||
    !isIdent(cond.operand, varName)
  ) return false;
  const ret = soleReturn(stmt.thenStatement);
  return !!ret && is404NotFound(ret.expression);
}

/** Single-declarator `const <name> = <init>` variable statement. */
function constDeclarator(stmt) {
  if (!ts.isVariableStatement(stmt)) return null;
  const list = stmt.declarationList;
  if (!(list.flags & ts.NodeFlags.Const)) return null;
  if (list.declarations.length !== 1) return null;
  const d = list.declarations[0];
  if (!d.initializer) return null;
  return d;
}

/** `<ctx>.params` property access. */
function isCtxParamsAccess(expr, ctxName) {
  return (
    expr &&
    ts.isPropertyAccessExpression(expr) &&
    isIdent(expr.expression, ctxName) &&
    expr.name.text === 'params'
  );
}

/** Statement resolves route params from the ctx param (left in place + rewritten
 *  for shape (a); an await-passthrough no-op for shape (b)). */
function isParamsResolutionStmt(stmt, ctxName, paramsAlias) {
  const d = constDeclarator(stmt);
  if (!d) return false;
  let init = d.initializer;
  // const X = (await ctx.params).prop;
  if (ts.isPropertyAccessExpression(init)) init = init.expression;
  if (ts.isParenthesizedExpression(init)) init = init.expression;
  if (!ts.isAwaitExpression(init)) return false;
  if (ctxName && isCtxParamsAccess(init.expression, ctxName)) return true;
  if (paramsAlias && isIdent(init.expression, paramsAlias)) return true;
  return false;
}

/** Count word-boundary references to `name`, excluding spans in `excludeRanges`. */
function countRefs(sf, name, excludeRanges) {
  let count = 0;
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === name) {
      const pos = node.getStart(sf);
      if (!excludeRanges.some(([s, e]) => pos >= s && pos < e)) count++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

// ── per-handler analysis ────────────────────────────────────────────────────

/**
 * Analyze one exported route handler function declaration. Returns either
 * { migrate: {...} } or { skip: '<reason>' }.
 */
function analyzeHandler(sf, fn, sessionAlias) {
  const name = fn.name.text;
  const body = fn.body;
  const bodyText = body.getText(sf);
  if (STREAM_RE.test(bodyText)) return { skip: `${name}: streaming/SSE handler` };
  if (WRAPPER_RE.test(bodyText)) return { skip: `${name}: already references a toolkit wrapper` };

  const params = fn.parameters;
  if (params.length > 2) return { skip: `${name}: unexpected handler arity ${params.length}` };
  const reqParam = params[0] ?? null;
  const ctxParam = params[1] ?? null;
  if (reqParam && !ts.isIdentifier(reqParam.name)) {
    return { skip: `${name}: destructured request parameter` };
  }
  // The route-ctx param comes in two provable shapes:
  //   (a) named:        `ctx: { params: Promise<T> }`  → rewrite `await ctx.params`
  //   (b) destructured: `{ params }: { params: Promise<T> }` → the wrapper hands a
  //       RESOLVED `params`; body `await params` is an await-passthrough no-op,
  //       so the body needs NO rewrite at all.
  let ctxName = null; // shape (a)
  let paramsAlias = null; // shape (b) — the local binding name (usually `params`)
  if (ctxParam) {
    if (ts.isIdentifier(ctxParam.name)) {
      ctxName = ctxParam.name.text;
    } else if (ts.isObjectBindingPattern(ctxParam.name)) {
      const els = ctxParam.name.elements;
      const el = els.length === 1 ? els[0] : null;
      const propName = el && !el.dotDotDotToken && !el.initializer && ts.isIdentifier(el.name)
        ? (el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text)
        : null;
      if (propName !== 'params') {
        return { skip: `${name}: destructured route-ctx parameter (unprovable rewrite)` };
      }
      paramsAlias = el.name.text;
    } else {
      return { skip: `${name}: unrecognized route-ctx parameter` };
    }
  }

  // Extract the inner params type from `{ params: Promise<T> }` (Next 15) or
  // the legacy sync `{ params: T }` annotation.
  let paramsType = null;
  let paramsIsPromise = true;
  if (ctxParam && ctxParam.type && ts.isTypeLiteralNode(ctxParam.type)) {
    const members = ctxParam.type.members;
    if (members.length === 1 && ts.isPropertySignature(members[0]) && ts.isIdentifier(members[0].name) &&
        members[0].name.text === 'params' && members[0].type) {
      const mt = members[0].type;
      if (ts.isTypeReferenceNode(mt) && ts.isIdentifier(mt.typeName) && mt.typeName.text === 'Promise' &&
          mt.typeArguments?.length === 1) {
        paramsType = mt.typeArguments[0].getText(sf);
      } else {
        paramsType = mt.getText(sf);
        paramsIsPromise = false;
      }
    }
  }

  const stmts = body.statements;
  let i = 0;
  const skipParamsStmts = () => {
    while (i < stmts.length && isParamsResolutionStmt(stmts[i], ctxName, paramsAlias)) i++;
  };

  // ── locate `const <v> = getSession();` (params-resolution stmts may precede)
  skipParamsStmts();
  const sessDecl = i < stmts.length ? constDeclarator(stmts[i]) : null;
  if (!sessDecl || !ts.isIdentifier(sessDecl.name) || !isBareCall(sessDecl.initializer, sessionAlias)) {
    return { skip: `${name}: no hand-rolled getSession() prologue` };
  }
  const sessionVar = sessDecl.name.text;
  const remove = [stmts[i]];
  i++;

  // ── optional explicit 401 guard
  skipParamsStmts();
  let had401 = false;
  if (i < stmts.length && isNullSessionGuard(stmts[i], sessionVar)) {
    had401 = true;
    remove.push(stmts[i]);
    i++;
  }

  // ── optional admin / dlz / owner leg (at most one)
  let wrapper = 'withSession';
  let wrapperArgs = [];
  let itemVar = null;
  skipParamsStmts();
  if (i + 1 < stmts.length) {
    const d = constDeclarator(stmts[i]);
    const init = d?.initializer;
    if (d && ts.isIdentifier(d.name) && init) {
      // P3: const g = requireTenantAdmin(v); if (g) return g;
      if (
        ts.isCallExpression(init) && isIdent(init.expression, 'requireTenantAdmin') &&
        init.arguments.length === 1 && isIdent(init.arguments[0], sessionVar) &&
        isGateReturnGuard(stmts[i + 1], d.name.text)
      ) {
        wrapper = 'withTenantAdmin';
        remove.push(stmts[i], stmts[i + 1]);
        i += 2;
      } else if (
        // P4: const denied = await denyIfNoDlzAccess(v, 'pane'); if (denied) return denied;
        ts.isAwaitExpression(init) && ts.isCallExpression(init.expression) &&
        isIdent(init.expression.expression, 'denyIfNoDlzAccess') &&
        init.expression.arguments.length === 2 &&
        isIdent(init.expression.arguments[0], sessionVar) &&
        ts.isStringLiteralLike(init.expression.arguments[1]) &&
        isGateReturnGuard(stmts[i + 1], d.name.text)
      ) {
        wrapper = 'withDlzAccess';
        wrapperArgs = [`'${init.expression.arguments[1].text}'`];
        remove.push(stmts[i], stmts[i + 1]);
        i += 2;
      } else if (
        // P2: const item = await loadOwnedItem(id, 'type', v.claims.oid[, opts]);
        //     if (!item) return 404;
        ts.isAwaitExpression(init) && ts.isCallExpression(init.expression) &&
        isIdent(init.expression.expression, 'loadOwnedItem') &&
        (init.expression.arguments.length === 3 || init.expression.arguments.length === 4) &&
        isIdent(init.expression.arguments[0], 'id') &&
        ts.isStringLiteralLike(init.expression.arguments[1]) &&
        init.expression.arguments[2].getText(sf) === `${sessionVar}.claims.oid` &&
        isNotFoundGuard(stmts[i + 1], d.name.text)
      ) {
        if (!had401) return { skip: `${name}: loadOwnedItem without a 401 session guard` };
        wrapper = 'withWorkspaceOwner';
        wrapperArgs = [`'${init.expression.arguments[1].text}'`];
        if (init.expression.arguments[3]) {
          const optsText = init.expression.arguments[3].getText(sf);
          if (optsText.replace(/\s+/g, '') !== '{allowReadRoles:true}') {
            return { skip: `${name}: loadOwnedItem opts ${optsText} not provably safe` };
          }
          wrapperArgs.push('{ allowReadRoles: true }');
        }
        itemVar = d.name.text;
        remove.push(stmts[i], stmts[i + 1]);
        i += 2;
      }
    }
  }
  // P4/P2 without the explicit 401 would change unauthenticated behavior only
  // for P3 (requireTenantAdmin(null) returns the identical 401 envelope, so
  // P3-without-401 is byte-compatible). Anything else must have had the guard.
  if (!had401 && wrapper !== 'withTenantAdmin') {
    return { skip: `${name}: getSession() without the exact 401 guard` };
  }

  // ── audit every remaining ctx reference: must be `await ctx.params` shapes
  const removeRanges = remove.map((s) => [s.getStart(sf), s.getEnd()]);
  const ctxRewrites = []; // { start, end, text }
  let ctxUnsafe = false;
  if (ctxName) {
    const visit = (node) => {
      if (ctxUnsafe) return;
      if (ts.isIdentifier(node) && node.text === ctxName && node !== ctxParam.name) {
        const pos = node.getStart(sf);
        if (removeRanges.some(([s, e]) => pos >= s && pos < e)) return; // being deleted
        // must be the `ctx` of `ctx.params`
        const pa = node.parent;
        if (!pa || !ts.isPropertyAccessExpression(pa) || pa.expression !== node || pa.name.text !== 'params') {
          ctxUnsafe = true;
          return;
        }
        // and that access must sit under an await: `await ctx.params` — UNLESS
        // the ctx annotation is the legacy sync `{ params: T }`, where a bare
        // `ctx.params.x` read rewrites safely to `params.x`.
        let awaitNode = pa.parent;
        if (!awaitNode || !ts.isAwaitExpression(awaitNode)) {
          if (!paramsIsPromise && paramsType) {
            ctxRewrites.push({ start: pa.getStart(sf), end: pa.getEnd(), text: 'params' });
            return;
          }
          ctxUnsafe = true;
          return;
        }
        // `(await ctx.params)` → replace the parenthesized span too
        let span = awaitNode;
        if (awaitNode.parent && ts.isParenthesizedExpression(awaitNode.parent)) span = awaitNode.parent;
        // `const params = await ctx.params;` would self-collide → delete the stmt
        const declParent = span.parent;
        if (
          ts.isVariableDeclaration(declParent) && ts.isIdentifier(declParent.name) &&
          declParent.name.text === 'params' && declParent.initializer === span &&
          ts.isVariableDeclarationList(declParent.parent) && declParent.parent.declarations.length === 1 &&
          ts.isVariableStatement(declParent.parent.parent)
        ) {
          const stmt = declParent.parent.parent;
          ctxRewrites.push({ start: stmt.getStart(sf), end: stmt.getEnd(), text: '' });
        } else {
          ctxRewrites.push({ start: span.getStart(sf), end: span.getEnd(), text: 'params' });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
  }
  if (ctxUnsafe) return { skip: `${name}: route-ctx used beyond \`await ${ctxName}.params\` (unprovable)` };
  // Shape (b): the wrapper hands a RESOLVED `params` under the same binding
  // name; body `await params` still passes through unchanged. Detect whether
  // the alias is referenced at all (excluding the deleted prologue).
  let paramsAliasUsed = false;
  if (paramsAlias) {
    const bodyStart = body.getStart(sf);
    paramsAliasUsed =
      countRefs(sf, paramsAlias, [...removeRanges, [0, bodyStart]]) > 0;
  }
  const needsParams = ctxRewrites.length > 0 || paramsAliasUsed || wrapper === 'withWorkspaceOwner';
  if (!paramsType && (ctxRewrites.length > 0 || paramsAliasUsed)) {
    // Without the inner type, `params` would type as Record<string,string> —
    // fine for `{ id }` destructures but unprovable in general. Require the
    // canonical `{ params: Promise<T> }` annotation.
    return { skip: `${name}: cannot extract params type from the ctx annotation` };
  }
  // wrapper-introduced `params` binding must not collide with a body-local one
  if (needsParams && !paramsAlias && new RegExp(`\\b(?:const|let|var)\\s+params\\b`).test(bodyText)) {
    return { skip: `${name}: body declares its own \`params\` (collision)` };
  }

  return {
    migrate: {
      name,
      fn,
      wrapper,
      wrapperArgs,
      sessionVar,
      itemVar,
      paramsType,
      needsParams,
      paramsAlias,
      paramsAliasUsed,
      remove,
      removeRanges,
      ctxRewrites,
      reqParamText: reqParam ? reqParam.getText(sf) : null,
    },
  };
}

// ── file transform ──────────────────────────────────────────────────────────

/** end-of-statement span including one trailing newline (keeps blank lines sane) */
function stmtDeletionSpan(sf, stmt) {
  const start = stmt.getStart(sf);
  let end = stmt.getEnd();
  const text = sf.text;
  // swallow trailing spaces + ONE newline
  while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
  if (text[end] === '\r') end++;
  if (text[end] === '\n') end++;
  // also swallow leading indentation of the deleted line
  let s = start;
  while (s > 0 && (text[s - 1] === ' ' || text[s - 1] === '\t')) s--;
  return { start: s, end };
}

/**
 * Transform one route.ts source. Returns { out, migrated: [names], skipped:
 * [{name/reason}] } — `out === src` when nothing changed.
 */
export function transformSource(src, fileName = 'route.ts') {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const sessImport = findNamedImportAlias(sf, SESSION_MODULE, 'getSession');
  if (!sessImport) return { out: src, migrated: [], skipped: [{ reason: 'no getSession import' }] };

  const migrations = [];
  const skipped = [];
  for (const stmt of sf.statements) {
    if (!ts.isFunctionDeclaration(stmt) || !stmt.name || !stmt.body) continue;
    if (!VERBS.has(stmt.name.text) || !isExported(stmt)) continue;
    const res = analyzeHandler(sf, stmt, sessImport.local);
    if (res.skip) skipped.push({ reason: res.skip });
    else migrations.push(res.migrate);
  }
  if (migrations.length === 0) return { out: src, migrated: [], skipped };

  const edits = [];
  const wrappersUsed = new Set();
  for (const m of migrations) {
    wrappersUsed.add(m.wrapper);
    // 1. delete prologue statements
    for (const s of m.remove) {
      const { start, end } = stmtDeletionSpan(sf, s);
      edits.push({ start, end, text: '' });
    }
    // 2. ctx.params rewrites
    for (const r of m.ctxRewrites) {
      if (r.text === '') {
        // whole-statement deletion span
        const stmt = (() => {
          let n = null;
          const find = (node) => {
            if (node.getStart(sf) === r.start && node.getEnd() === r.end) n = node;
            else ts.forEachChild(node, find);
          };
          find(sf);
          return n;
        })();
        if (stmt) {
          const { start, end } = stmtDeletionSpan(sf, stmt);
          edits.push({ start, end, text: '' });
        } else {
          edits.push(r);
        }
      } else {
        edits.push(r);
      }
    }
    // 3. header: `export async function VERB(a, b) {` →
    //    `export const VERB = wrapper[<T>]([args, ]async (a, ctxDestructure) => {`
    const fn = m.fn;
    const headerStart = fn.getStart(sf); // starts at `export`
    const bodyStart = fn.body.getStart(sf); // the `{`
    const sessionRefs = countRefs(sf, m.sessionVar, [
      ...m.removeRanges,
      [0, fn.body.getStart(sf)], // ignore the (deleted) decl + signature
    ]);
    const needsSession = sessionRefs > 0;
    const destructure = [];
    if (needsSession) destructure.push(m.sessionVar === 'session' ? 'session' : `session: ${m.sessionVar}`);
    if (m.itemVar) destructure.push(m.itemVar === 'item' ? 'item' : `item: ${m.itemVar}`);
    if (m.ctxRewrites.length > 0) destructure.push('params');
    else if (m.paramsAliasUsed) {
      destructure.push(m.paramsAlias === 'params' ? 'params' : `params: ${m.paramsAlias}`);
    }
    const handlerParams = [];
    if (m.reqParamText) handlerParams.push(m.reqParamText);
    else if (destructure.length) handlerParams.push('_req');
    if (destructure.length) handlerParams.push(`{ ${destructure.join(', ')} }`);
    const generic = m.paramsType ? `<${m.paramsType}>` : '';
    const args = m.wrapperArgs.length ? `${m.wrapperArgs.join(', ')}, ` : '';
    const header = `export const ${m.name} = ${m.wrapper}${generic}(${args}async (${handlerParams.join(', ')}) => `;
    edits.push({ start: headerStart, end: bodyStart, text: header });
    // 4. footer: closing `}` → `});`
    edits.push({ start: fn.body.getEnd() - 1, end: fn.body.getEnd(), text: '});' });
  }

  // 5. toolkit import (merge with an existing one if present)
  const existingToolkit = (() => {
    for (const stmt of sf.statements) {
      if (
        ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) &&
        stmt.moduleSpecifier.text === TOOLKIT_MODULE && stmt.importClause?.namedBindings &&
        ts.isNamedImports(stmt.importClause.namedBindings)
      ) return stmt;
    }
    return null;
  })();
  if (existingToolkit) {
    const have = new Set(existingToolkit.importClause.namedBindings.elements.map((e) => e.name.text));
    const add = [...wrappersUsed].filter((w) => !have.has(w));
    if (add.length) {
      const lastEl = existingToolkit.importClause.namedBindings.elements.at(-1);
      edits.push({ start: lastEl.getEnd(), end: lastEl.getEnd(), text: `, ${add.sort().join(', ')}` });
    }
  } else {
    let lastImportEnd = 0;
    for (const stmt of sf.statements) if (ts.isImportDeclaration(stmt)) lastImportEnd = stmt.getEnd();
    const line = `\nimport { ${[...wrappersUsed].sort().join(', ')} } from '${TOOLKIT_MODULE}';`;
    edits.push({ start: lastImportEnd, end: lastImportEnd, text: line });
  }

  // apply edits (descending, non-overlapping)
  edits.sort((a, b) => b.start - a.start);
  for (let k = 1; k < edits.length; k++) {
    if (edits[k].end > edits[k - 1].start) {
      return { out: src, migrated: [], skipped: [{ reason: 'internal: overlapping edits — aborted' }] };
    }
  }
  let out = src;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

  // 6. drop guard imports whose references were consumed by the wrappers
  //    (reference-counted — kept whenever still used elsewhere in the file)
  out = pruneUnusedImport(out, fileName, SESSION_MODULE, 'getSession');
  out = pruneUnusedImport(out, fileName, 'next/server', 'NextResponse');
  out = pruneUnusedImport(out, fileName, '@/lib/auth/feature-gate', 'requireTenantAdmin');
  out = pruneUnusedImport(out, fileName, '@/lib/auth/dlz-gate', 'denyIfNoDlzAccess');
  out = pruneUnusedImport(out, fileName, '@/app/api/items/_lib/item-crud', 'loadOwnedItem');
  out = pruneUnusedImport(out, fileName, '@/lib/api/respond', 'apiUnauthorized');

  return { out, migrated: migrations.map((m) => m.name), skipped };
}

/** Remove `exportedName` from `moduleName`'s named imports when its local alias
 *  is no longer referenced anywhere outside the import line itself. */
function pruneUnusedImport(src, fileName, moduleName, exportedName) {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const found = findNamedImportAlias(sf, moduleName, exportedName);
  if (!found) return src;
  const { local, importDecl, element } = found;
  const refs = countRefs(sf, local, [[importDecl.getStart(sf), importDecl.getEnd()]]);
  if (refs > 0) return src;
  const named = importDecl.importClause.namedBindings;
  if (named.elements.length === 1 && !importDecl.importClause.name) {
    // sole specifier → remove the whole import line
    const { start, end } = stmtDeletionSpan(sf, importDecl);
    return src.slice(0, start) + src.slice(end);
  }
  // remove just the specifier (+ a neighboring comma)
  const els = named.elements;
  const idx = els.indexOf(element);
  let start = element.getStart(sf);
  let end = element.getEnd();
  const text = sf.text;
  if (idx > 0) {
    start = els[idx - 1].getEnd(); // eat the preceding `, `
  } else if (els.length > 1) {
    while (text[end] === ',' || text[end] === ' ' || text[end] === '\n' || text[end] === '\r' || text[end] === '\t') end++;
  }
  return src.slice(0, start) + src.slice(end);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function listRouteFiles(families, singleFile) {
  if (singleFile) {
    const abs = path.isAbsolute(singleFile) ? singleFile : path.join(APP_ROOT, singleFile);
    return [abs];
  }
  // NB: double quotes — single quotes are not quoting chars in cmd.exe.
  const out = execSync('git ls-files "app/api/**/route.ts"', { cwd: APP_ROOT, encoding: 'utf8' });
  let files = out.split('\n').map((s) => s.trim()).filter(Boolean);
  if (families.length) {
    files = files.filter((f) => families.some((fam) => f.startsWith(`app/api/${fam}/`)));
  }
  return files.map((f) => path.join(APP_ROOT, f));
}

function main() {
  const argv = process.argv.slice(2);
  const APPLY = argv.includes('--apply');
  const families = argv.filter((a) => a.startsWith('--family=')).map((a) => a.slice('--family='.length));
  const singleFile = argv.find((a) => a.startsWith('--file='))?.slice('--file='.length) ?? null;

  const files = listRouteFiles(families, singleFile);
  let handlerCount = 0;
  let fileCount = 0;
  let skippedCount = 0;
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const relPath = path.relative(APP_ROOT, f).split(path.sep).join('/');
    const { out, migrated, skipped } = transformSource(src, relPath);
    for (const s of skipped) {
      if (s.reason === 'no getSession import') continue; // not in the migration universe
      console.log(`  ${relPath}: SKIPPED (${s.reason})`);
      skippedCount++;
    }
    if (migrated.length) {
      console.log(`  ${relPath}: MIGRATED ${migrated.length} handlers (${migrated.join(', ')})`);
      handlerCount += migrated.length;
      fileCount++;
      if (APPLY && out !== src) fs.writeFileSync(f, out, 'utf8');
    }
  }
  console.log(
    `\n${APPLY ? 'APPLIED' : 'DRY-RUN'}: ${handlerCount} handlers across ${fileCount} files; ${skippedCount} skipped`,
  );
  if (!APPLY && handlerCount > 0) {
    console.log('(dry-run — re-run with --apply to write, e.g. --apply --family=copilot)');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
