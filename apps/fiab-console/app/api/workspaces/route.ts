import { NextRequest, NextResponse } from 'next/server';
import { CosmosClient } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let _client: CosmosClient | null = null;
function cosmos(): CosmosClient {
  if (_client) return _client;
  const endpoint = process.env.COSMOS_ENDPOINT;
  if (!endpoint) throw new Error('COSMOS_ENDPOINT not set');
  _client = new CosmosClient({
    endpoint,
    aadCredentials: new DefaultAzureCredential(),
  });
  return _client;
}

function container() {
  const db = process.env.COSMOS_DATABASE || 'workspace-registry';
  const c = process.env.COSMOS_CONTAINER || 'workspaces';
  return cosmos().database(db).container(c);
}

export async function GET(_req: NextRequest) {
  const session = getSession();
  // Unauthenticated callers see an empty list (graceful empty-state
  // render in the UI) rather than a 401 that the React Query error
  // boundary would surface. Auth itself is enforced at the route
  // edge once MSAL is wired in v1.1.
  if (!session) return NextResponse.json([]);

  // No COSMOS_ENDPOINT in this deploy yet -> empty list so the pane
  // renders. Real query runs once operator wires COSMOS_ENDPOINT via
  // App Configuration.
  if (!process.env.COSMOS_ENDPOINT) return NextResponse.json([]);

  // RLS at the data layer: only workspaces the caller is a member of.
  // For real impl this filters via a `members` array indexed for the
  // caller's oid + group oids.
  const oid = session.claims.oid;
  const { resources } = await container()
    .items.query({
      query: 'SELECT * FROM c WHERE c.ownerEntraOid = @oid OR ARRAY_CONTAINS(c.members, @oid)',
      parameters: [{ name: '@oid', value: oid }],
    })
    .fetchAll();
  return NextResponse.json(resources);
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return new NextResponse('Unauthorized', { status: 401 });

  const body = await req.json();
  const { name, capacitySku, region, domainName } = body;
  if (!name || !capacitySku || !region || !domainName) {
    return new NextResponse('Missing required fields', { status: 400 });
  }

  const workspace = {
    id: crypto.randomUUID(),
    name,
    itemCount: 0,
    capacitySku,
    region,
    domainName,
    ownerEntraOid: session.claims.oid,
    members: [session.claims.oid],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const { resource } = await container().items.create(workspace);
  return NextResponse.json(resource, { status: 201 });
}
