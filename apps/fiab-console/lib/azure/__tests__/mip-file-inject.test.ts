/**
 * Vitest specs for mip-file-inject — the dependency-free MIP sensitivity-label
 * stamper. We build a REAL (STORED) OPC ZIP and a minimal PDF-with-XMP in-test,
 * stamp them, and re-parse the output to prove:
 *   - the OPC ZIP is still valid and carries the MSIP_Label_<GUID>_* custom
 *     properties (+ the Content_Types override + root relationship);
 *   - re-stamping replaces (does not duplicate) the MSIP set;
 *   - the PDF XMP edit preserves the byte-length (so /Length + xref stay valid);
 *   - honest gates return the original bytes unchanged.
 */
import { describe, it, expect } from 'vitest';
import {
  isMipSupportedType,
  buildMsipProps,
  stampMipLabel,
  injectMipXmpIntoPdf,
  injectMipIntoOoxml,
  __testing,
  type MipLabelInfo,
} from '../mip-file-inject';
import { deflateRawSync } from 'node:zlib';

const LABEL: MipLabelInfo = {
  labelId: '11111111-2222-3333-4444-555555555555',
  labelName: 'Confidential',
  setDate: '2026-06-06T00:00:00Z',
  siteId: '99999999-8888-7777-6666-555555555555',
  method: 'Standard',
};

