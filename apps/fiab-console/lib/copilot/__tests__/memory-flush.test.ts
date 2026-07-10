import { describe, it, expect, afterEach } from 'vitest';
import {
  splitConversation,
  isCopilotMemoryEnabled,
  copilotMemoryAgentId,
  flushWindow,
} from '../memory-flush';

describe('memory-flush / splitConversation', () => {
  it('folds user + assistant turns into question/answer', () => {
    const out = splitConversation(
      [
        { role: 'user', content: 'I run the FedCiv data platform' },
        { role: 'assistant', content: 'Noted your role.' },
        { role: 'user', content: 'Use synapse by default' },
      ],
      20,
    );
    expect(out).not.toBeNull();
    expect(out!.question).toContain('FedCiv');
    expect(out!.question).toContain('synapse');
    expect(out!.answer).toContain('Noted');
  });

  it('returns null on empty / junk', () => {
    expect(splitConversation([], 20)).toBeNull();
    expect(splitConversation(null, 20)).toBeNull();
    expect(splitConversation([{ role: 'user', content: '   ' }], 20)).toBeNull();
  });

  it('supplies a placeholder for a one-sided conversation', () => {
    const out = splitConversation([{ role: 'assistant', content: 'hello' }], 20);
    expect(out!.question).toMatch(/no user messages/i);
    expect(out!.answer).toBe('hello');
  });

  it('keeps only the last N messages', () => {
    const msgs = Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    const out = splitConversation(msgs, 5);
    expect(out!.question).toContain('m39');
    expect(out!.question).not.toContain('m10');
  });
});

describe('memory-flush / config', () => {
  afterEach(() => {
    delete process.env.LOOM_COPILOT_MEMORY;
    delete process.env.LOOM_COPILOT_MEMORY_AGENT_ID;
    delete process.env.LOOM_COPILOT_MEMORY_FLUSH_N;
  });

  it('kill-switch defaults ON, honors opt-out', () => {
    expect(isCopilotMemoryEnabled()).toBe(true);
    process.env.LOOM_COPILOT_MEMORY = 'off';
    expect(isCopilotMemoryEnabled()).toBe(false);
  });

  it('agent id defaults to loom-copilot', () => {
    expect(copilotMemoryAgentId()).toBe('loom-copilot');
    process.env.LOOM_COPILOT_MEMORY_AGENT_ID = 'custom';
    expect(copilotMemoryAgentId()).toBe('custom');
  });

  it('flush window defaults to 20 and clamps', () => {
    expect(flushWindow()).toBe(20);
    process.env.LOOM_COPILOT_MEMORY_FLUSH_N = '500';
    expect(flushWindow()).toBe(100);
    process.env.LOOM_COPILOT_MEMORY_FLUSH_N = 'junk';
    expect(flushWindow()).toBe(20);
  });
});
