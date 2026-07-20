/**
 * POST /api/dab/[id]/preview/rest
 *   body { restBasePath, entityPath, pkSegment?, select?, filter?, orderby?,
 *          first?, after?, role? }
 *   → server-side proxy of a real DAB REST read against the configured runtime
 *     (X-MS-API-ROLE honored). Returns { status, body, url }.
 *
 *   HONEST GATE: when the item's saved DAB config defines ZERO entities, the
 *   runtime can only 404 (EntityNotFound) — return a structured 409 naming the
 *   real cause + the editor flow that fixes it instead of the raw passthrough.
 *   When entities exist but the requested entityPath matches none of them, the
 *   passthrough is kept and the available entity paths are added to the result.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { jerr, loadOwnedItem } from '../../../../items/_lib/item-crud';
import { dabRuntimeGate, proxyRest } from '../../../_lib/dab-runtime';
import type { DabConfig } from '../../../_lib/dab-config-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-api-builder';

/** The REST path each configured entity answers on (mirrors the editor's pick). */
function entityRestPath(e: DabConfig['entities'][number]): string {
  const p = e.rest?.path || `/${e.name.toLowerCase()}`;
  return p.startsWith('/') ? p : `/${p}`;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const gate = dabRuntimeGate();
  if (gate) {
    return NextResponse.json({ ok: false, gate, error: `DAB runtime not provisioned: set ${gate.missing}.` }, { status: 503 });
  }
  const body = await req.json().catch(() => ({}));
  const restBasePath = String(body.restBasePath || '/api');
  const entityPath = String(body.entityPath || '');
  if (!entityPath) return jerr('entityPath is required', 400);

  // Best-effort config read — the gate below only fires when the saved config is
  // definitively empty; an unreadable/absent item keeps the raw passthrough.
  let entities: DabConfig['entities'] | null = null;
  const { id } = await ctx.params;
  try {
    const item = id && id !== 'new' ? await loadOwnedItem(id, ITEM_TYPE, session.claims.oid) : null;
    const cfg = item?.state?.dabConfig as DabConfig | undefined;
    if (cfg && Array.isArray(cfg.entities)) entities = cfg.entities;
  } catch { /* best-effort — fall through to the passthrough */ }

  if (entities && entities.length === 0) {
    return NextResponse.json({
      ok: false,
      error: 'This Data API has no entities yet.',
      code: 'no_entities',
      gate: {
        reason: 'This Data API has no entities yet — its DAB config defines zero tables, views, or stored procedures, so every REST read returns EntityNotFound.',
        remediation: 'Open the Data API builder editor\'s "Entities" stage and add at least one table, view, or stored procedure from the schema picker, then save and retry the preview.',
      },
    }, { status: 409 });
  }

  try {
    const result = await proxyRest(restBasePath, {
      entityPath: entityPath.startsWith('/') ? entityPath : `/${entityPath}`,
      pkSegment: body.pkSegment ? String(body.pkSegment) : undefined,
      select: body.select ? String(body.select) : undefined,
      filter: body.filter ? String(body.filter) : undefined,
      orderby: body.orderby ? String(body.orderby) : undefined,
      first: body.first !== undefined ? Number(body.first) : undefined,
      after: body.after ? String(body.after) : undefined,
      role: body.role ? String(body.role) : undefined,
    });
    // Entities exist but the requested path matches none of them → keep the raw
    // DAB passthrough, and name the entity paths that WOULD work.
    if (entities && entities.length > 0) {
      const wanted = entityPath.startsWith('/') ? entityPath : `/${entityPath}`;
      const available = entities.map(entityRestPath);
      if (!available.some((p) => p.toLowerCase() === wanted.toLowerCase())) {
        return NextResponse.json({
          ok: true,
          ...result,
          availableEntities: available,
          hint: `Requested entityPath "${wanted}" does not match any configured entity. Available entities: ${available.join(', ')}.`,
        });
      }
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}
