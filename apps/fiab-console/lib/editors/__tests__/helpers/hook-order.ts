/**
 * hook-order.ts — extract the React hook-call sequence of a component from
 * TypeScript/TSX source, expanding named custom hooks inline at their call
 * sites.
 *
 * Used by `semantic-model-hook-order.test.ts` to prove that the R10
 * decomposition of `semantic-model-editor.tsx` (and every future slice of it)
 * does not reorder `SemanticModelEditorInner`'s hooks. React's Rules of Hooks
 * make the order load-bearing, and a "purely structural" refactor that quietly
 * moves a `useState` block past ~60 other hook registrations is not purely
 * structural.
 *
 * Deliberately a source-level analysis, not a runtime one: hook *order* is a
 * property of the source, and a golden-file diff is the artifact a reviewer can
 * actually read.
 */

/** Blank out comments and string/template literals, preserving offsets + lines. */
export function stripNonCode(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (src[i] === "'" || src[i] === '"' || src[i] === '`') {
      const q = src[i];
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === q) { j++; break; }
        j++;
      }
      out += q + blank(src.slice(i + 1, Math.max(i + 1, j - 1))) + (j - 1 > i ? q : '');
      i = j;
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

/**
 * Return the source of the `{ … }` body of `function <name>(` , starting from
 * the declaration line (so the declaration's own identifier is excluded by the
 * caller). Brace matching runs over comment/string-stripped source.
 */
export function extractFunctionSource(src: string, name: string): string {
  const stripped = stripNonCode(src);
  const decl = new RegExp(`function\\s+${name}\\s*(?:<|\\()`);
  const m = decl.exec(stripped);
  if (!m) throw new Error(`extractFunctionSource: function ${name} not found`);
  // Walk forward to the first '{' that opens the body, i.e. the first '{' at
  // paren-depth 0 after the parameter list closes.
  let i = m.index;
  let paren = 0;
  let seenParams = false;
  while (i < stripped.length) {
    const c = stripped[i];
    if (c === '(') { paren++; seenParams = true; }
    else if (c === ')') { paren--; }
    else if (c === '{' && paren === 0 && seenParams) break;
    i++;
  }
  let depth = 0;
  const start = i;
  for (; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

/**
 * Extract the ordered list of hook call names in `source`.
 *
 * A hook call is an identifier matching /^use[A-Z]/ that is immediately
 * followed (modulo whitespace and a balanced `<…>` type-argument list) by `(`.
 * The balanced scan is what makes `useState<{ ok: boolean; text: string } | null>(null)`
 * and `useState<Array<{ a: string }>>([])` count — a naive regex misses those,
 * which is how the original review under-counted the moved block.
 */
export function hookSequence(source: string): string[] {
  const s = stripNonCode(source);
  const out: string[] = [];
  const ident = /\buse[A-Z][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = ident.exec(s))) {
    // Skip property access (`obj.useThing`) and declarations (`function useX`).
    const before = s.slice(0, m.index).trimEnd();
    if (before.endsWith('.')) continue;
    if (/\bfunction$/.test(before)) continue;
    let i = m.index + m[0].length;
    // Optional type-argument list.
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] === '<') {
      let depth = 0;
      let ok = false;
      for (; i < s.length; i++) {
        if (s[i] === '=' && s[i + 1] === '>') { i++; continue; } // arrow in a fn type
        if (s[i] === '<') depth++;
        else if (s[i] === '>') { depth--; if (depth === 0) { i++; ok = true; break; } }
        else if (s[i] === ';' && depth === 0) break;
      }
      if (!ok) continue;
      while (i < s.length && /\s/.test(s[i])) i++;
    }
    if (s[i] !== '(') continue;
    out.push(m[0]);
  }
  return out;
}

/**
 * Hook sequence of `componentName` in `componentSource`, with every hook named
 * in `expansions` replaced in place by the hook sequence of its own body.
 */
export function expandedHookSequence(
  componentSource: string,
  componentName: string,
  expansions: Record<string, string>,
): string[] {
  const inner: Record<string, string[]> = {};
  for (const [hookName, hookSource] of Object.entries(expansions)) {
    inner[hookName] = hookSequence(extractFunctionSource(hookSource, hookName));
  }
  const out: string[] = [];
  for (const h of hookSequence(extractFunctionSource(componentSource, componentName))) {
    if (inner[h]) out.push(...inner[h]);
    else out.push(h);
  }
  return out;
}
