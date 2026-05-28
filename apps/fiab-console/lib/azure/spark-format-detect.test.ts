import { describe, it, expect } from 'vitest';
import { detectSparkFormat, renderReadSnippet } from './spark-format-detect';

describe('detectSparkFormat', () => {
  it('detects parquet by extension', () => {
    const r = detectSparkFormat('events.parquet');
    expect(r.format).toBe('parquet');
    expect(r.native).toBe(true);
  });

  it('detects orc, avro, json, csv', () => {
    expect(detectSparkFormat('a.orc').format).toBe('orc');
    expect(detectSparkFormat('a.avro').format).toBe('avro');
    expect(detectSparkFormat('a.json').format).toBe('json');
    expect(detectSparkFormat('a.csv').format).toBe('csv');
    expect(detectSparkFormat('a.tsv').format).toBe('csv');
  });

  it('treats jsonl/ndjson as json with line-mode hint', () => {
    expect(detectSparkFormat('events.jsonl').format).toBe('json');
    expect(detectSparkFormat('events.ndjson').format).toBe('json');
  });

  it('routes XML through the spark-xml community connector', () => {
    const r = detectSparkFormat('catalog.xml');
    expect(r.format).toBe('xml');
    expect(r.native).toBe(false);
    expect(r.connector).toContain('spark-xml');
  });

  it('routes Excel through the spark-excel community connector', () => {
    const r = detectSparkFormat('report.xlsx');
    expect(r.format).toBe('excel');
    expect(r.native).toBe(false);
    expect(r.connector).toContain('spark-excel');
  });

  it('routes geo formats through Sedona', () => {
    expect(detectSparkFormat('shapes.geojson').connector).toContain('sedona');
    expect(detectSparkFormat('shapes.geoparquet').connector).toContain('sedona');
    expect(detectSparkFormat('roads.shp').connector).toContain('sedona');
    expect(detectSparkFormat('basin.gpkg').connector).toContain('sedona');
  });

  it('strips outer compression wrappers and uses inner extension', () => {
    expect(detectSparkFormat('events.json.gz').format).toBe('json');
    expect(detectSparkFormat('events.csv.bz2').format).toBe('csv');
    expect(detectSparkFormat('events.parquet.zst').format).toBe('parquet');
  });

  it('falls back to binaryFile for unknown extensions', () => {
    const r = detectSparkFormat('weird.xyz');
    expect(r.format).toBe('binaryFile');
    expect(r.native).toBe(true);
  });

  it('falls back via content-type when extension is missing', () => {
    expect(detectSparkFormat('Manifest', 'application/json').format).toBe('json');
    expect(detectSparkFormat('readme', 'text/plain').format).toBe('text');
    expect(detectSparkFormat('snapshot', 'image/png').format).toBe('image');
  });

  it('detects Delta Lake by _delta_log marker', () => {
    const r = detectSparkFormat('_delta_log/00000000000000000000.json');
    expect(r.format).toBe('delta');
  });

  it('renderReadSnippet substitutes the abfss path', () => {
    const hint = detectSparkFormat('events.parquet');
    const snippet = renderReadSnippet(
      hint,
      'abfss://bronze@acct.dfs.core.windows.net/events.parquet',
    );
    expect(snippet).toContain('abfss://');
    expect(snippet).not.toContain('{path}');
  });
});
