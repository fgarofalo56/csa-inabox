import { describe, it, expect } from 'vitest';
import { buildAoaiBody, type AoaiChatMessage } from '../aoai-model-contract';

const MSGS: AoaiChatMessage[] = [
  { role: 'system', content: 'you are a test' },
  { role: 'user', content: 'hi' },
];

describe('buildAoaiBody — token cap contract', () => {
  it('emits max_completion_tokens, NEVER max_tokens', () => {
    const body = buildAoaiBody({ messages: MSGS, maxCompletionTokens: 2048 });
    expect(body.max_completion_tokens).toBe(2048);
    expect('max_tokens' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('max_tokens');
  });

  it('omits the cap entirely when maxCompletionTokens is not supplied (tool-loop shape)', () => {
    const body = buildAoaiBody({ messages: MSGS });
    expect('max_completion_tokens' in body).toBe(false);
    expect('max_tokens' in body).toBe(false);
  });
});

describe('buildAoaiBody — temperature handling (retry contract)', () => {
  it('includes temperature on the first attempt when provided', () => {
    const body = buildAoaiBody({ messages: MSGS, temperature: 0.2, maxCompletionTokens: 2048 });
    expect(body.temperature).toBe(0.2);
  });

  it('omits temperature entirely on the retry attempt (undefined)', () => {
    const body = buildAoaiBody({ messages: MSGS, maxCompletionTokens: 2048 });
    expect('temperature' in body).toBe(false);
  });

  it('keeps temperature:0 (a real value) — only undefined is dropped', () => {
    const body = buildAoaiBody({ messages: MSGS, temperature: 0 });
    expect('temperature' in body).toBe(true);
    expect(body.temperature).toBe(0);
  });
});

describe('buildAoaiBody — response_format passthrough', () => {
  it('expands the json_object shorthand', () => {
    const body = buildAoaiBody({ messages: MSGS, responseFormat: 'json_object' });
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('passes a full response_format object through verbatim', () => {
    const rf = { type: 'json_schema', json_schema: { name: 'x', schema: {} } };
    const body = buildAoaiBody({ messages: MSGS, responseFormat: rf });
    expect(body.response_format).toEqual(rf);
  });

  it('omits response_format when not requested', () => {
    const body = buildAoaiBody({ messages: MSGS, maxCompletionTokens: 2048 });
    expect('response_format' in body).toBe(false);
  });
});

describe('buildAoaiBody — tool-loop + stream fields', () => {
  it('emits tools + tool_choice + stream when supplied', () => {
    const tools = [{ type: 'function', function: { name: 't', description: 'd', parameters: {} } }];
    const body = buildAoaiBody({ messages: MSGS, tools, toolChoice: 'auto', stream: true });
    expect(body.tools).toBe(tools);
    expect(body.tool_choice).toBe('auto');
    expect(body.stream).toBe(true);
  });

  it('omits tools / tool_choice / stream when not supplied', () => {
    const body = buildAoaiBody({ messages: MSGS });
    expect('tools' in body).toBe(false);
    expect('tool_choice' in body).toBe(false);
    expect('stream' in body).toBe(false);
  });
});

describe('buildAoaiBody — byte-identical reproduction of the legacy inline bodies', () => {
  // These literals are the EXACT objects the three legacy inline call sites in
  // copilot-orchestrator.ts pass to JSON.stringify. The canonical key order in
  // buildAoaiBody must reproduce each byte-for-byte so LOOM_AOAI_CLIENT_V2=on is
  // indistinguishable from off on the wire.
  it('aoaiCompleteText — with temperature', () => {
    const legacy = JSON.stringify({ messages: MSGS, temperature: 0.2, max_completion_tokens: 2048 });
    const built = JSON.stringify(buildAoaiBody({ messages: MSGS, temperature: 0.2, maxCompletionTokens: 2048 }));
    expect(built).toBe(legacy);
  });

  it('aoaiCompleteText — retry without temperature', () => {
    const legacy = JSON.stringify({ messages: MSGS, max_completion_tokens: 2048 });
    const built = JSON.stringify(buildAoaiBody({ messages: MSGS, maxCompletionTokens: 2048 }));
    expect(built).toBe(legacy);
  });

  it('aoaiCompleteJson — with temperature', () => {
    const legacy = JSON.stringify({
      messages: MSGS,
      temperature: 0.1,
      max_completion_tokens: 4096,
      response_format: { type: 'json_object' },
    });
    const built = JSON.stringify(
      buildAoaiBody({ messages: MSGS, temperature: 0.1, maxCompletionTokens: 4096, responseFormat: 'json_object' }),
    );
    expect(built).toBe(legacy);
  });

  it('aoaiCompleteJson — retry without temperature', () => {
    const legacy = JSON.stringify({
      messages: MSGS,
      max_completion_tokens: 4096,
      response_format: { type: 'json_object' },
    });
    const built = JSON.stringify(
      buildAoaiBody({ messages: MSGS, maxCompletionTokens: 4096, responseFormat: 'json_object' }),
    );
    expect(built).toBe(legacy);
  });

  it('callAoai tool-loop — with temperature (no cap)', () => {
    const tools = [{ type: 'function', function: { name: 't', description: 'd', parameters: {} } }];
    const base = { messages: MSGS, tools, tool_choice: 'auto' };
    const legacy = JSON.stringify({ ...base, temperature: 0.2 });
    const built = JSON.stringify(buildAoaiBody({ messages: MSGS, tools, toolChoice: 'auto', temperature: 0.2 }));
    expect(built).toBe(legacy);
  });

  it('callAoai tool-loop — retry without temperature (no cap)', () => {
    const tools = [{ type: 'function', function: { name: 't', description: 'd', parameters: {} } }];
    const base = { messages: MSGS, tools, tool_choice: 'auto' };
    const legacy = JSON.stringify(base);
    const built = JSON.stringify(buildAoaiBody({ messages: MSGS, tools, toolChoice: 'auto' }));
    expect(built).toBe(legacy);
  });
});
