import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { CANCEL_INTENT_TTL_SECONDS } from '../azure-sql-cancel-intents';

/**
 * #4406 — the drift guard the issue's acceptance criteria asked for: the ARM
 * row's `defaultTtl`/`ttl` and partition key must agree with the lazy
 * `createIfNotExists` call's `CANCEL_INTENT_TTL_SECONDS` / `/requestId`, or
 * the TTL self-eviction guarantee silently stops applying the moment some
 * OTHER path (an operator, a script, a future template edit) wins the
 * container-creation race.
 *
 * Values are LIFTED out of the bicep source via regex, not retyped as a
 * second `120` literal here — two independently-typed copies of the same
 * number is exactly the drift this test exists to catch, so the test itself
 * must not become a third one.
 *
 * Each read is scoped to the `sql-cancel-intents` declaration specifically.
 * Both bicep files declare other containers with their own `defaultTtl`/`ttl`
 * values nearby; a whole-file regex would silently bind to the WRONG
 * container's number the moment one were added or reordered above this one.
 */

const adminPlaneCosmos = () =>
  readFileSync(
    resolve(__dirname, '../../../../../platform/fiab/bicep/modules/admin-plane/loom-console-cosmos.bicep'),
    'utf8',
  );

const landingZoneCosmos = () =>
  readFileSync(
    resolve(__dirname, '../../../../../platform/fiab/bicep/modules/landing-zone/cosmos.bicep'),
    'utf8',
  );

function sliceBetween(src: string, startNeedle: string, endNeedle: string): string {
  const start = src.indexOf(startNeedle);
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start);
  const end = rest.indexOf(endNeedle);
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end + endNeedle.length);
}

describe('#4406 — sql-cancel-intents: ARM declarations agree with the lazy createIfNotExists call', () => {
  it('admin-plane/loom-console-cosmos.bicep defaultTtl equals CANCEL_INTENT_TTL_SECONDS', () => {
    const block = sliceBetween(adminPlaneCosmos(), "resource sqlCancelIntents '", '\n}\n');
    const match = block.match(/defaultTtl:\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(CANCEL_INTENT_TTL_SECONDS);
  });

  it('admin-plane/loom-console-cosmos.bicep partitionKey path equals /requestId', () => {
    const block = sliceBetween(adminPlaneCosmos(), "resource sqlCancelIntents '", '\n}\n');
    expect(block).toMatch(/partitionKey:\s*\{\s*paths:\s*\['\/requestId'\]/);
  });

  it("landing-zone/cosmos.bicep's ttl equals CANCEL_INTENT_TTL_SECONDS", () => {
    const block = sliceBetween(landingZoneCosmos(), "{ name: 'sql-cancel-intents'", '}');
    const match = block.match(/ttl:\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(CANCEL_INTENT_TTL_SECONDS);
  });

  it("landing-zone/cosmos.bicep's partitionKey equals /requestId", () => {
    const block = sliceBetween(landingZoneCosmos(), "{ name: 'sql-cancel-intents'", '}');
    expect(block).toMatch(/partitionKey:\s*'\/requestId'/);
  });
});
