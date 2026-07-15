/**
 * Shared types for the long-term Copilot memory brain (CTS-08 / CTS-12 / CTS-13).
 *
 * Kept FREE of Next/Azure imports so the guard (memory-write-guard.ts), the
 * recall packer (memory-recall.ts), and the consolidation reducer
 * (memory-consolidate.ts) are all pure and unit-testable. The Cosmos + AI Search
 * side-effects live in lib/azure/memory-store.ts / memory-vector-index.ts.
 */

/** A memory is scoped either to one USER (private) or one WORKSPACE (shared —
 *  the enterprise analog of ATLAS's household scope). */
export type MemoryScope = 'user' | 'workspace';

/** Coarse category the extractor/guard assigns. `identity` is a LOCKED field
 *  class (see LOCKED_CATEGORIES) — a write that mutates one needs approval. */
export type MemoryCategory =
  | 'identity'      // stable identity facts (name, role, org) — locked class
  | 'preference'    // stable preferences ("prefers metric units")
  | 'fact'          // durable facts about the user's world
  | 'decision'      // decisions made ("we standardized on ADLS Gen2")
  | 'context';      // standing context / recurring entities

/** How a memory entered the store. */
export type MemorySource = 'auto' | 'flush' | 'explicit' | 'consolidation';

/** The system-of-record doc persisted to the Cosmos `copilot-memory` container. */
export interface MemoryRecord {
  /** `mem:<uuid>` */
  id: string;
  /** Partition key — `user:<oid>` or `workspace:<id>`. Derived from the acting
   *  session ONLY (never client-supplied) so a write can't target a foreign
   *  scope (CTS-12 cross-tenant enforcement). */
  scopeKey: string;
  scope: MemoryScope;
  /** Redacted, sanitized memory text (secrets stripped by the guard). */
  content: string;
  category: MemoryCategory;
  /** 0..1 extractor/caller confidence. */
  confidence: number;
  tags: string[];
  /** AI Search vector-mirror doc key when the dual-write succeeded. */
  embeddingId?: string;
  createdAt: string;
  updatedAt?: string;
  source: MemorySource;
  /** Entra tenant of the acting session — a second isolation dimension so an
   *  admin browse never crosses tenants even within a shared workspace scope. */
  tenantId?: string;
  /** Provenance: the Copilot session the memory was captured from. */
  sourceSessionId?: string;
  /** Usage-weighted recall salience (CTS-13 relationship reinforcement) —
   *  incremented each time the memory is recalled into a turn. */
  recallCount?: number;
  lastRecalledAt?: string;
}

/** The acting session's identity — the ONLY source of a write's scope. */
export interface MemoryActor {
  userOid: string;
  tenantId?: string;
  /** The workspace the turn is scoped to, when writing a workspace memory. */
  workspaceId?: string;
}

/** A candidate memory before it is scoped + guarded. `content` + `category` are
 *  required; the rest default. */
export interface MemoryCandidate {
  content: string;
  category?: MemoryCategory;
  confidence?: number;
  tags?: string[];
  scope?: MemoryScope;
  source?: MemorySource;
  sourceSessionId?: string;
}

/** Verdict from the deterministic guard (CTS-12). */
export interface GuardVerdict {
  ok: boolean;
  /** The sanitized record ready to persist (present only when ok). */
  record?: MemoryRecord;
  /** Machine reason on rejection (e.g. 'injection', 'locked_field', 'empty'). */
  reason?: string;
  /** Human-readable detail for the audit log. */
  detail?: string;
  /** Deterministic flags raised during screening (always populated). */
  flags: string[];
  /** True when secret redaction changed the content. */
  redacted: boolean;
}
