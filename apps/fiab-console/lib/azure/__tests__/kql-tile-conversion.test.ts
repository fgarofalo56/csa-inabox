/**
 * Pure-logic tests for the Query → Dashboard conversion helpers (operator
 * review 5.2): the wizard's step state machine (target → visual → details →
 * review gating) and the dashboard-model append (data-source reuse, content
 * fallback, sanitizer bounds). No I/O — these pin the behavior the BFF route
 * and the editor wizard both build on.
 */
import { describe, it, expect } from 'vitest';
import {
  CONVERSION_WIZARD_STEPS, TILE_SIZES,
  geometryForSize, checkTileKql, isValidTileViz,
  initialConversionState, canAdvance, nextConversionStep, prevConversionStep,
  effectiveDashboardModel, withAppendedTile,
  type ConversionWizardState,
} from '@/lib/azure/kql-tile-conversion';

const BASE: ConversionWizardState = {
  dashboardId: 'dash-1',
  newDashboardName: '',
  viz: 'timechart',
  title: 'Events per hour',
  size: 'medium',
  kql: 'Events | summarize count() by bin(Timestamp, 1h)',
};

describe('wizard state machine', () => {
  it('initial state targets a new dashboard seeded from the source name + query', () => {
    const s = initialConversionState('Events | take 10', 'Telemetry DB');
    expect(s.dashboardId).toBe('__new__');
    expect(s.newDashboardName).toBe('Telemetry DB dashboard');
    expect(s.kql).toBe('Events | take 10');
    expect(s.viz).toBe('table');
    expect(s.size).toBe('medium');
  });

  it('target step requires a dashboard pick — and a name when creating new', () => {
    expect(canAdvance('target', { ...BASE, dashboardId: '' }).ok).toBe(false);
    expect(canAdvance('target', { ...BASE, dashboardId: '__new__', newDashboardName: '  ' }).ok).toBe(false);
    expect(canAdvance('target', { ...BASE, dashboardId: '__new__', newDashboardName: 'My dash' }).ok).toBe(true);
    expect(canAdvance('target', BASE).ok).toBe(true);
  });

  it('visual step requires a valid tile viz', () => {
    expect(canAdvance('visual', BASE).ok).toBe(true);
    expect(canAdvance('visual', { ...BASE, viz: 'sparkline' as any }).ok).toBe(false);
  });

  it('details step requires a non-blank title', () => {
    expect(canAdvance('details', { ...BASE, title: '   ' }).ok).toBe(false);
    expect(canAdvance('details', BASE).ok).toBe(true);
  });

  it('review step re-checks the query (empty / mgmt command rejected)', () => {
    expect(canAdvance('review', BASE).ok).toBe(true);
    expect(canAdvance('review', { ...BASE, kql: '' }).ok).toBe(false);
    expect(canAdvance('review', { ...BASE, kql: '.show tables' }).ok).toBe(false);
  });

  it('next/prev walk the four steps in order and stop at the ends', () => {
    expect(CONVERSION_WIZARD_STEPS).toEqual(['target', 'visual', 'details', 'review']);
    expect(nextConversionStep('target')).toBe('visual');
    expect(nextConversionStep('details')).toBe('review');
    expect(nextConversionStep('review')).toBeNull();
    expect(prevConversionStep('target')).toBeNull();
    expect(prevConversionStep('review')).toBe('details');
  });
});

describe('kql structural check + geometry', () => {
  it('rejects empty, mgmt, and oversized queries', () => {
    expect(checkTileKql('   ').ok).toBe(false);
    expect(checkTileKql('.create table T (x: long)').ok).toBe(false);
    expect(checkTileKql('x'.repeat(70_000)).ok).toBe(false);
    expect(checkTileKql('Events | take 10').ok).toBe(true);
  });

  it('size presets stay inside the dashboard grid (w 1..12, h 1..8)', () => {
    for (const s of TILE_SIZES) {
      expect(s.w).toBeGreaterThanOrEqual(1);
      expect(s.w).toBeLessThanOrEqual(12);
      expect(s.h).toBeGreaterThanOrEqual(1);
      expect(s.h).toBeLessThanOrEqual(8);
    }
    expect(geometryForSize('wide')).toEqual({ w: 12, h: 3 });
    expect(geometryForSize('nonsense')).toEqual({ w: 6, h: 3 }); // medium fallback
    expect(geometryForSize(undefined)).toEqual({ w: 6, h: 3 });
  });

  it('isValidTileViz accepts the dashboard tile model set only', () => {
    for (const v of ['table', 'timechart', 'line', 'bar', 'column', 'pie', 'stat', 'map']) {
      expect(isValidTileViz(v)).toBe(true);
    }
    expect(isValidTileViz('donut')).toBe(false);
    expect(isValidTileViz(undefined)).toBe(false);
  });
});

describe('dashboard-model append', () => {
  const TILE = { title: 'T', kql: 'Events | take 5', viz: 'table' as const, w: 6, h: 3 };

  it('appends the tile and creates a data source resolving the database', () => {
    const model = effectiveDashboardModel({ tiles: [{ title: 'Old', kql: 'Old | take 1', viz: 'stat' }] });
    const next = withAppendedTile(model, TILE, 'TelemetryDB');
    expect(next.tiles).toHaveLength(2);
    const added = next.tiles[1];
    expect(added.title).toBe('T');
    expect(added.kql).toBe('Events | take 5');
    expect(added.viz).toBe('table');
    expect(added.w).toBe(6);
    expect(added.h).toBe(3);
    expect(added.dataSourceId).toBeTruthy();
    const ds = next.dataSources.find((d) => d.id === added.dataSourceId);
    expect(ds?.database).toBe('TelemetryDB');
  });

  it('reuses an existing data source with the same database (no duplicates)', () => {
    const model = effectiveDashboardModel({
      tiles: [{ title: 'Old', kql: 'Old | take 1', viz: 'table', dataSourceId: 'ds-1' }],
      dataSources: [{ id: 'ds-1', name: 'Telemetry', database: 'TelemetryDB' }],
    });
    const next = withAppendedTile(model, TILE, 'TelemetryDB');
    expect(next.dataSources).toHaveLength(1);
    expect(next.tiles[1].dataSourceId).toBe('ds-1');
  });

  it('materializes a bundle dashboard\'s starter content tiles before appending (never shadows them)', () => {
    const state = {
      content: {
        kind: 'kql-dashboard',
        tiles: [
          { title: 'Starter A', kql: 'A | take 1', viz: 'card' },
          { title: 'Starter B', kql: 'B | take 1', viz: 'line' },
        ],
      },
    };
    const model = effectiveDashboardModel(state);
    expect(model.tiles).toHaveLength(2);
    expect(model.tiles[0].viz).toBe('stat'); // bundle 'card' → stat
    const next = withAppendedTile(model, TILE, 'TelemetryDB');
    expect(next.tiles.map((t) => t.title)).toEqual(['Starter A', 'Starter B', 'T']);
  });

  it('saved tiles take precedence over content (mirror of the read route)', () => {
    const state = {
      tiles: [{ title: 'Saved', kql: 'S | take 1', viz: 'table' }],
      content: { kind: 'kql-dashboard', tiles: [{ title: 'Starter', kql: 'A | take 1', viz: 'table' }] },
    };
    const model = effectiveDashboardModel(state);
    expect(model.tiles.map((t) => t.title)).toEqual(['Saved']);
  });
});
