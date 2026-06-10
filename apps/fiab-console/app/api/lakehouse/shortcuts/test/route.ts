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
import { getSession } from '@/lib/auth/session';
import { getAccountName } from '@/lib/azure/adls-client';
import { getShortcut, updateShortcutStatus } from '@/lib/azure/lakehouse-shortcuts';
import { resolveAndTestAdls, testEngineObject, refreshDeltaSharingCredential } from '@/lib/azure/shortcut-engines';
import { getKeyVaultSecret } from '@/lib/azure/shortcut-credentials';
import { testGraphTarget } from '@/lib/azure/sharepoint-graph-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sanitize(e: any): string {
  return (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const lakehouseId = (body?.lakehouseId || '').toString().trim();
  const id = (body?.id || '').toString().trim();
  if (!lakehouseId || !id) {
    return NextResponse.json({ ok: false, error: 'lakehouseId and id are required' }, { status: 400 });
  }

  const sc = await getShortcut(lakehouseId, id);
  if (!sc) return NextResponse.json({ ok: false, error: 'shortcut not found', code: 'not_found' }, { status: 404 });

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
      const raw = (await getKeyVaultSecret(sc.credentialRef.keyVaultSecret)).trim();
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
      const sharesUrl = profile.endpoint.replace(/\/+$/, '') + '/shares';
      const testRes = await fetch(sharesUrl, { headers: { Authorization: `Bearer ${profile.bearerToken}` } });
      if (testRes.status === 401 || testRes.status === 403) {
        throw Object.assign(
          new Error(
            `Delta Sharing authentication failed (HTTP ${testRes.status}). The bearer token in secret ` +
            `'${sc.credentialRef.keyVaultSecret}' is invalid or expired. Update the Key Vault secret with a ` +
            `fresh credential file from the provider, then Retry.`,
          ),
          { code: 'delta_sharing_auth_failure' },
        );
      }
      if (!testRes.ok) {
        throw Object.assign(new Error(`Delta Sharing endpoint unreachable (HTTP ${testRes.status}): ${sharesUrl}`), { code: 'delta_sharing_unreachable' });
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
      const msg = sanitize(e);
      const updated = await updateShortcutStatus(lakehouseId, id, 'error', msg);
      return NextResponse.json({ ok: false, error: msg, code: e?.code || 'delta_sharing_unreachable', data: updated }, { status: 502 });
    }
  }

  // SharePoint / OneDrive: re-validate the Graph drive folder is reachable on the
  // Console UAMI app token (Sites.Read.All + Files.Read.All). A 401/403 => the
  // AppRole grants/consent were revoked; a 404 => the folder moved/was deleted.
  if (sc.targetType === 'sharepoint' || sc.targetType === 'onedrive') {
    try {
      await testGraphTarget(sc.targetUri);
      const updated = await updateShortcutStatus(lakehouseId, id, 'active', undefined);
      return NextResponse.json({ ok: true, data: updated });
    } catch (e: any) {
      const msg = sanitize(e);
      const updated = await updateShortcutStatus(lakehouseId, id, 'error', msg);
      const status = typeof e?.status === 'number' ? e.status : 502;
      return NextResponse.json({ ok: false, error: msg, code: e?.code || 'sharepoint_unreachable', data: updated }, { status });
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
}
