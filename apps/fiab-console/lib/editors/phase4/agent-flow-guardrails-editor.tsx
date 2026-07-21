'use client';

/**
 * FlowGuardrailsEditor — WS-5.1 inline guardrails/evals config for an agent flow.
 *
 * Rendered in the AgentFlowCanvas inspector when the orchestrator agent node is
 * selected. Every control edits the structured `FlowGuardrails` the flow persists
 * to `state.guardrails`; the run route enforces it for real on every turn
 * (redact PII / blocked terms / require grounding / length cap) and records the
 * selected eval suites on each run. No freeform config (loom_no_freeform_config):
 * typed switches, a tag list, a number field, and an eval checklist.
 */
import { useState } from 'react';
import {
  Subtitle2, Caption1, Switch, Input, Field, Button, Tag, TagGroup, Checkbox,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add20Regular, ShieldCheckmark20Regular } from '@fluentui/react-icons';
import {
  FLOW_EVALS, normalizeGuardrails, activeGuardrailCount, type FlowGuardrails,
} from '@/lib/copilot/agent-flow-guardrails';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  icon: { color: tokens.colorBrandForeground1, display: 'inline-flex' },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  chips: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap', minWidth: 0 },
  evals: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
});

export interface FlowGuardrailsEditorProps {
  guardrails: FlowGuardrails;
  onChange: (next: FlowGuardrails) => void;
  disabled?: boolean;
}

export function FlowGuardrailsEditor({ guardrails, onChange, disabled }: FlowGuardrailsEditorProps) {
  const s = useStyles();
  const g = normalizeGuardrails(guardrails);
  const [termDraft, setTermDraft] = useState('');

  const patch = (p: Partial<FlowGuardrails>) => onChange(normalizeGuardrails({ ...g, ...p }));
  const addTerm = () => {
    const v = termDraft.trim();
    if (!v) return;
    patch({ blockedTerms: Array.from(new Set([...(g.blockedTerms || []), v])) });
    setTermDraft('');
  };
  const toggleEval = (id: string, on: boolean) => {
    const set = new Set(g.evals || []);
    if (on) set.add(id); else set.delete(id);
    patch({ evals: Array.from(set) });
  };

  return (
    <div className={s.root}>
      <div className={s.head}>
        <span className={s.icon}><ShieldCheckmark20Regular /></span>
        <Subtitle2>Guardrails &amp; evals</Subtitle2>
        <Badge count={activeGuardrailCount(g)} />
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        Enforced on every run — inline, deterministic, Azure-native. Applies to this flow&apos;s answers and to the published MCP tool.
      </Caption1>

      <Switch checked={g.enabled !== false} disabled={disabled} label="Guardrails enabled"
        onChange={(_, d) => patch({ enabled: d.checked })} />
      <Switch checked={!!g.redactPii} disabled={disabled || g.enabled === false} label="Redact PII from answers (email / phone / SSN / card)"
        onChange={(_, d) => patch({ redactPii: d.checked })} />
      <Switch checked={!!g.requireGrounding} disabled={disabled || g.enabled === false} label="Require grounding (block answers with no source rows)"
        onChange={(_, d) => patch({ requireGrounding: d.checked })} />

      <Field label="Max answer length (chars)" hint="0 = no cap.">
        <Input type="number" disabled={disabled || g.enabled === false} value={String(g.maxOutputChars || 0)}
          min={0} onChange={(_, d) => patch({ maxOutputChars: Math.max(0, Number(d.value) || 0) })} style={{ maxWidth: 160 }} />
      </Field>

      <Field label="Blocked terms" hint="Deny a turn (input or output) that contains any of these.">
        <div className={s.chips}>
          <Input disabled={disabled || g.enabled === false} value={termDraft} placeholder="term"
            onChange={(_, d) => setTermDraft(d.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTerm(); } }} style={{ minWidth: 160 }} />
          <Button size="small" appearance="secondary" icon={<Add20Regular />} disabled={disabled || g.enabled === false} onClick={addTerm}>Add</Button>
        </div>
      </Field>
      {(g.blockedTerms || []).length > 0 && (
        <TagGroup onDismiss={(_, d) => patch({ blockedTerms: (g.blockedTerms || []).filter((x) => x !== d.value) })}>
          {(g.blockedTerms || []).map((t) => (
            <Tag key={t} value={t} dismissible dismissIcon={{ 'aria-label': `remove ${t}` }}>{t}</Tag>
          ))}
        </TagGroup>
      )}

      <Field label="Eval suites" hint="Recorded on every run for the flow's quality posture (Azure AI Foundry evaluators).">
        <div className={s.evals}>
          {FLOW_EVALS.map((e) => (
            <Checkbox key={e.id} disabled={disabled} label={e.label}
              checked={(g.evals || []).includes(e.id)}
              onChange={(_, d) => toggleEval(e.id, !!d.checked)} />
          ))}
        </div>
      </Field>
    </div>
  );
}

// Local Badge shim (count pill) — avoids importing the full CounterBadge surface.
function Badge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: 18, height: 18, padding: `0 ${tokens.spacingHorizontalXXS}`,
      borderRadius: tokens.borderRadiusCircular, background: tokens.colorBrandBackground2,
      color: tokens.colorBrandForeground2, fontSize: tokens.fontSizeBase100, fontWeight: tokens.fontWeightSemibold,
    }}>{count}</span>
  );
}
