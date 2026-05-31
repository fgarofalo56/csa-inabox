'use client';

/**
 * ConnectSourceDialog — Fabric Real-Time Hub "Get events" / "Connect data
 * source" wizard. Three panes, one-for-one with Fabric:
 *   1. Pick a connector (category list + connector grid).
 *   2. Name the eventstream + target Fabric workspace + fill source-specific
 *      connection fields.
 *   3. POST /api/realtime-hub/connect-source → creates a REAL Fabric
 *      Eventstream item carrying the chosen source.
 *
 * No dead buttons: Connect actually calls the BFF; the result (created id
 * or 202 accepted, or a verbatim FabricError) is shown inline.
 */

import { useMemo, useState } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Input, Field, Badge, MessageBar, MessageBarBody, MessageBarTitle,
  Subtitle2, Body1, Caption1, makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowLeft20Regular, PlugConnected20Regular, Search20Regular } from '@fluentui/react-icons';
import {
  SOURCE_CONNECTORS, SOURCE_CATEGORIES, type SourceConnector, type SourceCategory,
} from './source-catalog';

const useStyles = makeStyles({
  surface: { maxWidth: '900px', width: '90vw' },
  layout: { display: 'grid', gridTemplateColumns: '190px 1fr', gap: '16px', minHeight: '440px' },
  catList: {
    display: 'flex', flexDirection: 'column', gap: '2px',
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`, paddingRight: '8px',
  },
  catItem: {
    textAlign: 'left', padding: '8px 12px', borderRadius: '4px', background: 'transparent',
    border: 'none', cursor: 'pointer', color: tokens.colorNeutralForeground1, fontSize: '14px',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  catItemActive: { backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1, fontWeight: 600 },
  rightCol: { display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 0 },
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '10px',
    overflowY: 'auto', paddingRight: '4px',
  },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '6px', padding: '12px',
    cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '4px',
    backgroundColor: tokens.colorNeutralBackground1, textAlign: 'left',
    ':hover': { borderColor: tokens.colorBrandStroke1, boxShadow: tokens.shadow4 },
  },
  form: { display: 'flex', flexDirection: 'column', gap: '12px' },
});

interface Props {
  /** Fabric workspaces the UAMI can see — [{id, name}]. */
  workspaces: Array<{ id: string; name: string }>;
  /** Pre-selected workspace id (optional). */
  defaultWorkspaceId?: string;
  /** Called after a successful connect so the parent can refresh the streams list. */
  onConnected?: () => void;
  /** Trigger button (rendered by parent). */
  trigger: React.ReactElement;
}

export function ConnectSourceDialog({ workspaces, defaultWorkspaceId, onConnected, trigger }: Props) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<SourceCategory>('Microsoft sources');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<SourceConnector | null>(null);

  const [displayName, setDisplayName] = useState('');
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId || '');
  const [props, setProps] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const connectors = useMemo(() => {
    const q = query.trim().toLowerCase();
    return SOURCE_CONNECTORS.filter((c) =>
      q ? (c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)) : c.category === category);
  }, [category, query]);

  function reset() {
    setPicked(null); setDisplayName(''); setProps({});
    setError(null); setErrorHint(null); setSuccess(null); setBusy(false);
  }

  function pick(c: SourceConnector) {
    setPicked(c);
    setDisplayName(`${c.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-stream`);
    setProps({});
    setError(null); setErrorHint(null); setSuccess(null);
  }

  const missingRequired = picked
    ? picked.fields.some((f) => f.required && !(props[f.key] || '').trim())
    : false;
  const canConnect = !!picked && !!displayName.trim() && !!workspaceId && !missingRequired && !busy;

  async function connect() {
    if (!picked || !canConnect) return;
    setBusy(true); setError(null); setErrorHint(null); setSuccess(null);
    try {
      const properties: Record<string, string> = {};
      for (const f of picked.fields) {
        const v = (props[f.key] || '').trim();
        if (v) properties[f.key] = v;
      }
      const res = await fetch('/api/realtime-hub/connect-source', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fabricWorkspaceId: workspaceId,
          displayName: displayName.trim(),
          sourceType: picked.sourceType,
          sourceName: picked.id,
          properties,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setError(j.error || `Connect failed (HTTP ${res.status}).`);
        setErrorHint(j.hint || null);
        return;
      }
      setSuccess(
        j.accepted
          ? `Eventstream creation accepted (long-running). It will appear in All data streams shortly.`
          : `Connected. Created Fabric Eventstream ${j.fabricEventstreamId || ''}.`,
      );
      onConnected?.();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(_, d) => { setOpen(d.open); if (!d.open) reset(); }}>
      <span onClick={() => setOpen(true)}>{trigger}</span>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>{picked ? `Connect ${picked.name}` : 'Get events — connect a source'}</DialogTitle>
          <DialogContent>
            {picked ? (
              <div className={styles.form}>
                <Button appearance="subtle" icon={<ArrowLeft20Regular />} onClick={() => { setPicked(null); setSuccess(null); }}>
                  Back to sources
                </Button>
                <Caption1>{picked.description}</Caption1>
                <Field label="Eventstream name" required>
                  <Input value={displayName} onChange={(_, d) => setDisplayName(d.value)} />
                </Field>
                <Field label="Fabric workspace" required
                  hint="Eventstreams are created in a Fabric workspace the Console UAMI can write to.">
                  <select
                    aria-label="Fabric workspace"
                    value={workspaceId}
                    onChange={(e) => setWorkspaceId(e.target.value)}
                    style={{ padding: '6px 8px', borderRadius: 4, border: `1px solid ${tokens.colorNeutralStroke1}` }}
                  >
                    <option value="">Select a workspace…</option>
                    {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </Field>
                {picked.fields.map((f) => (
                  <Field key={f.key} label={f.label} required={f.required} hint={f.help}>
                    <Input
                      placeholder={f.placeholder}
                      value={props[f.key] || ''}
                      onChange={(_, d) => setProps((p) => ({ ...p, [f.key]: d.value }))}
                    />
                  </Field>
                ))}
                {picked.fields.length === 0 && (
                  <MessageBar intent="info">
                    <MessageBarBody>This source needs no extra connection settings — Connect creates the eventstream and subscribes immediately.</MessageBarBody>
                  </MessageBar>
                )}
                {error && (
                  <MessageBar intent="error">
                    <MessageBarBody>
                      <MessageBarTitle>Could not connect source</MessageBarTitle>
                      {error}{errorHint ? ` — ${errorHint}` : ''}
                    </MessageBarBody>
                  </MessageBar>
                )}
                {success && (
                  <MessageBar intent="success"><MessageBarBody>{success}</MessageBarBody></MessageBar>
                )}
              </div>
            ) : (
              <div className={styles.layout}>
                <div className={styles.catList} role="tablist" aria-label="Source category">
                  {SOURCE_CATEGORIES.map((c) => (
                    <button key={c} type="button" role="tab" aria-selected={category === c}
                      className={`${styles.catItem} ${category === c && !query ? styles.catItemActive : ''}`}
                      onClick={() => { setCategory(c); setQuery(''); }}>
                      {c}
                    </button>
                  ))}
                </div>
                <div className={styles.rightCol}>
                  <Input contentBefore={<Search20Regular />} placeholder="Search sources"
                    value={query} onChange={(_, d) => setQuery(d.value)} />
                  <div className={styles.grid}>
                    {connectors.map((c) => (
                      <button key={c.id} type="button" className={styles.card} onClick={() => pick(c)}>
                        <Subtitle2>{c.name}</Subtitle2>
                        <Body1 style={{ fontSize: 13 }}>{c.description}</Body1>
                        <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                          <Badge appearance="outline" size="small">{c.sourceType}</Badge>
                          {c.preview && <Badge appearance="outline" color="warning" size="small">Preview</Badge>}
                        </div>
                      </button>
                    ))}
                    {connectors.length === 0 && <Body1>No matching sources.</Body1>}
                  </div>
                </div>
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => { setOpen(false); reset(); }}>Close</Button>
            {picked && (
              <Button appearance="primary" icon={<PlugConnected20Regular />} disabled={!canConnect} onClick={connect}>
                {busy ? 'Connecting…' : 'Connect'}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
