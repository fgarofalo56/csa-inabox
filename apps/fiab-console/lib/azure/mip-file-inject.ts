/**
 * MIP (Microsoft Information Protection) sensitivity-label STAMPER — pure Node,
 * zero external dependencies.
 *
 * Why "backend proxy MIP SDK" is implemented this way
 * ----------------------------------------------------------------------------
 * There is no official Node.js MIP File SDK, and the classic native SDK
 * (C++/C#/Python) cannot be invoked from the Next.js BFF runtime. What the
 * native SDK actually DOES, however, is fully specified and reproducible: it
 * writes a fixed set of `MSIP_Label_<GUID>_*` key/value pairs into the file's
 * metadata —
 *
 *   - Office Open XML (.docx/.xlsx/.pptx …): as <custom-properties> entries in
 *     the OPC package part `docProps/custom.xml` (fmtid
 *     {D5CDD505-2E9C-101B-9397-08002B2CF9AE}); Word/Excel/PowerPoint read these
 *     back and render the sensitivity bar.
 *   - PDF: as XMP packet properties under the `http://www.microsoft.com/...`
 *     (msip) namespace inside the document's XMP metadata stream.
 *
 * This module writes exactly those bytes, deterministically and verifiably —
 * the OPC ZIP is rebuilt from scratch (real CRC-32 + central directory) and the
 * PDF XMP packet is edited in place using the packet's reserved padding so the
 * stream /Length never changes (no xref rewrite, no corruption risk).
 *
 * Honest gates (per .claude/rules/no-vaporware.md): when a file cannot be safely
 * stamped (ZIP64 OPC, a PDF with no XMP packet, or a PDF whose XMP padding is too
 * small) the ORIGINAL bytes are returned unchanged with a precise status string
 * the BFF surfaces to the user — the download always succeeds.
 *
 * Everything here is covered by lib/azure/__tests__/mip-file-inject.test.ts,
 * which builds a real OPC ZIP, stamps it, and re-parses the result to prove the
 * archive is still valid and the MSIP_* properties are present.
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';

/** Sensitivity-label facts needed to stamp a file. */
export interface MipLabelInfo {
  /** MIP/Purview sensitivity-label GUID (no braces). */
  labelId: string;
  /** Display name, e.g. "Confidential". */
  labelName: string;
  /** ISO-8601 timestamp the label was applied. */
  setDate: string;
  /** Entra tenant id (SiteId). Optional — omitted when unknown. */
  siteId?: string;
  /** 'Standard' (user/automatic) or 'Privileged' (explicit). */
  method?: 'Standard' | 'Privileged';
}

export type MipStampStatus =
  | 'stamped'
  | 'unsupported-type'
  | 'no-xmp-stream'
  | 'pdf-insufficient-xmp-padding'
  | 'ooxml-zip64-unsupported'
  | 'ooxml-parse-failed'
  | 'invalid-label';

export interface MipStampResult {
  body: Buffer;
  status: MipStampStatus;
}

const PDF_EXTS = ['.pdf'];
const OOXML_EXTS = ['.docx', '.docm', '.dotx', '.xlsx', '.xlsm', '.xltx', '.pptx', '.pptm', '.potx'];

function ext(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i >= 0 ? filename.slice(i).toLowerCase() : '';
}

/** Returns the stamp family for a filename, or null when unsupported. */
export function isMipSupportedType(filename: string): 'pdf' | 'ooxml' | null {
  const e = ext(filename || '');
  if (PDF_EXTS.includes(e)) return 'pdf';
  if (OOXML_EXTS.includes(e)) return 'ooxml';
  return null;
}

