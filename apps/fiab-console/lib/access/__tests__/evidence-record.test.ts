/**
 * Unit tests for the signed access-review evidence chain (loom-apex B-N19c').
 *
 * Covers the three properties the audit standard depends on:
 *   1. hash-chain CONTINUITY — each record links to the previous record's hash;
 *   2. TAMPER DETECTION — mutating any decision breaks that record's own hash
 *      (and, once re-sealed, orphans every later record);
 *   3. CLOSE-PATH EMISSION — closing a campaign seals a record into Cosmos and
 *      fans it out through emitAuditEvent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AccessReview, AccessReviewItem } from '@/lib/types/access-review';
import type { AccessReviewEvidence } from '@/lib/types/access-review-evidence';
import { EVIDENCE_GENESIS_HASH } from '@/lib/types/access-review-evidence';
import {
  canonicalJson, evidenceContentHash, buildEvidenceRecord, verifyEvidenceChain,
  renderEvidenceSummary, buildEvidencePack,
} from '../evidence-record';

function item(over: Partial<AccessReviewItem> = {}): AccessReviewItem {
  return {
    id: over.id ?? 'it-1',
    assignmentId: over.assignmentId ?? 'as-1',
    principalId: over.principalId ?? 'p1',
    principalUpn: over.principalUpn ?? 'p1@contoso.com',
    principalType: over.principalType ?? 'User',
    resourceType: over.resourceType ?? 'workspace',
    resourceRef: over.resourceRef ?? 'ws-1',
    resourceName: over.resourceName ?? 'Finance',
    role: over.role ?? 'Contributor',
    source: over.source ?? 'direct',
    decision: over.decision ?? 'attest',
    decidedBy: over.decidedBy ?? 'reviewer@contoso.com',
    decidedAt: over.decidedAt ?? '2026-07-20T10:00:00.000Z',
    note: over.note,
    revokedAt: over.revokedAt,
  };
}

function review(over: Partial<AccessReview> = {}): AccessReview {
  return {
    id: over.id ?? 'camp-1',
    tenantId: over.tenantId ?? 'tenant-a',
    kind: 'access-review',
    name: over.name ?? 'Q3 recertification',
    description: over.description,
    scope: over.scope ?? { kind: 'all' },
    reviewers: over.reviewers ?? [{ type: 'user', id: 'r1', name: 'Reviewer One' }],
    delegatedTo: over.delegatedTo,
    cadenceDays: over.cadenceDays ?? 90,
    dueAt: over.dueAt ?? '2026-07-25T00:00:00.000Z',
    autoRevokeOnExpiry: over.autoRevokeOnExpiry ?? true,
    status: over.status ?? 'closed',
    items: over.items ?? [item()],
    createdBy: over.createdBy ?? 'admin@contoso.com',
    createdAt: over.createdAt ?? '2026-07-01T00:00:00.000Z',
    updatedAt: over.updatedAt ?? '2026-07-25T00:00:00.000Z',
    closedAt: over.closedAt ?? '2026-07-25T00:00:00.000Z',
    closedBy: over.closedBy ?? 'admin@contoso.com',
  };
}

const NOW = '2026-07-25T00:00:00.000Z';

describe('canonicalJson', () => {
  it('is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
  it('preserves array order (a re-ordered decision list is a different document)', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
  it('excludes contentHash and Cosmos system fields from the hash input', () => {
    const a = canonicalJson({ x: 1, contentHash: 'aaa', _etag: 'e1', _ts: 5 });
    const b = canonicalJson({ x: 1, contentHash: 'bbb', _etag: 'e2', _ts: 9 });
    expect(a).toBe(b);
    expect(a).toBe('{"x":1}');
  });
  it('drops undefined values so an absent optional never changes the hash', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});

describe('buildEvidenceRecord', () => {
  it('seals a record whose contentHash verifies and links to genesis by default', () => {
    const rec = buildEvidenceRecord(review(), { recordedBy: 'admin@contoso.com', now: NOW });
    expect(rec.sequence).toBe(1);
    expect(rec.prevHash).toBe(EVIDENCE_GENESIS_HASH);
    expect(rec.id).toBe('camp-1:1');
    expect(rec.tenantId).toBe('tenant-a');
    expect(rec.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const { contentHash, ...body } = rec;
    expect(evidenceContentHash(body as Omit<AccessReviewEvidence, 'contentHash'>)).toBe(contentHash);
  });

  it('is deterministic — identical inputs seal to an identical hash', () => {
    const a = buildEvidenceRecord(review(), { recordedBy: 'admin@contoso.com', now: NOW });
    const b = buildEvidenceRecord(review(), { recordedBy: 'admin@contoso.com', now: NOW });
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('records campaign metadata, every decision, and the resulting revocations', () => {
    const rec = buildEvidenceRecord(review({
      items: [
        item({ id: 'a', decision: 'attest' }),
        item({ id: 'b', decision: 'revoke', principalId: 'p2', revokedAt: NOW, decidedBy: 'reviewer@contoso.com' }),
        item({ id: 'c', decision: 'revoke', principalId: 'p3', revokedAt: NOW, note: 'auto-revoked at campaign close (no response)' }),
        item({ id: 'd', decision: 'pending', principalId: 'p4', decidedBy: undefined, decidedAt: undefined }),
      ],
    }), { recordedBy: 'admin@contoso.com', backendRevoked: 2, warnings: ['ws-1: ARM 409'], now: NOW });

    expect(rec.campaign.name).toBe('Q3 recertification');
    expect(rec.campaign.reviewers).toEqual([{ type: 'user', id: 'r1', name: 'Reviewer One' }]);
    expect(rec.campaign.closedBy).toBe('admin@contoso.com');
    expect(rec.decisions).toHaveLength(4);
    expect(rec.totals).toMatchObject({ total: 4, attested: 1, revoked: 2, pending: 1, autoRevoked: 1, backendRevoked: 2 });
    expect(rec.revocations).toHaveLength(2);
    expect(rec.revocations.find((r) => r.itemId === 'b')?.reason).toBe('reviewer');
    expect(rec.revocations.find((r) => r.itemId === 'c')?.reason).toBe('auto-close');
    expect(rec.warnings).toEqual(['ws-1: ARM 409']);
  });
});

/** Build a 3-record chain the way the store does (head → prevHash → next). */
function chain(): AccessReviewEvidence[] {
  const out: AccessReviewEvidence[] = [];
  for (let i = 1; i <= 3; i++) {
    const head = out[out.length - 1];
    out.push(buildEvidenceRecord(review({
      id: `camp-${i}`,
      name: `Campaign ${i}`,
      items: [
        item({ id: `${i}-a`, decision: 'attest' }),
        item({ id: `${i}-b`, decision: 'revoke', principalId: 'p2', principalUpn: 'p2@contoso.com', revokedAt: NOW }),
      ],
    }), {
      recordedBy: 'admin@contoso.com',
      prevHash: head?.contentHash,
      sequence: i,
      backendRevoked: 1,
      now: `2026-07-2${i}T00:00:00.000Z`,
    }));
  }
  return out;
}

