/**
 * N13 — GET/POST /api/admin/copilot-quality/prompts
 *
 * The LLMOps PROMPT REGISTRY behind the "Prompts" tab of the EXISTING
 * /admin/copilot-quality page (no orphan admin tile, no new admin page).
 *
 *   GET  → every registered prompt with its version roll-up, the active
 *          version's REAL copilot-evaluator score, and its approval record.
 *   POST → register a new prompt (audited).
 *
 * Real Cosmos reads/writes against `loom-prompt-registry` — no mocks. Publishing
 * a version hands scoring to the EXISTING E2 evaluator Function (see the
 * [promptId] route); this route adds NO second eval harness and NO second CI
 * gate. Tenant-admin only. Azure-native, no Fabric dependency.
 */
import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { tenantScopeId } from '@/lib/auth/session';
import { listPrompts, registerPrompt } from '@/lib/copilot/prompt-registry';
import { evaluatorRunGate } from '@/lib/azure/copilot-evaluator-client';
import { runtimeFlag } from '@/lib/admin/runtime-flags';

export const dynamic = 'force-dynamic';

export const GET = withTenantAdmin(async () => {
  try {
    const flagEnabled = await runtimeFlag('n13-prompt-registry');
    const prompts = flagEnabled ? await listPrompts() : [];
    return apiOk({
      flagEnabled,
      prompts,
      // Honest posture: publishing only requests a REAL eval run when the
      // evaluator Function is wired; the registry itself works either way.
      evaluatorConfigured: evaluatorRunGate() === null,
    });
  } catch (e) {
    return apiServerError(e, 'failed to load the prompt registry', 'prompt_registry_read_failed');
  }
});

export const POST = withTenantAdmin(async (req: NextRequest, { session }) => {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const actor = {
      oid: session.claims.oid,
      who: session.claims.upn || session.claims.email || session.claims.name || session.claims.oid,
      tenantId: tenantScopeId(session),
    };
    const created = await registerPrompt(
      {
        promptId: String(body.promptId ?? ''),
        surface: String(body.surface ?? ''),
        label: String(body.label ?? ''),
        description: String(body.description ?? ''),
        owner: String(body.owner ?? ''),
        template: String(body.template ?? ''),
      },
      actor,
    );
    return apiOk({ prompt: created.prompt, version: created.version });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Validation / duplicate-id failures are the caller's problem (400), not a 500.
    if (/required|must be|already registered|not a valid/i.test(msg)) return apiError(msg, 400);
    return apiServerError(e, 'failed to register the prompt', 'prompt_registry_register_failed');
  }
});