/** GUID check — labelId must be a real GUID for the MSIP_Label_<GUID>_* keys. */
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function xmlEscape(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The canonical ordered MSIP_Label_<GUID>_* key/value list the native MIP SDK
 * writes. The same set is used for both OOXML custom properties and PDF XMP.
 */
export function buildMsipProps(label: MipLabelInfo): { key: string; value: string }[] {
  const g = label.labelId;
  const out: { key: string; value: string }[] = [
    { key: `MSIP_Label_${g}_Enabled`, value: 'True' },
    { key: `MSIP_Label_${g}_SetDate`, value: label.setDate },
    { key: `MSIP_Label_${g}_Method`, value: label.method || 'Standard' },
    { key: `MSIP_Label_${g}_Name`, value: label.labelName },
    { key: `MSIP_Label_${g}_ContentBits`, value: '0' },
    { key: `MSIP_Label_${g}_ActionId`, value: randomUUID() },
  ];
  if (label.siteId) out.push({ key: `MSIP_Label_${g}_SiteId`, value: label.siteId });
  return out;
}

/** Dispatch entrypoint — stamp `buf` based on the filename, returning result + status. */
export function stampMipLabel(buf: Buffer, filename: string, label: MipLabelInfo): MipStampResult {
  if (!label?.labelId || !GUID_RE.test(label.labelId)) {
    return { body: buf, status: 'invalid-label' };
  }
  const kind = isMipSupportedType(filename);
  if (kind === 'pdf') return injectMipXmpIntoPdf(buf, label);
  if (kind === 'ooxml') return injectMipIntoOoxml(buf, label);
  return { body: buf, status: 'unsupported-type' };
}

// ============================================================
// PDF — XMP packet edit (padding-preserving, no xref rewrite)
// ============================================================

/**
 * Insert the MSIP_* properties into the PDF's XMP metadata packet. The XMP spec
 * mandates trailing whitespace padding before `<?xpacket end=...?>` precisely so
 * tools can edit in place; we consume an equal number of padding bytes to keep
 * the stream byte-length (and therefore the /Length entry + xref) identical.
 */
export function injectMipXmpIntoPdf(buf: Buffer, label: MipLabelInfo): MipStampResult {
  const text = buf.toString('latin1');
  const rdfClose = '</rdf:RDF>';
  const rdfIdx = text.indexOf(rdfClose);
  if (rdfIdx < 0) return { body: buf, status: 'no-xmp-stream' };

  // Build the rdf:Description block carrying the msip properties.
  const props = buildMsipProps(label)
    .map((p) => `   <msip:${p.key}>${xmlEscape(p.value)}</msip:${p.key}>`)
    .join('\n');
  const block =
    `\n  <rdf:Description rdf:about="" xmlns:msip="http://www.microsoft.com/schemas/msip">\n` +
    `${props}\n` +
    `  </rdf:Description>\n `;
  const insertBytes = Buffer.byteLength(block, 'latin1');

  // Find the xpacket end + the whitespace padding that precedes it so we can
  // reclaim exactly `insertBytes` of padding and keep total length constant.
  const endIdx = text.indexOf('<?xpacket end', rdfIdx);
  if (endIdx < 0) return { body: buf, status: 'pdf-insufficient-xmp-padding' };

  // Count whitespace run immediately before <?xpacket end ...?>.
  let padStart = endIdx;
  while (padStart > rdfIdx && /\s/.test(text[padStart - 1])) padStart--;
  const padLen = endIdx - padStart;
  if (padLen < insertBytes) return { body: buf, status: 'pdf-insufficient-xmp-padding' };

  // Compose: [head .. before </rdf:RDF>] + block + </rdf:RDF> + [reduced padding] + [tail].
  const head = text.slice(0, rdfIdx);
  const afterRdf = text.slice(rdfIdx + rdfClose.length, padStart); // between </rdf:RDF> and padding
  const reducedPad = ' '.repeat(padLen - insertBytes);
  const tail = text.slice(endIdx);
  const rebuilt = head + block + rdfClose + afterRdf + reducedPad + tail;

  const outBuf = Buffer.from(rebuilt, 'latin1');
  // Length invariant — guarantees we did not break the xref / stream /Length.
  if (outBuf.length !== buf.length) return { body: buf, status: 'pdf-insufficient-xmp-padding' };
  return { body: outBuf, status: 'stamped' };
}

// ============================================================
// OOXML (OPC ZIP) — rebuild with custom.xml MSIP properties
// ============================================================

const FMTID = '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}';
const CUSTOM_PART = 'docProps/custom.xml';
const CUSTOM_CT =
  '<Override PartName="/docProps/custom.xml" ' +
  'ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>';
const CUSTOM_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties';

interface ZipEntry {
  name: string;
  method: number;       // 0 stored | 8 deflate
  crc: number;          // uint32
  data: Buffer;         // compressed bytes (as stored on disk)
  uncompSize: number;
}

// ---- CRC-32 (IEEE) ----
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

/** Parse an OPC ZIP into entries (compressed data preserved as-is). */
function parseZip(buf: Buffer): ZipEntry[] {
  // Locate EOCD by scanning backwards for the signature 0x06054b50.
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('ZIP64');
  }

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central header');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    // Read the local header to find where the data actually begins.
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('bad local header');
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.slice(dataStart, dataStart + compSize);

    entries.push({ name, method, crc, data, uncompSize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntryText(e: ZipEntry): string {
  const raw = e.method === 8 ? inflateRawSync(e.data) : e.data;
  return raw.toString('utf8');
}

/** Build a stored-or-deflated entry from plain UTF-8 text. */
function makeEntry(name: string, text: string): ZipEntry {
  const uncompressed = Buffer.from(text, 'utf8');
  const deflated = deflateRawSync(uncompressed, { level: 9 });
  // Prefer the smaller representation; STORED avoids surprises on tiny parts.
  const useDeflate = deflated.length < uncompressed.length;
  return {
    name,
    method: useDeflate ? 8 : 0,
    crc: crc32(uncompressed),
    data: useDeflate ? deflated : uncompressed,
    uncompSize: uncompressed.length,
  };
}

/** Re-serialize entries to a valid ZIP (no data descriptors, no ZIP64). */
function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);          // version needed
    lfh.writeUInt16LE(0, 6);           // flags (no data descriptor)
    lfh.writeUInt16LE(e.method, 8);
    lfh.writeUInt16LE(0, 10);          // mod time
    lfh.writeUInt16LE(0x21, 12);       // mod date (1980-01-01)
    lfh.writeUInt32LE(e.crc, 14);
    lfh.writeUInt32LE(e.data.length, 18);
    lfh.writeUInt32LE(e.uncompSize, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);          // extra len
    locals.push(lfh, nameBuf, e.data);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);          // version made by
    cdh.writeUInt16LE(20, 6);          // version needed
    cdh.writeUInt16LE(0, 8);           // flags
    cdh.writeUInt16LE(e.method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x21, 14);
    cdh.writeUInt32LE(e.crc, 16);
    cdh.writeUInt32LE(e.data.length, 20);
    cdh.writeUInt32LE(e.uncompSize, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);          // extra
    cdh.writeUInt16LE(0, 32);          // comment
    cdh.writeUInt16LE(0, 34);          // disk #
    cdh.writeUInt16LE(0, 36);          // internal attrs
    cdh.writeUInt32LE(0, 38);          // external attrs
    cdh.writeUInt32LE(offset, 42);     // local header offset
    centrals.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + e.data.length;
  }

  const cdBuf = Buffer.concat(centrals);
  const cdStart = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

