/**
 * Unit tests for knowledge-base-model — the pure AOAI-model-binding + output-mode
 * composition logic behind AIF-1's Knowledge Base composer. No network, no live
 * Search / AOAI service (per no-vaporware.md these exercise real branching, not
 * mocked backend behavior).
 */
import { describe, it, expect } from 'vitest';
import {
  isChatCompletionModel,
  buildKnowledgeBaseModel,
  composeKnowledgeBaseModels,
  describeKbOutputMode,
} from '../knowledge-base-model';

describe('isChatCompletionModel', () => {
  it('accepts chat-completion families', () => {
    for (const m of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-5', 'o3-mini', 'model-router', 'phi-4']) {
      expect(isChatCompletionModel(m)).toBe(true);
    }
  });
  it('rejects embedding / audio / image families', () => {
    for (const m of ['text-embedding-3-large', 'text-embedding-ada-002', 'ada', 'whisper', 'tts-1', 'dall-e-3', 'gpt-image-1']) {
      expect(isChatCompletionModel(m)).toBe(false);
    }
  });
  it('is case-insensitive and handles empty / null', () => {
    expect(isChatCompletionModel('TEXT-EMBEDDING-3-SMALL')).toBe(false);
    expect(isChatCompletionModel('GPT-4O')).toBe(true);
    expect(isChatCompletionModel('')).toBe(false);
    expect(isChatCompletionModel(undefined)).toBe(false);
    expect(isChatCompletionModel(null)).toBe(false);
  });
});

describe('buildKnowledgeBaseModel', () => {
  it('constructs the azureOpenAI model reference and trims a trailing slash', () => {
    const m = buildKnowledgeBaseModel({
      resourceUri: 'https://acct.openai.azure.com/',
      deploymentId: 'gpt-4o-mini',
      modelName: 'gpt-4o-mini',
    });
    expect(m).toEqual({
      kind: 'azureOpenAI',
      azureOpenAIParameters: { resourceUri: 'https://acct.openai.azure.com', deploymentId: 'gpt-4o-mini', modelName: 'gpt-4o-mini' },
    });
  });
  it('falls back to the deployment id when modelName is absent', () => {
    const m = buildKnowledgeBaseModel({ resourceUri: 'https://acct.openai.azure.com', deploymentId: 'my-chat' });
    expect(m.azureOpenAIParameters.modelName).toBe('my-chat');
  });
  it('throws when the resourceUri is missing', () => {
    expect(() => buildKnowledgeBaseModel({ resourceUri: '', deploymentId: 'd' })).toThrow(/resourceUri/i);
  });
  it('throws when the resourceUri is not https', () => {
    expect(() => buildKnowledgeBaseModel({ resourceUri: 'http://acct.openai.azure.com', deploymentId: 'd' })).toThrow(/https/i);
  });
  it('throws when the deployment is missing', () => {
    expect(() => buildKnowledgeBaseModel({ resourceUri: 'https://a.openai.azure.com', deploymentId: '' })).toThrow(/deployment/i);
  });
});

describe('composeKnowledgeBaseModels', () => {
  const model = { resourceUri: 'https://acct.openai.azure.com', deploymentId: 'gpt-4o-mini', modelName: 'gpt-4o-mini' };

  it('extractive with no model → empty models[], no error', () => {
    const c = composeKnowledgeBaseModels({ synthesize: false, model: null });
    expect(c.outputMode).toBe('extractiveData');
    expect(c.models).toEqual([]);
    expect(c.error).toBeUndefined();
  });
  it('extractive with a model → forwards the model for query planning', () => {
    const c = composeKnowledgeBaseModels({ synthesize: false, model, reasoningEffort: 'medium' });
    expect(c.outputMode).toBe('extractiveData');
    expect(c.models).toHaveLength(1);
    expect(c.error).toBeUndefined();
  });
  it('synthesis without a model → error, no submit', () => {
    const c = composeKnowledgeBaseModels({ synthesize: true, model: null });
    expect(c.outputMode).toBe('answerSynthesis');
    expect(c.models).toEqual([]);
    expect(c.error).toMatch(/synthesized answers require/i);
  });
  it('synthesis with a model → answerSynthesis + models[]', () => {
    const c = composeKnowledgeBaseModels({ synthesize: true, model });
    expect(c.outputMode).toBe('answerSynthesis');
    expect(c.models).toHaveLength(1);
    expect(c.error).toBeUndefined();
  });
  it('surfaces the model build error for a malformed choice', () => {
    const c = composeKnowledgeBaseModels({ synthesize: true, model: { resourceUri: '', deploymentId: 'd' } });
    expect(c.error).toMatch(/resourceUri/i);
  });
});

describe('describeKbOutputMode', () => {
  it('labels each mode', () => {
    expect(describeKbOutputMode('answerSynthesis', true)).toMatch(/synthesized/i);
    expect(describeKbOutputMode('extractiveData', true)).toMatch(/model-planned/i);
    expect(describeKbOutputMode('extractiveData', false)).toBe('Extractive grounding');
    expect(describeKbOutputMode(undefined, false)).toBe('Extractive grounding');
  });
});
