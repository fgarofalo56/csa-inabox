import { describe, it, expect } from 'vitest';
import { sanitizePorts, portsSummary, emptyPorts, PORT_KINDS_BY_DIRECTION } from '../ports';

describe('sanitizePorts', () => {
  it('normalizes the structured {input,output,management} shape and constrains kinds', () => {
    const m = sanitizePorts({
      input: [{ name: 'Upstream sales', kind: 'data-product', ref: 'dp-9' }],
      output: [{ name: 'Curated', kind: 'sql-endpoint' }],
      management: [{ name: 'Health', kind: 'health' }],
    });
    expect(portsSummary(m)).toEqual({ input: 1, output: 1, management: 1, total: 3 });
    expect(m.input[0].kind).toBe('data-product');
    expect(m.input[0].ref).toBe('dp-9');
  });

  it('coerces an invalid kind to the first allowed kind for the direction', () => {
    const m = sanitizePorts({ output: [{ name: 'X', kind: 'health' /* not an output kind */ }] });
    expect(m.output[0].kind).toBe(PORT_KINDS_BY_DIRECTION.output[0]);
  });

  it('accepts the legacy flat array (DP-3 wizard) and groups by direction', () => {
    const m = sanitizePorts([
      { name: 'in-a', direction: 'input' },
      { name: 'out-b', direction: 'output' },
      { name: 'no-dir' }, // defaults to output
    ]);
    expect(m.input.map((p) => p.name)).toEqual(['in-a']);
    expect(m.output.map((p) => p.name)).toEqual(['out-b', 'no-dir']);
  });

  it('drops nameless ports and generates stable ids', () => {
    const m = sanitizePorts({ output: [{ name: '' }, { name: 'Keep' }] });
    expect(m.output).toHaveLength(1);
    expect(m.output[0].id).toBeTruthy();
  });

  it('empty input yields an empty model', () => {
    expect(sanitizePorts(undefined)).toEqual(emptyPorts());
  });
});
