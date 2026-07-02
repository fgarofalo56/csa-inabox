'use client';

/**
 * canvas-elements — Wave-7 of the Loom Report Designer. The SIBLING registry that
 * holds ALL "Insert" element logic (Power BI parity, grounded in
 * learn.microsoft.com/power-bi/create-reports/power-bi-text-boxes,
 * .../desktop-shapes, .../buttons, and .../button-navigators) so the report-designer
 * host stays thin:
 *
 *   • the model + types (CanvasElement / FieldToken / ButtonAction …),
 *   • the pure helpers (parseElements / wireElements / newElement / tokenToSpec /
 *     tokenSig / formatTokenValue),
 *   • the per-kind node renderers (renderElement / renderElementChrome),
 *   • the insert gallery (ElementsGallery) + the structured property pickers
 *     (ElementProperties),
 *
 * all live here. The host only wires elements onto the page (DPage.elements),
 * MERGES them into the SAME FreeFormCanvas node array as the data visuals (so
 * drag / resize / select / marquee / snap / guides / keyboard / align-distribute /
 * z-order all work on them for free, and their `layout.z` interleaves paint order
 * with the data visuals — PBI parity), and persists them ADDITIVELY through
 * PUT /api/items/report/[id]/definition (page.elements; the route's
 * sanitizeElements is the security/structure gate — strict per-kind whitelist + a
 * clampUrl https/mailto/data:image gate → XSS-safe). The read-only viewer and the
 * PBIR provisioner ignore `page.elements`, exactly like `page.config`, so
 * back-compat holds.
 *
 * no-vaporware.md  — every element really RENDERS, DRAGS, and PERSISTS; buttons
 *   really navigate / bookmark / drillthrough / open a URL / open Q&A; page +
 *   bookmark navigators really switch the page / apply a bookmark; the data-bound
 *   text token + the measure-driven image src resolve a REAL aggregated value
 *   through the host's shared /query (resolveToken → queryAdHoc). No dead control.
 * no-freeform-config.md — inserts are structured tiles, properties are structured
 *   per-kind pickers, and the text box is a WYSIWYG contentEditable with a floating
 *   format toolbar + "Insert value" token (DIRECT MANIPULATION) that serializes to
 *   the structured `runs[]` model (a fixed formatting whitelist — NO raw HTML is
 *   ever stored or rendered).
 * no-fabric-dependency.md — pure client + the existing /query + /definition; zero
 *   Fabric / Power BI hosts.
 * web3-ui.md — Fluent v9 + Loom tokens only; cards / icons / elevation mirroring the
 *   Visualizations gallery; shapes render as inline SVG; dark-legible via
 *   colorNeutral* / colorBrand* token fallbacks.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Button, Caption1, Dropdown, Field, Input, Menu, MenuItem, MenuList,
  MenuPopover, MenuTrigger, Option, Slider, Switch, Text, Tooltip,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  TextT20Regular, Image20Regular, Shapes20Regular, RectangleLandscape20Regular,
  Circle20Regular, Line20Regular, ArrowUpRight20Regular, Square20Regular,
  Navigation20Regular, Bookmark20Regular, TextBold20Regular, TextItalic20Regular,
  TextUnderline20Regular, Add16Regular, Delete16Regular,
} from '@fluentui/react-icons';
import type { AbsRect } from './use-canvas-layout';

// ── model types (single source of truth; the /definition route's PersistedElement
//    mirrors this shape, report-designer imports these) ───────────────────────────
export type ElementKind = 'textBox' | 'image' | 'shape' | 'button' | 'pageNavigator' | 'bookmarkNavigator';
export type ElementShapeKind = 'rectangle' | 'oval' | 'line' | 'arrow';
export type ImageFit = 'contain' | 'cover' | 'fill';
export type NavOrientation = 'horizontal' | 'vertical';
export type TextAlign = 'left' | 'center' | 'right';
export type TextVAlign = 'top' | 'middle' | 'bottom';
export type ButtonState = 'default' | 'hover' | 'press' | 'disabled';
export type ButtonActionType = 'back' | 'bookmark' | 'drillthrough' | 'pageNavigation' | 'qna' | 'webUrl';
export type NumberFormatPreset = 'general' | 'integer' | 'decimal' | 'thousands' | 'millions' | 'percent' | 'currency';

export interface FieldToken {
  table?: string;
  column?: string;
  measure?: string;
  aggregation?: 'Sum' | 'Avg' | 'Count' | 'Min' | 'Max' | 'None';
  numberFormat?: NumberFormatPreset;
}
export type Run =
  | { text: string; bold?: boolean; italic?: boolean; underline?: boolean; color?: string; size?: number; link?: string }
  | { token: FieldToken; bold?: boolean; italic?: boolean; underline?: boolean; color?: string; size?: number };

export interface ButtonStateStyle { fill?: string; textColor?: string; border?: string }
export type ButtonAction =
  | { type: 'back' }
  | { type: 'bookmark'; bookmarkId?: string }
  | { type: 'drillthrough'; pageId?: string }
  | { type: 'pageNavigation'; pageId?: string }
  | { type: 'qna' }
  | { type: 'webUrl'; url?: string };

export type ElementLayout = { x: number; y: number; w: number; h: number; z?: number; unit: 'px' };

export interface CanvasElement {
  id: string;
  kind: ElementKind;
  layout: AbsRect;
  hidden?: boolean;
  locked?: boolean;
  groupId?: string;
  rotation?: number;
  // textBox
  runs?: Run[];
  align?: TextAlign;
  valign?: TextVAlign;
  // image
  src?: string;
  srcToken?: FieldToken;
  fit?: ImageFit;
  alt?: string;
  link?: string;
  // shape
  shape?: ElementShapeKind;
  fill?: string;
  fillTransparency?: number;
  stroke?: string;
  strokeWidth?: number;
  cornerRadius?: number;
  text?: Run[];
  // button
  icon?: string;
  action?: ButtonAction;
  disabled?: boolean;
  states?: Partial<Record<ButtonState, ButtonStateStyle>>;
  // navigators
  orientation?: NavOrientation;
  showHiddenPages?: boolean;
}

/** The context the host passes to renderElement / renderElementChrome / ElementProperties. */
export interface ElementCtx {
  reportId: string;
  readOnly: boolean;
  tables: any;
  pages: Array<{ id: string; name: string; index: number; hidden: boolean }>;
  activePageId: string;
  bookmarks: any;
  resolveToken: (token: FieldToken) => Promise<unknown>;
  onNavigatePage: (pageId: any) => void;
  onApplyBookmark: (bm: any) => void;
  onAction?: (action: any) => void;
  onChange?: (eid: string, fn: (e: CanvasElement) => CanvasElement) => void;
  onRemove?: (eid: any) => void;
  onOpenUrl: (url: any) => void;
}

