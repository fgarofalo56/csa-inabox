import { describe, it, expect } from 'vitest';
import {
  WAREHOUSE_PERSONA,
  COPILOT_PERSONAS,
  getPersona,
} from '../copilot-personas-sql';

describe('WAREHOUSE_PERSONA', () => {
  it('is registered under the warehouse id', () => {
    expect(getPersona('warehouse')).toBe(WAREHOUSE_PERSONA);
    expect(COPILOT_PERSONAS.warehouse).toBe(WAREHOUSE_PERSONA);
  });

  it('declares T-SQL and the full mode set including optimize', () => {
    expect(WAREHOUSE_PERSONA.dialect).toBe('T-SQL');
    expect(WAREHOUSE_PERSONA.supportedModes).toContain('generate');
    expect(WAREHOUSE_PERSONA.supportedModes).toContain('explain');
    expect(WAREHOUSE_PERSONA.supportedModes).toContain('fix');
    expect(WAREHOUSE_PERSONA.supportedModes).toContain('optimize');
  });

  it('exposes non-empty quick actions with a label and a prompt each', () => {
    expect(WAREHOUSE_PERSONA.quickActions.length).toBeGreaterThan(0);
    for (const qa of WAREHOUSE_PERSONA.quickActions) {
      expect(qa.label.trim().length).toBeGreaterThan(0);
      expect(qa.prompt.trim().length).toBeGreaterThan(0);
    }
  });

  it('includes the "top customers by revenue" acceptance quick action', () => {
    const labels = WAREHOUSE_PERSONA.quickActions.map((q) => q.label.toLowerCase());
    expect(labels.some((l) => l.includes('customers') && l.includes('revenue'))).toBe(true);
  });

  it('grounds the system addendum in MPP / data-movement guidance', () => {
    expect(WAREHOUSE_PERSONA.systemPromptAddendum).toContain('Dedicated SQL pool');
    expect(WAREHOUSE_PERSONA.systemPromptAddendum).toContain('EXPLAIN WITH_RECOMMENDATIONS');
  });

  it('uses unique quick-action labels', () => {
    const labels = WAREHOUSE_PERSONA.quickActions.map((q) => q.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
