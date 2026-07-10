// CSA Loom — Loom OneLake registry (Cosmos-backed namespace store).
//
// The single owner of the namespace mapping the console libs
// (lakehouse.ts / shortcut-engines.ts / onelake-security-client.ts) persist
// per-item today: { workspace→container, item→managed folder, shortcut→target,
// role→ACL }. Backed by a Cosmos container created on demand
// (createIfNotExists) so a fresh environment needs no extra ARM/Bicep step —
// the exact pattern apps/fiab-console/lib/azure/cosmos-client.ts uses.
//
// REAL backend (no-vaporware): when LOOM_ONELAKE_COSMOS_ENDPOINT (or the shared
// LOOM_COSMOS_ENDPOINT) is set, this does real @azure/cosmos point-reads/upserts
// with managed-identity (AAD) auth. When it is UNSET the registry reports
// configured=false and the service falls through to the pure convention
// resolver (honest gate on /register, never a mock write).
//
// @azure/cosmos + @azure/identity are imported LAZILY (dynamic import) so the
// HTTP server + the zero-dependency convention-resolve path boot and run even
// before `npm install` — the core path never hard-depends on the SDK being
// present. In the built container image the deps ARE installed and the
// Cosmos-backed registered path executes end-to-end.

const DEFAULT_CONTAINER = 'onelake-registry';
const PARTITION_KEY = '/tenantId';

/** Read the registry's Cosmos config from env (shared LOOM_COSMOS_* fallback). */
export function cosmosConfig(env) {
  const e = env || {};
  const endpoint =
    (e.LOOM_ONELAKE_COSMOS_ENDPOINT || e.LOOM_COSMOS_ENDPOINT || e.COSMOS_ENDPOINT || '').trim();
  const database = (e.LOOM_ONELAKE_COSMOS_DATABASE || e.LOOM_COSMOS_DATABASE || 'loom').trim();
  const container = (e.LOOM_ONELAKE_REGISTRY_CONTAINER || DEFAULT_CONTAINER).trim();
  const clientId = (e.LOOM_UAMI_CLIENT_ID || e.AZURE_CLIENT_ID || '').trim();
  return { endpoint, database, container, clientId, configured: !!endpoint };
}

/** Deterministic Cosmos doc id for an item registration. */
export function registrationId(workspace, item, itemType) {
  const suffix = itemType ? `.${itemType}` : '';
  return `${workspace}::${item}${suffix}`;
}

/**
 * A Cosmos-backed registry, or a no-op honest-gate registry when Cosmos is
 * unset. Lazily constructs the @azure/cosmos client + container on first use.
 */
export class OneLakeRegistry {
  /** @param {Record<string,string|undefined>} env */
  constructor(env) {
    this.cfg = cosmosConfig(env);
    /** @type {any} */ this._container = null;
    /** @type {Promise<any>|null} */ this._init = null;
  }

  get configured() {
    return this.cfg.configured;
  }

  async _container_() {
    if (this._container) return this._container;
    if (!this.cfg.configured) {
      const err = new Error(
        'Cosmos registry not configured — set LOOM_ONELAKE_COSMOS_ENDPOINT ' +
          '(or the shared LOOM_COSMOS_ENDPOINT). The service still resolves ' +
          'loom:// paths by convention without it.',
      );
      err.code = 'not_configured';
      throw err;
    }
    if (!this._init) {
      this._init = (async () => {
        const [{ CosmosClient }, identity] = await Promise.all([
          import('@azure/cosmos'),
          import('@azure/identity'),
        ]);
        const { DefaultAzureCredential, ManagedIdentityCredential, ChainedTokenCredential } =
          identity;
        const chain = [];
        if (this.cfg.clientId) chain.push(new ManagedIdentityCredential({ clientId: this.cfg.clientId }));
        chain.push(new DefaultAzureCredential());
        const credential = new ChainedTokenCredential(...chain);
        const client = new CosmosClient({ endpoint: this.cfg.endpoint, aadCredentials: credential });
        const { database } = await client.databases.createIfNotExists({ id: this.cfg.database });
        const { container } = await database.containers.createIfNotExists({
          id: this.cfg.container,
          partitionKey: { paths: [PARTITION_KEY] },
        });
        this._container = container;
        return container;
      })();
    }
    return this._init;
  }

  /**
   * Point-read the registration for an item. Returns null when Cosmos is unset
   * (caller falls back to convention) or the item is unregistered.
   * @returns {Promise<import('./resolver.mjs').RegistryEntry|null>}
   */
  async lookup(tenant, workspace, item, itemType) {
    if (!this.cfg.configured) return null;
    const container = await this._container_();
    const id = registrationId(workspace, item, itemType);
    try {
      const { resource } = await container.item(id, tenant).read();
      if (!resource) return null;
      return {
        container: resource.container,
        rootPath: resource.rootPath,
        account: resource.account,
        abfssRoot: resource.abfssRoot,
        shortcut: resource.shortcut || undefined,
      };
    } catch (e) {
      if (e && (e.code === 404 || e.statusCode === 404)) return null;
      throw e;
    }
  }

  /**
   * Upsert an item registration (seeded from the console's lakehouse-abfss
   * resolution — the console posts the container/rootPath/abfssRoot it already
   * computed). Real Cosmos write; throws an honest not_configured gate if unset.
   */
  async register(doc) {
    const container = await this._container_();
    const id = registrationId(doc.workspace, doc.item, doc.itemType);
    const now = new Date().toISOString();
    const record = {
      id,
      tenantId: doc.tenant,
      workspace: doc.workspace,
      item: doc.item,
      itemType: doc.itemType || null,
      container: doc.container || null,
      rootPath: doc.rootPath || null,
      account: doc.account || null,
      abfssRoot: doc.abfssRoot || null,
      shortcut: doc.shortcut || null,
      roles: doc.roles || null,
      updatedAt: now,
    };
    const { resource } = await container.items.upsert(record);
    return resource || record;
  }

  /**
   * List registrations for a tenant (the /catalog Explore surface). Bounded
   * single-partition query.
   */
  async list(tenant, max = 200) {
    if (!this.cfg.configured) return [];
    const container = await this._container_();
    const { resources } = await container.items
      .query(
        {
          query: 'SELECT TOP @max c.id, c.workspace, c.item, c.itemType, c.container, c.rootPath, c.abfssRoot, c.shortcut FROM c WHERE c.tenantId = @t',
          parameters: [
            { name: '@t', value: tenant },
            { name: '@max', value: Math.max(1, Math.min(1000, max)) },
          ],
        },
        { partitionKey: tenant },
      )
      .fetchAll();
    return resources || [];
  }
}
