/**
 * GET /api/health/deep — DEEP health (dependency) check.
 *
 * Distinct from the shallow /api/health (Liveness/Readiness): this probes the
 * real backing dependencies — Cosmos reachability + Log Analytics (LAW) token
 * acquisition — within a ~2s budget.
 *
 * ALWAYS returns HTTP 200 (LIVENESS semantics): a Cosmos blip or a LAW token
 * hiccup must NOT make the ACA Envoy cycle replicas. The body reflects the
 * degraded dependency instead:
 *   { ok: boolean, checks: [{ name, ok, ms, error? }] }
 * `ok` is the AND of all checks; consumers (dashboards / alerts) read the body,
 * not the status code.
 *
 * no-vaporware: these are REAL probes — `probeCosmosReachable` does a real
 * getDatabaseAccount, and the LAW check does a real credential.getToken against
 * the sovereign-correct Log Analytics audience. Tokens are NEVER logged or
 * returned; only { name, ok, ms } (+ a short, token-free error string).
 */

import { NextResponse } from 'next/server';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { logAnalyticsTokenScope } from '@/lib/azure/cloud-endpoints';
import { probeCosmosReachable } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BUDGET_MS = Number(process.env.LOOM_HEALTH_DEEP_BUDGET_MS) || 2000;

interface Check {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

/** Bound a promise to the deep-health budget (reject on timeout). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** Short, token-free error label. */
function short(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  return m.slice(0, 120);
}

async function timed(name: string, fn: () => Promise<void>): Promise<Check> {
  const start = Date.now();
  try {
    await withTimeout(fn(), BUDGET_MS);
    return { name, ok: true, ms: Date.now() - start };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - start, error: short(e) };
  }
}

function lawCredential(): TokenCredential {
  const clientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  const chain: TokenCredential[] = [new AcaManagedIdentityCredential()];
  if (clientId) chain.push(new ManagedIdentityCredential({ clientId }));
  chain.push(new DefaultAzureCredential());
  return new ChainedTokenCredential(...chain);
}

export async function GET() {
  const checks = await Promise.all([
    // Cosmos reachability — real getDatabaseAccount, bounded.
    timed('cosmos', async () => {
      await probeCosmosReachable(BUDGET_MS);
    }),
    // LAW token acquisition — proves the UAMI can mint a Log Analytics-audience
    // token (the prerequisite for every Monitor/audit query). We acquire only;
    // the token is discarded and never logged.
    timed('log-analytics-token', async () => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), BUDGET_MS);
      try {
        const tok = await lawCredential().getToken(logAnalyticsTokenScope(), {
          abortSignal: ac.signal,
        });
        if (!tok?.token) throw new Error('no Log Analytics token returned');
      } finally {
        clearTimeout(t);
      }
    }),
  ]);

  const ok = checks.every((c) => c.ok);
  // ALWAYS 200 — liveness semantics. A degraded dep shows in the body.
  return NextResponse.json({ ok, checks }, { status: 200 });
}
