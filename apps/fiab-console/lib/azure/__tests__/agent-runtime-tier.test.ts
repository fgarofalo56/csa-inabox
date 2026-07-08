import { describe, it, expect, afterEach } from 'vitest';
import { selectAgentTier } from '../agent-runtime-tier';

/**
 * AIF-8 — agent-runtime tier selection. Pure (env + cloud) so it's testable
 * with no Azure calls. The MAF Gov backstop must engage ONLY when Foundry is
 * unconfigured AND we're in a Gov boundary AND the MAF app is deployed.
 */
const SAVED = {
  fp: process.env.LOOM_FOUNDRY_PROJECT_ENDPOINT,
  maf: process.env.LOOM_MAF_ENDPOINT,
  cloud: process.env.LOOM_CLOUD,
  azcloud: process.env.AZURE_CLOUD,
};

function reset() {
  delete process.env.LOOM_FOUNDRY_PROJECT_ENDPOINT;
  delete process.env.LOOM_MAF_ENDPOINT;
  delete process.env.LOOM_CLOUD;
  delete process.env.AZURE_CLOUD;
}

afterEach(() => {
  reset();
  if (SAVED.fp !== undefined) process.env.LOOM_FOUNDRY_PROJECT_ENDPOINT = SAVED.fp;
  if (SAVED.maf !== undefined) process.env.LOOM_MAF_ENDPOINT = SAVED.maf;
  if (SAVED.cloud !== undefined) process.env.LOOM_CLOUD = SAVED.cloud;
  if (SAVED.azcloud !== undefined) process.env.AZURE_CLOUD = SAVED.azcloud;
});

describe('selectAgentTier', () => {
  it('uses Foundry when the project endpoint is configured (Commercial)', () => {
    reset();
    process.env.LOOM_CLOUD = 'Commercial';
    process.env.LOOM_FOUNDRY_PROJECT_ENDPOINT = 'https://acct.services.ai.azure.com/api/projects/p';
    expect(selectAgentTier().tier).toBe('foundry-agent-service');
  });

  it('uses Foundry when configured EVEN in Gov with MAF deployed (opt-in Foundry wins)', () => {
    reset();
    process.env.LOOM_CLOUD = 'GCC-High';
    process.env.LOOM_MAF_ENDPOINT = 'http://loom-copilot-maf';
    process.env.LOOM_FOUNDRY_PROJECT_ENDPOINT = 'https://acct.services.ai.azure.com/api/projects/p';
    expect(selectAgentTier().tier).toBe('foundry-agent-service');
  });

  it('engages the MAF tier in Gov when Foundry is unconfigured and MAF is deployed', () => {
    reset();
    process.env.LOOM_CLOUD = 'GCC-High';
    process.env.LOOM_MAF_ENDPOINT = 'http://loom-copilot-maf';
    const d = selectAgentTier();
    expect(d.tier).toBe('maf');
    expect(d.reason).toMatch(/Gov/i);
  });

  it('engages the MAF tier for DoD too (isGovCloud)', () => {
    reset();
    process.env.LOOM_CLOUD = 'DoD';
    process.env.LOOM_MAF_ENDPOINT = 'http://loom-copilot-maf';
    expect(selectAgentTier().tier).toBe('maf');
  });

  it('stays on Foundry (honest gate) in Gov when the MAF app is NOT deployed', () => {
    reset();
    process.env.LOOM_CLOUD = 'GCC-High';
    expect(selectAgentTier().tier).toBe('foundry-agent-service');
  });

  it('stays on Foundry in Commercial even without a project endpoint (existing gate handles it)', () => {
    reset();
    process.env.LOOM_CLOUD = 'Commercial';
    process.env.LOOM_MAF_ENDPOINT = 'http://loom-copilot-maf';
    expect(selectAgentTier().tier).toBe('foundry-agent-service');
  });

  it('honors an explicit override endpoint over env', () => {
    reset();
    process.env.LOOM_CLOUD = 'GCC-High';
    process.env.LOOM_MAF_ENDPOINT = 'http://loom-copilot-maf';
    expect(selectAgentTier({ projectEndpoint: 'https://x.services.ai.azure.com/api/projects/p' }).tier)
      .toBe('foundry-agent-service');
  });
});
