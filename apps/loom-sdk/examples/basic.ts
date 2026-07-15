/**
 * Runnable example — provision a workspace + lakehouse, then list and clean up.
 *
 *   LOOM_API_URL=https://<host> LOOM_TOKEN=loom_pat_… npx tsx examples/basic.ts
 *
 * (After `npm run build`, import from '@csa-loom/sdk' instead of '../src/index.js'.)
 */
import { LoomClient, isLoomApiError } from '../src/index.js';

async function main(): Promise<void> {
  const baseUrl = process.env.LOOM_API_URL;
  const token = process.env.LOOM_TOKEN;
  if (!baseUrl || !token) {
    throw new Error('Set LOOM_API_URL and LOOM_TOKEN (a read-write loom_pat_… token).');
  }

  const loom = new LoomClient({ baseUrl, token });

  const me = await loom.whoami();
  console.log(`Authenticated as ${me.upn ?? me.oid} (auth=${me.auth}, scope=${me.scope ?? 'cookie'})`);

  const ws = await loom.workspaces.create({ name: `sdk-demo-${Date.now()}`, description: 'Created by @csa-loom/sdk example' });
  console.log(`Created workspace ${ws.id}`);

  const lake = await loom.items.create(ws.id, { itemType: 'lakehouse', displayName: 'Bronze lake' });
  console.log(`Created lakehouse ${lake.id}`);

  const items = await loom.items.list(ws.id);
  console.log(`Workspace has ${items.length} item(s).`);

  // Clean up.
  await loom.items.delete('lakehouse', lake.id);
  await loom.workspaces.delete(ws.id);
  console.log('Cleaned up.');
}

main().catch((e) => {
  if (isLoomApiError(e)) {
    console.error(`Loom API error ${e.status} (${e.code ?? 'n/a'}): ${e.message}${e.hint ? ` — ${e.hint}` : ''}`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
