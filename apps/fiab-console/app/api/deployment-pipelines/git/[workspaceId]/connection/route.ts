/**
 * Workspace ↔ Git connection (CI side) for a Fabric workspace.
 *
 *   GET    /api/deployment-pipelines/git/[workspaceId]/connection
 *            → provider details + connection state + last-sync head
 *   POST   /api/deployment-pipelines/git/[workspaceId]/connection
 *            body { provider: AzureDevOps|GitHub, branchName, ... , connectionId? }
 *            → connect the workspace to a repo+branch
 *   DELETE /api/deployment-pipelines/git/[workspaceId]/connection
 *            → disconnect the workspace from Git
 *
 * Real Fabric REST (core/git):
 *   GET  /v1/workspaces/{ws}/git/connection
 *     https://learn.microsoft.com/rest/api/fabric/core/git/get-connection
 *   POST /v1/workspaces/{ws}/git/connect
 *     https://learn.microsoft.com/rest/api/fabric/core/git/connect
 *   POST /v1/workspaces/{ws}/git/disconnect
 *     https://learn.microsoft.com/rest/api/fabric/core/git/disconnect
 *
 * Note: SPN/UAMI connect requires a ConfiguredConnection (Git provider
 * credentials) connectionId; GitHub always requires one. Surfaced in the gate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getWorkspaceGitConnection,
  connectWorkspaceGit,
  disconnectWorkspaceGit,
  FabricError,
  type GitProviderDetails,
} from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate(e: FabricError) {
  return NextResponse.json({
    ok: false,
    gate: {
      missing: ['Fabric Git authorization', 'Workspace admin role', 'Git provider credentials connection (for SPN/UAMI or GitHub)'],
      message: e.hint || e.message,
    },
  });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ workspaceId: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { workspaceId } = await ctx.params;
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  try {
    const connection = await getWorkspaceGitConnection(workspaceId);
    return NextResponse.json({ ok: true, data: { connection } });
  } catch (e) {
    if (e instanceof FabricError && (e.status === 401 || e.status === 403)) return gate(e);
    const status = e instanceof FabricError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ workspaceId: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { workspaceId } = await ctx.params;
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const provider = String(body?.provider || body?.gitProviderType || '').trim();
  if (provider !== 'AzureDevOps' && provider !== 'GitHub') {
    return NextResponse.json({ ok: false, error: 'provider must be AzureDevOps or GitHub' }, { status: 400 });
  }
  const details: GitProviderDetails = {
    gitProviderType: provider,
    branchName: String(body?.branchName || '').trim() || undefined,
    directoryName: typeof body?.directoryName === 'string' ? body.directoryName : undefined,
  };
  if (provider === 'AzureDevOps') {
    details.organizationName = String(body?.organizationName || '').trim() || undefined;
    details.projectName = String(body?.projectName || '').trim() || undefined;
    details.repositoryName = String(body?.repositoryName || '').trim() || undefined;
  } else {
    details.ownerName = String(body?.ownerName || '').trim() || undefined;
    details.repositoryName = String(body?.repositoryName || '').trim() || undefined;
    details.customDomainName = String(body?.customDomainName || '').trim() || undefined;
  }
  const connectionId = String(body?.connectionId || '').trim() || undefined;

  try {
    await connectWorkspaceGit(workspaceId, details, connectionId);
    return NextResponse.json({ ok: true, data: { connected: true } });
  } catch (e) {
    if (e instanceof FabricError && (e.status === 401 || e.status === 403)) return gate(e);
    const status = e instanceof FabricError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ workspaceId: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { workspaceId } = await ctx.params;
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  try {
    await disconnectWorkspaceGit(workspaceId);
    return NextResponse.json({ ok: true, data: { disconnected: true } });
  } catch (e) {
    if (e instanceof FabricError && (e.status === 401 || e.status === 403)) return gate(e);
    const status = e instanceof FabricError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
