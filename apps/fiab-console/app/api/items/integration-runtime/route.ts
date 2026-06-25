/**
 * BFF for the first-class `integration-runtime` item — the item's canonical
 * namespace.
 *
 *   GET    /api/items/integration-runtime            → { ok, runtimes: [{...ir, state}] }
 *   POST   /api/items/integration-runtime
 *          body { name, properties }                 → upsert (Managed | SelfHosted)
 *          body { name, action: 'start'|'stop' }     → lifecycle
 *          body { name, action: 'authKeys' }         → Self-Hosted install keys
 *   DELETE /api/items/integration-runtime?name=NAME  → delete
 *
 * REUSE, NOT REINVENT (no-vaporware.md): these handlers are RE-EXPORTED verbatim
 * from the deployment-default Data Factory route (/api/adf/integration-runtimes),
 * which calls real ARM (Microsoft.DataFactory/factories/integrationruntimes) with
 * an honest 503 infra-gate when the factory env isn't set. The standalone
 * IntegrationRuntimeEditor renders the shared IntegrationRuntimeManager in
 * factory-scoped mode, which targets /api/adf/integration-runtimes directly; this
 * namespaced route exposes the SAME real handlers under the item's own slug.
 * Azure-native default — no Fabric dependency (no-fabric-dependency.md).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export { GET, POST, DELETE } from '@/app/api/adf/integration-runtimes/route';
