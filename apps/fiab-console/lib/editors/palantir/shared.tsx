'use client';

/**
 * Palantir-class editors — SHARED module.
 *
 * Styles (useStyles), the CodeBlock viewer, the useItemState persistence hook,
 * SaveStrip / SectionHead chrome, and the ontology-binding hook + its types —
 * everything used by 2+ of the palantir editors. Extracted verbatim from
 * palantir-editors.tsx (behavior-preserving split — zero logic change).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import {
  Title2, Subtitle2, Body1, Caption1, Badge, Button, Input, Textarea, Spinner, Switch, Divider,
  Tab, TabList, Field, Dropdown, Option, Checkbox, SearchBox,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Accordion, AccordionItem, AccordionHeader, AccordionPanel,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Dismiss16Regular, Link20Regular, Code20Regular,
  Flash20Regular, Rocket20Regular, Play20Regular, Database20Regular,
  Copy16Regular, Checkmark16Regular, BrainCircuit20Regular,
  History20Regular, Bug20Regular,
  ArrowSwap20Regular, People20Regular, Tag20Regular, ChevronRight20Regular,
  CheckmarkCircle20Regular, DismissCircle20Regular, Cloud20Regular, Branch20Regular,
  Settings20Regular, Warning20Regular, Pulse20Regular, Alert20Regular,
  ArrowUp16Regular, ArrowDown16Regular, Wrench20Regular, Braces20Regular,
  Clock20Regular, DataHistogram20Regular, TextField20Regular, Beaker20Regular,
  Globe20Regular, CloudArrowUp20Regular, Open20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from '../item-editor-chrome';
import { NewItemCreateGate } from '../new-item-gate';
import { SlateAppBuilder, type SlateQueryDef, type SlateWidgetDef, type SlateVariable } from '../slate/slate-app-builder';
import { WorkshopAppBuilder, type WorkshopWidget, type WorkshopVariable } from '../workshop/workshop-app-builder';
import { deriveObjectProperties } from '../_palantir-codegen';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import {
  CHECK_TYPE_LIBRARY, CHECK_FAMILY_META, COMPARISON_OPERATORS, AGGREGATIONS,
  buildCheckQuery, type CheckTypeDef, type CheckFamily, type CheckField,
} from '@/app/api/items/health-check/_lib/check-types';
import type { OntologyEntityBinding } from '../_family-utils';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

export const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  section: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow, transform', transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': { boxShadow: tokens.shadow16, transform: 'translateY(-1px)' },
  },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  sectionIcon: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px',
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1,
  },
  hint: { color: tokens.colorNeutralForeground3, minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  addBar: {
    display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap',
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground2,
  },
  row: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
  },
  spacer: { flex: 1 },
  grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: tokens.spacingHorizontalM },
  modeBar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  trace: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2, border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  traceHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  codeWrap: {
    display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0,
    borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  codeHead: {
    display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    backgroundColor: tokens.colorNeutralBackground3, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  code: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, lineHeight: '18px',
    whiteSpace: 'pre', overflow: 'auto', minHeight: '120px', maxHeight: '60vh', margin: 0,
    resize: 'vertical', boxSizing: 'border-box',
    padding: tokens.spacingVerticalM, backgroundColor: tokens.colorNeutralBackground2,
  },
  tableWrap: { overflowX: 'auto', minWidth: 0, borderRadius: tokens.borderRadiusLarge, border: `1px solid ${tokens.colorNeutralStroke2}`, boxShadow: tokens.shadow4 },
  empty: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalXL, color: tokens.colorNeutralForeground3, textAlign: 'center',
    borderRadius: tokens.borderRadiusMedium, border: `1px dashed ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  saveStrip: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS, borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  fieldWide: { minWidth: '280px' },
  fieldStep: { minWidth: '260px' },
  fieldMed: { minWidth: '200px' },
  fieldNarrow: { minWidth: '140px' },
  mutedCaption: { color: tokens.colorNeutralForeground3 },
  errorCaption: { color: tokens.colorPaletteRedForeground1 },
  dialogForm: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 'min(420px, 100%)', maxWidth: '100%' },
  dialogScroll: { maxHeight: '52vh', overflowY: 'auto', paddingRight: tokens.spacingHorizontalXS },
  scopeBar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  scopeScroll: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    maxHeight: '40vh', overflowY: 'auto', paddingRight: tokens.spacingHorizontalXS, minWidth: 0,
  },
  chipBar: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, alignItems: 'center', minWidth: 0 },
  rowText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  tabStrip: { paddingBottom: tokens.spacingVerticalXS },
  pipelineLane: { display: 'flex', alignItems: 'stretch', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', overflowX: 'auto', paddingBottom: tokens.spacingVerticalS, minWidth: 0 },
  stageCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: '200px', maxWidth: '320px',
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
  },
  connector: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: tokens.spacingVerticalXXS, color: tokens.colorNeutralForeground3, alignSelf: 'center', minWidth: '44px',
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0, flexWrap: 'wrap' },
  cardActions: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', alignItems: 'center' },
  kv: { display: 'flex', justifyContent: 'space-between', gap: tokens.spacingHorizontalS, minWidth: 0 },
  statGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: tokens.spacingHorizontalM, minWidth: 0 },
  statTile: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow, transform', transitionDuration: tokens.durationNormal, transitionTimingFunction: tokens.curveEasyEase,
    ':hover': { boxShadow: tokens.shadow16, transform: 'translateY(-1px)' },
  },
  statHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, color: tokens.colorNeutralForeground3 },
  cTotal: { color: tokens.colorBrandForeground1 },
  cHealthy: { color: tokens.colorPaletteGreenForeground1 },
  cFiring: { color: tokens.colorPaletteRedForeground1 },
  cDisabled: { color: tokens.colorNeutralForeground3 },
  runPanel: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2, border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  rowActions: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end' },
  blockCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow', transitionDuration: tokens.durationNormal, transitionTimingFunction: tokens.curveEasyEase,
    ':hover': { boxShadow: tokens.shadow8 },
  },
  blockCardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  blockIcon: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: '30px', height: '30px', flexShrink: 0,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1,
  },
  blockBody: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  blockGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: tokens.spacingHorizontalM, minWidth: 0 },
  toolCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2,
  },
  blockConnector: { display: 'flex', alignItems: 'center', justifyContent: 'center', color: tokens.colorNeutralForeground4, paddingTop: tokens.spacingVerticalXXS, paddingBottom: tokens.spacingVerticalXXS },
  outPill: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS,
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
  },
  checkTile: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0, textAlign: 'left', cursor: 'pointer',
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow, transform', transitionDuration: tokens.durationNormal, transitionTimingFunction: tokens.curveEasyEase,
    ':hover': { boxShadow: tokens.shadow16, transform: 'translateY(-1px)', border: `1px solid ${tokens.colorBrandStroke1}` },
    ':focus-visible': { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '2px' },
  },
  checkTileHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  checkTileIcon: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', flexShrink: 0,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1,
  },
  galleryFamily: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
});

/** Code/output viewer with a working copy-to-clipboard control. */
export function CodeBlock({ content, ariaLabel }: { content: string; ariaLabel?: string }) {
  const s = useStyles();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard blocked; pre is still selectable */ });
  }, [content]);
  return (
    <div className={s.codeWrap}>
      <div className={s.codeHead}>
        <Button size="small" appearance="subtle" icon={copied ? <Checkmark16Regular /> : <Copy16Regular />} onClick={copy} disabled={!content}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className={s.code} aria-label={ariaLabel} tabIndex={0}>{content}</pre>
    </div>
  );
}

