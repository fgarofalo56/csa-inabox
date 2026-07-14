/**
 * POST /api/internal/copilot/memory/consolidate  (GET probe) — CTS-13.
 *
 * The nightly memory consolidation pass (dedupe near-duplicates, flag
 * contradictions, promote topics) run as an EXTERNAL timer hits this endpoint —
 * the SAME proven pattern as /api/internal/spark/keep-warm and the scheduler
 * tick. Auth is the shared internal trust token (LOOM_INTERNAL_TOKEN), NOT a user
 * session — this is machine-to-machine. A GitHub Actions `schedule:` workflow and
 * the loom-memory-consolidate ACA cron Job both drive it.
 *
 * Real backend: Cosmos `copilot-memory` + the AI Search vector mirror via
 * runConsolidation(). Honest no-op when the memory brain is disabled.
 */

import { NextRequest } from 'next/server';
import { isValidInternalToken, INTERNAL_TOKEN_HEADER } from '@/lib/auth/internal-token';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { runConsolidation } from '@/lib/azure/memory-consolidate';
import { isMemoryBrainEnabled } from '@/lib/azure/memory-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authed(req: NextRequest): boolean {
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const header = req.headers.get(INTERNAL_TOKEN_HEADER);
  return isValidInternalToken(bearer || null) || isValidInternalToken(header);
}

async function consolidate() {
  if (!isMemoryBrainEnabled()) {
    return apiOk({ skipped: true, reason: 'memory brain disabled (LOOM_COPILOT_MEMORY=false)' });
  }
  try {
    const run = await runConsolidation();
    return apiOk({
      scopes: run.scopes,
      merged: run.totalMerged,
      contradictions: run.totalContradictions,
      topics: run.totalTopics,
      at: run.at,
    });
  } catch (e) {
    return apiServerError(e, 'consolidation run failed', 'memory_consolidate_failed');
  }
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return apiError('invalid internal token', 401, { code: 'bad_internal_token' });
  return consolidate();
}

export async function GET(req: NextRequest) {
  if (!authed(req)) return apiError('invalid internal token', 401, { code: 'bad_internal_token' });
  return apiOk({ ok: true, ready: isMemoryBrainEnabled() });
}