function buildCustomXml(label: MipLabelInfo, existingText?: string): string {
  // Collect existing <property> blocks (drop any prior MSIP_Label_* so a re-stamp
  // replaces cleanly), tracking the max pid so new ones stay unique.
  const kept: string[] = [];
  let maxPid = 1;
  if (existingText) {
    const re = /<property\b[^>]*\bpid="(\d+)"[^>]*\bname="([^"]*)"[\s\S]*?<\/property>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(existingText))) {
      const pid = parseInt(m[1], 10);
      if (!Number.isNaN(pid)) maxPid = Math.max(maxPid, pid);
      if (!/^MSIP_Label_/.test(m[2])) kept.push(m[0]);
    }
  }
  let pid = maxPid + 1;
  const msip = buildMsipProps(label)
    .map(
      (p) =>
        `<property fmtid="${FMTID}" pid="${pid++}" name="${xmlEscape(p.key)}">` +
        `<vt:lpwstr>${xmlEscape(p.value)}</vt:lpwstr></property>`,
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    kept.join('') +
    msip +
    '</Properties>'
  );
}

function ensureContentTypeOverride(xml: string): string {
  if (xml.includes('PartName="/docProps/custom.xml"')) return xml;
  return xml.replace('</Types>', `${CUSTOM_CT}</Types>`);
}

function ensureRootRel(xml: string): string {
  if (xml.includes('Target="docProps/custom.xml"')) return xml;
  // Pick an rId that doesn't collide with existing ones.
  const used = new Set<string>();
  const re = /Id="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) used.add(m[1]);
  let n = 1;
  let rid = `rId${n}`;
  while (used.has(rid)) { n++; rid = `rId${n}`; }
  const rel = `<Relationship Id="${rid}" Type="${CUSTOM_REL_TYPE}" Target="docProps/custom.xml"/>`;
  return xml.replace('</Relationships>', `${rel}</Relationships>`);
}

/**
 * Stamp an OPC (OOXML) package by adding/replacing the MSIP_* custom document
 * properties in docProps/custom.xml and wiring the part into [Content_Types].xml
 * and the package root relationships.
 */
export function injectMipIntoOoxml(buf: Buffer, label: MipLabelInfo): MipStampResult {
  let entries: ZipEntry[];
  try {
    entries = parseZip(buf);
  } catch (e: any) {
    if (String(e?.message).includes('ZIP64')) return { body: buf, status: 'ooxml-zip64-unsupported' };
    return { body: buf, status: 'ooxml-parse-failed' };
  }

  try {
    const byName = new Map(entries.map((e) => [e.name, e] as const));

    // 1) custom.xml — merge or create.
    const existing = byName.get(CUSTOM_PART);
    const customXml = buildCustomXml(label, existing ? readEntryText(existing) : undefined);
    const customEntry = makeEntry(CUSTOM_PART, customXml);
    if (existing) {
      const idx = entries.findIndex((e) => e.name === CUSTOM_PART);
      entries[idx] = customEntry;
    } else {
      entries.push(customEntry);
    }

    // 2) [Content_Types].xml override (only when adding the part fresh).
    if (!existing) {
      const ct = byName.get('[Content_Types].xml');
      if (!ct) return { body: buf, status: 'ooxml-parse-failed' };
      const idx = entries.findIndex((e) => e.name === '[Content_Types].xml');
      entries[idx] = makeEntry('[Content_Types].xml', ensureContentTypeOverride(readEntryText(ct)));

      // 3) package root relationship.
      const rels = byName.get('_rels/.rels');
      if (!rels) return { body: buf, status: 'ooxml-parse-failed' };
      const ridx = entries.findIndex((e) => e.name === '_rels/.rels');
      entries[ridx] = makeEntry('_rels/.rels', ensureRootRel(readEntryText(rels)));
    }

    return { body: buildZip(entries), status: 'stamped' };
  } catch {
    return { body: buf, status: 'ooxml-parse-failed' };
  }
}

// Test-only: expose internal ZIP helpers so the vitest spec can re-parse a
// stamped OPC package and assert the MSIP_* custom properties round-trip.
export const __testing = { parseZip, readEntryText, makeEntry, buildZip, crc32 };
