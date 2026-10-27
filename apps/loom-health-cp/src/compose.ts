// Composition root: wires stores -> registry/jobs/routing/slo -> HTTP app.
// Both main.ts (Cosmos + remote JWKS) and the tests (fakes at the Stores and
// keyResolver seams) go through here, so the tested graph is the shipped graph.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAuthServer, type AuthServerInit } from './auth/server.js';
import { tenantHandlers } from './jobs/tenant-jobs.js';
import type { TenantArm } from './jobs/tenant-arm.js';
import type { BundleSource } from './pdp/bundles.js';
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
  bundles?: BundleSource;
  now?: () => Date;
  postgresRestart?: Pick<StampPowerDeps, 'power' | 'getStampManifest'>;
  /** Registers tenant.create / tenant.destroy. */
  tenantArm?: TenantArm;
  /** Serves the SMART/OAuth routes and /api/health/auth/*. */
  authServer?: AuthServerInit;
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
  const authenticate = createAuthenticator(input.auth);
  // W1-2: registered only when an ARM adapter is supplied; without one the tenant.* kinds answer "unknown job kind".
  if (input.tenantArm) {
    for (const h of tenantHandlers({ stamps: stores.stamps, tenants: stores.tenants, registry, arm: input.tenantArm })) jobs.register(h);
  }
  const app = createApp({ authenticate, registry, jobs, routing, slo, bundles: input.bundles, log });
  // W1-4: the Authorization Server answers its own paths and hands everything else to the control-plane app.
  const authServer = input.authServer
    ? createAuthServer({ ...input.authServer, authenticate, tenants: stores.tenants, log, now: input.now })
    : undefined;
  const handler = authServer
    ? async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (!(await authServer.handle(req, res))) await app(req, res);
      }
    : app;
  return { handler, registry, jobs, routing, slo, scheduleRestarts };
}
