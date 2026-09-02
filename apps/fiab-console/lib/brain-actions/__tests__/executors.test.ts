/**
 * THE EXECUTOR'S OWN REFUSAL (#4257) — defense in depth, measured.
 *
 * `guardScalableToZero` should refuse first. This suite proves the executor
 * refuses even when it does not: the guard chain must NOT be the only thing
 * standing between a click and unrecoverable data loss, because a dropped guard
 * call in a refactor, a mis-edited registry entry, or a future caller reaching
 * the executor directly are all one-line mistakes with an irreversible outcome.
 *
 * Every arm asserts the OUTCOME that matters — `updateContainerAppScale`, the
 * only ARM write on this path, was NOT called — rather than only that a promise
 * rejected. Deleting the two-line refusal from `executeScaleToZero` turns the
 * first spec red while the last one keeps the suite honest in the other
 * direction (an executor that refused everything would fail THAT).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const arm = vi.hoisted(() => ({
  getContainerApp: vi.fn(),
  updateContainerAppScale: vi.fn(),
  readAcaConfig: vi.fn(),
}));
vi.mock('@/lib/azure/container-apps-arm-client', () => ({
  getContainerApp: arm.getContainerApp,
  updateContainerAppScale: arm.updateContainerAppScale,
  readAcaConfig: arm.readAcaConfig,
  AcaArmError: class AcaArmError extends Error {},
  AcaNotConfiguredError: class AcaNotConfiguredError extends Error {},
}));

import { executeScaleToZero, NonScalableResourceError } from '../executors';
import { __resetScalabilityCache } from '../scalability';
import type { PerformSubject } from '../types';

const SUB = '00000000-0000-4000-8000-000000000001';
const RG = 'rg-loom';

function subject(displayName: string): PerformSubject {
  return {
    nodeId: `azure:/subscriptions/${SUB}/resourcegroups/${RG}/providers/microsoft.app/containerapps/${displayName}`,
    displayName,
    resourceType: 'Microsoft.App/containerApps',
    subscriptionId: SUB,
    resourceGroup: RG,
    armResourceId: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/${displayName}`,
    minReplicasClaimed: 1,
  };
}

const BEFORE = { minReplicas: 1, maxReplicas: 1, provisioningState: 'Succeeded' } as never;
const IDS = { findingId: 'unreachable-always-on:x', detector: 'unreachable-always-on' };

beforeEach(() => {
  vi.clearAllMocks();
  __resetScalabilityCache();
  arm.updateContainerAppScale.mockResolvedValue({
    minReplicas: 0,
    maxReplicas: 1,
    provisioningState: 'Succeeded',
  });
});

describe('executeScaleToZero refuses a service the DEPLOY declares non-scalable', () => {
  it('THE HAZARD: loom-risingwave throws BEFORE the ARM PATCH', async () => {
    // Reads the real committed deploy template, exactly as production does.
    await expect(executeScaleToZero(subject('loom-risingwave'), BEFORE, IDS)).rejects.toBeInstanceOf(
      NonScalableResourceError,
    );
    // The outcome that matters: Azure was never written.
    expect(arm.updateContainerAppScale).not.toHaveBeenCalled();
  });

  it('the error says what it established — no ARM call was made', async () => {
    const err = await executeScaleToZero(subject('loom-risingwave'), BEFORE, IDS).catch(
      (e: unknown) => e as NonScalableResourceError,
    );
    expect(err.message).toContain('REFUSED BY THE EXECUTOR');
    expect(err.message).toContain('No ARM call was made');
    expect(err.message).toMatch(/materialized view/i);
    // Reaching this error at all means the guard chain did not refuse first,
    // and the message says so rather than presenting itself as routine.
    expect(err.message).toContain('#4257');
    expect(err.kind).toBe('pinned-singleton');
  });

  it('#4261 — loom-unity is ELASTIC and refused anyway, for AVAILABILITY', async () => {
    // The review hole: its replica shape (min 1 / max 3 / with rules on the
    // Postgres path) clears the pinned predicate, so only the declared-consumer
    // signal can stop this write.
    const err = await executeScaleToZero(subject('loom-unity'), BEFORE, IDS).catch(
      (e: unknown) => e as NonScalableResourceError,
    );
    expect(err).toBeInstanceOf(NonScalableResourceError);
    expect(err.kind).toBe('declared-consumer');
    expect(err.message).toContain('AVAILABILITY refusal');
    expect(err.message).not.toMatch(/unrecoverable/);
    expect(arm.updateContainerAppScale).not.toHaveBeenCalled();
  });

  it('the other declared singletons are refused too', async () => {
    for (const name of ['loom-airflow', 'iceberg-catalog']) {
      await expect(executeScaleToZero(subject(name), BEFORE, IDS)).rejects.toBeInstanceOf(
        NonScalableResourceError,
      );
    }
    expect(arm.updateContainerAppScale).not.toHaveBeenCalled();
  });

  it('THE CONTROL: an elastic, UNWIRED app still gets its PATCH and a real receipt', async () => {
    // Without this, an executor that threw for every subject would satisfy every
    // spec above while having silently deleted the feature.
    // `loom-presidio-analyzer` is declared elastic (min 1 / max 4) and the
    // deploy wires no consumer to it — measured on the committed template.
    const receipt = await executeScaleToZero(subject('loom-presidio-analyzer'), BEFORE, IDS);
    expect(arm.updateContainerAppScale).toHaveBeenCalledWith('loom-presidio-analyzer', {
      minReplicas: 0,
    });
    expect(receipt.executor).toBe('scale-to-zero');
    expect(receipt.mutatedAzure).toBe(true);
    expect(receipt.before.minReplicas).toBe(1);
    expect(receipt.after.minReplicas).toBe(0);
  });

  it('an app the deploy template does not declare is still performable', async () => {
    // `loom-capacity-broker` comes from the generic `apps[]` copy loop, so it
    // has no static declaration — the founding acceptance case must survive.
    await executeScaleToZero(subject('loom-capacity-broker'), BEFORE, IDS);
    expect(arm.updateContainerAppScale).toHaveBeenCalledWith('loom-capacity-broker', {
      minReplicas: 0,
    });
  });
});
