'use client';

/**
 * CopilotTopicCanvas — structured topic authoring surface (H4).
 *
 * Replaces the raw AdaptiveDialog-YAML textarea with a typed step list:
 * Trigger phrases plus a sequence of Message / Question / Condition / Action
 * nodes, each with its own Fluent v9 form. The structured model serializes to
 * and from the AdaptiveDialog YAML stored in Dataverse (see
 * lib/copilot-studio/topic-model.ts), and a "Code view" toggle exposes the
 * underlying YAML. Default is the structured editor per ui-parity.md and
 * loom_no_freeform_config — the YAML textarea is no longer the primary surface.
 *
 * The component is controlled: it takes the flowYaml + triggerPhrases the panel
 * already manages and reports changes back, so persistence stays unchanged.
 */

import { useCallback, useMemo, useState, type ReactElement } from 'react';
import {
  Body1, Caption1, Subtitle2, Button, Input, Textarea, Dropdown, Option, Field, Badge,
  Switch, MessageBar, MessageBarBody, MessageBarTitle, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, ArrowUp16Regular, ArrowDown16Regular,
  Chat20Regular, QuestionCircle20Regular, BranchFork20Regular, Flow20Regular, Code20Regular,
} from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import {
  parseTopicFlow, serializeTopicFlow, isStructuredRepresentable, newStepId,
  type TopicStep, type ConditionStep, type TopicFlow,
} from '@/lib/copilot-studio/topic-model';

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 },
  toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  steps: { display: 'flex', flexDirection: 'column', gap: 10 },
  node: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6,
    padding: 12, display: 'flex', flexDirection: 'column', gap: 8,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  nodeHead: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' },
  nodeHeadLeft: { display: 'flex', alignItems: 'center', gap: 8 },
  nodeActions: { display: 'flex', gap: 4 },
  addRow: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  branch: {
    border: `1px dashed ${tokens.colorNeutralStroke2}`, borderRadius: 4,
    padding: 8, display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4,
  },
  phraseRow: { display: 'flex', gap: 6, alignItems: 'center' },
});

// Each step carries a client id for stable React keys; kept out of the model.
type IdStep = TopicStep & { _id: string };

function withIds(flow: TopicFlow): IdStep[] {
  return flow.steps
    .filter((s) => s.kind !== 'trigger')
    .map((s) => ({ ...s, _id: newStepId() } as IdStep));
}

function stripIds(steps: IdStep[], phrases: string[]): TopicFlow {
  const out: TopicStep[] = [];
  if (phrases.length) out.push({ kind: 'trigger', phrases });
  for (const s of steps) {
    const { _id, ...rest } = s as any;
    out.push(rest as TopicStep);
  }
  return { steps: out };
}

const NODE_META: Record<string, { label: string; icon: ReactElement }> = {
  message: { label: 'Message', icon: <Chat20Regular /> },
  question: { label: 'Question', icon: <QuestionCircle20Regular /> },
  condition: { label: 'Condition', icon: <BranchFork20Regular /> },
  action: { label: 'Action', icon: <Flow20Regular /> },
  raw: { label: 'Advanced (YAML)', icon: <Code20Regular /> },
};

export interface CopilotTopicCanvasProps {
  flowYaml: string;
  triggerPhrases: string[];
  onChange: (next: { flowYaml: string; triggerPhrases: string[] }) => void;
  ariaLabel?: string;
}

