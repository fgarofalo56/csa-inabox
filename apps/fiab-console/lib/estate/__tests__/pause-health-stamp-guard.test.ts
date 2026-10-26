/**
 * LHDS W1-8 - the `health-stamp` pause guard. Each case names the input that
 * would break it (assertion-design.md). A stamp with a running job must be
 * eligible:false; the positive case (idle stamp) pairs every absence assertion so
 * "always refuse" cannot pass.
 */
import { describe, it, expect } from 'vitest';
import {
  HEALTH_STAMP_TAG,
  HEALTH_TIER_TAG,
  healthStampPauseGuard,
  isHealthStampResource,
  tierPauseGuard,
} from '../pause-guards';

const STAMP_TAGS = { [HEALTH_STAMP_TAG]: 'dev01' };
const idle = { runningJobs: 0, activeFeeds: 0 };
const res = (tags: Record<string, string> | null) => ({ name: 'pg-lhds-dev01', tags });

describe('healthStampPauseGuard', () => {
  it('idle stamp (0 jobs, 0 feeds) is eligible - the positive control for every refusal below', () => {
    expect(healthStampPauseGuard(res(STAMP_TAGS), idle).eligible).toBe(true);
  });

  it('a stamp with a running job is eligible:false (breaks if runningJobs=1 is ignored)', () => {
    const g = healthStampPauseGuard(res(STAMP_TAGS), { runningJobs: 1, activeFeeds: 0 });
    expect(g.eligible).toBe(false);
    expect(g.reason).toContain('1 running lifecycle job');
  });

  it('a stamp with an active feed is eligible:false (breaks if activeFeeds=2 is ignored)', () => {
    const g = healthStampPauseGuard(res(STAMP_TAGS), { runningJobs: 0, activeFeeds: 2 });
    expect(g.eligible).toBe(false);
    expect(g.reason).toContain('2 active feed');
  });

  it('unknown activity fails safe (breaks if undefined/null is read as zero)', () => {
    expect(healthStampPauseGuard(res(STAMP_TAGS), undefined).eligible).toBe(false);
    expect(healthStampPauseGuard(res(STAMP_TAGS), { runningJobs: null, activeFeeds: 0 }).eligible).toBe(false);
    expect(healthStampPauseGuard(res(STAMP_TAGS), { runningJobs: 0, activeFeeds: null }).eligible).toBe(false);
    expect(healthStampPauseGuard(res(STAMP_TAGS), { runningJobs: Number.NaN, activeFeeds: 0 }).eligible).toBe(false);
  });

  it('production tier is held out even when idle (breaks if loom-health-tier=production is not read)', () => {
    const g = healthStampPauseGuard(res({ ...STAMP_TAGS, [HEALTH_TIER_TAG]: 'Production' }), idle);
    expect(g.eligible).toBe(false);
    expect(g.reason).toContain('production');
    expect(healthStampPauseGuard(res({ ...STAMP_TAGS, [HEALTH_TIER_TAG]: 'dev' }), idle).eligible).toBe(true);
  });

  it('loom-estate-pause=exempt holds an idle stamp out', () => {
    expect(healthStampPauseGuard(res({ ...STAMP_TAGS, 'loom-estate-pause': 'exempt' }), idle).eligible).toBe(false);
  });

  it('a resource without the stamp tag is not this guard\'s business (breaks if untagged resources are refused)', () => {
    expect(healthStampPauseGuard(res({ team: 'x' }), { runningJobs: 9, activeFeeds: 9 }).eligible).toBe(true);
    expect(isHealthStampResource({ team: 'x' })).toBe(false);
    expect(isHealthStampResource({ 'Loom-Health-Stamp': 'dev01' })).toBe(true);
    expect(isHealthStampResource({ [HEALTH_STAMP_TAG]: '  ' })).toBe(false);
  });
});

describe('tierPauseGuard integration', () => {
  const env = { LOOM_CONTAINER_PLATFORM: 'aks', LOOM_AKS_CLUSTER_NAME: 'aks-console' } as unknown as NodeJS.ProcessEnv;
  const aks = (tags: Record<string, string>) => ({ resourceType: 'Microsoft.ContainerService/managedClusters', name: 'aks-lhds-dev01', tags });

  it('a stamp AKS cluster with a running job is held out by tierPauseGuard', () => {
    const g = tierPauseGuard(aks(STAMP_TAGS), undefined, env, { runningJobs: 3, activeFeeds: 0 });
    expect(g.eligible).toBe(false);
    expect(g.reason).toContain('3 running lifecycle job');
  });

  it('the same cluster idle is eligible, and with no activity passed it is held out (fail safe)', () => {
    expect(tierPauseGuard(aks(STAMP_TAGS), undefined, env, idle).eligible).toBe(true);
    expect(tierPauseGuard(aks(STAMP_TAGS), undefined, env).eligible).toBe(false);
  });

  it('a stamp PostgreSQL server with a running job is held out (databases reach the guard through tierPauseGuard)', () => {
    const pg = { resourceType: 'Microsoft.DBforPostgreSQL/flexibleServers', name: 'pg-lhds-dev01', tags: STAMP_TAGS };
    expect(tierPauseGuard(pg, undefined, env, { runningJobs: 1, activeFeeds: 0 }).eligible).toBe(false);
    expect(tierPauseGuard(pg, undefined, env, idle).eligible).toBe(true);
  });

  it('non-stamp resources are unchanged: an untagged AKS cluster stays eligible with no activity', () => {
    expect(tierPauseGuard(aks({ team: 'x' }), undefined, env).eligible).toBe(true);
  });

  it('the existing console guard still wins on an idle stamp-tagged cluster that hosts the console', () => {
    const g = tierPauseGuard({ ...aks(STAMP_TAGS), name: 'aks-console' }, undefined, env, idle);
    expect(g.eligible).toBe(false);
    expect(g.reason).toContain('hosting this console');
  });
});
