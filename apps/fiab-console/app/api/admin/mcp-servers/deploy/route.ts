/**
 * GET  /api/admin/mcp-servers/deploy
 *   Report the MCP Azure Files persistence config gate + whether the
 *   loom-mcp container app already has the share mounted.
 *
 * POST /api/admin/mcp-servers/deploy — two operations, discriminated by body:
 *
 *   • Catalog browse-and-deploy wizard (body has `catalogId`): deploy a catalog
 *     MCP server to Azure. Gates on `admin.deploy-mcp` (Admin), validates the
 *     wizard's values against the entry's configSchema, writes every secret
 *     field to Key Vault (per-field secret; only the NAMES persist), creates an
 *     INTERNAL Azure Container App from the entry's image wiring the KV secrets
 *     as secretRef env vars (resolved by the MCP UAMI), and registers the
 *     resulting endpoint in the `mcp-servers` Cosmos container so the Copilot
 *     orchestrator discovers its tools automatically.
 *
 *   • Azure Files persistence mount (body has `mountPath`/`accessMode`/…): a real
 *     two-step ARM op — listKeys on the MCP Azure Files storage account (identity
 *     mounts are unsupported by Container Apps — Learn), PUT
 *     managedEnvironments/storages registering the share, then PUT the loom-mcp
 *     container app with the volume + volumeMount → new revision.
 *
 * Azure-native end-to-end (Container Apps + Key Vault + Cosmos) — no Microsoft
 * Fabric / Power BI dependency. On the AKS boundaries (GCC-High / IL5 / DoD) the
 * client throws AcaPlatformError and the route surfaces the AKS Azure Files PVC
 * remediation, or an HONEST gate naming the exact env var / role / bicep module +
 * a copy-pasteable `az containerapp create` fallback — never a fake success.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { pdpCheck } from '@/lib/auth/pdp/enforce';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { saveMcpServer } from '@/lib/azure/mcp-config-store';
import {
  upsertEnvStorage,
  deployMcpContainerApp,
  getStorageAccountKey,
  readMcpFilesConfig,
  McpFilesNotConfiguredError,
  AcaNotConfiguredError,
  AcaPlatformError,
  ACA_WORKLOAD_PROFILES,
  createMcpContainerApp,
  readAcaConfig,
  AcaArmError,
  type AcaAccessMode,
  type AcaEnvVar,
  type AcaSecretRef,
} from '@/lib/azure/container-apps-arm-client';
import { putKeyVaultSecret, deleteKeyVaultSecret, vaultUrl, sanitizeSecretName } from '@/lib/azure/kv-secrets-client';
import { isGovCloud, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import { getCatalogEntry, validateConfigValues, type McpCatalogEntry } from '@/lib/mcp/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACCESS_MODES = new Set<AcaAccessMode>(['ReadWrite', 'ReadOnly']);

export async function GET(_req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const cfg = readMcpFilesConfig();
    return NextResponse.json({ ok: true, configured: true, config: cfg });
  } catch (e: any) {
    if (e instanceof McpFilesNotConfiguredError) {
      return NextResponse.json({
        ok: false, configured: false, error: e.message, hint: `Set ${e.missing.join(', ')}.`,
      }, { status: 503 });
    }
    if (e instanceof AcaNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: `Set ${e.missing.join(', ')}.` }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}



/** Honest infra gate — names the missing env var / role / bicep module. */
function gate(entry: McpCatalogEntry, missing: string, detail: string, appName: string) {
  return NextResponse.json(
    {
      ok: false,
      gate: {
        message: detail,
        missing,
        boundary: cloudBoundaryLabel(),
        deployModule: 'platform/fiab/bicep/modules/admin-plane/mcp-catalog-app.bicep',
        // Copy-pasteable manual fallback that does exactly what this route would.
        commands: [
          `# Deploy ${entry.name} MCP server (the console would do this for you once the env vars below are set)`,
          `az containerapp create \\`,
          `  --name ${appName} \\`,
          `  --resource-group <LOOM_ACA_RG> \\`,
          `  --environment <managed-environment-name> \\`,
          `  --image ${entry.image} \\`,
          `  --target-port ${entry.ingressPort} --ingress internal \\`,
          `  --min-replicas 1 --max-replicas 2`,
        ],
      },
    },
    { status: 503 },
  );
}

