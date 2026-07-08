'use client';

/**
 * AgentToolsEditor — the shared, TYPED agent-tool authoring surface (AIF-5).
 *
 * Renders an `AgentTool[]` as a stack of typed config cards + an "Add tool"
 * picker. Every binding is a Dropdown / typed field — there is NO freeform
 * comma-separated or JSON tool box (loom_no_freeform_config). Used by the
 * operations-agent editor, the data-agent editor, and the multi-agent canvas
 * node inspector (AIF-6) so all agent surfaces share one catalog.
 *
 * Backend: none of its own. It emits structured state the host persists via its
 * existing item save route; `toFoundryTool()` (agent-tool-catalog.ts) maps the
 * same state to the Foundry Agent Service tool JSON on publish.
 */

import { useCallback, useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  Body1, Caption1, Badge, Button, Input, Field, Dropdown, Option,
  MessageBar, MessageBarBody, MessageBarTitle, Tag, TagGroup,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, Table20Regular, Pulse20Regular, SearchInfo20Regular,
  Library20Regular, Code20Regular, BracesVariable20Regular, PlugConnected20Regular,
  Globe20Regular, GlobeSearch20Regular, Add20Regular, Delete16Regular, Warning16Regular,
} from '@fluentui/react-icons';
import type { JSX } from 'react';
import {
  AGENT_TOOL_KINDS, agentToolKind, newAgentTool, describeAgentTool,
  isAgentToolConfigured, mcpToolOptions,
  type AgentTool, type AgentToolKind, type AgentToolAuthKind,
} from './agent-tool-catalog';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  addBar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' },
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
  icon: { color: tokens.colorBrandForeground1, display: 'inline-flex' },
  grow: { flex: 1, minWidth: 0 },
  grid2: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: tokens.spacingHorizontalM },
  chips: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' },
});

/** Kind glyph key → Fluent element. */
export const TOOL_ICON: Record<string, JSX.Element> = {
  warehouse: <Database20Regular />,
  lakehouse: <Table20Regular />,
  kql: <Pulse20Regular />,
  search: <SearchInfo20Regular />,
  knowledge: <Library20Regular />,
  code: <Code20Regular />,
  function: <BracesVariable20Regular />,
  mcp: <PlugConnected20Regular />,
  openapi: <Globe20Regular />,
  web: <GlobeSearch20Regular />,
};

export function toolIcon(kind: AgentToolKind): JSX.Element {
  const key = agentToolKind(kind)?.icon || '';
  return TOOL_ICON[key] || <BracesVariable20Regular />;
}

const AUTH_KINDS: { value: AgentToolAuthKind; label: string }[] = [
  { value: 'anonymous', label: 'Anonymous (no auth)' },
  { value: 'api-key', label: 'API key (Key Vault secret)' },
  { value: 'bearer', label: 'Bearer token (Key Vault secret)' },
];

export interface AgentToolsEditorProps {
  tools: AgentTool[];
  onChange: (next: AgentTool[]) => void;
  disabled?: boolean;
  /** Compact single-tool inspector mode (canvas) hides the intro caption. */
  compact?: boolean;
}

