/**
 * /api/cloud — which cloud boundary this Loom deployment runs in.
 *
 * Backs the header CloudBadge (operator ask 2026-07-14): every user sees an
 * always-visible assurance of the boundary they are working in — Commercial,
 * GCC, GCC-High (Azure Government), or DoD — derived from the SAME
 * detectLoomCloud() switch every Azure client in lib/azure keys endpoints off,
 * so the badge can never disagree with where the data-plane calls actually go.
 *
 * Unauthenticated by design: the welcome page already brands the boundary, and
 * the badge must render before sign-in completes. No tenant data is exposed —
 * only the cloud name and (when the deploy stamped it) the Azure region.
 */

import { NextResponse } from 'next/server';
import { detectLoomCloud, detectCloud } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    cloud: detectLoomCloud(),
    azureCloud: detectCloud(),
    region: process.env.LOOM_LOCATION || null,
  });
}
