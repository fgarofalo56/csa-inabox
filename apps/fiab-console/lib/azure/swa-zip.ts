/**
 * Minimal store-only (no compression) ZIP writer for the SWA publish path.
 * The app bundles are a handful of small text files (index.html + app.js +
 * staticwebapp.config.json), so STORE keeps this dependency-free while staying
 * a fully valid ZIP for the Static Web Apps zipdeploy fetcher.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a store-only ZIP from {path → utf-8 content}. Paths use forward slashes. */
export function buildStoreZip(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;

  for (const [path, content] of Object.entries(files)) {
    const name = Buffer.from(path.replace(/^\/+/, ''), 'utf-8');
    const data = Buffer.from(content, 'utf-8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);      // local file header signature
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(0x0800, 6);          // flags: UTF-8 names
    local.writeUInt16LE(0, 8);               // method: STORE
    local.writeUInt16LE(0, 10);              // mod time
    local.writeUInt16LE(0x21, 12);           // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);    // compressed size (= raw, STORE)
    local.writeUInt32LE(data.length, 22);    // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);              // extra length

    const cdir = Buffer.alloc(46);
    cdir.writeUInt32LE(0x02014b50, 0);       // central directory signature
    cdir.writeUInt16LE(20, 4);               // version made by
    cdir.writeUInt16LE(20, 6);               // version needed
    cdir.writeUInt16LE(0x0800, 8);           // flags: UTF-8 names
    cdir.writeUInt16LE(0, 10);               // method: STORE
    cdir.writeUInt16LE(0, 12);               // mod time
    cdir.writeUInt16LE(0x21, 14);            // mod date
    cdir.writeUInt32LE(crc, 16);
    cdir.writeUInt32LE(data.length, 20);
    cdir.writeUInt32LE(data.length, 24);
    cdir.writeUInt16LE(name.length, 28);
    cdir.writeUInt16LE(0, 30);               // extra length
    cdir.writeUInt16LE(0, 32);               // comment length
    cdir.writeUInt16LE(0, 34);               // disk number
    cdir.writeUInt16LE(0, 36);               // internal attrs
    cdir.writeUInt32LE(0, 38);               // external attrs
    cdir.writeUInt32LE(offset, 42);          // local header offset

    chunks.push(local, name, data);
    central.push(cdir, name);
    offset += local.length + name.length + data.length;
    count++;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);         // end of central directory
  eocd.writeUInt16LE(0, 4);                  // disk number
  eocd.writeUInt16LE(0, 6);                  // central directory disk
  eocd.writeUInt16LE(count, 8);              // entries on this disk
  eocd.writeUInt16LE(count, 10);             // total entries
  eocd.writeUInt32LE(centralBuf.length, 12); // central directory size
  eocd.writeUInt32LE(offset, 16);            // central directory offset
  eocd.writeUInt16LE(0, 20);                 // comment length

  return Buffer.concat([...chunks, centralBuf, eocd]);
}
