import { describe, expect, it } from 'vitest';
import { compatibilityMatrix, permits } from '../permits';
import { seedCatalog } from '../seed';
import { updateEnvironment } from '../catalog';

const cat = seedCatalog('t');
const S = { requireClassification: false, environments: cat.environments };
const REQ = { ...S, requireClassification: true };

describe('permits()', () => {
  it('Production gateway x Unclassified endpoint is blocked (breaks if unclassified resolves to allowed or warning)', () => {
    const v = permits('production', null, S);
    expect(v.level).toBe('blocked');
    expect(v.message).toContain('Production');
  });

  it('Production gateway x Development is blocked, but Production x Production is allowed', () => {
    expect(permits('production', 'development', S).level).toBe('blocked');
    expect(permits('production', 'production', S).level).toBe('allowed');
  });

  it('Unclassified gateway x Production resource is blocked even with Require classification off', () => {
    expect(permits(null, 'production', S).level).toBe('blocked');
  });

  it('Unclassified x Development: warning when Require classification is off, blocked when on', () => {
    expect(permits(null, 'development', S).level).toBe('warning');
    expect(permits(null, 'development', REQ).level).toBe('blocked');
    expect(permits('development', null, S).level).toBe('warning');
    expect(permits('development', null, REQ).level).toBe('blocked');
  });

  it('an unknown key is blocked on either side, naming the key', () => {
    expect(permits('nope', 'development', S)).toMatchObject({ level: 'blocked' });
    expect(permits('nope', 'development', S).message).toContain('nope');
    expect(permits('development', 'ghost', S).level).toBe('blocked');
  });

  it('an exception turns a cross-environment warning into allowed, one direction only', () => {
    const withExc = updateEnvironment(cat, 'staging', { exceptions: ['test'] });
    if (!withExc.ok) throw new Error(withExc.error);
    const s = { ...S, environments: withExc.doc.environments };
    expect(permits('staging', 'test', S).level).toBe('warning');
    expect(permits('staging', 'test', s).level).toBe('allowed');
    expect(permits('test', 'staging', s).level).toBe('warning');
  });

  it('a production-class environment cannot list a non-production exception', () => {
    const r = updateEnvironment(cat, 'production', { exceptions: ['development'] });
    expect(r.ok).toBe(false);
  });

  it('matrix has (n+1)^2 cells and agrees with permits() cell by cell', () => {
    const m = compatibilityMatrix(S);
    expect(m.cells).toHaveLength(7 * 7);
    for (const c of m.cells) expect(c.verdict).toEqual(permits(c.gatewayEnv, c.resourceEnv, S));
    const cell = m.cells.find((c) => c.gatewayEnv === 'production' && c.resourceEnv === null)!;
    expect(cell.verdict.level).toBe('blocked');
  });
});
