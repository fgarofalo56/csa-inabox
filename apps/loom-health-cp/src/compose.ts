// Composition root: wires stores -> registry/jobs/routing/slo -> HTTP app.
// Both main.ts (Cosmos + remote JWKS) and the tests (fakes at the Stores and
// keyResolver seams) go through here, so the tested graph is the shipped graph.

import { createApp } from './http/app.js';
import { builtinHandlers } from './jobs/builtin.js';
import { JobRunner } from './jobs/runner.js';
import { postgresRestartHandler, scheduleStampRestarts, type StampPowerDeps } from './jobs/stamp-power.js';
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
  now?: () => Date;
  postgresRestart?: Pick<StampPowerDeps, 'power' | 'getStampManifest'>;
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
  // W1-8: registered only when an ARM adapter is supplied (main.ts does not pass one yet, like the tenant jobs).
  if (input.postgresRestart) {
    jobs.register(postgresRestartHandler({ stamps: stores.stamps, ...input.postgresRestart }));
  }
  const scheduleRestarts = () => scheduleStampRestarts({ stamps: stores.stamps, jobs, now });
  const handler = createApp({ authenticate: createAuthenticator(input.auth), registry, jobs, routing, slo, log });
  return { handler, registry, jobs, routing, slo, scheduleRestarts };
}
