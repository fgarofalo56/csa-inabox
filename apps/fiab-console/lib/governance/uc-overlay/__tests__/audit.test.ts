/**
 * LU-5 — audit.ts tests, focused on the DENIAL sink.
 *
 * Bugs these catch:
 *   1. STORAGE AMPLIFICATION ON THE REFUSAL PATH. The 403 branch of the
 *      governance route records `attempted` BEFORE `applyOverlayMutation` runs,
 *      so none of `OVERLAY_LIMITS` has bounded it yet, and `withSession` applies
 *      no rate limit. Without a cap AT THE SINK, any signed-in caller holding no
 *      grant at all can drive unbounded attacker-controlled JSON into the shared
 *      Cosmos audit container, one document per refused request.
 *   2. an audit write throwing and taking the primary response down with it
 *      (the contract is explicitly best-effort).
 *   3. a denial record being written with no attribution (who / tenant / status).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const WRITTEN: any[] = [];
let createError: unknown = null;

vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: async () => ({
    items: {
      create: async (doc: any) => {
        if (createError) throw createError;
        WRITTEN.push(doc);
        return { resource: doc };
      },
    },
  }),
}));

import { boundAttempted, DENIAL_LIMITS, writeUcGovernanceDenial } from '../audit';

beforeEach(() => {
  WRITTEN.length = 0;
  createError = null;
});

describe('boundAttempted', () => {
  it('caps string length and marks the truncation', () => {
    const out = boundAttempted('x'.repeat(10_000)) as string;
    expect(out.length).toBeLessThan(DENIAL_LIMITS.maxStringLength + 32);
    expect(out).toMatch(/\[truncated\]$/);
  });

  it('caps array length and records how many were dropped', () => {
    const out = boundAttempted(Array.from({ length: 5_000 }, (_, i) => i)) as unknown[];
    expect(out.length).toBe(DENIAL_LIMITS.maxArrayItems + 1);
    expect(String(out.at(-1))).toMatch(/\[truncated\] \d+ more/);
  });

  it('caps object breadth', () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 500; i++) wide[`k${i}`] = 'v';
    const out = boundAttempted(wide) as Record<string, unknown>;
    expect(Object.keys(out).length).toBe(DENIAL_LIMITS.maxObjectKeys + 1);
  });

  it('caps DEPTH — a deeply nested payload cannot be persisted verbatim', () => {
    let deep: any = 'leaf';
    for (let i = 0; i < 2_000; i++) deep = { next: deep };
    const out = boundAttempted(deep);
    expect(JSON.stringify(out).length).toBeLessThan(1_024);
  });

  it('leaves a normal, small payload byte-identical (the cap is not lossy in practice)', () => {
    const normal = {
      fullName: 'main.sales.orders',
      setTags: [{ key: 'pii', value: 'yes' }],
      certificationRung: 'certified',
      syncPurview: true,
      attributeIds: ['owner'],
    };
    expect(boundAttempted(normal)).toEqual(normal);
  });

  it('never persists a function or symbol verbatim', () => {
    expect(boundAttempted({ f: () => 1 })).toEqual({ f: '[truncated]' });
  });
});

describe('writeUcGovernanceDenial', () => {
  it('ATTACK: a 250 MB attempted payload lands as a few KB, and stays attributable', async () => {
    await writeUcGovernanceDenial({
      tenantId: 'tenant-1',
      who: 'mallory@contoso.com',
      surface: 'catalog/unity/governance',
      status: 403,
      reason: 'requires Admin on admin.security',
      target: 'main.sales.orders',
      attempted: {
        setTags: Array.from({ length: 5_000 }, () => ({ key: 'k'.repeat(500), value: 'v'.repeat(50_000) })),
      },
    });
    expect(WRITTEN).toHaveLength(1);
    expect(JSON.stringify(WRITTEN[0]).length).toBeLessThan(32 * 1024);
    // Attribution survives the bound — a clipped record is still a usable one.
    expect(WRITTEN[0].who).toBe('mallory@contoso.com');
    expect(WRITTEN[0].tenantId).toBe('tenant-1');
    expect(WRITTEN[0].details.status).toBe(403);
    expect(WRITTEN[0].details.target).toBe('main.sales.orders');
    expect(WRITTEN[0].kind).toBe('uc-governance.denied');
  });

  it('the record id is a CSPRNG uuid, never a guessable counter', async () => {
    await writeUcGovernanceDenial({
      tenantId: 't', who: 'a', surface: 's', status: 403, reason: 'r',
    });
    expect(WRITTEN[0].id).toMatch(/^ucgov-[0-9a-f-]{36}$/);
  });

  it('a Cosmos failure is swallowed — an audit outage must not fail the primary response', async () => {
    createError = Object.assign(new Error('audit container missing'), { code: 404 });
    await expect(writeUcGovernanceDenial({
      tenantId: 't', who: 'a', surface: 's', status: 403, reason: 'r',
    })).resolves.toBeUndefined();
    // …and the honest consequence: NOTHING was recorded. This is documented in
    // the module header as an attributability aid, not a guaranteed ledger.
    expect(WRITTEN).toHaveLength(0);
  });
});
