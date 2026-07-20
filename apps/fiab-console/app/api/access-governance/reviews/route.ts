/**
 * Access reviews / recertification campaigns (access-governance W4, AG-6/AG-7).
 *
 *   GET  /api/access-governance/reviews         → campaigns the caller may see
 *                                                  (tenant-admin: all; reviewer:
 *                                                  those they review). ?scope=mine
 *                                                  restricts to the reviewer inbox.
 *   POST /api/access-governance/reviews         → create a campaign (tenant-admin):
 *                                                  snapshots the in-scope effective
 *                                                  grants from the W1 ledger + live
 *                                                  workspace ACLs into review items.
 *
 * Backed by `access-reviews` (PK /tenantId). Campaigns are built by the wizard —
 * scope/reviewers/cadence are pickers, never raw JSON (loom-no-freeform-config).
 * Real backends only; an empty campaign is an honest "nothing in scope" result.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin, isTenantAdmin } from '@/lib/auth/feature-gate';
import {
  accessReviewsContainer, accessAssignmentsContainer, workspaceRolesContainer,
} from '@/lib/azure/cosmos-client';
import type { AccessAssignment } from '@/lib/types/access-assignment';
import type { WorkspaceRoleAssignment } from '@/lib/azure/workspace-roles-client';
import { assignmentToEntry, workspaceRoleToEntry, type AccessEntry } from '@/lib/access/access-report';
import type { AccessReview, ReviewScope, ReviewScopeKind } from '@/lib/types/access-review';
import type { ApproverBinding } from '@/lib/types/approval-policy';
import { buildReviewItems, computeStats, canReview } from '@/lib/access/access-reviews';
import { apiServerError } from '@/lib/api/respond';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_ROWS = 2000;
const SCOPE_KINDS = new Set<ReviewScopeKind>(['all', 'package', 'resource', 'principal', 'group']);

/** Sanitize the wizard body into a persistable campaign shape (no freeform JSON). */
export function sanitizeReview(body: any): { review?: Omit<AccessReview, 'id' | 'tenantId' | 'kind' | 'status' | 'items' | 'createdAt' | 'updatedAt'>; error?: string } {
  const name = String(body?.name || '').trim().slice(0, 120);
  if (!name) return { error: 'name is required' };
  const kind = SCOPE_KINDS.has(body?.scope?.kind) ? (body.scope.kind as ReviewScopeKind) : 'all';
  const scope: ReviewScope = { kind };
  if (kind !== 'all') {
    const ref = String(body?.scope?.ref || '').trim();
    if (!ref) return { error: `a ${kind} scope requires a reference` };
    scope.ref = ref;
    if (kind === 'resource' && body?.scope?.resourceType) scope.resourceType = String(body.scope.resourceType).trim();
  }
  const reviewers: ApproverBinding[] = (Array.isArray(body?.reviewers) ? body.reviewers : [])
    .map((r: any) => ({ type: r?.type === 'group' ? 'group' : 'user', id: String(r?.id || '').trim(), name: r?.name ? String(r.name).trim().slice(0, 200) : undefined }))
    .filter((r: ApproverBinding) => r.id);
  const cadenceDays = body?.cadenceDays === null || body?.cadenceDays === undefined ? null : Math.max(0, Number(body.cadenceDays) || 0) || null;
  let dueAt: string | null = null;
  if (typeof body?.dueInDays === 'number' && body.dueInDays > 0) {
    dueAt = new Date(Date.now() + body.dueInDays * 24 * 3600_000).toISOString();
  } else if (body?.dueAt && !Number.isNaN(Date.parse(body.dueAt))) {
    dueAt = new Date(body.dueAt).toISOString();
  }
  return {
    review: {
      name,
      description: body?.description ? String(body.description).trim().slice(0, 1000) : undefined,
      scope,
      reviewers,
      cadenceDays,
      dueAt,
      autoRevokeOnExpiry: body?.autoRevokeOnExpiry === true,
      createdBy: undefined,
    },
  };
}

/** Read all effective grants (ledger + live workspace ACLs) as report entries. */
async function loadEffectiveGrants(): Promise<AccessEntry[]> {
  const ledger = await accessAssignmentsContainer();
  const wsRoles = await workspaceRolesContainer();
  const [{ resources: la }, { resources: wr }] = await Promise.all([
    ledger.items.query<AccessAssignment>({ query: `SELECT TOP ${MAX_ROWS} * FROM c` }).fetchAll(),
    wsRoles.items.query<WorkspaceRoleAssignment>({ query: `SELECT TOP ${MAX_ROWS} * FROM c` }).fetchAll(),
  ]);
  return [...(la || []).map(assignmentToEntry), ...(wr || []).map(workspaceRoleToEntry)];
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const admin = isTenantAdmin(s);
  const mine = req.nextUrl.searchParams.get('scope') === 'mine';
  try {
    const c = await accessReviewsContainer();
    const { resources } = await c.items.query<AccessReview>({ query: 'SELECT * FROM c ORDER BY c.createdAt DESC' }).fetchAll();
    const groups = s.claims.groups || [];
    const visible = (resources || []).filter((r) => {
      const can = canReview(r, s.claims.oid, groups, admin);
      return mine ? (can && !admin ? true : can) : (admin || can);
    });
    const withStats = visible.map((r) => ({ ...r, stats: computeStats(r.items || []) }));
    return NextResponse.json({ ok: true, reviews: withStats, isAdmin: admin });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  try {
    const body = await req.json().catch(() => ({}));
    const { review, error } = sanitizeReview(body);
    if (error) return NextResponse.json({ ok: false, error }, { status: 400 });

    const id = crypto.randomUUID();
    const entries = await loadEffectiveGrants();
    const items = buildReviewItems(id, entries, review!.scope);
    const now = new Date().toISOString();
    const doc: AccessReview = {
      id,
      tenantId: s!.claims.oid,
      kind: 'access-review',
      ...review!,
      createdBy: s!.claims.upn || s!.claims.oid,
      status: 'active',
      items,
      createdAt: now,
      updatedAt: now,
    };
    const c = await accessReviewsContainer();
    const { resource } = await c.items.create(doc);
    return NextResponse.json({ ok: true, review: { ...(resource || doc), stats: computeStats(items) }, itemCount: items.length }, { status: 201 });
  } catch (e: any) {
    return apiServerError(e);
  }
}
