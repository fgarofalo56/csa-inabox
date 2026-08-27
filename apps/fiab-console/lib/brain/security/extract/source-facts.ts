/**
 * LOOM BRAIN — SECURITY EXTRACTION: the source-reading primitives.
 *
 * PURE. Every function takes text a caller already read and returns facts. No
 * `fs`, no `process`, no network — so the whole extractor is unit-testable
 * against string fixtures and produces byte-identical output on every OS.
 *
 * ── WHY COMMENTS AND STRINGS ARE BLANKED FIRST, AND WHY IT IS NOT OPTIONAL ─
 *
 * This is the single most load-bearing decision in the package, and skipping it
 * would not produce a slightly-noisy extractor — it would produce a WRONG one,
 * in the dangerous direction.
 *
 * This codebase documents its security idioms IN PROSE, at length, inside the
 * files that implement them. `lib/api/route-toolkit.ts:10` contains, verbatim,
 * inside a docblock:
 *
 *     `… ; const gate = requireTenantAdmin(s); if (gate) return gate` → withTenantAdmin
 *
 * and `lib/brain/security/detectors/c1-*.ts` contains `if (isTenantAdmin(session))
 * return null;` twice in prose as the shape it is hunting. A lexical scan that
 * does not blank comments would report the DETECTOR as carrying the defect, and
 * would find `if (gate) return gate` consumption in files that consume nothing.
 * Both errors point at "everything is fine" for the wrong reason: a false
 * consumption edge makes C3 report clean.
 *
 * {@link blankNonCode} therefore replaces the CONTENT of every comment, string
 * and template literal with spaces while PRESERVING LENGTH AND NEWLINES, so
 * every offset and line number computed on the blanked text is still valid
 * against the original. It is a lexer, not a regex, because a regex cannot
 * decide whether a `//` is a comment or the middle of a URL in a string.
 *
 * ── WHAT THIS DELIBERATELY IS NOT ─────────────────────────────────────────
 *
 * It is not a TypeScript parser and does not pretend to be. `typescript` is a
 * dependency of this app and a full AST was the obvious alternative; it was not
 * taken, for a reason that is about the BUILD rather than about fidelity: the
 * artifact is produced by a build step that must run before the app is built,
 * on a plain Node runtime, and pinning the extractor to the compiler API makes
 * the graph's contents a function of the TypeScript version.
 *
 * The consequence is honest and bounded: this reads STRUCTURE (which symbols are
 * called, in which handler, with which arguments) and not TYPES. Every place
 * that costs fidelity is recorded as a {@link SkippedSubject} by the callers in
 * this package rather than silently dropped, and the limits are restated on each
 * analyzer. Where a fact cannot be established, the extractor does not emit the
 * node — it never guesses a value that would make a detector go quiet.
 */

/**
 * Blank the content of comments, strings and template literals, preserving
 * length and line structure.
 *
 * Returns a string of exactly the same length as the input, in which every
 * offset that was code is unchanged and every offset that was not is a space
 * (newlines inside blanked regions are kept, so line numbers survive).
 *
 * Template literals are blanked WHOLE, including their `${...}` expressions.
 * That is a deliberate loss: a call written inside a template expression is
 * invisible here. It is recorded as a limit rather than fixed because the only
 * analyzers in this package that would care (an emitted-command extractor for
 * C8) are not implemented, and a half-lexed template is worse than a declared
 * blind spot.
 */
export function blankNonCode(text: string): string {
  return blankRegions(text, true);
}

/**
 * Blank COMMENTS ONLY, preserving string and template contents.
 *
 * Needed wherever the fact being extracted IS a string literal, which
 * {@link blankNonCode} necessarily destroys. Two measured cases, both of which
 * silently produced ZERO findings before this existed:
 *
 *   - `stdio: ['inherit', 'inherit', 'pipe']` — the inherited-fd publication
 *     sink. Under full blanking it reads `stdio: ['       ', …]` and the
 *     `/inherit/` test fails, so the ONE publication class that has no `write()`
 *     in the parent's source went entirely undetected. That is #3876's most
 *     dangerous sink being missed by the tool built to find it.
 *   - `process['stdout'].write(x)` — bracket access, which is bypass 3 of the
 *     same issue. Under full blanking the member name is gone and the access
 *     path is invisible, which is precisely the "drive the write count to zero
 *     by renaming" evasion.
 *
 * Comments are still blanked, so this repo's very long docblocks — which quote
 * both of those shapes verbatim as the things they are hunting — cannot produce
 * a false positive.
 */
