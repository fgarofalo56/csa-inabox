/**
 * Tests for the Loom-native dashboard model + builder source metadata.
 *
 * - The client-safe BUILDER_SOURCE_META MUST match the server-only
 *   BUILDER_SOURCES (same ids + columns + defaults), since the builder UI can't
 *   import the server module (it pulls in @azure/identity).
 * - The synthesizer produces a renderable ReportModel + SampleData that the CoE
 *   <ReportCanvas> / buildVisualData consume unchanged.
 */

import { describe, it, expect, vi } from 'vitest';

// live-bindings.ts pulls in @azure/identity; mock it so importing BUILDER_SOURCES
// for the parity check doesn't load the real credential chain (same pattern as
// report-render/__tests__/live-bindings.test.ts).
vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 't', expiresOnTimestamp: Date.now() + 3_600_000 }; } }
  return { ChainedTokenCredential: Cred, DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred };
});
vi.mock('@/lib/azure/aca-managed-identity', () => ({
  AcaManagedIdentityCredential: class { async getToken() { return { token: 't' }; } },
}));

import {
  BUILDER_SOURCE_META, newDashboardSpec, newTile, validateSpec,
  synthReportModel, synthSampleData, type DashboardSpec,
} from '../dashboard-model';
import { BUILDER_SOURCES } from '../../report-render/live-bindings';
import { buildVisualData } from '../../report-render/visual-data';

describe('builder source metadata parity', () => {
  it('client meta matches server BUILDER_SOURCES by id + columns + defaults', () => {
    const serverById = Object.fromEntries(BUILDER_SOURCES.map((s) => [s.id, s]));
    expect(BUILDER_SOURCE_META.map((s) => s.id).sort()).toEqual(BUILDER_SOURCES.map((s) => s.id).sort());
    for (const meta of BUILDER_SOURCE_META) {
      const server = serverById[meta.id];
      expect(server, `server source ${meta.id}`).toBeTruthy();
      expect(meta.columns).toEqual(server.columns);
      expect(meta.defaultCategory).toBe(server.defaultCategory);
      expect(meta.defaultValue).toBe(server.defaultValue);
      expect(meta.plane).toBe(server.plane);
      expect(meta.requiredRole).toBe(server.requiredRole);
    }
  });
});

describe('validateSpec', () => {
  it('rejects empty + incomplete specs, accepts a complete one', () => {
    expect(validateSpec(newDashboardSpec())).toBeTruthy(); // no name / no tiles
    const spec: DashboardSpec = {
      ...newDashboardSpec(),
      name: 'FinOps',
      tiles: [newTile({ title: 'Spend', visual: 'bar', sourceId: 'cost-by-service', category: 'ServiceName', value: 'PreTaxCost' })],
    };
    expect(validateSpec(spec)).toBeNull();
    // KPI tile needs no category.
    const kpi: DashboardSpec = { ...spec, tiles: [newTile({ title: 'Total', visual: 'kpi', sourceId: 'cost-by-service', value: 'PreTaxCost' })] };
    expect(validateSpec(kpi)).toBeNull();
    // Chart tile missing category is invalid.
    const bad: DashboardSpec = { ...spec, tiles: [newTile({ title: 'x', visual: 'bar', sourceId: 'cost-by-service', value: 'PreTaxCost' })] };
    expect(validateSpec(bad)).toMatch(/category/i);
  });
});

describe('synthReportModel + synthSampleData', () => {
  const spec: DashboardSpec = {
    ...newDashboardSpec(),
    name: 'FinOps overview',
    tiles: [
      newTile({ id: 't1', title: 'Total spend', visual: 'kpi', sourceId: 'cost-by-service', value: 'PreTaxCost' }),
      newTile({ id: 't2', title: 'Spend by service', visual: 'bar', sourceId: 'cost-by-service', category: 'ServiceName', value: 'PreTaxCost' }),
    ],
  };

  it('produces one page with one visual per tile, correct PBIR types', () => {
    const model = synthReportModel(spec);
    expect(model.pages).toHaveLength(1);
    const v = model.pages[0].visuals;
    expect(v).toHaveLength(2);
    expect(v[0].type).toBe('card');
    expect(v[1].type).toBe('clusteredColumnChart');
    // Each tile is its own entity (keyed by tile id).
    expect(v[1].roles.Category?.[0].entity).toBe('t2');
    expect(v[1].roles.Y?.[0].property).toBe('PreTaxCost');
  });

  it('round-trips through buildVisualData to renderable shapes', () => {
    const model = synthReportModel(spec);
    const sample = synthSampleData(spec, {
      'cost-by-service': {
        columns: ['ServiceName', 'PreTaxCost'],
        rows: [
          { ServiceName: 'Storage', PreTaxCost: 100 },
          { ServiceName: 'Compute', PreTaxCost: 250 },
        ],
      },
    });
    const card = buildVisualData(model.pages[0].visuals[0], sample);
    expect(card.kind).toBe('card');
    const bars = buildVisualData(model.pages[0].visuals[1], sample);
    expect(bars.kind).toBe('bars');
    if (bars.kind === 'bars') {
      expect(bars.categories.map((c) => c.label).sort()).toEqual(['Compute', 'Storage']);
    }
  });
});
