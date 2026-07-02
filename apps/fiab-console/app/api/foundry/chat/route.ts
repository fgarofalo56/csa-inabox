/**
 * POST /api/foundry/chat — run a chat completion against a REAL deployed model.
 *
 * body: {
 *   deployment: string,                  // deployment name on the AOAI account
 *   messages: [{ role, content }, ...],   // OpenAI-style message thread
 *   temperature?, maxTokens?, topP?, stop?: string[],
 *   dataSources?: [{ indexName, authType:'system_assigned_managed_identity'|'api_key', apiKey? }]
 *                                         // Azure OpenAI "On Your Data" grounding
 * }
 *
 * Calls the data-plane chat/completions endpoint of the resolved Cognitive
 * Services account. No streaming on the wire (the route returns the full
 * answer); the client renders it. If the deployment doesn't exist the upstream
 * returns DeploymentNotFound and we surface it as an honest gate.
 *
 * When `dataSources` are supplied, each is mapped to a real Azure AI Search
 * `azure_search` data source (endpoint resolved server-side from the configured
 * LOOM_AI_SEARCH_SERVICE) and threaded into the completion's `data_sources[]` —
 * the model answers grounded in that index and the result carries `citations`.
 * If AI Search isn't wired we return an honest 503 gate naming the env var.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  chatCompletion,
  type ChatMessage,
  type OnYourDataSource,
  CsError,
  CsNotConfiguredError,
} from '@/lib/azure/foundry-cs-client';
import { searchConfigGate, searchServiceEndpoint } from '@/lib/azure/search-index-client';
import { selectorFromBody } from '../_selector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
    const deployment = String(body?.deployment || '').trim();
    if (!deployment) return NextResponse.json({ ok: false, error: 'deployment required' }, { status: 400 });
    const rawMessages = Array.isArray(body?.messages) ? body.messages : [];
    const messages: ChatMessage[] = rawMessages
      .filter((m: any) => m && typeof m.content === 'string' && ['system', 'user', 'assistant'].includes(m.role))
      .map((m: any) => ({ role: m.role, content: m.content }));
    if (!messages.some((m) => m.role === 'user')) {
      return NextResponse.json({ ok: false, error: 'at least one user message required' }, { status: 400 });
    }

    // On-Your-Data grounding — map the picker's data sources to real Azure AI
    // Search `azure_search` sources. Endpoint is resolved server-side from the
    // configured search service (never trusted from the client). Honest gate
    // when AI Search isn't wired in this deployment.
    let dataSources: OnYourDataSource[] | undefined;
    const rawDataSources = Array.isArray(body?.dataSources) ? body.dataSources : [];
    if (rawDataSources.length) {
      const g = searchConfigGate();
      if (g) {
        return NextResponse.json(
          {
            ok: false,
            error: `Azure AI Search is not configured in this deployment: set ${g.missing} to ground answers on your data.`,
            missing: g.missing,
            notDeployed: true,
          },
          { status: 503 },
        );
      }
      let endpoint: string;
      try {
        endpoint = searchServiceEndpoint();
      } catch (e: any) {
        return NextResponse.json({ ok: false, error: e?.message || String(e), notDeployed: true }, { status: 503 });
      }
      const built: OnYourDataSource[] = [];
      for (const d of rawDataSources) {
        const indexName = String(d?.indexName || '').trim();
        if (!indexName) {
          return NextResponse.json({ ok: false, error: 'each data source requires an indexName' }, { status: 400 });
        }
        const useKey = d?.authType === 'api_key';
        const key = String(d?.apiKey || '').trim();
        if (useKey && !key) {
          return NextResponse.json({ ok: false, error: 'API-key authentication requires a search admin/query key' }, { status: 400 });
        }
        built.push({
          type: 'azure_search',
          parameters: {
            endpoint,
            index_name: indexName,
            authentication: useKey
              ? { type: 'api_key', key }
              : { type: 'system_assigned_managed_identity' },
          },
        });
      }
      dataSources = built;
    }

    const result = await chatCompletion(deployment, messages, {
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
      maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : undefined,
      topP: typeof body.topP === 'number' ? body.topP : undefined,
      stop: Array.isArray(body.stop) ? body.stop.map(String).filter(Boolean) : undefined,
      dataSources,
    }, selectorFromBody(body));
    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    }
    if (e instanceof CsError) {
      // DeploymentNotFound (404) → honest gate: deploy a chat model first.
      const isMissing = e.status === 404 || /DeploymentNotFound|does not exist|not found/i.test(e.message);
      return NextResponse.json(
        {
          ok: false,
          error: e.message,
          notDeployed: isMissing,
          hint: isMissing
            ? 'No chat model is deployed under that name. Open the Model catalog tab, pick a chat-completion model (e.g. gpt-4o-mini) and Deploy it, then return here.'
            : undefined,
        },
        { status: e.status || 502 },
      );
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
