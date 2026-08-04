/**
 * P1.5 — the generic item-**definition** route (loom-vscode §2.5, W6).
 *
 *   GET  /api/items/[type]/[id]/definition
 *     → the item's editable, secret-scrubbed, provisioning-free definition, plus
 *       a strong `ETag` header (and `etag` in the body) for optimistic
 *       concurrency. Owner-scoped: a caller who cannot reach the item gets 404,
 *       never a cross-item read.
 *
 *   PUT  /api/items/[type]/[id]/definition   (header: If-Match: "<etag>")
 *     → write the edited definition back. `If-Match` is REQUIRED (428 without
 *       it); a stale tag → 412 (the VS Code client opens a diff instead of
 *       clobbering — N5/N6). The write re-attaches the item's scrubbed secrets +
 *       per-estate `provisioning`, so a GET→edit→PUT round-trip never destroys a
 *       value the client couldn't see (T-2). A body whose `schemaVersion` is
 *       newer than this build understands is refused (409) rather than truncated.
 *
 * Real Cosmos read/write via the same owner-scope primitive (`loadOwnedItem`)
 * every other item route uses — no mocks, no new auth surface. `withWorkspaceOwner`
 * itself binds a STATIC itemType at module load; this route's `[type]` is dynamic,
 * so it composes `getSession()` + `loadOwnedItem(id, type, …)` directly — the exact
 * primitive that wrapper calls — with read-roles admitted on GET and write-scoped
 * on PUT. Saves flow through `recordItemVersion` so notebook version history (N15)
 * is captured for free.
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { recordItemVersion } from '@/lib/versions/item-version-store';
import { apiOk, apiError, apiUnauthorized, apiNotFound, apiServerError } from '@/lib/api/respond';
import {
  buildItemDefinition,
  computeDefinitionEtag,
  applyItemDefinition,
  type LoomItemDefinition,
} from '@/lib/workspace/item-definition';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { type: string; id: string };

export async function GET(_req: NextRequest, props: { params: Promise<Params> }) {
  const { type, id } = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    // READ: admit shared read-only roles (Viewer/Contributor) — same as the
    // other read GETs. Owner-scope is enforced by loadOwnedItem; a caller who
    // cannot reach the item gets null → 404 (never a cross-item read).
    const item = await loadOwnedItem(id, type, session.claims.oid, {
      allowReadRoles: true,
      session,
    });
    if (!item) return apiNotFound('Item not found');

    const built = buildItemDefinition(item);
    return apiOk(
      {
        itemType: item.itemType,
        definition: built.definition,
        schemaVersion: built.definition.schemaVersion,
        etag: built.etag,
        scrubbedPaths: built.scrubbedPaths,
        provisioningExcluded: built.provisioningExcluded,
      },
      { headers: { ETag: built.etag } },
    );
  } catch (e) {
    return apiServerError(e, 'Failed to read item definition', 'definition_read_error');
  }
}

export async function PUT(req: NextRequest, props: { params: Promise<Params> }) {
  const { type, id } = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized();

  const ifMatch = (req.headers.get('if-match') || '').trim();
  if (!ifMatch) {
    return apiError(
      'If-Match header is required — GET the definition first and echo its ETag so a concurrent edit cannot be clobbered.',
      428,
      { code: 'precondition_required' },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('Invalid JSON', 400, { code: 'bad_json' });
  }

  try {
    // WRITE: write-scoped (no allowReadRoles) — a read-only share cannot mutate.
    const current = await loadOwnedItem(id, type, session.claims.oid, { session });
    if (!current) return apiNotFound('Item not found');

    // Optimistic concurrency: compare the caller's If-Match to the item's
    // CURRENT tag. A stale tag → 412; the client opens a diff (N5/N6).
    const currentEtag = computeDefinitionEtag(current);
    if (!etagMatches(ifMatch, currentEtag)) {
      return apiError(
        'The item changed since you loaded it — reload the definition and reapply your edit.',
        412,
        { code: 'precondition_failed', etag: currentEtag },
      );
    }

    const incoming = extractDefinition(body);
    const applied = applyItemDefinition(current, incoming);
    if (!applied.ok) return apiError(applied.error, applied.status, { code: applied.code });

    const now = new Date().toISOString();
    const next: WorkspaceItem & { schemaVersion: number } = {
      ...current,
      displayName:
        typeof incoming.displayName === 'string' && incoming.displayName.trim()
          ? incoming.displayName.trim()
          : current.displayName,
      description:
        typeof incoming.description === 'string'
          ? incoming.description.trim() || undefined
          : current.description,
      state: applied.state,
      schemaVersion: applied.schemaVersion,
      updatedAt: now,
    };

    const items = await itemsContainer();
    const { resource } = await items.item(current.id, current.workspaceId).replace<WorkspaceItem>(next);
    const saved = (resource ?? next) as WorkspaceItem;

    // Version-history snapshot (N15) at the shared save chokepoint — best-effort.
    await recordItemVersion(current, saved, {
      oid: session.claims.oid,
      name: session.claims.name || session.claims.upn || session.claims.email,
    });

    const built = buildItemDefinition(saved);
    return apiOk(
      {
        itemType: saved.itemType,
        definition: built.definition,
        schemaVersion: built.definition.schemaVersion,
        etag: built.etag,
        scrubbedPaths: built.scrubbedPaths,
        provisioningExcluded: built.provisioningExcluded,
      },
      { headers: { ETag: built.etag } },
    );
  } catch (e) {
    return apiServerError(e, 'Failed to write item definition', 'definition_write_error');
  }
}

/**
 * Accept either `{ definition: {...}, schemaVersion? }` (the wrapped shape the
 * VS Code client sends) or a bare definition object. Always returns an object so
 * `applyItemDefinition` can validate it.
 */
function extractDefinition(body: unknown): Partial<LoomItemDefinition> & Record<string, unknown> {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (b.definition && typeof b.definition === 'object') {
      return b.definition as Partial<LoomItemDefinition> & Record<string, unknown>;
    }
    return b as Partial<LoomItemDefinition> & Record<string, unknown>;
  }
  return {} as Partial<LoomItemDefinition> & Record<string, unknown>;
}

/**
 * ETag comparison tolerant of the weak-validator prefix (`W/"…"`) and of a
 * caller that dropped the quotes. Exact strong-tag match is the common path.
 */
function etagMatches(ifMatch: string, current: string): boolean {
  const norm = (s: string) => s.replace(/^W\//, '').replace(/^"|"$/g, '').trim();
  if (ifMatch === '*') return true;
  return norm(ifMatch) === norm(current);
}