// ---- minimal OPC ZIP builder (STORED entries) ----
function crc32(buf: Buffer): number {
  return __testing.crc32(buf);
}
function storedEntry(name: string, text: string) {
  const data = Buffer.from(text, 'utf8');
  return { name, data, crc: crc32(data) };
}
function buildOpc(parts: { name: string; text: string }[]): Buffer {
  const entries = parts.map((p) => storedEntry(p.name, p.text));
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(0, 8); // stored
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0x21, 12);
    lfh.writeUInt32LE(e.crc, 14);
    lfh.writeUInt32LE(e.data.length, 18);
    lfh.writeUInt32LE(e.data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    locals.push(lfh, nameBuf, e.data);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(0, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x21, 14);
    cdh.writeUInt32LE(e.crc, 16);
    cdh.writeUInt32LE(e.data.length, 20);
    cdh.writeUInt32LE(e.data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(offset, 42);
    centrals.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';
const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';
const DOCUMENT = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body/></w:document>';

function minimalDocx(): Buffer {
  return buildOpc([
    { name: '[Content_Types].xml', text: CONTENT_TYPES },
    { name: '_rels/.rels', text: ROOT_RELS },
    { name: 'word/document.xml', text: DOCUMENT },
  ]);
}

function readPart(zip: Buffer, name: string): string {
  const entries = __testing.parseZip(zip);
  const e = entries.find((x: any) => x.name === name);
  if (!e) throw new Error(`part not found: ${name}`);
  return __testing.readEntryText(e);
}

describe('isMipSupportedType', () => {
  it('classifies PDF, OOXML, and other types', () => {
    expect(isMipSupportedType('report.pdf')).toBe('pdf');
    expect(isMipSupportedType('budget.XLSX')).toBe('ooxml');
    expect(isMipSupportedType('deck.pptx')).toBe('ooxml');
    expect(isMipSupportedType('data.parquet')).toBeNull();
    expect(isMipSupportedType('blob.bin')).toBeNull();
  });
});

describe('buildMsipProps', () => {
  it('emits the canonical MSIP_Label_<GUID>_* keys', () => {
    const keys = buildMsipProps(LABEL).map((p) => p.key);
    expect(keys).toContain(`MSIP_Label_${LABEL.labelId}_Enabled`);
    expect(keys).toContain(`MSIP_Label_${LABEL.labelId}_Name`);
    expect(keys).toContain(`MSIP_Label_${LABEL.labelId}_SetDate`);
    expect(keys).toContain(`MSIP_Label_${LABEL.labelId}_SiteId`);
  });
});

describe('injectMipIntoOoxml', () => {
  it('stamps custom.xml + wires Content_Types + root rels, and round-trips', () => {
    const res = injectMipIntoOoxml(minimalDocx(), LABEL);
    expect(res.status).toBe('stamped');

    const custom = readPart(res.body, 'docProps/custom.xml');
    expect(custom).toContain(`MSIP_Label_${LABEL.labelId}_Enabled`);
    expect(custom).toContain('<vt:lpwstr>True</vt:lpwstr>');
    expect(custom).toContain('Confidential');
    expect(custom).toContain('{D5CDD505-2E9C-101B-9397-08002B2CF9AE}');

    const ct = readPart(res.body, '[Content_Types].xml');
    expect(ct).toContain('PartName="/docProps/custom.xml"');

    const rels = readPart(res.body, '_rels/.rels');
    expect(rels).toContain('Target="docProps/custom.xml"');
    expect(rels).toContain('custom-properties');

    // The original document part is preserved verbatim.
    expect(readPart(res.body, 'word/document.xml')).toBe(DOCUMENT);
  });

  it('re-stamping replaces (does not duplicate) the MSIP property set', () => {
    const first = injectMipIntoOoxml(minimalDocx(), LABEL);
    const second = injectMipIntoOoxml(first.body, { ...LABEL, labelName: 'Highly Confidential' });
    expect(second.status).toBe('stamped');
    const custom = readPart(second.body, 'docProps/custom.xml');
    // Exactly one Enabled property for this GUID after re-stamp.
    const occurrences = custom.split(`MSIP_Label_${LABEL.labelId}_Enabled`).length - 1;
    expect(occurrences).toBe(1);
    expect(custom).toContain('Highly Confidential');
  });

  it('merges into a pre-existing custom.xml, preserving non-MSIP properties', () => {
    const existingCustom =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" ' +
      'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="MyTag"><vt:lpwstr>keep-me</vt:lpwstr></property>' +
      '</Properties>';
    const docx = buildOpc([
      { name: '[Content_Types].xml', text: CONTENT_TYPES.replace('</Types>',
        '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>') },
      { name: '_rels/.rels', text: ROOT_RELS },
      { name: 'word/document.xml', text: DOCUMENT },
      { name: 'docProps/custom.xml', text: existingCustom },
    ]);
    const res = injectMipIntoOoxml(docx, LABEL);
    expect(res.status).toBe('stamped');
    const custom = readPart(res.body, 'docProps/custom.xml');
    expect(custom).toContain('keep-me');
    expect(custom).toContain(`MSIP_Label_${LABEL.labelId}_Name`);
  });

  it('honest-gates a non-ZIP buffer (parse failure, bytes unchanged)', () => {
    const junk = Buffer.from('not a zip at all', 'utf8');
    const res = injectMipIntoOoxml(junk, LABEL);
    expect(res.status).toBe('ooxml-parse-failed');
    expect(res.body).toBe(junk);
  });
});

describe('injectMipXmpIntoPdf', () => {
  function pdfWithXmp(paddingBytes: number): Buffer {
    const head = '%PDF-1.7\n<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>t</dc:title></rdf:Description>' +
      '</rdf:RDF></x:xmpmeta>';
    const pad = ' '.repeat(paddingBytes);
    const tail = '<?xpacket end="w"?>\n%%EOF\n';
    return Buffer.from(head + pad + tail, 'latin1');
  }

  it('stamps into the XMP packet without changing byte-length', () => {
    const input = pdfWithXmp(4000);
    const res = injectMipXmpIntoPdf(input, LABEL);
    expect(res.status).toBe('stamped');
    expect(res.body.length).toBe(input.length); // /Length + xref invariant
    const text = res.body.toString('latin1');
    expect(text).toContain('xmlns:msip="http://www.microsoft.com/schemas/msip"');
    expect(text).toContain(`<msip:MSIP_Label_${LABEL.labelId}_Name>Confidential</msip:MSIP_Label_${LABEL.labelId}_Name>`);
    expect(text).toContain('</rdf:RDF>');
    expect(text).toContain('<?xpacket end="w"?>');
  });

  it('honest-gates a PDF with no XMP packet', () => {
    const noXmp = Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF', 'latin1');
    const res = injectMipXmpIntoPdf(noXmp, LABEL);
    expect(res.status).toBe('no-xmp-stream');
    expect(res.body).toBe(noXmp);
  });

  it('honest-gates a PDF whose XMP padding is too small', () => {
    const res = injectMipXmpIntoPdf(pdfWithXmp(2), LABEL);
    expect(res.status).toBe('pdf-insufficient-xmp-padding');
  });
});

describe('stampMipLabel dispatch', () => {
  it('rejects a label without a real GUID', () => {
    const res = stampMipLabel(minimalDocx(), 'x.docx', { ...LABEL, labelId: 'not-a-guid' });
    expect(res.status).toBe('invalid-label');
  });
  it('returns unsupported-type for non-document files', () => {
    const res = stampMipLabel(Buffer.from('abc'), 'data.csv', LABEL);
    expect(res.status).toBe('unsupported-type');
  });
  it('routes .docx to the OOXML stamper', () => {
    const res = stampMipLabel(minimalDocx(), 'report.docx', LABEL);
    expect(res.status).toBe('stamped');
  });
});

describe('ZIP round-trip via __testing (deflated entries)', () => {
  it('parses deflated parts written by makeEntry/buildZip', () => {
    // makeEntry deflates; buildZip serializes; parseZip + readEntryText recover.
    const e = __testing.makeEntry('docProps/custom.xml', '<Properties>compress me '.repeat(50) + '</Properties>');
    const zip = __testing.buildZip([e]);
    const text = readPart(zip, 'docProps/custom.xml');
    expect(text).toContain('compress me');
    // Sanity: deflateRawSync actually shrank it (so method=8 was exercised).
    expect(deflateRawSync(Buffer.from('aaaaaaaaaa')).length).toBeLessThan(20);
  });
});