export function blankComments(text: string): string {
  return blankRegions(text, false);
}

function blankRegions(text: string, blankStrings: boolean): string {
  const out = text.split('');
  const n = text.length;
  let i = 0;

  /** Blank [from, to) but keep newlines so line numbers do not shift. */
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k += 1) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];

    // Line comment
    if (c === '/' && next === '/') {
      let j = i + 2;
      while (j < n && text[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }

    // Block comment
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j += 1;
      j = Math.min(j + 2, n);
      blank(i, j);
      i = j;
      continue;
    }

    // String / template literal. The quote characters themselves are kept so a
    // caller can still see that an argument WAS a literal; only the content goes.
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === quote) break;
        // An unterminated single/double-quoted string cannot span a newline;
        // bail so a stray apostrophe in code cannot swallow the rest of the file.
        if (quote !== '`' && text[j] === '\n') break;
        j += 1;
      }
      if (blankStrings) blank(i + 1, j);
      i = Math.min(j + 1, n);
      continue;
    }

    i += 1;
  }

  return out.join('');
}

/** Forward slashes, no leading `./`, no trailing slash, lowercased. */
export function canonicalRepoPath(p: string): string {
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** 1-based line number of a character offset. */
export function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

/**
 * A deterministic security-node id, rooted in SOURCE coordinates.
 *
 * `sec:<kind>:<path>#<symbol>`. Determinism matters for the same reason it does
 * on the waste side: a finding recorded against a node id must still resolve on
 * the next extraction, or evidence chains break between builds.
 */
export function securityNodeId(kind: string, path: string, symbol: string): string {
  return `sec:${kind}:${canonicalRepoPath(path)}#${symbol}`;
}

/**
 * The closing index (exclusive) of a balanced region starting at `open`.
 *
 * `text` must already be blanked, so brackets inside strings cannot unbalance
 * the scan. Returns `text.length` when the region never closes — a truncated or
 * unparseable file yields a conservative over-long slice rather than a throw,
 * because one malformed file must not abort a whole-repo extraction.
 */
export function balancedEnd(text: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const closer = pairs[text[open]];
  if (!closer) return open;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** One `name(...)` call site, with its argument text. */
export interface CallSite {
  readonly name: string;
  /** Offset of the first character of `name`. */
  readonly index: number;
  readonly line: number;
  /** The text between the outermost parentheses, blanked. */
  readonly argsText: string;
}

/**
 * Every call to `name` in `blanked`, with arguments.
 *
 * Matching is on a word boundary so `requireTenantAdmin` does not match
 * `myRequireTenantAdmin`. A generic instantiation (`withTenantAdmin<{id}>(…)`)
 * is handled by skipping a balanced `<…>` when one directly precedes the `(`.
 */
export function findCalls(blanked: string, name: string): CallSite[] {
  const out: CallSite[] = [];
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(blanked)) !== null) {
    let j = m.index + name.length;
    while (j < blanked.length && /\s/.test(blanked[j])) j += 1;

    // Skip a generic argument list: `withTenantAdmin<{ id: string }>(`.
    if (blanked[j] === '<') {
      let depth = 0;
      let k = j;
      for (; k < blanked.length; k += 1) {
        if (blanked[k] === '<') depth += 1;
        else if (blanked[k] === '>') {
          depth -= 1;
          if (depth === 0) {
            k += 1;
            break;
          }
        } else if (blanked[k] === ';' || blanked[k] === '\n') break;
      }
      let p = k;
      while (p < blanked.length && /\s/.test(blanked[p])) p += 1;
      if (blanked[p] === '(') j = p;
    }

    if (blanked[j] !== '(') continue;
    const end = balancedEnd(blanked, j);
    out.push({
      name,
      index: m.index,
      line: lineAt(blanked, m.index),
      argsText: blanked.slice(j + 1, Math.max(j + 1, end - 1)),
    });
  }
  return out;
}

