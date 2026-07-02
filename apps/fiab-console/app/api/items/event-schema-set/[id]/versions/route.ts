/**
 * POST /api/items/event-schema-set/[id]/versions?workspaceId=...
 *   body: { subject: string, schema: string, format?: 'AVRO'|'JSON'|'PROTOBUF' }
 *
 * Append a new version to the named subject (create the subject if missing).
 * Returns the persisted schemaSet state so the UI can re-render directly.
 *
 * Compatibility ENFORCEMENT (no longer a stub): before persisting, the new
 * schema is checked against the subject's latest version under the set's
 * compatibility policy. The check runs server-side via the Azure Event Hubs
 * Schema Registry data plane when LOOM_EH_SCHEMA_GROUP is configured, otherwise
 * via the in-process Avro structural validator (schema-compat-validator.ts) —
 * the Azure-native default that needs no extra infra and no Fabric. A breaking
 * change is rejected with HTTP 409 + the specific violations before anything is
 * written to Cosmos.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
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



interface SchemaVersion { id: number; schema: string; createdAt: string; createdBy?: string }
interface SchemaSubject { name: string; format: 'AVRO' | 'JSON' | 'PROTOBUF'; versions: SchemaVersion[] }

/** Normalize a Loom format token to the EH SR serialization label. */
function srFormat(f: SchemaFormat): 'Avro' | 'Json' | 'Protobuf' {
  if (f === 'JSON') return 'Json';
  if (f === 'PROTOBUF') return 'Protobuf';
  return 'Avro';
}

interface CompatOutcome { compatible: boolean; violations: string[] }

/**
 * Run the pre-persist compatibility check against the subject's latest version.
 * Returns compatible:true (no-op) when there is no prior version or mode=NONE.
 * Throws an EventHubsArmError-derived failure as a thrown Error so the caller
 * can 502 — never silently passes on a backend error.
 */
async function enforceCompat(
  mode: CompatMode,
  latest: string | undefined,
  subject: string,
  newSchema: string,
  format: SchemaFormat,
): Promise<CompatOutcome> {
  if (mode === 'NONE' || !latest) return { compatible: true, violations: [] };

  const srGate = schemaRegistryConfigGate();
  if (!srGate) {
    // Opt-in: delegate to EH SR server-side enforcement (400 on violation).
    const group = process.env.LOOM_EH_SCHEMA_GROUP as string;
    try {
      await putSchemaVersion(group, subject, newSchema, srFormat(format));
      return { compatible: true, violations: [] };
    } catch (e) {
      if (e instanceof EventHubsArmError && e.status === 400) {
        const detail = typeof e.body === 'string' && e.body ? e.body.slice(0, 300) : e.message;
        return { compatible: false, violations: [`Event Hubs Schema Registry rejected the schema as incompatible: ${detail}`] };
      }
      throw new Error(`Event Hubs Schema Registry check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Default: in-process Avro structural validator.
  return checkAvroCompat(latest, newSchema, mode, format);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  const subject = String(body?.subject || '').trim();
  const schema = String(body?.schema || '').trim();
  const format = (body?.format || 'AVRO') as SchemaSubject['format'];
  if (!subject) return apiError('subject required', 400);
  if (!schema) return apiError('schema required', 400);
  try {
    const items = await itemsContainer();
    const { resource: existing } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!existing || existing.itemType !== 'event-schema-set') return apiError('event schema set not found', 404);
    const state = (existing.state || {}) as Record<string, unknown>;
    const subjects = ((state.subjects as SchemaSubject[]) || []).slice();
    let idx = subjects.findIndex(x => x.name === subject);
    if (idx < 0) {
      subjects.push({ name: subject, format, versions: [] });
      idx = subjects.length - 1;
    }

    // Enforce the set's compatibility policy BEFORE persisting. When the subject
    // already has a version and the policy is not NONE, a breaking change is
    // rejected with 409 + the precise violations (the editor surfaces them).
    const mode = ((state.compatibility as string) || 'BACKWARD') as CompatMode;
    const latest = subjects[idx].versions.at(-1)?.schema;
    let outcome: CompatOutcome;
    try {
      outcome = await enforceCompat(mode, latest, subject, schema, format as SchemaFormat);
    } catch (e: any) {
      return apiError(e?.message || String(e), 502);
    }
    if (!outcome.compatible) {
      return apiError(
        `Schema is not ${mode}-compatible with version ${subjects[idx].versions.at(-1)?.id}: ${outcome.violations.join('; ')}`,
        409,
      );
    }

    const nextVersionId = (subjects[idx].versions.at(-1)?.id || 0) + 1;
    subjects[idx].versions.push({
      id: nextVersionId,
      schema,
      createdAt: new Date().toISOString(),
      createdBy: s.claims.upn || s.claims.email || s.claims.oid,
    });
    const next: WorkspaceItem = {
      ...existing,
      state: { ...state, subjects },
      updatedAt: new Date().toISOString(),
    };
    await items.item(existing.id, workspaceId).replace(next);
    return NextResponse.json({
      ok: true,
      subject,
      version: nextVersionId,
      subjects,
    });
  } catch (e: any) { return apiError(e?.message || String(e), 500); }
}
