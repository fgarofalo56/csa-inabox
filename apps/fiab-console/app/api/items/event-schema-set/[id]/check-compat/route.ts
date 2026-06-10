/**
 * POST /api/items/event-schema-set/[id]/check-compat?workspaceId=...
 *   body: { subject: string, newSchema: string, format?: 'AVRO'|'JSON'|'PROTOBUF' }
 *
 * Pre-publish compatibility check for a proposed schema version. Does NOT
 * persist anything — it answers "would registering this version under {subject}
 * be {compatibility}-compatible with the latest registered version?" so the
 * editor can warn (and the version route can block) BEFORE a breaking schema
 * lands.
 *
 * Two backends, selected automatically (no Fabric dependency on either path):
 *
 *   • eventhubs-sr  — when LOOM_EH_SCHEMA_GROUP + LOOM_EVENTHUB_NAMESPACE are
 *     set, delegate to the Azure Event Hubs Schema Registry data plane: a PUT
 *     of the schema into the group triggers the service's own server-side
 *     compatibility enforcement (400 on violation). Idempotent by content.
 *
 *   • cosmos-inprocess  — the DEFAULT. Run the pure Avro structural validator
 *     (schema-compat-validator.ts) against the latest version stored in Cosmos.
 *     Always available, no extra infra, works with LOOM_DEFAULT_FABRIC_WORKSPACE
 *     unset.
 *
 * Returns { ok:true, compatible, violations, checkedVia } or { ok:false, error }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  checkAvroCompat,
  type CompatMode,
  type SchemaFormat,
} from '@/lib/azure/schema-compat-validator';
import {
  schemaRegistryConfigGate,
  putSchemaVersion,
  EventHubsArmError,
} from '@/lib/azure/eventhubs-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

interface SchemaVersion { id: number; schema: string }
interface SchemaSubject { name: string; format: SchemaFormat; versions: SchemaVersion[] }

/** Normalize a Loom format token to the EH SR serialization label. */
function srFormat(f: SchemaFormat): 'Avro' | 'Json' | 'Protobuf' {
  if (f === 'JSON') return 'Json';
  if (f === 'PROTOBUF') return 'Protobuf';
  return 'Avro';
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  const subject = String(body?.subject || '').trim();
  const newSchema = String(body?.newSchema ?? body?.schema ?? '').trim();
  const format = (String(body?.format || 'AVRO').toUpperCase() as SchemaFormat);
  if (!subject) return err('subject required', 400);
  if (!newSchema) return err('newSchema required', 400);

  try {
    const items = await itemsContainer();
    const { resource: existing } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!existing || existing.itemType !== 'event-schema-set') return err('event schema set not found', 404);
    const state = (existing.state || {}) as Record<string, unknown>;
    const mode = ((state.compatibility as string) || 'BACKWARD') as CompatMode;
    const subjects = ((state.subjects as SchemaSubject[]) || []);
    const sub = subjects.find((x) => x.name === subject);
    const latest = sub?.versions?.at(-1)?.schema;

    // No prior version → nothing to be incompatible with; any first schema is OK.
    if (!latest) {
      return NextResponse.json({ ok: true, compatible: true, violations: [], checkedVia: 'cosmos-inprocess' });
    }
    if (mode === 'NONE') {
      return NextResponse.json({ ok: true, compatible: true, violations: [], checkedVia: 'cosmos-inprocess' });
    }

    // Opt-in path: delegate to Event Hubs Schema Registry server-side enforcement.
    const srGate = schemaRegistryConfigGate();
    if (!srGate) {
      const group = process.env.LOOM_EH_SCHEMA_GROUP as string;
      try {
        await putSchemaVersion(group, subject, newSchema, srFormat(format));
        // PUT succeeded → the service accepted it under the group's policy.
        return NextResponse.json({ ok: true, compatible: true, violations: [], checkedVia: 'eventhubs-sr' });
      } catch (e) {
        if (e instanceof EventHubsArmError && e.status === 400) {
          const detail = typeof e.body === 'string' && e.body ? e.body.slice(0, 300) : e.message;
          return NextResponse.json({
            ok: true,
            compatible: false,
            violations: [`Event Hubs Schema Registry rejected the schema as incompatible: ${detail}`],
            checkedVia: 'eventhubs-sr',
          });
        }
        // Auth/infra error from EH SR → surface honestly rather than silently
        // claiming compatible. The route returns 502 so the caller can retry or
        // fall back; the editor shows the real service error.
        const msg = e instanceof EventHubsArmError ? e.message : (e as Error)?.message || String(e);
        return err(`Event Hubs Schema Registry check failed: ${msg}`, 502);
      }
    }

    // Default path: in-process Avro structural validator.
    const result = checkAvroCompat(latest, newSchema, mode, format);
    return NextResponse.json({
      ok: true,
      compatible: result.compatible,
      violations: result.violations,
      checkedVia: 'cosmos-inprocess',
    });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}
