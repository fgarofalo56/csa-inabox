/**
 * Pure hash-chain logic for access-review evidence records (loom-apex B-N19c').
 * No Cosmos, no Azure — fully unit-testable. The store (`evidence-store.ts`)
 * reads the chain head, calls {@link buildEvidenceRecord}, persists, and fans the
 * event out; the BFF route calls {@link verifyEvidenceChain} +
 * {@link renderEvidenceSummary} to produce the downloadable evidence pack.
 *
 * ## Why a hash chain
 *
 * An audit record is only evidence if you can prove it hasn't been edited. Each
 * record's `contentHash` is SHA-256 over its canonical body — and that body
 * embeds `prevHash`, the previous record's `contentHash` for the same tenant.
 * Editing any historical decision changes that record's recomputed hash
 * (detected directly) AND orphans every later record (detected as a chain
 * break), so a single-row tamper cannot be hidden without rewriting the whole
 * chain — which the append-only container + the SIEM fan-out both witness.
 *
 * ## Canonicalization
 *
 * Hash input is a deterministic JSON encoding: object keys sorted, `undefined`
 * dropped, arrays order-preserved, Cosmos system fields (`_rid`, `_etag`, …)
 * and `contentHash` itself excluded. Two structurally identical records always
 * hash identically regardless of key insertion order.
 */
import crypto from 'node:crypto';
import type { AccessReview, AccessReviewItem } from '@/lib/types/access-review';
import {
  EVIDENCE_GENESIS_HASH, EVIDENCE_VERSION,
  type AccessReviewEvidence, type EvidenceChainIssue, type EvidenceChainVerification,
  type EvidenceDecision, type EvidenceRevocation,
} from '@/lib/types/access-review-evidence';

/** Cosmos system fields + the hash field itself — never part of the hash input. */
const EXCLUDED_KEYS = new Set(['contentHash', '_rid', '_self', '_etag', '_attachments', '_ts']);

/**
 * Deterministic JSON encoding used as the hash input. Object keys are sorted,
 * `undefined` / function values are dropped, arrays keep their order, and the
 * excluded keys above never appear. Exported for the unit test.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value as number) ? JSON.stringify(value) : 'null';
  if (t === 'boolean' || t === 'string') return JSON.stringify(value);
  if (t === 'undefined' || t === 'function' || t === 'symbol') return 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(obj).sort()) {
    if (EXCLUDED_KEYS.has(k)) continue;
    const v = obj[k];
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
    parts.push(`${JSON.stringify(k)}:${canonicalJson(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/** SHA-256 (hex) over the canonical body of a record, excluding `contentHash`. */
export function evidenceContentHash(record: Omit<AccessReviewEvidence, 'contentHash'> | AccessReviewEvidence): string {
  return crypto.createHash('sha256').update(canonicalJson(record), 'utf8').digest('hex');
}

function bindings(list: { type: string; id: string; name?: string }[] | undefined) {
  return (list || []).map((b) => ({ type: b.type, id: b.id, ...(b.name ? { name: b.name } : {}) }));
}

function toDecision(it: AccessReviewItem): EvidenceDecision {
  return {
    itemId: it.id,
    ...(it.assignmentId ? { assignmentId: it.assignmentId } : {}),
    principalId: it.principalId,
    ...(it.principalUpn ? { principalUpn: it.principalUpn } : {}),
    principalType: it.principalType,
    resourceType: it.resourceType,
    resourceRef: it.resourceRef,
    ...(it.resourceName ? { resourceName: it.resourceName } : {}),
    role: it.role,
    ...(it.permission ? { permission: it.permission } : {}),
    source: it.source,
    decision: it.decision,
    ...(it.decidedBy ? { decidedBy: it.decidedBy } : {}),
    ...(it.decidedAt ? { decidedAt: it.decidedAt } : {}),
    ...(it.note ? { note: it.note } : {}),
    ...(it.revokedAt ? { revokedAt: it.revokedAt } : {}),
  };
}

/** True when a decision was written by the auto-revoke-on-close path. */
function isAutoClose(it: AccessReviewItem): boolean {
  return it.decision === 'revoke' && (it.note || '').startsWith('auto-revoked at campaign close');
}

