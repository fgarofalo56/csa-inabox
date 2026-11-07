import { z } from 'zod';
import type { RoutingPublisher } from '../routing/publisher.js';
import type { JobHandler } from './types.js';

/** Handlers the framework ships with. W1-2's tenant jobs register alongside these. */
export function builtinHandlers(deps: { routing: RoutingPublisher }): JobHandler[] {
  return [routingPublishHandler(deps.routing)];
}

/** `routing.publish`: rebuild the tenant->stamp map from the registries and publish it. */
export function routingPublishHandler(publisher: RoutingPublisher): JobHandler {
  return {
    kind: 'routing.publish',
    subjectType: 'routing',
    inputSchema: z.strictObject({}),
    async run(ctx) {
      const r = await publisher.publish();
      await ctx.receipt(
        'routing.published',
        `published=${r.published} version=${r.version.slice(0, 12)} entries=${r.entryCount} skipped=${r.skipped.length}`,
      );
    },
  };
}