// ───────────────────────── shared state hook ─────────────────────────
export interface ItemDoc { id: string; displayName: string; state?: Record<string, unknown>; updatedAt?: string }

export function useItemState<T extends Record<string, unknown>>(slug: string, id: string, fallback: T) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [state, setStateRaw] = useState<T>(fallback);
  const [dirty, setDirty] = useState(false);
  const suppressDirty = useRef(false);

  const setState = useCallback<typeof setStateRaw>((updater) => {
    setStateRaw(updater as any);
    if (!suppressDirty.current) setDirty(true);
  }, []);

  const load = useCallback(async () => {
    if (!id || id === 'new') { setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/items/${slug}/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!r.ok) { setError(j?.error || `HTTP ${r.status}`); return; }
      const doc = j as ItemDoc;
      if (doc.state && typeof doc.state === 'object') {
        suppressDirty.current = true;
        setStateRaw({ ...fallback, ...(doc.state as T) });
        setDirty(false);
        queueMicrotask(() => { suppressDirty.current = false; });
      }
      setSavedAt(doc.updatedAt || null);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, id]);
  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (next?: T) => {
    setSaving(true); setError(null);
    if (!id || id === 'new') { setError('Save the item first (no id yet).'); setSaving(false); return false; }
    try {
      const r = await fetch(`/api/items/${slug}/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: next ?? state }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j?.error || `HTTP ${r.status}`); return false; }
      setSavedAt(j?.updatedAt || new Date().toISOString());
      setDirty(false);
      return true;
    } catch (e: any) { setError(e?.message || String(e)); return false; }
    finally { setSaving(false); }
  }, [slug, id, state]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (dirty && !saving) save(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, saving, save]);

  return { state, setState, loading, saving, error, savedAt, save, reload: load, dirty };
}

export function SaveStrip({ saving, savedAt, error, dirty, onSave }: {
  saving: boolean; savedAt: string | null; error: string | null; dirty: boolean; onSave: () => void;
}) {
  const s = useStyles();
  return (
    <div className={s.saveStrip}>
      <Button appearance="primary" onClick={onSave} disabled={saving || !dirty}>
        {saving ? 'Saving…' : !dirty ? 'Saved' : 'Save (Ctrl+S)'}
      </Button>
      {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
      {savedAt && !saving && <Caption1 className={s.mutedCaption}>Saved {new Date(savedAt).toLocaleTimeString()}</Caption1>}
      {error && <Caption1 className={s.errorCaption}>{error}</Caption1>}
    </div>
  );
}

export function SectionHead({ icon, title, hint }: { icon: ReactNode; title: string; hint: string }) {
  const s = useStyles();
  return (
    <div className={s.sectionHead}>
      <span className={s.sectionIcon}>{icon}</span>
      <div>
        <Subtitle2>{title}</Subtitle2>
        <Caption1 as="p" block className={s.hint}>{hint}</Caption1>
      </div>
    </div>
  );
}

export interface OntologySummary { id: string; displayName: string; workspaceId: string; classCount: number }
export interface OntologyClassLite { name: string; parent?: string; description?: string }
export interface OntologyActionLite { name: string; objectType: string; kind: 'create' | 'update' | 'delete'; params?: string[] }
export interface OntologySurface {
  id: string; displayName: string; classes: OntologyClassLite[];
  links: Array<{ from: string; to: string; kind: string }>;
  bindings: OntologyEntityBinding[];
  actionTypes?: OntologyActionLite[];
}

/** Shared hook: load the bind-ontology surface for an ontology-bound item type. */
export function useOntologyBinding(slug: string, id: string) {
  const [ontologies, setOntologies] = useState<OntologySummary[]>([]);
  const [boundOntologyId, setBoundOntologyId] = useState<string>('');
  const [surface, setSurface] = useState<OntologySurface | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await fetch(`/api/items/${slug}/${encodeURIComponent(id)}/bind-ontology`);
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) { setLoaded(true); return; }
      const j = await r.json();
      if (j?.ok) {
        setOntologies(Array.isArray(j.ontologies) ? j.ontologies : []);
        setBoundOntologyId(j.boundOntologyId || '');
        setSurface(j.surface || null);
      }
    } catch { /* surfaced on action */ }
    finally { setLoaded(true); }
  }, [slug, id]);
  useEffect(() => { void reload(); }, [reload]);

  const bind = useCallback(async (ontologyId: string) => {
    if (!ontologyId) { setMsg({ intent: 'error', text: 'Pick an ontology.' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/items/${slug}/${encodeURIComponent(id)}/bind-ontology`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ontologyId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
      setBoundOntologyId(ontologyId);
      setSurface(j.surface || null);
      setMsg({ intent: 'success', text: `Bound to ontology "${j.surface?.displayName || ontologyId}" (${j.surface?.classes?.length ?? 0} object types).` });
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [slug, id]);

  return { ontologies, boundOntologyId, surface, loaded, busy, msg, bind };
}
