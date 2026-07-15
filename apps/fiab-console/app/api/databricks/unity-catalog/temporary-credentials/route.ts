/**
 * Unity Catalog TEMPORARY CREDENTIAL VENDING — backend-aware.
 *
 *   POST /api/databricks/unity-catalog/temporary-credentials
 *     body { kind: 'table',  table_id,  operation: 'READ'|'READ_WRITE' }
 *          { kind: 'volume', volume_id, operation: 'READ_VOLUME'|'WRITE_VOLUME' }
 *          { kind: 'path',   url,       operation: 'PATH_READ'|'PATH_READ_WRITE'|'PATH_CREATE_TABLE' }
 *     → { ok, credential: { expiration_time, azure_user_delegation_sas?, url?, … } }
 *
 * Real Unity Catalog REST (api 2.1, both backends):
 *   POST /api/2.1/unity-catalog/temporary-table-credentials
 *   POST /api/2.1/unity-catalog/temporary-volume-credentials
 *   POST /api/2.1/unity-catalog/temporary-path-credentials
 * Learn: https://learn.microsoft.com/azure/databricks/external-access/credential-vending
 * OSS spec: github.com/unitycatalog/unitycatalog api/all.yaml (temporary credentials)
 *
 * Honest gate: on OSS, vending needs the loom-unity LOOM_UNITY_ADLS_* service
 * principal (else the server errors — surfaced verbatim with the remediation);
 * on Databricks, external-data-access must be enabled on the metastore.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate } from '@/lib/azure/databricks-client';
import { isOssUc } from '@/lib/azure/uc-backend';
import {
  primaryWorkspaceHost, vendTableCredentials, vendVolumeCredentials, vendPathCredentials,
} from '@/lib/azure/unity-catalog-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TABLE_OPS = new Set(['READ', 'READ_WRITE']);
const VOLUME_OPS = new Set(['READ_VOLUME', 'WRITE_VOLUME']);
const PATH_OPS = new Set(['PATH_READ', 'PATH_READ_WRITE', 'PATH_CREATE_TABLE']);

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!isOssUc()) {
    const g = databricksConfigGate();
    if (g) {
      return NextResponse.json(
        { ok: false, code: 'not_configured', error: `Databricks workspace not configured: set ${g.missing}.`, missing: g.missing },
        { status: 503 },
      );
    }
  }
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const kind = String(body?.kind || '').toLowerCase().trim();
  const operation = String(body?.operation || '').toUpperCase().trim();
  try {
    const host = await primaryWorkspaceHost();
    if (kind === 'table') {
      const tableId = String(body?.table_id || '').trim();
      if (!tableId) return NextResponse.json({ ok: false, error: 'table_id is required' }, { status: 400 });
      if (!TABLE_OPS.has(operation)) return NextResponse.json({ ok: false, error: `operation must be one of ${[...TABLE_OPS].join(', ')}` }, { status: 400 });
      const credential = await vendTableCredentials(host, tableId, operation as 'READ' | 'READ_WRITE');
      return NextResponse.json({ ok: true, credential });
    }
    if (kind === 'volume') {
      const volumeId = String(body?.volume_id || '').trim();
      if (!volumeId) return NextResponse.json({ ok: false, error: 'volume_id is required' }, { status: 400 });
      if (!VOLUME_OPS.has(operation)) return NextResponse.json({ ok: false, error: `operation must be one of ${[...VOLUME_OPS].join(', ')}` }, { status: 400 });
      const credential = await vendVolumeCredentials(host, volumeId, operation as 'READ_VOLUME' | 'WRITE_VOLUME');
      return NextResponse.json({ ok: true, credential });
    }
    if (kind === 'path') {
      const url = String(body?.url || '').trim();
      if (!url) return NextResponse.json({ ok: false, error: 'url is required (abfss://…)' }, { status: 400 });
      if (!PATH_OPS.has(operation)) return NextResponse.json({ ok: false, error: `operation must be one of ${[...PATH_OPS].join(', ')}` }, { status: 400 });
      const credential = await vendPathCredentials(host, url, operation as 'PATH_READ' | 'PATH_READ_WRITE' | 'PATH_CREATE_TABLE');
      return NextResponse.json({ ok: true, credential });
    }
    return NextResponse.json({ ok: false, error: "kind must be 'table', 'volume', or 'path'" }, { status: 400 });
  } catch (e: any) {
    const msg = e?.message || String(e);
    // Vending needs server-side cloud credentials — name the exact remediation.
    const hint = isOssUc()
      ? ' If this is a vending-config error, set LOOM_UNITY_ADLS_ACCOUNT/_TENANT/_CLIENT_ID/_CLIENT_SECRET on the loom-unity Container App (docs/fiab/unity-gov.md).'
      : ' If external data access is disabled, enable "External data access" on the Unity Catalog metastore (Databricks account console).';
    return NextResponse.json({ ok: false, error: msg + hint }, { status: e?.status || 502 });
  }
}
