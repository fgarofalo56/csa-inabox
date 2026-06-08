/**
 * AI Functions — AOAI suffix cloud matrix.
 *
 * Guards the sovereign-awareness the AI Functions surface depends on: the AOAI
 * inference host (getOpenAiSuffix) and token audience (cogScope) MUST flip to
 * the Government values on the Gov / DoD boundaries, so the gpt-4o substitute
 * for sentiment/classify/translate/summarize/extract calls the correct
 * sovereign endpoint. If a helper ever drifts back to a Commercial-only literal
 * the Gov rows here fail. Mirrors cloud-matrix.test.ts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const SAVED = { ...process.env };

async function load(cloud?: string) {
  vi.resetModules();
  delete process.env.AZURE_CLOUD;
  delete process.env.LOOM_ARM_ENDPOINT;
  if (cloud) process.env.AZURE_CLOUD = cloud;
  return import('../cloud-endpoints');
}

afterEach(() => {
  process.env = { ...SAVED };
});

describe('AI Functions AOAI suffix — Commercial (AzureCloud)', () => {
  it('getOpenAiSuffix() → openai.azure.com', async () => {
    const m = await load('AzureCloud');
    expect(m.isGovCloud()).toBe(false);
    expect(m.getOpenAiSuffix()).toBe('openai.azure.com');
  });

  it('cogScope() → cognitiveservices.azure.com/.default', async () => {
    const m = await load('AzureCloud');
    expect(m.cogScope()).toBe('https://cognitiveservices.azure.com/.default');
  });
});

describe('AI Functions AOAI suffix — Government (AzureUSGovernment / GCC-High / IL5)', () => {
  it('getOpenAiSuffix() → openai.azure.us', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.isGovCloud()).toBe(true);
    expect(m.getOpenAiSuffix()).toBe('openai.azure.us');
  });

  it('cogScope() → cognitiveservices.azure.us/.default', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.cogScope()).toBe('https://cognitiveservices.azure.us/.default');
  });
});

describe('AI Functions AOAI suffix — DoD (AzureDOD)', () => {
  it('is treated as Gov data-plane: openai.azure.us + Gov audience', async () => {
    const m = await load('AzureDOD');
    expect(m.isGovCloud()).toBe(true);
    expect(m.getOpenAiSuffix()).toBe('openai.azure.us');
    expect(m.cogScope()).toBe('https://cognitiveservices.azure.us/.default');
  });
});
