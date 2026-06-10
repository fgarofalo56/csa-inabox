/**
 * zip-reader.ts — a small, dependency-free ZIP archive reader.
 *
 * WHY A HAND-ROLLED READER
 * ------------------------
 * The SQL DB migration assistant runs on the Node.js BFF and needs to read a
 * `.dacpac` file — which is a standard PKZIP archive whose `model.xml` part
 * carries the database schema. The prod dependency tree is locked (no `jszip` /
 * `adm-zip` / `yauzl` resolvable from the app, matching the constraint already
 * documented in `rdl-xml.ts`), so this module implements a focused, correct ZIP
 * reader using only Node's built-in `zlib`.
 *
 * It supports the two storage methods DACPACs actually use:
 *   - method 0  (Stored / no compression)
 *   - method 8  (Deflate)        → `zlib.inflateRawSync`
 *
 * It reads the End-Of-Central-Directory record, walks the Central Directory to
 * locate each entry, then decompresses from the Local File Header. This is the
 * canonical "read a ZIP without a library" approach and is sufficient for the
 * DACPAC parts (model.xml, Origin.xml, [Content_Types].xml).
 *
 * Limitations (intentional — DACPACs never use these):
 *   - No ZIP64 (a DACPAC model.xml is well under 4 GB).
 *   - No encryption.
 * Both are detected and surfaced as honest errors rather than silently wrong
 * output.
 */

import zlib from 'zlib';

const EOCD_SIGNATURE = 0x06054b50; // End of central directory record
const CDH_SIGNATURE = 0x02014b50; // Central directory file header
const LFH_SIGNATURE = 0x04034b50; // Local file header

export interface ZipEntry {
  /** Entry path within the archive (forward-slash separated). */
  name: string;
  /** Decompressed (or stored) bytes. */
  data: Buffer;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

/** Locate the End-Of-Central-Directory record by scanning backwards from EOF. */
function findEocd(buf: Buffer): number {
  // EOCD is 22 bytes minimum; the trailing comment (almost always empty for a
  // DACPAC) can push it up to ~64 KB earlier. Scan that tail window.
  const minOffset = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new ZipError('Not a ZIP archive: End-Of-Central-Directory record not found.');
}

/**
 * Read every entry in a ZIP archive. Returns a map of entry path → bytes.
 * Throws {@link ZipError} for a malformed / unsupported archive.
 */
export function readZipEntries(buf: Buffer): Map<string, Buffer> {
  if (buf.length < 22) throw new ZipError('File is too small to be a ZIP archive.');

  const eocd = findEocd(buf);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || totalEntries === 0xffff) {
    throw new ZipError('ZIP64 archives are not supported.');
  }

  const entries = new Map<string, Buffer>();
  let ptr = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== CDH_SIGNATURE) {
      throw new ZipError(`Corrupt central directory at entry ${i + 1}.`);
    }
    const gpFlag = buf.readUInt16LE(ptr + 8);
    if (gpFlag & 0x0001) throw new ZipError('Encrypted ZIP entries are not supported.');

    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const fileNameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localHeaderOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + fileNameLen);

    // Resolve the actual compressed data start from the Local File Header,
    // whose extra-field length can differ from the central directory's.
    if (buf.readUInt32LE(localHeaderOffset) !== LFH_SIGNATURE) {
      throw new ZipError(`Corrupt local header for "${name}".`);
    }
    const lfhNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compSize);

    // Directory entries have a trailing slash and no payload — skip.
    if (!name.endsWith('/')) {
      let data: Buffer;
      if (method === 0) {
        data = Buffer.from(compressed);
      } else if (method === 8) {
        data = zlib.inflateRawSync(compressed);
      } else {
        throw new ZipError(`Unsupported ZIP compression method ${method} for "${name}".`);
      }
      entries.set(name, data);
    }

    ptr += 46 + fileNameLen + extraLen + commentLen;
  }

  return entries;
}

/**
 * Convenience: read a single named entry's UTF-8 text. Entry lookup is
 * case-insensitive on the leaf name to tolerate the `model.xml` vs `Model.xml`
 * casing that different DACPAC producers emit. Returns null if absent.
 */
export function readZipTextEntry(buf: Buffer, entryName: string): string | null {
  const entries = readZipEntries(buf);
  const direct = entries.get(entryName);
  if (direct) return direct.toString('utf8');
  const wantLeaf = entryName.split('/').pop()!.toLowerCase();
  for (const [name, data] of entries) {
    if (name.split('/').pop()!.toLowerCase() === wantLeaf) return data.toString('utf8');
  }
  return null;
}
