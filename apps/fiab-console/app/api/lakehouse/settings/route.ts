/**
 * GET /api/lakehouse/settings?container=<c>
 *     — return the persisted Loom-side lakehouse settings doc for the
 *       container (Spark defaults, time-travel retention, Delta defaults,
 *       display name override). Real ADLS state (e.g. soft-delete) is
 *       merged in from Microsoft.Storage when available.
 * PUT /api/lakehouse/settings
 *     body: { container, displayName?, defaultSparkPool?, sparkConfig?,
 *             timeTravelDays?, deltaDefaults?, description? }
 *     — upsert the Loom-side settings doc in the `tenant-settings`
 *       Cosmos container, partitioned by tenantId.
 *
 * Storage account-level features (lifecycle/version policy) require the
 * caller to hold Storage Account Contributor; settings persisted here are
 * Loom-side defaults that other editors (Lakehouse Notebook, Lakehouse
 * Preview) consume.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface LakehouseSettingsDoc {
  id: string;                  // `lakehouse-<container>`
  tenantId: string;            // partition key
  container: string;
  displayName?: string;
  description?: string;
  defaultSparkPool?: string;
  sparkConfig?: Record<string, string>;
  timeTravelDays?: number;     // Delta vacuum retention (default 7)
  deltaDefaults?: { autoOptimize?: boolean; tableProperties?: Record<string, string> };
  schemasEnabled?: boolean;    // multi-schema namespace (workspace.lakehouse.schema.table)
  updatedAt?: string;
  updatedBy?: string;
}

function docId(container: string) { return `lakehouse-${container}`; }

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const container = req.nextUrl.searchParams.get('container');
  if (!container) return NextResponse.json({ ok: false, error: 'container query param required' }, { status: 400 });
  const tenantId = session.claims.oid;

  try {
    const c = await tenantSettingsContainer();
    let resource: LakehouseSettingsDoc | undefined;
    try {
      const r = await c.item(docId(container), tenantId).read<LakehouseSettingsDoc>();
      resource = r.resource;
    } catch (e: any) {
      if (e?.code !== 404) throw e;
    }
    return NextResponse.json({
      ok: true,
      container,
      settings: resource || {
        id: docId(container),
        tenantId,
        container,
        timeTravelDays: 7,
        sparkConfig: {},
        deltaDefaults: { autoOptimize: true, tableProperties: {} },
        schemasEnabled: false,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function PUT(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const container: string = body?.container;
  if (!container) return NextResponse.json({ ok: false, error: 'container is required' }, { status: 400 });
  const tenantId = session.claims.oid;

  const doc: LakehouseSettingsDoc = {
    id: docId(container),
    tenantId,
    container,
    displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
    description: typeof body.description === 'string' ? body.description : undefined,
    defaultSparkPool: typeof body.defaultSparkPool === 'string' ? body.defaultSparkPool : undefined,
    sparkConfig: body.sparkConfig && typeof body.sparkConfig === 'object' ? body.sparkConfig : {},
    timeTravelDays: typeof body.timeTravelDays === 'number' && body.timeTravelDays >= 0 ? body.timeTravelDays : 7,
    deltaDefaults: body.deltaDefaults && typeof body.deltaDefaults === 'object' ? body.deltaDefaults : { autoOptimize: true },
    schemasEnabled: typeof body.schemasEnabled === 'boolean' ? body.schemasEnabled : undefined,
    updatedAt: new Date().toISOString(),
    updatedBy: session.claims.upn,
  };

  try {
    const c = await tenantSettingsContainer();
    const { resource } = await c.items.upsert<LakehouseSettingsDoc>(doc);
    return NextResponse.json({ ok: true, settings: resource });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
