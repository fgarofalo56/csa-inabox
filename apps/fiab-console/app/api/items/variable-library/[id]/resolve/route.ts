/**
 * POST /api/items/variable-library/[id]/resolve
 *   body: { valueSet?: 'default'|'dev'|'test'|'prod', text?: string }
 *
 * The runtime dereference layer for a Variable Library. Resolves every variable
 * for the requested value set (default = the library's active set), pulling
 * `secret-ref` typed variables out of Key Vault (real KV REST). Returns:
 *   - resolved[]: per-variable { value (MASKED for secrets), secret, resolvedFromKv, error }
 *   - expanded:   `text` with all `@{variables.NAME}` references substituted
 *                 (secrets shown as «secret:NAME» so material never reaches the UI)
 *
 * Secret material is resolved server-side only and is never serialized to the
 * browser — the editor shows masked values + a "resolved from Key Vault" badge.
 * When a secret-ref points at a KV secret but no vault is configured, that row
 * carries an honest error naming LOOM_KEY_VAULT_URI (no-vaporware).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import {
  resolveVariableSet, expandVariables, type VarDef, type ValueSet,
} from '@/lib/variables/resolve';
import { getKeyVaultSecretValue, vaultUrl } from '@/lib/azure/kv-secrets-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ITEM_TYPE = 'variable-library';
const VALUE_SETS: ValueSet[] = ['default', 'dev', 'test', 'prod'];

function err(error: string, status: number) { return NextResponse.json({ ok: false, error }, { status }); }

/**
 * Resolve a secret-ref raw value:
 *   - `env:NAME` or a bare uppercase token with no slashes  → process.env
 *   - `kv://vault/secret` or a KV secret name               → Key Vault REST
 */
async function resolveSecretRef(raw: string): Promise<string> {
  const ref = (raw || '').trim();
  if (!ref) throw new Error('empty secret-ref value');
  if (ref.startsWith('env:')) {
    const name = ref.slice(4);
    const val = process.env[name];
    if (val == null) throw new Error(`env var ${name} not set on the Console`);
    return val;
  }
  // kv://vault/secret-name  → take the last path segment as the secret name.
  let secretName = ref;
  if (ref.startsWith('kv://') || ref.startsWith('https://')) {
    secretName = ref.split('/').filter(Boolean).pop() || ref;
  }
  if (!vaultUrl()) {
    throw new Error('secret-ref requires a Key Vault — set LOOM_KEY_VAULT_URI (or LOOM_KEY_VAULT_NAME) and grant the Console UAMI "Key Vault Secrets User"');
  }
  return getKeyVaultSecretValue(secretName);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the variable library before resolving', 400);
  const body = await req.json().catch(() => ({} as any));
  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
    if (!item) return err('not found', 404);
    const state = (item.state || {}) as Record<string, unknown>;
    const variables: VarDef[] = Array.isArray(state.variables) ? (state.variables as VarDef[]) : [];
    const requested = String(body?.valueSet || state.activeValueSet || 'default') as ValueSet;
    const valueSet: ValueSet = VALUE_SETS.includes(requested) ? requested : 'default';

    const { resolved, values } = await resolveVariableSet(variables, valueSet, resolveSecretRef);

    // For text expansion, substitute secrets with a safe «secret:NAME» token so
    // the browser never receives secret material.
    let expanded: string | undefined;
    if (typeof body?.text === 'string') {
      const safeValues: Record<string, string> = {};
      for (const r of resolved) {
        safeValues[r.name] = r.secret ? `«secret:${r.name}»` : (values[r.name] ?? '');
      }
      expanded = expandVariables(body.text, safeValues);
    }

    return NextResponse.json({ ok: true, valueSet, resolved, expanded });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}
