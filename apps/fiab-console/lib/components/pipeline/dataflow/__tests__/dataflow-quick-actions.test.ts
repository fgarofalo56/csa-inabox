import { describe, it, expect } from 'vitest';
import { buildQuickActionTransform } from '../dataflow-quick-actions';

describe('buildQuickActionTransform', () => {
  it('typecast → cast transform with casts + errorHandling', () => {
    const t = buildQuickActionTransform({ action: 'typecast', fromStream: 'derive1', column: 'age', toType: 'integer' });
    expect(t).toEqual({ type: 'cast', settings: { casts: 'age->integer', errorHandling: 'fail' } });
  });

  it('typecast defaults toType to string', () => {
    const t = buildQuickActionTransform({ action: 'typecast', fromStream: 's1', column: 'x' });
    expect(t?.settings.casts).toBe('x->string');
  });

  it('modify → derive transform with identity column expression', () => {
    const t = buildQuickActionTransform({ action: 'modify', fromStream: 's1', column: 'name' });
    expect(t).toEqual({ type: 'derive', settings: { columns: 'name = name' } });
  });

  it('remove → select rule-mode dropping the column', () => {
    const t = buildQuickActionTransform({ action: 'remove', fromStream: 's1', column: 'ssn' });
    expect(t).toEqual({ type: 'select', settings: { mappingMode: 'rule', matchCondition: "name != 'ssn'", nameAs: '$$' } });
  });

  it('returns null when stream or column is missing', () => {
    expect(buildQuickActionTransform({ action: 'modify', fromStream: '', column: 'a' })).toBeNull();
    expect(buildQuickActionTransform({ action: 'modify', fromStream: 's1', column: '   ' })).toBeNull();
  });
});