export function CopilotTopicCanvas({ flowYaml, triggerPhrases, onChange, ariaLabel }: CopilotTopicCanvasProps) {
  const s = useStyles();
  const [codeView, setCodeView] = useState(false);

  // Parse once per incoming yaml/phrases for the structured view. We keep the
  // step ids stable within a render generation by deriving from the yaml.
  const steps = useMemo<IdStep[]>(() => withIds(parseTopicFlow(flowYaml, triggerPhrases)), [flowYaml, triggerPhrases]);
  const representable = useMemo(() => isStructuredRepresentable(flowYaml, triggerPhrases), [flowYaml, triggerPhrases]);

  const emit = useCallback((nextSteps: IdStep[], nextPhrases: string[]) => {
    const flow = stripIds(nextSteps, nextPhrases);
    onChange({ flowYaml: serializeTopicFlow(flow), triggerPhrases: nextPhrases });
  }, [onChange]);

  const updateStep = useCallback((idx: number, patch: Partial<TopicStep>) => {
    const next = steps.map((st, i) => (i === idx ? ({ ...st, ...patch } as IdStep) : st));
    emit(next, triggerPhrases);
  }, [steps, triggerPhrases, emit]);

  const removeStep = useCallback((idx: number) => {
    emit(steps.filter((_, i) => i !== idx), triggerPhrases);
  }, [steps, triggerPhrases, emit]);

  const moveStep = useCallback((idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[idx], next[j]] = [next[j], next[idx]];
    emit(next, triggerPhrases);
  }, [steps, triggerPhrases, emit]);

  const addStep = useCallback((kind: TopicStep['kind']) => {
    let fresh: TopicStep;
    switch (kind) {
      case 'message': fresh = { kind: 'message', text: '' }; break;
      case 'question': fresh = { kind: 'question', prompt: '', variable: 'Topic.Answer', entity: 'string' }; break;
      case 'condition': fresh = { kind: 'condition', branches: [{ expression: '', steps: [] }], elseSteps: [] }; break;
      case 'action': fresh = { kind: 'action', name: '', actionType: 'flow', ref: '' }; break;
      default: fresh = { kind: 'message', text: '' };
    }
    emit([...steps, { ...fresh, _id: newStepId() } as IdStep], triggerPhrases);
  }, [steps, triggerPhrases, emit]);

  // ---- trigger phrases ----
  const setPhrase = useCallback((i: number, v: string) => {
    const next = triggerPhrases.map((p, k) => (k === i ? v : p));
    emit(steps, next);
  }, [triggerPhrases, steps, emit]);
  const addPhrase = useCallback(() => emit(steps, [...triggerPhrases, '']), [triggerPhrases, steps, emit]);
  const removePhrase = useCallback((i: number) => emit(steps, triggerPhrases.filter((_, k) => k !== i)), [triggerPhrases, steps, emit]);

  if (codeView) {
    return (
      <div className={s.wrap}>
        <div className={s.toolbar}>
          <Switch checked label="Code view (AdaptiveDialog YAML)" onChange={() => setCodeView(false)} />
          <Caption1>Switch off to return to the structured editor.</Caption1>
        </div>
        <MonacoTextarea
          value={flowYaml}
          onChange={(v) => onChange({ flowYaml: v, triggerPhrases })}
          language="yaml"
          height={320}
          minHeight={240}
          ariaLabel={ariaLabel || 'Topic flow YAML'}
        />
      </div>
    );
  }

  return (
    <div className={s.wrap} aria-label={ariaLabel || 'Topic canvas'}>
      <div className={s.toolbar}>
        <Switch checked={false} label="Code view (AdaptiveDialog YAML)" onChange={() => setCodeView(true)} />
      </div>

      {!representable && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Advanced flow detected</MessageBarTitle>
            This topic contains AdaptiveDialog constructs the structured editor doesn&apos;t model; those are
            shown as read-only &quot;Advanced (YAML)&quot; nodes and preserved on save. Use Code view to edit them.
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Trigger */}
      <div className={s.node}>
        <div className={s.nodeHead}>
          <div className={s.nodeHeadLeft}>
            <Badge appearance="filled" color="brand">Trigger</Badge>
            <Body1><strong>Phrases that start this topic</strong></Body1>
          </div>
        </div>
        {triggerPhrases.length === 0 && <Caption1>No trigger phrases yet — add at least one.</Caption1>}
        {triggerPhrases.map((p, i) => (
          <div key={i} className={s.phraseRow}>
            <Input style={{ flex: 1 }} value={p} placeholder="e.g. reset my password" onChange={(_, d) => setPhrase(i, d.value)} />
            <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => removePhrase(i)} aria-label="Remove phrase" />
          </div>
        ))}
        <div><Button size="small" appearance="outline" icon={<Add20Regular />} onClick={addPhrase}>Add phrase</Button></div>
      </div>

      {/* Steps */}
      <Subtitle2>Conversation steps</Subtitle2>
      <div className={s.steps}>
        {steps.length === 0 && <Caption1>No steps yet — add a Message, Question, Condition, or Action below.</Caption1>}
        {steps.map((st, idx) => (
          <div key={st._id} className={s.node}>
            <div className={s.nodeHead}>
              <div className={s.nodeHeadLeft}>
                {NODE_META[st.kind]?.icon}
                <Body1><strong>{NODE_META[st.kind]?.label || st.kind}</strong></Body1>
              </div>
              <div className={s.nodeActions}>
                <Tooltip content="Move up" relationship="label">
                  <Button size="small" appearance="subtle" icon={<ArrowUp16Regular />} disabled={idx === 0} onClick={() => moveStep(idx, -1)} />
                </Tooltip>
                <Tooltip content="Move down" relationship="label">
                  <Button size="small" appearance="subtle" icon={<ArrowDown16Regular />} disabled={idx === steps.length - 1} onClick={() => moveStep(idx, 1)} />
                </Tooltip>
                <Tooltip content="Delete step" relationship="label">
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => removeStep(idx)} />
                </Tooltip>
              </div>
            </div>
            <StepBody step={st} onPatch={(patch) => updateStep(idx, patch)} />
          </div>
        ))}
      </div>

      <div className={s.addRow}>
        <Button size="small" appearance="outline" icon={<Chat20Regular />} onClick={() => addStep('message')}>Message</Button>
        <Button size="small" appearance="outline" icon={<QuestionCircle20Regular />} onClick={() => addStep('question')}>Question</Button>
        <Button size="small" appearance="outline" icon={<BranchFork20Regular />} onClick={() => addStep('condition')}>Condition</Button>
        <Button size="small" appearance="outline" icon={<Flow20Regular />} onClick={() => addStep('action')}>Action</Button>
      </div>
    </div>
  );
}

