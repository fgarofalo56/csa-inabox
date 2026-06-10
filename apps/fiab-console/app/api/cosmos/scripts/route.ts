/**
 * /api/cosmos/scripts — server-side scripts for a container:
 * stored procedures, triggers, and user-defined functions (list + author).
 *
 *   GET ?db=<name>&container=<name>
 *     → { ok, storedProcedures:[…], triggers:[…], userDefinedFunctions:[…] }
 *   GET ?db=<name>&container=<name>&kind=<kind>&name=<name>
 *     → { ok, script:{ id, name, body, … } }   (single-script detail w/ body)
 *
 *   PUT  { db, container, kind, id, body, triggerType?, triggerOperation? }
 *     → { ok, script:{ id, name, body, … } }   (create or replace)
 *
 *   DELETE ?db=<name>&container=<name>&kind=<kind>&name=<name>
 *     → { ok: true }
 *
 *   kind ∈ 'storedProcedure' | 'trigger' | 'udf'
 *
 * Real backend (ARM control plane, api-version 2024-11-15) via
 * lib/azure/cosmos-account-client.ts:
 *   …/sqlDatabases/{db}/containers/{c}/storedProcedures[/{name}]
 *   …/sqlDatabases/{db}/containers/{c}/triggers[/{name}]
 *   …/sqlDatabases/{db}/containers/{c}/userDefinedFunctions[/{name}]
 *
 * RBAC: the navigator's existing "DocumentDB Account Contributor" role covers
 * the storedProcedures/triggers/userDefinedFunctions sub-resources (PUT/DELETE)
 * — no new role is required. (Executing a stored procedure is a data-plane call;
 * see /api/cosmos/scripts/execute.)
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  listContainerScripts,
  getStoredProcedure, upsertStoredProcedure, deleteStoredProcedure,
  getTrigger, upsertTrigger, deleteTrigger,
  getUdf, upsertUdf, deleteUdf,
} from '@/lib/azure/cosmos-account-client';
import { requireSession, gateResponse, errorResponse, readBody } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ScriptKind = 'storedProcedure' | 'trigger' | 'udf';

function parseKind(v: unknown): ScriptKind | null {
  return v === 'storedProcedure' || v === 'trigger' || v === 'udf' ? v : null;
}

export async function GET(req: NextRequest) {
  const unauth = requireSession(); if (unauth) return unauth;
  const gated = gateResponse(); if (gated) return gated;
  try {
    const p = req.nextUrl.searchParams;
    const db = p.get('db');
    const container = p.get('container');
    if (!db || !container) {
      return NextResponse.json({ ok: false, error: 'db and container query params are required' }, { status: 400 });
    }
    // Single-script detail (body included) when name is supplied.
    const name = p.get('name');
    if (name) {
      const kind = parseKind(p.get('kind'));
      if (!kind) {
        return NextResponse.json({ ok: false, error: "kind must be 'storedProcedure' | 'trigger' | 'udf'" }, { status: 400 });
      }
      const script =
        kind === 'storedProcedure' ? await getStoredProcedure(db, container, name)
          : kind === 'trigger' ? await getTrigger(db, container, name)
            : await getUdf(db, container, name);
      if (!script) {
        return NextResponse.json({ ok: false, error: `${kind} "${name}" not found` }, { status: 404 });
      }
      return NextResponse.json({ ok: true, script });
    }
    // Otherwise the full list bundle (backward-compatible with the tree).
    const scripts = await listContainerScripts(db, container);
    return NextResponse.json({ ok: true, ...scripts });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PUT(req: NextRequest) {
  const unauth = requireSession(); if (unauth) return unauth;
  const gated = gateResponse(); if (gated) return gated;
  try {
    const body = await readBody<{
      db?: string; container?: string; kind?: string; id?: string; body?: string;
      triggerType?: 'Pre' | 'Post';
      triggerOperation?: 'All' | 'Create' | 'Delete' | 'Replace' | 'Update';
    }>(req);
    const db = body.db?.trim();
    const container = body.container?.trim();
    const kind = parseKind(body.kind);
    const id = body.id?.trim();
    if (!db || !container || !kind || !id) {
      return NextResponse.json({ ok: false, error: 'db, container, kind, and id are required' }, { status: 400 });
    }
    if (typeof body.body !== 'string') {
      return NextResponse.json({ ok: false, error: 'body (the script source) is required' }, { status: 400 });
    }
    let script;
    if (kind === 'storedProcedure') {
      script = await upsertStoredProcedure(db, container, { id, body: body.body });
    } else if (kind === 'udf') {
      script = await upsertUdf(db, container, { id, body: body.body });
    } else {
      const triggerType = body.triggerType === 'Post' ? 'Post' : 'Pre';
      const triggerOperation = body.triggerOperation || 'All';
      script = await upsertTrigger(db, container, { id, body: body.body, triggerType, triggerOperation });
    }
    return NextResponse.json({ ok: true, script });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  const unauth = requireSession(); if (unauth) return unauth;
  const gated = gateResponse(); if (gated) return gated;
  try {
    const p = req.nextUrl.searchParams;
    const db = p.get('db');
    const container = p.get('container');
    const kind = parseKind(p.get('kind'));
    const name = p.get('name');
    if (!db || !container || !kind || !name) {
      return NextResponse.json({ ok: false, error: 'db, container, kind, and name query params are required' }, { status: 400 });
    }
    if (kind === 'storedProcedure') await deleteStoredProcedure(db, container, name);
    else if (kind === 'udf') await deleteUdf(db, container, name);
    else await deleteTrigger(db, container, name);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
