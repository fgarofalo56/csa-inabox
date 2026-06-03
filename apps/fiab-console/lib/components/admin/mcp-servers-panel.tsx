'use client';

/**
 * MCPServersPanel — admin tenant-wide "External MCP Tools" configuration.
 *
 * Mounted in the Copilot & Agents section of /admin/tenant-settings.
 * Lets a tenant admin manage external MCP server connections:
 *   • List all registered servers
 *   • Add a new server (name + endpoint + auth)
 *   • Test connection (real fetch to tools/list)
 *   • Enable/disable
 *   • Edit / delete
 *
 * Fluent v9 form-based UI, no JSON.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Dialog, DialogTrigger, DialogContent, DialogBody, DialogTitle,
  Dropdown, Option, Field, Input, Checkbox, Spinner, Badge,
  MessageBar, MessageBarBody, MessageBarTitle,
  Caption1, Body2, Body1, makeStyles, tokens, Divider,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
} from '@fluentui/react-components';
import { Add20Regular, Edit20Regular, Delete20Regular, ArrowClockwise20Regular, Checkmark20Regular } from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import type { McpServerConfig, McpServerConfigDoc } from '@/lib/types/mcp-config';

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalL,
  },
  hint: { color: tokens.colorNeutralForeground3, fontSize: '12px' },
  bar: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  spacer: { flex: 1 },
  testStatus: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  tableWrap: { overflowX: 'auto' },
});

function McpServerForm({
  server,
  onSave,
  onCancel,
  isSaving,
}: {
  server?: McpServerConfigDoc | McpServerConfig;
  onSave: (config: McpServerConfig) => Promise<void>;
  onCancel: () => void;
  isSaving: boolean;
}) {
  const [form, setForm] = useState<McpServerConfig>(server ? {
    name: (server as any).name || '',
    endpoint: (server as any).endpoint || '',
    authMethod: (server as any).authMethod || 'header',
    authValue: (server as any).authValue || '',
    description: (server as any).description || '',
    enabled: (server as any).enabled !== false,
  } : {
    name: '',
    endpoint: '',
    authMethod: 'header',
    authValue: '',
    description: '',
    enabled: true,
  });
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ toolCount: number; tools?: Array<{ name: string; description?: string }> } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const testConnection = useCallback(async () => {
    setTesting(true); setTestError(null); setTestResult(null);
    try {
      const r = await fetch('/api/admin/mcp-servers/test-connection', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: form }),
      });
      const j = await r.json();
      if (!j.ok) { setTestError(j.error || 'Test failed'); return; }
      setTestResult({ toolCount: j.toolCount, tools: j.tools });
    } catch (e: any) {
      setTestError(e?.message || String(e));
    } finally { setTesting(false); }
  }, [form]);

  const handleSave = async () => {
    setSaveError(null);
    try {
      await onSave(form);
    } catch (e: any) {
      setSaveError(e?.message || String(e));
    }
  };

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: tokens.spacingHorizontalL }}>
        <Field label="Name" hint="Display name for this MCP server (e.g., 'Acme Tools').">
          <Input
            value={form.name}
            onChange={(_, d) => setForm((f) => ({ ...f, name: d.value }))}
            placeholder="My MCP Server"
          />
        </Field>
        <Field label="Endpoint" hint="HTTPS URL of the MCP server.">
          <Input
            value={form.endpoint}
            onChange={(_, d) => setForm((f) => ({ ...f, endpoint: d.value }))}
            placeholder="https://api.example.com/mcp"
          />
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: tokens.spacingHorizontalL }}>
        <Field label="Auth method" hint="How to authenticate with the MCP server.">
          <Dropdown
            value={form.authMethod || 'header'}
            selectedOptions={[form.authMethod || 'header']}
            onOptionSelect={(_, d) => setForm((f) => ({ ...f, authMethod: d.optionValue as any }))}
          >
            <Option value="header">Authorization header</Option>
            <Option value="key-vault">Key Vault secret</Option>
          </Dropdown>
        </Field>
        <Field
          label={form.authMethod === 'key-vault' ? 'Key Vault secret name' : 'Auth header value'}
          hint={form.authMethod === 'key-vault'
            ? 'Name of the secret in LOOM_KEY_VAULT_URL.'
            : 'Bearer token or raw header value.'
          }
        >
          <Input
            value={form.authValue || ''}
            onChange={(_, d) => setForm((f) => ({ ...f, authValue: d.value }))}
            type={form.authMethod === 'key-vault' ? 'text' : 'password'}
            placeholder={form.authMethod === 'key-vault' ? 'secret-name' : 'Bearer ...'}
          />
        </Field>
      </div>

      <Field label="Description (optional)" hint="Usage notes or endpoint details.">
        <Input
          value={form.description || ''}
          onChange={(_, d) => setForm((f) => ({ ...f, description: d.value }))}
          placeholder="Customer-specific API toolkit..."
        />
      </Field>

      <Checkbox
        checked={form.enabled}
        onChange={(_, d) => setForm((f) => ({ ...f, enabled: d.checked === true }))}
        label="Enabled"
      />

      {testError && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Test failed</MessageBarTitle>{testError}</MessageBarBody>
        </MessageBar>
      )}
      {testResult && (
        <MessageBar intent="success">
          <MessageBarBody>
            <MessageBarTitle>Connection successful</MessageBarTitle>
            Found {testResult.toolCount} tool{testResult.toolCount === 1 ? '' : 's'}
            {testResult.tools && testResult.tools.length > 0 && (
              <div style={{ marginTop: tokens.spacingVerticalS, fontSize: 12 }}>
                {testResult.tools.map((t) => <div key={t.name}>{t.name}</div>)}
              </div>
            )}
          </MessageBarBody>
        </MessageBar>
      )}
      {saveError && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{saveError}</MessageBarBody>
        </MessageBar>
      )}

      <div style={{ display: 'flex', gap: tokens.spacingHorizontalM }}>
        <Button
          onClick={() => void testConnection()}
          disabled={!form.endpoint || testing || isSaving}
          icon={<ArrowClockwise20Regular />}
        >
          {testing ? 'Testing...' : 'Test Connection'}
        </Button>
        <div style={{ flex: 1 }} />
        <Button appearance="secondary" onClick={onCancel} disabled={isSaving}>Cancel</Button>
        <Button appearance="primary" onClick={() => void handleSave()} disabled={!form.name || !form.endpoint || isSaving}>
          {isSaving ? 'Saving...' : 'Save Server'}
        </Button>
      </div>
    </>
  );
}

export function McpServersPanel() {
  const s = useStyles();
  const [servers, setServers] = useState<McpServerConfigDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const r = await fetch('/api/admin/mcp-servers');
      const j = await r.json();
      if (!j.ok) { setLoadError(j.error || `HTTP ${r.status}`); return; }
      setServers(Array.isArray(j.servers) ? j.servers : []);
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (serverId: string | undefined, config: McpServerConfig) => {
    setSaving(true);
    try {
      const method = serverId ? 'PUT' : 'POST';
      const url = serverId ? `/api/admin/mcp-servers?id=${serverId}` : '/api/admin/mcp-servers';
      const r = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setServers((prev) => {
        if (serverId) {
          return prev.map((s) => s.serverId === serverId ? j.server : s);
        } else {
          return [...prev, j.server];
        }
      });
      setShowAdd(false);
      setEditingId(null);
    } finally { setSaving(false); }
  }, []);

  const deleteServer = useCallback(async (serverId: string) => {
    if (!confirm(`Delete MCP server? This cannot be undone.`)) return;
    try {
      const r = await fetch(`/api/admin/mcp-servers?id=${serverId}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setServers((prev) => prev.filter((s) => s.serverId !== serverId));
    } catch (e: any) {
      alert(`Delete failed: ${e?.message}`);
    }
  }, []);

  if (loading) {
    return (
      <Section title="External MCP Tools">
        <Spinner label="Loading MCP servers..." />
      </Section>
    );
  }

  const editingServer = servers.find((s) => s.serverId === editingId);

  return (
    <Section title="External MCP Tools">
      <Body1 className={s.hint}>
        Register external MCP (Model Context Protocol) servers so Loom Copilot can call their tools.
        Each server's tools are discovered at orchestrate time and registered as Loom tools.
      </Body1>

      {loadError && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Load failed</MessageBarTitle>{loadError}</MessageBarBody>
        </MessageBar>
      )}

      {servers.length === 0 ? (
        <Caption1>No MCP servers registered yet.</Caption1>
      ) : (
        <div className={s.tableWrap}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Endpoint</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Tools</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {servers.map((server) => (
                <TableRow key={server.serverId}>
                  <TableCell>
                    <Body2 weight="semibold">{server.name}</Body2>
                    {server.description && <Caption1>{server.description}</Caption1>}
                  </TableCell>
                  <TableCell><Caption1>{server.endpoint.replace(/^https:\/\//, '').slice(0, 40)}</Caption1></TableCell>
                  <TableCell>
                    {server.enabled ? (
                      <Badge appearance="outline" color="success" size="small">Enabled</Badge>
                    ) : (
                      <Badge appearance="outline" color="warning" size="small">Disabled</Badge>
                    )}
                    {server.lastTestResult && (
                      <div className={s.testStatus}>
                        <Checkmark20Regular style={{ fontSize: 14, color: tokens.colorPaletteGreenForeground1 }} />
                        <Caption1>Tested {new Date(server.lastTestResult.at).toLocaleDateString()}</Caption1>
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    {server.lastTestResult ? (
                      <Caption1>{server.lastTestResult.toolCount} tools</Caption1>
                    ) : (
                      <Caption1>—</Caption1>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      icon={<Edit20Regular />}
                      size="small"
                      onClick={() => setEditingId(server.serverId)}
                      disabled={saving}
                    >Edit</Button>
                    <Button
                      icon={<Delete20Regular />}
                      size="small"
                      onClick={() => void deleteServer(server.serverId)}
                      disabled={saving}
                    >Delete</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className={s.bar}>
        <div className={s.spacer} />
        <Button icon={<Add20Regular />} appearance="primary" onClick={() => setShowAdd(true)}>
          Add MCP Server
        </Button>
      </div>

      {/* Add/Edit Dialog */}
      <Dialog open={showAdd || !!editingId} onOpenChange={(_, state) => { if (!state.open) { setShowAdd(false); setEditingId(null); } }}>
        <DialogTrigger />
        <DialogContent>
          <DialogBody>
            <DialogTitle>{editingId ? 'Edit MCP Server' : 'Add MCP Server'}</DialogTitle>
            <div style={{ marginTop: tokens.spacingVerticalL }}>
              <McpServerForm
                server={editingServer}
                onSave={(config) => save(editingId ?? undefined, config)}
                onCancel={() => { setShowAdd(false); setEditingId(null); }}
                isSaving={saving}
              />
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </Section>
  );
}
