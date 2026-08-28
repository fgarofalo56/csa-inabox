/**
 * LOOM BRAIN W10 — the READ boundary for stored finding documents (#3936,
 * review of #4014 S1).
 *
 * ── WHAT THIS SUITE IS FOR, STATED PRECISELY ───────────────────────────────
 * Not "does the validator work". The question this repo's own null-deref
 * incident taught it to ask is **"what INPUT SHAPE has no fixture?"** — because
 * a 22-test suite written FOR a null deref passed 22/22 on the broken code,
 * every one of its fixtures being type-correct.
 *
 * `./fixtures.ts#record` types `suppression` as fully-required and defaults it;
 * every use in `lifecycle.test.ts` and `cosmos-store.test.ts` passes a complete,
 * parseable object. So the two shapes below had ZERO fixtures anywhere in the
 * repository before this file, and each defeats a different property:
 *
 *   (a) `accepted` with NO `suppression` — a TypeError out of `reconcile()`
 *       that kills the lane, every night, permanently.
 *   (b) an UNPARSEABLE `expiresAt` — `Date.parse` gives NaN, the comparison is
 *       false, and the suppression NEVER EXPIRES. Identical in outcome to the
 *       `suppressions-never-expire` mutation arm, reached through DATA rather
 *       than CODE, which is exactly why the 14-arm sweep could not see it.
 *
 * Both are asserted against the SHIPPING read path (`CosmosFindingStore.list`),
 * not only against the validator in isolation — a test of the validator alone
 * would pass even if `list()` never called it, which is the wiring gap that
 * produced the finding in the first place.
 */

import { describe, expect, it } from 'vitest';
import {
  FindingDocumentShapeError,
  validateFindingDocument,
} from '../record-validation';
import { CosmosFindingStore, documentId } from '../cosmos-finding-store';
import { reconcile, suppressionExpired } from '../lifecycle';
import { FINDING_SCHEMA_VERSION, type FindingRecord } from '../model';
import { ESTATE, record } from './fixtures';

