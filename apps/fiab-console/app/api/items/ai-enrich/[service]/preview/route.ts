/**
 * POST /api/items/ai-enrich/[service]/preview
 *
 * The "test on a sample" affordance for the AI-enrichment pipeline activities.
 * Runs a REAL Azure Cognitive Services data-plane call against a caller-supplied
 * sample so the canvas node can prove the enrichment works before it runs in a
 * pipeline. No per-tenant Cosmos resource is touched — this is a stateless probe
 * over the deployment's SHARED cognitive backend (auth = signed-in +
 * Console-UAMI RBAC), matching the content-safety BFF routes.
 *
 * `[service]` ∈ { doc-intel | vision | language | translator | moderate }.
 *
 * Honest gates (no-vaporware.md): an unset endpoint env var returns 503 with the
 * exact var + bicep module to provision; a bad request returns 400; a real
 * cognitive error surfaces its status + message.
 *
 * Body per service:
 *   doc-intel  { modelId?, urlSource?, base64Source? }
 *   vision     { url?, base64?, features?, language? }
 *   language   { kind, text, language? }
 *   translator { text, to[], from? }
 *   moderate   { text, categories? }          (SVC-8 — reuses the built client)
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { analyzeDocument } from '@/lib/azure/doc-intelligence-client';
import { analyzeImage, type VisionFeature } from '@/lib/azure/ai-vision-client';
import { analyzeText, type LanguageTaskKind } from '@/lib/azure/ai-language-client';
import { translate } from '@/lib/azure/ai-translator-client';
import { moderateText, NotDeployedError } from '@/lib/azure/foundry-client';
import { CognitiveNotConfiguredError, CognitiveError } from '@/lib/azure/cognitive-common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ service: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const { service } = await ctx.params;
  const body = await req.json().catch(() => ({} as Record<string, unknown>));

  try {
    switch (service) {
      case 'doc-intel': {
        const result = await analyzeDocument({
          modelId: typeof body.modelId === 'string' ? body.modelId : undefined,
          urlSource: typeof body.urlSource === 'string' ? body.urlSource : undefined,
          base64Source: typeof body.base64Source === 'string' ? body.base64Source : undefined,
        });
        return apiOk({ service, result });
      }
      case 'vision': {
        const result = await analyzeImage({
          url: typeof body.url === 'string' ? body.url : undefined,
          base64: typeof body.base64 === 'string' ? body.base64 : undefined,
          features: Array.isArray(body.features) ? (body.features as VisionFeature[]) : undefined,
          language: typeof body.language === 'string' ? body.language : undefined,
        });
        return apiOk({ service, result });
      }
      case 'language': {
        if (typeof body.kind !== 'string' || typeof body.text !== 'string') {
          return apiError('language preview requires { kind, text }', 400);
        }
        const result = await analyzeText({
          kind: body.kind as LanguageTaskKind,
          text: body.text,
          language: typeof body.language === 'string' ? body.language : undefined,
        });
        return apiOk({ service, result });
      }
      case 'translator': {
        if (!Array.isArray(body.to) || body.to.length === 0) {
          return apiError('translator preview requires a non-empty { to } array', 400);
        }
        const result = await translate({
          text: (body.text as string | string[]) ?? '',
          to: body.to as string[],
          from: typeof body.from === 'string' ? body.from : undefined,
        });
        return apiOk({ service, result });
      }
      case 'moderate': {
        if (typeof body.text !== 'string') {
          return apiError('moderate preview requires { text }', 400);
        }
        const result = await moderateText(
          body.text,
          Array.isArray(body.categories) ? (body.categories as string[]) : undefined,
        );
        return apiOk({ service, result });
      }
      default:
        return apiError(`unknown AI-enrich service "${service}"`, 404);
    }
  } catch (e: unknown) {
    // Honest infra gate: endpoint env var unset → 503 naming the var + module.
    if (e instanceof CognitiveNotConfiguredError) {
      return apiError(e.message, 503, { gate: { envVar: e.envVar, service: e.service, hint: e.hint } });
    }
    if (e instanceof NotDeployedError) {
      return apiError(e.message, 503, { gate: { service: e.service, hint: e.hint } });
    }
    if (e instanceof CognitiveError) {
      return apiError(e.message, e.status >= 400 && e.status < 600 ? e.status : 502);
    }
    const anyErr = e as { message?: string; status?: number };
    return apiError(anyErr?.message || String(e), anyErr?.status || 502);
  }
}
