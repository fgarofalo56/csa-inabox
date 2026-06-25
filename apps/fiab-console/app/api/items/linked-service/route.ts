/**
 * BFF for the first-class `linked-service` item — the item's canonical
 * namespace.
 *
 *   GET    /api/items/linked-service            → { ok, linkedServices }
 *   POST   /api/items/linked-service            body { name, properties }  → upsert
 *   DELETE /api/items/linked-service?name=NAME  → delete
 *
 * REUSE, NOT REINVENT (no-vaporware.md): these handlers are RE-EXPORTED verbatim
 * from the deployment-default Data Factory route (/api/adf/linked-services),
 * which calls real ARM (Microsoft.DataFactory/factories/linkedservices) with an
 * honest 503 infra-gate when the factory env isn't set. The standalone
 * LinkedServiceEditor renders the shared LinkedServiceGallery, which targets
 * /api/adf/linked-services (and /api/synapse/linkedservices for the Synapse
 * engine) directly; this namespaced route exposes the SAME real handlers under
 * the item's own slug for programmatic / deep-link callers. Azure-native default
 * per no-fabric-dependency.md.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export { GET, POST, DELETE } from '@/app/api/adf/linked-services/route';
