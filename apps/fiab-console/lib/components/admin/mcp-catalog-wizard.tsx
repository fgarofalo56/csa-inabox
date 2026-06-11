'use client';

/**
 * McpCatalogBrowser — the "Browse library" surface for External MCP Tools.
 *
 * Renders the curated MCP_CATALOG as a grid of cards. "Deploy" opens a Fluent
 * wizard that renders ONE control per the entry's configSchema (password Input
 * for secret fields, Dropdown for enums, Switch for bools, Input otherwise — no
 * JSON), then POSTs to /api/admin/mcp-servers/deploy which provisions an internal
 * Azure Container App, writes per-field secrets to Key Vault, and auto-registers
 * the endpoint for Copilot. Honest infra gate (MessageBar) when ACA/KV/CAE isn't
 * wired (e.g. the AKS sovereign boundary).
 */

import { useCallback, useState, type ReactNode } from 'react';
import {
  Button, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Field, Input, Dropdown, Option, Switch, Badge, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle,
  Card, CardHeader, Caption1, Body1, Text, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Rocket20Regular, Code24Regular, Grid24Regular, Box24Regular,
  Archive24Regular, Globe24Regular,
} from '@fluentui/react-icons';
import { MCP_DEPLOY_CATALOG as MCP_CATALOG, type McpCatalogEntry, type McpDeployConfigField as McpConfigField } from '@/lib/mcp/catalog';
import type { McpServerConfigDoc } from '@/lib/types/mcp-config';

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalL,
    marginTop: tokens.spacingVerticalM,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
    transitionProperty: 'box-shadow, transform',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': {
      boxShadow: tokens.shadow16,
      transform: 'translateY(-2px)',
    },
  },
  cardDesc: { color: tokens.colorNeutralForeground2, flex: 1, minHeight: '40px' },
  cardFoot: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalS },
  spacer: { flex: 1 },
  iconWrap: { color: tokens.colorBrandForeground1, display: 'flex', alignItems: 'center' },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalM },
  gateDetail: { marginTop: tokens.spacingVerticalXS, fontSize: tokens.fontSizeBase200 },
  gateCommands: {
    marginTop: tokens.spacingVerticalS,
    fontSize: tokens.fontSizeBase100,
    whiteSpace: 'pre-wrap',
    backgroundColor: tokens.colorNeutralBackground3,
    padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    fontFamily: tokens.fontFamilyMonospace,
  },
  previewWrap: { marginTop: tokens.spacingVerticalS },
});

const CATEGORY_GLYPH: Record<McpCatalogEntry['category'], ReactNode> = {
  developer: <Code24Regular />,
  observability: <Grid24Regular />,
  data: <Box24Regular />,
  productivity: <Archive24Regular />,
  reference: <Globe24Regular />,
};

interface DeployGate {
  message: string;
  missing?: string;
  boundary?: string;
  deployModule?: string;
  commands?: string[];
}

function fieldDefault(f: McpConfigField): string {
  return f.default ?? (f.type === 'bool' ? 'false' : '');
}

