/**
 * Loom Sharing backend for the Marketplace "Data shares" BFF (LU-9).
 *
 * The Data-shares surface has always spoken Databricks Delta Sharing. In Azure
 * Government there is no Databricks Unity Catalog endpoint at all, so the whole
 * surface was an honest 501 gate. This module is the second backend: the same
 * routes, the same response shapes, served from Loom's own share/recipient
 * record and the OSS Delta Sharing reference server.
 *
 * Selection lives in {@link sharingBackend}: Loom wins whenever the sharing
 * server is deployed (LOOM_SHARING_URL), which makes the Azure-native path the
 * DEFAULT wherever it exists, exactly as `.claude/rules/no-fabric-dependency.md`
 * requires. Databricks remains for estates that have it and no loom-sharing.
 *
 * Response shapes intentionally mirror the Unity Catalog ones the existing UI
 * already renders (`{ok, host, shares|recipients}`), with `backend:'loom'` added
 * so a surface can tell the two apart where the affordances genuinely differ
 * (a Loom recipient is Entra principals, not an activation token).
 */

import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { isLoomSharingConfigured, LoomSharingNotConfiguredError } from '@/lib/sharing/store';
import {
  listShares as listLoomShares,
  getShare as getLoomShare,
  upsertShare,
  deleteShare as deleteLoomShare,
  listRecipients as listLoomRecipients,
  getRecipient,
  upsertRecipient,
  deleteRecipient as deleteLoomRecipient,
} from '@/lib/sharing/store';
import { sharingOwnerTenantId } from '@/lib/sharing/recipient-auth';
import {
  isValidSharingName,
  isValidPrincipalId,
  isValidShareLocation,
  renderSharesManifest,
  canonicalSharingName,
  sameSharingName,
  type LoomShare,
  type LoomRecipient,
  type SharedTable,
} from '@/lib/sharing/model';

export type SharingBackend = 'loom' | 'databricks';

/** Which sharing backend this deployment uses. Explicit override first, then
 *  "is the Azure-native server deployed", then Databricks. */
export function sharingBackend(): SharingBackend {
  const explicit = (process.env.LOOM_SHARING_BACKEND || '').trim().toLowerCase();
  if (explicit === 'loom' || explicit === 'databricks') return explicit;
  return isLoomSharingConfigured() ? 'loom' : 'databricks';
}

export function isLoomSharingBackend(): boolean {
  return sharingBackend() === 'loom';
}

function badRequest(error: string): NextResponse {
  return NextResponse.json({ ok: false, error }, { status: 400 });
}

/**
 * Reads on this surface are `withSession`, so ANY signed-in user can call them.
 * Three fields in the natural payload are estate infrastructure rather than
 * catalog metadata, and are withheld unless the caller is a tenant admin:
 *
 *   host        the internal FQDN of the sharing server (an internal-ingress
 *               target whose address is not otherwise discoverable)
 *   location    the raw `abfss://` root of every published table
 *   principals  the Entra object/application ids of every external recipient
 *
 * The rest of the shape is unchanged, so the UI renders identically for a
 * non-admin; only these three are elided. Mutations were already tenant-admin —
 * this closes the read half.
 */
export type SharingViewScope = { full: boolean };

/**
 * Recipients granted this share.
 *
 * Uses {@link sameSharingName} rather than `Array#includes`, for the same reason
 * the data plane does: share names are case-insensitive identifiers, and a
 * display that disagrees with the authorization decision is how a revocation
 * gets believed. `includes` here would show "not granted" for a grant the
 * protocol path honours.
 */
function grantedTo(recipients: LoomRecipient[], shareName: string): LoomRecipient[] {
  return recipients.filter((r) => (r.shares || []).some((s) => sameSharingName(s, shareName)));
}

/** UC-shaped view of a Loom share, so the existing UI renders it unchanged. */
function toUiShare(share: LoomShare, recipients: LoomRecipient[], scope: SharingViewScope) {
  return {
    name: share.id,
    comment: share.comment,
    owner: share.createdBy,
    objects: (share.tables || []).map((t) => ({
      name: `${t.schema}.${t.name}`,
      data_object_type: 'TABLE',
      shared_as: `${t.schema}.${t.name}`,
      // Loom-only extras — the ADLS root and protocol id the UI can surface.
      ...(scope.full ? { location: t.location } : {}),
      id: t.id,
      historyShared: !!t.historyShared,
    })),
    recipients: grantedTo(recipients, share.id).map((r) => r.id),
  };
}