/** A minimal fake `Container` that answers `list` from a fixed doc set. */
function storeOver(docs: Record<string, unknown>[]) {
  const container = {
    items: {
      query() {
        return {
          async fetchAll() {
            return { resources: docs };
          },
        };
      },
      async upsert(doc: Record<string, unknown>) {
        return { resource: doc };
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new CosmosFindingStore(async () => container as any);
}

/** A stored document, built from a real record then mutated into a bad shape. */
function docOf(base: FindingRecord, mutate: (d: Record<string, unknown>) => void) {
  const d = { ...(base as unknown as Record<string, unknown>) };
  d.id = documentId(base.fingerprint);
  d.docType = 'finding';
  mutate(d);
  return d;
}

const ACCEPTED = record({ detector: 'unreachable-service', subject: '/a', state: 'accepted' });

describe('SHAPE (a) — `accepted` with no suppression at all', () => {
  it('the fixture library CANNOT express it — which is why it had no fixture', () => {
    // The control for this whole suite. `record({state:'accepted'})` always
    // attaches a complete suppression, so no test written through the fixtures
    // could ever have reached this shape. That is the finding, not an aside.
    expect(ACCEPTED.state).toBe('accepted');
    expect((ACCEPTED as unknown as Record<string, unknown>).suppression).toBeDefined();
  });

  it('the READ path rejects it, naming the document and the field', async () => {
    const store = storeOver([docOf(ACCEPTED, (d) => delete d.suppression)]);
    await expect(store.list(ESTATE)).rejects.toThrow(FindingDocumentShapeError);
    await expect(store.list(ESTATE)).rejects.toThrow(/suppression/);
  });

  it('the schemaVersion guard does NOT catch it — the version is correct', () => {
    // `reconcile()` routes a record on a DIFFERENT schemaVersion to
    // `notEvaluated`. This document carries the CURRENT one, so that guard is
    // not even reached; only a field-level check can see it.
    const d = docOf(ACCEPTED, (x) => delete x.suppression);
    expect(d.schemaVersion).toBe(FINDING_SCHEMA_VERSION);
    expect(() => validateFindingDocument(d, String(d.id))).toThrow(FindingDocumentShapeError);
  });

  it('CONTROL: unvalidated, this shape kills reconcile() with a TypeError', () => {
    // The counterfactual. Without the read boundary the document reaches
    // `reconcile()` as a `FindingRecord`, and `prior.suppression.expiresAt`
    // dereferences undefined — a run that exits 1 and does so again every night
    // until somebody hand-edits Cosmos. This is the behaviour being prevented,
    // asserted so the prevention cannot be quietly removed.
    const broken = docOf(ACCEPTED, (d) => delete d.suppression) as unknown as FindingRecord;
    expect(() =>
      reconcile({
        estateId: ESTATE,
        runId: 'run-1',
        at: '2026-09-01T00:00:00.000Z',
        previous: [broken],
        occurrences: [
          { finding: { ...ACCEPTED } as never, fingerprint: ACCEPTED.fingerprint },
        ],
        evaluatedDetectors: new Set(['unreachable-service']),
      }),
    ).toThrow(TypeError);
  });

  it('a suppression missing only `owner` is rejected too (P-SUP)', async () => {
    const store = storeOver([
      docOf(ACCEPTED, (d) => {
        d.suppression = {
          reason: 'r',
          owner: '   ',
          acceptedAt: '2026-08-01T00:00:00.000Z',
          expiresAt: '2026-12-31T00:00:00.000Z',
        };
      }),
    ]);
    await expect(store.list(ESTATE)).rejects.toThrow(/suppression\.owner/);
  });

  it('a suppression missing only `reason` is rejected too (P-SUP)', async () => {
    const store = storeOver([
      docOf(ACCEPTED, (d) => {
        d.suppression = {
          reason: '',
          owner: 'o',
          acceptedAt: '2026-08-01T00:00:00.000Z',
          expiresAt: '2026-12-31T00:00:00.000Z',
        };
      }),
    ]);
    await expect(store.list(ESTATE)).rejects.toThrow(/suppression\.reason/);
  });
});

describe('SHAPE (b) — an UNPARSEABLE expiresAt, i.e. a suppression that never expires', () => {
  // Every one of these produces NaN from Date.parse. They are the shapes a
  // hand-edit, a migration, or a future writer actually emits.
  const UNPARSEABLE = ['', '   ', 'never', 'forever', 'not-a-date', '2026-13-45T99:99:99Z'];

  it.each(UNPARSEABLE)('the READ path rejects expiresAt=%j', async (bad) => {
    const store = storeOver([
      docOf(ACCEPTED, (d) => {
        d.suppression = {
          reason: 'r',
          owner: 'o',
          acceptedAt: '2026-08-01T00:00:00.000Z',
          expiresAt: bad,
        };
      }),
    ]);
    await expect(store.list(ESTATE)).rejects.toThrow(FindingDocumentShapeError);
  });

  it('the message NAMES the NaN mechanism, not just "invalid"', async () => {
    const store = storeOver([
      docOf(ACCEPTED, (d) => {
        d.suppression = {
          reason: 'r',
          owner: 'o',
          acceptedAt: '2026-08-01T00:00:00.000Z',
          expiresAt: 'never',
        };
      }),
    ]);
    // R7 + R6: the reason an operator needs is WHY this is dangerous, and it is
    // not obvious — an unreadable expiry reads as "not yet expired".
    await expect(store.list(ESTATE)).rejects.toThrow(/NaN/);
    await expect(store.list(ESTATE)).rejects.toThrow(/not yet expired/);
  });

  it('CONTROL: NaN really does compare as "not yet expired"', () => {
    // The mechanism, stated as an executable fact rather than an assertion in a
    // comment. If this ever stops being true the guard above is unnecessary,
    // and this line is what would say so.
    expect(Date.parse('never')).toBeNaN();
    expect(Date.parse('2030-01-01T00:00:00.000Z') >= Date.parse('never')).toBe(false);
  });

  it('BELT: suppressionExpired now THROWS on NaN rather than answering false', () => {
    // Defence in depth, keyed to a different thing than the read boundary: this
    // guards the FUNCTION however it is reached — an in-memory store, a route, a
    // future caller with no read boundary at all.
    expect(() =>
      suppressionExpired(
        { reason: 'r', owner: 'o', acceptedAt: '2026-08-01T00:00:00.000Z', expiresAt: 'never' },
        '2030-01-01T00:00:00.000Z',
      ),
    ).toThrow(/NaN/);
  });

  it('BELT: an unparseable RUN instant also throws — the other operand', () => {
    expect(() =>
      suppressionExpired(
        {
          reason: 'r',
          owner: 'o',
          acceptedAt: '2026-08-01T00:00:00.000Z',
          expiresAt: '2026-12-31T00:00:00.000Z',
        },
        'not-an-instant',
      ),
    ).toThrow(/NaN/);
  });

  it('CONTROL: a PARSEABLE expiry still decides both ways', () => {
    // The guard must not have been implemented by making everything throw.
    const s = {
      reason: 'r',
      owner: 'o',
      acceptedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-12-31T00:00:00.000Z',
    };
    expect(suppressionExpired(s, '2027-01-01T00:00:00.000Z')).toBe(true);
    expect(suppressionExpired(s, '2026-09-01T00:00:00.000Z')).toBe(false);
    // Boundary is inclusive, unchanged.
    expect(suppressionExpired(s, '2026-12-31T00:00:00.000Z')).toBe(true);
  });
});

describe('the rest of the read boundary', () => {
  it('rejects an unrecognised state rather than reconciling against it', async () => {
    const r = record({ detector: 'd', subject: '/a', state: 'new' });
    const store = storeOver([docOf(r, (d) => (d.state = 'archived'))]);
    await expect(store.list(ESTATE)).rejects.toThrow(/state/);
  });

  it('rejects a `new` record carrying a repair history (L1, laundered)', async () => {
    // The persistence-layer form of P-REG. L1 makes this unassignable in TYPE;
    // a document hand-written into Cosmos is not type-checked by anything.
    const r = record({ detector: 'd', subject: '/a', state: 'new' });
    const store = storeOver([
      docOf(r, (d) => {
        d.fixedAt = '2026-08-01T00:00:00.000Z';
      }),
    ]);
    await expect(store.list(ESTATE)).rejects.toThrow(/fixedAt/);
  });

  it('rejects a `new` record with a non-zero regressionCount (L1)', async () => {
    const r = record({ detector: 'd', subject: '/a', state: 'new' });
    const store = storeOver([docOf(r, (d) => (d.regressionCount = 3))]);
    await expect(store.list(ESTATE)).rejects.toThrow(/regressionCount/);
  });

  it("rejects a `regressed` record whose priorState is not 'fixed' (L2)", async () => {
    const r = record({ detector: 'd', subject: '/a', state: 'regressed' });
    const store = storeOver([docOf(r, (d) => (d.priorState = 'acknowledged'))]);
    await expect(store.list(ESTATE)).rejects.toThrow(/priorState/);
  });

  it('rejects a `fixed` record with an unparseable fixedAt', async () => {
    const r = record({ detector: 'd', subject: '/a', state: 'fixed' });
    const store = storeOver([docOf(r, (d) => (d.fixedAt = 'yesterday'))]);
    await expect(store.list(ESTATE)).rejects.toThrow(/fixedAt/);
  });

  it('rejects a missing fingerprint, estateId or detector', () => {
    for (const field of ['fingerprint', 'estateId', 'detector'] as const) {
      const d = docOf(record({ detector: 'd', subject: '/a', state: 'new' }), (x) => {
        x[field] = '';
      });
      expect(() => validateFindingDocument(d, 'f:x'), field).toThrow(new RegExp(field));
    }
  });

  it('does NOT reject a record on an OLDER schemaVersion — reconcile owns that', async () => {
    // Deliberate. `reconcile()` reports those under `notEvaluated` and leaves
    // them UNTOUCHED, which preserves their repair history. Rejecting them here
    // would destroy exactly what that branch protects.
    const r = record({ detector: 'd', subject: '/a', state: 'fixed' });
    const store = storeOver([docOf(r, (d) => (d.schemaVersion = FINDING_SCHEMA_VERSION - 1))]);
    const out = await store.list(ESTATE);
    expect(out).toHaveLength(1);
    expect(out[0].schemaVersion).toBe(FINDING_SCHEMA_VERSION - 1);
  });

  it('rejects a NON-NUMERIC schemaVersion, which is a different thing', async () => {
    const r = record({ detector: 'd', subject: '/a', state: 'fixed' });
    const store = storeOver([docOf(r, (d) => (d.schemaVersion = 'v1'))]);
    await expect(store.list(ESTATE)).rejects.toThrow(/schemaVersion/);
  });

  it('CONTROL: every WELL-FORMED state round-trips unchanged', async () => {
    // The guard must not be passing by rejecting everything. All five states,
    // through the real read path.
    const states = ['new', 'acknowledged', 'accepted', 'fixed', 'regressed'] as const;
    const docs = states.map((state, i) =>
      docOf(record({ detector: `d${i}`, subject: `/s${i}`, state }), () => {}),
    );
    const out = await storeOver(docs).list(ESTATE);
    expect(out.map((r) => r.state).sort()).toEqual([...states].sort());
  });

  it('names the DOCUMENT id, so triage is one look (R6)', () => {
    const d = docOf(ACCEPTED, (x) => delete x.suppression);
    expect(() => validateFindingDocument(d, 'f:the-broken-one')).toThrow(/f:the-broken-one/);
  });

  it('a malformed document is NEVER silently skipped', async () => {
    // The alternative to throwing is dropping, and dropping SHRINKS the backlog
    // with nothing to see it — the dominant evasion class this repo measures. If
    // this ever starts resolving, the population has been quietly reduced.
    const good = record({ detector: 'd', subject: '/good', state: 'new' });
    const bad = record({ detector: 'd', subject: '/bad', state: 'accepted' });
    const store = storeOver([
      docOf(good, () => {}),
      docOf(bad, (d) => delete d.suppression),
    ]);
    await expect(store.list(ESTATE)).rejects.toThrow(FindingDocumentShapeError);
  });
});
