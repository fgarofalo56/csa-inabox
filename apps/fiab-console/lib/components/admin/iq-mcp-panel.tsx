'use client';

/**
 * IqMcpPanel — admin "Fabric IQ — published MCP surface" discovery card.
 *
 * Mounted in the Copilot & Agents section of /admin/tenant-settings, directly
 * below McpServersPanel. The two are complements:
 *   • McpServersPanel = the CONSUME side — external MCP servers Loom Copilot calls.
 *   • IqMcpPanel      = the PUBLISH side — Loom's own unified Fabric IQ surface
 *     (ontology + semantic + live signals) exposed as ONE MCP endpoint that
 *     external agents (Microsoft Agent 365, Azure AI Foundry, Copilot Studio)
 *     ground on. This is Build-2026 #1 (Fabric IQ) + #6 (IQ-to-agents-via-MCP).
 *
 * This is a READ-ONLY discovery card (honors loom-no-freeform-config): it shows
 * the live endpoint URL (copy), the discovered tool catalog (live `tools/list`
 * via the GET discovery doc), the external-access state (LOOM_IQ_MCP_ENABLED),
 * the accepted auth modes, and a ready-to-paste registration snippet — so an
 * operator can register IQ in Foundry / Agent 365 without reading the bootstrap
 * doc. No config is mutated here; the gate is flipped in bicep
 * (`loomIqMcpEnabled`) / env (`LOOM_IQ_MCP_ENABLED`), surfaced as an honest gate.
 *
 * Backend: the existing `GET /api/iq/mcp` discovery document (unauthenticated,
 * no tenant data) — no new route. Per no-fabric-dependency.md every IQ layer
 * resolves to an Azure-native backend (Cosmos ontology/semantic + ADX signals)
 * with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Badge, Spinner, Divider,
  MessageBar, MessageBarBody, MessageBarTitle,
  Body1, Text, Caption1, makeStyles, tokens,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
} from '@fluentui/react-components';
import {
  ArrowClockwise20Regular, Copy16Regular, Checkmark16Regular,
  PlugConnected24Regular, Open16Regular,
} from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';

interface IqDiscoveryTool {
  name: string;
  description: string;
}

interface IqDiscoveryDoc {
  ok: boolean;
  server: string;
  protocol: string;
  protocolVersion: string;
  transport: string;
  endpoint: string;
  methods: string[];
  tools: IqDiscoveryTool[];
  externalAccessEnabled: boolean;
  auth: { session: string; bearer: string };
}

const useStyles = makeStyles({
  hint: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  bar: {
    display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center',
    flexWrap: 'wrap', marginBottom: tokens.spacingVerticalS,
  },
  spacer: { flex: 1 },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, marginTop: tokens.spacingVerticalM },
  endpointRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  mono: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    backgroundColor: tokens.colorNeutralBackground3,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    wordBreak: 'break-all',
  },
  snippet: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    backgroundColor: tokens.colorNeutralBackground3,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    whiteSpace: 'pre-wrap',
    overflowX: 'auto',
    margin: 0,
  },
  toolName: { fontFamily: tokens.fontFamilyMonospace, fontWeight: tokens.fontWeightSemibold, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  toolCol: { width: '34%', minWidth: 0 },
  toolDesc: { minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  authRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, marginTop: tokens.spacingVerticalXS },
  label: { fontWeight: tokens.fontWeightSemibold },
  emptyState: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: tokens.spacingVerticalS, paddingTop: tokens.spacingVerticalXXL, paddingBottom: tokens.spacingVerticalXXL,
    color: tokens.colorNeutralForeground3, textAlign: 'center',
  },
  emptyIcon: { fontSize: '32px', color: tokens.colorNeutralForeground4 },
});

export function IqMcpPanel() {
  const s = useStyles();
  const [doc, setDoc] = useState<IqDiscoveryDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const r = await fetch('/api/iq/mcp', { method: 'GET' });
      const j = (await r.json()) as IqDiscoveryDoc;
      if (!j?.ok) { setLoadError(`HTTP ${r.status}`); return; }
      setDoc(j);
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Absolute endpoint URL the operator pastes into Foundry / Agent 365.
  const absoluteEndpoint = useMemo(() => {
    const path = doc?.endpoint || '/api/iq/mcp';
    if (typeof window !== 'undefined' && window.location?.origin) {
      return `${window.location.origin}${path}`;
    }
    return path;
  }, [doc]);

  const registrationSnippet = useMemo(
    () =>
      [
        '# Register the CSA Loom Fabric IQ surface as an MCP tool source',
        '# (Azure AI Foundry agent / Microsoft Agent 365 connector).',
        `# Transport: HTTP JSON-RPC 2.0  •  Protocol: ${doc?.protocolVersion || '2024-11-05'}`,
        '',
        `MCP_ENDPOINT="${absoluteEndpoint}"`,
        '',
        '# External (machine) callers present a Bearer token + acting-tenant oid:',
        'curl -s "$MCP_ENDPOINT" \\',
        '  -H "Authorization: Bearer $LOOM_IQ_MCP_TOKEN" \\',
        '  -H "x-user-oid: <agent-acting-tenant-oid>" \\',
        '  -H "content-type: application/json" \\',
        `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
      ].join('\n'),
    [absoluteEndpoint, doc],
  );

  const copy = useCallback((key: string, text: string) => {
    try { void navigator.clipboard?.writeText(text); } catch { /* clipboard blocked */ }
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
  }, []);

  if (loading) {
    return (
      <Section title="Fabric IQ — published MCP surface">
        <Spinner label="Loading IQ discovery document…" />
      </Section>
    );
  }

  return (
    <Section title="Fabric IQ — published MCP surface">
      <Body1 className={s.hint}>
        Loom packages this tenant&apos;s <strong>ontology</strong>, <strong>semantic models</strong>, and{' '}
        <strong>live signals</strong> (Azure Data Explorer) into one Model Context Protocol endpoint that
        external agents — Microsoft Agent 365, Azure AI Foundry, Copilot Studio — can discover and ground on.
        Azure-native by default; no Microsoft Fabric capacity required.
      </Body1>

      {loadError && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Discovery document unavailable</MessageBarTitle>
            {loadError}
          </MessageBarBody>
        </MessageBar>
      )}

      {doc && (
        <>
          <div className={s.bar}>
            <PlugConnected24Regular style={{ color: 'var(--loom-accent-purple)' }} />
            <Text weight="semibold">{doc.server}</Text>
            <Badge appearance="tint" color="informative" size="small">
              {doc.protocol} · {doc.protocolVersion}
            </Badge>
            {doc.externalAccessEnabled ? (
              <Badge appearance="filled" color="success" size="small">external access enabled</Badge>
            ) : (
              <Badge appearance="filled" color="warning" size="small">external access off</Badge>
            )}
            <div className={s.spacer} />
            <Button icon={<ArrowClockwise20Regular />} onClick={() => void load()}>Reload</Button>
          </div>

          {!doc.externalAccessEnabled && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>External agent access is off</MessageBarTitle>
                Console users always reach IQ via their signed-in session (the catalog below is live).
                To let <strong>external</strong> agents call this endpoint with a Bearer token, set{' '}
                <code>LOOM_IQ_MCP_ENABLED=true</code> on the Console app — deploy it by setting bicep param{' '}
                <code>loomIqMcpEnabled = true</code> in{' '}
                <code>platform/fiab/bicep/modules/admin-plane/main.bicep</code> (which also wires a dedicated{' '}
                <code>LOOM_IQ_MCP_TOKEN</code> Bearer secret, isolated from the internal MAF/CI tokens).
              </MessageBarBody>
            </MessageBar>
          )}

          <div className={s.field}>
            <Text className={s.label}>Endpoint</Text>
            <div className={s.endpointRow}>
              <span className={s.mono}>{absoluteEndpoint}</span>
              <Button
                size="small"
                appearance="subtle"
                icon={copied === 'endpoint' ? <Checkmark16Regular /> : <Copy16Regular />}
                onClick={() => copy('endpoint', absoluteEndpoint)}
              >
                {copied === 'endpoint' ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <Caption1 className={s.hint}>
              JSON-RPC methods: {doc.methods.join(', ')} · transport: {doc.transport}
            </Caption1>
          </div>

          <div className={s.field}>
            <Text className={s.label}>Authentication</Text>
            <div className={s.authRow}>
              <Caption1><strong>Session:</strong> {doc.auth.session}</Caption1>
              <Caption1><strong>Bearer:</strong> {doc.auth.bearer}</Caption1>
            </div>
          </div>

          <div className={s.field}>
            <div className={s.endpointRow}>
              <Text className={s.label}>Register with an agent platform</Text>
              <Button
                size="small"
                appearance="subtle"
                icon={copied === 'snippet' ? <Checkmark16Regular /> : <Copy16Regular />}
                onClick={() => copy('snippet', registrationSnippet)}
              >
                {copied === 'snippet' ? 'Copied' : 'Copy snippet'}
              </Button>
            </div>
            <pre className={s.snippet}>{registrationSnippet}</pre>
          </div>

          <Divider />
          <div className={s.field}>
            <Text className={s.label}>Published tools ({doc.tools.length})</Text>
            <Caption1 className={s.hint}>
              Live from <code>tools/list</code>. Each tool calls a real Azure-native backend
              (Cosmos ontology / semantic models; Azure Data Explorer signals).
            </Caption1>
            <Table size="small" aria-label="Published IQ MCP tools">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell className={s.toolCol}>Tool</TableHeaderCell>
                  <TableHeaderCell>Description</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {doc.tools.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={2}>
                      <div className={s.emptyState}>
                        <PlugConnected24Regular className={s.emptyIcon} />
                        <Text weight="semibold">No tools published yet</Text>
                        <Caption1 className={s.hint}>
                          The IQ surface is reachable but currently exposes no tools. Tools appear here
                          once an ontology, semantic model, or live-signal source is registered for this tenant.
                        </Caption1>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  doc.tools.map((t) => (
                    <TableRow key={t.name}>
                      <TableCell className={s.toolCol}><span className={s.toolName}>{t.name}</span></TableCell>
                      <TableCell className={s.toolDesc}>{t.description}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <Caption1 className={s.hint} style={{ marginTop: tokens.spacingVerticalM }}>
            <Open16Regular style={{ verticalAlign: 'text-bottom', marginRight: tokens.spacingHorizontalXXS }} />
            Full registration walkthrough: <code>docs/fiab/v3-tenant-bootstrap.md#fabric-iq-mcp</code>
          </Caption1>
        </>
      )}
    </Section>
  );
}
