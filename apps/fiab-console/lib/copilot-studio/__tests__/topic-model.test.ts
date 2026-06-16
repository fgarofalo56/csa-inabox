/**
 * topic-model — round-trip coverage for the structured Copilot Studio topic
 * editor (audit H4). The structured editor must serialize to / parse from the
 * AdaptiveDialog YAML stored in Dataverse without losing content; unknown
 * constructs must be preserved as `raw` steps.
 */
import { describe, it, expect } from 'vitest';
import {
  parseTopicFlow, serializeTopicFlow, isStructuredRepresentable,
  type TopicFlow,
} from '../topic-model';

describe('topic-model parse', () => {
  it('parses a simple SendActivity into a message step', () => {
    const yaml = 'kind: AdaptiveDialog\nbeginDialog:\n  - kind: SendActivity\n    activity: "Hello there"';
    const flow = parseTopicFlow(yaml, ['hi', 'hello']);
    expect(flow.steps[0]).toEqual({ kind: 'trigger', phrases: ['hi', 'hello'] });
    const msg = flow.steps.find((s) => s.kind === 'message') as any;
    expect(msg.text).toBe('Hello there');
  });

  it('parses a Question step with variable + entity', () => {
    const yaml = [
      'kind: AdaptiveDialog',
      'beginDialog:',
      '  - kind: Question',
      '    prompt: "What is your name?"',
      '    variable: Topic.UserName',
      '    entity: string',
    ].join('\n');
    const flow = parseTopicFlow(yaml);
    const q = flow.steps.find((s) => s.kind === 'question') as any;
    expect(q).toMatchObject({ prompt: 'What is your name?', variable: 'Topic.UserName', entity: 'string' });
  });

  it('parses an InvokeFlowAction into an action step', () => {
    const yaml = [
      'kind: AdaptiveDialog',
      'beginDialog:',
      '  - kind: InvokeFlowAction',
      '    name: "Create ticket"',
      '    flowId: "11111111-2222-3333-4444-555555555555"',
    ].join('\n');
    const flow = parseTopicFlow(yaml);
    const a = flow.steps.find((s) => s.kind === 'action') as any;
    expect(a).toMatchObject({ actionType: 'flow', name: 'Create ticket', ref: '11111111-2222-3333-4444-555555555555' });
  });

  it('preserves unknown AdaptiveDialog kinds as raw steps', () => {
    const yaml = [
      'kind: AdaptiveDialog',
      'beginDialog:',
      '  - kind: SomeFutureAction',
      '    weirdProp: 123',
    ].join('\n');
    const flow = parseTopicFlow(yaml);
    expect(flow.steps.some((s) => s.kind === 'raw')).toBe(true);
    expect(isStructuredRepresentable(yaml)).toBe(false);
  });
});

describe('topic-model round-trip', () => {
  it('serialize→parse preserves a multi-step flow', () => {
    const flow: TopicFlow = {
      steps: [
        { kind: 'trigger', phrases: ['order status'] },
        { kind: 'message', text: 'Let me check that.' },
        { kind: 'question', prompt: 'Order number?', variable: 'Topic.Order', entity: 'string' },
        { kind: 'action', name: 'Lookup order', actionType: 'flow', ref: 'flow-123' },
      ],
    };
    const yaml = serializeTopicFlow(flow);
    const back = parseTopicFlow(yaml, ['order status']);
    // trigger + 3 actions
    expect(back.steps.filter((s) => s.kind !== 'trigger')).toHaveLength(3);
    const msg = back.steps.find((s) => s.kind === 'message') as any;
    const q = back.steps.find((s) => s.kind === 'question') as any;
    const act = back.steps.find((s) => s.kind === 'action') as any;
    expect(msg.text).toBe('Let me check that.');
    expect(q).toMatchObject({ prompt: 'Order number?', variable: 'Topic.Order' });
    expect(act).toMatchObject({ name: 'Lookup order', actionType: 'flow', ref: 'flow-123' });
    expect(yaml.startsWith('kind: AdaptiveDialog')).toBe(true);
  });

  it('round-trips a condition group with branches', () => {
    const flow: TopicFlow = {
      steps: [
        {
          kind: 'condition',
          branches: [
            { expression: 'Topic.Choice = "Yes"', steps: [{ kind: 'message', text: 'Great!' }] },
            { expression: 'Topic.Choice = "No"', steps: [{ kind: 'message', text: 'No problem.' }] },
          ],
          elseSteps: [{ kind: 'message', text: 'Please choose.' }],
        },
      ],
    };
    const yaml = serializeTopicFlow(flow);
    const back = parseTopicFlow(yaml);
    const cond = back.steps.find((s) => s.kind === 'condition') as any;
    expect(cond).toBeTruthy();
    expect(cond.branches).toHaveLength(2);
    expect(cond.branches[0].expression).toBe('Topic.Choice = "Yes"');
    expect((cond.branches[0].steps[0] as any).text).toBe('Great!');
  });

  it('an empty flow serializes to a valid AdaptiveDialog skeleton', () => {
    const yaml = serializeTopicFlow({ steps: [] });
    expect(yaml).toContain('kind: AdaptiveDialog');
    expect(yaml).toContain('beginDialog:');
  });
});
