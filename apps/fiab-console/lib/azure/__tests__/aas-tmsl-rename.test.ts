/**
 * Unit tests for the model-structure Copilot's pure TMSL builders
 * (rename measure + set measure description). These functions are dependency
 * free (no @azure/identity / network), so they unit-test directly.
 */
import { describe, it, expect } from 'vitest';
import {
  buildRenameMeasureTmsl,
  buildSetMeasureDescriptionTmsl,
} from '../aas-tmsl';

describe('buildRenameMeasureTmsl', () => {
  it('emits a TMSL rename command targeting the measure with the new name', () => {
    const json = JSON.parse(
      buildRenameMeasureTmsl({ database: 'SalesModel', tableName: 'Measures', fromName: 'fn_Total', toName: 'Total Sales' }),
    );
    expect(json.rename).toBeTruthy();
    expect(json.rename.object).toEqual({ database: 'SalesModel', table: 'Measures', measure: 'fn_Total' });
    expect(json.rename.newName).toBe('Total Sales');
  });
});

describe('buildSetMeasureDescriptionTmsl', () => {
  it('emits a TMSL alter command that sets the measure description only', () => {
    const json = JSON.parse(
      buildSetMeasureDescriptionTmsl({ database: 'SalesModel', tableName: 'Measures', measureName: 'Total Sales', description: 'Sum of order amounts.' }),
    );
    expect(json.alter).toBeTruthy();
    expect(json.alter.object).toEqual({ database: 'SalesModel', table: 'Measures', measure: 'Total Sales' });
    expect(json.alter.measure).toEqual({ name: 'Total Sales', description: 'Sum of order amounts.' });
    // alter must NOT carry an expression (description-only change)
    expect(json.alter.measure.expression).toBeUndefined();
  });
});