interface DeployBody {
  catalogId?: string;
  name?: string;
  values?: Record<string, unknown>;
}

interface MountBody {
  mountPath?: string;
  accessMode?: AcaAccessMode;
  subPath?: string;
  workloadProfileName?: string;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiError('unauthenticated', 401);

  const body = (await req.json().catch(() => ({}))) as DeployBody & MountBody;

  // Catalog browse-and-deploy wizard (audit-t45) — discriminated by `catalogId`.
  if (body.catalogId) {
    return deployCatalogServer(session, body);
  }
  // Otherwise: Azure Files persistence mount for the built-in loom-mcp app.
  return mountMcpPersistence(body);
}

async function deployCatalogServer(
  session: NonNullable<ReturnType<typeof getSession>>,
  body: DeployBody,
) {
  const denied = await enforceCapability(session, 'admin.deploy-mcp', 'Admin');
  if (denied) return denied;

  const tenantId = session.claims.oid;
  // PDP gate (default-off / shadow-ready). Admin write — deploy a catalog MCP server.
  const blocked = await pdpCheck(session, { level: 'domain', id: tenantId }, 'admin');
  if (blocked) return blocked;

  const who = session.claims.upn || session.claims.email || tenantId;

  const entry = getCatalogEntry(String(body.catalogId || ''));
  if (!entry) return apiError(`Unknown catalog server: ${body.catalogId}`, 400);

  // Validate the wizard's field values against the schema (typed + required).
  let values: Record<string, string>;
  try {
    values = validateConfigValues(entry, body.values || {});
  } catch (e: any) {
    return apiError(e?.message || String(e), 400);
  }

  // Derive a DNS-label-safe, unique Container App name (<= 32 chars).
  const rand = Math.random().toString(36).slice(2, 8);
  const appName = `loom-mcp-${entry.id}-${rand}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32).replace(/-+$/g, '');

  // ── Honest infra gates ───────────────────────────────────────────────────
  const envId = (process.env.LOOM_ACA_ENV_ID || '').trim();
  const envDomain = (process.env.LOOM_ACA_ENV_DOMAIN || '').trim();
  const uamiId = (process.env.LOOM_MCP_CATALOG_UAMI_ID || '').trim();
  const location = (process.env.LOOM_LOCATION || process.env.LOOM_REGION || '').trim();

  if (!envId || !envDomain) {
    return gate(
      entry,
      'LOOM_ACA_ENV_ID / LOOM_ACA_ENV_DOMAIN',
      isGovCloud()
        ? `MCP catalog deploy targets Azure Container Apps, but this ${cloudBoundaryLabel()} ` +
            'boundary runs the Loom plane on AKS (no Container Apps managed environment). Deploy ' +
            'the MCP server via the AKS/Helm path, or set LOOM_ACA_ENV_ID + LOOM_ACA_ENV_DOMAIN ' +
            'on the console if a Container Apps environment exists.'
        : 'The console is not wired to a Container Apps managed environment. Set LOOM_ACA_ENV_ID ' +
            '(the CAE resource id) and LOOM_ACA_ENV_DOMAIN (its default domain) on the console — ' +
            'admin-plane/main.bicep wires these from containerPlatformModule.outputs.',
      appName,
    );
  }
  if (!uamiId) {
    return gate(
      entry,
      'LOOM_MCP_CATALOG_UAMI_ID',
      'No managed identity configured for catalog-deployed MCP servers. Set LOOM_MCP_CATALOG_UAMI_ID ' +
        'to the uami-loom-mcp resource id (identity.bicep output uamiMcpId) so the deployed container ' +
        'can resolve its Key Vault secrets, and grant that identity "Key Vault Secrets User" on the vault.',
      appName,
    );
  }
  try {
    readAcaConfig();
  } catch (e) {
    if (e instanceof AcaNotConfiguredError) {
      return gate(
        entry,
        e.missing.join(', '),
        `Container Apps management not configured: ${e.message}. These are wired by admin-plane/main.bicep.`,
        appName,
      );
    }
    throw e;
  }
  const hasSecretField = entry.configSchema.some((f) => f.secret);
  if (hasSecretField && !vaultUrl()) {
    return gate(
      entry,
      'LOOM_KEY_VAULT_URI',
      'This server needs a per-field secret stored in Key Vault, but no vault is configured. Set ' +
        'LOOM_KEY_VAULT_URI (or LOOM_KEY_VAULT_NAME) on the console and grant the Console UAMI ' +
        '"Key Vault Secrets Officer" + the MCP UAMI "Key Vault Secrets User" on that vault.',
      appName,
    );
  }

  // ── Write per-field secrets to Key Vault, build env + ACA secret refs ─────
  const env: AcaEnvVar[] = [];
  const secrets: AcaSecretRef[] = [];
  const configValues: Record<string, string> = {}; // non-secret (persisted to Cosmos)
  const secretRefs: Record<string, string> = {};   // KV names only (persisted to Cosmos)
  const writtenSecretNames: string[] = [];          // for rollback on failure
  const base = vaultUrl();

  try {
    for (const f of entry.configSchema) {
      const v = values[f.key];
      if (v === undefined) continue;
      if (f.secret) {
        const kvName = sanitizeSecretName(`mcp-${appName}-${f.key}`);
        await putKeyVaultSecret(kvName, v);
        writtenSecretNames.push(kvName);
        secretRefs[f.key] = kvName;
        // ACA secret name (lowercase, dash-safe) referenced by env secretRef.
        const acaSecretName = kvName.toLowerCase();
        secrets.push({ name: acaSecretName, keyVaultUrl: `${base}/secrets/${kvName}`, identity: uamiId });
        env.push({ name: f.envVar, secretRef: acaSecretName });
      } else {
        configValues[f.key] = v;
        env.push({ name: f.envVar, value: v });
      }
    }

    // ── Create the Container App (real ARM PUT) ────────────────────────────
    const app = await createMcpContainerApp({
      name: appName,
      environmentId: envId,
      location: location || 'eastus2',
      uamiId,
      image: entry.image,
      targetPort: entry.ingressPort,
      env,
      secrets,
      command: entry.command,
      args: entry.args,
    });

    // ── Register the endpoint so the orchestrator auto-discovers its tools ──
    const endpoint = `https://${appName}.${envDomain}${entry.mcpPath}`;
    const deployedAt = new Date().toISOString();
    const doc = await saveMcpServer(tenantId, undefined, who, {
      name: body.name?.trim() || entry.name,
      endpoint,
      authMethod: 'header',
      description: `${entry.description} (deployed from catalog: ${entry.id})`,
      enabled: true,
      catalogId: entry.id,
      configValues,
      secretRefs,
      // Mark the connection as catalog-sourced + record the deployment so the
      // External MCP Tools panel can show live status and offer a teardown that
      // also deletes the Container App + KV secrets named in secretRefs.
      source: 'catalog',
      deployment: {
        catalogId: entry.id,
        containerAppName: appName,
        image: entry.image,
        provisioningState: app.provisioningState || 'Provisioning',
        fqdn: `${appName}.${envDomain}`,
        deployedAt,
        deployedBy: who,
      },
    });

    try {
      const audit = await auditLogContainer();
      await audit.items.create({
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        itemId: `mcp-server:${doc.serverId}`,
        tenantId,
        who,
        at: doc.createdAt,
        kind: 'mcp-server.deploy',
        name: doc.name,
        catalogId: entry.id,
        containerApp: appName,
        image: entry.image,
      }).catch(() => {});
    } catch { /* audit is best-effort */ }

    return NextResponse.json({
      ok: true,
      server: doc,
      deploy: {
        containerApp: appName,
        image: entry.image,
        endpoint,
        provisioningState: app.provisioningState || 'Provisioning',
        preview: !!entry.preview,
        message:
          `Deploying ${entry.name} as Container App "${appName}". It registers automatically; ` +
          'its tools appear in Copilot once the container is running and responds to tools/list.',
      },
    });
  } catch (e: any) {
    // Roll back any secrets we wrote so a failed deploy doesn't orphan them.
    for (const n of writtenSecretNames) {
      await deleteKeyVaultSecret(n).catch(() => {});
    }
    if (e instanceof AcaArmError) {
      return NextResponse.json(
        { ok: false, error: `Container App create failed (ARM ${e.status}): ${typeof e.body === 'string' ? e.body.slice(0, 400) : e.message}` },
        { status: 502 },
      );
    }
    return apiError(e?.message || String(e), 500);
  }
}

