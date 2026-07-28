/**
 * LU-5 — Loom Unity GOVERNANCE OVERLAY (tags / governed tags / certification /
 * attribute values) on `uc:<fqn>` securable identities.
 *
 *   GET  /api/catalog/unity/governance?fullName=main.sales.orders[&column=email]
 *          → { ok, overlay, columnOverlays, vocabulary, attributeGroups }
 *   GET  /api/catalog/unity/governance?prefix=main.sales
 *          → { ok, overlays, vocabulary, attributeGroups }
 *   POST /api/catalog/unity/governance
 *          body { fullName, securableType?, column?, setTags?, removeTagKeys?,
 *                 certification?, attributes?, syncPurview?, ucHost? }
 *          → { ok, overlay, purview? }
 *
 * DEFAULT-ON, both backends, no gate: the overlay is Cosmos-backed Loom-native
 * governance, so it works against the OSS Unity Catalog server in Azure
 * Government exactly as it does against Databricks UC — closing the
 * `UC_CAPABILITIES.tags → oss:'none'` hole without a Databricks SQL warehouse
 * (`.claude/rules/no-fabric-dependency.md`, `loom_default_on_opt_out`).
 * `POST … syncPurview:true` additionally mirrors the facts into the CLASSIC
 * Purview Data Map; when Purview is unconfigured the write still succeeds and
 * `purview.reason` names the exact missing env var (never a silent no-op).
 *
 * Every write is validated against the tenant's governed-tag vocabulary: a
 * value outside a governed tag's ALLOWED VALUES is rejected 400.
 */
import { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiBadRequest, apiError, apiHonestError, apiOk } from '@/lib/api/respond';
import { tenantScopeId } from '@/lib/auth/session';
import type { EndorsementRung } from '@/lib/dataproducts/certification';
import {
  applyOverlayMutation, assertValidFullName, defaultSecurableType, UcOverlayError,
  UC_SECURABLE_TYPES, type UcOverlayMutation, type UcSecurableType,
} from '@/lib/governance/uc-overlay/model';
import {
  isEmptyOverlay, deleteOverlay, listColumnOverlays, listOverlays, readAttributeGroups,
  readGovernedTags, readOverlay, writeOverlay,
} from '@/lib/governance/uc-overlay/store';
import { provenanceFromSync, syncOverlayToPurview } from '@/lib/governance/uc-overlay/purview-sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (req: NextRequest, { session }) => {
  const tenantId = tenantScopeId(session);
  const sp = req.nextUrl.searchParams;
  const fullName = sp.get('fullName')?.trim();
  const prefix = sp.get('prefix')?.trim();
  const column = sp.get('column')?.trim() || undefined;

  const [vocabulary, attributeGroups] = await Promise.all([
    readGovernedTags(tenantId),
    readAttributeGroups(tenantId),
  ]);

  if (!fullName && !prefix) return apiBadRequest('fullName or prefix is required');

  if (!fullName) {
    const overlays = await listOverlays(tenantId, prefix);
    return apiOk({ overlays, vocabulary, attributeGroups });
  }

  try {
    assertValidFullName(fullName);
  } catch (e) {
    return apiError((e as UcOverlayError).message, (e as UcOverlayError).status || 400);
  }
  const securableType = (sp.get('securableType')?.trim() as UcSecurableType) || undefined;
  const [overlay, columnOverlays] = await Promise.all([
    readOverlay(tenantId, { fullName, column, securableType }),
    column ? Promise.resolve([]) : listColumnOverlays(tenantId, fullName),
  ]);
  return apiOk({ overlay, columnOverlays, vocabulary, attributeGroups });
});

export const POST = withSession(async (req: NextRequest, { session }) => {
  const tenantId = tenantScopeId(session);
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return apiBadRequest('invalid JSON body');
  }

  const fullName = String(body.fullName || '').trim();
  const column = body.column ? String(body.column).trim() : undefined;
  const requestedType = body.securableType ? String(body.securableType).trim() : '';
  if (requestedType && !UC_SECURABLE_TYPES.includes(requestedType as UcSecurableType)) {
    return apiBadRequest(`securableType must be one of ${UC_SECURABLE_TYPES.join(', ')}`);
  }
  const securableType = (requestedType as UcSecurableType) || defaultSecurableType(fullName);

  const mutation: UcOverlayMutation = {
    setTags: Array.isArray(body.setTags)
      ? (body.setTags as Array<{ key?: unknown; value?: unknown }>).map((t) => ({
          key: String(t?.key ?? ''),
          value: t?.value === undefined || t?.value === null ? '' : String(t.value),
        }))
      : undefined,
    removeTagKeys: Array.isArray(body.removeTagKeys)
      ? (body.removeTagKeys as unknown[]).map((k) => String(k ?? ''))
      : undefined,
    certification: body.certification
      ? {
          rung: String((body.certification as { rung?: unknown }).rung ?? '') as EndorsementRung,
          note: (body.certification as { note?: unknown }).note
            ? String((body.certification as { note?: unknown }).note)
            : undefined,
        }
      : undefined,
    attributes: (body.attributes as UcOverlayMutation['attributes']) || undefined,
  };

  const nothingToDo = !mutation.setTags?.length && !mutation.removeTagKeys?.length
    && !mutation.certification && !mutation.attributes;
  if (nothingToDo && !body.syncPurview) {
    return apiBadRequest('nothing to apply: provide setTags, removeTagKeys, certification, attributes, or syncPurview');
  }

  try {
    assertValidFullName(fullName);
    const [vocabulary, attributeGroups] = await Promise.all([
      readGovernedTags(tenantId),
      readAttributeGroups(tenantId),
    ]);
    const current = await readOverlay(tenantId, { fullName, column, securableType });
    let next = applyOverlayMutation(current, mutation, {
      vocabulary,
      attributeGroups,
      actorUpn: session.claims.upn || session.claims.oid,
    });

    // Purview fold-in BEFORE the persist so the provenance stamp lands in the
    // same document version the caller gets back.
    let purview;
    if (body.syncPurview) {
      purview = await syncOverlayToPurview(next, {
        ucHost: body.ucHost ? String(body.ucHost) : undefined,
      });
      const prov = provenanceFromSync(purview);
      if (prov) next = { ...next, purview: prov };
    }

    if (isEmptyOverlay(next) && !next.purview) {
      // The last annotation was removed — drop the row instead of persisting an
      // empty document so a listing shows only genuinely-governed securables.
      await deleteOverlay(tenantId, next.identity);
      return apiOk({ overlay: next, deleted: true, ...(purview ? { purview } : {}) });
    }
    const saved = await writeOverlay(next);
    return apiOk({ overlay: saved, ...(purview ? { purview } : {}) });
  } catch (e) {
    if (e instanceof UcOverlayError) return apiError(e.message, e.status);
    const status = (e as { status?: number })?.status;
    if (typeof status === 'number' && status >= 400 && status < 600) {
      // Verbatim upstream honest gate (Purview 403 "UAMI lacks Data Curator",
      // 404 typedef, …) — apiHonestError is the sanctioned passthrough.
      return apiHonestError(e, status);
    }
    throw e;
  }
});
