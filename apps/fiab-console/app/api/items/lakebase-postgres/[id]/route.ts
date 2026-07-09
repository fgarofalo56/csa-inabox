/**
 * GET   /api/items/lakebase-postgres/[id]
 *   Hydrate the editor — persisted config (bound server, database, backend,
 *   pgvector, branch/snapshot history) + live server state + databases + the
 *   query / Databricks honest gates.
 *
 * PATCH /api/items/lakebase-postgres/[id]
 *   Mutate config: { action: 'bind' | 'setDatabase' | 'setBackend', ... }
 *   - bind:        { server: '<name>' }   → resolve via ARM + persist the ref
 *   - setDatabase: { database: '<name>' }
 *   - setBackend:  { backend: 'postgres' | 'databricks' }
 *
 * DEFAULT backend = Azure PostgreSQL Flexible Server (no Databricks dependency).
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError, apiServerError, apiHonestError } from '@/lib/api/respond';
import {
  getServer, listDatabases, postgresQueryGate, PostgresError,
} from '@/lib/azure/postgres-flex-client';
import { lakebaseDatabricksGate } from '@/lib/azure/lakebase-databricks-client';
import { saveLakebase, type LakebaseBackend } from '@/lib/lakebase/lakebase-store';
import { authItem, isError } from './_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const r = await authItem(id);
  if (isError(r)) return r.error;
  const { state } = r;

  const backend: LakebaseBackend = state.backend === 'databricks' ? 'databricks' : 'postgres';
  let live: { server?: unknown; databases?: unknown; serverError?: string } = {};
  if (state.server?.name) {
    try {
      const [server, databases] = await Promise.all([
        getServer(state.server.id || state.server.name),
        listDatabases(state.server.id || state.server.name).catch(() => []),
      ]);
      live = { server, databases };
    } catch (e) {
      // Honest, non-fatal: the editor still renders; surface the ARM message.
      live = { serverError: e instanceof PostgresError ? e.message : 'failed to read server' };
    }
  }

  return apiOk({
    config: state,
    backend,
    live,
    queryGate: postgresQueryGate(),
    databricksGate: lakebaseDatabricksGate(),
  });
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const r = await authItem(id, { write: true });
  if (isError(r)) return r.error;
  const { item } = r;

  let body: any;
  try { body = await req.json(); } catch { return apiError('Invalid JSON', 400, { code: 'bad_json' }); }
  const action = String(body?.action || '');

  try {
    if (action === 'bind') {
      const name = String(body?.server || '').trim();
      if (!name) return apiError('server name required', 400);
      const srv = await getServer(name); // resolves + validates existence via ARM
      const updated = await saveLakebase(item, {
        server: { name: srv.name, id: srv.id, fqdn: srv.fqdn, resourceGroup: srv.resourceGroup, location: srv.location },
        backend: 'postgres',
      });
      return apiOk({ config: (updated.state as any).lakebase });
    }
    if (action === 'setDatabase') {
      const database = String(body?.database || '').trim();
      if (!database) return apiError('database required', 400);
      const updated = await saveLakebase(item, { database });
      return apiOk({ config: (updated.state as any).lakebase });
    }
    if (action === 'setBackend') {
      const backend = body?.backend === 'databricks' ? 'databricks' : 'postgres';
      const updated = await saveLakebase(item, { backend });
      return apiOk({ config: (updated.state as any).lakebase });
    }
    return apiError(`unknown action '${action}'`, 400);
  } catch (e) {
    if (e instanceof PostgresError) return apiHonestError(e.message, e.status >= 400 && e.status < 600 ? e.status : 502);
    return apiServerError(e, 'failed to update Lakebase config');
  }
}
