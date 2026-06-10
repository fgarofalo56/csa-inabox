/**
 * aas-measure-structure (audit-T82) — unit tests for the pure measure-structure
 * TMSL builders used by the Copilot model-structure pane:
 *   buildRenameMeasureTmsl, buildSetMeasureDescriptionTmsl, buildSetTableDescriptionTmsl.
 *
 * These are network-free pure functions. They run only on the opt-in XMLA
 * backend; the Azure-native DEFAULT path (Cosmos model store) is exercised by
 * the route. No mocks here — just shape assertions on the emitted TMSL.
 */
import { describe, it, expect, vi } from 'vitest';

// aas-client.ts statically imports @azure/identity; stub it so the pure TMSL
// builders are importable without the credential ESM chain (mirrors aas-client.test.ts).
vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import {
  buildRenameMeasureTmsl,
  buildSetMeasureDescriptionTmsl,
  buildSetTableDescriptionTmsl,
} from '../aas-client';

describe('buildRenameMeasureTmsl', () => {
  it('puts the OLD name in object.measure and the NEW name in measure.name, carrying the expression forward', () => {
    const cmd = buildRenameMeasureTmsl('loomdb', 'Measures', 'Tot Sales', 'Total Sales', 'SUM(Sales[Amount])');
    expect(cmd.alter.object).toEqual({ database: 'loomdb', table: 'Measures', measure: 'Tot Sales' });
    expect(cmd.alter.measure.name).toBe('Total Sales');
    expect(cmd.alter.measure.expression).toBe('SUM(Sales[Amount])');
  });

  it('includes optional description / formatString / displayFolder only when provided', () => {
    const cmd = buildRenameMeasureTmsl('db', 't', 'a', 'b', 'EXPR', { description: 'desc', formatString: '0.00' });
    expect(cmd.alter.measure.description).toBe('desc');
    expect(cmd.alter.measure.formatString).toBe('0.00');
    expect(cmd.alter.measure).not.toHaveProperty('displayFolder');
  });
});

describe('buildSetMeasureDescriptionTmsl', () => {
  it('sets a trimmed description and keeps the measure name + expression', () => {
    const cmd = buildSetMeasureDescriptionTmsl('db', 'Measures', 'Revenue', 'SUM(F[R])', '  total revenue  ');
    expect(cmd.alter.object.measure).toBe('Revenue');
    expect(cmd.alter.measure.name).toBe('Revenue');
    expect(cmd.alter.measure.expression).toBe('SUM(F[R])');
    expect(cmd.alter.measure.description).toBe('total revenue');
  });

  it('omits description when blank (clears it via Alter)', () => {
    const cmd = buildSetMeasureDescriptionTmsl('db', 't', 'M', 'EXPR', '   ');
    expect(cmd.alter.measure).not.toHaveProperty('description');
  });
});

describe('buildSetTableDescriptionTmsl', () => {
  it('alters the table description', () => {
    const cmd = buildSetTableDescriptionTmsl('db', 'DimDate', 'Calendar dimension');
    expect(cmd.alter.object).toEqual({ database: 'db', table: 'DimDate' });
    expect(cmd.alter.table.name).toBe('DimDate');
    expect(cmd.alter.table.description).toBe('Calendar dimension');
  });

  it('omits description when undefined', () => {
    const cmd = buildSetTableDescriptionTmsl('db', 'DimDate', undefined);
    expect(cmd.alter.table).not.toHaveProperty('description');
  });
});
