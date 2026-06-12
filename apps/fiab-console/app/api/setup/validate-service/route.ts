/**
 * POST /api/setup/validate-service
 *   Honest per-service compatibility validation for the adopt-existing
 *   discovery step (D6). Given a chosen candidate (from discover-services) and
 *   the wizard's target region + boundary, runs REAL checks against ARM and
 *   returns a precise pass / warn / fail per check — never a faked green tick
 *   (per no-vaporware.md):
 *
 *     • Region      — candidate.region vs targetRegion. WARN on a mismatch
 *                     (cross-region latency / egress); some services treat it
 *                     as a hard FAIL (descriptor.regionHard).
 *     • Permissions — ARM GET on the candidate's resource id confirms the
 *                     Console UAMI can at least read it (a reuse pick must be
 *                     followed by grant-navigator-rbac.sh for write roles).
 *                     A 403 here is an honest FAIL with the exact follow-up.
 *     • SKU / kind  — service-specific: AOAI must be kind AIServices/OpenAI and
 *                     have a chat + embeddings deployment IN-REGION (else WARN);
 *                     Purview is one-per-tenant so deploy-new is BLOCKED when a
 *                     tenant account exists (cite EnterpriseTenantAlreadyExists).
 *
 *   Body:  { serviceKey, candidate, targetRegion, boundary }
 *   Reply: { ok: true, checks: ServiceCheck[], worst, reuseRequired? }
 *          { ok: false, error }
 */
import { NextRequest, NextResponse } from 'next/server';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { getSession } from '@/lib/auth/session';
import { armBase } from '@/lib/azure/cloud-endpoints';
import { serviceByKey, type ServiceCandidate, type ServiceCheck } from '@/lib/setup/shared-services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

interface ValidateBody {
  serviceKey?: string;
  candidate?: ServiceCandidate;
  targetRegion?: string;
  boundary?: string;
}

/** Worst status across a set of checks (fail > warn > pass). */
function worstOf(checks: ServiceCheck[]): 'pass' | 'warn' | 'fail' {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'pass';
}

