/**
 * POST /api/items/ontology-sdk/[id]/generate
 *   body (optional): { selectedObjectTypes?, selectedLinkTypes?, selectedActionTypes? }
 *   → { ok, typescript, python, dabConfig, actions, objectCount, linkCount,
 *       actionCount, propertyCount, selected }
 *
 * Generates typed TS + Python clients, a real dab-config.json, and a typed-action
 * reference from the bound ontology's parsed object / link / action types — scoped
 * to the caller's selection (Ontology scope selector). Deterministic real output
 * (no mocks). Azure-native — DAB runs on Container Apps; no Fabric required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import { loadOntologySurface } from '../../../_lib/palantir-crud';
import {
  generateTypeScriptSdk, generatePythonSdk, generateDabConfig,
  generateActionReference, deriveObjectProperties, type SdkActionTypeInput,
} from '@/lib/editors/_palantir-codegen';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ITEM_TYPE = 'ontology-sdk';
function err(error: string, status: number, code?: string) {
  return apiError(error, status, code ? { code } : undefined);
}

/** Stable identity for a link in the scope selector (kind + endpoints). */
function linkKey(l: { from: string; to: string; kind: string }): string {
  return `${l.kind}:${l.from}->${l.to}`;
}
/** Coerce a request/state value into a clean string[] (or undefined = "all"). */
function pickArr(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.map((x) => String(x)) : undefined;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the SDK item first (no id yet)', 400, 'no_id');
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const sdk = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!sdk) return err('ontology-sdk not found', 404, 'not_found');
  const state = { ...((sdk.state || {}) as Record<string, unknown>) };
  const ontologyId = state.boundOntologyId as string | undefined;
  if (!ontologyId) return err('bind an ontology before generating the SDK', 400, 'not_bound');
  const surface = await loadOntologySurface(ontologyId, s.claims.oid);
  if (!surface) return err('bound ontology not found', 404, 'ontology_not_found');
  if (surface.classes.length === 0) return err('the bound ontology has no object types — add entities to it first', 400, 'no_objects');

  // Resolve the scope selection: request body wins, else persisted state, else
  // "all" (undefined). An explicit empty selection means "none" → blocked below.
  const selObjs = pickArr(body.selectedObjectTypes) ?? pickArr(state.selectedObjectTypes);
  const selLinks = pickArr(body.selectedLinkTypes) ?? pickArr(state.selectedLinkTypes);
  const selActs = pickArr(body.selectedActionTypes) ?? pickArr(state.selectedActionTypes);

  const classes = selObjs ? surface.classes.filter((c) => selObjs.includes(c.name)) : surface.classes;
  if (classes.length === 0) return err('select at least one object type to include in the SDK', 400, 'empty_selection');
  const included = new Set(classes.map((c) => c.name));
  // Links/actions are constrained to the included object types so the generated
  // client never references an excluded type.
  const links = (selLinks ? surface.links.filter((l) => selLinks.includes(linkKey(l))) : surface.links)
    .filter((l) => included.has(l.from) && included.has(l.to));
  const actionTypes: SdkActionTypeInput[] = (selActs ? surface.actionTypes.filter((a) => selActs.includes(a.name)) : surface.actionTypes)
    .filter((a) => included.has(a.objectType))
    .map((a) => ({ name: a.name, objectType: a.objectType, kind: a.kind, params: a.params }));

  const propertiesByType = deriveObjectProperties(classes, surface.bindings, actionTypes);
  const input = { displayName: surface.displayName, classes, links, propertiesByType, actionTypes };
  const typescript = generateTypeScriptSdk(input);
  const python = generatePythonSdk(input);
  const dabConfig = generateDabConfig(input);
  const actions = generateActionReference(input);
  const propertyCount = Object.values(propertiesByType).reduce((n, p) => n + p.length, 0);

  // Persist what we generated + the selection actually used so the editor and a
  // later "publish" reflect the same scope.
  state.lastGeneratedAt = new Date().toISOString();
  state.objectCount = classes.length;
  state.linkCount = links.length;
  state.actionCount = actionTypes.length;
  if (pickArr(body.selectedObjectTypes)) state.selectedObjectTypes = pickArr(body.selectedObjectTypes);
  if (pickArr(body.selectedLinkTypes)) state.selectedLinkTypes = pickArr(body.selectedLinkTypes);
  if (pickArr(body.selectedActionTypes)) state.selectedActionTypes = pickArr(body.selectedActionTypes);
  await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, { state });

  return NextResponse.json({
    ok: true, typescript, python, dabConfig, actions,
    objectCount: classes.length, linkCount: links.length, actionCount: actionTypes.length, propertyCount,
    selected: { objectTypes: classes.map((c) => c.name), linkTypes: links.map(linkKey), actionTypes: actionTypes.map((a) => a.name) },
  });
}
