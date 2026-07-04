/**
 * POST /api/governance/scans/register-existing
 * ---------------------------------------------
 * Register a Microsoft Purview Data Map **scan source** from an Azure resource
 * the signed-in user already reached via the cross-subscription Resource Graph
 * browser (GET /api/azure/connectables). This is the "Add existing (browse my
 * subscriptions)" path on /governance/scans — it ties the strong ARG discovery
 * already wired for /connections to the Purview scanning plane.
 *
 * Body: {
 *   resourceId:   string   // full ARM id (non-secret provenance, for the record)
 *   name:         string   // Purview source name
 *   connType?:    ConnectionType   // preferred: derive kind + endpoint via the
 *                                  // shared purview-source-map (ADLS→AdlsGen2,
 *                                  // Azure SQL→AzureSqlDatabase, Synapse, Cosmos,
 *                                  // PostgreSQL, ADX, Databricks/UC)
 *   kind?:        string   // explicit Purview source kind (when connType absent)
 *   endpoint?:    string   // explicit endpoint (when connType absent)
 *   host?, database?, resourceName?, subscriptionId?, resourceGroup?, location?,
 *   metastoreId?: string   // required for AzureDatabricksUnityCatalog
 *   defineScan?:  boolean  // also upsert a System-ruleset scan (best-effort)
 *   collectionName?: string
 * }
 *
 * Backend: real Purview scanning REST via registerDataSource() (+ best-effort
 * upsertScan()) — no mocks. Honest gates per no-vaporware.md:
 *   - LOOM_PURVIEW_ACCOUNT unset → PurviewNotConfiguredError → 501 + hint.
 *   - EH/SB/Key Vault (non-scannable) → 400 + actionable reason.
 *   - 401/403 from the data plane → surfaced with the upstream status.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import {
  registerDataSource, upsertScan,
  PurviewNotConfiguredError, PurviewError,
} from '@/lib/azure/purview-client';
import {
  purviewSourceForConnectable, isUnsupportedPurviewSource,
  type PurviewSourceInput,
} from '@/lib/azure/purview-source-map';
import type { ConnectionType } from '@/lib/azure/connections-store';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Purview source names allow letters/digits/-/_; squash everything else. */
function sanitizeSourceName(raw: string): string {
  return (raw || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'source';
}

const CONN_TYPES: ConnectionType[] = [
  'azure-sql', 'synapse-dedicated', 'synapse-serverless', 'databricks-sql',
  'postgres', 'storage-adls', 'cosmos', 'generic-sql', 'adx',
  'event-hub', 'service-bus', 'key-vault',
];

export async function POST(req: NextRequest) {
  const session = getSession();
  const denied = requireTenantAdmin(session);
  if (denied) return denied;

  const body = await req.json().catch(() => ({} as any));
  const rawName = String(body?.name || '').trim();
  if (!rawName) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  const sourceName = sanitizeSourceName(rawName);

  const connType: ConnectionType | undefined =
    CONN_TYPES.includes(body?.connType) ? (body.connType as ConnectionType) : undefined;

  // Resolve { kind, endpoint, properties, scanRulesetName }. Preferred path:
  // derive everything from the connType via the shared map (1:1 with the
  // /connections "Add existing" mapping). Fallback: explicit kind + endpoint.
  let kind: string;
  let endpoint: string;
  let properties: Record<string, unknown>;
  let scanRulesetName: string;

  if (connType) {
    const mapInput: PurviewSourceInput = {
      connType,
      host: body?.host || body?.endpoint || undefined,
      database: body?.database || undefined,
      subscriptionId: body?.subscriptionId || undefined,
      resourceGroup: body?.resourceGroup || undefined,
      location: body?.location || undefined,
      resourceName: body?.resourceName || undefined,
      metastoreId: body?.metastoreId || undefined,
    };
    const mapped = purviewSourceForConnectable(mapInput);
    if (isUnsupportedPurviewSource(mapped)) {
      return NextResponse.json({ ok: false, code: 'unsupported_kind', error: mapped.reason }, { status: 400 });
    }
    kind = mapped.kind;
    endpoint = mapped.endpoint;
    properties = mapped.properties;
    scanRulesetName = mapped.scanRulesetName;
  } else {
    kind = String(body?.kind || '').trim();
    endpoint = String(body?.endpoint || '').trim();
    if (!kind) return NextResponse.json({ ok: false, error: 'kind (or connType) is required' }, { status: 400 });
    properties = {
      ...(endpoint ? { endpoint } : {}),
      ...(body?.subscriptionId ? { subscriptionId: body.subscriptionId } : {}),
      ...(body?.resourceGroup ? { resourceGroup: body.resourceGroup } : {}),
      ...(body?.location ? { location: body.location } : {}),
      ...(body?.resourceName ? { resourceName: body.resourceName } : {}),
    };
    scanRulesetName = kind;
  }

  if (body?.collectionName) {
    properties.collection = { referenceName: String(body.collectionName), type: 'CollectionReference' };
  }

  try {
    const source = await registerDataSource({ name: sourceName, kind, properties });

    // Optional best-effort scan definition (System ruleset == kind for built-ins).
    // A scan failure (e.g. needs a credential / IR) folds an honest note into the
    // response rather than failing the register that already succeeded.
    let scan: unknown;
    let scanError: string | undefined;
    if (body?.defineScan) {
      const scanName = `${sourceName}-scan`;
      try {
        scan = await upsertScan({
          sourceName, scanName, kind,
          scanRulesetName, scanRulesetType: 'System',
          collectionRef: body?.collectionName || undefined,
        });
      } catch (e: any) {
        scanError = e?.message || String(e);
      }
    }

    return NextResponse.json({
      ok: true,
      source,
      kind,
      endpoint,
      resourceId: body?.resourceId || undefined,
      ...(scan ? { scan } : {}),
      ...(scanError ? { scanError } : {}),
    }, { status: 201 });
  } catch (e: any) {
    if (e instanceof PurviewNotConfiguredError) {
      return NextResponse.json({ ok: false, code: 'not_configured', error: e.message, hint: e.hint }, { status: 501 });
    }
    if (e instanceof PurviewError) {
      return NextResponse.json({ ok: false, error: e.message, status: e.status }, { status: e.status >= 400 && e.status < 600 ? e.status : 502 });
    }
    return apiServerError(e);
  }
}
