/**
 * POST /api/items/event-schema-set/[id]/versions?workspaceId=...
 *   body: { subject: string, schema: string, format?: 'AVRO'|'JSON'|'PROTOBUF' }
 *
 * Append a new version to the named subject (create the subject if missing).
 * Returns the persisted schemaSet state so the UI can re-render directly.
 *
 * Compatibility check is a stub today — same payload registered against an
 * external Confluent/Apicurio registry would call POST /compatibility/...
 * before persisting. The MessageBar on the editor surfaces this gap.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) { return NextResponse.json({ ok: false, error }, { status }); }

interface SchemaVersion { id: number; schema: string; createdAt: string; createdBy?: string }
interface SchemaSubject { name: string; format: 'AVRO' | 'JSON' | 'PROTOBUF'; versions: SchemaVersion[] }

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  const subject = String(body?.subject || '').trim();
  const schema = String(body?.schema || '').trim();
  const format = (body?.format || 'AVRO') as SchemaSubject['format'];
  if (!subject) return err('subject required', 400);
  if (!schema) return err('schema required', 400);
  try {
    const items = await itemsContainer();
    const { resource: existing } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!existing || existing.itemType !== 'event-schema-set') return err('event schema set not found', 404);
    const state = (existing.state || {}) as Record<string, unknown>;
    const subjects = ((state.subjects as SchemaSubject[]) || []).slice();
    let idx = subjects.findIndex(x => x.name === subject);
    if (idx < 0) {
      subjects.push({ name: subject, format, versions: [] });
      idx = subjects.length - 1;
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
  } catch (e: any) { return err(e?.message || String(e), 500); }
}
