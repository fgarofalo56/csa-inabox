/**
 * Unity Catalog WRITE — grants (permissions on a securable). Backend-aware:
 * the same route serves Databricks Unity Catalog (Commercial default) AND the
 * self-hosted OSS Unity Catalog server (loom-unity, the Azure-Government
 * default) — both implement GET/PATCH /permissions/{securable_type}/{full_name}.
 *
 *   GET   /api/databricks/unity-catalog/grants?securable_type=SCHEMA&full_name=main.sales
 *           [&effective=true][&principal=ada@contoso.com]
 *           → { ok, effective, grants: [{ principal, privileges }], warnings?, principalClosure? }
 *   PATCH /api/databricks/unity-catalog/grants
 *           body { securable_type, full_name, changes: [{ principal, add?, remove? }] }
 *           → { ok, grants }
 *
 * Real Unity Catalog REST (api 2.1, both backends):
 *   GET   /api/2.1/unity-catalog/permissions/{securable_type}/{full_name}
 *   PATCH /api/2.1/unity-catalog/permissions/{securable_type}/{full_name}
 * Learn: https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/manage-privileges/
 * OSS spec: github.com/unitycatalog/unitycatalog api/all.yaml (permissions family)
 *
 * `effective=true` works on BOTH backends (LU-4). Databricks answers with its
 * native `GET /effective-permissions/...`; on the OSS backend the client
 * resolves the inheritance walk in-process from the direct grants + owners of
 * the containment chain, so there is no Databricks-only gate here any more.
 * Add `principal=` to ask "what can THIS principal actually do here?" — that
 * form additionally unions in the principal's transitive Entra group
 * membership, and reports honestly (`warnings[]`) if any of it was unreadable.
 *
 * AUTHORIZATION (LU-4 remediation). The `principal=` form resolves that
 * principal's directory membership through the Console UAMI's Graph app role,
 * which makes it a directory-membership oracle if left on `withSession` alone.
 * It is therefore restricted to a **tenant admin** or to the caller asking
 * about ITSELF (`lib/auth/uc-principal-probe.ts`); anything else is a 403
 * `principal_probe_forbidden`. EVERY effective query — allowed and denied —
 * writes a `uc-access-review` audit row (`lib/azure/uc-access-review-audit.ts`)
 * so an enumeration sweep cannot run untraced.
 *
 * AUTHORIZATION — PATCH (#2692). `withSession` is the AUTHENTICATION wrapper:
 * it admits any signed-in tenant user. This PATCH calls `updatePermissions`,
 * i.e. it rewrites WHO HOLDS WHICH PRIVILEGE on a Unity Catalog securable — a
 * privilege-escalation primitive if it is only authenticated. It is now
 * **tenant-admin** gated (`requireTenantAdmin`, the same check `withTenantAdmin`
 * runs, byte-compatible 403 `admin_only` envelope). UC securables are
 * METASTORE-scoped, so there is no owning Loom workspace to scope to and
 * tenant-admin is the only coherent scope. The gate runs BEFORE the Databricks
 * config gate and before the body is trusted, so a non-admin learns nothing
 * about the deployment's configuration. Both outcomes are audited: the DENIAL
 * here (a refusal never reaches a transport, so this is the only place it can
 * be recorded) and the APPLIED change, which additionally lands on the LU-3
 * choke point as `grant.update` with the upstream outcome.
 *
 * Console UAMI must be the object owner / metastore admin / have MANAGE on the
 * securable (else UC 403s, surfaced verbatim).
 */

import { NextRequest, NextResponse } from 'next/server';
import { databricksConfigGate } from '@/lib/azure/databricks-client';
import { isOssUc } from '@/lib/azure/uc-backend';
import {
  formatUcPrivilege, isUcPrivilegeRevocableHere, isUcPrivilegeBlocked,
  type UcEffectivePrivilege, type UcUsagePrerequisite,
} from '@/lib/azure/uc-effective-permissions';
import { isTenantAdmin, requireTenantAdmin } from '@/lib/auth/feature-gate';
import { decidePrincipalProbe } from '@/lib/auth/uc-principal-probe';
import { auditUcAccessReview } from '@/lib/azure/uc-access-review-audit';
import {
  primaryWorkspaceHost, listPermissions, listEffectivePermissions, updatePermissions,
  type UCSecurableType, type UCPermissionAssignment,
} from '@/lib/azure/unity-catalog-client';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SECURABLES = new Set<UCSecurableType>([
  'CATALOG', 'SCHEMA', 'TABLE', 'VOLUME', 'FUNCTION', 'REGISTERED_MODEL',
  'EXTERNAL_LOCATION', 'STORAGE_CREDENTIAL', 'METASTORE',
]);

