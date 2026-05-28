/**
 * POST /api/items/copy-job/[id]/run
 *
 * Loads the persisted source/sink/mappings, materialises a Synapse pipeline
 * named `loom-copy-<itemId>` with a single Copy activity, then triggers a
 * run. Returns the runId so the editor can poll /runs.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  runPipeline, upsertPipeline, type SynapsePipeline,
} from '@/lib/azure/synapse-dev-client';
import { jerr, loadOwnedItem } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'copy-job';

interface SideSpec {
  linkedService: string;
  type: string;      // e.g. AzureSqlSource, ParquetSource, DelimitedTextSink…
  query?: string;
  table?: string;
  path?: string;
  schema?: string;
}

interface CopySpec {
  source: SideSpec;
  sink: SideSpec;
  mappings?: Array<{ source: string; sink: string }>;
}

function buildPipeline(itemId: string, spec: CopySpec): SynapsePipeline {
  const sourceTypeProperties: Record<string, unknown> = {};
  if (spec.source.query) sourceTypeProperties.sqlReaderQuery = spec.source.query;
  const sinkTypeProperties: Record<string, unknown> = {};
  const translator = spec.mappings && spec.mappings.length > 0
    ? {
        type: 'TabularTranslator',
        mappings: spec.mappings.map((m) => ({
          source: { name: m.source }, sink: { name: m.sink },
        })),
      }
    : undefined;
  return {
    name: `loom-copy-${itemId}`,
    properties: {
      description: `Loom copy-job ${itemId}`,
      activities: [
        {
          name: 'Copy',
          type: 'Copy',
          inputs: [],
          outputs: [],
          typeProperties: {
            source: { type: spec.source.type, ...sourceTypeProperties },
            sink:   { type: spec.sink.type,   ...sinkTypeProperties },
            ...(translator ? { translator } : {}),
            enableStaging: false,
          },
          linkedServiceName: { referenceName: spec.source.linkedService, type: 'LinkedServiceReference' },
          // Sink linked service is referenced inline via the dataset normally;
          // for this minimal materialiser we surface both via activity-scope
          // user properties so the runtime fails fast with the correct hint.
          userProperties: [
            { name: 'sourceLinkedService', value: spec.source.linkedService },
            { name: 'sinkLinkedService',   value: spec.sink.linkedService },
          ],
        },
      ],
      annotations: ['loom', 'copy-job', itemId],
    },
  };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const override = await req.json().catch(() => ({}));
  try {
    const item = await loadOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('not found', 404);
    const spec = (item.state as any) as CopySpec | undefined;
    if (!spec?.source?.linkedService || !spec?.sink?.linkedService) {
      return jerr('source.linkedService and sink.linkedService are required', 400);
    }
    if (!spec.source.type || !spec.sink.type) {
      return jerr('source.type and sink.type are required', 400);
    }
    const merged: CopySpec = { ...spec, ...override };
    const pipelineName = `loom-copy-${(await ctx.params).id}`;
    await upsertPipeline(pipelineName, buildPipeline((await ctx.params).id, merged));
    const run = await runPipeline(pipelineName);
    return NextResponse.json({ ok: true, pipelineName, ...run });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}
