/**
 * LOOM BRAIN W10 — the estate id must not drift from the console's (S4).
 *
 * `LOOM_ESTATE_ID` is emitted by NO bicep module — grepping `platform/fiab/bicep`
 * returns zero matches — and `lib/estate/pause-orchestrator.ts#resolveEstateId`
 * SYNTHESIZES `loom:<sub8>:<rg>` when it is unset. So a literal typed into the
 * scan workflow would disagree with whatever the console resolves, and this
 * lane's findings — plus the graph versions it writes with the same id — would
 * land in a Cosmos partition nothing else reads. `auto-bind-by-default.md` §5:
 * the value is produced by the deploy, not typed in.
 *
 * `cli.ts` therefore DUPLICATES the algorithm rather than importing it, because
 * importing `pause-orchestrator` would drag `pause-actuator` and
 * `capacity-preflight` into the CLI's alias-free emit closure. A duplicate that
 * nothing compares is a duplicate that will drift, so this file imports BOTH and
 * asserts they agree across a matrix — including the cases that are easy to get
 * subtly wrong (the RG fallback ORDER, the 8-character prefix, whitespace).
 */

import { describe, expect, it } from 'vitest';
import { resolveScanEstateId } from '../cli';
import { resolveEstateId } from '../../../estate/pause-orchestrator';

const MATRIX: readonly NodeJS.ProcessEnv[] = [
  {},
  { LOOM_ESTATE_ID: 'explicit-wins' },
  { LOOM_ESTATE_ID: '   ' },
  { LOOM_ESTATE_ID: '  padded  ' },
  { LOOM_SUBSCRIPTION_ID: 'abcdef0123456789' },
  { LOOM_ADMIN_RG: 'rg-only' },
  { LOOM_SUBSCRIPTION_ID: 'abcdef0123456789', LOOM_ADMIN_RG: 'rg-csa-loom-admin-centralus' },
  { LOOM_SUBSCRIPTION_ID: 'abcdef0123456789', LOOM_ACA_RG: 'rg-aca' },
  { LOOM_SUBSCRIPTION_ID: 'abcdef0123456789', LOOM_DLZ_RG: 'rg-dlz' },
  // The FALLBACK ORDER is load-bearing: admin beats aca beats dlz. Getting it
  // wrong produces a plausible id that is quietly the wrong partition.
  { LOOM_SUBSCRIPTION_ID: 'abcdef0123456789', LOOM_ADMIN_RG: 'a', LOOM_ACA_RG: 'b', LOOM_DLZ_RG: 'c' },
  { LOOM_SUBSCRIPTION_ID: 'abcdef0123456789', LOOM_ACA_RG: 'b', LOOM_DLZ_RG: 'c' },
  // Short subscription values must not be padded or throw.
  { LOOM_SUBSCRIPTION_ID: 'abc', LOOM_ADMIN_RG: 'rg' },
  { LOOM_SUBSCRIPTION_ID: '  abcdef0123456789  ', LOOM_ADMIN_RG: '  rg  ' },
  { LOOM_ESTATE_ID: '', LOOM_SUBSCRIPTION_ID: 'abcdef0123456789', LOOM_ADMIN_RG: 'rg' },
];

describe('the scan and the console derive the SAME estate id', () => {
  it('has a NON-EMPTY matrix to compare over', () => {
    // A comparison over zero cases is green and blind.
    expect(MATRIX.length).toBeGreaterThanOrEqual(14);
  });

  it.each(MATRIX.map((env, i) => [i, env] as const))('case %i', (_i, env) => {
    expect(resolveScanEstateId(env)).toBe(resolveEstateId(env));
  });

  it('CONTROL: the comparison can FAIL — a wrong prefix length is caught', () => {
    // Without this, two functions that both returned a constant would agree
    // perfectly and this file would prove nothing.
    const env = { LOOM_SUBSCRIPTION_ID: 'abcdef0123456789', LOOM_ADMIN_RG: 'rg' };
    const wrong = `loom:${(env.LOOM_SUBSCRIPTION_ID || '').slice(0, 4)}:${env.LOOM_ADMIN_RG}`;
    expect(wrong).not.toBe(resolveEstateId(env));
    expect(resolveScanEstateId(env)).toBe('loom:abcdef01:rg');
  });

  it('CONTROL: the two functions are genuinely different implementations', () => {
    // If `resolveScanEstateId` were re-exported from pause-orchestrator, every
    // assertion above would be trivially true and the drift risk would be
    // untested rather than absent.
    expect(resolveScanEstateId).not.toBe(resolveEstateId);
  });
});