/** An exported Next.js route handler and its body text. */
export interface ExportedHandler {
  /** `GET` | `POST` | … */
  readonly method: string;
  readonly line: number;
  /** The blanked source of the whole export statement, including wrappers. */
  readonly body: string;
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/**
 * The exported HTTP handlers of a Next.js route module.
 *
 * Covers both shapes this repo uses: `export const GET = <expr>;` and
 * `export async function GET(...) { ... }`. The returned `body` spans the WHOLE
 * export — wrappers included — because the authorization facts an analyzer needs
 * (`withTenantAdmin(...)`) live in the wrapper position, outside the handler
 * function itself. Treating the handler arrow alone as the body was the first
 * implementation and it found ZERO wrappers, which is the failure mode this
 * comment exists to stop someone re-introducing.
 */
export function findExportedHandlers(blanked: string): ExportedHandler[] {
  const out: ExportedHandler[] = [];

  for (const method of HTTP_METHODS) {
    // `export const GET = ...;`
    const constRe = new RegExp(`\\bexport\\s+const\\s+${method}\\s*(?::[^=]+)?=`, 'g');
    let m: RegExpExecArray | null;
    while ((m = constRe.exec(blanked)) !== null) {
      const start = m.index + m[0].length;
      let depth = 0;
      let i = start;
      for (; i < blanked.length; i += 1) {
        const c = blanked[i];
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') depth -= 1;
        else if (c === ';' && depth <= 0) break;
      }
      out.push({ method, line: lineAt(blanked, m.index), body: blanked.slice(start, i) });
    }

    // `export async function GET(...) { ... }`
    const fnRe = new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${method}\\s*\\(`, 'g');
    while ((m = fnRe.exec(blanked)) !== null) {
      const parenOpen = blanked.indexOf('(', m.index);
      const parenEnd = balancedEnd(blanked, parenOpen);
      const braceOpen = blanked.indexOf('{', parenEnd);
      if (braceOpen < 0) continue;
      const braceEnd = balancedEnd(blanked, braceOpen);
      out.push({
        method,
        line: lineAt(blanked, m.index),
        body: blanked.slice(m.index, braceEnd),
      });
    }
  }

  return out.sort((a, b) => a.line - b.line);
}

/**
 * The route path a Next.js route module serves.
 *
 * `apps/fiab-console/app/api/copilot/sessions/[id]/trace/route.ts`
 *   -> `/api/copilot/sessions/[id]/trace`
 *
 * Returns `null` for a path that is not an `app/**\/route.ts`, so a caller
 * cannot accidentally treat a library module as a route.
 */
export function routePathOf(filePath: string): string | null {
  const p = filePath.replace(/\\/g, '/');
  const marker = '/app/';
  const at = p.lastIndexOf(marker);
  if (at < 0 || !/\/route\.tsx?$/.test(p)) return null;
  const rest = p.slice(at + marker.length).replace(/\/route\.tsx?$/, '');
  // Route groups `(admin)` are organisational and are not part of the URL.
  const segments = rest.split('/').filter((s) => s.length > 0 && !/^\(.*\)$/.test(s));
  return `/${segments.join('/')}`;
}

/**
 * The caller-named dynamic segments of a route path: `[id]`, `[...slug]`.
 *
 * These are the canonical "resource named by caller input" for C1 — the value
 * arrives in the URL, chosen entirely by the caller, and is what a point-read
 * keys on.
 */
export function dynamicSegmentsOf(routePath: string): string[] {
  const out: string[] = [];
  const re = /\[(?:\.\.\.)?([A-Za-z0-9_]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(routePath)) !== null) out.push(m[1]);
  return out;
}
