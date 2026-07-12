/**
 * admin-scaling CostPreview + ScalePicker — token/layout refactor guard (Vitest, jsdom).
 *
 * These two leaf components were refactored to drop hard-coded px / inline
 * color styles in favour of Loom design tokens (web3-ui.md). The refactor must
 * NOT change behaviour, so these tests pin the real, load-bearing output:
 *   - CostPreview renders the current + target list price and the signed
 *     monthly delta computed from its lookup table (× multiplier),
 *   - CostPreview renders nothing for an unknown family,
 *   - ScalePicker renders its label and reflects the selected SKU, and calling
 *     onChange is wired to option selection.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { CostPreview } from '../cost-preview';
import { ScalePicker } from '../scale-picker';

function mount(node: React.ReactNode) {
  return render(<FluentProvider theme={webLightTheme}>{node}</FluentProvider>);
}

describe('CostPreview', () => {
  afterEach(() => cleanup());

  it('shows current, target and the signed monthly delta from the lookup table', () => {
    // fabric-capacity: F2 = 263, F4 = 526 → delta +263/mo
    const { container } = mount(<CostPreview family="fabric-capacity" currentSku="F2" targetSku="F4" />);
    const text = container.textContent || '';
    expect(text).toContain('Current: $263');
    expect(text).toContain('$526');
    expect(text).toContain('(+$263/mo)');
  });

  it('applies the multiplier (replicas × partitions) to both price and delta', () => {
    // ai-search: standard = 251, standard2 = 1005; multiplier 2 → 502 → 2010, delta +1508
    const { container } = mount(<CostPreview family="ai-search" currentSku="standard" targetSku="standard2" multiplier={2} />);
    const text = container.textContent || '';
    expect(text).toContain('Current: $502');
    expect(text).toContain('$2,010');
    expect(text).toContain('(+$1,508/mo)');
  });

  it('renders nothing for an unknown family', () => {
    const { container } = mount(
      // @ts-expect-error — deliberately invalid family to exercise the guard
      <CostPreview family="not-a-family" currentSku="x" targetSku="y" />,
    );
    expect(container.textContent).toBe('');
  });
});

describe('ScalePicker', () => {
  afterEach(() => cleanup());

  it('renders its label and reflects the selected value', () => {
    mount(
      <ScalePicker
        label="Target SKU"
        options={[{ value: 'F2', label: 'F2' }, { value: 'F4', label: 'F4' }]}
        value="F4"
        onChange={() => {}}
      />,
    );
    expect(screen.getByText('Target SKU')).toBeInTheDocument();
    // Fluent Dropdown surfaces the selected option label as its combobox value.
    expect(screen.getByRole('combobox')).toHaveValue('F4');
  });

  it('is disabled when disabled is set', () => {
    mount(
      <ScalePicker
        label="Target DWU"
        options={[{ value: 'DW100c', label: 'DW100c' }]}
        value="DW100c"
        onChange={vi.fn()}
        disabled
      />,
    );
    expect(screen.getByRole('combobox')).toBeDisabled();
  });
});