export interface BuildEvidenceOptions {
  /** `contentHash` of the previous record for this tenant; genesis when none. */
  prevHash?: string;
  /** 1-based chain position; defaults to 1 (a tenant's first record). */
  sequence?: number;
  /** Who closed the campaign (upn or oid). */
  recordedBy: string;
  /** Backend revokes that actually ran during close (from closeCampaign). */
  backendRevoked?: number;
  /** Non-fatal revoke warnings from close. */
  warnings?: string[];
  /** ISO timestamp; defaults to now. */
  now?: string;
}

/**
 * Freeze a CLOSED campaign into an evidence record and seal it with its
 * content hash. Pure: same inputs → byte-identical record (the `now` /
 * `sequence` / `prevHash` inputs are the only variance), which is what makes
 * the tamper check meaningful.
 */
export function buildEvidenceRecord(review: AccessReview, opts: BuildEvidenceOptions): AccessReviewEvidence {
  const now = opts.now || new Date().toISOString();
  const items = review.items || [];
  const decisions = items.map(toDecision);

  let attested = 0, revoked = 0, pending = 0, autoRevoked = 0;
  const revocations: EvidenceRevocation[] = [];
  for (const it of items) {
    if (it.decision === 'attest') attested++;
    else if (it.decision === 'revoke') {
      revoked++;
      const auto = isAutoClose(it);
      if (auto) autoRevoked++;
      revocations.push({
        itemId: it.id,
        ...(it.assignmentId ? { assignmentId: it.assignmentId } : {}),
        principalId: it.principalId,
        ...(it.principalUpn ? { principalUpn: it.principalUpn } : {}),
        resourceType: it.resourceType,
        resourceRef: it.resourceRef,
        role: it.role,
        revokedAt: it.revokedAt || it.decidedAt || now,
        revokedBy: it.decidedBy || opts.recordedBy,
        reason: auto ? 'auto-close' : 'reviewer',
      });
    } else pending++;
  }

  const sequence = Math.max(1, Math.floor(opts.sequence ?? 1));
  const unsealed: Omit<AccessReviewEvidence, 'contentHash'> = {
    id: `${review.id}:${sequence}`,
    tenantId: review.tenantId,
    kind: 'access-review-evidence',
    version: EVIDENCE_VERSION,
    algorithm: 'sha256',
    sequence,
    prevHash: opts.prevHash || EVIDENCE_GENESIS_HASH,
    campaignId: review.id,
    campaign: {
      id: review.id,
      name: review.name,
      ...(review.description ? { description: review.description } : {}),
      scope: review.scope,
      reviewers: bindings(review.reviewers),
      delegatedTo: bindings(review.delegatedTo),
      cadenceDays: typeof review.cadenceDays === 'number' ? review.cadenceDays : null,
      dueAt: review.dueAt || null,
      autoRevokeOnExpiry: !!review.autoRevokeOnExpiry,
      ...(review.createdBy ? { createdBy: review.createdBy } : {}),
      createdAt: review.createdAt,
      closedAt: review.closedAt || now,
      closedBy: review.closedBy || opts.recordedBy,
    },
    decisions,
    revocations,
    totals: {
      total: items.length,
      attested,
      revoked,
      pending,
      autoRevoked,
      backendRevoked: Math.max(0, Math.floor(opts.backendRevoked ?? 0)),
    },
    warnings: (opts.warnings || []).slice(0, 20).map((w) => String(w).slice(0, 300)),
    recordedAt: now,
    recordedBy: opts.recordedBy,
  };
  return { ...unsealed, contentHash: evidenceContentHash(unsealed) };
}

/**
 * Verify a chain: every record's `contentHash` must match a recompute over its
 * own body (tamper detection) AND its `prevHash` must equal the previous
 * record's `contentHash` (chain continuity), with strictly increasing sequences
 * starting at 1 for a full-tenant chain.
 *
 * Pass `{ partial: true }` when verifying a SUBSET of a tenant's chain (e.g. a
 * single campaign's records): continuity is then only enforced between adjacent
 * supplied records whose sequences are contiguous, and the first record is not
 * required to be genesis.
 */
