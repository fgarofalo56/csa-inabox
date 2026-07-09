import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * W18 — marketplace listing analytics counter increments. The Cosmos container
 * is mocked with an in-memory item so the pure counter arithmetic (view +1,
 * subscribe +1, distinct-subscriber tracking) is asserted without a live store.
 */

const store = new Map<string, any>();

const fakeContainer = {
  item: (id: string, _pk: string) => ({
    read: async () => ({ resource: store.get(id) }),
  }),
  items: {
    upsert: async (doc: any) => {
      store.set(doc.id, doc);
      return { resource: doc };
    },
  },
};

vi.mock('@/lib/azure/cosmos-client', () => ({
  dataProductAnalyticsContainer: async () => fakeContainer,
}));

import {
  getListingAnalytics,
  recordListingView,
  recordListingSubscribe,
} from '../listing-analytics';

beforeEach(() => store.clear());

describe('listing analytics counters', () => {
  it('starts at zero for an unseen product', async () => {
    const a = await getListingAnalytics('dp-1');
    expect(a.views).toBe(0);
    expect(a.subscribes).toBe(0);
    expect(a.subscriberOids).toEqual([]);
  });

  it('increments the view counter and stamps lastViewedAt', async () => {
    await recordListingView('dp-1');
    await recordListingView('dp-1');
    const a = await getListingAnalytics('dp-1');
    expect(a.views).toBe(2);
    expect(a.lastViewedAt).toBeTruthy();
    expect(a.subscribes).toBe(0);
  });

  it('increments subscribes and tracks distinct subscriber oids', async () => {
    await recordListingSubscribe('dp-2', 'user-a');
    await recordListingSubscribe('dp-2', 'user-a'); // repeat subscriber
    await recordListingSubscribe('dp-2', 'user-b');
    const a = await getListingAnalytics('dp-2');
    expect(a.subscribes).toBe(3);
    expect(a.subscriberOids.sort()).toEqual(['user-a', 'user-b']); // distinct
    expect(a.lastSubscribedAt).toBeTruthy();
  });

  it('keeps view and subscribe counters independent per product', async () => {
    await recordListingView('dp-3');
    await recordListingSubscribe('dp-4', 'u1');
    expect((await getListingAnalytics('dp-3')).views).toBe(1);
    expect((await getListingAnalytics('dp-3')).subscribes).toBe(0);
    expect((await getListingAnalytics('dp-4')).subscribes).toBe(1);
    expect((await getListingAnalytics('dp-4')).views).toBe(0);
  });
});
