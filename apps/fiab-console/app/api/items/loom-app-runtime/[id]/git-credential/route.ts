/**
 * Private-git credential for a Loom App Runtime item (APP-W4 S3).
 *
 *   GET    → { configured, provider?, setAt? }   — status only, NEVER the value
 *   POST   { pat }                               — store the PAT in Key Vault
 *                                                  (secret loom-app-git-<id8>);
 *                                                  the item keeps only the
 *                                                  reference (state.gitAuth)
 *   DELETE                                        — remove secret + reference
 *
 * The build route resolves the secret at build time and hands it to buildApp,
 * which composes the provider's tokenized clone URL for ACR's source fetch —
 * the token never persists outside Key Vault and never rides a response.
 * Honest gate when no Key Vault is wired (kvSecretsConfigGate).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { readAppRuntime, saveAppRuntime, LOOM_APP_RUNTIME_TYPE } from '@/lib/apps/runtime-store';
import { kvSecretsConfigGate, putKeyVaultSecret, deleteKeyVaultSecret } from '@/lib/azure/kv-secrets-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function providerOf(gitUrl: string | undefined): string {
  const host = (gitUrl || '').replace(/^https:\/\//i, '').split('/')[0].toLowerCase();
  if (host === 'github.com') return 'github';
  if (host === 'gitlab.com') return 'gitlab';
  if (host === 'bitbucket.org') return 'bitbucket';
  if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) return 'azure-devops';
  return 'git';
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const access = await resolveItemAccessByOid(session, id, LOOM_APP_RUNTIME_TYPE);
    if (!access) return apiError('Item not found', 404, { code: 'not_found' });
    const rt = readAppRuntime(access.item);
    return apiOk(rt.gitAuth
      ? { configured: true, provider: rt.gitAuth.provider, setAt: rt.gitAuth.setAt }
      : { configured: false });
  } catch (e) {
    return apiServerError(e, 'failed to read the git credential status');
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const access = await resolveItemAccessByOid(session, id, LOOM_APP_RUNTIME_TYPE);
    if (!access) return apiError('Item not found', 404, { code: 'not_found' });
    if (!access.canWrite) return apiError('Read-only access', 403, { code: 'forbidden' });

    const gate = kvSecretsConfigGate();
    if (gate) return apiError(gate.detail, 503, { code: 'kv_not_configured', missing: gate.missing });

    const body = (await req.json().catch(() => ({}))) as { pat?: string };
    const pat = String(body?.pat || '').trim();
    if (!pat || pat.length < 8 || pat.length > 4096) {
      return apiError('pat is required (8–4096 chars).', 400);
    }

    const rt = readAppRuntime(access.item);
    const secretName = `loom-app-git-${id.slice(0, 8)}`;
    await putKeyVaultSecret(secretName, pat);
    await saveAppRuntime(access.item, {
      gitAuth: { provider: providerOf(rt.gitSource), secretName, setAt: new Date().toISOString() },
    });
    return apiOk({ configured: true, secretName, note: 'Token stored in Key Vault — the next git build authenticates with it.' });
  } catch (e) {
    return apiServerError(e, 'failed to store the git credential');
  }
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const access = await resolveItemAccessByOid(session, id, LOOM_APP_RUNTIME_TYPE);
    if (!access) return apiError('Item not found', 404, { code: 'not_found' });
    if (!access.canWrite) return apiError('Read-only access', 403, { code: 'forbidden' });
    const rt = readAppRuntime(access.item);
    if (rt.gitAuth?.secretName) {
      await deleteKeyVaultSecret(rt.gitAuth.secretName).catch(() => { /* already gone */ });
    }
    await saveAppRuntime(access.item, { gitAuth: undefined });
    return apiOk({ configured: false });
  } catch (e) {
    return apiServerError(e, 'failed to remove the git credential');
  }
}
