/**
 * Unit tests for the AI-enrichment cognitive clients (SVC-1) — the PURE request
 * builders + not-configured gates, which need no live Azure. The live analyze
 * calls are exercised end-to-end by the AI-enrich preview route
 * (/api/items/ai-enrich/[service]/preview) against a real cognitive account.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { visionFeatureQuery } from '../ai-vision-client';
import { buildAnalyzeTextBody } from '../ai-language-client';
import { buildTranslateQuery } from '../ai-translator-client';
import { analyzeDocument } from '../doc-intelligence-client';
import { analyzeImage } from '../ai-vision-client';
import { analyzeText } from '../ai-language-client';
import { translate } from '../ai-translator-client';
import {
  CognitiveNotConfiguredError, CognitiveError,
  resolveCognitiveEndpoint, firstEnvEndpoint, AI_SERVICES_FALLBACK_ENVS,
} from '../cognitive-common';

describe('ai-vision-client — feature query builder', () => {
  it('maps UI feature ids to REST feature names, ordered + de-duped', () => {
    expect(visionFeatureQuery(['caption', 'read', 'caption'])).toBe('Caption,Read');
    expect(visionFeatureQuery(['tags', 'objects', 'people'])).toBe('Tags,Objects,People');
  });
  it('defaults to Caption,Read when no features are requested', () => {
    expect(visionFeatureQuery()).toBe('Caption,Read');
    expect(visionFeatureQuery([])).toBe('Caption,Read');
  });
});

describe('ai-language-client — analyze-text body builder', () => {
  it('wraps a single document with the task kind + language', () => {
    const body = buildAnalyzeTextBody({ kind: 'KeyPhraseExtraction', text: 'hello', language: 'es' });
    expect(body.kind).toBe('KeyPhraseExtraction');
    expect((body.analysisInput as any).documents[0]).toMatchObject({ id: '1', language: 'es', text: 'hello' });
  });
  it('defaults language to en', () => {
    const body = buildAnalyzeTextBody({ kind: 'SentimentAnalysis', text: 'x' });
    expect((body.analysisInput as any).documents[0].language).toBe('en');
  });
});

describe('ai-translator-client — query builder', () => {
  it('emits one to= per target language + api-version', () => {
    const q = buildTranslateQuery(['fr', 'de'], 'en');
    expect(q).toContain('api-version=3.0');
    expect(q).toContain('to=fr');
    expect(q).toContain('to=de');
    expect(q).toContain('from=en');
  });
  it('omits from when not supplied', () => {
    expect(buildTranslateQuery(['es'])).not.toContain('from=');
  });
});

describe('honest not-configured gates (no endpoint AND no shared fallback)', () => {
  // The gate only fires when NEITHER the per-service endpoint NOR the shared
  // multi-service Azure AI Services fallback (LOOM_AOAI_ENDPOINT /
  // LOOM_FOUNDRY_ENDPOINT / LOOM_FOUNDRY_PROJECT_ENDPOINT) is configured — so we
  // clear the fallback vars too for this block.
  const saved = {
    d: process.env.LOOM_DOCINTEL_ENDPOINT,
    v: process.env.LOOM_VISION_ENDPOINT,
    l: process.env.LOOM_LANGUAGE_ENDPOINT,
    t: process.env.LOOM_TRANSLATOR_ENDPOINT,
    aoai: process.env.LOOM_AOAI_ENDPOINT,
    fnd: process.env.LOOM_FOUNDRY_ENDPOINT,
    fndp: process.env.LOOM_FOUNDRY_PROJECT_ENDPOINT,
  };
  beforeAll(() => {
    delete process.env.LOOM_DOCINTEL_ENDPOINT;
    delete process.env.LOOM_VISION_ENDPOINT;
    delete process.env.LOOM_LANGUAGE_ENDPOINT;
    delete process.env.LOOM_TRANSLATOR_ENDPOINT;
    delete process.env.LOOM_AOAI_ENDPOINT;
    delete process.env.LOOM_FOUNDRY_ENDPOINT;
    delete process.env.LOOM_FOUNDRY_PROJECT_ENDPOINT;
  });
  afterAll(() => {
    if (saved.d) process.env.LOOM_DOCINTEL_ENDPOINT = saved.d;
    if (saved.v) process.env.LOOM_VISION_ENDPOINT = saved.v;
    if (saved.l) process.env.LOOM_LANGUAGE_ENDPOINT = saved.l;
    if (saved.t) process.env.LOOM_TRANSLATOR_ENDPOINT = saved.t;
    if (saved.aoai) process.env.LOOM_AOAI_ENDPOINT = saved.aoai;
    if (saved.fnd) process.env.LOOM_FOUNDRY_ENDPOINT = saved.fnd;
    if (saved.fndp) process.env.LOOM_FOUNDRY_PROJECT_ENDPOINT = saved.fndp;
  });

  it('doc-intel throws CognitiveNotConfiguredError naming LOOM_DOCINTEL_ENDPOINT', async () => {
    await expect(analyzeDocument({ urlSource: 'https://x/y.pdf' }))
      .rejects.toMatchObject({ name: 'CognitiveNotConfiguredError', envVar: 'LOOM_DOCINTEL_ENDPOINT' });
  });
  it('vision throws CognitiveNotConfiguredError naming LOOM_VISION_ENDPOINT', async () => {
    await expect(analyzeImage({ url: 'https://x/y.png' }))
      .rejects.toMatchObject({ name: 'CognitiveNotConfiguredError', envVar: 'LOOM_VISION_ENDPOINT' });
  });
  it('language throws CognitiveNotConfiguredError naming LOOM_LANGUAGE_ENDPOINT', async () => {
    await expect(analyzeText({ kind: 'KeyPhraseExtraction', text: 'x' }))
      .rejects.toMatchObject({ name: 'CognitiveNotConfiguredError', envVar: 'LOOM_LANGUAGE_ENDPOINT' });
  });
  it('translator throws CognitiveNotConfiguredError naming LOOM_TRANSLATOR_ENDPOINT', async () => {
    await expect(translate({ text: 'hi', to: ['fr'] }))
      .rejects.toMatchObject({ name: 'CognitiveNotConfiguredError', envVar: 'LOOM_TRANSLATOR_ENDPOINT' });
  });
});

describe('default-ON fallback to the shared Azure AI Services account (svc-ai-enrich optionalDefault)', () => {
  // When a per-service endpoint is UNSET but the shared multi-service AI Services
  // (Foundry) account is deployed, the enrichment activity stays 100% functional
  // against that account — this is what makes svc-ai-enrich optionalDefault honest
  // (the feature is ON via the fallback; no fake config, no dedicated account
  // required). resolveCognitiveEndpoint is the single resolver every client uses.
  const saved = {
    d: process.env.LOOM_DOCINTEL_ENDPOINT, aoai: process.env.LOOM_AOAI_ENDPOINT,
    fnd: process.env.LOOM_FOUNDRY_ENDPOINT,
  };
  afterAll(() => {
    saved.d ? (process.env.LOOM_DOCINTEL_ENDPOINT = saved.d) : delete process.env.LOOM_DOCINTEL_ENDPOINT;
    saved.aoai ? (process.env.LOOM_AOAI_ENDPOINT = saved.aoai) : delete process.env.LOOM_AOAI_ENDPOINT;
    saved.fnd ? (process.env.LOOM_FOUNDRY_ENDPOINT = saved.fnd) : delete process.env.LOOM_FOUNDRY_ENDPOINT;
  });

  it('resolves the shared AOAI/Foundry endpoint when the per-service var is unset (no throw)', () => {
    delete process.env.LOOM_DOCINTEL_ENDPOINT;
    delete process.env.LOOM_FOUNDRY_ENDPOINT;
    process.env.LOOM_AOAI_ENDPOINT = 'https://aoai-shared.cognitiveservices.azure.com/';
    // Preferred: the cognitiveservices.* AOAI host (classic data-plane paths), trailing slash stripped.
    expect(resolveCognitiveEndpoint('LOOM_DOCINTEL_ENDPOINT', 'Document Intelligence', 'https://x'))
      .toBe('https://aoai-shared.cognitiveservices.azure.com');
    // The dedicated endpoint still WINS when set.
    process.env.LOOM_DOCINTEL_ENDPOINT = 'https://dedicated-docintel.cognitiveservices.azure.com';
    expect(resolveCognitiveEndpoint('LOOM_DOCINTEL_ENDPOINT', 'Document Intelligence', 'https://x'))
      .toBe('https://dedicated-docintel.cognitiveservices.azure.com');
  });

  it('falls back to LOOM_FOUNDRY_ENDPOINT when AOAI is also unset', () => {
    delete process.env.LOOM_DOCINTEL_ENDPOINT;
    delete process.env.LOOM_AOAI_ENDPOINT;
    process.env.LOOM_FOUNDRY_ENDPOINT = 'https://aifndry.services.ai.azure.com/';
    expect(firstEnvEndpoint(AI_SERVICES_FALLBACK_ENVS)).toBe('https://aifndry.services.ai.azure.com');
    expect(resolveCognitiveEndpoint('LOOM_DOCINTEL_ENDPOINT', 'Document Intelligence', 'https://x'))
      .toBe('https://aifndry.services.ai.azure.com');
  });
});

describe('input validation gates (endpoint set, bad input)', () => {
  it('translator rejects an empty target-language list', async () => {
    process.env.LOOM_TRANSLATOR_ENDPOINT = 'https://x.cognitiveservices.azure.com';
    await expect(translate({ text: 'hi', to: [] })).rejects.toBeInstanceOf(CognitiveError);
    delete process.env.LOOM_TRANSLATOR_ENDPOINT;
  });
  it('exposes the typed error classes', () => {
    expect(CognitiveNotConfiguredError).toBeTypeOf('function');
    expect(CognitiveError).toBeTypeOf('function');
  });
});
