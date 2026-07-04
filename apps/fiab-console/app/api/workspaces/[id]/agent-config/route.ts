/**
 * Workspace data-agent config.
 *
 *   GET /api/workspaces/[id]/agent-config
 *     → { ok, config, role, canEdit, foundry: { projectEndpoint?, configured }, tenantDefaults }
 *   PUT /api/workspaces/[id]/agent-config   (owners/contributors only)
 *     body { config: WorkspaceAgentConfig } → { ok, config }
 *
 * Lets workspace OWNERS/CONTRIBUTORS pick which Foundry project endpoint /
 * agent / models this workspace's data agents use. Persists to the Cosmos
 * `workspace-agent-config` container (PK /workspaceId). The data-agent run
 * path reads this (falling back to the tenant default, then env vars).
 *
 * Role gate via lib/auth/workspace-role (same model as the permissions route).
 * Honest 403 when the caller lacks the role; the pane renders a Fluent gate.
 * See .claude/rules/no-vaporware.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  resolveWorkspaceRole,
  canEditWorkspaceConfig,
} from '@/lib/auth/workspace-role';
import {
  loadWorkspaceAgentConfig,
  saveWorkspaceAgentConfig,
  loadTenantCopilotConfig,
} from '@/lib/azure/copilot-config-store';
import type { WorkspaceAgentConfig } from '@/lib/types/copilot-config';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEYS: (keyof WorkspaceAgentConfig)[] = [
  'foundryProjectEndpoint', 'foundryProjectId', 'foundryAccount', 'foundryAccountRg',
  'defaultAgent', 'chatDeployment', 'embeddingDeployment',
];

function sanitize(input: any): WorkspaceAgentConfig {
  const out: WorkspaceAgentConfig = {};
  for (const k of KEYS) {
    const v = input?.[k];
    if (typeof v === 'string') {
      const t = v.trim();
      (out as any)[k] = t === '' ? undefined : t;
    }
  }
  return out;
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const { workspace, role } = await resolveWorkspaceRole(id, s.claims.oid, s.claims.upn || s.claims.email);
    if (!workspace) return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
    if (!role) return NextResponse.json({ ok: false, error: 'no access to this workspace' }, { status: 403 });

    const config = (await loadWorkspaceAgentConfig(id)) || {};
    const tenant = (await loadTenantCopilotConfig(s.claims.oid)) || {};
    const projectEndpoint =
      config.foundryProjectEndpoint || tenant.foundryProjectEndpoint || process.env.LOOM_FOUNDRY_PROJECT_ENDPOINT;
    return NextResponse.json({
      ok: true,
      config,
      role,
      canEdit: canEditWorkspaceConfig(role),
      foundry: { projectEndpoint, configured: !!projectEndpoint },
      tenantDefaults: {
        foundryAccount: tenant.foundryAccount,
        foundryAccountRg: tenant.foundryAccountRg,
        foundryProjectEndpoint: tenant.foundryProjectEndpoint,
        copilotChatDeployment: tenant.copilotChatDeployment,
        embeddingDeployment: tenant.embeddingDeployment,
      },
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const { workspace, role } = await resolveWorkspaceRole(id, s.claims.oid, s.claims.upn || s.claims.email);
    if (!workspace) return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
    if (!canEditWorkspaceConfig(role)) {
      return NextResponse.json(
        { ok: false, error: 'Only workspace owners and contributors can change the data-agent config.', role },
        { status: 403 },
      );
    }
    const body = await req.json().catch(() => ({}));
    if (!body?.config || typeof body.config !== 'object') {
      return NextResponse.json({ ok: false, error: 'config (object) required' }, { status: 400 });
    }
    const who = s.claims.upn || s.claims.email || s.claims.oid;
    const doc = await saveWorkspaceAgentConfig(id, s.claims.oid, who, sanitize(body.config));
    const { id: _i, workspaceId: _w, tenantId: _t, updatedAt, updatedBy, ...config } = doc;
    return NextResponse.json({ ok: true, config, updatedAt, updatedBy });
  } catch (e: any) {
    return apiServerError(e);
  }
}
