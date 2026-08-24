/**
 * RESOURCE GRAPH COLLECTION — pagination, completeness, and R7 error honesty.
 *
 * ── WHY PAGINATION HAS ITS OWN SUITE ───────────────────────────────────────
 * ARG caps a response and returns a `$skipToken`. A collector that ignores it
 * gets a plausible-looking partial estate, and every node in the unread
 * remainder then comes out with zero inbound edges — a page-boundary artifact
 * rendered as a fleet of unreachable services, indistinguishable from a real
 * finding. The failure is silent, confident, and looks exactly like the product
 * working.
 *
 * ── AND WHY `complete` IS CONSERVATIVE ─────────────────────────────────────
 * `complete` is true ONLY when ARG's own `totalRecords` is known AND equals the
 * rows read. An UNKNOWN total is not completeness — treating it as such is the
 * "unknown reported as negative" failure, and here the negative class is the
 * dangerous one because it licenses every downstream verdict.
 *
 * ── R7 ─────────────────────────────────────────────────────────────────────
 * A failed pull must not return an empty estate. On 2026-08-05 a swallowed
 * permission denial became "the tag does not exist" and sent two investigations
 * down the wrong path. These specs assert the error carries the status AND how
 * much had been read, and that no code path converts a 403 into zero rows.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ResourceGraphCollectionError,
  collectEstate,
} from '@/app/api/admin/brain/_lib/arg-collect';
import { containerAppRow } from './estate-fixture';

const cred = { getToken: async () => ({ token: 'test-token' }) };

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('pagination', () => {
  it('follows $skipToken to exhaustion and concatenates every page', async () => {
    const pageA = [containerAppRow({ name: 'a' }), containerAppRow({ name: 'b' })];
    const pageB = [containerAppRow({ name: 'c' })];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: pageA, totalRecords: 3, $skipToken: 'tok-1' }))
      .mockResolvedValueOnce(jsonResponse({ data: pageB, totalRecords: 3 }));

    const res = await collectEstate({
      fetchImpl: fetchImpl as never,
      credential: cred,
      armBaseOverride: 'https://arm.test',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(res.rows).toHaveLength(3);
    expect(res.stats.pages).toBe(2);
    expect(res.stats.complete).toBe(true);
  });

  it('sends the skipToken it was given, rather than re-reading page one forever', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ data: [containerAppRow({ name: 'a' })], totalRecords: 2, $skipToken: 'TOK' }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [containerAppRow({ name: 'b' })], totalRecords: 2 }));

    await collectEstate({
      fetchImpl: fetchImpl as never,
      credential: cred,
      armBaseOverride: 'https://arm.test',
    });

    const secondBody = JSON.parse((fetchImpl.mock.calls[1]![1] as { body: string }).body);
    expect(secondBody.options.$skipToken).toBe('TOK');
    // ...and the FIRST request must not carry one.
    const firstBody = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body);
    expect(firstBody.options.$skipToken).toBeUndefined();
  });

  it('reports INCOMPLETE when the row count disagrees with totalRecords', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [containerAppRow({ name: 'a' })], totalRecords: 99 }));

    const res = await collectEstate({
      fetchImpl: fetchImpl as never,
      credential: cred,
      armBaseOverride: 'https://arm.test',
    });

    expect(res.rows).toHaveLength(1);
    expect(res.stats.totalRecords).toBe(99);
    // Rows were lost — and the snapshot must be rendered as partial.
    expect(res.stats.complete).toBe(false);
  });

  it('an UNKNOWN totalRecords is NOT completeness', async () => {
    // The conservative branch. `null` means ARG did not say; treating that as
    // "complete" would license every downstream reachability verdict on a guess.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [containerAppRow({ name: 'a' })] }));
    const res = await collectEstate({
      fetchImpl: fetchImpl as never,
      credential: cred,
      armBaseOverride: 'https://arm.test',
    });
    expect(res.stats.totalRecords).toBeNull();
    expect(res.stats.complete).toBe(false);
  });

  it('stops on an empty page rather than looping on a stale token', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ data: [containerAppRow({ name: 'a' })], totalRecords: 1, $skipToken: 'T' }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [], totalRecords: 1, $skipToken: 'T' }));

    const res = await collectEstate({
      fetchImpl: fetchImpl as never,
      credential: cred,
      armBaseOverride: 'https://arm.test',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(res.rows).toHaveLength(1);
  });
});

describe('R7 — a failure says what it established, and never returns an empty estate', () => {
  it('throws on a 403 rather than reporting zero resources', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'AuthorizationFailed',
      json: async () => ({}),
    } as unknown as Response);

    await expect(
      collectEstate({
        fetchImpl: fetchImpl as never,
        credential: cred,
        armBaseOverride: 'https://arm.test',
      }),
    ).rejects.toBeInstanceOf(ResourceGraphCollectionError);
  });

  it('the error carries the status and how much had been read before it failed', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ data: [containerAppRow({ name: 'a' })], totalRecords: 50, $skipToken: 'T' }),
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'TooManyRequests',
        json: async () => ({}),
      } as unknown as Response);

    try {
      await collectEstate({
        fetchImpl: fetchImpl as never,
        credential: cred,
        armBaseOverride: 'https://arm.test',
      });
      throw new Error('expected a throw');
    } catch (e) {
      const err = e as ResourceGraphCollectionError;
      expect(err.status).toBe(429);
      expect(err.message).toContain('page 2');
      expect(err.message).toContain('1 row(s) had been read');
      // The claim it explicitly refuses to make.
      expect(err.message).toContain('INCOMPLETE');
      expect(err.detail).toContain('TooManyRequests');
    }
  });

  it('a missing token states that NO query was issued', async () => {
    const fetchImpl = vi.fn();
    await expect(
      collectEstate({
        fetchImpl: fetchImpl as never,
        credential: { getToken: async () => null },
        armBaseOverride: 'https://arm.test',
      }),
    ).rejects.toThrow(/NO query was issued/);
    // ...and it did not silently pretend to look.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('the query is a QUERY', () => {
  it('POSTs to the Resource Graph resources endpoint, which has no mutating operation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [], totalRecords: 0 }));
    await collectEstate({
      fetchImpl: fetchImpl as never,
      credential: cred,
      armBaseOverride: 'https://arm.test',
    });
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain('/providers/Microsoft.ResourceGraph/resources');
    expect((fetchImpl.mock.calls[0]![1] as { method: string }).method).toBe('POST');
  });

  it('derives the ARM host from the caller/cloud rather than a literal', async () => {
    // Cloud invariance (cloud-parity.md): the same code must work in Commercial
    // and in a sovereign boundary. This asserts the host is not hard-coded;
    // it does NOT assert the code has been RUN against Gov, which it has not.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [], totalRecords: 0 }));
    await collectEstate({
      fetchImpl: fetchImpl as never,
      credential: cred,
      armBaseOverride: 'https://management.usgovcloudapi.net',
    });
    expect(fetchImpl.mock.calls[0]![0] as string).toContain('management.usgovcloudapi.net');
  });

  it('scopes to the container tier and projects the fields both extractors need', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [], totalRecords: 0 }));
    await collectEstate({
      fetchImpl: fetchImpl as never,
      credential: cred,
      armBaseOverride: 'https://arm.test',
    });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body) as {
      query: string;
    };
    expect(body.query).toContain('Microsoft.App/containerApps');
    expect(body.query).toContain('Microsoft.App/jobs');
    expect(body.query).toContain('Microsoft.App/managedEnvironments');
    // `properties` carries scale, ingress AND env — one read feeds both
    // extractors, so a node's scale and its wires can never disagree.
    expect(body.query).toContain('properties');
    expect(body.query).toContain('tags');
    // No `subscriptions` scope: the report covers everything the identity can
    // read (PRP §1 decision 4).
    expect(body).not.toHaveProperty('subscriptions');
  });

  it('counts distinct subscriptions case-insensitively', async () => {
    const rows = [
      containerAppRow({ name: 'a', sub: '00000000-0000-4000-8000-00000000000A' }),
      containerAppRow({ name: 'b', sub: '00000000-0000-4000-8000-00000000000a' }),
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: rows, totalRecords: 2 }));
    const res = await collectEstate({
      fetchImpl: fetchImpl as never,
      credential: cred,
      armBaseOverride: 'https://arm.test',
    });
    // ARM ids are case-insensitive; counting these as two subscriptions would
    // overstate the estate's breadth in every report.
    expect(res.stats.subscriptionsSeen).toBe(1);
  });
});
