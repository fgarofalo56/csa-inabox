/**
 * POST /api/lakehouse/shortcuts/test
 *
 * Re-validate that a shortcut's target is reachable and update its registry
 * status. For ADLS/internal shortcuts this is a real listPaths on the Console
 * UAMI; for Tables shortcuts it additionally proves the engine object exists
 * via a SELECT TOP 1. Powers the list's Status chip + the Test action.
 *
 * Body: { lakehouseId, id }
 * Auth: session-required. Design: docs/fiab/design/lakehouse-shortcuts.md.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAccountName } from '@/lib/azure/adls-client';
import { getShortcut, updateShortcutStatus } from '@/lib/azure/lakehouse-shortcuts';
import { resolveAndTestAdls, testEngineObject, refreshDeltaSharingCredential } from '@/lib/azure/shortcut-engines';
import { networkFailureReason, redactErrorText } from '@/lib/azure/shortcut-error-hygiene';
import {
  resolveShortcutSecret,
  isShortcutSecretRefusal,
  type ShortcutSecretOwner,
} from '@/lib/azure/shortcut-secret-resolver';
import { parseAbfss as parseExternalAbfss, listAdlsWithSas, ShortcutSourceError } from '@/lib/azure/shortcut-client';
import { headDriveItem, parseSharepointUri, graphDriveConfigGate } from '@/lib/azure/graph-drive-client';
import { withSession } from '@/lib/api/route-toolkit';
import { stripTrailingSlashes } from '@/lib/util/path-strings';
import { SHARE_PROVIDER_SECRET_PREFIX } from '@/lib/azure/share-provider-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** HTML stripped, whitespace collapsed, URL query strings / credentials removed. */
function sanitize(e: any): string {
  return redactErrorText((e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 500);
}

/**
 * The response for a stored credential the shortcut-secret resolver refused.
 * The row is NOT rewritten: a refusal says the credential cannot be used for
 * this row's owner, not that the source is unreachable, and the engine objects
 * created at bind time keep serving queries either way.
 */
function secretRefused(e: any) {
  const status = e?.status === 400 ? 400 : 403;
  return NextResponse.json({ ok: false, code: e?.code || 'shortcut_secret_refused', error: sanitize(e) }, { status });
}

export const POST = withSession(async (req: NextRequest) => {

  const body = await req.json().catch(() => ({}));
  const lakehouseId = (body?.lakehouseId || '').toString().trim();
  const id = (body?.id || '').toString().trim();
  if (!lakehouseId || !id) {
    return NextResponse.json({ ok: false, error: 'lakehouseId and id are required' }, { status: 400 });
  }

  const sc = await getShortcut(lakehouseId, id);
  if (!sc) return NextResponse.json({ ok: false, error: 'shortcut not found', code: 'not_found' }, { status: 404 });
  // The stored credential is resolved on behalf of the principal who CREATED
  // this row: a row may only keep using a credential its creator owns, whoever
  // presses Test. The row's tenantId is the creator's session tenant (the create
  // route stores it), so the tenant comparison applies here too.
  const secretOwner: ShortcutSecretOwner = {
    kind: 'principal', via: 'row', oid: sc.createdByOid, upn: sc.createdBy, tid: sc.tenantId,
    lakehouseId: sc.lakehouseId, targetType: sc.targetType,
  };

  // Delta Sharing: re-validate by listing shares with the stored bearer token.
  // A 401/403 means the token is expired/invalid — the "broken" state the Retry
  // action fixes once the operator updates the Key Vault secret. For a Tables
  // shortcut on Databricks we also rewrite the credential file on the UC Volume
  // so the refreshed token reaches the underlying delta_sharing UC table, then
  // prove the table reads with a real SELECT.
  if (sc.targetType === 'delta_sharing') {
    if (!sc.credentialRef?.keyVaultSecret) {
      const updated = await updateShortcutStatus(lakehouseId, id, 'pending',
        'Delta Sharing shortcut has no credential — re-create it with a Key Vault credentialRef.');
      return NextResponse.json({ ok: true, data: updated });
    }
    try {
      const raw = (await resolveShortcutSecret(sc.credentialRef.keyVaultSecret, secretOwner)).trim();
      let profile: { endpoint?: string; bearerToken?: string; expirationTime?: string; shareCredentialsVersion?: number };
      try {
        profile = JSON.parse(raw);
      } catch {
        throw Object.assign(
          new Error(`Delta Sharing secret '${sc.credentialRef.keyVaultSecret}' is not valid credential-file JSON.`),
          { code: 'bad_delta_sharing_secret' },
        );
      }
      if (!profile.endpoint || !profile.bearerToken) {
        throw Object.assign(
          new Error(`Delta Sharing credential file in '${sc.credentialRef.keyVaultSecret}' is missing 'endpoint' or 'bearerToken'.`),
          { code: 'bad_delta_sharing_secret' },
        );
      }
      const sharesUrl = stripTrailingSlashes(profile.endpoint) + '/shares';
      let testRes: Response;
      try {
        testRes = await fetch(sharesUrl, { headers: { Authorization: `Bearer ${profile.bearerToken}` } });
      } catch (netErr: any) {
        // The endpoint comes from the stored credential file: report a symbolic
        // reason, never the URL or a transport message that may carry it.
        throw Object.assign(
          new Error(
            `Delta Sharing endpoint in the credential file '${sc.credentialRef.keyVaultSecret}' is unreachable ` +
            `(${networkFailureReason(netErr)}).`,
          ),
          { code: 'delta_sharing_unreachable' },
        );
      }
      if (testRes.status === 401 || testRes.status === 403) {
        // A loom-dsp- credential is the one Loom stored when the provider was
        // added under Data shares; adding the provider again saves a new one,
        // named from the provider name — so only the SAME name replaces the
        // credential this row binds. Remove is refused while the provider still
        // has subscribed (mounted) catalogs, so those are unmounted first.
        const fromProvider = sc.credentialRef.keyVaultSecret.toLowerCase().startsWith(SHARE_PROVIDER_SECRET_PREFIX);
        const fix = fromProvider
          ? 'Get a fresh activation file from the provider. Under Data shares → Shared with me, unmount the ' +
            "provider's subscribed catalogs (Use / manage → Unmount) — Remove is refused while they are mounted — " +
            'then Remove the provider and add it again under the SAME provider name with the new file (Add provider), ' +
            'which saves the new credential under the name this shortcut uses. Then Retry, and subscribe again if you ' +
            'still need the catalogs.'
          : 'Update the Key Vault secret with a fresh credential file from the provider, then Retry.';
        throw Object.assign(
          new Error(
            `Delta Sharing authentication failed (HTTP ${testRes.status}). The bearer token in secret ` +
            `'${sc.credentialRef.keyVaultSecret}' is invalid or expired. ${fix}`,
          ),
          { code: 'delta_sharing_auth_failure' },
        );
      }
      if (!testRes.ok) {
        throw Object.assign(
          new Error(
            `Delta Sharing endpoint in the credential file '${sc.credentialRef.keyVaultSecret}' returned HTTP ${testRes.status}.`,
          ),
          { code: 'delta_sharing_unreachable' },
        );
      }
      // Tables shortcut on Databricks: push the (possibly refreshed) token to the
      // UC Volume credential file and prove the UC table still reads.
      if (sc.kind === 'tables' && sc.engine === 'databricks' && sc.engineObject) {
        await refreshDeltaSharingCredential(lakehouseId, sc.name, {
          endpoint: profile.endpoint, bearerToken: profile.bearerToken,
          expirationTime: profile.expirationTime, shareCredentialsVersion: profile.shareCredentialsVersion,
        });
        await testEngineObject(sc.engine, sc.engineObject);
      }
      const updated = await updateShortcutStatus(lakehouseId, id, 'active', undefined);
      return NextResponse.json({ ok: true, data: updated });
    } catch (e: any) {
      if (isShortcutSecretRefusal(e)) return secretRefused(e);
      const msg = sanitize(e);
      const updated = await updateShortcutStatus(lakehouseId, id, 'error', msg);
      return NextResponse.json({ ok: false, error: msg, code: e?.code || 'delta_sharing_unreachable', data: updated }, { status: 502 });
    }
  }

  // S3 / GCS: the read-through binding is the engine object (UC external table /
  // Synapse external view). Prove it with a real SELECT TOP 1 against the engine.
  if (sc.targetType === 's3' || sc.targetType === 'gcs') {
    if (!sc.engineObject || !sc.engine || sc.engine === 'none') {
      const updated = await updateShortcutStatus(lakehouseId, id, 'pending',
        `${sc.targetType.toUpperCase()} shortcut has no engine binding yet — re-create it with a Key Vault credentialRef.`);
      return NextResponse.json({ ok: true, data: updated });
    }
    try {
      await testEngineObject(sc.engine, sc.engineObject);
      const updated = await updateShortcutStatus(lakehouseId, id, 'active', undefined);
      return NextResponse.json({ ok: true, data: updated });
    } catch (e: any) {
      const msg = sanitize(e);
      const updated = await updateShortcutStatus(lakehouseId, id, 'error', msg);
      return NextResponse.json({ ok: false, error: msg, code: e?.code || 'engine_unreachable', data: updated }, { status: 502 });
    }
  }

  // SharePoint / OneDrive: re-read the targeted drive item via Microsoft Graph
  // on the Console UAMI (HEAD-equivalent). A 404 => the document/folder moved or
  // was deleted; a 403 => the Graph app-role/consent was revoked.
  if (sc.targetType === 'sharepoint') {
    const gate = graphDriveConfigGate();
    if (gate) {
      const updated = await updateShortcutStatus(lakehouseId, id, 'pending', gate.hint.followUp);
      return NextResponse.json({ ok: false, code: gate.code, error: gate.hint.followUp, hint: gate.hint.followUp, data: updated }, { status: 503 });
    }
    const parsed = parseSharepointUri(sc.targetUri);
    if (!parsed) {
      const updated = await updateShortcutStatus(lakehouseId, id, 'error', `Invalid SharePoint target: ${sc.targetUri}`);
      return NextResponse.json({ ok: false, code: 'bad_target', error: `Invalid SharePoint target: ${sc.targetUri}`, data: updated }, { status: 400 });
    }
    try {
      await headDriveItem(parsed.driveId, parsed.path);
      const updated = await updateShortcutStatus(lakehouseId, id, 'active', undefined);
      return NextResponse.json({ ok: true, data: updated });
    } catch (e: any) {
      const msg = sanitize(e);
      const updated = await updateShortcutStatus(lakehouseId, id, 'error', msg);
      return NextResponse.json({ ok: false, error: msg, code: e?.code || 'graph_drive_error', data: updated }, { status: e?.status || 502 });
    }
  }

  // SAS-authenticated external ADLS Gen2: re-probe with the SAS (the UAMI cannot
  // reach the account). A Tables shortcut additionally proves its Synapse view.
  if (
    sc.targetType === 'adls' &&
    sc.credentialRef?.keyVaultSecret &&
    (sc.credentialRef.kind === 'sas' || sc.credentialRef.kind === 'accountKey')
  ) {
    try {
      const sas = (await resolveShortcutSecret(sc.credentialRef.keyVaultSecret, secretOwner)).trim();
      if (!sas) throw Object.assign(new Error(`Key Vault secret '${sc.credentialRef.keyVaultSecret}' is empty — re-save the SAS.`), { code: 'kv_secret_empty' });
      const parts = parseExternalAbfss(sc.abfssUri || sc.targetUri);
      await listAdlsWithSas({ account: parts.account, container: parts.container, path: parts.path, sasToken: sas, maxResults: 1 });
      if (sc.kind === 'tables' && sc.engine && sc.engine !== 'none' && sc.engineObject) {
        await testEngineObject(sc.engine, sc.engineObject);
      }
      const updated = await updateShortcutStatus(lakehouseId, id, 'active', undefined);
      return NextResponse.json({ ok: true, data: updated });
    } catch (e: any) {
      if (isShortcutSecretRefusal(e)) return secretRefused(e);
      const msg = sanitize(e);
      const updated = await updateShortcutStatus(lakehouseId, id, 'error', msg);
      const code = e instanceof ShortcutSourceError ? e.code : e?.code || 'adls_sas_error';
      return NextResponse.json({ ok: false, error: msg, code, data: updated }, { status: (e instanceof ShortcutSourceError ? e.status : 502) || 502 });
    }
  }

  // ADLS / internal / Dataverse all resolve to an abfss path read on the UAMI.
  // For Dataverse the abfssUri was set at create time from the Synapse-Link
  // linked storage; re-test reachability of that path.
  try {
    if (sc.targetType === 'dataverse') {
      if (!sc.abfssUri) {
        const updated = await updateShortcutStatus(lakehouseId, id, 'pending',
          'Dataverse shortcut has no resolved storage path yet — re-create it with a Key Vault credentialRef.');
        return NextResponse.json({ ok: true, data: updated });
      }
      await resolveAndTestAdls('adls', sc.abfssUri, getAccountName);
    } else {
      await resolveAndTestAdls(sc.targetType, sc.targetUri, getAccountName);
    }
    const updated = await updateShortcutStatus(lakehouseId, id, 'active', undefined);
    return NextResponse.json({ ok: true, data: updated });
  } catch (e: any) {
    const msg = sanitize(e);
    const updated = await updateShortcutStatus(lakehouseId, id, 'error', msg);
    return NextResponse.json({ ok: false, error: msg, code: e?.code || 'unreachable', data: updated }, { status: 502 });
  }
});
