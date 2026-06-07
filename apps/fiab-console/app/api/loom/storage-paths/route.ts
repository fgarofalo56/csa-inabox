/**
 * GET /api/loom/storage-paths
 *
 * Returns the deployment's well-known ADLS Gen2 medallion container roots so the
 * Get-Data wizard can offer one-click "quick-pick" buttons (Bronze / Silver /
 * Gold / Landing) instead of forcing the operator to hand-type an abfss:// URL.
 *
 * The values come straight from the bicep-emitted env vars
 * (LOOM_BRONZE_URL / LOOM_SILVER_URL / LOOM_GOLD_URL / LOOM_LANDING_URL) which
 * are already cloud-aware (`environment().suffixes.storage`). No mocks: if none
 * are set the list is simply empty and the UI hides the quick-pick row — an
 * honest config-only state, not a fake.
 *
 * Per .claude/rules/no-vaporware.md — real env-sourced config, structured JSON.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface LoomStorageContainer {
  label: string;
  /** abfss://-style not required — the bicep value is the https:// dfs root. */
  url: string;
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const candidates: Array<{ label: string; raw: string | undefined }> = [
    { label: 'Bronze', raw: process.env.LOOM_BRONZE_URL },
    { label: 'Silver', raw: process.env.LOOM_SILVER_URL },
    { label: 'Gold', raw: process.env.LOOM_GOLD_URL },
    { label: 'Landing zone', raw: process.env.LOOM_LANDING_URL },
  ];

  const containers: LoomStorageContainer[] = candidates
    .filter((c): c is { label: string; raw: string } => !!c.raw && c.raw.trim().length > 0)
    .map((c) => ({ label: c.label, url: c.raw.trim() }));

  return NextResponse.json({ ok: true, containers });
}
