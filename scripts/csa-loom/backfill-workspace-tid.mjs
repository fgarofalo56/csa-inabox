/**
 * rel-T11 / B4 backfill — stamp the Entra tenant id (`tid`) + `ownerOid` onto
 * existing Loom Cosmos docs that predate the multi-user ACL model, so the shared
 * read path can enforce the tenant boundary and feature grants resolve tenant-wide.
 *
 * WHY: before rel-T11 every doc used `tenantId == owner oid`. Workspace/item
 * partition keys are IMMUTABLE, so we do NOT rewrite them — we only ADD the new
 * `tid`/`ownerOid` fields (an in-partition upsert). Feature-permission grants,
 * however, are TENANT-shared and are re-homed from the owner-oid partition into
 * the tenant-id partition so a grantee (a different user in the same tenant)
 * resolves. This is idempotent and safe to re-run.
 *
 * WHAT IT DOES (single-tenant deployment assumption — every doc belongs to the
 * one Entra tenant identified by AZURE_TENANT_ID):
 *   • workspaces           → set `tid = <tenant>`, `ownerOid = <doc.tenantId>` when absent (upsert, same partition).
 *   • feature-permissions  → copy each grant whose partition (`tenantId`) is an
 *                            OID into the `<tenant>` partition (id preserved).
 *                            The old oid-partition doc is left in place unless
 *                            --prune-grants is passed (harmless; unread once the
 *                            gate queries by tid).
 *
 * Direct Cosmos data-plane via AAD (DefaultAzureCredential) — run it from a
 * context whose identity has Cosmos data-plane write (the Console UAMI, or your
 * own account with a Cosmos Built-in Data Contributor assignment).
 *
 * Usage:
 *   AZURE_TENANT_ID=<entra-tenant-guid> \
 *   LOOM_COSMOS_ENDPOINT=https://<acct>.documents.azure.com:443/ \
 *   [LOOM_COSMOS_DATABASE=loom] \
 *   node scripts/csa-loom/backfill-workspace-tid.mjs [--apply] [--prune-grants]
 *
 *   Default is DRY-RUN (prints what it would change). Pass --apply to write.
 */
import { CosmosClient } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';

const TENANT = process.env.AZURE_TENANT_ID;
const ENDPOINT = process.env.LOOM_COSMOS_ENDPOINT;
const DB = process.env.LOOM_COSMOS_DATABASE || 'loom';
const APPLY = process.argv.includes('--apply');
const PRUNE_GRANTS = process.argv.includes('--prune-grants');

if (!TENANT) { console.error('AZURE_TENANT_ID (the Entra tenant guid) is required'); process.exit(2); }
if (!ENDPOINT) { console.error('LOOM_COSMOS_ENDPOINT is required'); process.exit(2); }

const client = new CosmosClient({ endpoint: ENDPOINT, aadCredentials: new DefaultAzureCredential() });
const db = client.database(DB);

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function backfillWorkspaces() {
  const c = db.container('workspaces');
  const { resources } = await c.items.query('SELECT * FROM c').fetchAll();
  let need = 0, done = 0;
  for (const ws of resources) {
    const patch = {};
    if (!ws.tid) patch.tid = TENANT;
    if (!ws.ownerOid) patch.ownerOid = ws.tenantId;
    if (Object.keys(patch).length === 0) continue;
    need++;
    console.log(`  workspace ${ws.id} (${ws.name || '?'}) += ${JSON.stringify(patch)}`);
    if (APPLY) {
      // Upsert into the SAME partition (tenantId unchanged) — only adds fields.
      await c.items.upsert({ ...ws, ...patch });
      done++;
    }
  }
  console.log(`workspaces: ${need} need backfill${APPLY ? `, ${done} written` : ' (dry-run)'} of ${resources.length} total`);
}

async function backfillGrants() {
  const c = db.container('feature-permissions');
  const { resources } = await c.items.query('SELECT * FROM c').fetchAll();
  let moved = 0, pruned = 0;
  for (const g of resources) {
    // Already tenant-keyed → nothing to do.
    if (g.tenantId === TENANT) continue;
    // Only re-home docs whose partition looks like an OID (a guid) — leave any
    // hand-authored/system rows alone.
    if (!GUID.test(String(g.tenantId))) continue;
    console.log(`  grant ${g.id} (cap=${g.capabilityId}) partition ${g.tenantId} -> ${TENANT}`);
    if (APPLY) {
      await c.items.upsert({ ...g, tenantId: TENANT }); // create in the tenant partition
      moved++;
      if (PRUNE_GRANTS) {
        try { await c.item(g.id, g.tenantId).delete(); pruned++; } catch { /* best-effort */ }
      }
    }
  }
  console.log(`feature-permissions: ${moved} re-homed${PRUNE_GRANTS ? `, ${pruned} pruned` : ''}${APPLY ? '' : ' (dry-run)'} of ${resources.length} total`);
}

console.log(`Backfill tid=${TENANT} on database '${DB}' — ${APPLY ? 'APPLY' : 'DRY-RUN'}${PRUNE_GRANTS ? ' +prune-grants' : ''}`);
await backfillWorkspaces();
await backfillGrants();
if (!APPLY) console.log('\nDRY-RUN complete. Re-run with --apply to write the changes.');
