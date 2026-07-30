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
 *                 certification?, attributes?, syncPurview? }
 *                 (ucHost is NOT accepted — the Purview/UC host is resolved from
 *                  config; see the note at the syncOverlayToPurview call.)
 *          → { ok, overlay, purview? }
 *
 * AUTHORIZATION — the mutation path is NOT session-only
 * ----------------------------------------------------
 * Reads are tenant-partition scoped (`tenantScopeId(session)`), so a signed-in
 * session is the right bar for GET. WRITES are not: this overlay is a TENANT-
 * WIDE trust surface, and `lib/auth/feature-gate.requireTenantAdmin`'s own
 * docblock names exactly this shape of risk — per-user Cosmos self-scoping
 * gives ZERO protection when the state being mutated is shared. Concretely:
 *
 *   - CERTIFICATION is an attestation other people rely on, stamped with the
 *     caller's UPN. A session-only gate means any authenticated user can FORGE
 *     "certified by <themselves>" on any table in any catalog.
 *   - GOVERNED TAGS are the input to LU-6's ABAC compiler, which emits real
 *     Databricks tag DDL / Synapse secure views — flipping one is an
 *     access-control change, not a label change.
 *   - `syncPurview` writes into the SHARED tenant Purview account with the
 *     Console UAMI's Data Curator role, and creates ACCOUNT-GLOBAL Atlas
 *     classification typedefs.
 *
 * So the write path is tiered on the existing, delegable `admin.security`
 * ("Security & Governance") capability — tenant admins bypass, and any admin
 * can delegate either tier at /admin/permissions:
 *
 *   Contributor  free-form tags, attribute values
 *   Admin        certification, governed-tag assignment, Purview sync
 *
 * A tag counts as GOVERNED for tiering if the tenant vocabulary defines it
 * TODAY **or** the row being mutated already carries it with `governed: true`.
 * The row half matters: dropping a key from the vocabulary must not silently
 * demote every already-persisted governed assignment to the Contributor tier.
 *
 * Every outcome is audited on a BEST-EFFORT basis
 * (`lib/governance/uc-overlay/audit.ts`) — applied mutations with before/after
 * facts, Purview pushes, AND denials (403 authz, 400 validation). The audit
 * write deliberately never blocks or fails the primary response (the same
 * contract as `writeDomainAudit`), so a Cosmos outage degrades the trail rather
 * than the governance write: this is an attributability aid, not a guaranteed
 * tamper-evident ledger.
 *
 * DEFAULT-ON, both backends, no INFRA gate: the overlay is Cosmos-backed
 * Loom-native governance, so it works against the OSS Unity Catalog server in
 * Azure Government exactly as it does against Databricks UC — closing the
 * `UC_CAPABILITIES.tags → oss:'none'` hole without a Databricks SQL warehouse
 * (`.claude/rules/no-fabric-dependency.md`, `loom_default_on_opt_out`). The
 * tiers above are an AUTHORIZATION gate, not an infra/spend gate.
 * `POST … syncPurview:true` additionally mirrors the facts into the CLASSIC
 * Purview Data Map; when Purview is unconfigured the write still succeeds and
 * `purview.reason` names the exact missing env var (never a silent no-op).
 */
import { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiBadRequest, apiError, apiHonestError, apiOk } from '@/lib/api/respond';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { tenantScopeId } from '@/lib/auth/session';
import type { EndorsementRung } from '@/lib/dataproducts/certification';
import {
  applyOverlayMutation, assertValidFullName, defaultSecurableType, findGovernedTag,
  hasPurviewResidue, isEmptyOverlay, UcOverlayError, UC_SECURABLE_TYPES,
  type UcGovernanceOverlay, type UcOverlayMutation, type UcSecurableType,
} from '@/lib/governance/uc-overlay/model';
import {
  deleteOverlay, listColumnOverlays, listOverlays, readAttributeGroups,
  readGovernedTags, readOverlay, writeOverlay,
} from '@/lib/governance/uc-overlay/store';
import {
  overlayFacts, writeOverlayAudit, writePurviewSyncAudit, writeUcGovernanceDenial,
} from '@/lib/governance/uc-overlay/audit';
import { provenanceFromSync, syncOverlayToPurview } from '@/lib/governance/uc-overlay/purview-sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The capability the governance WRITE path is gated on. Delegable at
 *  /admin/permissions; tenant admins bypass it (feature-gate.isTenantAdmin). */