export function verifyEvidenceChain(
  records: AccessReviewEvidence[],
  opts: { partial?: boolean } = {},
): EvidenceChainVerification {
  const sorted = [...(records || [])].sort((a, b) => a.sequence - b.sequence);
  const issues: EvidenceChainIssue[] = [];
  let prev: AccessReviewEvidence | null = null;

  for (const rec of sorted) {
    const recomputed = evidenceContentHash(rec);
    if (recomputed !== rec.contentHash) {
      issues.push({
        sequence: rec.sequence,
        recordId: rec.id,
        kind: 'content-hash-mismatch',
        detail: `record has been modified since it was sealed (stored ${rec.contentHash.slice(0, 12)}…, recomputed ${recomputed.slice(0, 12)}…)`,
      });
    }
    if (!prev) {
      if (!opts.partial && rec.prevHash !== EVIDENCE_GENESIS_HASH) {
        issues.push({ sequence: rec.sequence, recordId: rec.id, kind: 'chain-break', detail: 'first record does not link to the genesis hash — earlier records are missing' });
      }
    } else {
      if (rec.sequence === prev.sequence) {
        issues.push({ sequence: rec.sequence, recordId: rec.id, kind: 'duplicate-sequence', detail: `sequence ${rec.sequence} appears more than once` });
      } else if (rec.sequence !== prev.sequence + 1) {
        if (!opts.partial) {
          issues.push({ sequence: rec.sequence, recordId: rec.id, kind: 'sequence-gap', detail: `expected sequence ${prev.sequence + 1}, found ${rec.sequence} — a record is missing` });
        }
      } else if (rec.prevHash !== prev.contentHash) {
        issues.push({ sequence: rec.sequence, recordId: rec.id, kind: 'chain-break', detail: `prevHash does not match the hash of record ${prev.id}` });
      }
    }
    prev = rec;
  }

  const brokenAt = issues.length ? Math.min(...issues.map((i) => i.sequence)) : undefined;
  return {
    ok: issues.length === 0,
    records: sorted.length,
    issues,
    ...(brokenAt !== undefined ? { brokenAt } : {}),
    ...(prev ? { headHash: prev.contentHash } : {}),
  };
}

function line(label: string, value: string): string {
  return `${label.padEnd(22, ' ')}${value}`;
}

/**
 * Human-readable evidence summary — the ".txt" half of the downloadable pack.
 * An auditor reads this; the JSON half is what a verifier re-hashes.
 */