export function AgentToolsEditor({ tools, onChange, disabled, compact }: AgentToolsEditorProps) {
  const s = useStyles();
  const [addKind, setAddKind] = useState<AgentToolKind>('warehouse');

  // Cache of item options per Loom item type (lazy, per bindItemType).
  const [itemOpts, setItemOpts] = useState<Record<string, { id: string; name: string }[]>>({});
  const [loadingType, setLoadingType] = useState<string | null>(null);
  const loadItems = useCallback(async (itemType: string) => {
    if (itemOpts[itemType]) return;
    setLoadingType(itemType);
    try {
      const r = await clientFetch(`/api/items/by-type?types=${encodeURIComponent(itemType)}`);
      const j = await r.json();
      const items = (j.items || []).map((it: any) => ({ id: it.id, name: it.displayName || it.id }));
      setItemOpts((prev) => ({ ...prev, [itemType]: items }));
    } catch {
      setItemOpts((prev) => ({ ...prev, [itemType]: [] }));
    } finally {
      setLoadingType(null);
    }
  }, [itemOpts]);

  // Ensure options are loaded for every bound-item tool already present.
  useEffect(() => {
    for (const t of tools) {
      const bt = agentToolKind(t.kind)?.bindItemType;
      if (bt) loadItems(bt);
    }
  }, [tools, loadItems]);

  const mcpOpts = mcpToolOptions();

  const patch = (id: string, p: Partial<AgentTool>) =>
    onChange(tools.map((t) => (t.id === id ? { ...t, ...p } : t)));
  const remove = (id: string) => onChange(tools.filter((t) => t.id !== id));
  const add = () => {
    const meta = agentToolKind(addKind);
    if (meta?.singleton && tools.some((t) => t.kind === addKind)) return;
    const bt = meta?.bindItemType;
    if (bt) loadItems(bt);
    onChange([...tools, newAgentTool(addKind)]);
  };

  // Allowed-tools chip input (mcp) — kept a typed tag list, never a JSON/CSV box.
  const [allowDraft, setAllowDraft] = useState<Record<string, string>>({});
  const addAllowed = (t: AgentTool) => {
    const v = (allowDraft[t.id] || '').trim();
    if (!v) return;
    const next = Array.from(new Set([...(t.allowedTools || []), v]));
    patch(t.id, { allowedTools: next });
    setAllowDraft((d) => ({ ...d, [t.id]: '' }));
  };

  return (
    <div className={s.root}>
      {!compact && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Attach typed tools — Loom data items, MCP servers, OpenAPI endpoints, or a code interpreter.
          Each is authored with a config form (no freeform tool text) and published as a Foundry Agent Service tool.
        </Caption1>
      )}

      {tools.map((t) => {
        const meta = agentToolKind(t.kind);
        const bt = meta?.bindItemType || null;
        const opts = bt ? (itemOpts[bt] || []) : [];
        const configured = isAgentToolConfigured(t);
        return (
          <div key={t.id} className={s.card}>
            <div className={s.head}>
              <span className={s.icon}>{toolIcon(t.kind)}</span>
              <div className={s.grow}>
                <Body1 style={{ fontWeight: tokens.fontWeightSemibold }}>{meta?.label || t.kind}</Body1>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{describeAgentTool(t)}</Caption1>
              </div>
              {!configured && (
                <Badge appearance="tint" color="warning" icon={<Warning16Regular />}>Incomplete</Badge>
              )}
              <Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={disabled}
                aria-label={`Remove ${meta?.label || t.kind} tool`} onClick={() => remove(t.id)} />
            </div>

            {/* Item-bound kinds → a typed item Dropdown. */}
            {bt && (
              <Field label={`${meta?.label} item`} hint={loadingType === bt ? 'Loading items…' : undefined}>
                <Dropdown
                  disabled={disabled}
                  value={t.itemName || ''}
                  selectedOptions={t.itemId ? [t.itemId] : []}
                  placeholder={opts.length ? 'Select an item…' : `No ${bt} items found`}
                  onOptionSelect={(_, d) => {
                    const chosen = opts.find((o) => o.id === d.optionValue);
                    patch(t.id, { itemId: d.optionValue as string, itemName: chosen?.name });
                  }}
                >
                  {opts.map((o) => <Option key={o.id} value={o.id}>{o.name}</Option>)}
                </Dropdown>
              </Field>
            )}

            {/* MCP tool. */}
            {t.kind === 'mcp' && (
              <>
                <Field label="MCP server">
                  <Dropdown
                    disabled={disabled}
                    value={t.serverLabel || ''}
                    selectedOptions={t.serverId ? [t.serverId] : []}
                    placeholder="Select an MCP server…"
                    onOptionSelect={(_, d) => {
                      const opt = mcpOpts.find((o) => o.id === d.optionValue);
                      patch(t.id, { serverId: d.optionValue as string, serverLabel: opt?.label, serverUrl: opt?.endpoint });
                    }}
                  >
                    {mcpOpts.map((o) => <Option key={o.id} value={o.id} text={o.label}>{o.label}{o.optIn ? ' (opt-in)' : ''}</Option>)}
                  </Dropdown>
                </Field>
                {t.serverId && !t.serverUrl && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>Server endpoint not wired yet</MessageBarTitle>
                      {mcpOpts.find((o) => o.id === t.serverId)?.gate || 'Provide the server endpoint via its env var before this tool is usable.'}
                    </MessageBarBody>
                  </MessageBar>
                )}
                <Field label="Allowed tools" hint="Leave empty to allow every tool the server exposes.">
                  <div className={s.chips}>
                    <Input
                      disabled={disabled}
                      value={allowDraft[t.id] || ''}
                      placeholder="tool name"
                      onChange={(_, d) => setAllowDraft((dd) => ({ ...dd, [t.id]: d.value }))}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addAllowed(t); } }}
                      style={{ minWidth: 180 }}
                    />
                    <Button size="small" appearance="secondary" icon={<Add20Regular />} disabled={disabled} onClick={() => addAllowed(t)}>Add</Button>
                  </div>
                </Field>
                {(t.allowedTools || []).length > 0 && (
                  <TagGroup onDismiss={(_, d) => patch(t.id, { allowedTools: (t.allowedTools || []).filter((x) => x !== d.value) })}>
                    {(t.allowedTools || []).map((name) => (
                      <Tag key={name} value={name} dismissible dismissIcon={{ 'aria-label': `remove ${name}` }}>{name}</Tag>
                    ))}
                  </TagGroup>
                )}
              </>
            )}

            {/* OpenAPI tool. */}
            {t.kind === 'openapi' && (
              <>
                <Field label="Spec URL" hint="HTTPS URL of the OpenAPI (Swagger) document.">
                  <Input disabled={disabled} value={t.specUrl || ''} placeholder="https://api.example.com/openapi.json"
                    onChange={(_, d) => patch(t.id, { specUrl: d.value })} />
                </Field>
                <div className={s.grid2}>
                  <Field label="Auth">
                    <Dropdown
                      disabled={disabled}
                      value={AUTH_KINDS.find((a) => a.value === (t.authKind || 'anonymous'))?.label}
                      selectedOptions={[t.authKind || 'anonymous']}
                      onOptionSelect={(_, d) => patch(t.id, { authKind: d.optionValue as AgentToolAuthKind })}
                    >
                      {AUTH_KINDS.map((a) => <Option key={a.value} value={a.value}>{a.label}</Option>)}
                    </Dropdown>
                  </Field>
                  {t.authKind && t.authKind !== 'anonymous' && (
                    <Field label="Key Vault secret name" hint="The secret NAME holding the credential (never the value).">
                      <Input disabled={disabled} value={t.authRef || ''} placeholder="my-api-key-secret"
                        onChange={(_, d) => patch(t.id, { authRef: d.value })} />
                    </Field>
                  )}
                </div>
              </>
            )}

            {/* Function tool. */}
            {t.kind === 'function' && (
              <Field label="Function name" hint="The Loom BFF tool the agent may call.">
                <Input disabled={disabled} value={t.functionName || ''} placeholder="get_open_incidents"
                  onChange={(_, d) => patch(t.id, { functionName: d.value })} />
              </Field>
            )}

            {/* Honest gov gate (bing). */}
            {meta?.gate && (
              <MessageBar intent="warning">
                <MessageBarBody><MessageBarTitle>Availability</MessageBarTitle>{meta.gate}</MessageBarBody>
              </MessageBar>
            )}
          </div>
        );
      })}

      <div className={s.addBar}>
        <Field label="Add a tool">
          <Dropdown
            disabled={disabled}
            value={agentToolKind(addKind)?.label}
            selectedOptions={[addKind]}
            onOptionSelect={(_, d) => d.optionValue && setAddKind(d.optionValue as AgentToolKind)}
            style={{ minWidth: 240 }}
          >
            {AGENT_TOOL_KINDS.map((k) => <Option key={k.kind} value={k.kind} text={k.label}>{k.label}</Option>)}
          </Dropdown>
        </Field>
        <Button appearance="primary" icon={<Add20Regular />} disabled={disabled} onClick={add}>Add tool</Button>
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{agentToolKind(addKind)?.description}</Caption1>
    </div>
  );
}
