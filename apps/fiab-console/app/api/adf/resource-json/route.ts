/**
 * Read-only full-definition view for a single Factory Resource, backing the
 * "View JSON", "Clone", and "Rename" right-click actions in the ADF Factory
 * Resources navigator (lib/components/pipeline/factory-resources-tree.tsx).
 *
 * The list routes (/api/adf/pipelines etc.) return trimmed rows (name + count)
 * so the tree can render fast; those don't carry the full ARM `properties`.
 * Clone/Rename need the complete definition to re-create it under a new name,
 * and "View JSON" shows it read-only — so this route fetches the ONE resource's
 * full ARM definition via the existing adf-client get* helpers.
 *
 *   GET /api/adf/resource-json?type=<kind>&name=<name>
 *        → { ok:true, definition:{ name, properties, ... } }
 *
 * type ∈ pipeline|dataset|dataflow|trigger|linkedService|integrationRuntime|cdc.
 * Factory is the env-pinned deployment default; honest 503 gate when unset.
 * Real ARM REST via the Console UAMI. No mocks. GET-only (no mutation here).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  adfConfigGate,
  getPipeline, getDataset, getDataFlow, getTrigger,
  getLinkedService, getIntegrationRuntime, getAdfCdc,
} from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GETTERS: Record<string, (name: string) => Promise<unknown>> = {
  pipeline: getPipeline,
  dataset: getDataset,
  dataflow: getDataFlow,
  trigger: getTrigger,
  linkedService: getLinkedService,
  integrationRuntime: getIntegrationRuntime,
  cdc: getAdfCdc,
};

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const g = adfConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Data Factory not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }

  const type = req.nextUrl.searchParams.get('type')?.trim() || '';
  const name = req.nextUrl.searchParams.get('name')?.trim() || '';
  if (!name) return NextResponse.json({ ok: false, error: 'name query param is required' }, { status: 400 });

  const getter = GETTERS[type];
  if (!getter) {
    return NextResponse.json(
      { ok: false, error: `unsupported type '${type}' (expected ${Object.keys(GETTERS).join('|')})` },
      { status: 400 },
    );
  }

  try {
    const definition = await getter(name);
    return NextResponse.json({ ok: true, definition });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