function toUiRecipient(r: LoomRecipient, scope: SharingViewScope) {
  return {
    name: r.id,
    // Deliberately NOT 'TOKEN': there is no activation URL and no long-lived
    // bearer profile to hand out. Saying TOKEN would imply a credential the
    // Loom backend does not mint.
    authentication_type: 'ENTRA',
    comment: r.comment,
    ...(scope.full ? { principals: r.principalIds } : { principalCount: (r.principalIds || []).length }),
    shares: r.shares,
    disabled: !!r.disabled,
  };
}

/** The sharing server FQDN is only disclosed to a tenant admin. */
function hostFor(scope: SharingViewScope): string {
  return scope.full ? (process.env.LOOM_SHARING_URL || '') : '';
}

export async function loomListShares(scope: SharingViewScope): Promise<NextResponse> {
  const tenantId = sharingOwnerTenantId();
  const [shares, recipients] = await Promise.all([listLoomShares(tenantId), listLoomRecipients(tenantId)]);
  return NextResponse.json({
    ok: true,
    backend: 'loom',
    host: hostFor(scope),
    shares: shares.map((s) => toUiShare(s, recipients, scope)),
  });
}

export async function loomCreateShare(body: any, actor: string): Promise<NextResponse> {
  // Canonical from the first line: the name is a case-insensitive identifier, so
  // the existence check, the document id and every later comparison must all be
  // looking at the same string. See lib/sharing/model.ts canonicalSharingName.
  const name = canonicalSharingName(body?.name);
  if (!isValidSharingName(name)) {
    return badRequest('Share name must be 1-63 characters of letters, digits, dash or underscore (it travels into a YAML config and a URL path).');
  }
  const tenantId = sharingOwnerTenantId();
  // Case-insensitive by construction — `Sales` and `sales` resolve to one
  // document, so this catches the collision rather than creating a second share
  // that a grant for either name would authorize.
  if (await getLoomShare(tenantId, name)) return badRequest(`A share named "${name}" already exists.`);
  const share = await upsertShare({
    id: name,
    tenantId,
    comment: body?.comment ? String(body.comment) : undefined,
    tables: [],
    createdBy: actor,
  });
  return NextResponse.json({ ok: true, backend: 'loom', share: toUiShare(share, [], { full: true }) });
}

export async function loomGetShare(rawName: string, scope: SharingViewScope): Promise<NextResponse> {
  const name = canonicalSharingName(rawName);
  const tenantId = sharingOwnerTenantId();
  const share = await getLoomShare(tenantId, name);
  if (!share) return NextResponse.json({ ok: false, error: `Share "${name}" not found.` }, { status: 404 });
  const recipients = await listLoomRecipients(tenantId);
  return NextResponse.json({
    ok: true,
    backend: 'loom',
    share: toUiShare(share, recipients, scope),
    permissions: {
      privilege_assignments: grantedTo(recipients, share.id)
        .map((r) => ({ principal: r.id, privileges: ['SELECT'] })),
    },
  });
}

/** Normalise one add-object payload into a Loom shared table, or explain why
 *  it cannot be one. The Loom backend needs an ADLS Delta root — a bare Unity
 *  Catalog three-part name has no meaning without a Databricks metastore. */
function toSharedTable(o: any): SharedTable | string {
  const schema = String(o?.schema || '').trim();
  const name = String(o?.name || '').trim();
  const location = String(o?.location || '').trim();
  if (!schema || !name) return 'Each shared table needs a schema and a name.';
  if (!isValidSharingName(schema) || !isValidSharingName(name)) {
    return `"${schema}.${name}" is not a valid share table name (letters, digits, dash, underscore).`;
  }
  if (!isValidShareLocation(location)) {
    return `"${schema}.${name}" needs an ADLS Gen2 Delta location (abfss://<container>@<account>.dfs.<suffix>/<path>). The Loom sharing backend serves Delta tables from the estate's own lake, so a Unity Catalog table name alone cannot be published.`;
  }
  const id = String(o?.id || '').trim() || randomUUID();
  return { schema, name, location, id, historyShared: !!o?.historyShared };
}

