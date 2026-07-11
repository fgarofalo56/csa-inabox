/**
 * Model-strategy M4 — routing decision for the OPT-IN APIM AI-gateway.
 *
 * Pure, network-free coverage of resolveAoaiCallTarget / aoaiApimHeaders:
 *   • flag OFF (default) → direct AOAI endpoint, byte-identical target
 *   • flag ON + gateway URL → route through APIM (endpoint swapped)
 *   • Gov fallback (apimAvailable:false) → direct-with-MI
 *   • subscription-key attach + header emission
 *   • misconfiguration (flag on / url missing, or vice-versa) → direct
 */
import { describe, it, expect } from 'vitest';
import {
  resolveAoaiCallTarget,
  aoaiApimHeaders,
  APIM_SUBSCRIPTION_KEY_HEADER,
} from '../aoai-apim-gateway';
import type { AoaiTarget } from '../copilot-orchestrator';

const BASE: AoaiTarget = {
  endpoint: 'https://aifndry-loom-x.openai.azure.com',
  deployment: 'gpt-5-chat',
  apiVersion: '2024-10-21',
};
const GATEWAY = 'https://apim-csa-loom-eastus.azure-api.net';

describe('resolveAoaiCallTarget — DEFAULT is direct', () => {
  it('flag unset → direct (byte-identical target, viaApim false)', () => {
    const t = resolveAoaiCallTarget(BASE, { env: {} });
    expect(t.viaApim).toBe(false);
    expect(t.endpoint).toBe(BASE.endpoint);
    expect(t.deployment).toBe(BASE.deployment);
    expect(t.apiVersion).toBe(BASE.apiVersion);
    expect(t.subscriptionKey).toBeUndefined();
  });

  it('flag on but NO gateway url → direct', () => {
    const t = resolveAoaiCallTarget(BASE, { env: { LOOM_AOAI_VIA_APIM: 'true' } });
    expect(t.viaApim).toBe(false);
    expect(t.endpoint).toBe(BASE.endpoint);
  });

  it('gateway url set but flag OFF → direct', () => {
    const t = resolveAoaiCallTarget(BASE, { env: { LOOM_AOAI_APIM_URL: GATEWAY } });
    expect(t.viaApim).toBe(false);
    expect(t.endpoint).toBe(BASE.endpoint);
  });

  it('flag set to a non-"true" value → direct', () => {
    const t = resolveAoaiCallTarget(BASE, { env: { LOOM_AOAI_VIA_APIM: '1', LOOM_AOAI_APIM_URL: GATEWAY } });
    expect(t.viaApim).toBe(false);
  });
});

describe('resolveAoaiCallTarget — flag on + url routes through APIM', () => {
  it('endpoint swapped to the gateway; deployment/apiVersion preserved', () => {
    const t = resolveAoaiCallTarget(BASE, {
      env: { LOOM_AOAI_VIA_APIM: 'true', LOOM_AOAI_APIM_URL: GATEWAY },
    });
    expect(t.viaApim).toBe(true);
    expect(t.endpoint).toBe(GATEWAY);
    expect(t.deployment).toBe(BASE.deployment);
    expect(t.apiVersion).toBe(BASE.apiVersion);
  });

  it('trims a trailing slash on the gateway url', () => {
    const t = resolveAoaiCallTarget(BASE, {
      env: { LOOM_AOAI_VIA_APIM: 'true', LOOM_AOAI_APIM_URL: `${GATEWAY}/` },
    });
    expect(t.endpoint).toBe(GATEWAY);
  });

  it('case-insensitive TRUE flag', () => {
    const t = resolveAoaiCallTarget(BASE, {
      env: { LOOM_AOAI_VIA_APIM: 'TRUE', LOOM_AOAI_APIM_URL: GATEWAY },
    });
    expect(t.viaApim).toBe(true);
  });

  it('carries the subscription key when configured', () => {
    const t = resolveAoaiCallTarget(BASE, {
      env: {
        LOOM_AOAI_VIA_APIM: 'true',
        LOOM_AOAI_APIM_URL: GATEWAY,
        LOOM_AOAI_APIM_SUBSCRIPTION_KEY: 'sub-key-123',
      },
    });
    expect(t.viaApim).toBe(true);
    expect(t.subscriptionKey).toBe('sub-key-123');
  });
});

describe('resolveAoaiCallTarget — Gov direct-with-MI fallback', () => {
  it('apimAvailable:false forces direct even with the flag + url on', () => {
    const env = { LOOM_AOAI_VIA_APIM: 'true', LOOM_AOAI_APIM_URL: GATEWAY };
    const routed = resolveAoaiCallTarget(BASE, { env });
    expect(routed.viaApim).toBe(true);

    const fallback = resolveAoaiCallTarget(BASE, { env, apimAvailable: false });
    expect(fallback.viaApim).toBe(false);
    expect(fallback.endpoint).toBe(BASE.endpoint);
    expect(fallback.subscriptionKey).toBeUndefined();
  });
});

describe('aoaiApimHeaders', () => {
  it('empty on the direct path', () => {
    const t = resolveAoaiCallTarget(BASE, { env: {} });
    expect(aoaiApimHeaders(t)).toEqual({});
  });

  it('empty when routed but no key configured', () => {
    const t = resolveAoaiCallTarget(BASE, {
      env: { LOOM_AOAI_VIA_APIM: 'true', LOOM_AOAI_APIM_URL: GATEWAY },
    });
    expect(aoaiApimHeaders(t)).toEqual({});
  });

  it('emits the subscription-key header when routed with a key', () => {
    const t = resolveAoaiCallTarget(BASE, {
      env: {
        LOOM_AOAI_VIA_APIM: 'true',
        LOOM_AOAI_APIM_URL: GATEWAY,
        LOOM_AOAI_APIM_SUBSCRIPTION_KEY: 'sub-key-123',
      },
    });
    expect(aoaiApimHeaders(t)).toEqual({ [APIM_SUBSCRIPTION_KEY_HEADER]: 'sub-key-123' });
  });
});
