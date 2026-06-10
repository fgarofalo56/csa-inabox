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

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Input, Field, Badge, MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Subtitle2, Body1, Caption1, Spinner, Dropdown, Option, makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowLeft20Regular, Open20Regular, PlugConnected20Regular, Search20Regular } from '@fluentui/react-icons';
import {
  SOURCE_CONNECTORS, SOURCE_CATEGORIES, sourceVisual, type SourceConnector, type SourceCategory,
} from './source-catalog';

const useStyles = makeStyles({
  surface: { maxWidth: '900px', width: '90vw' },
  layout: {
    display: 'grid', gridTemplateColumns: '190px 1fr',
    gap: tokens.spacingHorizontalL, minHeight: '440px',
  },
  catList: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`, paddingRight: tokens.spacingHorizontalS,
  },
  catItem: {
    textAlign: 'left',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium, background: 'transparent',
    border: 'none', cursor: 'pointer', color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase300, lineHeight: tokens.lineHeightBase300,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '1px' },
  },
  catItemActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  rightCol: {
    display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalM, minHeight: 0,
  },
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
    gap: tokens.spacingHorizontalS, alignContent: 'start',
    overflowY: 'auto', paddingRight: tokens.spacingHorizontalXS,
  },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM,
    cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    backgroundColor: tokens.colorNeutralBackground1, textAlign: 'left',
    ':hover': { borderColor: tokens.colorBrandStroke1, boxShadow: tokens.shadow4 },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '1px' },
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  chip: {
    flexShrink: 0, width: '32px', height: '32px',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: tokens.borderRadiusMedium,
  },
  cardName: { fontWeight: tokens.fontWeightSemibold, lineHeight: 1.2 },
  cardDesc: { fontSize: '13px', color: tokens.colorNeutralForeground2, lineHeight: 1.4 },
  cardTags: { display: 'flex', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalXS, flexWrap: 'wrap' },
  formHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  emptyGrid: {
    gridColumn: '1 / -1',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalXXL, textAlign: 'center',
    color: tokens.colorNeutralForeground3,
  },
  emptyGridIcon: {
    width: '40px', height: '40px',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground3,
  },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  backBtn: { alignSelf: 'flex-start' },
});

interface Props {
  /** Fabric workspaces the UAMI can see — [{id, name}]. */
  workspaces: Array<{ id: string; name: string }>;
  /** Pre-selected workspace id (optional). */
  defaultWorkspaceId?: string;
  /**
   * Called after a successful connect so the parent can refresh the streams
   * list. Receives the created eventstream's editor link (when the BFF returns
   * one) so the parent can offer an "Open eventstream editor" affordance.
   */
  onConnected?: (result?: { link?: string; eventstreamId?: string }) => void;
  /** Trigger button (rendered by parent). Optional in controlled mode. */
  trigger?: React.ReactElement;
  /**
   * Controlled-open mode (used by the on-page SourceGallery). When `open` is
   * provided the dialog is parent-controlled; `onOpenChange` reports changes.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Pre-select this connector and jump straight to its connection form. */
  initialConnector?: SourceConnector | null;
  /**
   * Pre-fill the connection form's property fields (e.g. an Event Hub name a
   * Subscribe action picked from the RTI hub catalog). Applied when the dialog
   * opens onto `initialConnector`. Keys match the connector's field keys.
   */
  initialProps?: Record<string, string> | null;
  /** Pre-fill the eventstream display name (defaults to a slug of the source). */
  initialDisplayName?: string | null;
}

export function ConnectSourceDialog({
  workspaces, defaultWorkspaceId, onConnected, trigger,
  open: openProp, onOpenChange, initialConnector, initialProps, initialDisplayName,
}: Props) {
  const styles = useStyles();
  const [openState, setOpenState] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? !!openProp : openState;
  const setOpen = (v: boolean) => { if (controlled) onOpenChange?.(v); else setOpenState(v); };
  const [category, setCategory] = useState<SourceCategory>('Microsoft sources');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<SourceConnector | null>(null);

  // When opened with a pre-selected connector, jump straight to its form —
  // honoring any pre-filled property values / display name from the caller
  // (e.g. the RTI hub Subscribe action carrying the chosen Event Hub).
  useEffect(() => {
    if (open && initialConnector) pick(initialConnector, initialProps || undefined, initialDisplayName || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialConnector, initialProps, initialDisplayName]);

  const [displayName, setDisplayName] = useState('');
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId || '');
  const [props, setProps] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [createdLink, setCreatedLink] = useState<string | null>(null);

  const connectors = useMemo(() => {
    const q = query.trim().toLowerCase();
    return SOURCE_CONNECTORS.filter((c) =>
      q ? (c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)) : c.category === category);
  }, [category, query]);

  function reset() {
    setPicked(null); setDisplayName(''); setProps({});
    setError(null); setErrorHint(null); setSuccess(null); setBusy(false);
    setCreatedLink(null);
  }

  function pick(c: SourceConnector, preProps?: Record<string, string>, preName?: string) {
    setPicked(c);
    setDisplayName(preName?.trim() || `${c.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-stream`);
    // Keep only property values whose keys this connector actually exposes.
    const allowed: Record<string, string> = {};
    if (preProps) {
      for (const f of c.fields) {
        const v = preProps[f.key];
        if (v != null && String(v).trim()) allowed[f.key] = String(v);
      }
    }
    setProps(allowed);
    setError(null); setErrorHint(null); setSuccess(null); setCreatedLink(null);
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
          workspaceId,
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
          : `Connected. Created eventstream "${displayName.trim()}" — open it to wire processing + destinations.`,
      );
      setCreatedLink(typeof j.link === 'string' ? j.link : null);
      onConnected?.({
        link: typeof j.link === 'string' ? j.link : undefined,
        eventstreamId: typeof j.eventstreamId === 'string' ? j.eventstreamId : undefined,
      });
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(_, d) => { setOpen(d.open); if (!d.open) reset(); }}>
      {trigger != null ? <span onClick={() => setOpen(true)}>{trigger}</span> : <></>}
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>{picked ? `Connect ${picked.name}` : 'Get events — connect a source'}</DialogTitle>
          <DialogContent>
            {picked ? (
              <div className={styles.form}>
                <Button appearance="subtle" className={styles.backBtn} icon={<ArrowLeft20Regular />}
                  onClick={() => { setPicked(null); setSuccess(null); }}>
                  Back to sources
                </Button>
                {(() => {
                  const v = sourceVisual(picked);
                  const Icon = v.icon;
                  return (
                    <div className={styles.formHead}>
                      <span className={styles.chip} style={{ backgroundColor: `${v.color}1f`, color: v.color }} aria-hidden>
                        <Icon style={{ width: 20, height: 20, color: v.color }} />
                      </span>
                      <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>{picked.description}</Caption1>
                    </div>
                  );
                })()}
                <Field label="Eventstream name" required>
                  <Input value={displayName} onChange={(_, d) => setDisplayName(d.value)} />
                </Field>
                <Field label="Workspace" required
                  hint="The Loom workspace to create the eventstream in (Azure-native — Event Hubs backed).">
                  <Dropdown
                    aria-label="Workspace"
                    placeholder="Select a workspace…"
                    selectedOptions={workspaceId ? [workspaceId] : []}
                    value={workspaces.find((w) => w.id === workspaceId)?.name || ''}
                    onOptionSelect={(_, d) => setWorkspaceId(d.optionValue || '')}
                  >
                    {workspaces.map((w) => <Option key={w.id} value={w.id}>{w.name}</Option>)}
                  </Dropdown>
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
                  <MessageBar intent="success">
                    <MessageBarBody>{success}</MessageBarBody>
                    {createdLink && (
                      <MessageBarActions>
                        <Link href={createdLink} style={{ textDecoration: 'none' }}>
                          <Button appearance="primary" size="small" icon={<Open20Regular />}>
                            Open eventstream editor
                          </Button>
                        </Link>
                      </MessageBarActions>
                    )}
                  </MessageBar>
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
                    {connectors.map((c) => {
                      const v = sourceVisual(c);
                      const Icon = v.icon;
                      return (
                        <button key={c.id} type="button" className={styles.card}
                          onClick={() => pick(c)} aria-label={`Connect ${c.name}`}>
                          <div className={styles.cardHead}>
                            <span className={styles.chip} style={{ backgroundColor: `${v.color}1f`, color: v.color }} aria-hidden>
                              <Icon style={{ width: 20, height: 20, color: v.color }} />
                            </span>
                            <Subtitle2 className={styles.cardName}>{c.name}</Subtitle2>
                          </div>
                          <Body1 className={styles.cardDesc}>{c.description}</Body1>
                          <div className={styles.cardTags}>
                            <Badge appearance="outline" size="small">{c.sourceType}</Badge>
                            {c.preview && <Badge appearance="outline" color="warning" size="small">Preview</Badge>}
                          </div>
                        </button>
                      );
                    })}
                    {connectors.length === 0 && (
                      <div className={styles.emptyGrid}>
                        <span className={styles.emptyGridIcon} aria-hidden>
                          <Search20Regular />
                        </span>
                        <Body1>
                          {query.trim()
                            ? <>No sources match &quot;{query.trim()}&quot;. Try a different term or pick a category.</>
                            : 'No sources in this category.'}
                        </Body1>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => { setOpen(false); reset(); }}>Close</Button>
            {picked && (
              <Button appearance="primary"
                icon={busy ? <Spinner size="tiny" /> : <PlugConnected20Regular />}
                disabled={!canConnect} onClick={connect}>
                {busy ? 'Connecting…' : 'Connect'}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