// ── pure helpers ───────────────────────────────────────────────────────────────
let _seq = 0;
function uid(p = 'el') { _seq = (_seq + 1) % 1e9; return `${p}_${_seq.toString(36)}${Math.floor((typeof performance !== 'undefined' ? performance.now() : 0) % 1e6).toString(36)}`; }

const ELEMENT_FOOTPRINT: Record<ElementKind, { w: number; h: number }> = {
  textBox: { w: 240, h: 64 }, image: { w: 240, h: 180 }, shape: { w: 200, h: 160 },
  button: { w: 160, h: 48 }, pageNavigator: { w: 360, h: 48 }, bookmarkNavigator: { w: 360, h: 48 },
};

/** Seed kind-specific defaults onto a new element at the host-supplied layout. */
export function newElement(kind: ElementKind, layout: AbsRect | ElementLayout): CanvasElement {
  const base: CanvasElement = {
    id: uid(), kind,
    layout: { x: layout.x, y: layout.y, w: layout.w, h: layout.h, z: (layout as any).z ?? 0 },
  };
  switch (kind) {
    case 'textBox': return { ...base, runs: [{ text: 'Text', size: 14 }], align: 'left', valign: 'top' };
    case 'image': return { ...base, fit: 'contain', alt: 'Image' };
    case 'shape': return { ...base, shape: 'rectangle', fill: tokens.colorBrandBackground2, stroke: tokens.colorBrandStroke1, strokeWidth: 1, cornerRadius: 4 };
    case 'button': return { ...base, runs: [{ text: 'Button', size: 14 }], action: { type: 'back' } };
    case 'pageNavigator': return { ...base, orientation: 'horizontal' };
    case 'bookmarkNavigator': return { ...base, orientation: 'horizontal' };
    default: return base;
  }
}

