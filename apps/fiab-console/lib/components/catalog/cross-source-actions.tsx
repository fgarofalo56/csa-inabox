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
  Subtitle2, Body1, makeStyles, tokens, Field, Textarea,
} from '@fluentui/react-components';
import { Open16Regular } from '@fluentui/react-icons';

interface Props {
  source: 'purview' | 'unity-catalog' | 'onelake';
  id: string;
  host?: string;
  workspaceId?: string;
  detail?: any;
}

const useStyles = makeStyles({
  row: { display: 'flex', flexDirection: 'column', gap: 12 },
  group: { padding: 12, borderRadius: 6, border: `1px solid ${tokens.colorNeutralStroke2}`, display: 'flex', flexDirection: 'column', gap: 8 },
  groupTitle: { fontWeight: 600 },
  buttonRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground3, fontSize: 12 },
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
    <div className={s.row}>
      {(source === 'unity-catalog' || source === 'onelake') && (
        <div className={s.group}>
          <Subtitle2 className={s.groupTitle}>Register in Purview</Subtitle2>
          <Body1 className={s.hint}>
            Creates / merges an Atlas entity in Purview Unified Catalog using a deterministic qualifiedName.
            Subsequent registrations are idempotent (Atlas dedupes by qualifiedName).
          </Body1>
          <Field label="Business domain GUID (optional)">
            <Input value={domain} onChange={(_, d) => setDomain(d.value)} placeholder="11111111-2222-3333-4444-555555555555" />
          </Field>
          <div className={s.buttonRow}>
            <Button appearance="primary" onClick={registerInPurview} disabled={busy} data-testid="action-register">
              {busy ? <Spinner size="tiny" /> : 'Register in Purview'}
            </Button>
          </div>
        </div>
      )}

      <div className={s.group}>
        <Subtitle2 className={s.groupTitle}>Glossary term</Subtitle2>
        <Body1 className={s.hint}>
          Creates a glossary term in Purview. {source !== 'purview' ? 'Register the asset first to enable auto-apply.' : 'Applies it to this asset.'}
        </Body1>
        <Field label="Term name" required>
          <Input value={termName} onChange={(_, d) => setTermName(d.value)} placeholder="PII" />
        </Field>
        <Field label="Long description">
          <Textarea value={termDesc} onChange={(_, d) => setTermDesc(d.value)} placeholder="Personally identifiable information" rows={2} />
        </Field>
        <div className={s.buttonRow}>
          <Button appearance="secondary" onClick={applyTerm} disabled={busy} data-testid="action-glossary">
            {busy ? <Spinner size="tiny" /> : (source === 'purview' ? 'Create + apply' : 'Create term')}
          </Button>
        </div>
      </div>

      {source === 'onelake' && (
        <div className={s.group}>
          <Subtitle2 className={s.groupTitle}>Promote ADLS path to OneLake shortcut</Subtitle2>
          <Body1 className={s.hint}>
            Creates a zero-copy shortcut from ADLS Gen2 into this Lakehouse. The shortcut is auto-registered in Purview.
          </Body1>
          <Field label="Shortcut name" required>
            <Input value={shortcutName} onChange={(_, d) => setShortcutName(d.value)} placeholder="bronze-customers" />
          </Field>
          <Field label="ADLS Gen2 location">
            <Input value={shortcutLocation} onChange={(_, d) => setShortcutLocation(d.value)} />
          </Field>
          <Field label="ADLS subpath">
            <Input value={shortcutSubpath} onChange={(_, d) => setShortcutSubpath(d.value)} />
          </Field>
          <div className={s.buttonRow}>
            <Button appearance="primary" onClick={promoteShortcut} disabled={busy} data-testid="action-shortcut">
              {busy ? <Spinner size="tiny" /> : 'Create shortcut'}
            </Button>
          </div>
        </div>
      )}

      {result && (
        <MessageBar intent={result.ok ? 'success' : 'error'}>
          <MessageBarBody>
            <MessageBarTitle>{result.ok ? 'Done' : 'Action failed'}</MessageBarTitle>
            <Body1>{result.message}</Body1>
            {result.link && (
              <a href={result.link} target="_blank" rel="noreferrer" style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 6, fontSize: 13,
              }}>
                Open in Purview <Open16Regular />
              </a>
            )}
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}
