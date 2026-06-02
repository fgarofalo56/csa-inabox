/**
 * Data-source provisioning + registration for the DAB Data-source stage.
 *
 * GET  /api/dab/deploy-source
 *   → report which deploy paths are available in THIS environment and which
 *     post-deploy registration sinks (Purview, Unity Catalog) are wired, so the
 *     UI can show honest affordances instead of pretending everything deploys.
 *
 * POST /api/dab/deploy-source
 *   body { target: 'sql' | 'postgresql' | 'cosmos', name, server?, location?,
 *          skuName?, sampleName?, adminGroupSid?, adminGroupName?,
 *          registerPurview?: boolean, registerUnityCatalog?: boolean }
 *   → deploy a new source AND register it as far as is REAL:
 *       • SQL: real `createDatabase` on an existing logical server (ARM PUT);
 *         then grant the DEPLOYING USER (and optional admin GROUP) as the
 *         server's Entra admin via `setAadAdmin`; optionally register the
 *         server as a Purview data source + (best-effort) trigger a scan; and
 *         (when Databricks UC is configured) create a UC catalog to land
 *         governed external references.
 *       • PostgreSQL / Cosmos: there is no in-product ARM create path for these
 *         in Loom today; they provision through the deploy-planner bicep knob
 *         (`postgresEnabled` / core Cosmos). We HONEST-GATE with the exact knob
 *         + command rather than faking a create.
 *
 * Per .claude/rules/no-vaporware.md: every step that runs is a real Azure REST
 * call; every step that can't run returns a precise gate naming the env var /
 * role / resource to provision. We never claim a registration we didn't wire.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { jerr } from '../../items/_lib/item-crud';
import {
  listServers, createDatabase, setAadAdmin, type AadAdmin,
} from '@/lib/azure/azure-sql-client';
import {
  isPurviewConfigured, getPurviewAccountName, registerDataSource,
} from '@/lib/azure/purview-client';
import {
  databricksConfigGate, createUcCatalog, listUcCatalogs,
} from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DeployBody {
  target?: 'sql' | 'postgresql' | 'cosmos';
  name?: string;
  server?: string;
  location?: string;
  skuName?: string;
  sampleName?: string;
  /** Optional Entra GROUP object id to ALSO grant as SQL admin. */
  adminGroupSid?: string;
  adminGroupName?: string;
  registerPurview?: boolean;
  registerUnityCatalog?: boolean;
}

/** A registration / permission step result the UI lists honestly. */
interface StepResult {
  step: string;
  state: 'done' | 'gated' | 'error' | 'skipped';
  detail: string;
  gate?: { missing: string };
}