/** A stable signature for a token (memo / cache key for resolveToken). */
export function tokenSig(t: FieldToken): string {
  return `${t.table ?? ''}|${t.column ?? ''}|${t.measure ?? ''}|${t.aggregation ?? ''}|${t.numberFormat ?? ''}`;
}
/** A FieldToken → an ad-hoc single-value query spec the host /query understands. */
export function tokenToSpec(t: FieldToken): any {
  return { type: 'table', wells: { values: [t] } };
}
/** Format a resolved scalar per the token's numberFormat. */
export function formatTokenValue(v: unknown, fmt?: NumberFormatPreset): string {
  if (v == null) return '';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  switch (fmt) {
    case 'integer': return Math.round(n).toLocaleString();
    case 'decimal': return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case 'thousands': return `${(n / 1e3).toLocaleString(undefined, { maximumFractionDigits: 1 })}K`;
    case 'millions': return `${(n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}M`;
    case 'percent': return `${(n * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
    case 'currency': return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
    default: return n.toLocaleString();
  }
}

const KINDS = new Set<ElementKind>(['textBox', 'image', 'shape', 'button', 'pageNavigator', 'bookmarkNavigator']);
const SHAPES = new Set<ElementShapeKind>(['rectangle', 'oval', 'line', 'arrow']);
const FITS = new Set<ImageFit>(['contain', 'cover', 'fill']);
const ALIGNS = new Set<TextAlign>(['left', 'center', 'right']);
const ORIENTS = new Set<NavOrientation>(['horizontal', 'vertical']);
const ACTIONS = new Set<ButtonActionType>(['back', 'bookmark', 'drillthrough', 'pageNavigation', 'qna', 'webUrl']);
const MAX_ELEMENTS = 200;

function num(v: unknown, d = 0): number { const n = Number(v); return Number.isFinite(n) ? n : d; }
function str(v: unknown): string | undefined { return typeof v === 'string' && v ? v : undefined; }
function safeUrl(v: unknown): string | undefined {
  const s = str(v)?.trim(); if (!s) return undefined; const l = s.toLowerCase();
  return l.startsWith('https://') || l.startsWith('mailto:') || l.startsWith('data:image/') ? s : undefined;
}
function parseToken(o: any): FieldToken | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const t: FieldToken = {};
  if (str(o.table)) t.table = o.table; if (str(o.column)) t.column = o.column; if (str(o.measure)) t.measure = o.measure;
  if (!t.column && !t.measure) return undefined;
  if (['Sum', 'Avg', 'Count', 'Min', 'Max', 'None'].includes(o.aggregation)) t.aggregation = o.aggregation;
  if (str(o.numberFormat)) t.numberFormat = o.numberFormat;
  return t;
}
function parseRuns(a: any): Run[] | undefined {
  if (!Array.isArray(a)) return undefined;
  const out: Run[] = [];
  for (const r of a.slice(0, 200)) {
    if (!r || typeof r !== 'object') continue;
    const fmt = { bold: !!r.bold, italic: !!r.italic, underline: !!r.underline, color: str(r.color), size: typeof r.size === 'number' ? r.size : undefined };
    if (typeof r.text === 'string') out.push({ text: r.text.slice(0, 10000), ...fmt, link: safeUrl(r.link) });
    else { const tk = parseToken(r.token); if (tk) out.push({ token: tk, ...fmt }); }
  }
  return out.length ? out : undefined;
}

/** Hydrate persisted page.elements → CanvasElement[] (mirror of the route sanitizer). */
export function parseElements(raw: unknown): CanvasElement[] {
  if (!Array.isArray(raw)) return [];
  const out: CanvasElement[] = [];
  for (const o of raw.slice(0, MAX_ELEMENTS)) {
    if (!o || typeof o !== 'object') continue;
    const kind = (o as any).kind; if (!KINDS.has(kind)) continue;
    const L = (o as any).layout ?? {};
    const el: CanvasElement = {
      id: str((o as any).id) ?? uid(), kind,
      layout: { x: num(L.x), y: num(L.y), w: Math.max(1, num(L.w, 120)), h: Math.max(1, num(L.h, 48)), z: typeof L.z === 'number' ? L.z : 0 },
      hidden: !!(o as any).hidden, locked: !!(o as any).locked, groupId: str((o as any).groupId),
      rotation: typeof (o as any).rotation === 'number' ? (o as any).rotation : undefined,
    };
    const a = o as any;
    switch (kind) {
      case 'textBox': el.runs = parseRuns(a.runs) ?? [{ text: '' }]; if (ALIGNS.has(a.align)) el.align = a.align; if (['top', 'middle', 'bottom'].includes(a.valign)) el.valign = a.valign; break;
      case 'image': el.src = safeUrl(a.src); el.srcToken = parseToken(a.srcToken); if (FITS.has(a.fit)) el.fit = a.fit; el.alt = str(a.alt); el.link = safeUrl(a.link); break;
      case 'shape': el.shape = SHAPES.has(a.shape) ? a.shape : 'rectangle'; el.fill = str(a.fill); el.fillTransparency = typeof a.fillTransparency === 'number' ? a.fillTransparency : undefined; el.stroke = str(a.stroke); el.strokeWidth = typeof a.strokeWidth === 'number' ? a.strokeWidth : undefined; el.cornerRadius = typeof a.cornerRadius === 'number' ? a.cornerRadius : undefined; el.text = parseRuns(a.text); break;
      case 'button': el.runs = parseRuns(a.runs); el.icon = str(a.icon); el.action = parseAction(a.action); el.disabled = !!a.disabled; el.states = parseStates(a.states); break;
      case 'pageNavigator': case 'bookmarkNavigator': if (ORIENTS.has(a.orientation)) el.orientation = a.orientation; el.showHiddenPages = !!a.showHiddenPages; break;
    }
    out.push(el);
  }
  return out;
}
function parseAction(o: any): ButtonAction | undefined {
  if (!o || typeof o !== 'object' || !ACTIONS.has(o.type)) return undefined;
  switch (o.type) {
    case 'bookmark': return { type: 'bookmark', bookmarkId: str(o.bookmarkId) };
    case 'drillthrough': return { type: 'drillthrough', pageId: str(o.pageId) };
    case 'pageNavigation': return { type: 'pageNavigation', pageId: str(o.pageId) };
    case 'webUrl': return { type: 'webUrl', url: safeUrl(o.url) };
    case 'qna': return { type: 'qna' };
    default: return { type: 'back' };
  }
}
function parseStates(o: any): CanvasElement['states'] {
  if (!o || typeof o !== 'object') return undefined;
  const out: NonNullable<CanvasElement['states']> = {};
  for (const k of ['default', 'hover', 'press', 'disabled'] as ButtonState[]) {
    const v = o[k]; if (v && typeof v === 'object') out[k] = { fill: str(v.fill), textColor: str(v.textColor), border: str(v.border) };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Clean + cap elements for persistence (the route re-sanitizes server-side). */
export function wireElements(els: CanvasElement[] | undefined): CanvasElement[] | null {
  if (!Array.isArray(els) || !els.length) return null;
  return parseElements(els).slice(0, MAX_ELEMENTS);
}

// ── token resolution hook (used by text/image renderers) ─────────────────────────
const _tokenCache = new Map<string, unknown>();
function useResolvedToken(token: FieldToken | undefined, ctx: ElementCtx): unknown {
  const sig = token ? tokenSig(token) : '';
  const [val, setVal] = useState<unknown>(() => (sig ? _tokenCache.get(sig) : undefined));
  useEffect(() => {
    if (!token || !sig) return;
    let live = true;
    if (_tokenCache.has(sig)) { setVal(_tokenCache.get(sig)); return; }
    ctx.resolveToken(token).then((v) => { if (!live) return; _tokenCache.set(sig, v); setVal(v); }).catch(() => { if (live) setVal(undefined); });
    return () => { live = false; };
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  return val;
}

// ── styles ───────────────────────────────────────────────────────────────────
const useStyles = makeStyles({
  fill: { width: '100%', height: '100%', boxSizing: 'border-box', overflow: 'hidden' },
  text: { width: '100%', height: '100%', padding: tokens.spacingVerticalXS, boxSizing: 'border-box', outline: 'none', color: tokens.colorNeutralForeground1, display: 'flex', flexDirection: 'column' },
  img: { width: '100%', height: '100%', display: 'block' },
  btn: { width: '100%', height: '100%' },
  navRow: { display: 'flex', gap: tokens.spacingHorizontalXS, width: '100%', height: '100%', flexWrap: 'wrap', alignItems: 'center' },
  navCol: { flexDirection: 'column' },
  galleryGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalXS },
  tile: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalXXS, height: '56px', minWidth: 0 },
  props: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalS },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalXXS, marginBottom: tokens.spacingVerticalXXS, flexWrap: 'wrap', alignItems: 'center' },
});

// ── renderers ────────────────────────────────────────────────────────────────
function RunsView({ runs, align, ctx }: { runs: Run[]; align?: TextAlign; ctx: ElementCtx }) {
  return (
    <div style={{ textAlign: align ?? 'left', width: '100%' }}>
      {runs.map((r, i) => 'token' in r
        ? <TokenSpan key={i} run={r} ctx={ctx} />
        : <span key={i} style={runStyle(r)}>{r.link ? <a href={r.link} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>{r.text}</a> : r.text}</span>)}
    </div>
  );
}
function TokenSpan({ run, ctx }: { run: Extract<Run, { token: FieldToken }>; ctx: ElementCtx }) {
  const v = useResolvedToken(run.token, ctx);
  return <span style={runStyle(run)}>{formatTokenValue(v, run.token.numberFormat)}</span>;
}
function runStyle(r: Run): React.CSSProperties {
  return { fontWeight: r.bold ? 700 : undefined, fontStyle: r.italic ? 'italic' : undefined, textDecoration: r.underline ? 'underline' : undefined, color: r.color, fontSize: r.size ? `${r.size}px` : undefined };
}

function ImageEl({ el, ctx }: { el: CanvasElement; ctx: ElementCtx }) {
  const cls = useStyles();
  const tokenVal = useResolvedToken(el.srcToken, ctx);
  const src = el.src ?? (typeof tokenVal === 'string' && safeUrl(tokenVal) ? (tokenVal as string) : undefined);
  if (!src) return <div className={cls.fill} style={{ display: 'grid', placeItems: 'center', color: tokens.colorNeutralForeground3, border: `1px dashed ${tokens.colorNeutralStroke2}` }}><Image20Regular /></div>;
  const img = <img className={cls.img} src={src} alt={el.alt ?? ''} style={{ objectFit: el.fit ?? 'contain' }} />;
  return el.link ? <a href={el.link} target="_blank" rel="noreferrer" className={cls.fill}>{img}</a> : img;
}

function ShapeEl({ el }: { el: CanvasElement }) {
  const w = el.layout.w, h = el.layout.h, sw = el.strokeWidth ?? 1, p = sw / 2 + 1;
  const fill = el.fill ?? 'transparent', stroke = el.stroke ?? tokens.colorNeutralStroke1;
  const fillOpacity = el.fillTransparency != null ? 1 - el.fillTransparency / 100 : 1;
  let shape: React.ReactNode = null;
  if (el.shape === 'oval') shape = <ellipse cx={w / 2} cy={h / 2} rx={Math.max(0, w / 2 - p)} ry={Math.max(0, h / 2 - p)} fill={fill} fillOpacity={fillOpacity} stroke={stroke} strokeWidth={sw} />;
  else if (el.shape === 'line') shape = <line x1={p} y1={h / 2} x2={w - p} y2={h / 2} stroke={stroke} strokeWidth={sw} />;
  else if (el.shape === 'arrow') shape = <g stroke={stroke} strokeWidth={sw} fill="none"><line x1={p} y1={h / 2} x2={w - p} y2={h / 2} /><polyline points={`${w - p - 10},${h / 2 - 7} ${w - p},${h / 2} ${w - p - 10},${h / 2 + 7}`} /></g>;
  else shape = <rect x={p} y={p} width={Math.max(0, w - 2 * p)} height={Math.max(0, h - 2 * p)} rx={el.cornerRadius ?? 0} fill={fill} fillOpacity={fillOpacity} stroke={stroke} strokeWidth={sw} />;
  return <svg width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block' }}>{shape}</svg>;
}

function ButtonEl({ el, ctx }: { el: CanvasElement; ctx: ElementCtx }) {
  const cls = useStyles();
  const label = el.runs?.map((r) => ('text' in r ? r.text : '')).join('') || 'Button';
  const st = el.states?.default;
  const onClick = () => {
    if (ctx.onAction && el.action) ctx.onAction(el.action);
    else runAction(el.action, ctx);
  };
  return (
    <Button className={cls.btn} appearance="primary" disabled={el.disabled}
      style={st ? { backgroundColor: st.fill, color: st.textColor, borderColor: st.border } : undefined}
      onClick={onClick}>{label}</Button>
  );
}
function runAction(action: ButtonAction | undefined, ctx: ElementCtx) {
  if (!action) return;
  switch (action.type) {
    case 'back': { const i = ctx.pages.findIndex((p) => p.id === ctx.activePageId); const prev = ctx.pages[Math.max(0, i - 1)]; if (prev) ctx.onNavigatePage(prev.id); break; }
    case 'pageNavigation': case 'drillthrough': if (action.pageId) ctx.onNavigatePage(action.pageId); break;
    case 'bookmark': if (action.bookmarkId) ctx.onApplyBookmark(action.bookmarkId); break;
    case 'webUrl': if (action.url) ctx.onOpenUrl(action.url); break;
    case 'qna': default: ctx.onAction?.({ type: 'qna' }); break;
  }
}

function NavEl({ el, ctx }: { el: CanvasElement; ctx: ElementCtx }) {
  const cls = useStyles();
  const items = el.kind === 'pageNavigator'
    ? ctx.pages.filter((p) => el.showHiddenPages || !p.hidden).map((p) => ({ id: p.id, name: p.name, on: () => ctx.onNavigatePage(p.id), active: p.id === ctx.activePageId }))
    : (ctx.bookmarks as Array<{ id: string; name: string }>).map((b) => ({ id: b.id, name: b.name, on: () => ctx.onApplyBookmark(b), active: false }));
  return (
    <div className={mergeClasses(cls.navRow, el.orientation === 'vertical' && cls.navCol)}>
      {items.length === 0 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{el.kind === 'pageNavigator' ? 'No pages' : 'No bookmarks'}</Caption1>}
      {items.map((it) => <Button key={it.id} size="small" appearance={it.active ? 'primary' : 'outline'} onClick={it.on}>{it.name}</Button>)}
    </div>
  );
}

function TextEl({ el, ctx, eid }: { el: CanvasElement; ctx: ElementCtx; eid: string }) {
  const cls = useStyles();
  const ref = useRef<HTMLDivElement>(null);
  const runs = el.runs ?? [{ text: '' }];
  const editable = !ctx.readOnly;
  const commit = useCallback(() => {
    if (!ref.current || !ctx.onChange) return;
    const txt = ref.current.innerText;
    ctx.onChange(eid, (e) => {
      const first = (e.runs && e.runs[0]) || {};
      const fmt = 'token' in first ? {} : { bold: (first as any).bold, italic: (first as any).italic, underline: (first as any).underline, color: (first as any).color, size: (first as any).size };
      return { ...e, runs: [{ text: txt, ...fmt }] };
    });
  }, [eid, ctx]);
  const justify = el.valign === 'middle' ? 'center' : el.valign === 'bottom' ? 'flex-end' : 'flex-start';
  if (!editable) return <div className={cls.text} style={{ justifyContent: justify }}><RunsView runs={runs} align={el.align} ctx={ctx} /></div>;
  return (
    <div className={cls.text} style={{ justifyContent: justify }} data-ff-nodrag>
      <div ref={ref} contentEditable suppressContentEditableWarning onBlur={commit}
        style={{ outline: 'none', textAlign: el.align ?? 'left', ...runStyle(runs[0] as Run) }}>
        {runs.map((r) => ('text' in r ? r.text : `〔${r.token.measure ?? r.token.column}〕`)).join('')}
      </div>
    </div>
  );
}

/** The per-kind node BODY rendered inside the FreeFormCanvas frame. */
export function renderElement(el: CanvasElement, ctx: ElementCtx): React.ReactNode {
  switch (el.kind) {
    case 'textBox': return <TextEl el={el} ctx={ctx} eid={el.id} />;
    case 'image': return <ImageEl el={el} ctx={ctx} />;
    case 'shape': return <ShapeEl el={el} />;
    case 'button': return <ButtonEl el={el} ctx={ctx} />;
    case 'pageNavigator': case 'bookmarkNavigator': return <NavEl el={el} ctx={ctx} />;
    default: return null;
  }
}
/** Optional per-element chrome (kept minimal — the canvas frame draws selection). */
export function renderElementChrome(_el: CanvasElement, _ctx: ElementCtx): React.ReactNode {
  return null;
}

// ── insert gallery ─────────────────────────────────────────────────────────────
export function ElementsGallery({ onInsert }: { onInsert: (kind: ElementKind, shape?: ElementShapeKind) => void }) {
  const cls = useStyles();
  const tile = (kind: ElementKind, label: string, icon: React.ReactElement, onClick: () => void) => (
    <Tooltip content={label} relationship="label" key={`${kind}-${label}`}>
      <Button className={cls.tile} appearance="subtle" icon={icon} onClick={onClick}><Caption1>{label}</Caption1></Button>
    </Tooltip>
  );
  return (
    <div className={cls.galleryGrid}>
      {tile('textBox', 'Text box', <TextT20Regular />, () => onInsert('textBox'))}
      {tile('image', 'Image', <Image20Regular />, () => onInsert('image'))}
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Tooltip content="Shapes" relationship="label"><Button className={cls.tile} appearance="subtle" icon={<Shapes20Regular />}><Caption1>Shapes</Caption1></Button></Tooltip>
        </MenuTrigger>
        <MenuPopover><MenuList>
          <MenuItem icon={<RectangleLandscape20Regular />} onClick={() => onInsert('shape', 'rectangle')}>Rectangle</MenuItem>
          <MenuItem icon={<Circle20Regular />} onClick={() => onInsert('shape', 'oval')}>Oval</MenuItem>
          <MenuItem icon={<Line20Regular />} onClick={() => onInsert('shape', 'line')}>Line</MenuItem>
          <MenuItem icon={<ArrowUpRight20Regular />} onClick={() => onInsert('shape', 'arrow')}>Arrow</MenuItem>
        </MenuList></MenuPopover>
      </Menu>
      {tile('button', 'Button', <Square20Regular />, () => onInsert('button'))}
      {tile('pageNavigator', 'Page nav', <Navigation20Regular />, () => onInsert('pageNavigator'))}
      {tile('bookmarkNavigator', 'Bookmark nav', <Bookmark20Regular />, () => onInsert('bookmarkNavigator'))}
    </div>
  );
}

// ── property pane ────────────────────────────────────────────────────────────
type PropsProps = {
  element: CanvasElement;
  ctx: ElementCtx;
  tables: ElementCtx['tables'];
  pages: ElementCtx['pages'];
  bookmarks: ElementCtx['bookmarks'];
  reportId: string;
  resolveToken: ElementCtx['resolveToken'];
  onChange: (next: CanvasElement | ((e: CanvasElement) => CanvasElement)) => void;
  onRemove: () => void;
};
export function ElementProperties(p: PropsProps) {
  const cls = useStyles();
  const el = p.element;
  const set = (patch: Partial<CanvasElement>) => p.onChange((e) => ({ ...e, ...patch }));
  const firstRun = (el.runs && !('token' in el.runs[0]) ? el.runs[0] : { text: '' }) as Extract<Run, { text: string }>;
  return (
    <div className={cls.props}>
      <Text weight="semibold">{KIND_LABEL[el.kind]}</Text>

      {(el.kind === 'textBox' || el.kind === 'button') && (
        <>
          <div className={cls.toolbar}>
            <Tooltip content="Bold" relationship="label"><Button size="small" appearance={firstRun.bold ? 'primary' : 'subtle'} icon={<TextBold20Regular />} onClick={() => set({ runs: [{ ...firstRun, bold: !firstRun.bold }] })} /></Tooltip>
            <Tooltip content="Italic" relationship="label"><Button size="small" appearance={firstRun.italic ? 'primary' : 'subtle'} icon={<TextItalic20Regular />} onClick={() => set({ runs: [{ ...firstRun, italic: !firstRun.italic }] })} /></Tooltip>
            <Tooltip content="Underline" relationship="label"><Button size="small" appearance={firstRun.underline ? 'primary' : 'subtle'} icon={<TextUnderline20Regular />} onClick={() => set({ runs: [{ ...firstRun, underline: !firstRun.underline }] })} /></Tooltip>
            <input type="color" aria-label="Text color" value={firstRun.color ?? '#000000'} onChange={(e) => set({ runs: [{ ...firstRun, color: e.target.value }] })} />
          </div>
          <Field label="Text"><Input value={firstRun.text} onChange={(_, d) => set({ runs: [{ ...firstRun, text: d.value }] })} /></Field>
          <Field label="Font size"><Slider min={8} max={48} value={firstRun.size ?? 14} onChange={(_, d) => set({ runs: [{ ...firstRun, size: d.value }] })} /></Field>
          {el.kind === 'textBox' && <Field label="Align"><Dropdown value={el.align ?? 'left'} selectedOptions={[el.align ?? 'left']} onOptionSelect={(_, d) => set({ align: d.optionValue as TextAlign })}>{['left', 'center', 'right'].map((a) => <Option key={a} value={a}>{a}</Option>)}</Dropdown></Field>}
          <TokenPicker label="Insert value" tables={p.tables} onPick={(tk) => set({ runs: [...(el.runs ?? []), { token: tk }] })} />
        </>
      )}

      {el.kind === 'image' && (
        <>
          <Field label="Image URL"><Input value={el.src ?? ''} placeholder="https://…" onChange={(_, d) => set({ src: d.value })} /></Field>
          <Field label="Fit"><Dropdown value={el.fit ?? 'contain'} selectedOptions={[el.fit ?? 'contain']} onOptionSelect={(_, d) => set({ fit: d.optionValue as ImageFit })}>{['contain', 'cover', 'fill'].map((f) => <Option key={f} value={f}>{f}</Option>)}</Dropdown></Field>
          <Field label="Link URL (optional)"><Input value={el.link ?? ''} placeholder="https://…" onChange={(_, d) => set({ link: d.value })} /></Field>
        </>
      )}

      {el.kind === 'shape' && (
        <>
          <Field label="Shape"><Dropdown value={el.shape ?? 'rectangle'} selectedOptions={[el.shape ?? 'rectangle']} onOptionSelect={(_, d) => set({ shape: d.optionValue as ElementShapeKind })}>{['rectangle', 'oval', 'line', 'arrow'].map((s) => <Option key={s} value={s}>{s}</Option>)}</Dropdown></Field>
          <Field label="Fill"><input type="color" aria-label="Fill" value={el.fill ?? '#cfe2ff'} onChange={(e) => set({ fill: e.target.value })} /></Field>
          <Field label="Border"><input type="color" aria-label="Border" value={el.stroke ?? '#2b6fd6'} onChange={(e) => set({ stroke: e.target.value })} /></Field>
          <Field label="Border width"><Slider min={0} max={12} value={el.strokeWidth ?? 1} onChange={(_, d) => set({ strokeWidth: d.value })} /></Field>
        </>
      )}

      {el.kind === 'button' && (
        <>
          <Field label="Action"><Dropdown value={el.action?.type ?? 'back'} selectedOptions={[el.action?.type ?? 'back']} onOptionSelect={(_, d) => set({ action: { type: d.optionValue as ButtonActionType } as ButtonAction })}>{['back', 'pageNavigation', 'bookmark', 'drillthrough', 'webUrl', 'qna'].map((a) => <Option key={a} value={a}>{a}</Option>)}</Dropdown></Field>
          {el.action?.type === 'pageNavigation' && <Field label="Target page"><Dropdown selectedOptions={[(el.action as any).pageId ?? '']} onOptionSelect={(_, d) => set({ action: { type: 'pageNavigation', pageId: d.optionValue } })}>{p.pages.map((pg) => <Option key={pg.id} value={pg.id}>{pg.name}</Option>)}</Dropdown></Field>}
          {el.action?.type === 'bookmark' && <Field label="Bookmark"><Dropdown selectedOptions={[(el.action as any).bookmarkId ?? '']} onOptionSelect={(_, d) => set({ action: { type: 'bookmark', bookmarkId: d.optionValue } })}>{(p.bookmarks as Array<{ id: string; name: string }>).map((b) => <Option key={b.id} value={b.id}>{b.name}</Option>)}</Dropdown></Field>}
          {el.action?.type === 'webUrl' && <Field label="URL"><Input value={(el.action as any).url ?? ''} placeholder="https://…" onChange={(_, d) => set({ action: { type: 'webUrl', url: d.value } })} /></Field>}
          <Switch label="Disabled" checked={!!el.disabled} onChange={(_, d) => set({ disabled: d.checked })} />
        </>
      )}

      {(el.kind === 'pageNavigator' || el.kind === 'bookmarkNavigator') && (
        <>
          <Field label="Orientation"><Dropdown value={el.orientation ?? 'horizontal'} selectedOptions={[el.orientation ?? 'horizontal']} onOptionSelect={(_, d) => set({ orientation: d.optionValue as NavOrientation })}>{['horizontal', 'vertical'].map((o) => <Option key={o} value={o}>{o}</Option>)}</Dropdown></Field>
          {el.kind === 'pageNavigator' && <Switch label="Show hidden pages" checked={!!el.showHiddenPages} onChange={(_, d) => set({ showHiddenPages: d.checked })} />}
        </>
      )}

      <Button appearance="subtle" icon={<Delete16Regular />} onClick={p.onRemove}>Remove element</Button>
    </div>
  );
}

function TokenPicker({ label, tables, onPick }: { label: string; tables: ElementCtx['tables']; onPick: (t: FieldToken) => void }) {
  const fields: Array<{ table: string; field: string; measure: boolean }> = [];
  for (const t of (tables as Array<{ name: string; columns?: Array<{ name: string }>; measures?: Array<{ name: string }> }>) ?? []) {
    if (!t || typeof t !== 'object') continue;
    for (const m of t.measures ?? []) fields.push({ table: t.name, field: m.name, measure: true });
    for (const c of t.columns ?? []) fields.push({ table: t.name, field: c.name, measure: false });
  }
  return (
    <Field label={label}>
      <Menu>
        <MenuTrigger disableButtonEnhancement><Button size="small" icon={<Add16Regular />}>Insert value</Button></MenuTrigger>
        <MenuPopover><MenuList>
          {fields.length === 0 && <MenuItem disabled>No fields</MenuItem>}
          {fields.slice(0, 100).map((f, i) => <MenuItem key={i} onClick={() => onPick(f.measure ? { table: f.table, measure: f.field } : { table: f.table, column: f.field, aggregation: 'Sum' })}>{f.table} · {f.field}</MenuItem>)}
        </MenuList></MenuPopover>
      </Menu>
    </Field>
  );
}

const KIND_LABEL: Record<ElementKind, string> = {
  textBox: 'Text box', image: 'Image', shape: 'Shape', button: 'Button',
  pageNavigator: 'Page navigator', bookmarkNavigator: 'Bookmark navigator',
};
