/**
 * /api/data-products/[id]/versions  (DP-9)
 *
 *   GET  → the immutable version history (each entry + its diff vs the prior).
 *   POST → append a NEW immutable contract version (never overwrites). The body
 *          carries the edited contract; the server computes the schema diff vs
 *          the latest version, classifies the semver level, bumps the version,
 *          and appends. The product's current `state.contract` is updated to the
 *          new version.
 *
 * This is the "append, don't overwrite" spine DP-9 adds on top of the contract
 * designer (which used to clobber the single current contract on every Save).
 * Owner-only (loadOwnedItem). Azure-native Cosmos; no Fabric dependency.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem, jerr } from '@/app/api/items/_lib/item-crud';
import { sanitizeContract, type DataContract } from '@/lib/dataproducts/contract';
import {
  diffContracts, bumpVersion, type VersionEntry, type SemverLevel,
} from '@/lib/dataproducts/versioning';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';

function readVersions(state: Record<string, unknown>): VersionEntry[] {
  return Array.isArray(state.versions) ? (state.versions as VersionEntry[]) : [];
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const { id } = await ctx.params;
  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('data-product item not found', 404);
    const state = (item.state || {}) as Record<string, unknown>;
    return NextResponse.json({
      ok: true,
      versions: readVersions(state),
      current: (state.contract as DataContract) ?? null,
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const { id } = await ctx.params;

  const body = await req.json().catch(() => ({}));
  const contract = sanitizeContract(body?.contract);
  if (!contract) return jerr('a valid { contract } is required', 400);
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 2000) : undefined;

  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('data-product item not found', 404);
    const state = (item.state || {}) as Record<string, unknown>;
    const versions = readVersions(state);
    const prev = versions.length ? versions[versions.length - 1].contract : (state.contract as DataContract | undefined);

    const diff = diffContracts(prev, contract);
    const level: SemverLevel = versions.length === 0 ? 'patch' : diff.level;
    // Version the new entry: honor an explicit contract.version if the author
    // bumped it past the suggestion, else auto-bump from the prior version.
    const autoVersion = versions.length === 0 ? (contract.version || '1.0.0') : bumpVersion(prev?.version, level);
    const version = contract.version && contract.version !== prev?.version ? contract.version : autoVersion;

    const entry: VersionEntry = {
      version, level,
      contract: { ...contract, version },
      createdAt: new Date().toISOString(),
      createdBy: session.claims.upn || session.claims.email || session.claims.oid,
      ...(note ? { note } : {}),
      ...(versions.length ? { changes: diff.changes } : {}),
    };

    const nextVersions = [...versions, entry];
    const updated = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, {
      state: { ...state, versions: nextVersions, contract: entry.contract },
    });
    if (!updated) return jerr('failed to persist the new version', 500);

    return NextResponse.json({ ok: true, entry, diff, breaking: diff.breaking });
  } catch (e: any) {
    return apiServerError(e);
  }
}
