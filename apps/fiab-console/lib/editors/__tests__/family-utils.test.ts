/**
 * Vitest — Power Platform / ML / Geo / Graph editor family.
 *
 * Exercises every exported helper in lib/editors/_family-utils.ts. Catches
 * the class of bug a UI smoke can't (regex break, off-by-one zoom, geo
 * walker missing nested polygons, etc.) without spinning up a browser.
 *
 * Coverage targets (sweep deliverable):
 *   - splitAdlsPath          [GeoDatasetEditor]
 *   - joinAdlsPath           [GeoDatasetEditor]
 *   - validateVarValue       [VariableLibraryEditor]
 *   - parseOntologyHierarchy [OntologyEditor]
 *   - aiStateLabel           [AiBuilderModelEditor]
 *   - aiStatusLabel          [AiBuilderModelEditor]
 *   - computeGeoBbox         [MapEditor]
 *   - bboxToZoom             [MapEditor]
 */
import { describe, it, expect } from 'vitest';
import {
  splitAdlsPath, joinAdlsPath,
  validateVarValue,
  parseOntologyHierarchy,
  aiStateLabel, aiStatusLabel,
  computeGeoBbox, bboxToZoom,
} from '../_family-utils';

// ============================================================
// splitAdlsPath / joinAdlsPath
// ============================================================

describe('splitAdlsPath', () => {
  it('parses a full abfss path', () => {
    expect(splitAdlsPath('abfss://gold@adls.dfs.core.windows.net/geo/events/'))
      .toEqual({ container: 'gold', suffix: 'geo/events/' });
  });
  it('parses a container-only path', () => {
    expect(splitAdlsPath('abfss://silver@adls.dfs.core.windows.net/'))
      .toEqual({ container: 'silver', suffix: '' });
  });
  it('parses a container-only path with no trailing slash', () => {
    expect(splitAdlsPath('abfss://bronze@adls.dfs.core.windows.net'))
      .toEqual({ container: 'bronze', suffix: '' });
  });
  it('returns the raw input as suffix when malformed', () => {
    expect(splitAdlsPath('not-a-real-path'))
      .toEqual({ container: '', suffix: 'not-a-real-path' });
  });
  it('returns an empty parse for an empty string', () => {
    expect(splitAdlsPath(''))
      .toEqual({ container: '', suffix: '' });
  });
});

describe('joinAdlsPath', () => {
  it('produces a full abfss path when account URL is provided', () => {
    const accountUrl = 'https://csaloomstor.dfs.core.windows.net/';
    expect(joinAdlsPath('gold', 'geo/events/', accountUrl))
      .toBe('abfss://gold@csaloomstor.dfs.core.windows.net/geo/events/');
  });
  it('strips a leading slash in the suffix to avoid double slashes', () => {
    expect(joinAdlsPath('gold', '/geo/events/', 'https://csaloomstor.dfs.core.windows.net/'))
      .toBe('abfss://gold@csaloomstor.dfs.core.windows.net/geo/events/');
  });
  it('emits a placeholder host when no account URL is provided', () => {
    expect(joinAdlsPath('gold', 'geo/'))
      .toBe('abfss://gold@<account>.dfs.core.windows.net/geo/');
  });
  it('returns the suffix unchanged when no container is selected', () => {
    expect(joinAdlsPath('', 'free/form/path')).toBe('free/form/path');
  });
  it('round-trips a parsed path back to its original shape', () => {
    const original = 'abfss://gold@csaloomstor.dfs.core.windows.net/geo/events/';
    const split = splitAdlsPath(original);
    const accountUrl = 'https://csaloomstor.dfs.core.windows.net/';
    expect(joinAdlsPath(split.container, split.suffix, accountUrl)).toBe(original);
  });
});

// ============================================================
// validateVarValue
// ============================================================

