/**
 * LU-5 — AUDIT TRAIL for the Loom Unity governance overlay.
 *
 * WHY THIS EXISTS (same reasoning as `lib/governance/domain-audit.ts`, whose
 * header records it for governance domains): the classic Microsoft Purview Data
 * Map Audit does NOT cover Loom-side governance mutations. Certification
 * attestations, governed-tag assignments (which LU-6's ABAC compiler turns into
 * real access-control DDL), and tenant vocabulary edits are therefore recorded
 * HERE as the authoritative trail, surfaced by the existing Admin → Audit Logs
 * reader (it queries `c.kind` and orders by `c.at`).
 *
 * `updatedBy` / `certification.by` on the overlay document are NOT a trail —
 * they are last-writer-wins fields on a mutable doc, so the previous certifier
 * is overwritten and unrecoverable. Every event below is append-only and
 * carries the BEFORE and AFTER facts.
 *
 * DENIALS ARE AUDITED TOO. An authorization refusal (403) and a validation
 * refusal (400 — a value outside the governed vocabulary, an unknown attribute
 * id, an oversized payload) are exactly the events a reviewer needs to see, so
 * `writeUcGovernanceDenial` records them with the attempted change, BOUNDED by
 * `boundAttempted` (the 403 branch runs before any request validation, so the
 * payload is raw and the caller holds no grant).
 *
 * BEST-EFFORT, NOT GUARANTEED. Audit writes never block and never fail the
 * primary response (identical contract to `writeDomainAudit`) — a Cosmos hiccup
 * must not make a governance write fail after it has already been applied. The
 * consequence is honest and deliberate: with the audit container missing or
 * misconfigured, governance mutations and refused forgery attempts proceed
 * UNRECORDED. This is an attributability aid, not a tamper-evident ledger, and
 * must not be relied on as a compliance control on its own.
 */
import { randomUUID } from 'node:crypto';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import type { UcGovernanceOverlay } from './model';

export type UcGovernanceAuditAction =
  | 'overlay.update'
  | 'overlay.delete'
  | 'overlay.purview-sync'
  | 'vocabulary.update'
  | 'denied';

/** The governance facts of an overlay, flattened for the audit record. */
export interface UcOverlayFacts {
  tags: Array<{ key: string; value: string; governed?: boolean }>;
  certificationRung: string;
  certifiedBy?: string;
  certifiedAt?: string;
  attributeIds: string[];
}

/** Snapshot the auditable facts of an overlay (never the whole document). */
export function overlayFacts(o: UcGovernanceOverlay | null | undefined): UcOverlayFacts {
  return {
    tags: (o?.tags || []).map((t) => ({ key: t.key, value: t.value, governed: !!t.governed })),
    certificationRung: o?.certification?.rung || 'none',
    ...(o?.certification?.by ? { certifiedBy: o.certification.by } : {}),
    ...(o?.certification?.at ? { certifiedAt: o.certification.at } : {}),
    attributeIds: Object.keys(o?.attributes || {}).sort(),
  };
}

async function write(
  tenantId: string,
  who: string,
  action: UcGovernanceAuditAction,
  itemId: string,
  details: unknown,
): Promise<void> {
  try {
    const c = await auditLogContainer();
    const at = new Date().toISOString();
    await c.items.create({
      // CSPRNG id (never Math.random — CodeQL js/insecure-randomness, and an
      // audit record id must not be guessable/forgeable).
      id: `ucgov-${randomUUID()}`,
      itemId,
      tenantId,
      who,
      at,
      timestamp: at,
      kind: `uc-governance.${action}`,
      category: 'uc-governance',
      action,
      details,
    });
  } catch {
    /* Non-fatal audit write — never block the primary response. */
  }
}

/**
 * Record an applied overlay mutation. `before`/`after` are the flattened facts
 * so a reviewer can see exactly which tag or rung moved, and who moved it —
 * including the certifier that the mutable document just overwrote.
 */
export async function writeOverlayAudit(p: {
  tenantId: string;
  who: string;
  action: 'overlay.update' | 'overlay.delete';
  identity: string;
  fullName: string;
  securableType: string;
  before: UcOverlayFacts;
  after: UcOverlayFacts;
}): Promise<void> {
  await write(p.tenantId, p.who, p.action, `uc-governance:${p.identity}`, {
    identity: p.identity,
    fullName: p.fullName,
    securableType: p.securableType,
    before: p.before,
    after: p.after,
  });
}

/**
 * Record a Purview fold-in attempt. Logged whether or not it synced: a push
 * into the SHARED tenant Purview account (global Atlas typedefs + asset
 * classifications, written with the Console UAMI's Data Curator role) is an
 * estate-wide side effect and must be attributable.
 */