export async function loomPatchShare(rawName: string, body: any): Promise<NextResponse> {
  const name = canonicalSharingName(rawName);
  const tenantId = sharingOwnerTenantId();
  const share = await getLoomShare(tenantId, name);
  if (!share) return NextResponse.json({ ok: false, error: `Share "${name}" not found.` }, { status: 404 });

  let tables = [...(share.tables || [])];
  if (Array.isArray(body?.addObjects)) {
    for (const o of body.addObjects) {
      const t = toSharedTable(o);
      if (typeof t === 'string') return badRequest(t);
      // Re-publishing the same schema.table replaces it rather than duplicating —
      // two entries with the same name would make the rendered YAML ambiguous.
      tables = tables.filter((x) => !(x.schema === t.schema && x.name === t.name));
      tables.push(t);
    }
  }
  if (Array.isArray(body?.removeObjects)) {
    for (const o of body.removeObjects) {
      // Accept both the Loom shape ({schema,name}) and the UI's "schema.table".
      const raw = String(o?.name || '').trim();
      const schema = String(o?.schema || '').trim() || raw.split('.')[0];
      const tname = o?.schema ? raw : raw.split('.').slice(1).join('.');
      tables = tables.filter((x) => !(x.schema === schema && x.name === tname));
    }
  }
  const updated = await upsertShare({ ...share, tables });

  // Grants live on the RECIPIENT (that is the only place the sharing server
  // cannot see, and therefore the only place they are safe).
  if (Array.isArray(body?.grant) || Array.isArray(body?.revoke)) {
    for (const rn of (body.grant || []) as string[]) {
      const r = await getRecipient(tenantId, String(rn));
      if (!r) return badRequest(`Recipient "${canonicalSharingName(rn)}" does not exist.`);
      if (!r.shares.some((s) => sameSharingName(s, name))) {
        await upsertRecipient({ ...r, shares: [...r.shares, name] });
      }
    }
    for (const rn of (body.revoke || []) as string[]) {
      const r = await getRecipient(tenantId, String(rn));
      if (!r) continue;
      // Canonical compare, not `includes`/`!==`. A revocation that silently
      // matched nothing because the operator typed a different case would leave
      // the data plane — which compares case-insensitively — still serving.
      const kept = r.shares.filter((s) => !sameSharingName(s, name));
      if (kept.length !== r.shares.length) await upsertRecipient({ ...r, shares: kept });
    }
  }

  const recipients = await listLoomRecipients(tenantId);
  return NextResponse.json({
    ok: true,
    backend: 'loom',
    share: toUiShare(updated, recipients, { full: true }),
    permissions: {
      privilege_assignments: grantedTo(recipients, name)
        .map((r) => ({ principal: r.id, privileges: ['SELECT'] })),
    },
    // Publishing a table only takes effect once the server's config manifest is
    // re-applied. Say so on the response instead of letting an operator believe
    // a just-added table is already readable.
    manifestPending: true,
  });
}

export async function loomDeleteShare(rawName: string): Promise<NextResponse> {
  const name = canonicalSharingName(rawName);
  const tenantId = sharingOwnerTenantId();
  // Revoke first: a deleted share whose grants survive would silently re-grant
  // if the name were ever reused. Canonical compare, so a delete typed in a
  // different case cannot leave that orphan grant behind.
  const recipients = await listLoomRecipients(tenantId);
  for (const r of grantedTo(recipients, name)) {
    await upsertRecipient({ ...r, shares: r.shares.filter((s) => !sameSharingName(s, name)) });
  }
  await deleteLoomShare(tenantId, name);
  return NextResponse.json({ ok: true, backend: 'loom' });
}

export async function loomListRecipients(scope: SharingViewScope): Promise<NextResponse> {
  const tenantId = sharingOwnerTenantId();
  const recipients = await listLoomRecipients(tenantId);
  return NextResponse.json({
    ok: true,
    backend: 'loom',
    host: hostFor(scope),
    recipients: recipients.map((r) => toUiRecipient(r, scope)),
  });
}