describe('validateVarValue', () => {
  it('passes empty values regardless of type', () => {
    expect(validateVarValue('integer', '')).toBeNull();
    expect(validateVarValue('guid', '')).toBeNull();
  });
  it('validates integers', () => {
    expect(validateVarValue('integer', '42')).toBeNull();
    expect(validateVarValue('integer', '-7')).toBeNull();
    expect(validateVarValue('integer', '3.14')).toMatch(/integer/);
    expect(validateVarValue('integer', 'abc')).toMatch(/integer/);
  });
  it('validates numbers (int OR float)', () => {
    expect(validateVarValue('number', '3.14')).toBeNull();
    expect(validateVarValue('number', '42')).toBeNull();
    expect(validateVarValue('number', '-1.5')).toBeNull();
    expect(validateVarValue('number', 'NaN')).toMatch(/number/);
  });
  it('validates booleans', () => {
    expect(validateVarValue('bool', 'true')).toBeNull();
    expect(validateVarValue('bool', 'False')).toBeNull();
    expect(validateVarValue('bool', '1')).toMatch(/true or false/);
  });
  it('validates ISO 8601 datetimes', () => {
    expect(validateVarValue('datetime', '2026-05-27')).toBeNull();
    expect(validateVarValue('datetime', '2026-05-27T14:30:00Z')).toBeNull();
    expect(validateVarValue('datetime', '2026-05-27T14:30:00+05:30')).toBeNull();
    expect(validateVarValue('datetime', 'yesterday')).toMatch(/ISO 8601/);
  });
  it('validates GUIDs', () => {
    expect(validateVarValue('guid', '12345678-1234-1234-1234-123456789012')).toBeNull();
    expect(validateVarValue('guid', 'abc')).toMatch(/GUID/);
  });
  it('passes string / item-ref / connection-ref / secret-ref through', () => {
    expect(validateVarValue('string', 'anything')).toBeNull();
    expect(validateVarValue('item-ref', 'wrk-123')).toBeNull();
    expect(validateVarValue('connection-ref', 'conn-abc')).toBeNull();
    expect(validateVarValue('secret-ref', 'kv:my-secret')).toBeNull();
  });
});

// ============================================================
// parseOntologyHierarchy
// ============================================================

describe('parseOntologyHierarchy', () => {
  it('parses a simple two-level hierarchy', () => {
    const src = `Thing : -- root\nParty : Thing -- person or org`;
    expect(parseOntologyHierarchy(src)).toEqual([
      { name: 'Thing', parent: undefined, description: 'root' },
      { name: 'Party', parent: 'Thing', description: 'person or org' },
    ]);
  });
  it('ignores blank lines and full-line comments', () => {
    const src = `# this is a comment\n\nThing :\n   # indented comment\nParty : Thing -- p`;
    expect(parseOntologyHierarchy(src)).toEqual([
      { name: 'Thing', parent: undefined, description: undefined },
      { name: 'Party', parent: 'Thing', description: 'p' },
    ]);
  });
  it('strips trailing inline comments', () => {
    const src = `Thing :   # root entity`;
    expect(parseOntologyHierarchy(src)).toEqual([
      { name: 'Thing', parent: undefined, description: undefined },
    ]);
  });
  it('drops malformed lines silently', () => {
    const src = `Thing :\n123-not-an-identifier\nParty : Thing`;
    expect(parseOntologyHierarchy(src)).toEqual([
      { name: 'Thing', parent: undefined, description: undefined },
      { name: 'Party', parent: 'Thing', description: undefined },
    ]);
  });
  it('handles the editor sample without throwing', () => {
    const src = `Thing :  -- root\nParty : Thing -- person or org\nCustomer : Party -- buying party\nVendor : Party -- selling party\nOrder : Thing -- transaction record`;
    const parsed = parseOntologyHierarchy(src);
    expect(parsed).toHaveLength(5);
    expect(parsed.find(c => c.name === 'Customer')?.parent).toBe('Party');
  });
});

// ============================================================
// aiStateLabel / aiStatusLabel
// ============================================================

