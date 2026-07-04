'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * NewItemGate — shared `/new` create surface for focused editors.
 *
 * Background: every focused editor short-circuits on `id === 'new'` because no
 * Cosmos record exists yet, so its real Save / Run / Deploy / Publish actions
 * have nothing to act on. The old behaviour was a dead-end MessageBar ("create
 * this from the workspace catalog") with every ribbon/primary button disabled —
 * which reads as vaporware (a primary action that is never clickable).
 *
 * This component replaces that dead end with a real, enabled primary action:
 *
 *   mode="create" (default)
 *     Workspace dropdown + display-name input + an ENABLED primary "Create"
 *     button. Clicking it POSTs `/api/cosmos-items/<slug>` (real Cosmos write)
 *     and navigates to `/items/<slug>/<newId>`, where the full editor takes
 *     over with its real backend-wired actions.
 *
 *   mode="browse"
 *     For read-only registry editors (e.g. AML model / experiment registries
 *     where entities are authored in Azure ML, not Loom). Lists the real
 *     entities from the supplied endpoint; the primary action "Open" navigates
 *     to the selected real item. No fake create.
 *
 * Honest gates: if no workspaces exist (create mode) or the registry endpoint
 * returns an error / 503 (browse mode), a Fluent MessageBar intent="warning"
 * explains the exact next step. No mock data, no dead buttons.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Label, Spinner, Dropdown, Option,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add20Regular, Open20Regular } from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, maxWidth: '640px', minWidth: 0 },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  actions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalM, alignItems: 'center', marginTop: tokens.spacingVerticalXS },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalXS, minWidth: 0 },
  row: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    cursor: 'pointer', minWidth: 0,
  },
  rowActive: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`, border: `2px solid ${tokens.colorBrandStroke1}`, borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorBrandBackground2, cursor: 'pointer', minWidth: 0,
  },
  rowText: { minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  errText: { overflowWrap: 'anywhere', wordBreak: 'break-word' },
});

interface WorkspaceLite { id: string; name: string }

function useLoomWorkspaces() {
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const r = await clientFetch('/api/loom/workspaces');
        const j = await r.json();
        if (!j.ok) { setError(j.error || `HTTP ${r.status}`); setWorkspaces([]); }
        else { setWorkspaces(j.workspaces || []); }
      } catch (e: any) { setError(e?.message || String(e)); setWorkspaces([]); }
      finally { setLoading(false); }
    })();
  }, []);
  return { workspaces, error, loading };
}

// ---------------------------------------------------------------------------
// Create mode
// ---------------------------------------------------------------------------

interface CreateGateProps {
  item: FabricItemType;
  /** What the primary button reads ("Create environment", etc.). */
  createLabel?: string;
  /** Optional intro explaining what the editor does once created. */
  intro?: string;
}

export function NewItemCreateGate({ item, createLabel, intro }: CreateGateProps) {
  const s = useStyles();
  const router = useRouter();
  const ws = useLoomWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsName = (ws.workspaces || []).find((w) => w.id === workspaceId)?.name || '';
  const canCreate = !busy && !!workspaceId && !!displayName.trim();

  const create = useCallback(async () => {
    if (!canCreate) return;
    setBusy(true); setError(null);
    try {
      const r = await clientFetch(`/api/cosmos-items/${encodeURIComponent(item.slug)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, displayName: displayName.trim() }),
      });
      const j = await r.json();
      if (!j.ok || !j.item?.id) throw new Error(j.error || `HTTP ${r.status}`);
      router.push(`/items/${encodeURIComponent(item.slug)}/${encodeURIComponent(j.item.id)}`);
    } catch (e: any) { setError(e?.message || String(e)); setBusy(false); }
  }, [canCreate, item.slug, workspaceId, displayName, router]);

  const primary = createLabel || `Create ${item.displayName.toLowerCase()}`;
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'New', actions: [
        { label: busy ? 'Creating…' : primary, onClick: canCreate ? create : undefined, disabled: !canCreate,
          title: !workspaceId ? 'Select a workspace' : !displayName.trim() ? 'Enter a name' : undefined },
      ]},
    ]},
  ], [busy, primary, canCreate, create, workspaceId, displayName]);

  const noWorkspaces = !ws.loading && (ws.workspaces?.length ?? 0) === 0;

  return (
    <ItemEditorChrome item={item} id="new" ribbon={ribbon} main={
      <div className={s.pad}>
        <Subtitle2>New {item.displayName.toLowerCase()}</Subtitle2>
        {intro && <Body1>{intro}</Body1>}

        {ws.error && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Workspaces not reachable</MessageBarTitle>
              <span className={s.errText}>{ws.error}</span>
              <br /><Caption1>Cosmos `workspaces` container must be reachable and the Console UAMI granted data access.</Caption1>
            </MessageBarBody>
          </MessageBar>
        )}
        {noWorkspaces && !ws.error && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>No workspaces yet</MessageBarTitle>
              Create a workspace first (Home → New workspace), then return to create a {item.displayName.toLowerCase()}.
            </MessageBarBody>
          </MessageBar>
        )}
        {error && (
          <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Create failed</MessageBarTitle><span className={s.errText}>{error}</span></MessageBarBody></MessageBar>
        )}

        <div className={s.field}>
          <Label htmlFor="ng-ws">Workspace</Label>
          <Dropdown
            id="ng-ws"
            placeholder={ws.loading ? 'Loading workspaces…' : noWorkspaces ? 'No workspaces available' : 'Select a workspace'}
            value={wsName}
            selectedOptions={workspaceId ? [workspaceId] : []}
            disabled={ws.loading || noWorkspaces}
            onOptionSelect={(_, d) => setWorkspaceId(d.optionValue || '')}
          >
            {(ws.workspaces || []).map((w) => (
              <Option key={w.id} value={w.id}>{w.name}</Option>
            ))}
          </Dropdown>
        </div>

        <div className={s.field}>
          <Label htmlFor="ng-name">Name</Label>
          <Input id="ng-name" value={displayName} onChange={(_, d) => setDisplayName(d.value)}
            placeholder={`My ${item.displayName.toLowerCase()}`}
            onKeyDown={(e) => { if (e.key === 'Enter' && canCreate) create(); }} />
        </div>

        <div className={s.actions}>
          <Button appearance="primary" icon={<Add20Regular />} onClick={create} disabled={!canCreate}>
            {busy ? 'Creating…' : primary}
          </Button>
          {busy && <Spinner size="tiny" />}
        </div>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Creates the item in Cosmos and opens the full editor, where its configuration and primary action run against the real backend.
        </Caption1>
      </div>
    } />
  );
}

