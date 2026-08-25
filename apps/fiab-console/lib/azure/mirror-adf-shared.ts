/**
 * mirror-adf-shared — the small primitives BOTH mirror engines need.
 *
 * `mirror-engine.ts` dispatches to `mirror-adf-copy.ts`, so anything the copy
 * runtime imports back out of the engine would be a require cycle. These four
 * values are the entire overlap, so they live here instead — a leaf module that
 * imports nothing of ours. Types stay in `mirror-engine.ts` and are pulled with
 * `import type`, which TypeScript erases, so they create no runtime edge.
 *
 * Extracted when `mirror-engine.ts` crossed its 1700-LOC ceiling. The seam is
 * the one the file already documented with its own banner comment — the ADF
 * Copy runtime — not an arbitrary line-count cut.
 */

/** The ADLS container every mirror lands into. */
export const BRONZE = 'bronze';

/** Cap how many tables one Start replicates when none were explicitly chosen. */
export const MAX_TABLES = Number(process.env.LOOM_MIRROR_MAX_TABLES || 50);

/**
 * ADF object name: letters/digits/_ only, first char a letter. Byte-for-byte
 * the same transform the provisioner's `adfName()` applies, so the derived
 * pipeline name matches the one `provisionAdfCdc()` created (`<name>_to_bronze`).
 */
export function adfSafeName(s: string): string {
  let n = s.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+/, '').slice(0, 120);
  if (!/^[A-Za-z]/.test(n)) n = `t_${n}`;
  return n || 'loom_mirror';
}

/** The pre-existing ADF AzureBlobFS (ADLS) linked service to bind, or null. */
export function mirrorAdlsLinkedService(): string | null {
  const v = process.env.LOOM_MIRROR_ADLS_LINKED_SERVICE;
  return v && v.trim() ? v.trim() : null;
}
