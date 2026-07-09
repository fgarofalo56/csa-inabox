/**
 * Curated sample-stream + catalog tests (FGC-14). Pure data + generator logic.
 */
import { describe, it, expect } from 'vitest';
import {
  CURATED_SAMPLE_STREAMS,
  sampleStreamById,
  sampleStreamOptions,
  generateSampleEvents,
} from '../sample-streams';
import { SOURCE_CONNECTORS, sourceVisual } from '../source-catalog';

describe('curated sample streams', () => {
  it('exposes the Fabric-parity named catalog', () => {
    const ids = CURATED_SAMPLE_STREAMS.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['Bicycles', 'YellowTaxi', 'StockMarket', 'Buses', 'SP500', 'SemanticModelLogs']));
  });
  it('every stream has a non-empty schema + label', () => {
    for (const s of CURATED_SAMPLE_STREAMS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.schema.length).toBeGreaterThan(0);
      expect(s.defaultRate).toBeGreaterThan(0);
    }
  });
  it('sampleStreamById + options resolve', () => {
    expect(sampleStreamById('YellowTaxi')?.label).toBe('Yellow Taxi');
    expect(sampleStreamById('nope')).toBeUndefined();
    const opts = sampleStreamOptions();
    expect(opts).toHaveLength(CURATED_SAMPLE_STREAMS.length);
    expect(opts[0]).toHaveProperty('value');
    expect(opts[0]).toHaveProperty('label');
  });
});

describe('generateSampleEvents', () => {
  it('produces N events matching the stream schema keys', () => {
    const events = generateSampleEvents('YellowTaxi', 5, { seed: 1, now: 1_700_000_000_000 });
    expect(events).toHaveLength(5);
    const keys = Object.keys(events[0]);
    for (const f of sampleStreamById('YellowTaxi')!.schema) {
      expect(keys).toContain(f.name);
    }
  });
  it('is deterministic given a seed', () => {
    const a = generateSampleEvents('StockMarket', 3, { seed: 42, now: 1_700_000_000_000 });
    const b = generateSampleEvents('StockMarket', 3, { seed: 42, now: 1_700_000_000_000 });
    expect(a).toEqual(b);
  });
  it('caps count and rejects unknown streams', () => {
    expect(generateSampleEvents('Buses', 5000).length).toBeLessThanOrEqual(1000);
    expect(() => generateSampleEvents('nope', 1)).toThrow(/unknown sample stream/i);
  });
  it('emits ISO timestamps', () => {
    const [ev] = generateSampleEvents('SemanticModelLogs', 1, { seed: 7, now: 1_700_000_000_000 });
    expect(String(ev.timestamp)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('source catalog — new connectors (FGC-14)', () => {
  it('adds MongoDB / Oracle CDC, HTTP, Solace, weather', () => {
    const types = SOURCE_CONNECTORS.map((c) => c.sourceType);
    expect(types).toEqual(expect.arrayContaining(['MongoDBCDC', 'OracleDBCDC', 'Http', 'SolacePubSub', 'RealTimeWeather']));
  });
  it('infra-gated connectors carry an honest infraNote', () => {
    for (const id of ['mongodb-cdc', 'oracle-cdc', 'http-source', 'realtime-weather']) {
      const c = SOURCE_CONNECTORS.find((x) => x.id === id);
      expect(c, id).toBeTruthy();
      expect((c!.infraNote || '').length, id).toBeGreaterThan(0);
    }
  });
  it('sample-data uses a curated select, not free text', () => {
    const sd = SOURCE_CONNECTORS.find((c) => c.id === 'sample-data')!;
    const field = sd.fields.find((f) => f.key === 'sampleType')!;
    expect(field.kind).toBe('select');
    expect((field.options || []).length).toBe(CURATED_SAMPLE_STREAMS.length);
  });
  it('every connector resolves a visual (icon + colour)', () => {
    for (const c of SOURCE_CONNECTORS) {
      const v = sourceVisual(c);
      expect(v.icon).toBeTruthy();
      expect(v.color).toMatch(/^#/);
    }
  });
});
