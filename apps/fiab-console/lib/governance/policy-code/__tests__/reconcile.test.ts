import { describe, it, expect } from 'vitest';
import { diffOps } from '../reconcile';
import type { CompiledOp } from '../compilers/types';

function op(key: string, undo?: string): CompiledOp {
  return { key, kind: 'grant', statement: `APPLY ${key}`, undo, target: 't', principals: ['p'], from: 's' };
}

describe('reconcile diffOps (pure) — drift self-heal', () => {
  const a = op('k:a', 'UNDO a');
  const b = op('k:b', 'UNDO b');
  const c = op('k:c', 'UNDO c');

  it('applies desired ops that are missing from live (out-of-band drift heals)', () => {
    // Desired a,b; live has only a → b drifted away and must be re-applied.
    const d = diffOps([a, b], new Set(['k:a']), [a, b]);
    expect(d.toApply.map((o) => o.key)).toEqual(['k:b']);
    expect(d.inSync.map((o) => o.key)).toEqual(['k:a']);
    expect(d.toRevoke).toHaveLength(0);
  });

  it('revokes prior-applied ops no longer in the desired set (policy removal)', () => {
    // Prior applied a,b,c; desired now only a → b and c must be revoked.
    const d = diffOps([a], new Set(['k:a', 'k:b', 'k:c']), [a, b, c]);
    expect(d.toApply).toHaveLength(0);
    expect(d.toRevoke.map((o) => o.key).sort()).toEqual(['k:b', 'k:c']);
  });

  it('a fully-converged set has no delta', () => {
    const d = diffOps([a, b], new Set(['k:a', 'k:b']), [a, b]);
    expect(d.toApply).toHaveLength(0);
    expect(d.toRevoke).toHaveLength(0);
    expect(d.inSync).toHaveLength(2);
  });

  it('only revokes ops that carry an inverse (undo)', () => {
    const noUndo = op('k:x'); // no undo
    const d = diffOps([], new Set(['k:x']), [noUndo]);
    expect(d.toRevoke).toHaveLength(0);
  });

  it('a brand-new set applies everything (nothing live yet)', () => {
    const d = diffOps([a, b, c], new Set(), []);
    expect(d.toApply.map((o) => o.key)).toEqual(['k:a', 'k:b', 'k:c']);
    expect(d.toRevoke).toHaveLength(0);
  });
});
