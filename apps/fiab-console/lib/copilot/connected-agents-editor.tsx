'use client';

/**
 * ConnectedAgentsEditor — typed multi-agent composition surface (AIF-4).
 *
 * A point-and-click picker of EXISTING Loom agent items (data-agent /
 * operations-agent) as sub-agents of an orchestrator, each with a typed role +
 * delegation description. Persisted as structured `state.subAgents[]`; consumed
 * by the Loom orchestrator (default) and the Foundry connected-agent publish
 * (opt-in). No freeform config.
 */

import { useCallback, useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  Body1, Caption1, Badge, Button, Input, Field, Dropdown, Option,
  MessageBar, MessageBarBody,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Bot20Regular, Add20Regular, Delete16Regular, Warning16Regular,
} from '@fluentui/react-icons';
import {
  SUB_AGENT_ITEM_TYPES, newSubAgentRef, isSubAgentConfigured,
  type SubAgentRef, type SubAgentItemType,
} from './connected-agents';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingVerticalM,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    background: tokens.colorNeutralBackground1,
  },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  grow: { flex: 1, minWidth: 0 },
  icon: { color: tokens.colorBrandForeground1, display: 'inline-flex' },
  grid2: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr)', gap: tokens.spacingHorizontalM },
  addBar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' },
});

interface AgentOption { id: string; name: string; itemType: SubAgentItemType }

const TYPE_LABEL: Record<SubAgentItemType, string> = {
  'data-agent': 'Data agent',
  'operations-agent': 'Operations agent',
};

export interface ConnectedAgentsEditorProps {
  subAgents: SubAgentRef[];
  onChange: (next: SubAgentRef[]) => void;
  /** The orchestrator's own item id — excluded from the picker (no self-reference). */
  selfId: string;
  disabled?: boolean;
  compact?: boolean;
}

export function ConnectedAgentsEditor({ subAgents, onChange, selfId, disabled, compact }: ConnectedAgentsEditorProps) {
  const s = useStyles();
  const [opts, setOpts] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [pickId, setPickId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await clientFetch(`/api/items/by-type?types=${encodeURIComponent(SUB_AGENT_ITEM_TYPES.join(','))}`);
      const j = await r.json();
      const items: AgentOption[] = (j.items || [])
        .map((it: any) => ({
          id: it.id,
          name: it.displayName || it.id,
          itemType: (SUB_AGENT_ITEM_TYPES as readonly string[]).includes(it.itemType) ? it.itemType : 'data-agent',
        }))
        .filter((o: AgentOption) => o.id && o.id !== selfId);
      setOpts(items);
    } catch {
      setOpts([]);
    } finally {
      setLoading(false);
    }
  }, [selfId]);
  useEffect(() => { load(); }, [load]);

  const patch = (id: string, p: Partial<SubAgentRef>) =>
    onChange(subAgents.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const remove = (id: string) => onChange(subAgents.filter((r) => r.id !== id));
  const add = () => {
    const chosen = opts.find((o) => o.id === pickId);
    if (!chosen) return;
    if (subAgents.some((r) => r.itemId === chosen.id)) return; // no duplicate connection
    onChange([...subAgents, newSubAgentRef(chosen.id, chosen.itemType, chosen.name)]);
    setPickId('');
  };

  const available = opts.filter((o) => !subAgents.some((r) => r.itemId === o.id));

  return (
    <div className={s.root}>
      {!compact && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Connect other agents as sub-agents. This agent becomes an orchestrator: at run time it delegates to each
          sub-agent&rsquo;s real grounded run and synthesizes the result (Azure-native default). On publish, each
          connection is emitted as a Foundry Agent Service connected-agent tool.
        </Caption1>
      )}

      {subAgents.map((r) => {
        const configured = isSubAgentConfigured(r);
        return (
          <div key={r.id} className={s.card}>
            <div className={s.head}>
              <span className={s.icon}><Bot20Regular /></span>
              <div className={s.grow}>
                <Body1 style={{ fontWeight: tokens.fontWeightSemibold }}>{r.name}</Body1>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{TYPE_LABEL[r.itemType]}</Caption1>
              </div>
              {!configured && <Badge appearance="tint" color="warning" icon={<Warning16Regular />}>Unbound</Badge>}
              <Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={disabled}
                aria-label={`Remove sub-agent ${r.name}`} onClick={() => remove(r.id)} />
            </div>
            <div className={s.grid2}>
              <Field label="Role" hint="What this agent is to the orchestrator.">
                <Input disabled={disabled} value={r.role || ''} placeholder="finance analyst"
                  onChange={(_, d) => patch(r.id, { role: d.value })} />
              </Field>
              <Field label="When to delegate" hint="Guides the orchestrator on when to call this agent.">
                <Input disabled={disabled} value={r.description || ''} placeholder="Questions about revenue, margin, bookings by region."
                  onChange={(_, d) => patch(r.id, { description: d.value })} />
              </Field>
            </div>
          </div>
        );
      })}

      {opts.length === 0 && !loading && (
        <MessageBar intent="info">
          <MessageBarBody>No other agents in this workspace yet. Create a data-agent or operations-agent to connect it here.</MessageBarBody>
        </MessageBar>
      )}

      <div className={s.addBar}>
        <Field label="Connect an agent" hint={loading ? 'Loading agents…' : undefined}>
          <Dropdown
            disabled={disabled || available.length === 0}
            value={available.find((o) => o.id === pickId)?.name || ''}
            selectedOptions={pickId ? [pickId] : []}
            placeholder={available.length ? 'Select an agent…' : 'No agents available'}
            onOptionSelect={(_, d) => d.optionValue && setPickId(d.optionValue)}
            style={{ minWidth: 260 }}
          >
            {available.map((o) => <Option key={o.id} value={o.id} text={o.name}>{o.name} · {TYPE_LABEL[o.itemType]}</Option>)}
          </Dropdown>
        </Field>
        <Button appearance="primary" icon={<Add20Regular />} disabled={disabled || !pickId} onClick={add}>Connect</Button>
      </div>
    </div>
  );
}