export const GOVERNANCE_CAPABILITY = 'admin.security';

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
  const who = session.claims.upn || session.claims.oid;
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
    // NOT trusted as-is despite the cast: `applyOverlayMutation` runs
    // `model.validateAttributeValues` over it, which enforces the tenant's own
    // AttributeDef fieldType/choices and hard size bounds before anything
    // reaches Cosmos (unbounded JSON here was a storage-amplification vector).
    attributes: (body.attributes ?? undefined) as UcOverlayMutation['attributes'],
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

    // ---- AUTHORIZATION (tiered; see the module docblock) -------------------
    // Elevated when the request touches a trust signal (certification), an
    // access-control input (a GOVERNED tag), or the shared tenant Purview
    // account.
    //
    // GOVERNED-NESS IS RESOLVED FROM TWO SOURCES, AND THE ROW WINS.
    // The live vocabulary alone is NOT sufficient: it is tenant-wide mutable
    // state, and one tenant-admin `POST /api/catalog/unity/governed-tags
    // {tags: []}` drops a key out of it while every already-persisted
    // `governed: true` assignment stays on its row. If the tier were derived
    // from the vocabulary only, that single save would silently demote every
    // historical governed tag to the Contributor tier — letting a Contributor
    // de-classify `pii=yes`, which is exactly the access-control input LU-6
    // compiles. `model.ts` persists `governed` per assignment PRECISELY so a
    // later vocabulary edit cannot re-characterise history; the gate has to
    // honour that flag or it contradicts the invariant it depends on.
    //
    // So `current` is read BEFORE the decision, not after.
    const current = await readOverlay(tenantId, { fullName, column, securableType });
    const touchedKeys = [
      ...(mutation.setTags || []).map((t) => t.key),
      ...(mutation.removeTagKeys || []),
    ].map((k) => String(k || '').trim().toLowerCase()).filter(Boolean);
    const touchesGoverned = touchedKeys.some(
      (k) => !!findGovernedTag(vocabulary, k)
        || (current.tags || []).some((t) => !!t.governed && (t.key || '').trim().toLowerCase() === k),
    );
    const elevated = !!mutation.certification || touchesGoverned || !!body.syncPurview;
    const requiredRole = elevated ? 'Admin' : 'Contributor';
    const denied = await enforceCapability(session, GOVERNANCE_CAPABILITY, requiredRole);
    if (denied) {
      await writeUcGovernanceDenial({
        tenantId,
        who,
        surface: 'catalog/unity/governance',
        status: 403,
        reason: `requires ${requiredRole} on ${GOVERNANCE_CAPABILITY}`
          + (elevated ? ' (certification / governed tag / Purview sync)' : ''),
        target: fullName,
        attempted: {
          fullName,
          column,
          setTags: mutation.setTags,
          removeTagKeys: mutation.removeTagKeys,
          certificationRung: mutation.certification?.rung,
          attributeIds: Object.keys((mutation.attributes || {}) as Record<string, unknown>),
          syncPurview: !!body.syncPurview,
        },
      });
      return denied;
    }
    // ------------------------------------------------------------------------

    const before = overlayFacts(current);
    let next: UcGovernanceOverlay;
    try {
      next = applyOverlayMutation(current, mutation, {
        vocabulary,
        attributeGroups,
        actorUpn: who,
      });
    } catch (e) {
      if (e instanceof UcOverlayError) {
        // A validation refusal is exactly the event a reviewer needs to see.
        await writeUcGovernanceDenial({
          tenantId, who, surface: 'catalog/unity/governance', status: e.status,
          reason: e.message, target: fullName,
          attempted: {
            setTags: mutation.setTags,
            removeTagKeys: mutation.removeTagKeys,
            certificationRung: mutation.certification?.rung,
            attributeIds: Object.keys((mutation.attributes || {}) as Record<string, unknown>),
          },
        });
      }
      throw e;
    }

    // PERSIST FIRST, then push to Purview. The reverse order leaves Purview
    // holding classifications Loom has no record of whenever the Cosmos upsert
    // fails, with no compensating action.
    //
    // The delete rule keys on RESIDUE, not on the mere presence of a `purview`
    // stamp: an ever-synced securable carries that stamp forever, so `!purview`
    // would persist exactly the hollow row the rule exists to prevent.
    const emptied = isEmptyOverlay(next) && !hasPurviewResidue(next);
    if (emptied) await deleteOverlay(tenantId, next.identity);
    else next = await writeOverlay(next);

    await writeOverlayAudit({
      tenantId, who, action: emptied ? 'overlay.delete' : 'overlay.update',
      identity: next.identity, fullName: next.fullName, securableType: next.securableType,
      before, after: overlayFacts(emptied ? null : next),
    });

    let purview;
    let deleted = emptied;
    if (body.syncPurview) {
      // `ucHost` is deliberately NOT taken from the request body. It selected the
      // destination for a call that carries a managed-identity bearer, so a caller
      // could aim a credentialed request at any host — the same class as the Key
      // Vault exfiltration closed in #2683 and the role-grant escalation in #2691.
      // syncOverlayToPurview already falls back to firstUcHost() (config-derived),
      // so removing the parameter loses no capability: it was pure convenience.
      purview = await syncOverlayToPurview(next);
      await writePurviewSyncAudit({
        tenantId, who, identity: next.identity, fullName: next.fullName,
        synced: purview.synced, reason: purview.reason, guid: purview.guid,
        classificationsAdded: purview.classifications,
        classificationsRemoved: purview.removedClassifications,
        businessMetadataKeys: purview.businessMetadataKeys,
      });
      const prov = provenanceFromSync(purview);
      if (prov) {
        // Second write: record what Purview now holds so the NEXT sync knows
        // exactly which classifications to supersede.
        next = { ...next, purview: prov };
        if (isEmptyOverlay(next) && !hasPurviewResidue(next)) {
          if (!emptied) await deleteOverlay(tenantId, next.identity);
          deleted = true;
        } else {
          next = await writeOverlay(next);
          deleted = false;
        }
      }
    }

    return apiOk({ overlay: next, ...(deleted ? { deleted: true } : {}), ...(purview ? { purview } : {}) });
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
