// Origin boundary for credentialed requests that follow server-supplied links (a Key Vault `nextLink`, a version
// `kid`). A copy of `isSameOrigin` in apps/fiab-console/lib/util/same-origin-url.ts (a separate package, so copied,
// not imported). Compare parsed ORIGINS, never string prefixes: `https://kv.vault.azure.net.evil.example` starts
// with `https://kv.vault.azure.net`.

function originOf(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!u.origin || u.origin === 'null') return null;
  return u.origin;
}

/**
 * True when `candidate` parses AND shares an origin with `base`. False, never a throw, when either side fails to
 * parse: a base that cannot be parsed admits nothing (fail closed).
 */
export function isSameOrigin(candidate: string | null | undefined, base: string | null | undefined): boolean {
  const c = originOf((candidate || '').trim());
  const b = originOf((base || '').trim());
  if (!c || !b) return false;
  return c === b;
}
