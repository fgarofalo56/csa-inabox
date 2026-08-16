/**
 * INVARIANT: every Key Vault secret-VALUE reader enforces the purpose policy.
 *
 * WHY THIS FILE EXISTS
 *   #2683 added the purpose allow-list to `getKeyVaultSecretValue` and threaded a
 *   purpose through ~13 call sites. It missed `getShortcutSecretValue`, a SECOND
 *   reader in the same module that resolves a caller-supplied `?kvSecret=` name.
 *   TypeScript could not catch it: the function simply never had a `purpose`
 *   parameter to omit, so every call site type-checked.
 *
 *   That is the repo's recurring "seventh consumer" shape: the correct helper
 *   exists, and a sibling never adopts it. The compiler enforces that CALLERS
 *   pass a purpose; nothing enforced that a NEW READER asks for one. This test
 *   is that missing half — it reads the module source and fails when a function
 *   that reaches a `/secrets/` endpoint does not call `assertSecretReadAllowed`
 *   first.
 *
 * WHAT IS IN POPULATION, AND WHAT IS NOT — stated explicitly, because a guard
 * that does not say where it stops gets trusted past its evidence:
 *
 *   • SCOPE IS THIS ONE MODULE. `kv-secrets-client.ts` is the only file this
 *     test reads. A KV `/secrets/` GET elsewhere is NOT covered — and one
 *     already exists (`lib/admin/secret-health.ts` issues `GET {vault}/secrets/
 *     {name}` for two hard-coded names and reads `attributes`, never `.value`,
 *     so it is safe but proves the shape is reachable outside this file). The
 *     limit is deliberate rather than lazy: the repo's PreToolUse secrets guard
 *     denies reading several of the sibling files a cross-file scan would have
 *     to police, so an expectation over them could not be validated before
 *     shipping it. Widening this test means widening it WITH the ability to
 *     verify what it asserts. `check-external-origin-urls.mjs` states its own
 *     boundary the same way.
 *
 *   • EXFILTRATION ONLY — NOT DESTRUCTION. PUT and DELETE are excluded because
 *     they return no value, so they cannot leak one. That is true about
 *     exfiltration and SILENT ABOUT DESTRUCTION, and the silence has already
 *     cost something: a caller-aimed KV soft-DELETE (issue #3611) is invisible
 *     to every assertion here, by construction. A destruction primitive needs a
 *     different control than a read primitive; do not read a pass from this file
 *     as evidence that delete paths are safe.
 *
 * Deliberately source-level. A behavioural test can only cover the readers we
 * already know about; the defect here was an UNKNOWN reader, so the population
 * has to be derived from the file rather than listed by hand.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '..', 'kv-secrets-client.ts'), 'utf-8');

/** Blank a span while preserving length, so every index stays comparable. */
const blank = (m: string) => ' '.repeat(m.length);

/**
 * Comments blanked, STRING LITERALS PRESERVED. Used to decide what a function
 * touches: the `/secrets/` path lives inside a template literal, so a masking
 * that blanks strings would erase the very thing being detected.
 */
function maskComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank);
}

/**
 * Comments AND string literals blanked. Used for brace matching and for ORDERING
 * indices, so that neither a comment nor a string can position a policy call
 * where the code does not. An earlier revision indexed `assertSecretReadAllowed`
 * against the ORIGINAL text, which meant a single line of prose —
 * `// assertSecretReadAllowed is applied below` — disabled every ordering check
 * while the suite stayed green.
 */
function maskCommentsAndStrings(source: string): string {
  return maskComments(source)
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => `\`${blank(m.slice(2))}\``)
    .replace(/'(?:\\.|[^'\\])*'/g, (m) => `'${blank(m.slice(2))}'`)
    .replace(/"(?:\\.|[^"\\])*"/g, (m) => `"${blank(m.slice(2))}"`);
}

const COMMENTS_MASKED = maskComments(SRC);
const FULLY_MASKED = maskCommentsAndStrings(SRC);

interface Decl {
  name: string;
  exported: boolean;
  /** Body span [start,end] of the `{ … }`, as indices into every masking. */
  start: number;
  end: number;
}

/**
 * Every top-level function-like declaration, whether written as a `function` or
 * as a `const … = (…) => {}`. An earlier revision matched only
 * `export (async )?function NAME(`, so a reader written as an exported arrow
 * const was structurally invisible to the whole file.
 */
function declarations(): Decl[] {
  const out: Decl[] = [];
  const patterns: { re: RegExp; exported: boolean }[] = [
    { re: /(export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g, exported: false },
    // NOTE the return-type group is `[^=]*` and NOT `[^=>]*`: a return type of
    // `Promise<string>` contains '>', so excluding '>' made this pattern fail to
    // match the exact arrow-const shape it was added to catch. It matched
    // nothing, the suite stayed green, and the mutant walked straight through.
    { re: /(export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\s*)?\([^)]*\)\s*(?::[^=]*)?=>/g, exported: false },
  ];
  for (const { re } of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(FULLY_MASKED))) {
      const name = m[2];
      const exported = !!m[1];
      const open = FULLY_MASKED.indexOf('{', re.lastIndex - 1);
      if (open < 0) continue;
      let depth = 0;
      let end = -1;
      for (let i = open; i < FULLY_MASKED.length; i++) {
        if (FULLY_MASKED[i] === '{') depth++;
        else if (FULLY_MASKED[i] === '}') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end < 0) continue;
      out.push({ name, exported, start: open, end: end + 1 });
    }
  }
  return out;
}

