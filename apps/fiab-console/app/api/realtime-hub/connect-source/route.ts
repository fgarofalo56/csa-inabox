/**
 * POST /api/realtime-hub/connect-source
 *
 * Real-Time Hub "Connect source" / "Get events" flow. **Azure-native by
 * default** (no Microsoft Fabric, per .claude/rules/no-fabric-dependency.md):
 * creates a Loom-native **eventstream** item carrying the chosen streaming
 * source. The Loom eventstream runtime is Azure Event Hubs (+ Stream Analytics
 * for processing); the eventstream editor opens fully built-out on the item.
 *
 * Fabric is opt-in: set `LOOM_EVENTSTREAM_BACKEND=fabric` AND pass a
 * `fabricWorkspaceId` and the route creates a real Fabric Eventstream instead.
 *
 * Body (Azure-native default):
 *   { workspaceId, displayName, sourceType, sourceName?, description?, properties? }
 * Body (Fabric opt-in): adds `fabricWorkspaceId`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createOwnedItem } from '../../items/_lib/item-crud';
import {
  connectEventstreamSource,
  isRthSourceType,
  RTH_SOURCE_TYPES,
  FabricError,
} from '@/lib/azure/fabric-client';
import { putKeyVaultSecret, vaultUrl, KeyVaultError } from '@/lib/azure/kv-secrets-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FABRIC_OPT_IN = (process.env.LOOM_EVENTSTREAM_BACKEND || '').toLowerCase() === 'fabric';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const ct = req.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    return NextResponse.json({ ok: false, error: 'Content-Type must be application/json' }, { status: 415 });
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const displayName = String(body.displayName || '').trim();
  const sourceType = String(body.sourceType || '').trim();
  const sourceName = String(body.sourceName || 'source-1').trim() || 'source-1';
  const fabricWorkspaceId = String(body.fabricWorkspaceId || '').trim();
  const properties = (body.properties && typeof body.properties === 'object') ? body.properties : {};

  if (!displayName) return NextResponse.json({ ok: false, error: 'displayName is required.' }, { status: 400 });
  if (!isRthSourceType(sourceType)) {
    return NextResponse.json({ ok: false, error: `Unsupported sourceType "${sourceType}".`, hint: `Allowed: ${RTH_SOURCE_TYPES.join(', ')}` }, { status: 400 });
  }

  // Defense in depth: Fabric-only source types (FabricWorkspaceItemEvents /
  // FabricJobEvents / FabricOneLakeEvents) require the Fabric backend. Reject
  // them up front when Fabric isn't opted in, instead of silently creating an
  // Azure-native eventstream item that can never produce those events
  // (audit: rti-hub-catalog / connect-source — reject fabric-* when
  // LOOM_EVENTSTREAM_BACKEND != fabric).
  if (/^Fabric/.test(sourceType) && !FABRIC_OPT_IN) {
    return NextResponse.json({
      ok: false,
      error: `Source type "${sourceType}" requires the Microsoft Fabric backend, which is not enabled in this deployment.`,
      hint: 'Set LOOM_EVENTSTREAM_BACKEND=fabric and bind a Fabric workspace to use Fabric event sources, or pick an Azure-native source.',
    }, { status: 400 });
  }

  // ---- Fabric opt-in path (only when explicitly enabled + a workspace given) ----
  if (FABRIC_OPT_IN && fabricWorkspaceId) {
    try {
      const result = await connectEventstreamSource(fabricWorkspaceId, {
        displayName,
        description: body.description ? String(body.description) : 'Connected from CSA Loom Real-Time Hub',
        sourceName, sourceType, properties,
      });
      return NextResponse.json({
        ok: true, connected: true, backend: 'fabric',
        accepted: (result as any)?._accepted === true,
        fabricEventstreamId: (result as any)?.id ?? null,
        fabricWorkspaceId, sourceType,
      });
    } catch (e: any) {
      if (e instanceof FabricError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint }, { status: e.status });
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
    }
  }

  // ---- Azure-native default: create a Loom eventstream item ----
  const workspaceId = String(body.workspaceId || '').trim();
  if (!workspaceId) {
    return NextResponse.json({ ok: false, error: 'workspaceId is required.', hint: 'Pick the Loom workspace to create the eventstream in.' }, { status: 400 });
  }
  // Secret hardening: never persist a broker password (or any *password* prop)
  // in the item state / Cosmos. Write it to Key Vault and keep only a secretRef
  // (per no-vaporware.md secret handling + the mTLS connection contract).
  const safeProps: Record<string, unknown> = { ...properties };
  try {
    for (const key of Object.keys(safeProps)) {
      if (/password|secret|key$/i.test(key) && typeof safeProps[key] === 'string' && (safeProps[key] as string).trim()) {
        if (!vaultUrl()) {
          return NextResponse.json({
            ok: false,
            error: 'A secret was supplied but no Key Vault is configured to store it.',
            hint: 'Set LOOM_KEY_VAULT_URI (or LOOM_KEY_VAULT_NAME) and grant the Console identity "Key Vault Secrets Officer".',
          }, { status: 503 });
        }
        const { name } = await putKeyVaultSecret(`es-${sourceName}-${key}-${Date.now()}`, String(safeProps[key]));
        delete safeProps[key];
        safeProps[`${key}SecretRef`] = name;
      }
    }
  } catch (e: any) {
    if (e instanceof KeyVaultError) {
      const hint = e.status === 403
        ? 'Grant the Console identity the "Key Vault Secrets Officer" role on the configured vault.'
        : undefined;
      return NextResponse.json({ ok: false, error: e.message, hint }, { status: e.status });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }

  const res = await createOwnedItem(session, 'eventstream', {
    workspaceId,
    displayName,
    description: body.description ? String(body.description) : `Real-Time Hub source: ${sourceType}`,
    state: {
      backend: 'azure-native',
      // The eventstream editor reads this topology: one source node, no
      // destinations yet (the user wires processing/destinations in the canvas).
      definition: {
        sources: [{ name: sourceName, type: sourceType, properties: safeProps }],
        operators: [],
        destinations: [],
      },
      source: { name: sourceName, type: sourceType, properties: safeProps },
    },
  });
  if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: res.status });

  return NextResponse.json({
    ok: true,
    connected: true,
    backend: 'azure-native',
    eventstreamId: res.item.id,
    workspaceId,
    sourceType,
    link: `/items/eventstream/${res.item.id}`,
  });
}
