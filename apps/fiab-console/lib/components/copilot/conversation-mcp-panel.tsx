'use client';

/**
 * ConversationMcpPanel — the per-CONVERSATION MCP visibility surface (CTS-09).
 *
 * Complements the per-call "via <server>" badge in TurnDetailPanel with the
 * "which MCP servers + tools were live this conversation" view the audit found
 * missing. A slim, collapsible strip (docked above the context meter) that lists
 * every MCP server that backed a tool call this conversation, its total call
 * count + success tally, and — when expanded — the per-tool breakdown.
 *
 * Read-only, Fluent v9 + Loom tokens. Renders nothing when no MCP-backed call
 * has happened yet (native-only conversations stay clean).
 */

import { useState } from 'react';
import { Badge, Caption1, makeStyles, tokens } from '@fluentui/react-components';
import {
  PlugConnected16Regular, ChevronDown16Regular, ChevronUp16Regular,
  CheckmarkCircle12Regular, ErrorCircle12Regular,
} from '@fluentui/react-icons';
import { deriveConnectedMcp } from './connected-mcp';
import type { Turn } from './types';

const useStyles = makeStyles({
  root: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
  },
  header: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    cursor: 'pointer', width: '100%', background: 'none', border: 'none',
    padding: `${tokens.spacingVerticalXXS} 0`, textAlign: 'left',
    color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase200,
    ':focus-visible': { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '2px' },
  },
  headerLabel: { fontWeight: tokens.fontWeightSemibold },
  headerMeta: { color: tokens.colorNeutralForeground3, marginLeft: 'auto', display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalXXS },
  rows: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, marginTop: tokens.spacingVerticalS },
  server: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  serverHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  serverName: { fontWeight: tokens.fontWeightSemibold },
  count: { color: tokens.colorNeutralForeground3, marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' },
  tool: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    marginLeft: '20px', fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3,
  },
  ok: { color: tokens.colorPaletteGreenForeground1, flexShrink: 0 },
  bad: { color: tokens.colorPaletteRedForeground1, flexShrink: 0 },
});

export interface ConversationMcpPanelProps {
  turns: readonly Turn[];
}

export function ConversationMcpPanel({ turns }: ConversationMcpPanelProps) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const { servers, totalCalls } = deriveConnectedMcp(turns);

  // Native-only conversations render nothing — this is the MCP surface.
  if (servers.length === 0) return null;

  return (
    <div className={s.root} data-testid="copilot-mcp-panel">
      <button
        className={s.header}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? 'Collapse MCP servers' : 'Expand MCP servers'}
      >
        <PlugConnected16Regular aria-hidden style={{ color: tokens.colorBrandForeground1 }} />
        <span className={s.headerLabel}>
          {servers.length} MCP server{servers.length === 1 ? '' : 's'} this conversation
        </span>
        <span className={s.headerMeta}>
          <span>{totalCalls} call{totalCalls === 1 ? '' : 's'}</span>
          {open ? <ChevronUp16Regular aria-hidden /> : <ChevronDown16Regular aria-hidden />}
        </span>
      </button>

      {!open && (
        <div className={s.chips}>
          {servers.map((sv) => (
            <Badge key={sv.name} size="small" appearance="outline" color="informative" icon={<PlugConnected16Regular />}>
              {sv.name} · {sv.calls}
            </Badge>
          ))}
        </div>
      )}

      {open && (
        <div className={s.rows}>
          {servers.map((sv) => (
            <div key={sv.name} className={s.server}>
              <div className={s.serverHead}>
                <PlugConnected16Regular aria-hidden style={{ color: tokens.colorBrandForeground1, flexShrink: 0 }} />
                <span className={s.serverName}>{sv.name}</span>
                {sv.failed > 0 && (
                  <Badge size="extra-small" appearance="tint" color="danger">{sv.failed} failed</Badge>
                )}
                <span className={s.count}>{sv.calls} call{sv.calls === 1 ? '' : 's'} · {sv.tools.length} tool{sv.tools.length === 1 ? '' : 's'}</span>
              </div>
              {sv.tools.map((t) => (
                <div key={t.name} className={s.tool}>
                  {t.failed > 0
                    ? <ErrorCircle12Regular className={s.bad} aria-label="Had a failure" />
                    : <CheckmarkCircle12Regular className={s.ok} aria-label="Succeeded" />}
                  <span>{t.name}</span>
                  <span className={s.count}>{t.calls}×</span>
                </div>
              ))}
            </div>
          ))}
          <Caption1 style={{ color: tokens.colorNeutralForeground4 }}>
            MCP tool calls are also shown per-message under each answer&apos;s Details.
          </Caption1>
        </div>
      )}
    </div>
  );
}
