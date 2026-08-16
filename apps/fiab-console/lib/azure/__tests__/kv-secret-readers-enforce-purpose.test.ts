/**
 * INVARIANT: every Key Vault secret-VALUE reader enforces the purpose policy.
 *
 * WHY THIS FILE EXISTS
 *   #2683 added the purpose allow-list to `getKeyVaultSecretValue` and threaded a
 *   purpose through ~13 call sites. It missed `getShortcutSecretValue`, a SECOND
 *   reader in the same module that resolves a caller-supplied `?kvSecret=` name
 *   against a vault which — with LOOM_SHORTCUT_KEYVAULT unset, the default —
 *   IS the main Loom vault. TypeScript could not catch it: the function simply
 *   never had a `purpose` parameter to omit, so every call site type-checked.
 *
 *   That is the repo's recurring "seventh consumer" shape: the correct helper
 *   exists, and a sibling never adopts it. The compiler enforces that CALLERS
 *   pass a purpose; nothing enforced that a NEW READER asks for one. This test
 *   is that missing half — it reads the module source and fails when a function
 *   that GETs `/secrets/{name}` does not call `assertSecretReadAllowed` first.
 *
 * Deliberately source-level. A behavioural test can only cover the readers we
 * already know about; the defect here was an UNKNOWN reader, so the population
 * has to be derived from the file rather than listed by hand.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '..', 'kv-secrets-client.ts'), 'utf-8');

/**
 * Split the module into top-level `export async function <name>(…) { … }` bodies
 * by brace-matching. Comments and strings are masked first so a brace inside
 * either cannot desynchronise the depth count.
 */
function exportedFunctionBodies(source: string): Record<string, string> {
  const masked = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => `\`${' '.repeat(Math.max(0, m.length - 2))}\``)
    .replace(/'(?:\\.|[^'\\])*'/g, (m) => `'${' '.repeat(Math.max(0, m.length - 2))}'`)
    .replace(/"(?:\\.|[^"\\])*"/g, (m) => `"${' '.repeat(Math.max(0, m.length - 2))}"`);

  const out: Record<string, string> = {};
  const re = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const open = masked.indexOf('{', re.lastIndex);
    if (open < 0) continue;
    let depth = 0;
    let end = -1;
    for (let i = open; i < masked.length; i++) {
      if (masked[i] === '{') depth++;
      else if (masked[i] === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) continue;
    // Return the ORIGINAL text for the span (masking was only for brace safety).
    out[m[1]] = source.slice(open, end + 1);
  }
  return out;
}

const BODIES = exportedFunctionBodies(SRC);

/**
 * A function READS SECRET MATERIAL when it issues a GET against `/secrets/`.
 * PUT (store) and DELETE (soft-delete) do not return a value, so they are not
 * exfiltration primitives and are out of population.
 */
function readsSecretValue(body: string): boolean {
  if (!/\/secrets\//.test(body)) return false;
  if (/method:\s*['"](PUT|DELETE)['"]/.test(body)) return false;
  return true;
}

describe('the population of secret-value readers is derived, not assumed', () => {
  it('finds the exported functions in kv-secrets-client', () => {
    expect(Object.keys(BODIES).length).toBeGreaterThan(5);
    // Both known readers must be discovered, or the parser has silently stopped
    // seeing the thing this test is supposed to police.
    expect(BODIES).toHaveProperty('getKeyVaultSecretValue');
    expect(BODIES).toHaveProperty('getShortcutSecretValue');
  });

  it('classifies the readers and excludes the writers', () => {
    const readers = Object.keys(BODIES).filter((n) => readsSecretValue(BODIES[n]));
    expect(readers).toContain('getKeyVaultSecretValue');
    expect(readers).toContain('getShortcutSecretValue');
    expect(readers).not.toContain('putKeyVaultSecret');
    expect(readers).not.toContain('putShortcutSecret');
    expect(readers).not.toContain('deleteKeyVaultSecret');
    expect(readers).not.toContain('deleteShortcutSecret');
  });
});

describe('every secret-value reader enforces the purpose policy', () => {
  const readers = Object.keys(BODIES).filter((n) => readsSecretValue(BODIES[n]));

  it.each(readers)('%s calls assertSecretReadAllowed', (name) => {
    expect(BODIES[name]).toMatch(/assertSecretReadAllowed\s*\(/);
  });

  it.each(readers)('%s enforces BEFORE resolving the vault, minting a token, or fetching', (name) => {
    const body = BODIES[name];
    const assertAt = body.indexOf('assertSecretReadAllowed');
    expect(assertAt).toBeGreaterThanOrEqual(0);

    // Every sink that must not have run yet. NOTE the vault matcher covers the
    // PREFIXED resolvers too (`shortcutVaultUrl`, `certVaultUrl`) — an earlier
    // revision of this test matched only /vaultUrl\(/ and was therefore blind to
    // getShortcutSecretValue, the exact reader this file exists to police.
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
    // At least one sink must be present, or the classifier picked a function
    // that does not actually read and this assertion proves nothing.
    expect(Object.values(sinks).some((at) => at >= 0)).toBe(true);
  });

  it.each(readers)('%s takes a purpose parameter rather than defaulting one', (name) => {
    // Re-find the signature for this function in the original source.
    const sig = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\s*\\(([^)]*)\\)`).exec(SRC);
    expect(sig).not.toBeNull();
    expect(sig![1]).toMatch(/purpose\s*:\s*KvSecretPurpose/);
    // An OPTIONAL or defaulted purpose would let a call site silently opt out.
    expect(sig![1]).not.toMatch(/purpose\s*\?\s*:/);
    expect(sig![1]).not.toMatch(/purpose\s*:\s*KvSecretPurpose\s*=/);
  });
});
