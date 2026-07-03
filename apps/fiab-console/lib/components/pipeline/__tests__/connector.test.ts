import { describe, it, expect } from 'vitest';
import { tokens } from '@fluentui/react-components';
import { CONNECTOR_COLORS, type ConnectorCondition } from '../connector';

// Per web3-ui.md, connector edge colors are Loom/Fluent design tokens
// (`tokens.colorPalette*`), NOT hard-coded hex — so the SVG strokes track the
// theme (green ≈ #107c10 in the default theme, resolved from the CSS variable).
describe('connector colors', () => {
  it('exposes a design-token color for each of the four Fabric conditions', () => {
    const required: ConnectorCondition[] = ['Succeeded', 'Failed', 'Completed', 'Skipped'];
    for (const k of required) expect(CONNECTOR_COLORS[k]).toBeTruthy();
  });

  it('uses the green token for Succeeded and the red token for Failed', () => {
    expect(CONNECTOR_COLORS.Succeeded).toBe(tokens.colorPaletteGreenForeground1);
    expect(CONNECTOR_COLORS.Failed).toBe(tokens.colorPaletteRedForeground1);
  });
});
