/**
 * POST /api/items/dataverse-table/[id]/columns?envId=<env>
 *   id = table LogicalName (e.g. "account", "new_invoice").
 *   body = AddColumnSpec { schemaName, displayName, attributeType, requiredLevel?,
 *          description?, maxLength?, precision?, integerFormat?, dateTimeFormat? }
 *
 * Creates a real column on the Dataverse table via the Web API
 * (POST EntityDefinitions(...)/Attributes). Surfaces 401/403/4xx with a precise
 * remediation hint (Dataverse SP must be an Application User with a customizing
 * role). Azure-native default — no Fabric / Power BI dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  addColumn, dataverseConfigGate, PowerPlatformError,
  type AddColumnSpec, type DataverseColumnType,
} from '@/lib/azure/powerplatform-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TYPES: DataverseColumnType[] = ['String', 'Memo', 'Integer', 'Decimal', 'Money', 'Boolean', 'DateTime'];

function err(e: any) {
  const status = e instanceof PowerPlatformError ? e.status : 502;
  return NextResponse.json(
    { ok: false, error: e?.message || String(e), hint: e?.hint, endpoint: e?.endpoint, body: e?.body },
    { status },
  );
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const envId = req.nextUrl.searchParams.get('envId');
  if (!envId) return NextResponse.json({ ok: false, error: 'envId query param required' }, { status: 400 });

  // Honest config gate — column write needs the dedicated Dataverse SP.
  const gate = dataverseConfigGate();
  if (gate) {
    return NextResponse.json(
      {
        ok: false, code: 'not_configured',
        error: `Dataverse write not configured — ${gate.missing} is unset.`,
        hint: 'Set LOOM_DATAVERSE_CLIENT_ID / LOOM_DATAVERSE_CLIENT_SECRET / LOOM_DATAVERSE_TENANT_ID and register that SP as a Dataverse Application User with the System Administrator (or System Customizer) role on this environment.',
      },
      { status: 503 },
    );
  }

  let body: any;
  try { body = await req.json(); } catch { body = null; }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'JSON body required' }, { status: 400 });
  }
  const { schemaName, displayName, attributeType } = body;
  if (!schemaName || typeof schemaName !== 'string') {
    return NextResponse.json({ ok: false, error: 'schemaName is required' }, { status: 400 });
  }
  if (!displayName || typeof displayName !== 'string') {
    return NextResponse.json({ ok: false, error: 'displayName is required' }, { status: 400 });
  }
  if (!TYPES.includes(attributeType)) {
    return NextResponse.json({ ok: false, error: `attributeType must be one of: ${TYPES.join(', ')}` }, { status: 400 });
  }

  const spec: AddColumnSpec = {
    schemaName: schemaName.trim(),
    displayName: displayName.trim(),
    attributeType,
    requiredLevel: body.requiredLevel,
    description: typeof body.description === 'string' ? body.description.trim() || undefined : undefined,
    maxLength: typeof body.maxLength === 'number' ? body.maxLength : undefined,
    precision: typeof body.precision === 'number' ? body.precision : undefined,
    integerFormat: body.integerFormat,
    dateTimeFormat: body.dateTimeFormat,
  };

  try {
    const result = await addColumn(envId, (await ctx.params).id, spec);
    return NextResponse.json({ ok: true, envId, metadataId: result.metadataId, entityId: result.entityId });
  } catch (e: any) { return err(e); }
}