describe('verifyEvidenceChain — continuity', () => {
  it('verifies a well-formed chain', () => {
    const recs = chain();
    const v = verifyEvidenceChain(recs);
    expect(v.ok).toBe(true);
    expect(v.records).toBe(3);
    expect(v.issues).toEqual([]);
    expect(v.headHash).toBe(recs[2].contentHash);
    expect(v.brokenAt).toBeUndefined();
  });

  it('verifies regardless of the order records come back from Cosmos', () => {
    const recs = chain();
    expect(verifyEvidenceChain([recs[2], recs[0], recs[1]]).ok).toBe(true);
  });

  it('flags a chain that does not start at genesis', () => {
    const recs = chain();
    const v = verifyEvidenceChain(recs.slice(1));
    expect(v.ok).toBe(false);
    expect(v.issues[0].kind).toBe('chain-break');
    expect(v.brokenAt).toBe(2);
  });

  it('allows a campaign-scoped subset when partial:true', () => {
    const recs = chain();
    expect(verifyEvidenceChain(recs.slice(1), { partial: true }).ok).toBe(true);
  });

  it('flags a missing record (sequence gap) in a full-tenant chain', () => {
    const recs = chain();
    const v = verifyEvidenceChain([recs[0], recs[2]]);
    expect(v.ok).toBe(false);
    expect(v.issues.map((i) => i.kind)).toContain('sequence-gap');
  });

  it('flags a duplicate sequence', () => {
    const recs = chain();
    const v = verifyEvidenceChain([recs[0], { ...recs[1], sequence: 1, id: 'dup:1' }]);
    expect(v.ok).toBe(false);
    expect(v.issues.map((i) => i.kind)).toContain('duplicate-sequence');
  });
});

