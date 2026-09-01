/**
 * #4243 — the preview drift token and its ONE sanctioned comparator.
 *
 * Moved from pause-orchestrator.test.ts when the token layer was extracted to
 * `../pause-drift-token` (monolith split, 2026-08-31) — the test sits opposite
 * the module it names, same as the pause-actuator extraction.
 *
 * The invariant under test: a "the set changed" refusal exists ONLY on a
 * positively-observed change. Read failures — the live 2026-08-31 incident's
 * mechanism — refuse with RETRY, never with a drift claim (deploy-integrity R7).
 */
import { describe, it, expect } from 'vitest';
import { evaluateDrift, parsePreviewToken, previewToken } from '../pause-drift-token';

describe('#4243 previewToken / parsePreviewToken — stable under throttled reads', () => {
  const MANIFEST = ['/subscriptions/s/resourceGroups/r/providers/Microsoft.Kusto/clusters/adx',
    '/subscriptions/s/resourceGroups/r/providers/Microsoft.Synapse/workspaces/w/sqlPools/p'];

  it('is computed over the MANIFEST population — a read failure that shrinks the established set does not change the m-part', () => {
    const clean = previewToken({ manifestIds: MANIFEST, establishedIds: MANIFEST, readFailures: 0 });
    const throttled = previewToken({ manifestIds: MANIFEST, establishedIds: [MANIFEST[0]], readFailures: 1 });
    expect(parsePreviewToken(clean)!.manifestDigest).toBe(parsePreviewToken(throttled)!.manifestDigest);
    // The tokens DO differ — via the f-count and p-part, which the comparator
    // treats as "degraded", never as "the estate changed".
    expect(clean).not.toBe(throttled);
  });

  it('is order- and case-insensitive over the SET, like ARM ids', () => {
    const a = previewToken({ manifestIds: [MANIFEST[0], MANIFEST[1]], establishedIds: MANIFEST, readFailures: 0 });
    const b = previewToken({
      manifestIds: [MANIFEST[1].toUpperCase(), MANIFEST[0]],
      establishedIds: [...MANIFEST].reverse(),
      readFailures: 0,
    });
    expect(a).toBe(b);
  });

  it('round-trips through parsePreviewToken; the legacy count:hash shape parses as null (stale, not drift)', () => {
    const t = previewToken({ manifestIds: MANIFEST, establishedIds: [MANIFEST[0]], readFailures: 2 });
    const p = parsePreviewToken(t)!;
    expect(p.manifestCount).toBe(2);
    expect(p.establishedCount).toBe(1);
    expect(p.readFailures).toBe(2);
    expect(parsePreviewToken('2:abcd1234')).toBeNull();
    expect(parsePreviewToken('')).toBeNull();
    expect(parsePreviewToken(undefined)).toBeNull();
  });

  it('a NON-STRING value parses as null (stale), never throws — the token is untrusted JSON (review round 1)', () => {
    // Measured: {"confirmToken": 5} crashed `.trim()` into a generic 500 with
    // zero audit rows. The guard sends it to the audited stale-token refusal.
    expect(parsePreviewToken(5 as never)).toBeNull();
    expect(parsePreviewToken({} as never)).toBeNull();
    expect(parsePreviewToken(null)).toBeNull();
    expect(parsePreviewToken(true as never)).toBeNull();
  });
});

describe('#4243 evaluateDrift — the three-way split the live incident demanded', () => {
  const M = ['/subscriptions/s/resourceGroups/r/providers/Microsoft.Kusto/clusters/adx',
    '/subscriptions/s/resourceGroups/r/providers/Microsoft.Synapse/workspaces/w/sqlPools/p'];
  const fail = (id: string, throttled: boolean) => ({
    resourceId: id,
    name: id.split('/').pop()!,
    error: throttled ? 'ARM GET x was throttled (429) and stayed throttled after 3 attempt(s).' : 'ARM GET x failed 403: forbidden',
    kind: (throttled ? 'throttled' : 'unreachable') as 'throttled' | 'unreachable',
    throttled,
  });
  const cleanToken = previewToken({ manifestIds: M, establishedIds: M, readFailures: 0 });

  it('UNCHANGED estate, clean reads both sides -> proceed', () => {
    expect(evaluateDrift({ confirmToken: cleanToken, manifestIds: M, establishedIds: M, readFailures: [] }))
      .toEqual({ kind: 'proceed' });
  });

  it('THE LIVE SHAPE: clean preview + a throttled POST-time read over an UNCHANGED estate -> reads-failed, NEVER set-changed', () => {
    // Deleting the reads-failed guard (comparing hashes anyway) turns this
    // exact input into a false "set-changed" — the manufactured 409 of #4243.
    const v = evaluateDrift({
      confirmToken: cleanToken,
      manifestIds: M,
      establishedIds: [M[0]], // the throttled resource dropped out
      readFailures: [fail(M[1], true)],
    });
    expect(v.kind).toBe('reads-failed');
  });

  it('a DEGRADED preview confirmed against a now-clean estate -> preview-degraded, never set-changed', () => {
    const degraded = previewToken({ manifestIds: M, establishedIds: [M[0]], readFailures: 1 });
    const v = evaluateDrift({ confirmToken: degraded, manifestIds: M, establishedIds: M, readFailures: [] });
    expect(v.kind).toBe('preview-degraded');
  });

  it('REAL drift — both sides fully read, membership genuinely differs -> set-changed', () => {
    const preview = previewToken({ manifestIds: M, establishedIds: [M[0]], readFailures: 0 });
    const v = evaluateDrift({ confirmToken: preview, manifestIds: M, establishedIds: M, readFailures: [] });
    expect(v).toEqual({ kind: 'set-changed', confirmedCount: 1, currentCount: 2 });
  });

  it('a MANIFEST change is positively observed even under total read failure', () => {
    // The same comparison covers a 404-absent resource REAPPEARING between the
    // preview and the POST: the m-part is "deploy-named minus positively
    // absent", so an appearance moves it — a positive observation both times.
    const oldDeploy = previewToken({ manifestIds: [M[0]], establishedIds: [M[0]], readFailures: 0 });
    const v = evaluateDrift({
      confirmToken: oldDeploy,
      manifestIds: M,
      establishedIds: [],
      readFailures: [fail(M[0], true), fail(M[1], true)],
    });
    expect(v).toEqual({ kind: 'manifest-changed', confirmedCount: 1, currentCount: 2 });
  });

  it('no token / stale token are their own refusals, never drift', () => {
    expect(evaluateDrift({ confirmToken: undefined, manifestIds: M, establishedIds: M, readFailures: [] }).kind)
      .toBe('no-token');
    expect(evaluateDrift({ confirmToken: '2:deadbeef', manifestIds: M, establishedIds: M, readFailures: [] }).kind)
      .toBe('stale-token');
  });
});