export function renderEvidenceSummary(
  records: AccessReviewEvidence[],
  verification: EvidenceChainVerification,
): string {
  const sorted = [...(records || [])].sort((a, b) => a.sequence - b.sequence);
  const out: string[] = [];
  out.push('CSA LOOM — ACCESS REVIEW EVIDENCE PACK');
  out.push('='.repeat(72));
  out.push(line('Generated', new Date().toISOString()));
  out.push(line('Records', String(sorted.length)));
  out.push(line('Chain integrity', verification.ok ? 'VERIFIED — every record hashes to its sealed value and links to its predecessor' : 'FAILED'));
  if (!verification.ok) {
    for (const i of verification.issues) out.push(line('  ! issue', `seq ${i.sequence} (${i.kind}): ${i.detail}`));
  }
  if (verification.headHash) out.push(line('Chain head hash', verification.headHash));
  out.push('');

  for (const r of sorted) {
    out.push('-'.repeat(72));
    out.push(`RECORD #${r.sequence} — ${r.campaign.name}`);
    out.push('-'.repeat(72));
    out.push(line('Campaign id', r.campaignId));
    if (r.campaign.description) out.push(line('Description', r.campaign.description));
    out.push(line('Scope', `${r.campaign.scope.kind}${r.campaign.scope.ref ? ` · ${r.campaign.scope.ref}` : ''}${r.campaign.scope.resourceType ? ` (${r.campaign.scope.resourceType})` : ''}`));
    out.push(line('Reviewers', r.campaign.reviewers.length ? r.campaign.reviewers.map((b) => `${b.name || b.id} [${b.type}]`).join(', ') : 'admin-only (no named reviewers)'));
    if (r.campaign.delegatedTo.length) out.push(line('Delegated to', r.campaign.delegatedTo.map((b) => `${b.name || b.id} [${b.type}]`).join(', ')));
    out.push(line('Opened', `${r.campaign.createdAt}${r.campaign.createdBy ? ` by ${r.campaign.createdBy}` : ''}`));
    out.push(line('Deadline', r.campaign.dueAt || 'none'));
    out.push(line('Recurrence', r.campaign.cadenceDays ? `every ${r.campaign.cadenceDays} days` : 'one-time'));
    out.push(line('Auto-revoke on close', r.campaign.autoRevokeOnExpiry ? 'yes' : 'no'));
    out.push(line('Closed', `${r.campaign.closedAt} by ${r.campaign.closedBy}`));
    out.push('');
    out.push(line('Grants reviewed', String(r.totals.total)));
    out.push(line('  attested', String(r.totals.attested)));
    out.push(line('  revoked', `${r.totals.revoked} (${r.totals.autoRevoked} auto-revoked on no response, ${r.totals.backendRevoked} real backend teardown(s))`));
    out.push(line('  undecided', String(r.totals.pending)));
    out.push('');
    out.push('DECISIONS');
    if (!r.decisions.length) out.push('  (no grants were in scope)');
    for (const d of r.decisions) {
      out.push(`  [${d.decision.toUpperCase().padEnd(7, ' ')}] ${d.principalUpn || d.principalId} → ${d.resourceName || d.resourceRef} (${d.resourceType}) as ${d.role}`);
      out.push(`            via ${d.source}${d.decidedBy ? ` · decided by ${d.decidedBy}` : ''}${d.decidedAt ? ` at ${d.decidedAt}` : ''}${d.note ? ` · ${d.note}` : ''}`);
    }
    out.push('');
    out.push('REVOCATIONS');
    if (!r.revocations.length) out.push('  (none)');
    for (const v of r.revocations) {
      out.push(`  ${v.revokedAt}  ${v.principalUpn || v.principalId} lost ${v.role} on ${v.resourceRef} (${v.resourceType}) — ${v.reason}, by ${v.revokedBy}`);
    }
    if (r.warnings.length) {
      out.push('');
      out.push('WARNINGS AT CLOSE');
      for (const w of r.warnings) out.push(`  ${w}`);
    }
    out.push('');
    out.push(line('Previous hash', r.prevHash));
    out.push(line('Content hash', `${r.contentHash}  (sha256, canonical-json v${r.version})`));
    out.push(line('Sealed', `${r.recordedAt} by ${r.recordedBy}`));
    out.push('');
  }

  out.push('='.repeat(72));
  out.push('Verify independently: canonicalise each record (sorted keys, `contentHash`');
  out.push('and Cosmos system fields removed), SHA-256 it, and compare to `contentHash`;');
  out.push('then confirm each `prevHash` equals the previous record\'s `contentHash`.');
  return out.join('\n');
}

/** The machine-readable half of the pack (what a verifier re-hashes). */
export interface EvidencePack {
  product: 'csa-loom';
  artifact: 'access-review-evidence-pack';
  version: typeof EVIDENCE_VERSION;
  algorithm: 'sha256';
  generatedAt: string;
  campaignId?: string;
  verification: EvidenceChainVerification;
  records: AccessReviewEvidence[];
}

/** Assemble the downloadable pack (JSON body + readable summary). */
export function buildEvidencePack(
  records: AccessReviewEvidence[],
  opts: { campaignId?: string; partial?: boolean; now?: string } = {},
): { pack: EvidencePack; summary: string } {
  const verification = verifyEvidenceChain(records, { partial: opts.partial });
  const sorted = [...(records || [])].sort((a, b) => a.sequence - b.sequence);
  const pack: EvidencePack = {
    product: 'csa-loom',
    artifact: 'access-review-evidence-pack',
    version: EVIDENCE_VERSION,
    algorithm: 'sha256',
    generatedAt: opts.now || new Date().toISOString(),
    ...(opts.campaignId ? { campaignId: opts.campaignId } : {}),
    verification,
    records: sorted,
  };
  return { pack, summary: renderEvidenceSummary(sorted, verification) };
}