function gate() {
  // On the OSS backend there is no Databricks dependency — the client routes to
  // LOOM_UNITY_URL and throws its own structured gate when that is unset.
  if (isOssUc()) return null;
  const g = databricksConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Databricks workspace not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

/** One privilege as the pane consumes it: the structured provenance AND the
 *  display string it belongs to, in ONE object. `privileges[i]` and `detail[i]`
 *  used to be built from two DIFFERENT filters over the same raw array (`.map()
 *  .filter(Boolean)` vs `.filter(typeof === 'object')`), so a single string
 *  entry or an entry that formatted to `''` shifted every later index and a
 *  BLOCKED privilege could render brand-tinted "granted here". They are now the
 *  same list, built once. */
interface GrantPrivilegeOut extends UcEffectivePrivilege {
  /** The annotated display text — identical to the matching `privileges[i]`. */
  display: string;
  revocableHere: boolean;
  blocked: boolean;
}

/** One row as the pane consumes it: the display strings (unchanged wire
 *  contract) PLUS the structured provenance. The pane tints badges and decides
 *  revocability from `detail[]`, never by re-parsing the display text — a
 *  securable literally named `owner` used to mis-tint, and a `via <group>` row
 *  used to look locally revocable. `detail.length === privileges.length` and
 *  `detail[i].display === privileges[i]` always. */
interface GrantRowOut {
  principal: string;
  privileges: string[];
  detail: GrantPrivilegeOut[];
  usage?: UcUsagePrerequisite[];
}

type RawAssignment = {
  principal: string;
  privileges?: unknown[];
  usage?: UcUsagePrerequisite[];
};

function grantsOf(p: { privilege_assignments?: RawAssignment[] }): GrantRowOut[] {
  return (p.privilege_assignments || []).map((a) => {
    // One formatter for every shape: OSS spells privileges "USE CATALOG" and
    // Databricks "USE_CATALOG" (both normalized to the UI's underscore form),
    // while effective rows arrive as { privilege, inherited_from_type, … }
    // objects from either the Databricks endpoint or the Loom resolver. A plain
    // string (the direct-grants shape) becomes a minimal structured entry, so
    // the two arrays are ALWAYS the same length and the same order.
    const detail: GrantPrivilegeOut[] = (a.privileges || []).flatMap((v) => {
      const display = formatUcPrivilege(v);
      if (!display) return [];
      const structured: UcEffectivePrivilege = (v && typeof v === 'object')
        ? (v as UcEffectivePrivilege)
        : { privilege: display };
      return [{
        ...structured,
        display,
        revocableHere: isUcPrivilegeRevocableHere(structured),
        blocked: isUcPrivilegeBlocked(structured),
      }];
    });
    return {
      principal: a.principal,
      privileges: detail.map((d) => d.display),
      detail,
      ...(a.usage?.length ? { usage: a.usage } : {}),
    };
  });
}

export const GET = withSession(async (req: NextRequest, { session }) => {
  const g = gate(); if (g) return g;
  const securableType = (req.nextUrl.searchParams.get('securable_type') || '').toUpperCase().trim() as UCSecurableType;
  const fullName = req.nextUrl.searchParams.get('full_name')?.trim();
  const effective = req.nextUrl.searchParams.get('effective') === 'true';
  const principal = (req.nextUrl.searchParams.get('principal') || '').trim();
  if (!SECURABLES.has(securableType)) {
    return NextResponse.json({ ok: false, error: `securable_type must be one of ${[...SECURABLES].join(', ')}` }, { status: 400 });
  }
  if (!fullName && securableType !== 'METASTORE') {
    return NextResponse.json({ ok: false, error: 'full_name is required' }, { status: 400 });
  }

  // Directory-enumeration guard: probing a principal that is not you resolves
  // ITS Entra group membership with the platform identity, so it is tenant-admin
  // only. The denial is audited too — a silent 403 tells no one an enumeration
  // sweep is in progress.
  if (effective && principal) {
    const decision = decidePrincipalProbe(session, principal, isTenantAdmin(session));
    if (!decision.allowed) {
      void auditUcAccessReview(session, {
        securableType, securableName: fullName || '', effective: true,
        probedPrincipal: principal, decision: 'denied-principal-probe', nowIso: new Date().toISOString(),
      });
      return NextResponse.json(
        { ok: false, error: 'forbidden', code: 'principal_probe_forbidden', reason: decision.reason, remediation: decision.remediation },
        { status: 403 },
      );
    }
  }

  try {
    const host = await primaryWorkspaceHost();
    if (effective) {
      // Works on BOTH backends: native on Databricks, BFF-resolved inheritance
      // walk on the OSS / Loom Unity backend (LU-4).
      const p = await listEffectivePermissions(host, securableType, fullName || '', principal ? { principal } : undefined);
      const grants = grantsOf(p);
      void auditUcAccessReview(session, {
        securableType, securableName: fullName || '', effective: true,
        ...(principal ? { probedPrincipal: principal } : {}),
        decision: 'allowed', resultPrincipals: grants.length,
        ...(p.principal_closure ? { closureSize: p.principal_closure.length } : {}),
        nowIso: new Date().toISOString(),
      });
      return NextResponse.json({
        ok: true,
        effective: true,
        grants,
        ...(p.warnings?.length ? { warnings: p.warnings } : {}),
        ...(p.principal_closure ? { principalClosure: p.principal_closure } : {}),
        // Whether the closure was ACTUALLY resolved from the directory. The pane
        // must not assert "nor through any group it belongs to" off a closure
        // that is just [principal] because Graph was unavailable.
        ...(p.principal_closure ? { closureResolved: p.closure_resolved === true } : {}),
        // #2651 — the owner, read alongside the Databricks passthrough (whose
        // effective-permissions answer never includes ownership). No new
        // exposure: the securable's `owner` is already on every catalogs /
        // schemas / tables list this same session can read, and this response
        // already carries the full principal→privilege graph for the securable.
        ...(p.owner ? { owner: p.owner } : {}),
        ...(p.owner_unreadable ? { ownerUnreadable: true } : {}),
        ...(principal ? { principal } : {}),
      });
    }
    const p = await listPermissions(host, securableType, fullName || '');
    return NextResponse.json({ ok: true, effective: false, grants: grantsOf(p) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
});

/** What a REFUSED grant mutation was trying to do, for the denial audit row.
 *  Every field is BOUNDED and derived, never a copy of the caller's JSON: the
 *  securable type is snapped to the validated enum, and the rest are counts.
 *  The 403 branch runs before any request validation and `withSession` applies
 *  no rate limit, so an ungranted caller must not be able to drive arbitrary
 *  text into the shared audit container (the amplification defect #2607's
 *  round-3 fixed on the sibling governance trail; `securableName` is bounded a
 *  second time at the sink). Parsing NEVER throws — a refusal is still audited
 *  when the body is garbage. */
async function attemptedGrantChange(req: NextRequest): Promise<{
  securableType: string; fullName: string;
  changedPrincipals: number; privilegesAdded: number; privilegesRemoved: number;
}> {
  const empty = { securableType: '(unparsed)', fullName: '', changedPrincipals: 0, privilegesAdded: 0, privilegesRemoved: 0 };
  let body: any;
  try { body = await req.json(); } catch { return empty; }
  const rawType = String(body?.securable_type || '').toUpperCase().trim();
  const all = Array.isArray(body?.changes) ? body.changes : [];
  // Count every entry, but only WALK a bounded prefix — a refusal must not do
  // O(caller-chosen) work per request on an ungated path.
  const scanned = all.slice(0, 1000);
  const lenOf = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  return {
    securableType: SECURABLES.has(rawType as UCSecurableType) ? rawType : '(invalid)',
    fullName: String(body?.full_name ?? '').trim(),
    changedPrincipals: all.length,
    privilegesAdded: scanned.reduce((n: number, c: any) => n + lenOf(c?.add), 0),
    privilegesRemoved: scanned.reduce((n: number, c: any) => n + lenOf(c?.remove), 0),
  };
}

export const PATCH = withSession(async (req: NextRequest, { session }) => {
  // AUTHORIZATION FIRST — this rewrites the grant graph. Before the config gate
  // (a non-admin must not learn the deployment's Databricks state) and before
  // the body is trusted. `requireTenantAdmin` is the exact check
  // `withTenantAdmin` runs; it is inlined here ONLY so the refusal can be
  // audited, which a wrapper short-circuit cannot do.
  const refused = requireTenantAdmin(session);
  if (refused) {
    const attempt = await attemptedGrantChange(req);
    void auditUcAccessReview(session, {
      securableType: attempt.securableType, securableName: attempt.fullName,
      effective: false, decision: 'denied-grant-change',
      changedPrincipals: attempt.changedPrincipals,
      privilegesAdded: attempt.privilegesAdded,
      privilegesRemoved: attempt.privilegesRemoved,
      nowIso: new Date().toISOString(),
    });
    return refused;
  }
  const g = gate(); if (g) return g;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const securableType = String(body?.securable_type || '').toUpperCase().trim() as UCSecurableType;
  const fullName = String(body?.full_name || '').trim();
  const rawChanges = Array.isArray(body?.changes) ? body.changes : [];
  if (!SECURABLES.has(securableType)) {
    return NextResponse.json({ ok: false, error: `securable_type must be one of ${[...SECURABLES].join(', ')}` }, { status: 400 });
  }
  if (!fullName && securableType !== 'METASTORE') {
    return NextResponse.json({ ok: false, error: 'full_name is required' }, { status: 400 });
  }
  if (rawChanges.length === 0) {
    return NextResponse.json({ ok: false, error: 'changes[] is required' }, { status: 400 });
  }
  // The OSS server expects space-separated privilege spellings ("USE CATALOG");
  // Databricks accepts the underscore form. Normalize per backend.
  const oss = isOssUc();
  const norm = (p: any) => {
    const v = String(p).toUpperCase().trim();
    return oss ? v.replace(/_/g, ' ') : v.replace(/ /g, '_');
  };
  const add: UCPermissionAssignment[] = [];
  const remove: UCPermissionAssignment[] = [];
  for (const c of rawChanges) {
    const principal = String(c?.principal || '').trim();
    if (!principal) continue;
    const a = Array.isArray(c?.add) ? c.add.map(norm).filter(Boolean) : [];
    const r = Array.isArray(c?.remove) ? c.remove.map(norm).filter(Boolean) : [];
    if (a.length) add.push({ principal, privileges: a });
    if (r.length) remove.push({ principal, privileges: r });
  }
  if (!add.length && !remove.length) {
    return NextResponse.json({ ok: false, error: 'each change needs a principal and at least one add/remove privilege' }, { status: 400 });
  }
  try {
    const host = await primaryWorkspaceHost();
    const p = await updatePermissions(host, securableType, fullName, { add, remove });
    // The APPLIED change. The upstream REST call itself is on the LU-3 choke
    // point (`grant.update`); this row is the AUTHORIZATION decision, and pairs
    // with the denial row above so both halves of the gate are visible in one
    // place.
    void auditUcAccessReview(session, {
      securableType, securableName: fullName,
      effective: false, decision: 'allowed-grant-change',
      changedPrincipals: new Set([...add, ...remove].map((c) => c.principal)).size,
      privilegesAdded: add.reduce((n, c) => n + c.privileges.length, 0),
      privilegesRemoved: remove.reduce((n, c) => n + c.privileges.length, 0),
      nowIso: new Date().toISOString(),
    });
    return NextResponse.json({ ok: true, grants: grantsOf(p) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
});
