/**
 * Browser-automation tool status (AIF-18). Reports whether a Playwright runner
 * is wired so the Agents editor can render the honest gate when the
 * browser_automation tool is selected but no runner is deployed.
 *
 *   GET /api/foundry/browser-tool/status
 *     → { ok, configured, mode: 'endpoint'|'job'|'none', env, hint? }
 *
 * No backend call — pure config read. See .claude/rules/no-vaporware.md.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { browserToolStatus } from '@/lib/azure/browser-tool-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  return NextResponse.json({ ok: true, ...browserToolStatus() });
}