export async function writePurviewSyncAudit(p: {
  tenantId: string;
  who: string;
  identity: string;
  fullName: string;
  synced: boolean;
  reason?: string;
  guid?: string;
  classificationsAdded?: string[];
  classificationsRemoved?: string[];
  businessMetadataKeys?: string[];
}): Promise<void> {
  await write(p.tenantId, p.who, 'overlay.purview-sync', `uc-governance:${p.identity}`, {
    identity: p.identity,
    fullName: p.fullName,
    synced: p.synced,
    ...(p.reason ? { reason: p.reason } : {}),
    ...(p.guid ? { guid: p.guid } : {}),
    classificationsAdded: p.classificationsAdded || [],
    classificationsRemoved: p.classificationsRemoved || [],
    businessMetadataKeys: p.businessMetadataKeys || [],
  });
}

/**
 * Record a tenant governed-tag VOCABULARY edit. This is a whole-document
 * overwrite, so a single bad save can delete every governed tag definition the
 * tenant has — `before` is the only way to reconstruct it.
 */
export async function writeVocabularyAudit(p: {
  tenantId: string;
  who: string;
  before: Array<{ key: string; allowedValues: string[] }>;
  after: Array<{ key: string; allowedValues: string[] }>;
}): Promise<void> {
  await write(p.tenantId, p.who, 'vocabulary.update', `uc-governance-vocabulary:${p.tenantId}`, {
    before: p.before.map((d) => ({ key: d.key, allowedValues: d.allowedValues })),
    after: p.after.map((d) => ({ key: d.key, allowedValues: d.allowedValues })),
    removedKeys: p.before
      .map((d) => d.key)
      .filter((k) => !p.after.some((a) => a.key.toLowerCase() === k.toLowerCase())),
  });
}

/**
 * Hard bounds on a DENIAL record's `attempted` payload.
 *
 * A denial is written on the 403 branch — BEFORE `applyOverlayMutation` and
 * therefore before `validateTagAssignment` / `validateAttributeValues` have
 * bounded anything. `withSession` applies no rate limit, so without these caps
 * any signed-in user holding NO grant at all could drive unbounded
 * attacker-controlled JSON into the shared Cosmos audit container, one document
 * per refused request — the same storage-amplification class the success path
 * closed via `OVERLAY_LIMITS`, reopened on the refusal path and reachable
 * without authorization.
 */
export const DENIAL_LIMITS = {
  /** Max array entries kept from an attempted payload. */
  maxArrayItems: 20,
  /** Max characters kept from any string. */
  maxStringLength: 256,
  /** Max own keys kept from any object. */
  maxObjectKeys: 32,
  /** Max nesting kept; deeper values collapse to a marker. */
  maxDepth: 4,
} as const;

/** Truncation marker so a reader can tell a record was clipped, not empty. */
const TRUNCATED = '[truncated]';

/**
 * Recursively bound an attacker-supplied value to {@link DENIAL_LIMITS}.
 * Exported so the bound is testable directly, but every write goes through
 * {@link writeUcGovernanceDenial}, which applies it — the cap lives at the SINK
 * so no current or future denial call site can forget it.
 */
export function boundAttempted(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > DENIAL_LIMITS.maxStringLength
      ? `${value.slice(0, DENIAL_LIMITS.maxStringLength)}…${TRUNCATED}`
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= DENIAL_LIMITS.maxDepth) return TRUNCATED;
  if (Array.isArray(value)) {
    const kept = value.slice(0, DENIAL_LIMITS.maxArrayItems).map((v) => boundAttempted(v, depth + 1));
    if (value.length > DENIAL_LIMITS.maxArrayItems) {
      kept.push(`${TRUNCATED} ${value.length - DENIAL_LIMITS.maxArrayItems} more`);
    }
    return kept;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [k, v] of entries.slice(0, DENIAL_LIMITS.maxObjectKeys)) {
      out[String(k).slice(0, DENIAL_LIMITS.maxStringLength)] = boundAttempted(v, depth + 1);
    }
    if (entries.length > DENIAL_LIMITS.maxObjectKeys) {
      out[TRUNCATED] = entries.length - DENIAL_LIMITS.maxObjectKeys;
    }
    return out;
  }
  // functions / symbols / bigint — never persisted verbatim.
  return TRUNCATED;
}

/**
 * Record a REFUSED governance mutation — an authorization denial (403) or a
 * validation rejection (400). `attempted` carries what the caller tried to do
 * so a repeated forgery attempt is visible in Admin → Audit Logs — BOUNDED by
 * {@link boundAttempted}, because on the 403 branch it is raw request body from
 * a caller who has no grant at all.
 */
export async function writeUcGovernanceDenial(p: {
  tenantId: string;
  who: string;
  surface: string;
  status: number;
  reason: string;
  target?: string;
  attempted?: unknown;
}): Promise<void> {
  await write(p.tenantId, p.who, 'denied', `uc-governance:${p.target || p.surface}`, {
    surface: p.surface,
    status: p.status,
    reason: String(p.reason || '').slice(0, DENIAL_LIMITS.maxStringLength * 4),
    ...(p.target ? { target: String(p.target).slice(0, DENIAL_LIMITS.maxStringLength) } : {}),
    ...(p.attempted !== undefined ? { attempted: boundAttempted(p.attempted) } : {}),
  });
}
