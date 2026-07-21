'use client';

/**
 * AgentFlowPublishPanel — WS-5.1 "Publish as MCP / API" surface for an agent flow.
 *
 * Publishing exposes the whole flow as an MCP server (`ask_<flow>` tool) at
 * `/api/items/agent-flow/[id]/mcp` — the SAME JSON-RPC-over-HTTPS endpoint is the
 * flow's callable API. Real backend: POST/DELETE
 * `/api/items/agent-flow/[id]/publish-mcp` flips the persisted publish flag; the
 * MCP route then runs the flow for real (grounded data + ontology + MCP tools +
 * handoffs + guardrails). Azure-native, sovereign — no Microsoft Fabric.
 */
import { useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Button, Badge, Spinner, Field,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  PlugConnectedRegular, CopyRegular, CheckmarkCircleRegular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  icon: { color: tokens.colorBrandForeground1, display: 'inline-flex', fontSize: tokens.fontSizeBase400 },
  code: {
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalS,
  },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
});

export interface AgentFlowPublishState {
  mcpPublished?: boolean;
  mcpToolName?: string;
  mcpPublishedAt?: string;
}

export interface AgentFlowPublishPanelProps {
  id: string;
  origin: string;
  published: boolean;
  toolName?: string;
  publishedAt?: string;
  canPublish: boolean;
  /** Called after a successful publish/unpublish so the host refreshes state. */
  onChange: (next: { published: boolean; toolName?: string; publishedAt?: string }) => void;
}

export function AgentFlowPublishPanel(props: AgentFlowPublishPanelProps) {
  const s = useStyles();
  const { id, origin, published, toolName, publishedAt, canPublish, onChange } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const endpoint = `${origin.replace(/\/+$/, '')}/api/items/agent-flow/${encodeURIComponent(id)}/mcp`;
  const clientConfig = JSON.stringify({
    mcpServers: { [toolName || 'ask_flow']: { type: 'http', url: endpoint, headers: { Authorization: 'Bearer loom_pat_<your-token>' } } },
  }, null, 2);

  const doPublish = async () => {
    setBusy(true); setError(null);
    try {
      const r = await clientFetch(`/api/items/agent-flow/${encodeURIComponent(id)}/publish-mcp`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok || !j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      onChange({ published: true, toolName: j.toolName, publishedAt: j.publishedAt });
    } catch (e: any) { setError(e?.message || String(e)); } finally { setBusy(false); }
  };
  const doUnpublish = async () => {
    setBusy(true); setError(null);
    try {
      const r = await clientFetch(`/api/items/agent-flow/${encodeURIComponent(id)}/publish-mcp`, { method: 'DELETE' });
      const j = await r.json();
      if (!r.ok || !j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      onChange({ published: false });
    } catch (e: any) { setError(e?.message || String(e)); } finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(clientConfig); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  return (
    <div className={s.root}>
      <div className={s.head}>
        <span className={s.icon}><PlugConnectedRegular aria-hidden /></span>
        <Subtitle2>Publish as MCP / API</Subtitle2>
        {published
          ? <Badge appearance="tint" color="success" icon={<CheckmarkCircleRegular />}>Published</Badge>
          : <Badge appearance="tint" color="informative">Not published</Badge>}
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        Expose this whole flow as an MCP server — one <code>{toolName || 'ask_&lt;flow&gt;'}</code> tool that runs the flow
        (grounded data + ontology objects + real MCP tools + agent handoffs + guardrails) for any MCP client. The same
        endpoint is a JSON-RPC-over-HTTPS API. Azure-native — no Microsoft Fabric.
      </Caption1>

      {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Publish failed</MessageBarTitle>{error}</MessageBarBody></MessageBar>}

      {!canPublish && !published && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Nothing to publish yet</MessageBarTitle>
            Add orchestrator instructions and at least one tool or connected agent, then save, before publishing.
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={s.row}>
        {!published ? (
          <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <PlugConnectedRegular />} disabled={busy || !canPublish} onClick={doPublish}>
            {busy ? 'Publishing…' : 'Publish as MCP'}
          </Button>
        ) : (
          <Button appearance="secondary" disabled={busy} onClick={doUnpublish}>{busy ? 'Working…' : 'Unpublish'}</Button>
        )}
      </div>

      {published && (
        <>
          <Field label="MCP endpoint (also the JSON-RPC API URL)">
            <div className={s.code}>{endpoint}</div>
          </Field>
          <Field label="Tool name"><Body1><code>{toolName}</code></Body1></Field>
          {publishedAt && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Published {new Date(publishedAt).toLocaleString()}</Caption1>}
          <Field label="MCP client config (paste into Claude Desktop / Agent 365 / Foundry)">
            <div className={s.code}>{clientConfig}</div>
          </Field>
          <div className={s.row}>
            <Button size="small" appearance="subtle" icon={copied ? <CheckmarkCircleRegular /> : <CopyRegular />} onClick={copy}>
              {copied ? 'Copied' : 'Copy client config'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
