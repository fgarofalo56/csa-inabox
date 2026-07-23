/**
 * cosmos-ttl — TTL-enabling container creator (I3 / rev-2 F8).
 *
 * Creates (or upgrades) a container with `defaultTtl: -1` — TTL ENABLED with
 * NO default expiry, so only docs that carry their own `ttl` field self-evict
 * (the pdp.shadow / identity.shadow 90-day retention) while every other doc
 * remains permanent. `createIfNotExists` only applies the setting on CREATION,
 * so a one-time read+replace upgrades containers that predate the change
 * (best-effort — rows simply persist without TTL until the upgrade lands).
 */
import type { Container, Database } from '@azure/cosmos';

export async function createTtlEnabledContainer(
  database: Database,
  id: string,
  partitionKeyPath: string,
): Promise<Container> {
  const container = (await database.containers.createIfNotExists({
    id,
    partitionKey: { paths: [partitionKeyPath] },
    defaultTtl: -1,
  })).container;
  try {
    const def = (await container.read()).resource;
    if (def && def.defaultTtl === undefined) {
      await container.replace({ ...def, defaultTtl: -1 });
    }
  } catch { /* best-effort TTL upgrade */ }
  return container;
}