describe('verifyEvidenceChain — tamper detection', () => {
  it('detects a mutated decision (verdict flipped from revoke to attest)', () => {
    const recs = chain();
    const tampered = structuredClone(recs);
    tampered[1].decisions[1].decision = 'attest';
    const v = verifyEvidenceChain(tampered);
    expect(v.ok).toBe(false);
    expect(v.issues[0].kind).toBe('content-hash-mismatch');
    expect(v.brokenAt).toBe(2);
  });

  it('detects a mutated reviewer / timestamp on a decision', () => {
    const recs = chain();
    const t1 = structuredClone(recs);
    t1[0].decisions[0].decidedBy = 'someone-else@contoso.com';
    expect(verifyEvidenceChain(t1).ok).toBe(false);

    const t2 = structuredClone(recs);
    t2[0].decisions[0].decidedAt = '2020-01-01T00:00:00.000Z';
    expect(verifyEvidenceChain(t2).ok).toBe(false);
  });

  it('detects a deleted revocation row and edited totals', () => {
    const recs = chain();
    const t = structuredClone(recs);
    t[2].revocations = [];
    t[2].totals.revoked = 0;
    const v = verifyEvidenceChain(t);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.kind === 'content-hash-mismatch')).toBe(true);
  });

  it('cannot be hidden by re-sealing the edited record — the chain then breaks', () => {
    const recs = chain();
    const t = structuredClone(recs);
    t[1].decisions[1].decision = 'attest';
    // Attacker re-seals record 2 so its own hash matches again…
    const { contentHash: _drop, ...body } = t[1];
    t[1].contentHash = evidenceContentHash(body as Omit<AccessReviewEvidence, 'contentHash'>);
    const v = verifyEvidenceChain(t);
    // …but record 3's prevHash still points at the ORIGINAL record-2 hash.
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.kind === 'chain-break' && i.sequence === 3)).toBe(true);
  });

  it('ignores Cosmos system fields, so a normal read never false-positives', () => {
    const recs = chain();
    const withSys = recs.map((r) => ({ ...r, _rid: 'abc', _etag: '"0x1"', _ts: 1_753_000_000, _self: 'x', _attachments: 'y' })) as AccessReviewEvidence[];
    expect(verifyEvidenceChain(withSys).ok).toBe(true);
  });
});

