/**
 * POST /api/setup/quota-preflight
 *
 * Predicts whether the selected topology's DLZ deploy would be blocked by Azure
 * vCPU quota BEFORE `az deployment sub create` fires. For each target
 * subscription + region it reads the read-only Compute usages API:
 *
 *   GET {arm}/subscriptions/{sub}/providers/Microsoft.Compute/locations/{loc}/usages
 *
 * and evaluates the Total Regional vCPUs aggregate + the VM-family tiers the
 * topology consumes (Gov AKS Ddsv5; SHIR Dsv5 scale-to-0 advisory) via the pure
 * evaluator in lib/setup/quota-preflight. Reader is sufficient — the same right
 * the wizard already needs to list subscriptions — so the pre-flight never needs
 * elevated rights; it only reads usage.
 *
 * This is a GATE, not a blocker: the wizard surfaces an honest per-tier warning
 * (SKU + region + current/limit + a "request quota increase" portal link) and
 * still lets the operator proceed (quota may be requested out of band).
 *
 * Request body:
 *   { boundary, targets: [{ subscriptionId, subscriptionName?, location, role? }] }
 *     role: 'full' (hosts the container platform — single-sub/hub) | 'spoke'
 *
 * Response:
 *   { ok: true,  evaluations: QuotaEvaluation[] }   (ok=false on any hard-fail tier)
 *   { ok: false, error }                            on auth / bad-request
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { armBase } from '@/lib/azure/cloud-endpoints';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import {
  requiredComputeForDeploy,
  evaluateQuota,
  type ComputeUsageEntry,
  type QuotaBoundary,
  type QuotaEvaluation,
} from '@/lib/setup/quota-preflight';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCATION_RE = /^[a-z0-9]{1,40}$/i;

const credential = uamiArmCredential();

async function armToken(): Promise<string> {
  const t = await credential.getToken(`${armBase()}/.default`);
  if (!t?.token) throw new Error('Failed to acquire AAD token for ARM');
  return t.token;
}

interface TargetInput {
  subscriptionId: string;
  subscriptionName?: string;
  location: string;
  role?: 'full' | 'spoke';
}

/** Read the Compute usages for one subscription + region. */
async function readComputeUsages(
  subscriptionId: string,
  location: string,
  token: string,
): Promise<{ usages: ComputeUsageEntry[]; error?: string }> {
  try {
    const res = await fetch(
      `${armBase()}/subscriptions/${subscriptionId}/providers/Microsoft.Compute/locations/${encodeURIComponent(
        location,
      )}/usages?api-version=2024-07-01`,
      { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' },
    );
    const ct = res.headers.get('content-type') || '';
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { usages: [], error: `Compute usages ${res.status}: ${t.slice(0, 200)}` };
    }
    if (!ct.includes('application/json')) {
      const t = await res.text().catch(() => '');
      return { usages: [], error: `Compute usages returned non-JSON (${ct || 'unknown'}): ${t.slice(0, 160)}` };
    }
    const j: any = await res.json();
    return { usages: (j?.value || []) as ComputeUsageEntry[] };
  } catch (e: any) {
    return { usages: [], error: `Compute usages request failed: ${e?.message ?? String(e)}` };
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: { boundary?: QuotaBoundary; targets?: TargetInput[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const boundary = body.boundary;
  const rawTargets = Array.isArray(body.targets) ? body.targets : [];
  // Validate + de-duplicate targets by (sub, location). Skip malformed rows
  // rather than 400 the whole request — a partial pre-flight still helps.
  const seen = new Set<string>();
  const targets: TargetInput[] = [];
  for (const t of rawTargets) {
    const sub = (t?.subscriptionId || '').trim();
    const loc = (t?.location || '').trim();
    if (!GUID_RE.test(sub) || !LOCATION_RE.test(loc)) continue;
    const key = `${sub}/${loc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ subscriptionId: sub, subscriptionName: t.subscriptionName, location: loc, role: t.role });
  }

  if (targets.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'no valid { subscriptionId, location } targets supplied' },
      { status: 400 },
    );
  }

  let token: string;
  try {
    token = await armToken();
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: `auth failed: ${e?.message ?? String(e)}`,
        hint: 'The Console identity could not acquire an ARM token. Grant the Console UAMI (or your az-login principal) Reader on the target subscriptions.',
      },
      { status: 502 },
    );
  }

  const evaluations: (QuotaEvaluation & { error?: string })[] = [];
  for (const t of targets) {
    const { usages, error } = await readComputeUsages(t.subscriptionId, t.location, token);
    const required = requiredComputeForDeploy({ boundary, role: t.role ?? 'full' });
    const evaluation = evaluateQuota({
      subscriptionId: t.subscriptionId,
      subscriptionName: t.subscriptionName,
      location: t.location,
      required,
      usages,
    });
    evaluations.push(error ? { ...evaluation, error } : evaluation);
  }

  const ok = evaluations.every((e) => e.ok || e.error);
  return NextResponse.json({ ok, evaluations });
}
