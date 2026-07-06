/**
 * GET/PATCH/DELETE /api/items/loom-app/[id] — the Loom app (org app) editor's
 * useItemState driver. Persists the app definition (content + navigation +
 * audiences) as the item's Cosmos `state`. Azure-native; nothing reads a Fabric
 * or Power BI workspace (.claude/rules/no-fabric-dependency.md).
 */
import { makeItemRoute } from '../../_lib/palantir-crud';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { GET, PATCH, DELETE } = makeItemRoute('loom-app');
