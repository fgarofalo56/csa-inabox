// Minimal USTAR reader/writer for OPA bundles (regular files only). A bundle is a few KB of
// `opa build` output, so this stays dependency-free instead of pulling in a tar package for the one
// place the control plane rewrites an archive. Anything it does not understand is REJECTED, never
// skipped: a signature must cover every byte OPA will later read.

export interface TarEntry {
  /** Name exactly as stored in the archive (OPA writes a leading "/"). */
  name: string;
  data: Buffer;
}

export class TarError extends Error {}

const BLOCK = 512;

function cstr(b: Buffer, from: number, len: number): string {
  const s = b.subarray(from, from + len);
  const z = s.indexOf(0);
  return s.subarray(0, z < 0 ? s.length : z).toString('utf8');
}

function octal(b: Buffer, from: number, len: number): number {
  const t = cstr(b, from, len).trim();
  if (!/^[0-7]*$/.test(t)) throw new TarError('tar header has a non-octal field');
  return t === '' ? 0 : parseInt(t, 8);
}

export function readTar(tar: Buffer, maxEntries = 64): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((x) => x === 0)) return out; // end-of-archive marker
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (h[i] as number);
    if (sum !== octal(h, 148, 8)) throw new TarError('tar header checksum mismatch');
    const type = String.fromCharCode(h[156] as number);
    if (type !== '0' && type !== '\0') throw new TarError(`unsupported tar entry type '${type === '\0' ? 'NUL' : type}' (regular files only)`);
    const prefix = cstr(h, 345, 155);
    const name = prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100);
    const size = octal(h, 124, 12);
    const start = off + BLOCK;
    if (start + size > tar.length) throw new TarError('tar entry runs past the end of the archive');
    if (out.length >= maxEntries) throw new TarError(`tar has more than ${maxEntries} entries`);
    out.push({ name, data: Buffer.from(tar.subarray(start, start + size)) });
    off = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  throw new TarError('tar has no end-of-archive marker');
}

export function writeTar(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    if (name.length === 0 || name.length > 100) throw new TarError(`tar entry name '${e.name}' is empty or longer than 100 bytes`);
    const h = Buffer.alloc(BLOCK);
    name.copy(h, 0);
    h.write('0000644\0', 100, 'ascii'); // mode
    h.write('0000000\0', 108, 'ascii'); // uid
    h.write('0000000\0', 116, 'ascii'); // gid
    h.write(`${e.data.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii'); // size
    h.write('00000000000\0', 136, 'ascii'); // mtime 0: the archive is reproducible
    h.fill(32, 148, 156); // checksum placeholder
    h.write('0', 156, 'ascii'); // regular file
    h.write('ustar\0', 257, 'ascii');
    h.write('00', 263, 'ascii');
    let sum = 0;
    for (const x of h) sum += x;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    parts.push(h, e.data, Buffer.alloc((BLOCK - (e.data.length % BLOCK)) % BLOCK));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}
