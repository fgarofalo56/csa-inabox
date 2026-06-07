/**
 * Minimal PKZIP read/write — no external dependencies.
 * Uses node:zlib deflateRawSync / inflateRawSync.
 * Only supports file sizes < 4 GiB (ZIP64 not needed for pipeline JSON).
 *
 * Used by the data-pipeline export/import routes so a pipeline can be
 * downloaded as a .zip (pipeline-content.json) and re-imported, identical
 * to the ADF Studio "Export template" / ARM export round-trip. No new npm
 * dependency is pulled in (PKZIP is implemented here against node:zlib).
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

// ── CRC-32 (PKZIP uses CRC-32 over uncompressed data) ──────────────────
const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ 0xffffffff) >>> 0;
}

// ── DOS time encoding (required by PKZIP header) ────────────────────────
function dosTime(d = new Date()): { time: number; date: number } {
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)) & 0xffff,
    date: ((((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate())) & 0xffff,
  };
}

// ── writeZip ─────────────────────────────────────────────────────────────
export interface ZipEntry { name: string; data: Buffer; }

export function writeZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const centralDir: Buffer[] = [];
  const { time: mt, date: md } = dosTime();
  let offset = 0;

  for (const { name, data } of entries) {
    const compressed = deflateRawSync(data, { level: 6 });
    const crc = crc32(data);
    const nameBuf = Buffer.from(name, 'utf-8');

    // Local file header
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0);  // sig
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(0, 6);           // flags
    lh.writeUInt16LE(8, 8);           // deflate
    lh.writeUInt16LE(mt, 10);
    lh.writeUInt16LE(md, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);          // extra
    nameBuf.copy(lh, 30);

    // Central directory record
    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);  // sig
    cd.writeUInt16LE(20, 4);          // version made by
    cd.writeUInt16LE(20, 6);          // version needed
    cd.writeUInt16LE(0, 8);           // flags
    cd.writeUInt16LE(8, 10);          // deflate
    cd.writeUInt16LE(mt, 12);
    cd.writeUInt16LE(md, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);          // extra len
    cd.writeUInt16LE(0, 32);          // comment len
    cd.writeUInt16LE(0, 34);          // disk start
    cd.writeUInt16LE(0, 36);          // internal attrs
    cd.writeUInt32LE(0, 38);          // external attrs
    cd.writeUInt32LE(offset, 42);     // local header offset
    nameBuf.copy(cd, 46);

    parts.push(lh, compressed);
    centralDir.push(cd);
    offset += lh.length + compressed.length;
  }

  const cdBuf = Buffer.concat(centralDir);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, cdBuf, eocd]);
}

// ── readZip ──────────────────────────────────────────────────────────────
export function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // Locate End of Central Directory by scanning backward for sig 0x06054b50
  let eocdOff = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOff = i; break; }
  }
  if (eocdOff < 0) throw new Error('Not a valid ZIP file (no EOCD)');

  const cdCount = buf.readUInt16LE(eocdOff + 8);
  let cdOff = buf.readUInt32LE(eocdOff + 16);

  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(cdOff) !== 0x02014b50) throw new Error('Corrupt central directory');
    const method = buf.readUInt16LE(cdOff + 10);
    const compSize = buf.readUInt32LE(cdOff + 20);
    const uncompSize = buf.readUInt32LE(cdOff + 24);
    const nameLen = buf.readUInt16LE(cdOff + 28);
    const extraLen = buf.readUInt16LE(cdOff + 30);
    const commentLen = buf.readUInt16LE(cdOff + 32);
    const localOff = buf.readUInt32LE(cdOff + 42);
    const name = buf.subarray(cdOff + 46, cdOff + 46 + nameLen).toString('utf-8');

    // Follow local header to data
    const lhNameLen = buf.readUInt16LE(localOff + 26);
    const lhExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lhNameLen + lhExtraLen;
    const compData = buf.subarray(dataOff, dataOff + compSize);
    const data = method === 0 ? Buffer.from(compData) : inflateRawSync(compData);
    if (uncompSize !== 0 && data.length !== uncompSize) {
      throw new Error(`ZIP: decompressed size mismatch for ${name}`);
    }
    out.set(name, data);
    cdOff += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
