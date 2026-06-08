/**
 * /api/cosmos/container-settings — a container's TTL + indexing policy.
 *
 *   GET   ?db=<name>&container=<name>                       → { ok, container: ContainerDetail }
 *   PATCH { db, container, defaultTtl?, indexingPolicy? }   → { ok, container: ContainerDetail }
 *
 * Real backend (no JSON textareas — the panel builds these from form rows):
 *   GET   …/sqlDatabases/{db}/containers/{c}                    (full resource shape)
 *   PUT   …/sqlDatabases/{db}/containers/{c}                    (TTL + indexingPolicy)
 *   (ARM api-version 2024-11-15) via lib/azure/cosmos-account-client.ts.
 *
 * defaultTtl semantics on PATCH:
 *   undefined → leave unchanged · null → TTL off · -1 → on/per-item · >0 → on/seconds.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getContainer, updateContainerSettings,
  type CosmosIndexingPolicy,
} from '@/lib/azure/cosmos-account-client';
import { requireSession, gateResponse, errorResponse, readBody } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const unauth = requireSession(); if (unauth) return unauth;
  const gated = gateResponse(); if (gated) return gated;
  try {
    const db = req.nextUrl.searchParams.get('db');
    const container = req.nextUrl.searchParams.get('container');
    if (!db || !container) {
      return NextResponse.json({ ok: false, error: 'db and container query params are required' }, { status: 400 });
    }
    const detail = await getContainer(db, container);
    if (!detail) return NextResponse.json({ ok: false, error: `container ${db}/${container} not found` }, { status: 404 });
    return NextResponse.json({ ok: true, container: detail });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: NextRequest) {
  const unauth = requireSession(); if (unauth) return unauth;
  const gated = gateResponse(); if (gated) return gated;
  try {
    const body = await readBody<{
      db?: string; container?: string;
      defaultTtl?: number | null;
      indexingPolicy?: CosmosIndexingPolicy;
    }>(req);
    if (!body.db?.trim() || !body.container?.trim()) {
      return NextResponse.json({ ok: false, error: 'db and container are required' }, { status: 400 });
    }
    if (body.defaultTtl === undefined && !body.indexingPolicy) {
      return NextResponse.json({ ok: false, error: 'nothing to update (provide defaultTtl and/or indexingPolicy)' }, { status: 400 });
    }
    const detail = await updateContainerSettings(body.db.trim(), body.container.trim(), {
      defaultTtl: body.defaultTtl,
      indexingPolicy: body.indexingPolicy,
    });
    return NextResponse.json({ ok: true, container: detail });
  } catch (e) {
    return errorResponse(e);
  }
}