async function armToken(): Promise<string> {
  const t = await credential.getToken(`${armBase()}/.default`);
  if (!t?.token) throw new Error('empty ARM token');
  return t.token;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as ValidateBody;
  const svc = serviceByKey(body.serviceKey || '');
  const cand = body.candidate;
  if (!svc) return NextResponse.json({ ok: false, error: `unknown serviceKey: ${body.serviceKey}` }, { status: 400 });
  if (!cand?.id || !cand.name) {
    return NextResponse.json({ ok: false, error: 'candidate (id + name) is required' }, { status: 400 });
  }

  const arm = armBase();
  const targetRegion = (body.targetRegion || '').toLowerCase();
  const checks: ServiceCheck[] = [];

  // ── 1. Region ──────────────────────────────────────────────────────────
  const candRegion = (cand.region || '').toLowerCase();
  if (!targetRegion) {
    checks.push({ label: 'Region', status: 'warn', detail: 'No target region selected yet — pick the deployment region to validate co-location.' });
  } else if (candRegion === targetRegion) {
    checks.push({ label: 'Region', status: 'pass', detail: `Co-located in ${cand.region}.` });
  } else {
    checks.push({
      label: 'Region',
      status: svc.regionHard ? 'fail' : 'warn',
      detail: `${svc.label} is in ${cand.region || 'an unknown region'} but the deployment targets ${body.targetRegion}. ${
        svc.regionHard
          ? 'Data-plane co-location is required for this service.'
          : 'Cross-region reuse works but adds latency / egress cost.'
      }`,
    });
  }

  // ── 2. Permissions — real ARM GET on the resource id ─────────────────────
  let token: string;
  try {
    token = await armToken();
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `auth failed: ${e?.message ?? String(e)}` },
      { status: 502 },
    );
  }

  // A generic resource GET. ARM requires an api-version; the latest generic
  // resources API works for any provider type.
  try {
    const r = await fetch(`${arm}${cand.id}?api-version=2024-03-01`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (r.ok) {
      checks.push({
        label: 'Permissions',
        status: 'pass',
        detail: 'The Console identity can read this resource. Run grant-navigator-rbac.sh after deploy to grant the data-plane roles for reuse.',
      });
    } else if (r.status === 403 || r.status === 401) {
      checks.push({
        label: 'Permissions',
        status: 'fail',
        detail: `The Console identity cannot read ${cand.name} (HTTP ${r.status}). Grant it at least Reader on ${cand.rg}/${cand.subscriptionId}, then re-validate. Reuse also needs the data-plane roles from grant-navigator-rbac.sh.`,
      });
    } else if (r.status === 404) {
      checks.push({
        label: 'Permissions',
        status: 'warn',
        detail: `Resource not found at the generic API (HTTP 404) — it may use a provider-specific api-version. The reuse wiring still applies; confirm RBAC manually.`,
      });
    } else {
      const t = await r.text().catch(() => '');
      checks.push({ label: 'Permissions', status: 'warn', detail: `ARM returned HTTP ${r.status}: ${t.slice(0, 140)}` });
    }
  } catch (e: any) {
    checks.push({ label: 'Permissions', status: 'warn', detail: `Permission probe failed: ${e?.message ?? String(e)}` });
  }

  // ── 3. Service-specific SKU / kind / capability checks ───────────────────
  let reuseRequired = false;

  if (svc.key === 'aoai') {
    const k = (cand.kind || '').toLowerCase();
    if (k !== 'aiservices' && k !== 'openai') {
      checks.push({
        label: 'Kind',
        status: 'fail',
        detail: `Account kind is "${cand.kind || 'unknown'}" — Loom needs an AIServices or OpenAI account for chat + embeddings.`,
      });
    } else {
      // Real ARM list of model deployments on the account.
      try {
        const dr = await fetch(`${arm}${cand.id}/deployments?api-version=2023-05-01`, {
          headers: { authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        if (dr.ok) {
          const dj: any = await dr.json();
          const deployments = (dj?.value || []) as any[];
          const models = deployments.map((d) => String(d?.properties?.model?.name || '').toLowerCase());
          const hasChat = models.some((m) => m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('phi'));
          const hasEmbed = models.some((m) => m.includes('embedding') || m.includes('embed') || m.includes('ada'));
          if (hasChat && hasEmbed) {
            checks.push({ label: 'Model deployments', status: 'pass', detail: `Found chat + embeddings deployments (${deployments.length} total).` });
          } else {
            const missing = [!hasChat ? 'a chat model' : null, !hasEmbed ? 'an embeddings model' : null].filter(Boolean).join(' and ');
            checks.push({
              label: 'Model deployments',
              status: 'warn',
              detail: `No ${missing} deployment found on this account in ${cand.region || 'its region'}. AI Functions / Copilot need both — deploy them (or pick another account) before reuse.`,
            });
          }
        } else {
          checks.push({
            label: 'Model deployments',
            status: 'warn',
            detail: `Could not list model deployments (HTTP ${dr.status}). Grant the Console identity Cognitive Services Contributor/Reader and re-validate.`,
          });
        }
      } catch (e: any) {
        checks.push({ label: 'Model deployments', status: 'warn', detail: `Deployment list failed: ${e?.message ?? String(e)}` });
      }
    }
  }

  if (svc.key === 'purview') {
    // Purview is one-per-tenant: a discovered account means deploy-new is
    // blocked (EnterpriseTenantAlreadyExists). Pin the choice to reuse.
    reuseRequired = true;
    checks.push({
      label: 'Tenant policy',
      status: 'pass',
      detail: 'A Microsoft Purview account already exists in this tenant. Loom reuses it — deploying a second account fails with EnterpriseTenantAlreadyExists, so "Deploy new" is blocked.',
    });
  }

  if (svc.key === 'keyvault' && cand.sku) {
    // No hard gate, but surface the SKU so operators know premium (HSM) vs standard.
    checks.push({ label: 'SKU', status: 'pass', detail: `Key Vault SKU: ${cand.sku}.` });
  }

  if (svc.key === 'gateway') {
    checks.push({
      label: 'Ingress',
      status: 'pass',
      detail: 'Reusing this gateway routes Loom ingress through it — add the Console / APIM backend pool + listener after deploy.',
    });
  }

  return NextResponse.json({ ok: true, checks, worst: worstOf(checks), reuseRequired });
}
