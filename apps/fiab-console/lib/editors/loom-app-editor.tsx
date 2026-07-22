'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * LoomAppEditor — org app builder (Fabric / Power BI org-app parity, Azure-native).
 *
 * Bundle existing workspace items into a distributable, audience-scoped app:
 *   • Content — pick items from the workspace (real Cosmos inventory via
 *     /candidates), order them, assign nav sections.
 *   • Navigation — manage + reorder the nav sections.
 *   • Audiences — named audiences with an access list + a visible-content subset
 *     (the Fabric org-app "audiences" model on Loom's access layer).
 *   • Publish — publish to a consumer app view at /apps/view/<id>; Preview resolves
 *     the same manifest the consumer sees (/render).
 *
 * Everything persists to Cosmos as the item's `state` (useItemState → PATCH
 * /api/items/loom-app/[id]); no Fabric or Power BI workspace is required
 * (.claude/rules/no-fabric-dependency.md, no-vaporware.md, ui-parity.md).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Title3, Subtitle2, Body1, Caption1, Badge, Button, Input, Spinner,
  Tab, TabList, Field, Dropdown, Option, Checkbox, SearchBox, Divider,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Dismiss16Regular, ArrowUp16Regular, ArrowDown16Regular,
  Apps20Regular, People20Regular, CloudArrowUp20Regular,
  Open20Regular, Eye20Regular, Board20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemCreateGate } from './new-item-gate';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { useRegisterRibbonCommands } from '@/lib/components/shared/ribbon-commands';
import { useItemState, SaveStrip, SectionHead, useStyles } from './palantir/shared';
import { getItemTypeIcon } from '@/lib/components/item-type-icon';
import { findItemType } from '@/lib/catalog/fabric-item-types';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import {
  EMPTY_LOOM_APP, newLocalId,
  type LoomAppDefinition, type LoomAppContentEntry, type LoomAppAudience,
} from './loom-app-model';

interface Candidate { itemId: string; itemType: string; displayName: string; updatedAt: string | null }

const useLocal = makeStyles({
  tabs: { marginBottom: tokens.spacingVerticalM },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  grow: { flexGrow: 1, minWidth: 0 },
  chips: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalXS },
  chip: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
  itemName: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  audienceCard: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingVerticalM,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    boxShadow: tokens.shadow2,
  },
  subsetGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: tokens.spacingVerticalXS, marginTop: tokens.spacingVerticalXS,
  },
  navGroup: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, marginBottom: tokens.spacingVerticalM },
  navItem: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground1,
    // Native <button>: without an explicit color, text inherits UA ButtonText (black-on-dark).
    color: tokens.colorNeutralForeground1,
  },
});

const NO_SECTION = '__none__';