function StepBody({ step, onPatch }: { step: IdStep; onPatch: (patch: Partial<TopicStep>) => void }) {
  const s = useStyles();
  switch (step.kind) {
    case 'message':
      return (
        <Field label="Message text">
          <Textarea rows={2} value={step.text} placeholder="What the bot says" onChange={(_, d) => onPatch({ text: d.value } as any)} />
        </Field>
      );
    case 'question':
      return (
        <>
          <Field label="Prompt">
            <Textarea rows={2} value={step.prompt} placeholder="Question to ask the user" onChange={(_, d) => onPatch({ prompt: d.value } as any)} />
          </Field>
          <Field label="Save answer to variable" hint="e.g. Topic.UserName">
            <Input value={step.variable} onChange={(_, d) => onPatch({ variable: d.value } as any)} />
          </Field>
          <Field label="Answer type">
            <Dropdown
              value={step.entity || 'string'}
              selectedOptions={[step.entity || 'string']}
              onOptionSelect={(_, d) => d.optionValue && onPatch({ entity: d.optionValue } as any)}
            >
              <Option value="string">Text</Option>
              <Option value="number">Number</Option>
              <Option value="boolean">Boolean (yes/no)</Option>
              <Option value="datetime">Date/time</Option>
              <Option value="email">Email</Option>
            </Dropdown>
          </Field>
        </>
      );
    case 'action':
      return (
        <>
          <Field label="Action name" required>
            <Input value={step.name} onChange={(_, d) => onPatch({ name: d.value } as any)} />
          </Field>
          <Field label="Invoke">
            <Dropdown
              value={step.actionType === 'flow' ? 'Power Automate flow' : 'Connector'}
              selectedOptions={[step.actionType]}
              onOptionSelect={(_, d) => d.optionValue && onPatch({ actionType: d.optionValue } as any)}
            >
              <Option value="flow">Power Automate flow</Option>
              <Option value="connector">Connector</Option>
            </Dropdown>
          </Field>
          <Field label={step.actionType === 'flow' ? 'Flow id' : 'Connector id'} hint="GUID / resource id of the target">
            <Input value={step.ref} onChange={(_, d) => onPatch({ ref: d.value } as any)} />
          </Field>
        </>
      );
    case 'condition':
      return <ConditionBody step={step} onPatch={onPatch} />;
    case 'raw':
      return (
        <Field label="Advanced AdaptiveDialog (read-only here — edit in Code view)">
          <MonacoTextarea value={step.yaml} onChange={() => {}} readOnly language="yaml" height={140} ariaLabel="Advanced node YAML" />
        </Field>
      );
    default:
      return null;
  }
}

function ConditionBody({ step, onPatch }: { step: ConditionStep & { _id: string }; onPatch: (patch: Partial<TopicStep>) => void }) {
  const s = useStyles();
  const setBranchExpr = (bi: number, expr: string) => {
    const branches = step.branches.map((b, i) => (i === bi ? { ...b, expression: expr } : b));
    onPatch({ branches } as any);
  };
  const setBranchMessage = (bi: number, text: string) => {
    const branches = step.branches.map((b, i) => (
      i === bi ? { ...b, steps: [{ kind: 'message', text } as TopicStep] } : b
    ));
    onPatch({ branches } as any);
  };
  const addBranch = () => onPatch({ branches: [...step.branches, { expression: '', steps: [] }] } as any);
  const removeBranch = (bi: number) => onPatch({ branches: step.branches.filter((_, i) => i !== bi) } as any);
  const firstMessage = (b: ConditionStep['branches'][number]) =>
    (b.steps.find((x) => x.kind === 'message') as any)?.text || '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Caption1>Branch on a condition; each branch can reply with a message. Use Code view for richer branch bodies.</Caption1>
      {step.branches.map((b, bi) => (
        <div key={bi} className={s.branch}>
          <Field label={`If (branch ${bi + 1})`} hint='e.g. Topic.Choice = "Yes"'>
            <Input value={b.expression} onChange={(_, d) => setBranchExpr(bi, d.value)} />
          </Field>
          <Field label="Then say">
            <Input value={firstMessage(b)} placeholder="Reply for this branch" onChange={(_, d) => setBranchMessage(bi, d.value)} />
          </Field>
          <div><Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => removeBranch(bi)}>Remove branch</Button></div>
        </div>
      ))}
      <div><Button size="small" appearance="outline" icon={<Add20Regular />} onClick={addBranch}>Add branch</Button></div>
    </div>
  );
}

export default CopilotTopicCanvas;
