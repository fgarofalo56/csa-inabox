// Composition root: wires stores -> registry/jobs/routing/slo -> HTTP app.
// Both main.ts (Cosmos + remote JWKS) and the tests (fakes at the Stores and
// keyResolver seams) go through here, so the tested graph is the shipped graph.

import type { BundleSource } from './pdp/bundles.js';
import { createApp } from './http/app.js';
import { builtinHandlers } from './jobs/builtin.js';
import { JobRunner } from './jobs/runner.js';
import { createAuthenticator, type AuthOptions } from './middleware/auth.js';
import { Registry } from './registry/registry.js';
import { RoutingPublisher } from './routing/publisher.js';
import { SloService } from './slo/aggregate.js';
import type { Stores } from './store/types.js';

export type Logger = (event: string, fields: Record<string, string | number>) => void;

export interface ComposeInput {
  stores: Stores;
  auth: AuthOptions;
  sloAvailabilityTarget: number;
  log: Logger;
  bundles?: BundleSource;
  now?: () => Date;
}

export function compose(input: ComposeInput) {
  const { stores, log } = input;
  const now = input.now ?? (() => new Date());
  const registry = new Registry(stores.stamps, stores.tenants, now);
  const routing = new RoutingPublisher(stores.stamps, stores.tenants, stores.routing, now);
  const slo = new SloService(stores.stamps, stores.slo, input.sloAvailabilityTarget, now);
  const jobs = new JobRunner(
    stores.jobs,
    async (type, id) => {
      if (type === 'routing') return id === 'current';
      return (await (type === 'stamp' ? stores.stamps : stores.tenants).get(id)) !== undefined;
    },
    log,
    now,
  );
  for (const h of builtinHandlers({ routing })) jobs.register(h);
  const handler = createApp({ authenticate: createAuthenticator(input.auth), registry, jobs, routing, slo, bundles: input.bundles, log });
  return { handler, registry, jobs, routing, slo };
}
