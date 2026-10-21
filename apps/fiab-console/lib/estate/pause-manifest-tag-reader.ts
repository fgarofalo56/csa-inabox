/**
 * The DISCOVERY tag reader, split out of `./pause-orchestrator` (2026-10-20)
 * to keep that file under the monolith ceiling (scripts/ci/check-file-size.mjs)
 * while the throttle-hold logic landed. Re-exported verbatim from the
 * orchestrator, so every importer and `vi.mock` keeps working unchanged.
 */
import { armTypeFromId } from './pause-actuator';
import { pausableTypeSpec } from './pause-inventory';

/**
 * #4243 — the DISCOVERY tag reader: same read contract as the actuator's
 * `readTags` (ARM omitting `tags` is a successful "no tags" -> `{}`; only a
 * throw is a failed read), but routed through `armGetWithRetry`, so a
 * transient 429 is retried honoring `Retry-After` and only a SUSTAINED
 * throttle surfaces — as an `ArmThrottledError` whose message says
 * "throttled", which `partitionDiscovery` (`./pause-discovery-classify`)
 * classifies distinctly from a generic unreachable read.
 *
 * The actuator's own `readTags` stays single-shot: the act-time re-verify must
 * be fail-safe — on any doubt it skips the mutation, which is cheaper and safer
 * than retrying at the moment of acting. (The actuator's STATE reads —
 * `readPower` and the probes — are retried; see `createArmActuator`.)
 */
export function createManifestTagReader(): (
  resourceId: string,
) => Promise<Readonly<Record<string, string>> | null> {
  return async (resourceId: string) => {
    const { armGetWithRetry } = await import('@/lib/azure/arm-client');
    const type = armTypeFromId(resourceId);
    const version = pausableTypeSpec(type)?.armApiVersion ?? '2021-04-01';
    const body = await armGetWithRetry<{ tags?: Record<string, string> }>(
      `${resourceId}?api-version=${version}`,
    );
    return body?.tags ?? {};
  };
}