describe('renderEvidenceSummary / buildEvidencePack', () => {
  it('renders a readable auditor summary with hashes and the verdict', () => {
    const recs = chain();
    const txt = renderEvidenceSummary(recs, verifyEvidenceChain(recs));
    expect(txt).toContain('CSA LOOM — ACCESS REVIEW EVIDENCE PACK');
    expect(txt).toContain('VERIFIED');
    expect(txt).toContain('Campaign 1');
    expect(txt).toContain(recs[0].contentHash);
    expect(txt).toContain('DECISIONS');
    expect(txt).toContain('REVOCATIONS');
  });

  it('states the failure in the summary when the chain is broken', () => {
    const recs = chain();
    const t = structuredClone(recs);
    t[0].decisions[0].role = 'Owner';
    const txt = renderEvidenceSummary(t, verifyEvidenceChain(t));
    expect(txt).toContain('FAILED');
    expect(txt).toContain('content-hash-mismatch');
  });

  it('packs records + verification + summary for download', () => {
    const recs = chain();
    const { pack, summary } = buildEvidencePack(recs, { campaignId: 'camp-1', now: NOW });
    expect(pack.artifact).toBe('access-review-evidence-pack');
    expect(pack.algorithm).toBe('sha256');
    expect(pack.records).toHaveLength(3);
    expect(pack.verification.ok).toBe(true);
    expect(summary.length).toBeGreaterThan(100);
    // The pack round-trips through JSON without changing any hash.
    const round = JSON.parse(JSON.stringify(pack)) as typeof pack;
    expect(verifyEvidenceChain(round.records).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Close-path emission — the store seals into Cosmos + fans out via emitAuditEvent
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  created: [] as any[],
  auditRows: [] as any[],
  emitted: [] as any[],
  head: null as any,
  failCreate: false,
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  accessReviewEvidenceContainer: async () => ({
    items: {
      query: () => ({ fetchAll: async () => ({ resources: h.head ? [h.head] : [] }) }),
      create: async (doc: any) => {
        if (h.failCreate) throw new Error('cosmos 429');
        h.created.push(doc);
        return { resource: doc };
      },
    },
  }),
  auditLogContainer: async () => ({
    items: { create: async (doc: any) => { h.auditRows.push(doc); return { resource: doc }; } },
  }),
}));

vi.mock('@/lib/admin/audit-stream', () => ({
  emitAuditEvent: (ev: any) => { h.emitted.push(ev); },
}));

const { sealCampaignEvidence } = await import('../evidence-store');

describe('sealCampaignEvidence (close-path emission)', () => {
  beforeEach(() => {
    h.created.length = 0; h.auditRows.length = 0; h.emitted.length = 0;
    h.head = null; h.failCreate = false;
  });

  it('writes the first record for a tenant linked to genesis and fans it out', async () => {
    const r = review({ items: [item({ decision: 'attest' })] });
    const { evidence, error } = await sealCampaignEvidence(r, 'admin@contoso.com', {
      backendRevoked: 0, warnings: [], actor: { oid: 'oid-1', upn: 'admin@contoso.com', tid: 'tid-1' }, now: NOW,
    });
    expect(error).toBeUndefined();
    expect(evidence).not.toBeNull();
    expect(evidence!.sequence).toBe(1);
    expect(evidence!.prevHash).toBe(EVIDENCE_GENESIS_HASH);
    expect(h.created).toHaveLength(1);
    expect(h.created[0].kind).toBe('access-review-evidence');

    // Cosmos audit trail row.
    expect(h.auditRows).toHaveLength(1);
    expect(h.auditRows[0].action).toBe('review-evidence-sealed');

    // SIEM / webhook fan-out.
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]).toMatchObject({
      action: 'access-review.evidence-sealed',
      targetType: 'access-review-evidence',
      targetId: evidence!.id,
      tenantId: 'tid-1',
      outcome: 'success',
    });
    expect((h.emitted[0].detail as any).contentHash).toBe(evidence!.contentHash);
  });

  it('chains the next record onto the tenant head, producing a verifiable chain', async () => {
    const first = await sealCampaignEvidence(review({ id: 'camp-1' }), 'admin@contoso.com', { now: NOW });
    h.head = first.evidence;
    const second = await sealCampaignEvidence(review({ id: 'camp-2', name: 'Q4' }), 'admin@contoso.com', { now: NOW });
    expect(second.evidence!.sequence).toBe(2);
    expect(second.evidence!.prevHash).toBe(first.evidence!.contentHash);
    expect(verifyEvidenceChain([first.evidence!, second.evidence!]).ok).toBe(true);
  });

  it('never throws when the evidence write fails — the close already happened', async () => {
    h.failCreate = true;
    const { evidence, error } = await sealCampaignEvidence(review(), 'admin@contoso.com', { now: NOW });
    expect(evidence).toBeNull();
    expect(error).toContain('cosmos 429');
    expect(h.emitted).toHaveLength(0);
  });
});