async function mountMcpPersistence(body: MountBody) {
  // Structured validation (loom-no-freeform-config): every field is enumerated
  // or constrained — no arbitrary env/secret blob accepted.
  const accessMode: AcaAccessMode = body.accessMode || 'ReadWrite';
  if (!ACCESS_MODES.has(accessMode)) {
    return NextResponse.json({ ok: false, error: 'accessMode must be ReadWrite or ReadOnly' }, { status: 400 });
  }
  if (body.workloadProfileName && !ACA_WORKLOAD_PROFILES.has(body.workloadProfileName)) {
    return NextResponse.json({
      ok: false, error: `workloadProfileName must be one of ${[...ACA_WORKLOAD_PROFILES].join(', ')}`,
    }, { status: 400 });
  }
  if (body.mountPath && !body.mountPath.startsWith('/')) {
    return NextResponse.json({ ok: false, error: 'mountPath must be an absolute path' }, { status: 400 });
  }
  if (body.subPath && body.subPath.startsWith('/')) {
    return NextResponse.json({ ok: false, error: 'subPath must not start with "/"' }, { status: 400 });
  }

  try {
    const cfg = readMcpFilesConfig();
    const mountPath = body.mountPath || cfg.mountPath;

    // 1. Resolve the storage-account key (identity mounts unsupported by ACA).
    const accountKey = await getStorageAccountKey(cfg.storageAccount, cfg.resourceGroup);

    // 2. Register the share on the managed environment.
    const storage = await upsertEnvStorage({
      storageName: cfg.storageName,
      accountName: cfg.storageAccount,
      accountKey,
      shareName: cfg.shareName,
      accessMode,
    });

    // 3. Mount it into the loom-mcp container app (new revision).
    const app = await deployMcpContainerApp({
      name: 'loom-mcp',
      storageName: cfg.storageName,
      mountPath,
      subPath: body.subPath,
      workloadProfileName: body.workloadProfileName,
      env: [{ name: 'LOOM_MCP_DATA_DIR', value: mountPath }],
    });

    return NextResponse.json({ ok: true, storage, app, mountPath });
  } catch (e: any) {
    if (e instanceof McpFilesNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: `Set ${e.missing.join(', ')}.` }, { status: 503 });
    }
    if (e instanceof AcaNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: `Set ${e.missing.join(', ')}.` }, { status: 503 });
    }
    if (e instanceof AcaPlatformError) {
      // AKS boundary — Azure Files PVC path, not a Container Apps storage mount.
      return NextResponse.json({ ok: false, error: e.message }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status: e?.status || 502 });
  }
}
