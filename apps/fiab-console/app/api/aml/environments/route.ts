/**
 * /api/aml/environments — Azure ML environment management (Library & Environment).
 *
 * The Azure-native 1:1 for a Fabric notebook "Environment" (curated, versioned
 * libraries). Backed by real ARM REST against the AML workspace — NO Fabric
 * workspace required (Azure-native default; see no-fabric-dependency.md).
 *
 *   GET  /api/aml/environments
 *        → { ok, environments: AmlEnvironment[] }   (each carries real packages)
 *   GET  /api/aml/environments?name=<n>&version=<v>
 *        → { ok, environment }                       (one env, real packages)
 *   POST /api/aml/environments
 *        body: { name, version?, image, condaPackages?, pipPackages?, description? }
 *        → { ok, environment }                       (registers a version)
 *   PATCH /api/aml/environments?action=attach
 *        body: { notebookId, workspaceId, envName, envVersion }
 *        → { ok, attachedAmlEnv }                    (persists onto the notebook)
 *   PATCH /api/aml/environments?action=attach-jar
 *        body: { notebookId, workspaceId, jar }      (custom .jar / wheel)
 *        → { ok, customLibraries }
 *   PATCH /api/aml/environments?action=detach-jar
 *        body: { notebookId, workspaceId, jar }
 *        → { ok, customLibraries }
 *
 * Honest infra-gate: when no AML workspace is configured, list/create return 503
 * with the exact env vars to set; the editor renders a MessageBar.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  listEnvironments, getEnvironment, createEnvironment,
  AmlEnvNotConfiguredError, AmlEnvError,
} from '@/lib/azure/aml-environments-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fail(e: any) {
  if (e instanceof AmlEnvNotConfiguredError) {
    return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  }
  const status = e instanceof AmlEnvError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const name = req.nextUrl.searchParams.get('name');
  const version = req.nextUrl.searchParams.get('version') || undefined;
  try {
    if (name) {
      const environment = await getEnvironment(name, version);
      if (!environment) return NextResponse.json({ ok: false, error: `environment ${name} not found` }, { status: 404 });
      return NextResponse.json({ ok: true, environment });
    }
    const environments = await listEnvironments();
    return NextResponse.json({ ok: true, environments });
  } catch (e: any) { return fail(e); }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const name = String(body?.name || '').trim();
  const image = String(body?.image || '').trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  if (!image) return NextResponse.json({ ok: false, error: 'image (base image) required' }, { status: 400 });
  try {
    const environment = await createEnvironment({
      name,
      version: body?.version ? String(body.version) : undefined,
      image,
      description: body?.description ? String(body.description) : undefined,
      condaPackages: Array.isArray(body?.condaPackages) ? body.condaPackages.map(String) : undefined,
      pipPackages: Array.isArray(body?.pipPackages) ? body.pipPackages.map(String) : undefined,
    });
    return NextResponse.json({ ok: true, environment });
  } catch (e: any) { return fail(e); }
}

async function loadNotebook(id: string, workspaceId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  try {
    const { resource } = await items.item(id, workspaceId).read<WorkspaceItem>();
    return (resource && resource.itemType === 'notebook') ? resource : null;
  } catch (e: any) { if (e?.code === 404) return null; throw e; }
}

export async function PATCH(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const action = req.nextUrl.searchParams.get('action') || 'attach';
  const body = await req.json().catch(() => ({}));
  const notebookId = String(body?.notebookId || '').trim();
  const workspaceId = String(body?.workspaceId || '').trim();
  if (!notebookId || !workspaceId) {
    return NextResponse.json({ ok: false, error: 'notebookId + workspaceId required' }, { status: 400 });
  }
  try {
    const nb = await loadNotebook(notebookId, workspaceId);
    if (!nb) return NextResponse.json({ ok: false, error: 'notebook not found' }, { status: 404 });
    const items = await itemsContainer();
    const state = ((nb.state as any) || {}) as Record<string, unknown>;

    if (action === 'attach') {
      const envName = String(body?.envName || '').trim();
      const envVersion = String(body?.envVersion || '').trim();
      if (!envName) return NextResponse.json({ ok: false, error: 'envName required' }, { status: 400 });
      // Validate against the real AML backend so we never persist a phantom env.
      const environment = await getEnvironment(envName, envVersion || undefined);
      if (!environment) return NextResponse.json({ ok: false, error: `environment ${envName} not found in AML workspace` }, { status: 404 });
      const attachedAmlEnv = { name: environment.name, version: environment.latestVersion || envVersion || '1' };
      state.attachedAmlEnv = attachedAmlEnv;
      await items.item(nb.id, workspaceId).replace({ ...nb, state, updatedAt: new Date().toISOString() } as WorkspaceItem);
      return NextResponse.json({ ok: true, attachedAmlEnv, environment });
    }

    if (action === 'detach') {
      delete state.attachedAmlEnv;
      await items.item(nb.id, workspaceId).replace({ ...nb, state, updatedAt: new Date().toISOString() } as WorkspaceItem);
      return NextResponse.json({ ok: true, attachedAmlEnv: null });
    }

    if (action === 'attach-jar' || action === 'detach-jar') {
      const jar = String(body?.jar || '').trim();
      if (!jar) return NextResponse.json({ ok: false, error: 'jar (path or filename) required' }, { status: 400 });
      const current = Array.isArray(state.customLibraries) ? (state.customLibraries as string[]) : [];
      const next = action === 'attach-jar'
        ? Array.from(new Set([...current, jar]))
        : current.filter((j) => j !== jar);
      state.customLibraries = next;
      await items.item(nb.id, workspaceId).replace({ ...nb, state, updatedAt: new Date().toISOString() } as WorkspaceItem);
      return NextResponse.json({ ok: true, customLibraries: next });
    }

    return NextResponse.json({ ok: false, error: `unsupported action: ${action}` }, { status: 400 });
  } catch (e: any) { return fail(e); }
}