describe('aiStateLabel', () => {
  it('maps 0 -> Active', () => { expect(aiStateLabel(0)).toBe('Active'); });
  it('maps 1 -> Inactive', () => { expect(aiStateLabel(1)).toBe('Inactive'); });
  it('falls back to em-dash for unknown / undefined', () => {
    expect(aiStateLabel(undefined)).toBe('—');
    expect(aiStateLabel(99)).toBe('—');
  });
});

describe('aiStatusLabel', () => {
  it('maps the known statuscode values', () => {
    expect(aiStatusLabel(1)).toBe('Draft');
    expect(aiStatusLabel(2)).toBe('Trained');
    expect(aiStatusLabel(3)).toBe('Published');
    expect(aiStatusLabel(4)).toBe('Training');
    expect(aiStatusLabel(5)).toBe('Training failed');
    expect(aiStatusLabel(6)).toBe('Publishing');
  });
  it('stringifies unknown numeric values', () => {
    expect(aiStatusLabel(42)).toBe('42');
  });
  it('returns em-dash for undefined', () => {
    expect(aiStatusLabel(undefined)).toBe('—');
  });
});

// ============================================================
// computeGeoBbox / bboxToZoom
// ============================================================

describe('computeGeoBbox', () => {
  it('returns null for an empty FeatureCollection', () => {
    expect(computeGeoBbox({ type: 'FeatureCollection', features: [] })).toBeNull();
  });
  it('returns null when no `features` array is present', () => {
    expect(computeGeoBbox({})).toBeNull();
    expect(computeGeoBbox(null)).toBeNull();
  });
  it('handles a single point', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-122.33, 47.61] } },
      ],
    };
    expect(computeGeoBbox(fc)).toEqual({ minLon: -122.33, maxLon: -122.33, minLat: 47.61, maxLat: 47.61 });
  });
  it('walks nested polygon coordinates', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature', properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: [[
              [-122.5, 47.5], [-122.0, 47.5], [-122.0, 47.8], [-122.5, 47.8], [-122.5, 47.5],
            ]],
          },
        },
      ],
    };
    expect(computeGeoBbox(fc)).toEqual({ minLon: -122.5, maxLon: -122.0, minLat: 47.5, maxLat: 47.8 });
  });
  it('combines multiple features into a single bbox', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-122.33, 47.61] } },
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-77.04, 38.91] } },
      ],
    };
    expect(computeGeoBbox(fc)).toEqual({ minLon: -122.33, maxLon: -77.04, minLat: 38.91, maxLat: 47.61 });
  });
});

describe('bboxToZoom', () => {
  it('returns the default zoom (8) when bbox is null', () => {
    expect(bboxToZoom(null)).toBe(8);
  });
  it('clamps very small spans to a high zoom', () => {
    const tight: NonNullable<ReturnType<typeof computeGeoBbox>> = {
      minLon: -122.331, maxLon: -122.329, minLat: 47.609, maxLat: 47.611,
    };
    const z = bboxToZoom(tight);
    expect(z).toBeGreaterThanOrEqual(15);
    expect(z).toBeLessThanOrEqual(18);
  });
  it('clamps very wide spans to a low zoom', () => {
    const wide: NonNullable<ReturnType<typeof computeGeoBbox>> = {
      minLon: -180, maxLon: 180, minLat: -85, maxLat: 85,
    };
    const z = bboxToZoom(wide);
    expect(z).toBeGreaterThanOrEqual(1);
    expect(z).toBeLessThanOrEqual(3);
  });
  it('never exceeds 18 or falls below 1', () => {
    expect(bboxToZoom({ minLon: 0, maxLon: 1e-12, minLat: 0, maxLat: 1e-12 })).toBeLessThanOrEqual(18);
    expect(bboxToZoom({ minLon: -180, maxLon: 180, minLat: -90, maxLat: 90 })).toBeGreaterThanOrEqual(1);
  });
});
