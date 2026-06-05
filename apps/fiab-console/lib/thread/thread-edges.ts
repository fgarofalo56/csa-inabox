/**
 * Loom Thread edge graph — persistence of every "Weave" integration.
 *
 * Each time a Thread edge wires one Loom service into another (a notebook
 * attached to a lakehouse, a table published to Power BI / an API, a source
 * added to a data agent), we record a row here so Loom can render a
 * lineage / mesh view ("what feeds what") over real activity.
 *
 * Stored in the Cosmos `thread-edges` container (PK `/tenantId`). Writes are
 * best-effort: `recordThreadEdge` never throws — an edge action must still
 * succeed even if the graph write fails (no-vaporware: the integration itself
 * is the real backend; the graph is an observability layer over it).
 */

import { threadEdgesContainer } from '@/lib/azure/cosmos-client';
import type { SessionPayload } from '@/lib/auth/session';

export interface ThreadEdge {
  id: string;
  tenantId: string;
  /** Source Loom item. */
  fromItemId: string;
  fromType: string;
  fromName?: string;
  /** Target: a Loom item id, or an external id (e.g. a Power BI dataset id). */
  toItemId: string;
  toType: string;
  toName?: string;
  /** Whether the target is a Loom item (deep-linkable) or external. */
  toExternal?: boolean;
  /** Optional external deep link (e.g. the Power BI service URL). */
  toLink?: string;
  /** The ThreadAction id that created the edge. */
  action: string;
  createdAt: string;
  createdBy?: string;
}

export interface RecordEdgeInput {
  fromItemId: string;
  fromType: string;
  fromName?: string;
  toItemId: string;
  toType: string;
  toName?: string;
  toExternal?: boolean;
  toLink?: string;
  action: string;
}

/**
 * Record a Thread edge. Best-effort — swallows errors so an edge action never
 * fails because of the observability write. `createdAt` is stamped by the
 * caller-free `new Date()` at write time (server route context).
 */
export async function recordThreadEdge(session: SessionPayload, input: RecordEdgeInput): Promise<void> {
  try {
    const tenantId = session.claims.oid;
    const container = await threadEdgesContainer();
    const now = new Date().toISOString();
    const doc: ThreadEdge = {
      id: `edge_${tenantId}_${input.fromItemId}_${input.toItemId}_${input.action}`.replace(/[^A-Za-z0-9_-]/g, '_'),
      tenantId,
      fromItemId: input.fromItemId,
      fromType: input.fromType,
      fromName: input.fromName,
      toItemId: input.toItemId,
      toType: input.toType,
      toName: input.toName,
      toExternal: input.toExternal,
      toLink: input.toLink,
      action: input.action,
      createdAt: now,
      createdBy: session.claims.upn || session.claims.email || tenantId,
    };
    // Upsert so re-weaving the same pair/action refreshes (not duplicates) the edge.
    await container.items.upsert(doc);
  } catch {
    /* observability write is best-effort — never block the edge action */
  }
}

/** List the caller's Thread edges (most recent first). */
export async function listThreadEdges(session: SessionPayload): Promise<ThreadEdge[]> {
  const tenantId = session.claims.oid;
  const container = await threadEdgesContainer();
  const { resources } = await container.items
    .query<ThreadEdge>({
      query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.createdAt DESC',
      parameters: [{ name: '@t', value: tenantId }],
    })
    .fetchAll();
  return resources || [];
}
