'use client';

/**
 * CrossSourceActions — buttons that fan an asset out to the other two
 * catalog stores. Surfaced on the asset detail page.
 *
 * Per source:
 *   unity-catalog → "Register in Purview"      POST /api/catalog/register
 *                   "Apply glossary term"      POST /api/catalog/glossary
 *   onelake       → "Register in Purview"      POST /api/catalog/register
 *                   "Promote shortcut to ..."  POST /api/catalog/shortcut
 *   purview       → "Apply glossary term"      POST /api/catalog/glossary
 *
 * Every action posts to a real BFF route (no client-side mock). Errors are
 * surfaced inline via MessageBar.
 */
import { useState } from 'react';
import {
  Button, Input, MessageBar, MessageBarBody, MessageBarTitle, Spinner,
  Body1, Caption1, Switch, Badge, makeStyles, tokens, Field, Textarea,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
} from '@fluentui/react-components';
import { Open16Regular, Sparkle20Regular } from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';

interface Props {
  source: 'purview' | 'unity-catalog' | 'onelake';
  id: string;
  host?: string;
  workspaceId?: string;
  detail?: any;
}

const useStyles = makeStyles({
  // each action group stacks its fields with consistent vertical rhythm
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  // capped-width controls so nothing stretches full-bleed
  control: {
    maxWidth: '480px',
    width: '100%',
  },
  buttonRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
    marginTop: tokens.spacingVerticalS,
  },
  hint: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    maxWidth: '640px',
  },
  resultLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    marginTop: tokens.spacingVerticalS,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorBrandForeground1,
    textDecorationLine: 'none',
    ':hover': { textDecorationLine: 'underline' },
  },
});

interface ActionResult {
  ok: boolean;
  message: string;
  link?: string;
  raw?: unknown;
}