export function LoomAppEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const l = useLocal();
  const router = useRouter();
  const { state, setState, loading, saving, error, savedAt, save, reload, dirty } =
    useItemState<LoomAppDefinition>('loom-app', id, EMPTY_LOOM_APP);

  const [tab, setTab] = useState('content');
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [candErr, setCandErr] = useState<string | null>(null);
  const [candQuery, setCandQuery] = useState('');

  // Publish + preview state
  const [pubBusy, setPubBusy] = useState(false);
  const [pubMsg, setPubMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [preview, setPreview] = useState<PreviewManifest | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewMsg, setPreviewMsg] = useState<string | null>(null);

  const content = useMemo(() => (Array.isArray(state.content) ? state.content : []), [state.content]);
  const sections = useMemo(() => (Array.isArray(state.sections) ? state.sections : []), [state.sections]);
  const audiences = useMemo(() => (Array.isArray(state.audiences) ? state.audiences : []), [state.audiences]);
  const addedIds = useMemo(() => new Set(content.map((c) => c.itemId)), [content]);

  // Load the real, live workspace inventory the app can bundle.
  useEffect(() => {
    if (!id || id === 'new') return;
    let cancelled = false;
    setCandErr(null);
    clientFetch(`/api/items/loom-app/${encodeURIComponent(id)}/candidates`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!j?.ok) { setCandErr(j?.error || `HTTP ${r.status}`); setCandidates([]); return; }
        setCandidates(Array.isArray(j.items) ? j.items : []);
      })
      .catch((e) => { if (!cancelled) { setCandErr(String(e?.message || e)); setCandidates([]); } });
    return () => { cancelled = true; };
  }, [id]);

  // ── Content mutations ─────────────────────────────────────────────
  const addContent = useCallback((c: Candidate) => {
    setState((p) => {
      const cur = Array.isArray(p.content) ? p.content : [];
      if (cur.some((e) => e.itemId === c.itemId)) return p;
      const entry: LoomAppContentEntry = { itemId: c.itemId, itemType: c.itemType, displayName: c.displayName };
      return { ...p, content: [...cur, entry] };
    });
  }, [setState]);

  const removeContent = useCallback((itemId: string) => {
    setState((p) => ({ ...p, content: (p.content || []).filter((e) => e.itemId !== itemId) }));
  }, [setState]);

  const moveContent = useCallback((idx: number, dir: -1 | 1) => {
    setState((p) => {
      const arr = [...(p.content || [])];
      const j = idx + dir;
      if (j < 0 || j >= arr.length) return p;
      [arr[idx], arr[j]] = [arr[j], arr[idx]];
      return { ...p, content: arr };
    });
  }, [setState]);

  const setEntrySection = useCallback((itemId: string, section: string) => {
    setState((p) => ({
      ...p,
      content: (p.content || []).map((e) => e.itemId === itemId ? { ...e, section: section === NO_SECTION ? undefined : section } : e),
    }));
  }, [setState]);

  // ── Section mutations ─────────────────────────────────────────────
  const [newSection, setNewSection] = useState('');
  const addSection = useCallback(() => {
    const name = newSection.trim();
    if (!name) return;
    setState((p) => {
      const cur = Array.isArray(p.sections) ? p.sections : [];
      if (cur.includes(name)) return p;
      return { ...p, sections: [...cur, name] };
    });
    setNewSection('');
  }, [newSection, setState]);

  const removeSection = useCallback((name: string) => {
    setState((p) => ({
      ...p,
      sections: (p.sections || []).filter((x) => x !== name),
      content: (p.content || []).map((e) => e.section === name ? { ...e, section: undefined } : e),
    }));
  }, [setState]);

  const moveSection = useCallback((idx: number, dir: -1 | 1) => {
    setState((p) => {
      const arr = [...(p.sections || [])];
      const j = idx + dir;
      if (j < 0 || j >= arr.length) return p;
      [arr[idx], arr[j]] = [arr[j], arr[idx]];
      return { ...p, sections: arr };
    });
  }, [setState]);

  // ── Audience mutations ────────────────────────────────────────────
  const [newAudience, setNewAudience] = useState('');
  const addAudience = useCallback(() => {
    const name = newAudience.trim();
    if (!name) return;
    setState((p) => ({
      ...p,
      audiences: [...(p.audiences || []), { id: newLocalId('aud'), name, principals: [], itemIds: [] }],
    }));
    setNewAudience('');
  }, [newAudience, setState]);

  const removeAudience = useCallback((audId: string) => {
    setState((p) => ({ ...p, audiences: (p.audiences || []).filter((a) => a.id !== audId) }));
  }, [setState]);

  const updateAudience = useCallback((audId: string, patch: Partial<LoomAppAudience>) => {
    setState((p) => ({ ...p, audiences: (p.audiences || []).map((a) => a.id === audId ? { ...a, ...patch } : a) }));
  }, [setState]);

  // ── Publish + preview ─────────────────────────────────────────────
  const publish = useCallback(async (unpublish = false) => {
    setPubBusy(true); setPubMsg(null);
    try {
      if (dirty) await save();
      const r = await clientFetch(`/api/items/loom-app/${encodeURIComponent(id)}/publish`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(unpublish ? { unpublish: true } : {}),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setPubMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
      if (unpublish) setPubMsg({ intent: 'warning', text: 'App unpublished — consumers can no longer open it.' });
      else setPubMsg({ intent: 'success', text: `Published v${j.version}. Consumer app view is live at ${j.url}.` });
      await reload();
    } catch (e: any) { setPubMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setPubBusy(false); }
  }, [id, dirty, save, reload]);

  const runPreview = useCallback(async () => {
    setPreviewBusy(true); setPreviewMsg(null);
    try {
      if (dirty) await save();
      const r = await clientFetch(`/api/items/loom-app/${encodeURIComponent(id)}/render`);
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setPreviewMsg(j?.error || `HTTP ${r.status}`); setPreview(null); return; }
      setPreview(j.app as PreviewManifest);
    } catch (e: any) { setPreviewMsg(e?.message || String(e)); setPreview(null); }
    finally { setPreviewBusy(false); }
  }, [id, dirty, save]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'App', actions: [
        { label: saving ? 'Saving…' : 'Save', icon: <CloudArrowUp20Regular />, onClick: () => save(), disabled: saving || !dirty },
      ]},
      { label: 'Distribute', actions: [
        { label: 'Publish', icon: <CloudArrowUp20Regular />, onClick: () => { setTab('publish'); void publish(false); }, disabled: pubBusy || content.length === 0 },
        { label: 'Open app', icon: <Open20Regular />, onClick: () => window.open(`/apps/view/${encodeURIComponent(id)}`, '_blank', 'noopener'), disabled: !state.published },
      ]},
    ]},
  ], [save, saving, dirty, publish, pubBusy, content.length, state.published, id]);

  useRegisterRibbonCommands(ribbon, 'loom-app');

  if (id === 'new') {
    return <NewItemCreateGate item={item}
      createLabel="Create Loom app"
      intro="An org app that bundles your workspace items — reports, dashboards, notebooks and more — into a distributable, audience-scoped app. Azure-native: the definition and audiences persist to Cosmos and the published view reuses Loom's existing item routes + access model. No Power BI or Fabric workspace required." />;
  }

  const filteredCandidates = (candidates || []).filter((c) => {
    if (addedIds.has(c.itemId)) return false;
    const q = candQuery.trim().toLowerCase();
    if (!q) return true;
    return c.displayName.toLowerCase().includes(q) || c.itemType.toLowerCase().includes(q);
  });

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} dirty={dirty} commandSearch main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <TeachingBanner
          surfaceKey="loom-app-builder"
          title="Bundle workspace items into an org app"
          message="Pick items from this workspace, group them into navigation sections, scope them to audiences, then publish a consumer app view. Azure-native: the definition and audiences persist to Cosmos and the published view reuses Loom's item routes + access model — no Power BI or Microsoft Fabric workspace required."
          learnMoreHref="https://learn.microsoft.com/power-bi/collaborate-share/service-create-distribute-apps"
        />

        {state.published ? (
          <MessageBar intent="success"><MessageBarBody>
            <MessageBarTitle>Published (v{state.version || 1})</MessageBarTitle>
            The consumer app view is live.
            <Button appearance="transparent" size="small" icon={<Open20Regular />}
              onClick={() => window.open(`/apps/view/${encodeURIComponent(id)}`, '_blank', 'noopener')}>Open app</Button>
          </MessageBarBody></MessageBar>
        ) : null}

        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)} className={l.tabs}>
          <Tab value="content" icon={<Apps20Regular />}>Content <Badge appearance="tint" color="informative">{content.length}</Badge></Tab>
          <Tab value="navigation" icon={<Board20Regular />}>Navigation <Badge appearance="tint" color="informative">{sections.length}</Badge></Tab>
          <Tab value="audiences" icon={<People20Regular />}>Audiences <Badge appearance="tint" color="informative">{audiences.length}</Badge></Tab>
          <Tab value="publish" icon={<CloudArrowUp20Regular />}>Publish</Tab>
          <Tab value="preview" icon={<Eye20Regular />}>Preview</Tab>
        </TabList>

        {/* ── Content tab ── */}
        {tab === 'content' && (
          <div className={s.section}>
            <SectionHead icon={<Apps20Regular />} title="App content" hint="Pick items from this workspace to include. The list on the left is the live workspace inventory (Cosmos-backed); added items make up the app's navigation." />
            <div className={l.row}>
              <div className={l.grow} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
                <Subtitle2>Available items</Subtitle2>
                <SearchBox placeholder="Search workspace items" value={candQuery}
                  onChange={(_, d) => setCandQuery(d.value)} />
                {candErr && <MessageBar intent="warning"><MessageBarBody>{candErr}</MessageBarBody></MessageBar>}
                {candidates === null ? (
                  <div className={s.empty}><Spinner size="tiny" label="Loading workspace items…" labelPosition="after" /></div>
                ) : filteredCandidates.length === 0 ? (
                  <div className={s.empty}><Caption1>{(candidates.length === 0) ? 'No other items in this workspace yet — create items, then bundle them here.' : 'All matching items are already added.'}</Caption1></div>
                ) : (
                  <div className={l.navGroup}>
                    {filteredCandidates.slice(0, 200).map((c) => (
                      <div key={c.itemId} className={l.navItem}>
                        <span className={l.itemName}>
                          {getItemTypeIcon(c.itemType)}
                          <Body1>{c.displayName}</Body1>
                          <Caption1 className={s.mutedCaption}>{findItemType(c.itemType)?.displayName || c.itemType}</Caption1>
                        </span>
                        <span style={{ flexGrow: 1 }} />
                        <Button size="small" appearance="primary" icon={<Add20Regular />} onClick={() => addContent(c)}>Add</Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <Divider />
            <Subtitle2>Included content ({content.length})</Subtitle2>
            {content.length === 0 ? (
              <div className={s.empty}><Caption1>No content yet — add items from the list above.</Caption1></div>
            ) : (
              <div className={s.tableWrap}>
                <Table size="small" aria-label="App content">
                  <TableHeader><TableRow>
                    <TableHeaderCell>Order</TableHeaderCell>
                    <TableHeaderCell>Item</TableHeaderCell>
                    <TableHeaderCell>Type</TableHeaderCell>
                    <TableHeaderCell>Section</TableHeaderCell>
                    <TableHeaderCell>Remove</TableHeaderCell>
                  </TableRow></TableHeader>
                  <TableBody>
                    {content.map((e, idx) => (
                      <TableRow key={e.itemId}>
                        <TableCell>
                          <Button size="small" appearance="subtle" icon={<ArrowUp16Regular />} aria-label="Move up" disabled={idx === 0} onClick={() => moveContent(idx, -1)} />
                          <Button size="small" appearance="subtle" icon={<ArrowDown16Regular />} aria-label="Move down" disabled={idx === content.length - 1} onClick={() => moveContent(idx, 1)} />
                        </TableCell>
                        <TableCell>
                          <span className={l.itemName}>{getItemTypeIcon(e.itemType)}<Body1>{e.displayName}</Body1></span>
                        </TableCell>
                        <TableCell><Caption1>{findItemType(e.itemType)?.displayName || e.itemType}</Caption1></TableCell>
                        <TableCell>
                          <Dropdown size="small" aria-label="Section"
                            value={e.section || 'Ungrouped'}
                            selectedOptions={[e.section || NO_SECTION]}
                            onOptionSelect={(_, d) => setEntrySection(e.itemId, d.optionValue || NO_SECTION)}>
                            <Option value={NO_SECTION} text="Ungrouped">Ungrouped</Option>
                            {sections.map((sec) => <Option key={sec} value={sec} text={sec}>{sec}</Option>)}
                          </Dropdown>
                        </TableCell>
                        <TableCell>
                          <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Remove" onClick={() => removeContent(e.itemId)} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}

        {/* ── Navigation tab ── */}
        {tab === 'navigation' && (
          <div className={s.section}>
            <SectionHead icon={<Board20Regular />} title="Navigation sections" hint="Group content into named sections consumers see in the app's left nav. Assign each content item to a section in the Content tab." />
            <div className={s.addBar}>
              <Field label="New section" className={s.fieldWide}>
                <Input value={newSection} onChange={(_, d) => setNewSection(d.value)} placeholder="e.g. Overview, Finance, Operations"
                  onKeyDown={(e) => { if (e.key === 'Enter') addSection(); }} />
              </Field>
              <Button appearance="primary" icon={<Add20Regular />} onClick={addSection} disabled={!newSection.trim()}>Add section</Button>
            </div>
            {sections.length === 0 ? (
              <div className={s.empty}><Caption1>No sections — content without a section shows under a default group. Add sections to organize the nav.</Caption1></div>
            ) : (
              <div className={l.navGroup}>
                {sections.map((sec, idx) => {
                  const count = content.filter((c) => c.section === sec).length;
                  return (
                    <div key={sec} className={l.navItem}>
                      <Board20Regular />
                      <Body1>{sec}</Body1>
                      <Badge appearance="tint" color="informative">{count} item{count === 1 ? '' : 's'}</Badge>
                      <span style={{ flexGrow: 1 }} />
                      <Button size="small" appearance="subtle" icon={<ArrowUp16Regular />} aria-label="Move up" disabled={idx === 0} onClick={() => moveSection(idx, -1)} />
                      <Button size="small" appearance="subtle" icon={<ArrowDown16Regular />} aria-label="Move down" disabled={idx === sections.length - 1} onClick={() => moveSection(idx, 1)} />
                      <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Remove section" onClick={() => removeSection(sec)} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Audiences tab ── */}
        {tab === 'audiences' && (
          <div className={s.section}>
            <SectionHead icon={<People20Regular />} title="Audiences" hint="Each audience has its own access list and, optionally, a subset of content it can see. With no audiences, everyone with workspace access sees the whole app." />
            <div className={s.addBar}>
              <Field label="New audience" className={s.fieldWide}>
                <Input value={newAudience} onChange={(_, d) => setNewAudience(d.value)} placeholder="e.g. Executives, Analysts"
                  onKeyDown={(e) => { if (e.key === 'Enter') addAudience(); }} />
              </Field>
              <Button appearance="primary" icon={<Add20Regular />} onClick={addAudience} disabled={!newAudience.trim()}>Add audience</Button>
            </div>
            {audiences.length === 0 ? (
              <div className={s.empty}><Caption1>No audiences defined — the app is visible to everyone with workspace access. Add an audience to scope access.</Caption1></div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                {audiences.map((a) => (
                  <AudienceCard key={a.id} className={l.audienceCard} chipClass={l.chip} chipsClass={l.chips} subsetClass={l.subsetGrid}
                    audience={a} content={content}
                    onRename={(name) => updateAudience(a.id, { name })}
                    onPrincipals={(principals) => updateAudience(a.id, { principals })}
                    onItemIds={(itemIds) => updateAudience(a.id, { itemIds })}
                    onRemove={() => removeAudience(a.id)} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Publish tab ── */}
        {tab === 'publish' && (
          <div className={s.section}>
            <SectionHead icon={<CloudArrowUp20Regular />} title="Publish" hint="Publishing mints a consumer app view at /apps/view/<id> and records a version. Consumers who belong to an audience open the app and navigate to the real items under their own identity + governance." />
            <div className={s.addBar}>
              <Button appearance="primary" icon={pubBusy ? <Spinner size="tiny" /> : <CloudArrowUp20Regular />} onClick={() => publish(false)} disabled={pubBusy || content.length === 0}>
                {state.published ? 'Re-publish' : 'Publish'}
              </Button>
              {state.published && (
                <>
                  <Button appearance="outline" icon={<Open20Regular />} onClick={() => window.open(`/apps/view/${encodeURIComponent(id)}`, '_blank', 'noopener')}>Open app</Button>
                  <Button appearance="subtle" onClick={() => publish(true)} disabled={pubBusy}>Unpublish</Button>
                </>
              )}
            </div>
            {content.length === 0 && (
              <MessageBar intent="warning"><MessageBarBody>Add at least one content item before publishing.</MessageBarBody></MessageBar>
            )}
            {pubMsg && <MessageBar intent={pubMsg.intent}><MessageBarBody>{pubMsg.text}</MessageBarBody></MessageBar>}
            {state.published && (
              <Caption1 className={s.mutedCaption}>
                Version {state.version || 1}{state.publishedAt ? ` · published ${new Date(String(state.publishedAt)).toLocaleString()}` : ''} · {content.length} item{content.length === 1 ? '' : 's'} · {audiences.length} audience{audiences.length === 1 ? '' : 's'}
              </Caption1>
            )}
          </div>
        )}

        {/* ── Preview tab ── */}
        {tab === 'preview' && (
          <div className={s.section}>
            <SectionHead icon={<Eye20Regular />} title="Preview" hint="Resolve the exact manifest a consumer sees — nav filtered by your audience membership, display names refreshed from the live items." />
            <div className={s.addBar}>
              <Button appearance="primary" icon={previewBusy ? <Spinner size="tiny" /> : <Eye20Regular />} onClick={runPreview} disabled={previewBusy}>Resolve preview</Button>
            </div>
            {previewMsg && <MessageBar intent="warning"><MessageBarBody>{previewMsg}</MessageBarBody></MessageBar>}
            {preview && <ConsumerNav manifest={preview} navGroupClass={l.navGroup} navItemClass={l.navItem} itemNameClass={l.itemName} onOpen={(href) => router.push(href)} />}
          </div>
        )}

        <SaveStrip saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
      </div>
    } />
  );
}

// ── Audience card (name + principals + visible-content subset) ──────
function AudienceCard({
  audience, content, className, chipClass, chipsClass, subsetClass,
  onRename, onPrincipals, onItemIds, onRemove,
}: {
  audience: LoomAppAudience;
  content: LoomAppContentEntry[];
  className: string; chipClass: string; chipsClass: string; subsetClass: string;
  onRename: (name: string) => void;
  onPrincipals: (principals: string[]) => void;
  onItemIds: (itemIds: string[]) => void;
  onRemove: () => void;
}) {
  const [principal, setPrincipal] = useState('');
  const principals = audience.principals || [];
  const subset = audience.itemIds || [];
  const allContent = subset.length === 0;

  const addPrincipal = () => {
    const v = principal.trim();
    if (!v) return;
    if (principals.some((p) => p.toLowerCase() === v.toLowerCase())) { setPrincipal(''); return; }
    onPrincipals([...principals, v]);
    setPrincipal('');
  };
  const toggleItem = (itemId: string, checked: boolean) => {
    const base = subset.length === 0 ? [] : subset;
    onItemIds(checked ? [...base, itemId] : base.filter((x) => x !== itemId));
  };

  return (
    <div className={className}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
        <People20Regular />
        <Field style={{ flexGrow: 1 }}>
          <Input value={audience.name} onChange={(_, d) => onRename(d.value)} aria-label="Audience name" placeholder="Audience name" />
        </Field>
        <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Remove audience" onClick={onRemove} />
      </div>

      <Field label="Access list (user email / UPN / group id)">
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
          <Input value={principal} onChange={(_, d) => setPrincipal(d.value)} placeholder="user@contoso.com or a group object id"
            style={{ flexGrow: 1 }} onKeyDown={(e) => { if (e.key === 'Enter') addPrincipal(); }} />
          <Button appearance="primary" icon={<Add20Regular />} onClick={addPrincipal} disabled={!principal.trim()}>Add</Button>
        </div>
      </Field>
      {principals.length === 0 ? (
        <Caption1 style={{ color: tokens.colorPaletteYellowForeground1 }}>No members yet — this audience grants no access until you add a principal.</Caption1>
      ) : (
        <div className={chipsClass}>
          {principals.map((p) => (
            <Badge key={p} appearance="tint" color="brand" className={chipClass}>
              {p}
              <Button size="small" appearance="transparent" icon={<Dismiss16Regular />} aria-label={`Remove ${p}`}
                onClick={() => onPrincipals(principals.filter((x) => x !== p))} />
            </Badge>
          ))}
        </div>
      )}

      <Field label="Visible content">
        <Checkbox label="All app content" checked={allContent} onChange={(_, d) => { if (d.checked) onItemIds([]); else onItemIds(content.map((c) => c.itemId)); }} />
        {!allContent && (
          <div className={subsetClass}>
            {content.map((c) => (
              <Checkbox key={c.itemId} label={c.displayName} checked={subset.includes(c.itemId)}
                onChange={(_, d) => toggleItem(c.itemId, Boolean(d.checked))} />
            ))}
          </div>
        )}
      </Field>
    </div>
  );
}

// ── Consumer nav (shared preview + /apps view rendering shape) ──────
interface PreviewNavItem { itemId: string; itemType: string; displayName: string; section: string; href: string }
interface PreviewNavGroup { section: string; items: PreviewNavItem[] }
export interface PreviewManifest {
  id: string; displayName: string; description: string;
  published: boolean; publishedAt: string | null; version: number;
  audiences: string[]; itemCount: number; nav: PreviewNavGroup[];
}

export function ConsumerNav({ manifest, navGroupClass, navItemClass, itemNameClass, onOpen }: {
  manifest: PreviewManifest;
  navGroupClass: string; navItemClass: string; itemNameClass: string;
  onOpen: (href: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
      <div>
        <Title3>{manifest.displayName}</Title3>
        {manifest.description && <Body1 block>{manifest.description}</Body1>}
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalXS, flexWrap: 'wrap' }}>
          {manifest.published ? <Badge appearance="tint" color="success">Published v{manifest.version}</Badge> : <Badge appearance="tint" color="warning">Draft</Badge>}
          <Badge appearance="tint" color="informative">{manifest.itemCount} item{manifest.itemCount === 1 ? '' : 's'}</Badge>
          {manifest.audiences.map((a) => <Badge key={a} appearance="outline" color="brand">{a}</Badge>)}
        </div>
      </div>
      {manifest.nav.length === 0 ? (
        <MessageBar intent="info"><MessageBarBody>No content is visible to you in this app.</MessageBarBody></MessageBar>
      ) : manifest.nav.map((g, gi) => (
        <div key={g.section || `g${gi}`} className={navGroupClass}>
          <Subtitle2>{g.section || 'Content'}</Subtitle2>
          {g.items.map((it) => (
            <button key={it.itemId} type="button" className={navItemClass} onClick={() => onOpen(it.href)} style={{ cursor: 'pointer', textAlign: 'left' }}>
              <span className={itemNameClass}>{getItemTypeIcon(it.itemType)}<Body1>{it.displayName}</Body1></span>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{findItemType(it.itemType)?.displayName || it.itemType}</Caption1>
              <span style={{ flexGrow: 1 }} />
              <Open20Regular />
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
