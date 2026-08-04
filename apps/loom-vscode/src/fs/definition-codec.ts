/**
 * Shared codec for an item definition ⇄ file bytes. The `loom:` FileSystemProvider
 * and the local mirror BOTH use this so a definition hashes identically whether
 * it came from the live FS or a downloaded file (the M/L/C comparison depends on
 * byte-for-byte agreement).
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Definition object → canonical pretty-printed JSON bytes (trailing newline). */
export function encodeDefinition(definition: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(definition, null, 2) + '\n');
}

/** File bytes → definition object (throws on invalid JSON — caller handles). */
export function decodeDefinition(bytes: Uint8Array): unknown {
  return JSON.parse(decoder.decode(bytes));
}
