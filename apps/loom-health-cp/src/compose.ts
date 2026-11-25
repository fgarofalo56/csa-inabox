// Composition root: wires stores -> registry/jobs/routing/slo -> HTTP app.
// Both main.ts (Cosmos + remote JWKS) and the tests (fakes at the Stores and
// keyResolver seams) go through here, so the tested graph is the shipped graph.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAuthServer, type AuthServerInit } from './auth/server.js';
import { tenantHandlers } from './jobs/tenant-jobs.js';
import { fhirTenantHandlers, fhirTenantTeardownHandler, type FhirEngineHost } from './jobs/fhir-tenant-jobs.js';
import { reconcileEnginesOnce } from './jobs/fhir-engine-reconcile.js';
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
  /** PEM of the bundle signing key's public half (GET .../verification-key). Absent = 503. */
  bundleKey?: () => Promise<string>;
  now?: () => Date;
  postgresRestart?: Pick<StampPowerDeps, 'power' | 'getStampManifest'>;
  /** Registers tenant.create / tenant.destroy. */
  tenantArm?: TenantArm;
  /**
   * Registers fhir-tenant.create / .configure / .teardown. Needs `tenantArm` too, and a non-empty `pdpUrl`: without a
   * PDP every engine request is answered 503, so the kinds are not registered (they answer "unknown job kind").
   */
  fhirEngine?: { host: FhirEngineHost; pdpUrl: string };
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
  // W2-2b B2c: fail CLOSED. No host, no ARM adapter, or no PDP url = no engine kinds at all.
  const fhirDeps =
    input.tenantArm && input.fhirEngine && input.fhirEngine.pdpUrl.trim() !== ''
      ? { stamps: stores.stamps, tenants: stores.tenants, arm: input.tenantArm, engine: input.fhirEngine.host, pdpUrl: input.fhirEngine.pdpUrl }
      : undefined;
  // W1-2: registered only when an ARM adapter is supplied (main.ts always passes one, #5162); without one the tenant.* kinds answer "unknown job kind".
  // #5442: with the engine configured, tenant.create chains fhir-tenant.create and tenant.destroy runs the teardown first.
  if (input.tenantArm) {
    const fhir = fhirDeps && {
      submitCreate: async (tenantId: string, idempotencyKey: string) => {
        const { job, created } = await jobs.submit({ kind: 'fhir-tenant.create', subjectType: 'tenant', subjectId: tenantId, idempotencyKey, requestedBy: 'job:tenant.create' });
        return { jobId: job.id, created };
      },
      teardown: fhirTenantTeardownHandler(fhirDeps).run,
    };
    for (const h of tenantHandlers({ stamps: stores.stamps, tenants: stores.tenants, registry, arm: input.tenantArm, fhir })) jobs.register(h);
  }
  if (fhirDeps) for (const h of fhirTenantHandlers(fhirDeps)) jobs.register(h);
  // #5482 item 6: the engine drift reconciler (main.ts runs it at startup and on a timer). Absent with the engine kinds.
  const reconcileEngines = fhirDeps ? () => reconcileEnginesOnce({ ...fhirDeps, jobs, log, now }) : undefined;
  const app = createApp({ authenticate, registry, jobs, routing, slo, bundles: input.bundles, bundleKey: input.bundleKey, log });
  // W1-4: the Authorization Server answers its own paths and hands everything else to the control-plane app.
  const authServer = input.authServer
    ? createAuthServer({ ...input.authServer, authenticate, tenants: stores.tenants, log, now: input.now })
    : undefined;
  const handler = authServer
    ? async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (!(await authServer.handle(req, res))) await app(req, res);
      }
    : app;
  return { handler, registry, jobs, routing, slo, scheduleRestarts, reconcileEngines };
}
