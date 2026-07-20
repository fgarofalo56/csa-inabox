import { describe, it, expect } from 'vitest';
import { buildStoreZip } from '../swa-zip';

describe('buildStoreZip', () => {
  it('produces a valid ZIP structure (signatures + EOCD entry count)', () => {
    const zip = buildStoreZip({ 'index.html': '<html>hi</html>', 'app.js': 'console.log(1)', 'staticwebapp.config.json': '{}' });
    expect(zip.readUInt32LE(0)).toBe(0x04034b50); // first local header
    const eocd = zip.subarray(zip.length - 22);
    expect(eocd.readUInt32LE(0)).toBe(0x06054b50); // end of central directory
    expect(eocd.readUInt16LE(10)).toBe(3);         // total entries
  });

  it('stores content verbatim (STORE method, sizes match)', () => {
    const content = 'abc123-Ω'; // multibyte to exercise utf-8 sizing
    const zip = buildStoreZip({ 'f.txt': content });
    const raw = Buffer.from(content, 'utf-8');
    expect(zip.readUInt16LE(8)).toBe(0);                 // method STORE
    expect(zip.readUInt32LE(18)).toBe(raw.length);       // compressed size
    expect(zip.readUInt32LE(22)).toBe(raw.length);       // uncompressed size
    expect(zip.includes(raw)).toBe(true);                // payload embedded verbatim
  });

  it('strips leading slashes from paths', () => {
    const zip = buildStoreZip({ '/nested/file.js': 'x' });
    expect(zip.includes(Buffer.from('nested/file.js'))).toBe(true);
    expect(zip.includes(Buffer.from('//nested'))).toBe(false);
  });
});
