import { describe, it, expect, afterEach } from 'vitest';
import {
  batchConfigGate,
  buildPoolBody,
  buildJobBody,
  buildTaskBody,
  autoScaleFormulaFor,
  AUTOSCALE_PRESETS,
  VM_SIZE_PRESETS,
} from '../batch-client';

const ENV_KEYS = [
  'LOOM_BATCH_ACCOUNT', 'LOOM_BATCH_SUB', 'LOOM_SUBSCRIPTION_ID',
  'LOOM_BATCH_RG', 'LOOM_DLZ_RG', 'LOOM_ADMIN_RG',
];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
function clearEnv() { for (const k of ENV_KEYS) delete process.env[k]; }
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('batch-client config gate', () => {
  it('names LOOM_BATCH_ACCOUNT first when unset', () => {
    clearEnv();
    expect(batchConfigGate()).toEqual({ missing: 'LOOM_BATCH_ACCOUNT' });
  });
  it('falls through subscription then RG aliases', () => {
    clearEnv();
    process.env.LOOM_BATCH_ACCOUNT = 'acct';
    expect(batchConfigGate()?.missing).toContain('LOOM_BATCH_SUB');
    process.env.LOOM_SUBSCRIPTION_ID = 'sub';
    expect(batchConfigGate()?.missing).toContain('LOOM_BATCH_RG');
    process.env.LOOM_DLZ_RG = 'rg';
    expect(batchConfigGate()).toBeNull();
  });
});

describe('buildPoolBody', () => {
  it('emits fixedScale when autoscale is off, with defaulted counts + Ubuntu image', () => {
    const body = buildPoolBody({ name: 'p1', vmSize: 'standard_d2s_v3' });
    expect(body.properties.vmSize).toBe('standard_d2s_v3');
    expect(body.properties.scaleSettings.fixedScale.targetDedicatedNodes).toBe(1);
    expect(body.properties.scaleSettings.fixedScale.targetLowPriorityNodes).toBe(0);
    expect(body.properties.scaleSettings.autoScale).toBeUndefined();
    const img = body.properties.deploymentConfiguration.virtualMachineConfiguration.imageReference;
    expect(img.offer).toContain('ubuntu');
  });
  it('emits autoScale block only when a formula is present', () => {
    const off = buildPoolBody({ name: 'p', vmSize: 'v', enableAutoScale: true });
    expect(off.properties.scaleSettings.autoScale).toBeUndefined(); // no formula ⇒ fixed
    const on = buildPoolBody({ name: 'p', vmSize: 'v', enableAutoScale: true, autoScaleFormula: '$x=1;' });
    expect(on.properties.scaleSettings.autoScale.formula).toBe('$x=1;');
    expect(on.properties.scaleSettings.autoScale.evaluationInterval).toBe('PT5M');
    expect(on.properties.scaleSettings.fixedScale).toBeUndefined();
  });
  it('honours explicit node counts', () => {
    const body = buildPoolBody({ name: 'p', vmSize: 'v', targetDedicatedNodes: 4, targetLowPriorityNodes: 8 });
    expect(body.properties.scaleSettings.fixedScale.targetDedicatedNodes).toBe(4);
    expect(body.properties.scaleSettings.fixedScale.targetLowPriorityNodes).toBe(8);
  });
});

describe('buildJobBody / buildTaskBody', () => {
  it('job carries poolInfo.poolId and omits empty optionals', () => {
    const b = buildJobBody({ id: 'j1', poolId: 'p1' });
    expect(b.poolInfo.poolId).toBe('p1');
    expect(b.displayName).toBeUndefined();
    expect(b.priority).toBeUndefined();
  });
  it('job includes priority 0 when explicitly set', () => {
    const b = buildJobBody({ id: 'j', poolId: 'p', priority: 0 });
    expect(b.priority).toBe(0);
  });
  it('task carries the command line', () => {
    const b = buildTaskBody({ jobId: 'j', id: 't', commandLine: '/bin/bash -c "echo hi"' });
    expect(b.id).toBe('t');
    expect(b.commandLine).toContain('echo hi');
  });
});

describe('autoscale presets', () => {
  it('resolves a preset key to its formula and unknown to empty', () => {
    expect(autoScaleFormulaFor('queue-driven')).toContain('$TargetDedicatedNodes');
    expect(autoScaleFormulaFor('nope')).toBe('');
  });
  it('every preset formula assigns a target node variable', () => {
    for (const p of AUTOSCALE_PRESETS) expect(p.formula).toMatch(/\$Target(Dedicated|LowPriority)Nodes/);
  });
  it('ships a non-empty VM size catalog', () => {
    expect(VM_SIZE_PRESETS.length).toBeGreaterThan(3);
  });
});