export async function loomCreateRecipient(body: any, actor: string): Promise<NextResponse> {
  // Canonical for the same reason a share name is: the recipient name is the key
  // a grant, a revoke and the kill-switch are all typed against, and two records
  // differing only by case could hold the SAME Entra principal — so a DELETE or a
  // suspend would hit one of them and leave the other authorizing.
  const name = canonicalSharingName(body?.name);
  if (!isValidSharingName(name)) {
    return badRequest('Recipient name must be 1-63 characters of letters, digits, dash or underscore.');
  }
  const principals: string[] = Array.isArray(body?.principalIds)
    ? body.principalIds.map((p: unknown) => String(p).trim()).filter(Boolean)
    : String(body?.principalId || '').split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
  if (!principals.length) {
    return badRequest('A recipient needs at least one Entra principal (the object id of a guest user, or the application id of a service principal). Loom does not mint long-lived bearer profiles — recipients authenticate with Entra tokens.');
  }
  const bad = principals.find((p) => !isValidPrincipalId(p));
  if (bad) return badRequest(`"${bad}" is not a GUID. Use the Entra object id (oid) or application id.`);

  const tenantId = sharingOwnerTenantId();
  if (await getRecipient(tenantId, name)) return badRequest(`A recipient named "${name}" already exists.`);

  // ONE principal may belong to ONE recipient. Otherwise the kill-switch and
  // DELETE become unreliable in exactly the way a case-colliding name was:
  // authentication resolves to whichever record matches first, so suspending
  // "the" recipient for a principal can leave a second record still
  // authenticating it — a revocation that looks applied and is not.
  const existing = await listLoomRecipients(tenantId);
  const wanted = new Set(principals.map((p) => p.trim().toLowerCase()));
  const clash = existing.find((r) => (r.principalIds || []).some((p) => wanted.has(p.trim().toLowerCase())));
  if (clash) {
    return badRequest(
      `One of those Entra principals is already registered to recipient "${clash.id}". `
      + 'A principal belongs to exactly one recipient, so that suspending or deleting that recipient '
      + 'reliably removes its access. Grant the existing recipient the share instead, or remove the '
      + 'principal from it first.',
    );
  }

  const recipient = await upsertRecipient({
    id: name,
    tenantId,
    principalIds: principals,
    // A recipient is created with NO shares. Granting is a separate, explicit
    // act — creation must never imply access.
    shares: [],
    comment: body?.comment ? String(body.comment) : undefined,
    createdBy: actor,
  });
  return NextResponse.json({ ok: true, backend: 'loom', recipient: toUiRecipient(recipient, { full: true }) });
}

export async function loomDeleteRecipient(rawName: string): Promise<NextResponse> {
  await deleteLoomRecipient(sharingOwnerTenantId(), canonicalSharingName(rawName));
  return NextResponse.json({ ok: true, backend: 'loom' });
}

/**
 * Suspend or restore a recipient — the kill-switch write path.
 *
 * `disabled` takes effect on the NEXT protocol call: `matchRecipientByPrincipal`
 * skips disabled recipients, so the caller stops authenticating entirely while
 * its record, its grants, and its audit history survive. That is the difference
 * from DELETE, which loses the grant list and makes "what did they have?"
 * unanswerable during an incident. Tenant-admin, like every other act that
 * changes who can read estate data.
 */
export async function loomSetRecipientDisabled(rawName: string, disabled: boolean): Promise<NextResponse> {
  const name = canonicalSharingName(rawName);
  const tenantId = sharingOwnerTenantId();
  const recipient = await getRecipient(tenantId, name);
  if (!recipient) return NextResponse.json({ ok: false, error: `Recipient "${name}" not found.` }, { status: 404 });
  const updated = await upsertRecipient({ ...recipient, disabled });
  return NextResponse.json({ ok: true, backend: 'loom', recipient: toUiRecipient(updated, { full: true }) });
}

/**
 * The rendered `shares:` manifest for the reference server, plus its base64
 * form for `sharesManifestB64`.
 *
 * This is an HONEST seam, not a hidden one: the reference server reads its
 * share list from a config file at boot, so a newly published table is visible
 * to recipients only after the Container App is redeployed with the new
 * manifest. Loom surfaces the exact value to apply rather than pretending the
 * publish already took effect.
 */
export async function loomManifest(): Promise<NextResponse> {
  const shares = await listLoomShares(sharingOwnerTenantId());
  const yaml = renderSharesManifest(shares);
  return NextResponse.json({
    ok: true,
    backend: 'loom',
    yaml,
    base64: Buffer.from(yaml, 'utf-8').toString('base64'),
    shareCount: shares.length,
    tableCount: shares.reduce((n, s) => n + (s.tables?.length || 0), 0),
    apply:
      'Redeploy platform/fiab/bicep/modules/compute/loom-sharing-app.bicep with sharesManifestB64=<base64> (or az containerapp update --set-env-vars LOOM_SHARING_SHARES_B64=<base64>). The reference server reads its share list at boot, so published tables become readable on the next revision.',
  });
}

/** Map a Loom-backend failure to a response. Keeps the honest gate typed. */
export function loomSharingErrorResponse(e: unknown): NextResponse | null {
  if (e instanceof LoomSharingNotConfiguredError) {
    return NextResponse.json(
      {
        ok: false,
        gated: true,
        backend: 'loom',
        error: e.message,
        hint: e.hint.followUp,
        missing: e.hint.missingEnvVar,
        bicepModule: e.hint.bicepModule,
      },
      { status: 501 },
    );
  }
  return null;
}
