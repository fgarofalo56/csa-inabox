/**
 * The recommendation-state store (#4242): decision persistence (the
 * decision-amnesia fix) + the staged two-step confirm.
 *
 * Runs against an in-memory Cosmos container fake injected through the store's
 * constructor seam, so every property here — single-use tokens, expiry, the
 * raw token never being stored — is proven without a tenant.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Container } from '@azure/cosmos';
import {
  BrainActionsNotConfiguredError,
  RecommendationStateStore,
  resetRecommendationStateClient,
  STAGED_CONFIRM_TTL_MS,
  stateDocumentId,
} from '../state-store';
import { FINDING_ID, NODE_ID } from './fixtures';

const ACTOR = { oid: 'oid-1', upn: 'admin@example.test' };
const DETECTOR = 'unreachable-always-on';

/** In-memory stand-in for the Cosmos container surface the store uses —
 * including `_etag` versioning and IfMatch-conditioned `item().replace`, so
 * the optimistic-concurrency consume path is exercised for real. */
class FakeContainer {
  docs = new Map<string, Record<string, unknown>>();
  private etagCounter = 0;
  /** Test hook: runs between a replace's IfMatch check being SET UP by the
   * caller (its earlier read) and the write — bump the etag here to simulate
   * a concurrent writer landing in the read→replace window. */
  onBeforeReplace: (() => void) | null = null;

  private stamp(doc: Record<string, unknown>): Record<string, unknown> {
    this.etagCounter += 1;
    return { ...(JSON.parse(JSON.stringify(doc)) as Record<string, unknown>), _etag: `etag-${this.etagCounter}` };
  }

  /** Simulate an out-of-band concurrent write: same body, NEW etag. */
  bumpEtag(id: string): void {
    const doc = this.docs.get(id);
    if (doc) this.docs.set(id, this.stamp(doc));
  }

  items = {
    upsert: async (doc: Record<string, unknown>) => {
      this.docs.set(String(doc.id), this.stamp(doc));
      return { resource: doc };
    },
    query: (spec: { query: string; parameters: { name: string; value: unknown }[] }) => ({
      fetchAll: async () => {
        const p = Object.fromEntries(spec.parameters.map((x) => [x.name, x.value]));
        let all = [...this.docs.values()].filter(
          (d) => d.estateId === p['@estateId'] && d.docType === p['@docType'],
        );
        if (p['@findingId'] !== undefined) {
          all = all.filter((d) => d.findingId === p['@findingId']);
        }
        return { resources: all };
      },
    }),
  };

  item = (id: string, _pk: string) => ({
    replace: async (
      body: Record<string, unknown>,
      opts?: { accessCondition?: { type: string; condition: string } },
    ) => {
      this.onBeforeReplace?.();
      const current = this.docs.get(id);
      const cond = opts?.accessCondition;
      if (cond?.type === 'IfMatch' && current && current._etag !== cond.condition) {
        const err = new Error('precondition failed') as Error & { code: number };
        err.code = 412;
        throw err;
      }
      this.docs.set(id, this.stamp(body));
      return { resource: body };
    },
  });
}

let fake: FakeContainer;
let store: RecommendationStateStore;

beforeEach(() => {
  fake = new FakeContainer();
  store = new RecommendationStateStore(async () => fake as unknown as Container);
});

describe('decision persistence — the decision-amnesia fix', () => {
  it('a recorded approval survives a re-read', async () => {
    await store.recordDecision(FINDING_ID, 'approved', ACTOR, 'agreed');
    const states = await store.read();
    expect(states).toHaveLength(1);
    expect(states[0]!.findingId).toBe(FINDING_ID);
    expect(states[0]!.state).toBe('approved');
    expect(states[0]!.note).toBe('agreed');
    expect(states[0]!.actorOid).toBe('oid-1');
  });

  it('a dismissal overwrites an approval for the same finding (one doc per finding)', async () => {
    await store.recordDecision(FINDING_ID, 'approved', ACTOR);
    await store.recordDecision(FINDING_ID, 'dismissed', ACTOR);
    const states = await store.read(FINDING_ID);
    expect(states).toHaveLength(1);
    expect(states[0]!.state).toBe('dismissed');
  });

  it('the document id is reversible, not a hash', () => {
    expect(stateDocumentId(FINDING_ID).startsWith('rs:')).toBe(true);
    // Two distinct findings can never share a document.
    expect(stateDocumentId('a')).not.toBe(stateDocumentId('b'));
  });
});

