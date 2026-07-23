/**
 * POST /api/lineage/openlineage — OpenLineage RunEvent ingest (loom-next-level
 * L2, rev-2 SRE-F2 security redesign).
 *
 * The Synapse Spark pools run the openlineage-spark listener
 * (`spark.extraListeners = io.openlineage.spark.agent.OpenLineageSparkListener`,
 * http transport → THIS route; wired by
 * platform/fiab/bicep/modules/landing-zone/synapse-spark-pools.bicep +
 * scripts/csa-loom/openlineage-pool-setup.sh). Each COMPLETE RunEvent's
 * `columnLineage` facet is mapped into the L1 column model
 * (`RecordEdgeInput.columnMappings`, `confidence:'declared'`) and written via
 * `recordThreadEdge` — REAL declared column lineage from Spark transforms,
 * Azure-native, no Fabric.
 *
 * Security posture (BINDING, per the rev-2 redesign — every point enforced):
 *   1. AUTH — per-pool Entra bearer (JWKS-verified, tenant + audience pinned)
 *      or per-WORKSPACE minted token; never one global static secret. Verifier:
 *      lib/azure/openlineage-auth.ts. Fail-closed: unset → 503, bad → 401,
 *      unregistered principal → 403.
 *   2. SCOPE — the credential authorizes exactly ONE workspace. Every resolved
 *      OUTPUT item must belong to it; a resolved output in a DIFFERENT
 *      workspace is rejected 403 AND audit-logged (spoofable provenance is an
 *      SI-7/SC-8 integrity finding — the write must be provably attributable).
 *   3. LIMITS — 5 MB body cap (mirrors the eventhouse ingest's explicit byte
 *      cap) → 413; per-credential rate limit (two-tier: in-proc token bucket +
 *      durable Cosmos window) → 429; dataset + columnMappings fan-out caps
 *      per RunEvent (Cosmos write-amplification guard) → 413.
 *   4. TOPOLOGY — the route serves the in-VNet ingress ONLY. Defense-in-depth
 *      in code: a request that arrives via the public Front Door path (FD
 *      stamps `x-azure-fdid` on every forwarded request) is rejected 403
 *      unless the operator explicitly opts out via
 *      LOOM_OPENLINEAGE_PUBLIC_INGRESS_ENABLED=true.
 *
 * No mock data (no-vaporware): every accepted event writes real Cosmos
 * thread-edges rows readable back via GET /api/catalog/lineage?...&columns=true.
 * Honest gate: with no credential configured the OpenLineage source is simply
 * absent — the other column sources (Databricks UC, dbt, ADF Copy mappings)
 * keep flowing (default-ON preserved).
 */

import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { verifyOpenLineageAuth } from '@/lib/azure/openlineage-auth';
import {
  OL_MAX_BODY_BYTES,
  parseRunEvent,
  mapRunEventToEdges,
  type MappedOpenLineageEdge,
} from '@/lib/azure/openlineage-ingest';
import { enforceRateLimitForKey } from '@/lib/azure/rate-limiter';
import { itemsContainer, workspacesContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import type { SessionPayload } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Per-credential rate budget: bursty Spark jobs emit a handful of events per
 *  run — 20-burst / 5-per-second is generous for real listeners while bounding
 *  a runaway or hostile producer. The durable Cosmos window (default class:
 *  120/min cross-replica) backstops replica spreading. */
const OL_RATE_LIMITS = { ratePerSec: 5, burst: 20 };

/** A Loom item that carries at least one physical storage path in its state. */
interface PathItem {
  id: string;
  workspaceId: string;
  itemType: string;
  displayName?: string;
  paths: string[]; // normalized (lowercase, no trailing slash)
}

function normPath(p: string): string {
  return p.trim().replace(/\/+$/, '').toLowerCase();
}

/** Collect the physical storage-path strings on an item's state (top level —
 *  e.g. lakehouse `state.adlsRoot`, mirror bronze roots). */
function statePaths(state: Record<string, unknown> | undefined): string[] {
  if (!state || typeof state !== 'object') return [];
  const out: string[] = [];
  for (const v of Object.values(state)) {
    if (typeof v === 'string' && /^(abfss?|wasbs?|https):\/\//i.test(v.trim())) out.push(normPath(v));
  }
  return out;
}

/** True when `uri` is the item path itself or a child of it (`/` boundary). */
function pathOwns(itemPath: string, uri: string): boolean {
  if (!itemPath) return false;
  if (uri === itemPath) return true;
  return uri.startsWith(`${itemPath}/`);
}

/** Longest-prefix owner of `uri` among the candidates, or null. */
function resolveOwner(uri: string, candidates: PathItem[]): PathItem | null {
  let best: PathItem | null = null;
  let bestLen = -1;
  for (const c of candidates) {
    for (const p of c.paths) {
      if (pathOwns(p, uri) && p.length > bestLen) {
        best = c;
        bestLen = p.length;
      }
    }
  }
  return best;
}

/** Path-bearing items of ONE workspace (the authorized scope). */
async function loadWorkspacePathItems(workspaceId: string): Promise<PathItem[]> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<{ id: string; workspaceId: string; itemType: string; displayName?: string; state?: Record<string, unknown> }>({
      query: 'SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.state FROM c WHERE c.workspaceId = @w',
      parameters: [{ name: '@w', value: workspaceId }],
    })
    .fetchAll();
  return (resources || [])
    .map((r) => ({ id: r.id, workspaceId: r.workspaceId, itemType: r.itemType, displayName: r.displayName, paths: statePaths(r.state) }))
    .filter((r) => r.paths.length > 0);
}

/**
 * Cross-workspace forgery probe (redesign #2): find an item in a DIFFERENT
 * workspace that owns `uri`. Queries only the path-bearing item classes
 * (bounded), then prefix-matches in process.
 */
async function findForeignOwner(uri: string, workspaceId: string): Promise<PathItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<{ id: string; workspaceId: string; itemType: string; displayName?: string; state?: Record<string, unknown> }>({
      query:
        'SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.state FROM c ' +
        'WHERE c.workspaceId != @w AND (IS_DEFINED(c.state.adlsRoot) OR IS_DEFINED(c.state.abfssUri) OR IS_DEFINED(c.state.storageLocation))',
      parameters: [{ name: '@w', value: workspaceId }],
    })
    .fetchAll();
  const candidates = (resources || [])
    .map((r) => ({ id: r.id, workspaceId: r.workspaceId, itemType: r.itemType, displayName: r.displayName, paths: statePaths(r.state) }))
    .filter((r) => r.paths.length > 0);
  return resolveOwner(uri, candidates);
}