// ---------------------------------------------------------------------------
// Browse mode (read-only registries)
// ---------------------------------------------------------------------------

interface BrowseEntity { id: string; name: string; detail?: string; badge?: string }

interface BrowseGateProps {
  item: FabricItemType;
  /** BFF endpoint returning { ok, ...listKey } */
  endpoint: string;
  /** Key in the JSON response holding the array (e.g. 'models', 'experiments'). */
  listKey: string;
  /** Map a raw list element to a display row. */
  mapEntity: (raw: any) => BrowseEntity;
  /** What the slug for the opened item is (usually item.slug). */
  openSlug: string;
  intro?: string;
  /** Honest gate hint shown when the endpoint errors (env var / role to set). */
  gateHint?: string;
  /**
   * External authoring surface (e.g. Azure ML Studio). Rendered as an
   * always-enabled secondary affordance so the page is never a dead end even
   * when the registry is empty or unreachable. Label defaults to "Open studio".
   */
  studioUrl?: string;
  studioLabel?: string;
}

export function NewItemBrowseGate({ item, endpoint, listKey, mapEntity, openSlug, intro, gateHint, studioUrl, studioLabel }: BrowseGateProps) {
  const s = useStyles();
  const router = useRouter();
  const [rows, setRows] = useState<BrowseEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(endpoint);
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); setRows([]); }
      else {
        const mapped = ((j[listKey] as any[]) || []).map(mapEntity);
        setRows(mapped);
        // Auto-select the first row so the primary "Open" enables immediately
        // instead of sitting disabled until a manual click. Matches the
        // auto-pick-first-workspace pattern in the Fabric editors. Users can
        // still pick a different row.
        setSelected((prev) => prev || (mapped[0]?.id ?? null));
      }
    } catch (e: any) { setError(e?.message || String(e)); setRows([]); }
    finally { setLoading(false); }
  }, [endpoint, listKey, mapEntity]);

  useEffect(() => { load(); }, [load]);

  const open = useCallback(() => {
    if (!selected) return;
    router.push(`/items/${encodeURIComponent(openSlug)}/${encodeURIComponent(selected)}`);
  }, [selected, openSlug, router]);

  const openStudio = useCallback(() => {
    if (studioUrl) { try { window.open(studioUrl, '_blank', 'noreferrer'); } catch { /* popup blocked */ } }
  }, [studioUrl]);

  const canOpen = !!selected && !loading;
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Registry', actions: [
        { label: 'Open', onClick: canOpen ? open : undefined, disabled: !canOpen, title: !selected ? 'Select an entry first' : undefined },
        { label: loading ? 'Loading…' : 'Refresh', onClick: loading ? undefined : load, disabled: loading },
        ...(studioUrl ? [{ label: studioLabel || 'Open studio', onClick: openStudio, disabled: false }] : []),
      ]},
    ]},
  ], [canOpen, open, selected, loading, load, studioUrl, studioLabel, openStudio]);

  return (
    <ItemEditorChrome item={item} id="new" ribbon={ribbon} main={
      <div className={s.pad}>
        <Subtitle2>{item.displayName} registry</Subtitle2>
        {intro && <Body1>{intro}</Body1>}

        {loading && <Spinner size="small" label="Loading registry…" labelPosition="after" />}
        {error && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Registry not reachable</MessageBarTitle>
              <span className={s.errText}>{error}</span>
              {gateHint && <><br /><Caption1>{gateHint}</Caption1></>}
            </MessageBarBody>
          </MessageBar>
        )}
        {!loading && !error && rows.length === 0 && (
          <MessageBar intent="info">
            <MessageBarBody>No entries registered yet.{gateHint ? ` ${gateHint}` : ''}</MessageBarBody>
          </MessageBar>
        )}

        <div className={s.list}>
          {rows.map((r) => (
            <div key={r.id} className={selected === r.id ? s.rowActive : s.row}
              onClick={() => setSelected(r.id)} role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') setSelected(r.id); }}>
              <div className={s.rowText}>
                <Body1><strong>{r.name}</strong></Body1>
                {r.detail && <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>{r.detail}</Caption1>}
              </div>
              {r.badge && <Badge appearance="outline">{r.badge}</Badge>}
            </div>
          ))}
        </div>

        <div className={s.actions}>
          <Button appearance="primary" icon={<Open20Regular />} onClick={open} disabled={!canOpen}>Open</Button>
          {studioUrl && (
            <Button appearance="secondary" icon={<Open20Regular />} onClick={openStudio}>
              {studioLabel || 'Open studio'}
            </Button>
          )}
        </div>
      </div>
    } />
  );
}
