/**
 * GET /api/admin/gates/[id]/options — REAL ARM discovery for a gate's Fix-it
 * picker: enumerates the live Azure resources that can satisfy each required
 * setting (e.g. every Synapse workspace / Event Hubs namespace / AOAI account
 * in the deployment's subscription(s)) so the operator PICKS from what exists
 * instead of typing (no-vaporware.md — real list calls, never a canned list).
 *
 * Loader semantics (lib/gates/registry.ts GateOptionsLoader):
 *   - subscription-scope list: GET /subscriptions/{sub}/resources?$filter=
 *     resourceType eq '<armType>' (admin sub + DLZ sub when distinct);
 *   - valueFrom 'name'|'id' resolves from the list response;
 *   - valueFrom 'properties.<path>' does a bounded per-resource GET with the
 *     loader's api-version (first 15 resources);
 *   - special 'aoai-deployments' walks OpenAI/AIServices accounts and lists
 *     their model deployments.
 *
 * Response: { ok, options: { [envVar]: Array<{ value, label, resourceId }> } }.
 * A gate setting without a loader is simply absent — the dialog renders a
 * free-text input with the registry valueHint for those.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { apiNotFound, apiError } from '@/lib/api/respond';
import { getGate, type GateOptionsLoader } from '@/lib/gates/registry';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const credential = uamiArmCredential();

export interface GateOption {
  value: string;
  label: string;
  resourceId: string;
}

function subs(): string[] {
  const out = new Set<string>();
  for (const k of ['LOOM_SUBSCRIPTION_ID', 'LOOM_DLZ_SUBSCRIPTION_ID']) {
    const v = (process.env[k] || '').trim();
    if (v) out.add(v);
  }
  return Array.from(out);
}

async function armGet(token: string, url: string): Promise<any> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`ARM ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

function pluck(obj: any, path: string): string {
  let cur = obj;
  for (const part of path.split('.')) cur = cur?.[part];
  return typeof cur === 'string' ? cur : cur != null ? String(cur) : '';
}

async function listResources(token: string, armType: string): Promise<any[]> {
  const all: any[] = [];
  for (const sub of subs()) {
    const filter = encodeURIComponent(`resourceType eq '${armType}'`);
    let url: string | undefined =
      `${armBase()}/subscriptions/${sub}/resources?$filter=${filter}&api-version=2021-04-01`;
    while (url) {
      const page = await armGet(token, url);
      all.push(...(page.value || []));
      url = page.nextLink;
      if (all.length >= 100) break; // bounded — a picker, not an inventory
    }
  }
  return all;
}

async function loadOptions(token: string, loader: GateOptionsLoader): Promise<GateOption[]> {
  // Special: enumerate AOAI model deployments across OpenAI/AIServices accounts.
  if (loader.special === 'aoai-deployments') {
    const accounts = (await listResources(token, 'Microsoft.CognitiveServices/accounts'))
      .filter((a) => !loader.kindFilter || loader.kindFilter.includes(a.kind) || ['OpenAI', 'AIServices'].includes(a.kind))
      .slice(0, 10);
    const out: GateOption[] = [];
    for (const a of accounts) {
      try {
        const deps = await armGet(token, `${armBase()}${a.id}/deployments?api-version=2023-05-01`);
        for (const d of deps.value || []) {
          out.push({
            value: d.name,
            label: `${d.name} (${d.properties?.model?.name || 'model'} @ ${a.name})`,
            resourceId: d.id,
          });
        }
      } catch { /* account without list permission — skip, never fake */ }
    }
    return out;
  }

  let resources = await listResources(token, loader.armType);
  if (loader.kindFilter?.length) {
    resources = resources.filter((r) => loader.kindFilter!.includes(r.kind));
  }
  resources = resources.slice(0, 15); // bounded per-resource GETs below

  const out: GateOption[] = [];
  for (const r of resources) {
    let value: string;
    if (loader.valueFrom === 'name') value = r.name;
    else if (loader.valueFrom === 'id') value = r.id;
    else {
      // properties.<path> — the subscription list omits properties; fetch the
      // resource with the loader's api-version (real ARM GET, bounded above).
      try {
        const full = await armGet(
          token,
          `${armBase()}${r.id}?api-version=${loader.armApiVersion || '2021-04-01'}`,
        );
        value = pluck(full, loader.valueFrom);
      } catch {
        continue; // unreadable resource — skip rather than fabricate a value
      }
    }
    if (!value) continue;
    out.push({ value, label: `${r.name} (${r.location || 'unknown region'})`, resourceId: r.id });
  }
  return out;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  const capGate = await enforceCapability(session, 'admin.env-config', 'Admin');
  if (capGate) return capGate;

  const { id } = await ctx.params;
  const gate = getGate(id);
  if (!gate) return apiNotFound(`unknown gate id '${id}'`);

  if (!process.env.LOOM_SUBSCRIPTION_ID) {
    return apiError(
      'LOOM_SUBSCRIPTION_ID not set — ARM discovery needs the deployment subscription. Enter values manually or resolve the "Azure subscription + resource groups" gate first.',
      503,
      { code: 'not_configured', missing: 'LOOM_SUBSCRIPTION_ID' },
    );
  }

  let token: string;
  try {
    const t = await credential.getToken(armScope());
    token = t!.token;
  } catch (e: any) {
    return apiError(`ARM auth failed: ${e?.message || String(e)}`, 502);
  }

  const options: Record<string, GateOption[]> = {};
  const errors: Record<string, string> = {};
  for (const s of gate.requiredSettings) {
    if (!s.loader) continue;
    try {
      options[s.envVar] = await loadOptions(token, s.loader);
    } catch (e: any) {
      errors[s.envVar] = e?.message || String(e);
    }
  }

  return NextResponse.json({ ok: true, gateId: id, options, errors });
}
