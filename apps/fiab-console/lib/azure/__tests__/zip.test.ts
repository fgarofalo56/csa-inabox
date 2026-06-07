import { describe, it, expect } from 'vitest';
import { writeZip, readZip } from '../zip';

describe('zip (PKZIP round-trip)', () => {
  it('round-trips a single JSON entry byte-for-byte', () => {
    const obj = { name: 'X', properties: { activities: [{ name: 'A', type: 'Copy' }] } };
    const json = JSON.stringify(obj, null, 2);
    const buf = writeZip([{ name: 'pipeline-content.json', data: Buffer.from(json, 'utf-8') }]);

    // EOCD signature must be present.
    expect(buf.length).toBeGreaterThan(22);

    const entries = readZip(buf);
    expect(entries.has('pipeline-content.json')).toBe(true);
    const out = entries.get('pipeline-content.json')!.toString('utf-8');
    expect(out).toBe(json);
    expect(JSON.parse(out)).toEqual(obj);
  });

  it('round-trips multiple entries (pipeline + manifest)', () => {
    const pipeline = Buffer.from(JSON.stringify({ properties: { activities: [] } }), 'utf-8');
    const manifest = Buffer.from(JSON.stringify({ loomExport: true, displayName: 'My PL' }), 'utf-8');
    const buf = writeZip([
      { name: 'pipeline-content.json', data: pipeline },
      { name: 'manifest.json', data: manifest },
    ]);
    const entries = readZip(buf);
    expect(entries.size).toBe(2);
    expect(entries.get('pipeline-content.json')!.equals(pipeline)).toBe(true);
    expect(entries.get('manifest.json')!.equals(manifest)).toBe(true);
  });

  it('handles a large/compressible payload (deflate path)', () => {
    const big = Buffer.from('a'.repeat(50_000) + JSON.stringify({ properties: { activities: [] } }), 'utf-8');
    const buf = writeZip([{ name: 'big.json', data: big }]);
    // Compression must actually shrink a highly-repetitive payload.
    expect(buf.length).toBeLessThan(big.length);
    const entries = readZip(buf);
    expect(entries.get('big.json')!.equals(big)).toBe(true);
  });

  it('throws on a non-ZIP buffer', () => {
    expect(() => readZip(Buffer.from('not a zip file at all'))).toThrow(/ZIP/);
  });
});
