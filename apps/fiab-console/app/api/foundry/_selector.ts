/**
 * Shared helper: parse the AI Foundry account selector from a Foundry BFF
 * request. The Hub's account picker passes `?account=<name>&rg=<rg>` on GETs
 * and `{ account, rg }` in the JSON body on mutating calls. When absent, the
 * client falls back to the env-var default (LOOM_AOAI_ACCOUNT) / discovery.
 */
import type { NextRequest } from 'next/server';
import type { AccountSelector } from '@/lib/azure/foundry-cs-client';

/** From query string (`?account=&rg=&sub=`). */
export function selectorFromQuery(req: NextRequest): AccountSelector | undefined {
  const name = req.nextUrl.searchParams.get('account')?.trim();
  if (!name) return undefined;
  const rg = req.nextUrl.searchParams.get('rg')?.trim() || undefined;
  const sub = req.nextUrl.searchParams.get('sub')?.trim() || undefined;
  return { name, rg, sub };
}

/** From a parsed JSON body (`{ account, rg, sub }`). */
export function selectorFromBody(body: any): AccountSelector | undefined {
  const name = typeof body?.account === 'string' ? body.account.trim() : '';
  if (!name) return undefined;
  const rg = typeof body?.rg === 'string' && body.rg.trim() ? body.rg.trim() : undefined;
  const sub = typeof body?.sub === 'string' && body.sub.trim() ? body.sub.trim() : undefined;
  return { name, rg, sub };
}