export function CrossSourceActions({ source, id, host, workspaceId, detail }: Props) {
  const s = useStyles();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [domain, setDomain] = useState('');
  const [termName, setTermName] = useState('');
  const [termDesc, setTermDesc] = useState('');
  const [shortcutName, setShortcutName] = useState('');
  const [shortcutLocation, setShortcutLocation] = useState('https://.dfs.core.windows.net');
  const [shortcutSubpath, setShortcutSubpath] = useState('/container/path');

  // ── Bulk AI auto-description (semantic models) ──────────────────────────────
  const [descMeasures, setDescMeasures] = useState(true);
  const [descColumns, setDescColumns] = useState(true);
  const [descOverwrite, setDescOverwrite] = useState(false);
  const [descBusy, setDescBusy] = useState(false);
  const [descGate, setDescGate] = useState<{ missing?: string; detail?: string } | null>(null);
  const [descResult, setDescResult] = useState<{
    applied: boolean;
    measures: Array<{ name: string; description: string }>;
    columns: Array<{ name: string; description: string }>;
    note?: string;
    error?: string;
  } | null>(null);

  // The OneLake catalog row carries the asset type via detail.itemType /
  // detail.detail.type; default to semantic-model (the only describable type).
  const assetItemType =
    String(detail?.itemType || detail?.detail?.type || detail?.detail?.itemType || 'semantic-model');
  const isSemanticModel = /semantic.?model/i.test(assetItemType);

  async function generateDescriptions(apply: boolean) {
    if (!descMeasures && !descColumns) {
      setDescResult({ applied: false, measures: [], columns: [], error: 'Select measures and/or columns to describe.' });
      return;
    }
    setDescBusy(true); setDescResult(null); setDescGate(null);
    try {
      const targets: string[] = [];
      if (descMeasures) targets.push('measures');
      if (descColumns) targets.push('columns');
      const r = await fetch('/api/catalog/describe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: id, itemType: 'semantic-model', apply, targets, overwrite: descOverwrite }),
      });
      const j = await r.json();
      if (j.aoaiUnavailable) {
        setDescGate({ missing: j.missing, detail: j.detail });
        return;
      }
      if (!j.ok) {
        setDescResult({ applied: false, measures: [], columns: [], error: j.error || 'Description generation failed' });
        return;
      }
      setDescResult({
        applied: !!j.applied,
        measures: Array.isArray(j.measures) ? j.measures : [],
        columns: Array.isArray(j.columns) ? j.columns : [],
        note: j.note,
      });
    } catch (e: any) {
      setDescResult({ applied: false, measures: [], columns: [], error: e?.message || String(e) });
    } finally {
      setDescBusy(false);
    }
  }

  async function registerInPurview() {
    setBusy(true); setResult(null);
    try {
      const body: Record<string, unknown> = {};
      if (source === 'unity-catalog') {
        body.source = 'unity-catalog'; body.host = host; body.fullName = id;
      } else if (source === 'onelake') {
        body.source = 'onelake'; body.workspaceId = workspaceId; body.itemId = id;
      } else { return; }
      if (domain) body.domain = domain;
      const r = await fetch('/api/catalog/register', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.ok) {
        setResult({
          ok: true,
          message: `Registered as Purview ${j.typeName} with guid ${j.guid?.slice(0, 12) ?? '?'}…`,
          link: j.purviewDeepLink,
          raw: j,
        });
      } else {
        setResult({ ok: false, message: j.error || 'Register failed', raw: j });
      }
    } catch (e: any) {
      setResult({ ok: false, message: e?.message || String(e) });
    } finally { setBusy(false); }
  }

  async function applyTerm() {
    if (!termName.trim()) { setResult({ ok: false, message: 'Term name required' }); return; }
    setBusy(true); setResult(null);
    try {
      const body: Record<string, unknown> = { term: { name: termName, longDescription: termDesc } };
      // For Purview source we know the entity guid; for UC/OneLake the user
      // must first register so we don't have a guid here unless `detail` has
      // a guidEntityMap with this id.
      if (source === 'purview') {
        body.applyTo = { source: 'purview', entityGuid: id };
      }
      const r = await fetch('/api/catalog/glossary', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.ok) {
        setResult({
          ok: true,
          message: j.applied
            ? `Created term "${j.term?.name}" and applied to this asset.`
            : `Created term "${j.term?.name}". To apply, register the asset in Purview first.`,
          raw: j,
        });
      } else {
        setResult({ ok: false, message: j.error || 'Glossary failed', raw: j });
      }
    } catch (e: any) {
      setResult({ ok: false, message: e?.message || String(e) });
    } finally { setBusy(false); }
  }

  async function promoteShortcut() {
    if (!shortcutName.trim()) { setResult({ ok: false, message: 'Shortcut name required' }); return; }
    if (!workspaceId) { setResult({ ok: false, message: 'workspaceId required (open from OneLake source)' }); return; }
    setBusy(true); setResult(null);
    try {
      const body = {
        workspaceId, itemId: id, name: shortcutName,
        path: 'Files',
        target: {
          adlsGen2: { location: shortcutLocation, subpath: shortcutSubpath },
        },
        registerInPurview: true,
        domain: domain || undefined,
      };
      const r = await fetch('/api/catalog/shortcut', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.ok) {
        setResult({
          ok: true,
          message: `Created shortcut "${j.shortcut?.name}"${j.purview?.guid ? ' and registered in Purview' : ''}.`,
          link: j.purview?.deepLink,
          raw: j,
        });
      } else {
        setResult({ ok: false, message: j.error || 'Shortcut failed', raw: j });
      }
    } catch (e: any) {
      setResult({ ok: false, message: e?.message || String(e) });
    } finally { setBusy(false); }
  }

  return (
    <>
      {(source === 'unity-catalog' || source === 'onelake') && (
        <Section title="Register in Purview">
          <div className={s.group}>
            <Body1 className={s.hint}>
              Creates / merges an Atlas entity in Purview Unified Catalog using a deterministic qualifiedName.
              Subsequent registrations are idempotent (Atlas dedupes by qualifiedName).
            </Body1>
            <Field label="Business domain GUID (optional)">
              <Input className={s.control} value={domain} onChange={(_, d) => setDomain(d.value)} placeholder="11111111-2222-3333-4444-555555555555" />
            </Field>
            <div className={s.buttonRow}>
              <Button appearance="primary" onClick={registerInPurview} disabled={busy} data-testid="action-register">
                {busy ? <Spinner size="tiny" /> : 'Register in Purview'}
              </Button>
            </div>
          </div>
        </Section>
      )}

      {source === 'onelake' && (
        <Section title="Generate AI descriptions">
          <div className={s.group}>
            <Body1 className={s.hint}>
              Bulk-generates business-friendly descriptions for every measure and
              table column on this semantic model using Azure OpenAI, then (when
              applied) writes them back to the model in Cosmos. Azure-native — no
              Microsoft Fabric / Power BI workspace required.
            </Body1>
            {!isSemanticModel && (
              <MessageBar intent="info">
                <MessageBarBody>
                  AI auto-description targets <strong>semantic models</strong>. This
                  asset is a <code>{assetItemType}</code> — open a semantic model to
                  bulk-describe its measures and columns.
                </MessageBarBody>
              </MessageBar>
            )}
            <div style={{ display: 'flex', gap: tokens.spacingHorizontalL, flexWrap: 'wrap' }}>
              <Switch
                checked={descMeasures}
                onChange={(_, d) => setDescMeasures(d.checked)}
                label="Measures"
              />
              <Switch
                checked={descColumns}
                onChange={(_, d) => setDescColumns(d.checked)}
                label="Table columns"
              />
              <Switch
                checked={descOverwrite}
                onChange={(_, d) => setDescOverwrite(d.checked)}
                label="Overwrite existing descriptions"
              />
            </div>
            <div className={s.buttonRow}>
              <Button
                appearance="secondary"
                icon={<Sparkle20Regular />}
                onClick={() => generateDescriptions(false)}
                disabled={descBusy || !isSemanticModel}
                data-testid="action-describe-preview"
              >
                {descBusy ? <Spinner size="tiny" /> : 'Preview descriptions'}
              </Button>
              <Button
                appearance="primary"
                icon={<Sparkle20Regular />}
                onClick={() => generateDescriptions(true)}
                disabled={descBusy || !isSemanticModel}
                data-testid="action-describe-apply"
              >
                {descBusy ? <Spinner size="tiny" /> : 'Generate + apply to model'}
              </Button>
            </div>

            {descGate && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Azure OpenAI not configured</MessageBarTitle>
                  {descGate.detail ??
                    `Set ${descGate.missing ?? 'LOOM_AOAI_ENDPOINT'} to enable AI descriptions.`}
                </MessageBarBody>
              </MessageBar>
            )}

            {descResult?.error && (
              <MessageBar intent="error">
                <MessageBarBody>
                  <MessageBarTitle>Description generation failed</MessageBarTitle>
                  {descResult.error}
                </MessageBarBody>
              </MessageBar>
            )}

            {descResult && !descResult.error && (
              <>
                <MessageBar intent="success">
                  <MessageBarBody>
                    <MessageBarTitle>{descResult.applied ? 'Descriptions applied' : 'Descriptions generated'}</MessageBarTitle>
                    {descResult.note ??
                      `${descResult.measures.length} measure + ${descResult.columns.length} column description(s).`}
                  </MessageBarBody>
                </MessageBar>
                {(descResult.measures.length > 0 || descResult.columns.length > 0) && (
                  <div className={s.control} style={{ maxWidth: 640, overflowX: 'auto' }}>
                    <Table size="small" aria-label="Generated descriptions">
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>Object</TableHeaderCell>
                          <TableHeaderCell>Generated description</TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {descResult.measures.map((p) => (
                          <TableRow key={`m:${p.name}`}>
                            <TableCell>
                              <Badge appearance="tint" color="brand" size="small">measure</Badge>{' '}
                              <code>{p.name}</code>
                            </TableCell>
                            <TableCell><Caption1>{p.description}</Caption1></TableCell>
                          </TableRow>
                        ))}
                        {descResult.columns.map((p) => (
                          <TableRow key={`c:${p.name}`}>
                            <TableCell>
                              <Badge appearance="tint" color="informative" size="small">column</Badge>{' '}
                              <code>{p.name}</code>
                            </TableCell>
                            <TableCell><Caption1>{p.description}</Caption1></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            )}
          </div>
        </Section>
      )}

      <Section title="Glossary term">
        <div className={s.group}>
          <Body1 className={s.hint}>
            Creates a glossary term in Purview. {source !== 'purview' ? 'Register the asset first to enable auto-apply.' : 'Applies it to this asset.'}
          </Body1>
          <Field label="Term name" required>
            <Input className={s.control} value={termName} onChange={(_, d) => setTermName(d.value)} placeholder="PII" />
          </Field>
          <Field label="Long description">
            <Textarea className={s.control} value={termDesc} onChange={(_, d) => setTermDesc(d.value)} placeholder="Personally identifiable information" rows={2} />
          </Field>
          <div className={s.buttonRow}>
            <Button appearance="secondary" onClick={applyTerm} disabled={busy} data-testid="action-glossary">
              {busy ? <Spinner size="tiny" /> : (source === 'purview' ? 'Create + apply' : 'Create term')}
            </Button>
          </div>
        </div>
      </Section>

      {source === 'onelake' && (
        <Section title="Promote ADLS path to OneLake shortcut">
          <div className={s.group}>
            <Body1 className={s.hint}>
              Creates a zero-copy shortcut from ADLS Gen2 into this Lakehouse. The shortcut is auto-registered in Purview.
            </Body1>
            <Field label="Shortcut name" required>
              <Input className={s.control} value={shortcutName} onChange={(_, d) => setShortcutName(d.value)} placeholder="bronze-customers" />
            </Field>
            <Field label="ADLS Gen2 location">
              <Input className={s.control} value={shortcutLocation} onChange={(_, d) => setShortcutLocation(d.value)} />
            </Field>
            <Field label="ADLS subpath">
              <Input className={s.control} value={shortcutSubpath} onChange={(_, d) => setShortcutSubpath(d.value)} />
            </Field>
            <div className={s.buttonRow}>
              <Button appearance="primary" onClick={promoteShortcut} disabled={busy} data-testid="action-shortcut">
                {busy ? <Spinner size="tiny" /> : 'Create shortcut'}
              </Button>
            </div>
          </div>
        </Section>
      )}

      {result && (
        <MessageBar intent={result.ok ? 'success' : 'error'}>
          <MessageBarBody>
            <MessageBarTitle>{result.ok ? 'Done' : 'Action failed'}</MessageBarTitle>
            <Body1>{result.message}</Body1>
            {result.link && (
              <a className={s.resultLink} href={result.link} target="_blank" rel="noreferrer">
                Open in Purview <Open16Regular />
              </a>
            )}
          </MessageBarBody>
        </MessageBar>
      )}
    </>
  );
}
