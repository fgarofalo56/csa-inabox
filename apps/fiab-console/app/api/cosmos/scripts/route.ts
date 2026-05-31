/**
 * /api/cosmos/scripts — read-only server-side scripts for a container:
 * stored procedures, triggers, and user-defined functions.
 *
 *   GET ?db=<name>&container=<name>
 *     → { ok, storedProcedures:[…], triggers:[…], userDefinedFunctions:[…] }
 *
 * Real backend (all three, in parallel):
 *   …/sqlDatabases/{db}/containers/{c}/storedProcedures
 *   …/sqlDatabases/{db}/containers/{c}/triggers
 *   …/sqlDatabases/{db}/containers/{c}/userDefinedFunctions
 *   (ARM api-version 2024-11-15) via lib/azure/cosmos-account-client.ts.
 *
 * Authoring/editing script bodies is a rich JS data-plane surface; the
 * navigator lists existing scripts (parity with Data Explorer's Scripts node)
 * and discloses create/edit as an honest "coming" row in the UI.
 */

import { NextRequest, NextResponse } from 'next/server';
import { listContainerScripts } from '@/lib/azure/cosmos-account-client';
import { requireSession, gateResponse, errorResponse } from '../_shared';

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
    const scripts = await listContainerScripts(db, container);
    return NextResponse.json({ ok: true, ...scripts });
  } catch (e) {
    return errorResponse(e);
  }
}
