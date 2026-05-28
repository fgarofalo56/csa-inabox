/**
 * POST   /api/items/copilot-template-library/[id]  — instantiate template into a Copilot Studio agent
 *   body: { envId }
 *   Creates a new msdyn_copilot in the target environment seeded with the
 *   template's name/description/instructions, then materializes the template's
 *   knowledge sources and topics. Returns the created agent.
 *
 * DELETE /api/items/copilot-template-library/[id]  — delete custom template (built-in templates are protected)
 */

import { NextRequest, NextResponse } from 'next/server';
import type { Container } from '@azure/cosmos';
import { CosmosClient } from '@azure/cosmos';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { getSession } from '@/lib/auth/session';
import {
  createAgent, addKnowledgeSource, upsertTopic, CopilotStudioError,
  type KnowledgeSourceType,
} from '@/lib/azure/copilot-studio-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TENANT_PK = process.env.LOOM_TEMPLATE_TENANT || 'csa';

function credential() {
  const clientId = process.env.LOOM_UAMI_CLIENT_ID;
  const chain: any[] = [];
  if (clientId) chain.push(new ManagedIdentityCredential({ clientId }));
  chain.push(new DefaultAzureCredential());
  return new ChainedTokenCredential(...chain);
}

let _container: Container | null = null;
async function getContainer(): Promise<Container> {
  if (_container) return _container;
  const endpoint = process.env.LOOM_COSMOS_ENDPOINT;
  if (!endpoint) throw new Error('LOOM_COSMOS_ENDPOINT not set');
  const client = new CosmosClient({ endpoint, aadCredentials: credential() });
  const databaseId = process.env.LOOM_COSMOS_DATABASE || 'loom';
  const { database } = await client.databases.createIfNotExists({ id: databaseId });
  const { container } = await database.containers.createIfNotExists({
    id: 'copilot-template-library',
    partitionKey: { paths: ['/tenantId'] },
  });
  _container = container;
  return container;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const container = await getContainer();
    const { resource } = await container.item((await ctx.params).id, TENANT_PK).read<any>();
    if (!resource) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true, template: resource });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body?.envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  try {
    const container = await getContainer();
    const { resource: tmpl } = await container.item((await ctx.params).id, TENANT_PK).read<any>();
    if (!tmpl) return NextResponse.json({ ok: false, error: 'template not found' }, { status: 404 });
    const agent = await createAgent(String(body.envId), {
      name: tmpl.name,
      description: tmpl.description,
      instructions: tmpl.instructions,
      modelDeployment: tmpl.suggestedModel,
    });
    const knowledgeResults: any[] = [];
    for (const k of tmpl.knowledge || []) {
      try {
        const ks = await addKnowledgeSource(String(body.envId), agent.id, {
          type: k.type as KnowledgeSourceType,
          name: k.name,
          uri: k.uri,
        });
        knowledgeResults.push({ ok: true, knowledge: ks });
      } catch (e: any) {
        knowledgeResults.push({ ok: false, error: e?.message || String(e), name: k.name });
      }
    }
    const topicResults: any[] = [];
    for (const t of tmpl.topics || []) {
      try {
        const topic = await upsertTopic(String(body.envId), {
          agentId: agent.id,
          name: t.name,
          triggerPhrases: t.triggerPhrases || [],
          flowYaml: t.flowYaml || '',
        });
        topicResults.push({ ok: true, topic });
      } catch (e: any) {
        topicResults.push({ ok: false, error: e?.message || String(e), name: t.name });
      }
    }
    return NextResponse.json({ ok: true, agent, knowledge: knowledgeResults, topics: topicResults });
  } catch (e: any) {
    const status = e instanceof CopilotStudioError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, status }, { status });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const container = await getContainer();
    const { resource } = await container.item((await ctx.params).id, TENANT_PK).read<any>();
    if (!resource) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    if (resource.builtin) return NextResponse.json({ ok: false, error: 'built-in templates cannot be deleted' }, { status: 403 });
    await container.item((await ctx.params).id, TENANT_PK).delete();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