describe('the staged two-step confirm', () => {
  it('stage mints a bounded token and the RAW token is never stored', async () => {
    const { confirmToken, expiresAt } = await store.stage(FINDING_ID, DETECTOR, NODE_ID, ACTOR);
    expect(confirmToken.length).toBeGreaterThanOrEqual(32);
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(STAGED_CONFIRM_TTL_MS + 1000);

    const doc = fake.docs.get(stateDocumentId(FINDING_ID))!;
    expect(doc.state).toBe('staged');
    // THE PROPERTY: a read of the store cannot mint a confirmation. The
    // document carries the SHA-256, never the token.
    expect(JSON.stringify(doc)).not.toContain(confirmToken);
    expect((doc.staging as { tokenSha256: string }).tokenSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the right token consumes exactly ONCE — a replay refuses', async () => {
    const { confirmToken } = await store.stage(FINDING_ID, DETECTOR, NODE_ID, ACTOR);

    const first = await store.consumeStagedToken(FINDING_ID, DETECTOR, NODE_ID, confirmToken, ACTOR);
    expect(first).toBeNull();

    const replay = await store.consumeStagedToken(FINDING_ID, DETECTOR, NODE_ID, confirmToken, ACTOR);
    expect(replay).not.toBeNull();
    expect(replay!.guard).toBe('staged-confirm');
    expect(replay!.reason).toContain('no live staging');
  });

  it('a WRONG token refuses and does not consume the staging', async () => {
    const { confirmToken } = await store.stage(FINDING_ID, DETECTOR, NODE_ID, ACTOR);

    const bad = await store.consumeStagedToken(FINDING_ID, DETECTOR, NODE_ID, 'forged-token', ACTOR);
    expect(bad).not.toBeNull();
    expect(bad!.reason).toContain('does not match');

    // The real token still works — the forgery did not burn the staging.
    expect(await store.consumeStagedToken(FINDING_ID, DETECTOR, NODE_ID, confirmToken, ACTOR)).toBeNull();
  });

  it('an EXPIRED staging refuses — stale re-affirmations are re-staged, never honoured', async () => {
    const { confirmToken } = await store.stage(FINDING_ID, DETECTOR, NODE_ID, ACTOR);
    const doc = fake.docs.get(stateDocumentId(FINDING_ID))!;
    (doc.staging as { expiresAt: string }).expiresAt = new Date(Date.now() - 1000).toISOString();

    const out = await store.consumeStagedToken(FINDING_ID, DETECTOR, NODE_ID, confirmToken, ACTOR);
    expect(out).not.toBeNull();
    expect(out!.reason).toContain('expired');
  });

  it('a token authorizes EXACTLY the change it staged — detector/subject mismatch refuses', async () => {
    const { confirmToken } = await store.stage(FINDING_ID, DETECTOR, NODE_ID, ACTOR);

    const wrongDetector = await store.consumeStagedToken(FINDING_ID, 'orphan', NODE_ID, confirmToken, ACTOR);
    expect(wrongDetector).not.toBeNull();
    expect(wrongDetector!.reason).toContain('does not match this request');

    const wrongSubject = await store.consumeStagedToken(
      FINDING_ID,
      DETECTOR,
      'azure:/subscriptions/x/resourcegroups/y/providers/microsoft.app/containerapps/other',
      confirmToken,
      ACTOR,
    );
    expect(wrongSubject).not.toBeNull();
  });

  it('CONCURRENT consumes: the etag arbitrates and exactly one wins (#4246 should-fix)', async () => {
    const { confirmToken } = await store.stage(FINDING_ID, DETECTOR, NODE_ID, ACTOR);

    // Simulate the race: a concurrent writer lands INSIDE this consume's
    // read→replace window (the fake bumps the etag just before the replace).
    // Without the IfMatch condition both consumes would write and both would
    // execute — "single-use" only serially, which is what the review measured.
    fake.onBeforeReplace = () => {
      fake.bumpEtag(stateDocumentId(FINDING_ID));
      fake.onBeforeReplace = null; // one interleave, then the world is quiet
    };
    const lost = await store.consumeStagedToken(FINDING_ID, DETECTOR, NODE_ID, confirmToken, ACTOR);
    expect(lost).not.toBeNull();
    expect(lost!.guard).toBe('staged-confirm');
    expect(lost!.reason).toContain('concurrently');
    expect(lost!.reason).toContain('executed nothing');
  });

  it('a decision (approved/dismissed) is NOT a staging — confirm refuses over it', async () => {
    await store.recordDecision(FINDING_ID, 'approved', ACTOR);
    const out = await store.consumeStagedToken(FINDING_ID, DETECTOR, NODE_ID, 'any', ACTOR);
    expect(out).not.toBeNull();
    expect(out!.reason).toContain('no live staging');
  });
});

describe('outcome records', () => {
  it('recordPerformed stores the receipt', async () => {
    const receipt = {
      executor: 'scale-to-zero',
      detector: DETECTOR,
      findingId: FINDING_ID,
      resourceId: '/subscriptions/x/resourceGroups/y/providers/Microsoft.App/containerApps/z',
      before: { minReplicas: 2 },
      after: { minReplicas: 0 },
      performedAt: '2026-08-31T00:00:00.000Z',
      mutatedAzure: true,
    } as const;
    await store.recordPerformed(FINDING_ID, receipt, ACTOR);
    const [state] = await store.read(FINDING_ID);
    expect(state!.state).toBe('performed');
    expect(state!.receipt?.after).toEqual({ minReplicas: 0 });
  });

  it('recordFailed stores the REAL error verbatim', async () => {
    await store.recordFailed(FINDING_ID, 'updateContainerAppScale(x) failed 403', ACTOR);
    const [state] = await store.read(FINDING_ID);
    expect(state!.state).toBe('failed');
    expect(state!.error).toBe('updateContainerAppScale(x) failed 403');
  });
});

describe('the honest not-configured gate', () => {
  it('fails CLOSED with the exact env var named when Cosmos is absent', async () => {
    const saved = process.env.LOOM_COSMOS_ENDPOINT;
    delete process.env.LOOM_COSMOS_ENDPOINT;
    resetRecommendationStateClient();
    try {
      const bare = new RecommendationStateStore();
      await expect(bare.read()).rejects.toThrow(BrainActionsNotConfiguredError);
      await expect(bare.read()).rejects.toThrow(/LOOM_COSMOS_ENDPOINT/);
    } finally {
      if (saved !== undefined) process.env.LOOM_COSMOS_ENDPOINT = saved;
      resetRecommendationStateClient();
    }
  });
});