const DECLS = declarations();
const bodyOf = (d: Decl, masking: string) => masking.slice(d.start, d.end);

/** Names of module-local helpers whose own body reaches a `/secrets/` path. */
const SECRET_PATH_HELPERS = DECLS
  .filter((d) => /\/secrets\//.test(bodyOf(d, COMMENTS_MASKED)))
  .map((d) => d.name);

/**
 * A declaration READS SECRET MATERIAL when it reaches a `/secrets/` endpoint —
 * directly, or through a module-local helper that builds the path. The
 * indirection step matters: hoisting the literal into a `kvSecretPath()` helper
 * would otherwise drop the reader out of the population entirely, which is a
 * one-line way to make this whole file stop watching.
 *
 * PUT / DELETE are excluded — see the destruction caveat in the header.
 */
function readsSecretValue(d: Decl): boolean {
  const body = bodyOf(d, COMMENTS_MASKED);
  const direct = /\/secrets\//.test(body);
  const viaHelper = SECRET_PATH_HELPERS.some(
    (h) => h !== d.name && new RegExp(`\\b${h}\\s*\\(`).test(body),
  );
  if (!direct && !viaHelper) return false;
  if (/method:\s*['"](PUT|DELETE)['"]/.test(body)) return false;
  return true;
}

const READERS = DECLS.filter((d) => d.exported && readsSecretValue(d));

describe('the population of secret-value readers is derived, not assumed', () => {
  it('parses both function and arrow declarations', () => {
    const names = DECLS.map((d) => d.name);
    expect(names).toContain('getKeyVaultSecretValue');
    expect(names).toContain('getShortcutSecretValue');
    // A helper-style declaration must be visible too, or the arrow/indirection
    // handling above is untested against this module's real shape.
    expect(names).toContain('token');
  });

  it('CANARY: both known readers are still in population', () => {
    // If an indirection ever drops a known reader out of the set, every
    // assertion below would vacuously pass over a shrinking population. This is
    // the check that fails loudly instead.
    const names = READERS.map((d) => d.name);
    expect(names).toContain('getKeyVaultSecretValue');
    expect(names).toContain('getShortcutSecretValue');
  });

  it('excludes the writers and the soft-delete paths', () => {
    const names = READERS.map((d) => d.name);
    expect(names).not.toContain('putKeyVaultSecret');
    expect(names).not.toContain('putShortcutSecret');
    expect(names).not.toContain('deleteKeyVaultSecret');
    expect(names).not.toContain('deleteShortcutSecret');
  });
});

describe('every secret-value reader enforces the purpose policy', () => {
  const names = READERS.map((d) => d.name);

  it.each(names)('%s calls assertSecretReadAllowed', (name) => {
    const d = READERS.find((r) => r.name === name)!;
    expect(bodyOf(d, FULLY_MASKED)).toMatch(/assertSecretReadAllowed\s*\(/);
  });

  it.each(names)('%s enforces BEFORE resolving the vault, minting a token, or fetching', (name) => {
    const d = READERS.find((r) => r.name === name)!;
    // Indices are taken against the FULLY masked body, so a comment or a string
    // mentioning the policy cannot stand in for calling it.
    const body = bodyOf(d, FULLY_MASKED);
    const assertAt = body.indexOf('assertSecretReadAllowed');
    expect(assertAt).toBeGreaterThanOrEqual(0);

    // The vault matcher covers the PREFIXED resolvers (`shortcutVaultUrl`,
    // `certVaultUrl`) — matching only /vaultUrl\(/ was blind to the exact reader
    // this file exists to police.
    const sinks: Record<string, number> = {
      'a vault-url resolver': body.search(/\w*[Vv]aultUrl\s*\(/),
      'a token mint': body.search(/\btoken\s*\(/),
      'an outbound fetch': body.search(/fetchWithTimeout\s*\(/),
    };
    for (const [what, at] of Object.entries(sinks)) {
      if (at < 0) continue;
      expect(
        assertAt,
        `${name}: the purpose check must precede ${what} — a refusal must not have already read anything`,
      ).toBeLessThan(at);
    }
    expect(Object.values(sinks).some((at) => at >= 0)).toBe(true);
  });

  it.each(names)('%s takes a required purpose parameter', (name) => {
    const sig = new RegExp(
      `(?:function\\s+${name}\\s*\\(([^)]*)\\))|(?:${name}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?\\(([^)]*)\\))`,
    ).exec(FULLY_MASKED);
    expect(sig).not.toBeNull();
    const params = sig![1] ?? sig![2] ?? '';
    expect(params).toMatch(/purpose\s*:\s*KvSecretPurpose/);
    // An OPTIONAL or defaulted purpose would let a call site silently opt out.
    expect(params).not.toMatch(/purpose\s*\?\s*:/);
    expect(params).not.toMatch(/purpose\s*:\s*KvSecretPurpose\s*=/);
  });
});
