/**
 * /api/cosmos/container-throughput — a container's provisioned RU/s.
 *
 *   GET   ?db=<name>&container=<name>                          → { ok, throughput }
 *   PATCH { db, container, mode, value? }                      → { ok, throughput }
 *
 * mode:
 *   'manual'             → PUT throughputSettings/default { throughput: value }
 *   'autoscale'          → PUT throughputSettings/default { autoscaleSettings.maxThroughput: value }
 *   'migrateToAutoscale' → POST …/migrateToAutoscale          (manual → autoscale, value ignored)
 *   'migrateToManual'    → POST …/migrateToManualThroughput   (autoscale → manual, value ignored)
 *
 * Real backend (no JSON textareas):
 *   …/sqlDatabases/{db}/containers/{c}/throughputSettings/default (ARM 2024-11-15)
 *   via lib/azure/cosmos-account-client.ts. The Console UAMI needs
 *   "Cosmos DB Operator" / "DocumentDB Account Contributor" at the account scope.
 *
 * Switching mode requires the migrate actions (a plain PUT can't change mode —
 * ARM returns 400). The panel sends migrate* first, then a value PUT if needed.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getContainerThroughput, updateContainerThroughput,
  migrateContainerToAutoscale, migrateContainerToManual,
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
    const throughput = await getContainerThroughput(db, container);
    return NextResponse.json({ ok: true, throughput });
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
      mode?: 'manual' | 'autoscale' | 'migrateToAutoscale' | 'migrateToManual';
      value?: number;
    }>(req);
    if (!body.db?.trim() || !body.container?.trim()) {
      return NextResponse.json({ ok: false, error: 'db and container are required' }, { status: 400 });
    }
    const db = body.db.trim();
    const container = body.container.trim();
    let throughput;
    switch (body.mode) {
      case 'migrateToAutoscale':
        throughput = await migrateContainerToAutoscale(db, container);
        break;
      case 'migrateToManual':
        throughput = await migrateContainerToManual(db, container);
        break;
      case 'manual':
      case 'autoscale': {
        const value = Number(body.value);
        if (!(value > 0)) {
          return NextResponse.json({ ok: false, error: 'value must be a positive number of RU/s' }, { status: 400 });
        }
        throughput = await updateContainerThroughput(db, container, body.mode, value);
        break;
      }
      default:
        return NextResponse.json(
          { ok: false, error: "mode must be 'manual', 'autoscale', 'migrateToAutoscale', or 'migrateToManual'" },
          { status: 400 },
        );
    }
    return NextResponse.json({ ok: true, throughput });
  } catch (e) {
    return errorResponse(e);
  }
}
