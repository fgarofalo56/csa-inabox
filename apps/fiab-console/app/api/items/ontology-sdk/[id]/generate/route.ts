/**
 * POST /api/items/ontology-sdk/[id]/generate → { ok, typescript, python, dabConfig, objectCount }
 * Generates typed TS + Python clients and a real dab-config.json from the bound
 * ontology's parsed object / link types. Deterministic real output (no mocks).
 * Azure-native — DAB runs on Container Apps; no Fabric required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import { loadOntologySurface } from '../../../_lib/palantir-crud';
import {
  generateTypeScriptSdk, generatePythonSdk, generateDabConfig,
} from '@/lib/editors/_palantir-codegen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ITEM_TYPE = 'ontology-sdk';
function err(error: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status });
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the SDK item first (no id yet)', 400, 'no_id');
  const sdk = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!sdk) return err('ontology-sdk not found', 404, 'not_found');
  const ontologyId = (sdk.state as Record<string, unknown> | undefined)?.boundOntologyId as string | undefined;
  if (!ontologyId) return err('bind an ontology before generating the SDK', 400, 'not_bound');
  const surface = await loadOntologySurface(ontologyId, s.claims.oid);
  if (!surface) return err('bound ontology not found', 404, 'ontology_not_found');
  if (surface.classes.length === 0) return err('the bound ontology has no object types — add entities to it first', 400, 'no_objects');

  const input = { displayName: surface.displayName, classes: surface.classes, links: surface.links };
  const typescript = generateTypeScriptSdk(input);
  const python = generatePythonSdk(input);
  const dabConfig = generateDabConfig(input);

  const state = { ...((sdk.state || {}) as Record<string, unknown>) };
  state.lastGeneratedAt = new Date().toISOString();
  state.objectCount = surface.classes.length;
  await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, { state });

  return NextResponse.json({ ok: true, typescript, python, dabConfig, objectCount: surface.classes.length });
}
