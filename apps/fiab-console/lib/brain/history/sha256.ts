/**
 * SHA-256, in plain TypeScript, for the Brain's graph history (#3935).
 *
 * ── WHY NOT `node:crypto` ──────────────────────────────────────────────────
 * The whole `lib/brain` tree is pure by design so that detectors, the graph and
 * now the history are testable with no Azure tenant and importable from any
 * runtime. `node:crypto` would make this module — and, transitively,
 * `./index.ts` — unimportable from an edge runtime or a client component, which
 * is a real constraint here: the Brain visualizer is a client surface and W8
 * (#3934) consumes these types. `crypto.subtle` is the portable alternative and
 * is ASYNC, which would push a promise through every digest, diff and query
 * signature for no benefit.
 *
 * ── WHY NOT A CHEAP NON-CRYPTOGRAPHIC HASH ─────────────────────────────────
 * A 32- or 64-bit hash collides. The consequence of a collision HERE is not a
 * slow lookup: the store treats an equal digest as *"the estate did not change"*
 * and does not record a version. A collision therefore SILENTLY LOSES A REAL
 * CHANGE — the one failure this feature exists to prevent — and does it in a way
 * nothing downstream can detect. sha256's collision resistance is the property
 * being bought, not the pedigree.
 *
 * ── HOW IT IS PROVEN TO BE A REAL SHA-256 ──────────────────────────────────
 * `./__tests__/sha256.test.ts` runs the published FIPS 180-4 / NIST vectors. A
 * hand-rolled hash that is merely *deterministic* would pass every other test in
 * this directory — every one of them only needs "same input, same output" — so
 * the vectors are the only thing standing between this file and a toy hash with
 * a plausible name. Do not replace them with a self-consistency check.
 *
 * Implementation notes: standard FIPS 180-4. All arithmetic is on 32-bit words
 * with `| 0` / `>>> 0` to stay inside the int32 fast path and out of float
 * rounding, which is where naive JS SHA implementations go wrong.
 */

/** Round constants: first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** Initial hash: first 32 bits of the fractional parts of the square roots of the first 8 primes. */
const H0: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function toHex8(x: number): string {
  return (x >>> 0).toString(16).padStart(8, '0');
}

/**
 * sha256 of a UTF-8 string, as 64 lowercase hex characters.
 *
 * `TextEncoder` is used for the UTF-8 encoding because it is the one encoder
 * present in every runtime this code can land in. Hand-rolling UTF-8 is how a
 * hash starts disagreeing with itself across surrogate pairs.
 */
export function sha256Hex(input: string): string {
  const msg = new TextEncoder().encode(input);
  const msgLen = msg.length;

  // Padding: 0x80, then zeros, then the 64-bit big-endian bit length.
  const totalLen = ((msgLen + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(totalLen);
  buf.set(msg);
  buf[msgLen] = 0x80;

  // Bit length as a 64-bit big-endian value. Split with floating-point division
  // rather than a 32-bit shift: `bits << 32` is 0 in JS, and a >512 MB input
  // would silently hash as if it were shorter.
  const bits = msgLen * 8;
  const hi = Math.floor(bits / 0x100000000);
  const lo = bits >>> 0;
  buf[totalLen - 8] = (hi >>> 24) & 0xff;
  buf[totalLen - 7] = (hi >>> 16) & 0xff;
  buf[totalLen - 6] = (hi >>> 8) & 0xff;
  buf[totalLen - 5] = hi & 0xff;
  buf[totalLen - 4] = (lo >>> 24) & 0xff;
  buf[totalLen - 3] = (lo >>> 16) & 0xff;
  buf[totalLen - 2] = (lo >>> 8) & 0xff;
  buf[totalLen - 1] = lo & 0xff;

  const h = new Int32Array(8);
  for (let i = 0; i < 8; i += 1) h[i] = H0[i] | 0;

  const w = new Int32Array(64);

  for (let off = 0; off < totalLen; off += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = off + i * 4;
      w[i] = ((buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3]) | 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + hh) | 0;
  }

  let out = '';
  for (let i = 0; i < 8; i += 1) out += toHex8(h[i]);
  return out;
}

/**
 * A SHORT digest, for a value whose content must be change-detectable but must
 * never be stored.
 *
 * 16 hex characters = 64 bits. That is NOT the estate content address (see
 * {@link sha256Hex}); it is a per-field fingerprint whose only job is "did this
 * one env var value change?". A 64-bit collision there loses one field's change
 * on one edge, not a whole version, and the alternative — persisting the value —
 * puts connection strings in a store that may be exported.
 */
export function shortDigest(value: string): string {
  return sha256Hex(value).slice(0, 16);
}
