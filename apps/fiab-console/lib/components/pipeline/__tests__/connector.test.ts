import { describe, it, expect } from 'vitest';
import { CONNECTOR_COLORS, type ConnectorCondition } from '../connector';

describe('connector colors', () => {
  it('exposes the four Fabric connector colors', () => {
    const required: ConnectorCondition[] = ['Succeeded', 'Failed', 'Completed', 'Skipped'];
    for (const k of required) expect(CONNECTOR_COLORS[k]).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('uses green for Succeeded and red for Failed', () => {
    expect(CONNECTOR_COLORS.Succeeded.toLowerCase()).toBe('#107c10');
    expect(CONNECTOR_COLORS.Failed.toLowerCase()).toBe('#d13438');
  });
});
