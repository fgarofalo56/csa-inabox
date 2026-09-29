/**
 * Which lakehouse items register a schema name in the schema registry.
 *
 * The Spark DDL behind `/api/lakehouse/schemas` runs against one metastore
 * for the Spark pool, so a schema name is not namespaced per lakehouse there.
 * Before a route drops a Spark schema it asks whether any OTHER item also
 * registers that name; if one does, the Spark schema is kept and only this
 * item's registry row is removed.
 */
import { lakehouseSchemasContainer } from '@/lib/azure/cosmos-client';

/** Item ids, other than `lakehouseId`, whose registry holds a schema called `name`. */
export async function otherSchemaOwners(lakehouseId: string, name: string): Promise<string[]> {
  const c = await lakehouseSchemasContainer();
  // Cross-partition by design: the question is about every item's registry.
  const { resources } = await c.items
    .query<unknown>({
      query: 'SELECT VALUE c.lakehouseId FROM c WHERE c.name = @name AND c.lakehouseId != @lh',
      parameters: [
        { name: '@name', value: name },
        { name: '@lh', value: lakehouseId },
      ],
    })
    .fetchAll();
  const ids = resources.filter((id): id is string => typeof id === 'string' && id !== '' && id !== lakehouseId);
  return Array.from(new Set(ids));
}
