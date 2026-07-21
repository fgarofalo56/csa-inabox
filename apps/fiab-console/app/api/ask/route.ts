/**
 * POST /api/ask
 *
 * Surface-level "Ask" endpoint — accepts a natural-language question about the
 * data currently visible on any Loom surface (lakehouse preview, warehouse table,
 * KQL dashboard, report, semantic model, ontology) and answers it by building a
 * temporary DataAgentConfig from the surface context and calling the REAL
 * `chatGrounded` from `data-agent-client.ts`.
 *
 * This is the BFF for the shared `AskAffordance` component (WS-5.4). It reuses
 * the identical AOAI grounding pipeline as the data-agent item chat
 * (/api/items/data-agent/[id]/chat) — no Fabric, no mocks
 * (no-fabric-dependency.md, no-vaporware.md).
 *
 * Body:
 *   question      string  (required)
 *   surfaceKind   'lakehouse' | 'warehouse' | 'kql-database' | 'kql-dashboard' |
 *                 'semantic-model' | 'report' | 'ontology'
 *   itemId        string  — Loom item id for provenance / source name
 *   itemType      string  — Loom item type label (e.g. "lakehouse")
 *   context       object  (optional)
 *     tables      string[]    — selected table / view names visible on the surface
 *     columns     string[]    — column names visible in the current view / selection
 *     query       string      — current SQL/KQL already in the editor (if any)
 *     selection   string      — text currently selected / highlighted on the surface
 *
 * Response (ok):
 *   { ok: true, answer, tools?, usage?, model?, sourcesAvailable? }
 *
 * Response (error):
 *   { ok: false, error, code?, hint?, missing? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  chatGrounded,
  NoAoaiDeploymentError,
  type DataAgentConfig,
  type DataAgentSource,
  type DataAgentSourceType,
} from '@/lib/azure/data-agent-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Map a Loom surface kind to the DataAgent source type and query language. */
const SURFACE_SOURCE_TYPE: Record<string, DataAgentSourceType> = {
  lakehouse:       'lakehouse',
  warehouse:       'warehouse',
  'kql-database':  'kql',
  'kql-dashboard': 'kql',
  'semantic-model': 'semantic-model',
  report:          'semantic-model',
  ontology:        'ontology',
};

/** Build a grounded DataAgentConfig from the surface context (no Cosmos lookup). */
function buildConfig(
  surfaceKind: string,
  itemId: string,
  itemType: string,
  context: {
    tables?: string[];
    columns?: string[];
    query?: string;
    selection?: string;
  },
): DataAgentConfig {
  const sourceType: DataAgentSourceType = SURFACE_SOURCE_TYPE[surfaceKind] ?? 'lakehouse';
  const surfaceLabel = surfaceKind.replace(/-/g, ' ');

  // Build a concise grounding description from the surface context.
  const descParts: string[] = [];
  if (context.tables?.length) {
    descParts.push(`Tables/views visible: ${context.tables.slice(0, 10).join(', ')}`);
  }
  if (context.columns?.length) {
    descParts.push(`Columns: ${context.columns.slice(0, 20).join(', ')}`);
  }
  if (context.query?.trim()) {
    descParts.push(`Current query:\n${context.query.trim().slice(0, 800)}`);
  }
  if (context.selection?.trim()) {
    descParts.push(`User selection: ${context.selection.trim().slice(0, 400)}`);
  }

  const tables = context.tables?.join(', ') || undefined;

  const source: DataAgentSource = {
    id: itemId || surfaceKind,
    type: sourceType,
    name: `${itemType || surfaceLabel} (${surfaceLabel} surface)`,
    tables,
    description: `This source represents the ${surfaceLabel} surface the user is currently viewing.`,
    instructions: descParts.length
      ? `Current surface context:\n${descParts.join('\n\n')}`
      : undefined,
  };

  return {
    instructions:
      `You are answering a question about the data on a ${surfaceLabel} surface in CSA Loom. ` +
      `The user is looking at this specific data; ground your answer in the attached source. ` +
      `Be concise and data-driven.`,
    sources: [source],
  };
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (!question) {
    return NextResponse.json({ ok: false, error: 'question required' }, { status: 400 });
  }

  const surfaceKind = typeof body?.surfaceKind === 'string' ? body.surfaceKind.trim() : 'lakehouse';
  const itemId = typeof body?.itemId === 'string' ? body.itemId.trim() : '';
  const itemType = typeof body?.itemType === 'string' ? body.itemType.trim() : '';

  const rawCtx = body?.context && typeof body.context === 'object' ? (body.context as Record<string, unknown>) : {};
  const context = {
    tables: Array.isArray(rawCtx.tables)
      ? (rawCtx.tables as unknown[]).map(String).filter(Boolean)
      : undefined,
    columns: Array.isArray(rawCtx.columns)
      ? (rawCtx.columns as unknown[]).map(String).filter(Boolean)
      : undefined,
    query: typeof rawCtx.query === 'string' ? rawCtx.query : undefined,
    selection: typeof rawCtx.selection === 'string' ? rawCtx.selection : undefined,
  };

  const cfg: DataAgentConfig = buildConfig(surfaceKind, itemId, itemType, context);

  try {
    const answer = await chatGrounded(cfg, [], question, {
      tenantId: session.claims.oid,
    });
    return NextResponse.json({ ok: true, ...answer });
  } catch (e: unknown) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json(
        {
          ok: false,
          code: 'not_configured',
          error: (e as Error).message,
          hint: 'Open the AI Foundry hub editor → "Quota + usage" tab → deploy gpt-4o-mini, or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT.',
          missing: 'LOOM_AOAI_DEPLOYMENT',
        },
        { status: 503 },
      );
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
