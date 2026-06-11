/**
 * Workshop (PMF-44 / Atelier-T51) — run a data action.
 *
 * POST /api/items/workshop-app/[id]/run-action
 *   body: { entityType, op?: 'list', top?: number }
 *   → { ok, op, entityType, columns:[], rows:[][], rowCount } | honest gate
 *
 * A Workshop app's operational actions read/write the data behind the bound
 * ontology entity types. This route resolves the workshop app's bound ontology,
 * finds the ontology's entity binding for `entityType` (a Lakehouse / Warehouse
 * source persisted on the ontology's state.entityBindings), and runs a REAL
 * read against the Azure-native backend:
 *   • warehouse binding → Synapse dedicated SQL pool via the live TDS path
 *     (synapse-sql-client.executeQuery) — same backend the warehouse editor uses.
 *
 * Per no-fabric-dependency.md the default is Azure-native (Synapse), no Fabric.
 * Honest infra-gate (503) when Synapse env is unset (dedicatedTarget throws
 * 'Missing env var'); honest 409 when no warehouse source is bound to the type.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { dedicatedTarget, executeQuery } from '@/lib/azure/synapse-sql-client';
import type { OntologyEntityBinding } from '@/lib/editors/_family-utils';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'workshop-app';

function err(error: string, status: number, code?: string, gate?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}), ...(gate ? { gate } : {}) }, { status });
}

/** A safe SQL identifier — letters/digits/underscore, max 128, else null. */
function safeIdent(name: string): string | null {
  return /^[A-Za-z_][\w]{0,127}$/.test(name) ? name : null;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the workshop app first', 400, 'no_id');
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const entityType = String((body as { entityType?: string })?.entityType || '').trim();
  const top = Math.min(Math.max(Number((body as { top?: number })?.top) || 50, 1), 1000);
  if (!entityType) return err('entityType is required', 400, 'bad_request');

  const app = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!app) return err('workshop app not found', 404, 'not_found');
  const boundOntologyId = String(((app.state || {}) as Record<string, unknown>).boundOntologyId || '');
  if (!boundOntologyId) return err('Bind an ontology to this Workshop app first.', 409, 'no_ontology');

  const onto: WorkspaceItem | null = await loadOwnedItem(boundOntologyId, 'ontology', s.claims.oid);
  if (!onto) return err('bound ontology not found', 404, 'ontology_not_found');
  const bindings = (((onto.state || {}) as Record<string, unknown>).entityBindings as OntologyEntityBinding[]) || [];
  const binding = bindings.find((b) => (b.entityTypes || []).includes(entityType) && b.sourceKind === 'warehouse');
  if (!binding) {
    return err(
      `No warehouse data source is bound to entity type "${entityType}" on the ontology.`,
      409, 'no_binding',
      { reason: 'A Workshop action reads the warehouse table behind the ontology entity type.', remediation: `Open the bound ontology and use "Bind to data source" to map a Warehouse table to ${entityType}.` },
    );
  }

  const table = safeIdent(entityType);
  if (!table) return err('entity type is not a safe SQL identifier', 400, 'bad_ident');

  let target;
  try {
    target = dedicatedTarget();
  } catch (e: unknown) {
    return err(
      'Azure Synapse dedicated SQL pool not configured.',
      503, 'synapse_not_configured',
      { reason: 'The Azure-native Workshop backend reads entity rows from the bound Synapse warehouse.', remediation: 'Set LOOM_SYNAPSE_WORKSPACE / LOOM_SYNAPSE_DEDICATED_DB on the Console. No Microsoft Fabric required.', detail: e instanceof Error ? e.message : String(e) },
    );
  }

  try {
    const result = await executeQuery(target, `SELECT TOP (${top}) * FROM [${table}]`, 60_000);
    return NextResponse.json({ ok: true, op: 'list', entityType, columns: result.columns, rows: result.rows, rowCount: result.rows.length });
  } catch (e: unknown) {
    return err(`Query failed: ${e instanceof Error ? e.message : String(e)}`, 502, 'query_failed');
  }
}