function DeployWizard({
  entry,
  onClose,
  onDeployed,
}: {
  entry: McpCatalogEntry;
  onClose: () => void;
  onDeployed: (server: McpServerConfigDoc) => void;
}) {
  const s = useStyles();
  const [name, setName] = useState(entry.name);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of entry.configSchema) init[f.key] = fieldDefault(f);
    return init;
  });
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<DeployGate | null>(null);

  const set = (k: string, v: string) => setValues((p) => ({ ...p, [k]: v }));

  const missingRequired = entry.configSchema
    .filter((f) => f.required)
    .some((f) => !values[f.key] || values[f.key].trim() === '');

  const deploy = useCallback(async () => {
    setDeploying(true); setError(null); setGate(null);
    try {
      const r = await fetch('/api/admin/mcp-servers/deploy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ catalogId: entry.id, name, values }),
      });
      const j = await r.json();
      if (r.status === 503 && j.gate) { setGate(j.gate); return; }
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      onDeployed(j.server);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setDeploying(false); }
  }, [entry.id, name, values, onDeployed]);

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Deploy {entry.name}</DialogTitle>
          <DialogContent>
            <Body1>{entry.description}</Body1>
            {entry.preview && (
              <div className={s.previewWrap}>
                <Badge appearance="tint" color="warning">Preview</Badge>
              </div>
            )}
            <div className={s.form}>
              <Field label="Display name" hint="Shown in the External MCP Tools list and in Copilot.">
                <Input value={name} onChange={(_, d) => setName(d.value)} />
              </Field>

              {entry.configSchema.map((f) => {
                if (f.type === 'bool') {
                  return (
                    <Field key={f.key} label={f.label} hint={f.help}>
                      <Switch
                        checked={values[f.key] === 'true'}
                        onChange={(_, d) => set(f.key, d.checked ? 'true' : 'false')}
                      />
                    </Field>
                  );
                }
                if (f.type === 'enum' && f.options) {
                  return (
                    <Field key={f.key} label={f.label} hint={f.help} required={f.required}>
                      <Dropdown
                        value={values[f.key] || ''}
                        selectedOptions={[values[f.key] || '']}
                        onOptionSelect={(_, d) => set(f.key, d.optionValue || '')}
                      >
                        {f.options.map((o) => <Option key={o} value={o}>{o}</Option>)}
                      </Dropdown>
                    </Field>
                  );
                }
                return (
                  <Field key={f.key} label={f.label} hint={f.help} required={f.required}>
                    <Input
                      value={values[f.key] || ''}
                      type={f.secret ? 'password' : (f.type === 'number' ? 'number' : 'text')}
                      onChange={(_, d) => set(f.key, d.value)}
                      contentAfter={f.secret ? <Badge size="small" appearance="tint" color="brand">Key Vault</Badge> : undefined}
                    />
                  </Field>
                );
              })}

              {error && (
                <MessageBar intent="error">
                  <MessageBarBody><MessageBarTitle>Deploy failed</MessageBarTitle>{error}</MessageBarBody>
                </MessageBar>
              )}
              {gate && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Infrastructure not wired ({gate.boundary})</MessageBarTitle>
                    {gate.message}
                    {gate.missing && <div className={s.gateDetail}>Set/grant: <code>{gate.missing}</code></div>}
                    {gate.deployModule && <div className={s.gateDetail}>Bicep: <code>{gate.deployModule}</code></div>}
                    {gate.commands && gate.commands.length > 0 && (
                      <pre className={s.gateCommands}>
                        {gate.commands.join('\n')}
                      </pre>
                    )}
                  </MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={deploying}>Cancel</Button>
            <Button
              appearance="primary"
              icon={deploying ? <Spinner size="tiny" /> : <Rocket20Regular />}
              disabled={deploying || missingRequired}
              onClick={() => void deploy()}
            >
              {deploying ? 'Deploying…' : 'Deploy & register'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export function McpCatalogBrowser({ onDeployed }: { onDeployed: (server: McpServerConfigDoc) => void }) {
  const s = useStyles();
  const [selected, setSelected] = useState<McpCatalogEntry | null>(null);

  return (
    <div>
      <Body1>
        Browse the curated library of MCP servers. Deploying provisions the server as an internal
        Azure Container App, stores credentials per-field in Key Vault, and registers it for Copilot
        automatically — no further setup.
      </Body1>
      <div className={s.grid}>
        {MCP_CATALOG.map((entry) => (
          <Card key={entry.id} className={s.card}>
            <CardHeader
              image={<span className={s.iconWrap}>{CATEGORY_GLYPH[entry.category]}</span>}
              header={<Text weight="semibold">{entry.name}</Text>}
              description={<Caption1>{entry.category}</Caption1>}
            />
            <Text className={s.cardDesc} size={200}>{entry.description}</Text>
            <div className={s.cardFoot}>
              {entry.preview && <Badge appearance="tint" color="warning" size="small">Preview</Badge>}
              {entry.configSchema.some((f) => f.secret) && (
                <Badge appearance="outline" color="brand" size="small">Key Vault secret</Badge>
              )}
              <div className={s.spacer} />
              <Button appearance="primary" size="small" icon={<Rocket20Regular />} onClick={() => setSelected(entry)}>
                Deploy
              </Button>
            </div>
          </Card>
        ))}
      </div>

      {selected && (
        <DeployWizard
          entry={selected}
          onClose={() => setSelected(null)}
          onDeployed={(server) => { setSelected(null); onDeployed(server); }}
        />
      )}
    </div>
  );
}
