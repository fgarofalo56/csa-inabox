/**
 * GET /api/setup/existing-aoai
 *   Discovers existing Azure OpenAI / AI Foundry (AIServices) accounts across
 *   every subscription the Console identity can see, via Azure Resource Graph,
 *   then enumerates each account's MODEL DEPLOYMENTS (ARM management plane) so
 *   the Setup Wizard's AOAI card can offer: use-existing / provision-new /
 *   disable — WITH a recommendation (reuse when a gpt-4o-class chat AND an
 *   embeddings deployment already exist, which avoids paying for a duplicate
 *   model; otherwise provision-new).
 *
 *   This is the in-console twin of scripts/csa-loom/discover-services.sh's
 *   `scan_aoai` (CLI). Both feed the same wiring: `agentFoundryEnabled` to
 *   provision new, or `existingFoundryAccountName` + the discovered chat/embed
 *   deployment names to reuse.
 *
 *   No mock data — Resource Graph honours RBAC, so when the principal can see no
 *   AIServices accounts the list is genuinely empty and the wizard recommends
 *   provision-new (per no-vaporware.md).
 *
 * Response shape:
 *   { ok: true, recommendation: 'reuse'|'new', accounts: [{
 *       name, resourceGroup, subscriptionId, location, kind,
 *       chatDeployment, embedDeployment, deployments: [{name, model}]
 *   }] }
 *   { ok: false, error, hint? }
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { armBase } from '@/lib/azure/cloud-endpoints';
import { uamiArmCredential } from '@/lib/azure/arm-credential';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const credential = uamiArmCredential();

interface AoaiDeployment {
  name: string;
  model: string;
}
interface AoaiAccount {
  name: string;
  resourceGroup: string;
  subscriptionId: string;
  location: string;
  kind: string;
  chatDeployment: string;
  embedDeployment: string;
  deployments: AoaiDeployment[];
}

const CHAT_RE = /gpt-4o|gpt-4\.1|gpt-4|gpt-35|gpt-3\.5/i;
const EMBED_RE = /embedding/i;

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const arm = armBase();
  let token: string;
  try {
    const t = await credential.getToken(`${arm}/.default`);
    if (!t?.token) throw new Error('empty token');
    token = t.token;
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: `auth failed: ${e?.message ?? String(e)}`,
        hint: 'The Console identity could not acquire an ARM token. Grant the Console UAMI Reader on the subscriptions to scan for existing AOAI accounts.',
      },
      { status: 502 },
    );
  }

  // 1) Resource Graph: AIServices / OpenAI accounts the principal can read.
  let accountsRaw: any[] = [];
  try {
    const res = await fetch(
      `${arm}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          query:
            "Resources | where type =~ 'Microsoft.CognitiveServices/accounts' " +
            "| where kind in~ ('AIServices','OpenAI') " +
            '| project name, resourceGroup, subscriptionId, location, kind ' +
            '| order by name asc',
        }),
        cache: 'no-store',
      },
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return NextResponse.json(
        { ok: false, error: `Resource Graph ${res.status}: ${t.slice(0, 200)}` },
        { status: 502 },
      );
    }
    const j: any = await res.json();
    accountsRaw = (j?.data || []) as any[];
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `Resource Graph request failed: ${e?.message ?? String(e)}` },
      { status: 502 },
    );
  }

  // 2) For each account (cap to a sane number), enumerate model deployments via
  //    the ARM management plane and classify chat / embed.
  const accounts: AoaiAccount[] = [];
  for (const a of accountsRaw.slice(0, 25)) {
    const deployments: AoaiDeployment[] = [];
    try {
      const url =
        `${arm}/subscriptions/${a.subscriptionId}/resourceGroups/${a.resourceGroup}` +
        `/providers/Microsoft.CognitiveServices/accounts/${a.name}/deployments?api-version=2023-05-01`;
      const r = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      if (r.ok) {
        const dj: any = await r.json().catch(() => null);
        for (const d of dj?.value || []) {
          deployments.push({ name: d?.name || '', model: d?.properties?.model?.name || '' });
        }
      }
    } catch {
      // Deployment enumeration is best-effort; the account still appears.
    }
    const chat = deployments.find((d) => CHAT_RE.test(d.model))?.name || '';
    const embed = deployments.find((d) => EMBED_RE.test(d.model))?.name || '';
    accounts.push({
      name: a.name,
      resourceGroup: a.resourceGroup,
      subscriptionId: a.subscriptionId,
      location: a.location || '',
      kind: a.kind || '',
      chatDeployment: chat,
      embedDeployment: embed,
      deployments,
    });
  }

  // Recommend reuse only when some account already has a complete chat+embed
  // pair (avoids a duplicate model deployment + its cost); otherwise new.
  const recommendation = accounts.some((a) => a.chatDeployment && a.embedDeployment)
    ? 'reuse'
    : 'new';

  return NextResponse.json({ ok: true, recommendation, accounts });
}