/** Cross-partition workspace load (machine path — no user session). */
async function loadWorkspaceDoc(workspaceId: string): Promise<{ id: string; tenantId: string; name?: string } | null> {
  const ws = await workspacesContainer();
  const { resources } = await ws.items
    .query<{ id: string; tenantId: string; name?: string }>({
      query: 'SELECT TOP 1 c.id, c.tenantId, c.name FROM c WHERE c.id = @id',
      parameters: [{ name: '@id', value: workspaceId }],
    })
    .fetchAll();
  return resources?.[0] || null;
}

/** Machine "session" for recordThreadEdge: writes land in the workspace
 *  OWNER's thread-edge partition (tenantId = owner oid) so the owner's lineage
 *  canvas renders the Spark-derived edges. Attribution is explicit. */
function machineSession(ownerOid: string): SessionPayload {
  return {
    claims: { oid: ownerOid, name: 'OpenLineage ingest', upn: 'openlineage-ingest@loom.internal' },
    exp: Math.floor(Date.now() / 1000) + 60,
  };
}

/** 403 + authoritative audit row + SIEM emit for a cross-workspace write
 *  attempt (redesign #2 — every rejection is attributable + discoverable). */
async function auditCrossWorkspaceDenial(opts: {
  principal: string;
  authorizedWorkspaceId: string;
  targetWorkspaceId: string;
  uri: string;
  itemId: string;
}): Promise<void> {
  const now = new Date().toISOString();
  try {
    const audit = await auditLogContainer();
    await audit.items
      .create({
        id: `audit-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        itemId: `openlineage:${opts.itemId}`,
        tenantId: opts.authorizedWorkspaceId,
        who: opts.principal,
        actorOid: opts.principal,
        at: now,
        kind: 'lineage.openlineage.cross-workspace-denied',
        target: opts.uri,
        detail: {
          authorizedWorkspaceId: opts.authorizedWorkspaceId,
          targetWorkspaceId: opts.targetWorkspaceId,
          resolvedItemId: opts.itemId,
        },
      })
      .catch(() => undefined);
  } catch {
    /* audit is best-effort; the 403 itself is the enforcement */
  }
  emitAuditEvent({
    actorOid: opts.principal,
    actorUpn: opts.principal,
    action: 'lineage.openlineage.cross-workspace-denied',
    targetType: 'thread-edge',
    targetId: opts.itemId,
    outcome: 'denied',
    tenantId: opts.authorizedWorkspaceId,
    detail: { uri: opts.uri, authorizedWorkspaceId: opts.authorizedWorkspaceId, targetWorkspaceId: opts.targetWorkspaceId },
  });
}

export async function POST(req: NextRequest) {
  // 4. TOPOLOGY — reject the public Front Door path (in-VNet ingress only).
  const viaFrontDoor = !!req.headers.get('x-azure-fdid');
  const publicOptOut = (process.env.LOOM_OPENLINEAGE_PUBLIC_INGRESS_ENABLED || '').toLowerCase() === 'true';
  if (viaFrontDoor && !publicOptOut) {
    return apiError('the OpenLineage ingest serves the in-VNet ingress only', 403, { code: 'public_ingress_rejected' });
  }

  // 1. AUTH — per-pool Entra bearer / per-workspace minted token (fail-closed).
  const auth = await verifyOpenLineageAuth(req.headers.get('authorization'));
  if (!auth.ok) return apiError(auth.error, auth.status, { code: 'openlineage_auth' });

  // 3a. RATE — per-credential two-tier budget.
  const limited = await enforceRateLimitForKey(`ol:${auth.principal}`, 'ol-ingest', OL_RATE_LIMITS);
  if (limited) return limited;

  // 3b. SIZE — explicit byte cap (mirror of the eventhouse MAX_FILE_BYTES).
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > OL_MAX_BODY_BYTES) {
    return apiError(`RunEvent too large (> ${OL_MAX_BODY_BYTES / 1024 / 1024} MB cap)`, 413, { code: 'body_too_large' });
  }
  const text = await req.text();
  if (Buffer.byteLength(text, 'utf-8') > OL_MAX_BODY_BYTES) {
    return apiError(`RunEvent too large (> ${OL_MAX_BODY_BYTES / 1024 / 1024} MB cap)`, 413, { code: 'body_too_large' });
  }

  // Schema validation.
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return apiError('invalid JSON body', 400, { code: 'bad_json' });
  }
  const parsed = parseRunEvent(raw);
  if (!parsed.ok) return apiError(parsed.error, 400, { code: parsed.code });

  // 3c. FAN-OUT caps (dataset + columnMappings write-amplification guards).
  const mapped = mapRunEventToEdges(parsed.event);
  if (!mapped.ok) return apiError(mapped.error, 413, { code: mapped.code });
  if (!mapped.edges.length) {
    // START/RUNNING/ABORT/FAIL or an edge-less COMPLETE — acknowledged, no writes.
    return apiOk({ accepted: 0, skipped: 0, eventType: parsed.event.eventType });
  }

  try {
    // 2. SCOPE — the credential's workspace must exist; resolution is bounded
    //    to it, and outputs resolving elsewhere are rejected + audited.
    const ws = await loadWorkspaceDoc(auth.workspaceId);
    if (!ws) {
      return apiError(`authorized workspace ${auth.workspaceId} does not exist`, 403, { code: 'workspace_not_found' });
    }
    const candidates = await loadWorkspacePathItems(auth.workspaceId);
    const session = machineSession(ws.tenantId);

    let accepted = 0;
    let skipped = 0;
    const written: Array<{ fromItemId: string; toItemId: string; columnMappings: number }> = [];

    for (const edge of mapped.edges as MappedOpenLineageEdge[]) {
      const toItem = resolveOwner(edge.toUri, candidates);
      if (!toItem) {
        // Forgery probe: does this output belong to a DIFFERENT workspace?
        const foreign = await findForeignOwner(edge.toUri, auth.workspaceId);
        if (foreign) {
          await auditCrossWorkspaceDenial({
            principal: auth.principal,
            authorizedWorkspaceId: auth.workspaceId,
            targetWorkspaceId: foreign.workspaceId,
            uri: edge.toUri,
            itemId: foreign.id,
          });
          return apiError(
            `output dataset resolves to an item outside the authorized workspace (${foreign.workspaceId})`,
            403,
            { code: 'cross_workspace_write' },
          );
        }
        skipped += 1; // honest: not a Loom-tracked asset — no fabricated node
        continue;
      }
      const fromItem = resolveOwner(edge.fromUri, candidates);
      if (!fromItem || fromItem.id === toItem.id) {
        skipped += 1;
        continue;
      }
      await recordThreadEdge(session, {
        fromItemId: fromItem.id,
        fromType: fromItem.itemType,
        fromName: fromItem.displayName,
        toItemId: toItem.id,
        toType: toItem.itemType,
        toName: toItem.displayName,
        action: 'openlineage-spark',
        ...(edge.columnMappings.length ? { columnMappings: edge.columnMappings } : {}),
      });
      accepted += 1;
      written.push({ fromItemId: fromItem.id, toItemId: toItem.id, columnMappings: edge.columnMappings.length });
    }

    return apiOk({
      accepted,
      skipped,
      eventType: parsed.event.eventType,
      job: parsed.event.job.name,
      runId: parsed.event.run.runId,
      edges: written,
    });
  } catch (e) {
    return apiServerError(e, 'OpenLineage ingest failed', 'openlineage_ingest_failed');
  }
}
