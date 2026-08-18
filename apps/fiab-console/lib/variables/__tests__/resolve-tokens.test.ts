/**
 * `referencedVariableTokens` — the ADVISORY-ONLY reference scanner (#3575).
 *
 * The reported symptom was a Resolve whose output equalled its input with no
 * explanation. One way to reach that state is a reference the expansion regex
 * cannot match at all (`@{variables.Order-Count}`): `referencedVariableNames`
 * never sees it, so nothing was ever reported as unresolved and the user got
 * ZERO signal — issue #3575 verbatim.
 *
 * The fix widens DETECTION only. These specs pin both halves of that contract:
 *
 *   1. the loose scanner sees references the strict one cannot, and correctly
 *      flags which of them expansion could ever substitute; and
 *   2. `expandVariables` / `referencedVariableNames` are UNCHANGED — widening
 *      `VAR_REF` would alter what actually gets substituted in pipelines and
 *      notebooks at runtime, which is precisely what must not happen.
 */
import { describe, it, expect } from 'vitest';
import {
  referencedVariableTokens, referencedVariableNames, expandVariables,
} from '../resolve';

describe('referencedVariableTokens (advisory scanner)', () => {
  it('reports a malformed name the strict regex cannot see, and marks it unsubstitutable', () => {
    const text = '@{variables.Order-Count}/x';
    // The strict scanner — which drives expansion — is blind to it. That
    // blindness IS the bug: no name, no diff, no banner.
    expect(referencedVariableNames(text)).toEqual([]);

    const tokens = referencedVariableTokens(text);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      name: 'Order-Count',
      ref: '@{variables.Order-Count}',
      substitutable: false,
    });
  });

  it('marks well-formed names substitutable and carries the sigil actually written', () => {
    const tokens = referencedVariableTokens('${variables.ENV}/batch?size=@{variables.BatchSize}');
    expect(tokens.map((t) => [t.name, t.ref, t.substitutable])).toEqual([
      ['ENV', '${variables.ENV}', true],
      ['BatchSize', '@{variables.BatchSize}', true],
    ]);
  });

  it('classifies leading-digit, empty and whitespace names as unsubstitutable', () => {
    const tokens = referencedVariableTokens('@{variables.2fa} ${variables.} @{variables.my var}');
    expect(tokens.map((t) => [t.name, t.substitutable])).toEqual([
      ['2fa', false],
      ['', false],
      ['my var', false],
    ]);
  });

  it('keeps duplicates in source order (callers de-duplicate on their own key)', () => {
    expect(referencedVariableTokens('@{variables.X}@{variables.X}').map((t) => t.name))
      .toEqual(['X', 'X']);
  });

  it('is stateless across calls despite the module-level /g regex', () => {
    const text = '@{variables.ENV}';
    expect(referencedVariableTokens(text)).toHaveLength(1);
    expect(referencedVariableTokens(text)).toHaveLength(1);
  });

  // ---- RUNTIME BEHAVIOUR MUST NOT MOVE -----------------------------------
  // Measured at this commit, `expandVariables` has exactly ONE production
  // caller: app/api/items/variable-library/[id]/resolve/route.ts. No executor
  // reaches it today — `lib/install/pipeline-variables.ts` promotes a different
  // `{{var:NAME}}` token via `rawValueForSet`. So the blast radius of a widened
  // VAR_REF is currently that one route's `expanded` output, not the pipeline
  // and notebook runtimes.
  //
  // The guard is still the right one to keep: `expandVariables` is exported as
  // the shared substitution primitive precisely so executors CAN adopt it, and
  // these specs mean a widened regex cannot silently change what it substitutes
  // if they do.
  it('expandVariables still leaves a malformed reference verbatim even when a value is supplied', () => {
    expect(expandVariables('@{variables.Order-Count}/x', { 'Order-Count': '42' }))
      .toBe('@{variables.Order-Count}/x');
  });

  it('expandVariables still substitutes both sigils for well-formed names', () => {
    expect(expandVariables('${variables.ENV}/@{variables.N}', { ENV: 'dev', N: '5' }))
      .toBe('dev/5');
  });

  it('expandVariables still leaves an unknown well-formed reference verbatim', () => {
    expect(expandVariables('@{variables.Nope}', { ENV: 'dev' })).toBe('@{variables.Nope}');
  });
});
