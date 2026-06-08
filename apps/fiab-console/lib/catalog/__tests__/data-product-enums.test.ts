import { describe, it, expect } from 'vitest';
import {
  DATA_PRODUCT_TYPES,
  DATA_PRODUCT_AUDIENCES,
  DATA_PRODUCT_TYPE_VALUES,
  DATA_PRODUCT_AUDIENCE_VALUES,
  DATA_PRODUCT_DESCRIPTION_MAX,
  isValidDataProductType,
  isValidAudience,
  dataProductTypeLabel,
  audienceLabel,
} from '../data-product-enums';

describe('data-product enums (Purview Unified Catalog 2026-03-20-preview)', () => {
  it('exposes the 14 real CatalogModelDataProductTypeEnum values', () => {
    expect(DATA_PRODUCT_TYPES).toHaveLength(14);
    // Spot-check exact API values used in the POST body.
    expect(DATA_PRODUCT_TYPE_VALUES).toContain('Master');
    expect(DATA_PRODUCT_TYPE_VALUES).toContain('AnalyticsModel');
    expect(DATA_PRODUCT_TYPE_VALUES).toContain('SemanticModel');
    expect(DATA_PRODUCT_TYPE_VALUES).toContain('MLAITrainingDataSet');
    // No duplicates.
    expect(new Set(DATA_PRODUCT_TYPE_VALUES).size).toBe(14);
  });

  it('exposes exactly the 8 real AudienceEnum values', () => {
    expect(DATA_PRODUCT_AUDIENCES).toHaveLength(8);
    expect(DATA_PRODUCT_AUDIENCE_VALUES).toEqual([
      'DataEngineer', 'BIEngineer', 'DataAnalyst', 'DataScientist',
      'BusinessAnalyst', 'SoftwareEngineer', 'BusinessUser', 'Executive',
    ]);
  });

  it('enforces the 10,000-char description limit constant', () => {
    expect(DATA_PRODUCT_DESCRIPTION_MAX).toBe(10_000);
  });

  it('validates type + audience values', () => {
    expect(isValidDataProductType('Master')).toBe(true);
    expect(isValidDataProductType('NotAType')).toBe(false);
    expect(isValidDataProductType(123 as unknown)).toBe(false);
    expect(isValidAudience('Executive')).toBe(true);
    expect(isValidAudience('CEO')).toBe(false);
  });

  it('maps enum values to friendly labels', () => {
    expect(dataProductTypeLabel('AnalyticsModel')).toBe('Analytics model');
    expect(dataProductTypeLabel(undefined)).toBe('—');
    expect(dataProductTypeLabel('Unmapped')).toBe('Unmapped');
    expect(audienceLabel('BIEngineer')).toBe('BI engineer');
  });
});