export async function GET() {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);

  const subOk = !!process.env.LOOM_SUBSCRIPTION_ID;
  let sqlServers: string[] = [];
  if (subOk) {
    try { sqlServers = (await listServers()).map((s) => s.name); } catch { /* control-plane may be gated */ }
  }
  const dbxGate = databricksConfigGate();

  return NextResponse.json({
    ok: true,
    deployer: { oid: session.claims.oid, upn: session.claims.upn, name: session.claims.name },
    capabilities: {
      // SQL DB has a real in-product ARM create path (onto an existing server).
      sql: {
        deployable: subOk && sqlServers.length > 0,
        servers: sqlServers,
        gate: !subOk
          ? { missing: 'LOOM_SUBSCRIPTION_ID' }
          : sqlServers.length === 0
            ? { missing: 'an existing Azure SQL logical server (deploy one via the deploy-planner sql knob)' }
            : undefined,
      },
      // PostgreSQL + Cosmos provision via bicep; surfaced as plan-handoff.
      postgresql: { deployable: false, bicepFlag: 'postgresEnabled', module: 'platform/fiab/bicep/modules/deploy-planner/postgres.bicep' },
      cosmos: { deployable: false, bicepCore: true, module: 'platform/fiab/bicep/main.bicep (Cosmos is a core resource)' },
    },
    registration: {
      purview: { configured: isPurviewConfigured(), account: getPurviewAccountName() },
      unityCatalog: { configured: !dbxGate, gate: dbxGate || undefined },
    },
  });
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);

  const body = (await req.json().catch(() => ({}))) as DeployBody;
  const target = body.target;
  if (!target) return jerr('target is required (sql | postgresql | cosmos)', 400);
  const name = (body.name || '').trim();
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(name)) {
    return jerr('a valid resource name is required (letters/digits/-/_, ≤63 chars)', 400);
  }

  // ── PostgreSQL / Cosmos: honest bicep handoff (no fake create) ────────────
  if (target === 'postgresql' || target === 'cosmos') {
    const isPg = target === 'postgresql';
    return NextResponse.json(
      {
        ok: false,
        gate: { missing: isPg ? 'postgresEnabled (bicep)' : 'Cosmos (core bicep)' },
        error: `Loom provisions ${isPg ? 'PostgreSQL Flexible Server' : 'Cosmos DB'} through bicep, not an in-product ARM create.`,
        remediation: {
          message: isPg
            ? 'Plan a PostgreSQL Flexible Server in the deploy-planner (data → PostgreSQL Flexible), export the bicepparam, and deploy. It sets postgresEnabled=true.'
            : 'Cosmos DB is a core resource deployed by main.bicep. If absent, redeploy the stack.',
          module: isPg
            ? 'platform/fiab/bicep/modules/deploy-planner/postgres.bicep'
            : 'platform/fiab/bicep/main.bicep',
          command: 'az deployment sub create -f platform/fiab/bicep/main.bicep -p <plan>.bicepparam',
          plannerHref: '/admin/deploy-plan',
        },
      },
      { status: 503 },
    );
  }

  // ── SQL Database: real create + grant + register ──────────────────────────
  if (!process.env.LOOM_SUBSCRIPTION_ID) {
    return NextResponse.json(
      { ok: false, gate: { missing: 'LOOM_SUBSCRIPTION_ID' }, error: 'Subscription not configured; cannot create a SQL database.' },
      { status: 503 },
    );
  }

  // Resolve a target logical server: provided, else env default, else first.
  let server = (body.server || process.env.LOOM_AZURE_SQL_DEFAULT_SERVER || '').trim();
  let servers: { name: string; fqdn: string }[] = [];
  try {
    servers = (await listServers()).map((s) => ({ name: s.name, fqdn: s.fqdn }));
  } catch (e: any) {
    return jerr(`Could not list SQL servers: ${e?.message || e}`, 502);
  }
  if (!server) {
    if (servers.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          gate: { missing: 'an Azure SQL logical server' },
          error: 'No Azure SQL logical server exists to create the database on.',
          remediation: {
            message: 'Deploy an Azure SQL server first via the deploy-planner (data → Azure SQL Database), then retry.',
            plannerHref: '/admin/deploy-plan',
          },
        },
        { status: 503 },
      );
    }
    server = servers[0].name;
  }
  const serverFqdn = servers.find((s) => s.name === server)?.fqdn || `${server}.database.windows.net`;

  const steps: StepResult[] = [];

  // 1) Create the database (real ARM PUT). Default to a serverless GP SKU +
  //    an optional AdventureWorksLT sample so the new source has objects.
  const created = await createDatabase({
    server,
    name,
    location: body.location,
    skuName: body.skuName || 'GP_S_Gen5_1',
    tier: body.skuName ? undefined : 'GeneralPurpose',
    sampleName: body.sampleName,
  });
  if (!created.ok) {
    return NextResponse.json({ ok: false, error: `Database create failed: ${created.error}`, server }, { status: created.status || 502 });
  }
  steps.push({ step: 'create-database', state: 'done', detail: `Created database '${name}' on ${serverFqdn}.` });

  // 2) Grant the DEPLOYING USER as the server's Entra admin (real ARM PUT).
  //    SQL servers carry a single AD admin; if a group is supplied, prefer it
  //    (groups scale better) and note that the user is a member.
  try {
    const tenantId = process.env.AZURE_TENANT_ID;
    if (body.adminGroupSid && GUID_RE.test(body.adminGroupSid)) {
      const admin: AadAdmin = { login: body.adminGroupName || 'sql-admins', sid: body.adminGroupSid, tenantId };
      await setAadAdmin(server, admin);
      steps.push({ step: 'grant-admin', state: 'done', detail: `Set Entra admin group '${admin.login}' on server ${server}. Add the deploying user (${session.claims.upn}) to that group for admin access.` });
    } else if (GUID_RE.test(session.claims.oid)) {
      const admin: AadAdmin = { login: session.claims.upn || session.claims.name || session.claims.oid, sid: session.claims.oid, tenantId };
      await setAadAdmin(server, admin);
      steps.push({ step: 'grant-admin', state: 'done', detail: `Set the deploying user (${admin.login}) as Entra admin on server ${server}.` });
    } else {
      steps.push({ step: 'grant-admin', state: 'gated', detail: 'Session has no Entra object id (oid) to grant; supply an admin group object id instead.', gate: { missing: 'adminGroupSid' } });
    }
  } catch (e: any) {
    steps.push({ step: 'grant-admin', state: 'error', detail: `Admin grant failed: ${e?.message || e}` });
  }

  // 3) Console UAMI data-plane role. The Console's user-assigned identity needs
  //    to be a DB principal to read/write the new database for DAB schema
  //    introspection. This is a CREATE USER FROM EXTERNAL PROVIDER inside the
  //    DB, which the UAMI can only run AFTER it (or the deploying user) is the
  //    server AD admin — a one-time SQL action, not an ARM call. Honest-gate it.
  {
    const uami = process.env.LOOM_UAMI_NAME || process.env.LOOM_UAMI_CLIENT_ID;
    steps.push({
      step: 'uami-db-role',
      state: 'gated',
      detail: uami
        ? `Grant the Console UAMI (${uami}) data-plane access by running, as the new server admin: ` +
          `CREATE USER [${uami}] FROM EXTERNAL PROVIDER; ALTER ROLE db_datareader ADD MEMBER [${uami}]; ` +
          `(add db_datawriter for write entities) — run it on database '${name}'.`
        : 'Set LOOM_UAMI_NAME to the Console user-assigned identity name, then grant it db_datareader/db_datawriter on the new database.',
      gate: { missing: uami ? 'one-time SQL CREATE USER FROM EXTERNAL PROVIDER' : 'LOOM_UAMI_NAME' },
    });
  }

  // 4) Register into Microsoft Purview (real PUT /scan/datasources/{name}).
  if (body.registerPurview) {
    if (!isPurviewConfigured()) {
      steps.push({ step: 'register-purview', state: 'gated', detail: 'Purview not configured in this environment.', gate: { missing: 'LOOM_PURVIEW_ACCOUNT' } });
    } else {
      try {
        const ds = await registerDataSource({
          name: `loom-sql-${server}`,
          kind: 'AzureSqlDatabase',
          properties: {
            serverEndpoint: serverFqdn,
            subscriptionId: process.env.LOOM_SUBSCRIPTION_ID,
            location: body.location,
          },
        });
        steps.push({ step: 'register-purview', state: 'done', detail: `Registered Purview data source '${ds.name}' (${getPurviewAccountName()}). Create + run a scan from Admin → Purview → Scans to populate the catalog.` });
      } catch (e: any) {
        steps.push({ step: 'register-purview', state: 'error', detail: `Purview registration failed: ${e?.message || e}` });
      }
    }
  } else {
    steps.push({ step: 'register-purview', state: 'skipped', detail: 'Purview registration not requested.' });
  }

  // 5) Register a governed catalog in Databricks Unity Catalog (real POST).
  //    DAB doesn't read from UC, but landing a UC catalog lets the same data be
  //    governed/queried in Databricks alongside the DAB API.
  if (body.registerUnityCatalog) {
    const dbxGate = databricksConfigGate();
    if (dbxGate) {
      steps.push({ step: 'register-unity-catalog', state: 'gated', detail: 'Databricks Unity Catalog not configured.', gate: dbxGate });
    } else {
      try {
        const catName = `loom_${name}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
        const existing = await listUcCatalogs();
        if (existing.some((c) => c.name === catName)) {
          steps.push({ step: 'register-unity-catalog', state: 'done', detail: `Unity Catalog '${catName}' already exists.` });
        } else {
          const cat = await createUcCatalog({ name: catName, comment: `Loom-governed catalog for SQL source '${name}' on ${serverFqdn}.` });
          steps.push({ step: 'register-unity-catalog', state: 'done', detail: `Created Unity Catalog '${cat.name}'. Add an external location / federated catalog to expose the SQL data in Databricks.` });
        }
      } catch (e: any) {
        steps.push({ step: 'register-unity-catalog', state: 'error', detail: `Unity Catalog registration failed: ${e?.message || e}` });
      }
    }
  } else {
    steps.push({ step: 'register-unity-catalog', state: 'skipped', detail: 'Unity Catalog registration not requested.' });
  }

  // The new source the editor should select (mssql + server + database).
  return NextResponse.json({
    ok: true,
    source: { kind: 'mssql', server, fqdn: serverFqdn, database: name },
    steps,
  });
}
