'use client';

/**
 * DeploymentPlannerView — visually plan a CSA Loom / Fabric-in-a-Box rollout
 * across multiple subscriptions and domains, then generate the bicepparam the
 * real `az deployment sub create` consumes.
 *
 * Layout (React Flow nested nodes): subscription container → domain containers
 * → service leaves (official Azure icons). Drag a service from the left palette
 * onto a domain (or select a domain and click the service) to plan it there.
 *
 * Real backend per no-vaporware.md: the plan + the tenant's domains load from
 * /api/admin/deploy-plan (Cosmos); Save PUTs the plan back. The planner does
 * NOT execute a deployment — Export produces the bicepparam and an honest
 * MessageBar points at the deploy command / workflow.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap,
  useReactFlow, MarkerType, type Node, type Edge, type Connection, type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Button, Badge, Caption1, Subtitle2, Body1, Input, Dropdown, Option, Field, Tooltip,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle, Spinner, Textarea, SpinButton,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell, TableCellLayout,
  Divider, Link, TabList, Tab,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Save20Regular, ArrowDownload20Regular, Delete20Regular, Search16Regular,
  ChevronDown20Regular, ChevronRight20Regular, CheckmarkCircle20Regular, Settings20Regular,
  Money20Regular, Open16Regular,
} from '@fluentui/react-icons';
import { SubscriptionNode, DomainNode, ServiceNode, ServiceIconChip } from './deploy-plan-nodes';
import {
  SERVICE_CATALOG, SERVICE_CATEGORY_ORDER, servicesByCategory, serviceByKey, serviceVisual,
  SERVICE_COUNT, TOGGLEABLE_SERVICE_COUNT, configFor, resolveConfigValue, configStatus,
  type ServiceDef, type ServiceCategory, type ConfigField,
} from './service-catalog';
import { iconUrl } from '../ui/item-type-visual';
import { planToBicepparam } from './bicepparam';
import { planToBicep } from './planToBicep';
import { validatePlan, parseServiceNodeId, type PlanIssue } from './plan-validation';
import {
  pricingCalculatorUrl, serviceDetailsUrl, breakdownToCsv, breakdownToJson, downloadText,
} from './pricing-calculator-link';
import type { CostSummary } from './cost-estimate';
import {
  RETAIL_CURRENCIES, COMMERCIAL_REGIONS, DEFAULT_CURRENCY, regionLabel,
} from './cost-options';
import type { PlanSubscription, ConfigValue } from './types';

const nodeTypes: NodeTypes = { subscription: SubscriptionNode, domain: DomainNode, service: ServiceNode };

/** Format a monthly figure as a whole-dollar currency string (no cents noise). */
function fmtMoney(v: number, currency: string): string {
  const n = Number.isFinite(v) ? v : 0;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: n < 10 ? 2 : 0 }).format(n);
  } catch {
    return `${currency || 'USD'} ${n.toFixed(2)}`;
  }
}

// layout constants
const SUB_PAD_X = 16, SUB_HEADER = 36, SUB_GAP = 28, SUB_BOTTOM = 16;
const DOMAIN_W = 312, DOMAIN_HEADER = 30, DOMAIN_PAD = 12, DOMAIN_GAP = 16;
const SVC_W = 132, SVC_H = 40, SVC_GAP_X = 12, SVC_GAP_Y = 10, SVC_COLS = 2;
const SUB_W = DOMAIN_W + SUB_PAD_X * 2;

function domainHeight(serviceCount: number): number {
  const rows = Math.max(1, Math.ceil(serviceCount / SVC_COLS));
  return DOMAIN_HEADER + DOMAIN_PAD + rows * (SVC_H + SVC_GAP_Y) + DOMAIN_PAD;
}

interface DomainRect { x: number; y: number; w: number; h: number; si: number; di: number }

/** Build the nested React Flow node list + absolute domain rects (for drop hit-test). */
function buildNodes(subs: PlanSubscription[], sel: Selection): { nodes: Node[]; rects: DomainRect[] } {
  const nodes: Node[] = [];
  const rects: DomainRect[] = [];
  let subX = 0;
  subs.forEach((sub, si) => {
    let domY = SUB_HEADER;
    const domainNodes: Node[] = [];
    sub.domains.forEach((dom, di) => {
      const h = domainHeight(dom.services.length);
      const domId = `dom:${si}:${di}`;
      domainNodes.push({
        id: domId, type: 'domain', parentId: `sub:${si}`, extent: 'parent',
        position: { x: SUB_PAD_X, y: domY },
        width: DOMAIN_W, height: h,
        selectable: true, draggable: false,
        data: { name: dom.name || dom.domainId, serviceCount: dom.services.length },
        selected: sel?.kind === 'domain' && sel.si === si && sel.di === di,
      });
      rects.push({ x: subX + SUB_PAD_X, y: domY, w: DOMAIN_W, h, si, di });
      dom.services.forEach((key, k) => {
        const col = k % SVC_COLS, row = Math.floor(k / SVC_COLS);
        domainNodes.push({
          id: `svc:${si}:${di}:${key}`, type: 'service', parentId: domId, extent: 'parent',
          position: { x: DOMAIN_PAD + col * (SVC_W + SVC_GAP_X), y: DOMAIN_HEADER + DOMAIN_PAD + row * (SVC_H + SVC_GAP_Y) },
          draggable: false, selectable: true,
          data: { serviceKey: key, configStatus: configStatus(key, sub.serviceConfigs?.[key]) },
          selected: sel?.kind === 'service' && sel.si === si && sel.di === di && sel.key === key,
        });
      });
      domY += h + DOMAIN_GAP;
    });
    const subH = Math.max(domY + SUB_BOTTOM, SUB_HEADER + 80);
    nodes.push({
      id: `sub:${si}`, type: 'subscription',
      position: { x: subX, y: 0 },
      width: SUB_W, height: subH,
      draggable: false, selectable: true,
      data: { name: sub.name, boundary: sub.boundary, region: sub.region },
      selected: sel?.kind === 'subscription' && sel.si === si,
    });
    nodes.push(...domainNodes);
    subX += SUB_W + SUB_GAP;
  });
  return { nodes, rects };
}

type Selection =
  | { kind: 'subscription'; si: number }
  | { kind: 'domain'; si: number; di: number }
  | { kind: 'service'; si: number; di: number; key: string }
  | { kind: 'edge'; si: number; idx: number }
  | null;

/** Build the React Flow dependency edges from each subscription's edges[]. */
function buildEdges(subs: PlanSubscription[], sel: Selection): Edge[] {
  const edges: Edge[] = [];
  subs.forEach((sub, si) => {
    (sub.edges || []).forEach((e, idx) => {
      const selected = sel?.kind === 'edge' && sel.si === si && sel.idx === idx;
      edges.push({
        id: `e:${si}:${idx}`,
        source: e.from,
        target: e.to,
        selected,
        style: { stroke: selected ? tokens.colorBrandStroke1 : tokens.colorNeutralStroke1, strokeWidth: selected ? 2.5 : 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: selected ? tokens.colorBrandStroke1 : tokens.colorNeutralStroke1 },
      });
    });
  });
  return edges;
}

const useStyles = makeStyles({
  root: {
    display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalL, minHeight: 0,
  },
  toolbar: {
    display: 'flex', gap: tokens.spacingHorizontalS,
    alignItems: 'center', flexWrap: 'wrap',
  },
  body: {
    // Height-bounded to the viewport so the PALETTE scrolls internally and the
    // CANVAS stays fixed — collapsing/expanding categories never grows the page.
    // minmax(0,1fr) lets the canvas column shrink instead of overflowing wide.
    display: 'grid', gridTemplateColumns: '300px minmax(0, 1fr)',
    gap: tokens.spacingHorizontalL,
    height: 'calc(100vh - 220px)', minHeight: '460px',
  },
  palette: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
    overflowY: 'auto',
    padding: tokens.spacingVerticalM,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
  },
  pFilters: {
    display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS,
  },
  pGroup: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  pGroupHead: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    marginBottom: '2px', width: '100%', cursor: 'pointer',
    background: 'none', border: 'none', padding: '4px 2px', textAlign: 'left',
    borderRadius: tokens.borderRadiusMedium,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  pGroupChevron: { flexShrink: 0, color: tokens.colorNeutralForeground3, display: 'flex' },
  pGroupCount: { marginLeft: 'auto', color: tokens.colorNeutralForeground3, fontSize: '11px' },
  pGroupSwatch: { width: '8px', height: '8px', borderRadius: '2px', flexShrink: 0 },
  pTile: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: '7px 9px', borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground1,
    cursor: 'grab', fontSize: '12px',
    transitionDuration: tokens.durationFaster,
    transitionProperty: 'border-color, background-color, transform',
    ':hover': {
      border: `1px solid ${tokens.colorBrandStroke1}`,
      backgroundColor: tokens.colorNeutralBackground1Hover,
      transform: 'translateY(-1px)',
    },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '1px' },
  },
  pTileLabel: {
    flex: 1, minWidth: 0, whiteSpace: 'nowrap',
    overflow: 'hidden', textOverflow: 'ellipsis',
    color: tokens.colorNeutralForeground1,
  },
  canvas: {
    position: 'relative',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    overflow: 'hidden', background: tokens.colorNeutralBackground3,
    boxShadow: tokens.shadow2,
  },
  // Inspector card shared by the three context panels below the canvas, so they
  // read as one consistent surface family with the palette + canvas (token
  // radius/shadow, not ad-hoc px) instead of borderless boxes.
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
    padding: tokens.spacingVerticalM,
  },
  subEditor: {
    // Top-align so a hinted field (e.g. Deployment mode) keeps its control on
    // the same baseline as the un-hinted inputs — its hint extends downward
    // instead of shoving the control up out of the row.
    display: 'flex', gap: tokens.spacingHorizontalM,
    alignItems: 'flex-start', flexWrap: 'wrap',
  },
  subField: { minWidth: '220px' },
  svcConfig: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
  },
  svcConfigHead: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
  },
  fieldRow: {
    display: 'flex', gap: tokens.spacingHorizontalL,
    flexWrap: 'wrap', alignItems: 'flex-end',
  },
  edgeInspector: {
    display: 'flex', gap: tokens.spacingHorizontalS,
    alignItems: 'center', flexWrap: 'wrap',
  },
  issueList: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
  },
  spacer: { flex: 1 },
  // ---- cost-estimate dialog ----
  // Bound the report height so a many-domain plan scrolls inside the dialog
  // instead of pushing the action bar off-screen.
  costScroll: {
    maxHeight: '64vh', overflowY: 'auto',
    paddingRight: tokens.spacingHorizontalXS,
  },
  costBody: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  // Currency + pricing-region pickers — a distinct controls bar above the report.
  costPickers: {
    display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end',
    gap: tokens.spacingHorizontalL, rowGap: tokens.spacingVerticalS,
    marginBottom: tokens.spacingVerticalM,
    paddingTop: tokens.spacingVerticalS, paddingBottom: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  costPickerField: { minWidth: '200px', flex: '1 1 200px' },
  costDomain: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalS, paddingBottom: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  costDomainHead: { display: 'flex', alignItems: 'baseline', gap: tokens.spacingHorizontalS },
  costDomainTotal: { marginLeft: 'auto', fontWeight: tokens.fontWeightSemibold },
  costTotalRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalS, paddingBottom: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground2,
    border: `1px solid ${tokens.colorBrandStroke2}`,
  },
  costGrand: {
    marginLeft: 'auto',
    fontSize: tokens.fontSizeBase600, fontWeight: tokens.fontWeightBold,
    color: tokens.colorBrandForeground1,
  },
  costMuted: { color: tokens.colorNeutralForeground3 },
  costSku: { fontSize: tokens.fontSizeBase200 },
  costUnit: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  costFootnote: { color: tokens.colorNeutralForeground3, fontStyle: 'italic' },
  costUnest: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  costUnestList: { marginTop: tokens.spacingVerticalXS, marginBottom: 0, paddingLeft: tokens.spacingHorizontalXXL },
  exportBody: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    paddingTop: tokens.spacingVerticalS,
  },
  exportHint: {
    display: 'block', margin: 0, color: tokens.colorNeutralForeground3,
    lineHeight: tokens.lineHeightBase300,
  },
  exportArea: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200, minHeight: '340px',
  },
});

const MIME = 'application/x-loom-service';

function PlannerInner() {
  const s = useStyles();
  const rf = useReactFlow();
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [subs, setSubs] = useState<PlanSubscription[]>([]);
  const [domains, setDomains] = useState<Array<{ id: string; name: string }>>([]);
  const [sel, setSel] = useState<Selection>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [catFilter, setCatFilter] = useState<ServiceCategory | 'all'>('all');
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set());
  const toggleCat = useCallback((id: string) => {
    setCollapsedCats((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const [exportSub, setExportSub] = useState<PlanSubscription | null>(null);
  const [exportFmt, setExportFmt] = useState<'bicepparam' | 'bicep'>('bicepparam');
  const [costOpen, setCostOpen] = useState(false);
  const [costSub, setCostSub] = useState<PlanSubscription | null>(null);
  const [costSummary, setCostSummary] = useState<CostSummary | null>(null);
  const [costBusy, setCostBusy] = useState(false);
  const [costErr, setCostErr] = useState<string | null>(null);
  // Cost-report pickers: currency + Commercial pricing region (Retail Prices API
  // overrides). Empty region = derive from the plan boundary on the server.
  const [costCurrency, setCostCurrency] = useState<string>(DEFAULT_CURRENCY);
  const [costRegion, setCostRegion] = useState<string>('');
  const rectsRef = useRef<DomainRect[]>([]);

  // ---- load ----
  useEffect(() => {
    (async () => {
      setLoading(true); setErr(null);
      try {
        const r = await fetch('/api/admin/deploy-plan');
        const j = await r.json();
        if (!j.ok) { setErr(j.error || 'failed to load plan'); return; }
        setSubs(j.plan?.subscriptions || []);
        setDomains(j.domains || []);
      } catch (e: any) { setErr(e?.message || String(e)); }
      finally { setLoading(false); }
    })();
  }, []);

  const mutate = useCallback((fn: (draft: PlanSubscription[]) => void) => {
    setSubs((prev) => {
      const next = JSON.parse(JSON.stringify(prev)) as PlanSubscription[];
      fn(next);
      return next;
    });
    setDirty(true);
  }, []);

  // ---- node graph ----
  const { nodes, rects } = useMemo(() => buildNodes(subs, sel), [subs, sel]);
  const edges = useMemo(() => buildEdges(subs, sel), [subs, sel]);
  rectsRef.current = rects;

  // ---- plan validation (live) ----
  const issues = useMemo(() => validatePlan(subs), [subs]);
  const errorCount = issues.filter((i) => i.level === 'error').length;
  const [showIssues, setShowIssues] = useState(false);

  const onNodeClick = useCallback((_: unknown, n: Node) => {
    const [kind, si, di, ...rest] = n.id.split(':');
    if (kind === 'sub') setSel({ kind: 'subscription', si: Number(si) });
    else if (kind === 'dom') setSel({ kind: 'domain', si: Number(si), di: Number(di) });
    else if (kind === 'svc') setSel({ kind: 'service', si: Number(si), di: Number(di), key: rest.join(':') });
  }, []);

  const onEdgeClick = useCallback((_: unknown, e: Edge) => {
    const [, si, idx] = e.id.split(':');
    setSel({ kind: 'edge', si: Number(si), idx: Number(idx) });
  }, []);

  // ---- connect two service nodes → a dependency edge ----
  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    const from = parseServiceNodeId(c.source);
    if (!from) return; // only service→service edges are meaningful
    if (!parseServiceNodeId(c.target)) return;
    mutate((d) => {
      const sub = d[from.si];
      if (!sub) return;
      if (!sub.edges) sub.edges = [];
      if (sub.edges.some((e) => e.from === c.source && e.to === c.target)) return; // de-dupe
      sub.edges.push({ from: c.source!, to: c.target! });
    });
  }, [mutate]);

  // ---- add a service to a domain (by index) ----
  const addServiceTo = useCallback((si: number, di: number, key: string) => {
    mutate((d) => {
      const dom = d[si]?.domains[di];
      if (dom && !dom.services.includes(key)) dom.services.push(key);
    });
  }, [mutate]);

  // ---- palette click: add to selected domain ----
  const paletteAdd = useCallback((def: ServiceDef) => {
    if (sel?.kind === 'domain') addServiceTo(sel.si, sel.di, def.key);
    else if (sel?.kind === 'service') addServiceTo(sel.si, sel.di, def.key);
  }, [sel, addServiceTo]);

  // ---- palette drag → drop onto a domain (hit-test absolute rects) ----
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const key = e.dataTransfer.getData(MIME);
    if (!key) return;
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const hit = rectsRef.current.find((r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);
    if (hit) addServiceTo(hit.si, hit.di, key);
    else if (sel?.kind === 'domain') addServiceTo(sel.si, sel.di, key);
  }, [rf, addServiceTo, sel]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
  }, []);

  // ---- structural edits ----
  const addSubscription = useCallback(() => {
    mutate((d) => {
      const n = d.length + 1;
      d.push({ id: `sub-${n}`, name: `Subscription ${n}`, boundary: 'Commercial',
        domains: domains.map((dm) => ({ domainId: dm.id, name: dm.name, services: [] })) });
    });
    setSel({ kind: 'subscription', si: subs.length });
  }, [mutate, domains, subs.length]);

  const addDomainToSelectedSub = useCallback(() => {
    if (sel?.kind !== 'subscription' && sel?.kind !== 'domain') return;
    const si = sel.si;
    mutate((d) => {
      const used = new Set(d[si].domains.map((x) => x.domainId));
      const avail = domains.find((dm) => !used.has(dm.id));
      if (avail) d[si].domains.push({ domainId: avail.id, name: avail.name, services: [] });
    });
  }, [sel, mutate, domains]);

  const deleteSelected = useCallback(() => {
    if (!sel) return;
    mutate((d) => {
      if (sel.kind === 'edge') {
        const sub = d[sel.si];
        if (sub?.edges) sub.edges.splice(sel.idx, 1);
        return;
      }
      // Gather every edge across the plan, remap node-id indices for the
      // structural delete, then redistribute (positional node ids shift when a
      // domain or subscription is removed, so edges must be remapped to stay
      // honest — never left dangling).
      const all: { from: string; to: string }[] = [];
      for (const su of d) for (const e of su.edges || []) all.push({ ...e });

      const remapId = (id: string): string | null => {
        const p = parseServiceNodeId(id);
        if (!p) return id;
        if (sel.kind === 'service') {
          return (p.si === sel.si && p.di === sel.di && p.key === sel.key) ? null : id;
        }
        if (sel.kind === 'domain') {
          if (p.si !== sel.si) return id;
          if (p.di === sel.di) return null;
          return p.di > sel.di ? `svc:${p.si}:${p.di - 1}:${p.key}` : id;
        }
        // subscription
        if (p.si === sel.si) return null;
        return p.si > sel.si ? `svc:${p.si - 1}:${p.di}:${p.key}` : id;
      };

      if (sel.kind === 'service') {
        const dom = d[sel.si]?.domains[sel.di];
        if (dom) dom.services = dom.services.filter((k) => k !== sel.key);
      } else if (sel.kind === 'domain') {
        d[sel.si]?.domains.splice(sel.di, 1);
      } else if (sel.kind === 'subscription') {
        d.splice(sel.si, 1);
      }

      const remapped: { from: string; to: string }[] = [];
      for (const e of all) {
        const from = remapId(e.from);
        const to = remapId(e.to);
        if (from && to && from !== to) remapped.push({ from, to });
      }
      for (const su of d) su.edges = [];
      for (const e of remapped) {
        const fp = parseServiceNodeId(e.from);
        if (fp && d[fp.si]) (d[fp.si].edges ||= []).push(e);
      }
      for (const su of d) if (su.edges && su.edges.length === 0) su.edges = undefined;
    });
    setSel(null);
  }, [sel, mutate]);

  const patchSelectedSub = useCallback((patch: Partial<PlanSubscription>) => {
    if (sel?.kind !== 'subscription') return;
    mutate((d) => { Object.assign(d[sel.si], patch); });
  }, [sel, mutate]);

  // ---- per-resource config (SKU / tier / runtime) ----
  const patchServiceConfig = useCallback((fieldKey: string, value: ConfigValue) => {
    if (sel?.kind !== 'service') return;
    const svcKey = sel.key;
    mutate((d) => {
      const sub = d[sel.si];
      if (!sub) return;
      if (!sub.serviceConfigs) sub.serviceConfigs = {};
      if (!sub.serviceConfigs[svcKey]) sub.serviceConfigs[svcKey] = {};
      sub.serviceConfigs[svcKey][fieldKey] = value;
    });
  }, [sel, mutate]);

  // ---- save ----
  const save = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/admin/deploy-plan', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscriptions: subs }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'save failed');
      setDirty(false);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [subs]);

  // ---- estimate cost (public Azure Retail Prices API) ----
  const estimateCost = useCallback(async (sub: PlanSubscription, opts?: { currencyCode?: string; region?: string }) => {
    const currencyCode = opts?.currencyCode ?? costCurrency;
    const region = opts?.region ?? costRegion;
    setCostSub(sub); setCostOpen(true); setCostBusy(true); setCostErr(null); setCostSummary(null);
    try {
      const r = await fetch('/api/admin/deploy-plan/cost-estimate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: sub, currencyCode, region: region || undefined }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'cost estimate failed');
      setCostSummary(j.summary as CostSummary);
    } catch (e: any) { setCostErr(e?.message || String(e)); }
    finally { setCostBusy(false); }
  }, [costCurrency, costRegion]);

  const q = query.trim().toLowerCase();
  const matches = (def: ServiceDef) =>
    (catFilter === 'all' || def.category === catFilter) &&
    (!q || def.label.toLowerCase().includes(q) || def.key.toLowerCase().includes(q)
      || def.description.toLowerCase().includes(q));
  const matchCount = SERVICE_CATALOG.filter(matches).length;

  const selectedSub = sel?.kind === 'subscription' ? subs[sel.si] : null;
  const selectedSvc = sel?.kind === 'service'
    ? {
        def: serviceByKey(sel.key),
        stored: subs[sel.si]?.serviceConfigs?.[sel.key],
        subName: subs[sel.si]?.name,
        status: configStatus(sel.key, subs[sel.si]?.serviceConfigs?.[sel.key]),
      }
    : null;

  // Reset the selected service's stored config so it falls back to module
  // defaults (clears the "configured" badge, never leaves an invalid value).
  const resetServiceConfig = useCallback(() => {
    if (sel?.kind !== 'service') return;
    const svcKey = sel.key;
    mutate((d) => {
      const sub = d[sel.si];
      if (sub?.serviceConfigs) delete sub.serviceConfigs[svcKey];
    });
  }, [sel, mutate]);

  if (loading) return <Spinner label="Loading deployment plan…" />;

  return (
    <div className={s.root}>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Architecture builder</MessageBarTitle>
          Plan from a catalog of {SERVICE_COUNT} Azure service types ({TOGGLEABLE_SERVICE_COUNT} have a
          one-button bicep toggle; <Badge size="tiny" appearance="outline" color="warning">plan</Badge> services
          are real Azure but not auto-provisioned by main.bicep yet, so they are not written as bicep params).
          Drop services into domains, then <strong>select a placed service to configure its SKU / tier / runtime</strong> in
          the inspector below the canvas. A node shows{' '}
          <CheckmarkCircle20Regular style={{ verticalAlign: 'text-bottom', color: tokens.colorPaletteGreenForeground1, width: 14, height: 14 }} aria-hidden /> once you&apos;ve
          set a value and a hollow dot while it still uses module defaults; <strong>Validate</strong> calls out any service
          left on defaults or with an invalid value. Drag from a service&apos;s right edge to another to record a dependency.
          Save persists to Cosmos. To
          deploy, use <strong>Export bicep</strong> on a subscription — choose <code>.bicepparam</code> (drives the
          maintained main.bicep) or a standalone <code>.bicep</code> template (your dependency arrows become module{' '}
          <code>dependsOn</code>) — then run
          {' '}<code>az deployment sub create</code>{' '}or trigger the deploy-fiab workflow. <strong>Estimate cost</strong> prices the selected
          subscription against the public Azure Retail Prices API (best-effort list price). Domains come from{' '}
          <a href="/admin/domains">Admin → Domains</a>.
        </MessageBarBody>
      </MessageBar>

      <div className={s.toolbar}>
        <Button appearance="primary" icon={<Add20Regular />} onClick={addSubscription}>Add subscription</Button>
        <Button icon={<Add20Regular />} disabled={sel?.kind !== 'subscription' && sel?.kind !== 'domain'} onClick={addDomainToSelectedSub}>Add domain</Button>
        <Button icon={<Delete20Regular />} disabled={!sel} onClick={deleteSelected}>
          Remove {sel?.kind === 'edge' ? 'dependency' : sel?.kind || 'selection'}
        </Button>
        <Button
          icon={errorCount ? <Delete20Regular /> : <CheckmarkCircle20Regular />}
          onClick={() => setShowIssues((v) => !v)}
          appearance={errorCount ? 'outline' : 'subtle'}
        >
          Validate{issues.length ? ` (${errorCount} error${errorCount === 1 ? '' : 's'}, ${issues.length - errorCount} warning${issues.length - errorCount === 1 ? '' : 's'})` : ' ✓'}
        </Button>
        <div className={s.spacer} />
        <Button icon={<Money20Regular />} disabled={!selectedSub} onClick={() => selectedSub && estimateCost(selectedSub)}>
          Estimate cost
        </Button>
        <Button icon={<ArrowDownload20Regular />} disabled={!selectedSub} onClick={() => { if (selectedSub) { setExportFmt('bicepparam'); setExportSub(selectedSub); } }}>
          Export bicep
        </Button>
        <Button appearance="primary" icon={<Save20Regular />} disabled={!dirty || busy} onClick={save}>
          {busy ? 'Saving…' : dirty ? 'Save plan' : 'Saved'}
        </Button>
      </div>

      {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Plan error</MessageBarTitle>{err}</MessageBarBody></MessageBar>}
      {domains.length === 0 && (
        <MessageBar intent="warning"><MessageBarBody>
          No domains yet. Create business domains in <a href="/admin/domains">Admin → Domains</a> first; they become the
          containers you plan services into.
        </MessageBarBody></MessageBar>
      )}

      {showIssues && (
        <div className={s.issueList} data-testid="plan-issues">
          {issues.length === 0 ? (
            <MessageBar intent="success"><MessageBarBody>
              <MessageBarTitle>Plan is valid</MessageBarTitle>
              No issues found. Every dependency points at a planned service and nothing is left dangling.
            </MessageBarBody></MessageBar>
          ) : (
            issues.map((iss, i) => (
              <MessageBar key={i} intent={iss.level === 'error' ? 'error' : 'warning'}>
                <MessageBarBody>{iss.message}</MessageBarBody>
              </MessageBar>
            ))
          )}
        </div>
      )}

      <div className={s.body}>
        {/* palette */}
        <div className={s.palette} role="navigation" aria-label="Azure service catalog">
          <Input size="small" contentBefore={<Search16Regular />} placeholder="Search all Azure services"
            value={query} onChange={(_, d) => setQuery(d.value)} aria-label="Search services" />

          {/* category filter chips */}
          <div className={s.pFilters} role="group" aria-label="Filter by category">
            <Badge appearance={catFilter === 'all' ? 'filled' : 'outline'} color="brand"
              style={{ cursor: 'pointer' }} onClick={() => setCatFilter('all')}>
              All ({SERVICE_COUNT})
            </Badge>
            {SERVICE_CATEGORY_ORDER.map((cat) => {
              const n = servicesByCategory(cat.id).length;
              const on = catFilter === cat.id;
              return (
                <Badge key={cat.id} appearance={on ? 'filled' : 'outline'}
                  style={{ cursor: 'pointer', backgroundColor: on ? cat.color : undefined, borderColor: cat.color, color: on ? '#fff' : cat.color }}
                  onClick={() => setCatFilter(on ? 'all' : cat.id)} title={cat.label}>
                  {cat.label.split(' ')[0]} ({n})
                </Badge>
              );
            })}
          </div>

          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            {sel?.kind === 'domain' || sel?.kind === 'service'
              ? `Click or drag a service onto the selected domain. ${matchCount} services shown.`
              : `Select a domain, then click a service — or drag one onto a domain. ${matchCount} services shown.`}
          </Caption1>

          {matchCount === 0 && (
            <Caption1 style={{ color: tokens.colorNeutralForeground3, padding: '8px 4px' }}>
              No services match the current search/filter.
            </Caption1>
          )}

          {SERVICE_CATEGORY_ORDER.map((cat) => {
            const items = servicesByCategory(cat.id).filter(matches);
            if (!items.length) return null;
            const collapsed = collapsedCats.has(cat.id);
            return (
              <div key={cat.id} className={s.pGroup}>
                <button
                  type="button"
                  className={s.pGroupHead}
                  onClick={() => toggleCat(cat.id)}
                  aria-expanded={!collapsed}
                  aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${cat.label}`}
                >
                  <span className={s.pGroupChevron}>{collapsed ? <ChevronRight20Regular /> : <ChevronDown20Regular />}</span>
                  <span className={s.pGroupSwatch} style={{ background: cat.color }} />
                  <Subtitle2>{cat.label}</Subtitle2>
                  <span className={s.pGroupCount}>{items.length}</span>
                </button>
                {!collapsed && items.map((def) => {
                  const vis = serviceVisual(def.key);
                  return (
                    <Tooltip key={def.key} content={def.description} relationship="description" positioning="after">
                      <div
                        className={s.pTile}
                        draggable
                        data-service-key={def.key}
                        onDragStart={(e) => { e.dataTransfer.setData(MIME, def.key); e.dataTransfer.effectAllowed = 'copy'; }}
                        onClick={() => paletteAdd(def)}
                        role="button" tabIndex={0}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); paletteAdd(def); } }}
                      >
                        <ServiceIconChip def={def} vis={vis} Glyph={vis.glyph} remote={iconUrl(def.iconSlug ?? def.key)} size={28} iconPx={17} radius={6} />
                        <span className={s.pTileLabel}>{def.label}</span>
                        {!def.bicepFlag && !def.planOnly && (
                          <Badge size="tiny" appearance="outline" color="informative" title="Core — always deployed">core</Badge>
                        )}
                        {def.planOnly && (
                          <Badge size="tiny" appearance="outline" color="warning" title="Plan-only — no one-button bicep toggle yet">plan</Badge>
                        )}
                      </div>
                    </Tooltip>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* canvas */}
        <div className={s.canvas} onDrop={onDrop} onDragOver={onDragOver} data-canvas="deploy-planner">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onConnect={onConnect}
            onPaneClick={() => setSel(null)}
            nodesConnectable
            nodesDraggable={false}
            minZoom={0.3}
            maxZoom={2}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={null}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={tokens.colorNeutralStroke2} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable style={{ backgroundColor: tokens.colorNeutralBackground1 }} />
          </ReactFlow>
          {subs.length === 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', color: tokens.colorNeutralForeground3 }}>
              <Caption1>Click “Add subscription” to start planning your deployment.</Caption1>
            </div>
          )}
        </div>
      </div>

      {/* selected-subscription inline editor */}
      {selectedSub && (
        <div className={`${s.card} ${s.subEditor}`}>
          <Field className={s.subField} label="Subscription name">
            <Input value={selectedSub.name} onChange={(_, d) => patchSelectedSub({ name: d.value })} />
          </Field>
          <Field className={s.subField} label="Boundary">
            <Dropdown value={selectedSub.boundary || 'Commercial'} selectedOptions={[selectedSub.boundary || 'Commercial']}
              onOptionSelect={(_, d) => patchSelectedSub({ boundary: d.optionValue as PlanSubscription['boundary'] })}>
              <Option value="Commercial">Commercial</Option>
              <Option value="GCC">GCC</Option>
              <Option value="GCC-High">GCC-High</Option>
              <Option value="IL5">IL5</Option>
            </Dropdown>
          </Field>
          <Field className={s.subField} label="Region (optional)">
            <Input value={selectedSub.region || ''} placeholder="eastus2 / usgovvirginia" onChange={(_, d) => patchSelectedSub({ region: d.value })} />
          </Field>
          <Field
            className={s.subField}
            label="Deployment mode"
            hint={
              (selectedSub.deploymentMode || (selectedSub.domains.length > 1 ? 'multi-sub' : 'single-sub')) === 'single-sub'
                ? 'Admin Plane + 1 DLZ in this subscription. Add a 2nd domain to use multi-sub.'
                : 'Admin Plane here + one DLZ per domain across separate subs (fill dlzSubscriptionIds before deploy).'
            }
          >
            <Dropdown
              value={selectedSub.deploymentMode || (selectedSub.domains.length > 1 ? 'multi-sub' : 'single-sub')}
              selectedOptions={[selectedSub.deploymentMode || (selectedSub.domains.length > 1 ? 'multi-sub' : 'single-sub')]}
              onOptionSelect={(_, d) => patchSelectedSub({ deploymentMode: d.optionValue as PlanSubscription['deploymentMode'] })}
              aria-label="Deployment mode"
            >
              <Option value="single-sub">single-sub (Admin Plane + 1 DLZ)</Option>
              <Option value="multi-sub">multi-sub (one DLZ per domain)</Option>
            </Dropdown>
          </Field>
        </div>
      )}

      {/* selected-service per-resource config panel */}
      {selectedSvc?.def && (
        <div data-testid="service-config-panel" className={`${s.card} ${s.svcConfig}`}>
          <div className={s.svcConfigHead}>
            <Settings20Regular style={{ color: selectedSvc.def.color }} />
            <Subtitle2>{selectedSvc.def.label}</Subtitle2>
            {selectedSvc.subName && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>in {selectedSvc.subName}</Caption1>}
            {!selectedSvc.def.bicepFlag && !selectedSvc.def.planOnly && (
              <Badge size="small" appearance="outline" color="informative">core</Badge>
            )}
            {selectedSvc.def.planOnly && (
              <Badge size="small" appearance="outline" color="warning">plan-only</Badge>
            )}
            {selectedSvc.status === 'configured' && (
              <Badge size="small" appearance="tint" color="success" icon={<CheckmarkCircle20Regular />}>configured</Badge>
            )}
            {selectedSvc.status === 'default' && (
              <Badge size="small" appearance="outline" color="warning">using defaults</Badge>
            )}
            {selectedSvc.status === 'invalid' && (
              <Badge size="small" appearance="tint" color="danger">invalid</Badge>
            )}
            {(selectedSvc.status === 'configured' || selectedSvc.status === 'invalid') && (
              <Button size="small" appearance="subtle" onClick={resetServiceConfig}
                style={{ marginLeft: 'auto' }}>Reset to defaults</Button>
            )}
          </div>

          {selectedSvc.def.config?.length ? (
            <>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                These choices are written into the exported bicepparam and applied by{' '}
                <code>az deployment sub create</code> — the options match the module&apos;s allowed values for this boundary.
              </Caption1>
              <div className={s.fieldRow}>
                {selectedSvc.def.config.map((field) => (
                  <ConfigFieldControl
                    key={field.key}
                    field={field}
                    value={resolveConfigValue(field, selectedSvc.stored)}
                    onChange={(v) => patchServiceConfig(field.key, v)}
                  />
                ))}
              </div>
            </>
          ) : selectedSvc.def.planOnly ? (
            <MessageBar intent="warning"><MessageBarBody>
              <MessageBarTitle>Plan-only — no auto-deploy knobs</MessageBarTitle>
              {selectedSvc.def.label} is real Azure but is not provisioned by main.bicep, so it has no exported
              configuration. Provision it separately (its description explains why). It still documents intent on the canvas.
            </MessageBarBody></MessageBar>
          ) : !selectedSvc.def.bicepFlag ? (
            <MessageBar intent="info"><MessageBarBody>
              <MessageBarTitle>Core service — always deployed</MessageBarTitle>
              {selectedSvc.def.label} is part of every Loom deployment, so it has no opt-in toggle or SKU choice here.
            </MessageBarBody></MessageBar>
          ) : (
            <MessageBar intent="info"><MessageBarBody>
              {selectedSvc.def.label} deploys with its module defaults — no configurable SKU/tier is exposed for it yet.
            </MessageBarBody></MessageBar>
          )}
        </div>
      )}

      {/* selected-dependency (edge) inspector */}
      {sel?.kind === 'edge' && (() => {
        const e = subs[sel.si]?.edges?.[sel.idx];
        const from = e && parseServiceNodeId(e.from);
        const to = e && parseServiceNodeId(e.to);
        return (
          <div className={`${s.card} ${s.edgeInspector}`}>
            <Subtitle2>Dependency</Subtitle2>
            {from && to ? (
              <Body1>
                {serviceByKey(from.key)?.label || from.key} <strong>→</strong> {serviceByKey(to.key)?.label || to.key}
              </Body1>
            ) : <Body1>—</Body1>}
            <div className={s.spacer} />
            <Button size="small" icon={<Delete20Regular />} onClick={deleteSelected}>Remove dependency</Button>
          </div>
        );
      })()}

      {/* bicepparam export dialog */}
      <Dialog open={!!exportSub} onOpenChange={(_, d) => { if (!d.open) setExportSub(null); }}>
        <DialogSurface style={{ maxWidth: 820, width: '92vw' }}>
          <DialogBody>
            <DialogTitle>Export — {exportSub?.name}</DialogTitle>
            <DialogContent className={s.exportBody}>
              <TabList selectedValue={exportFmt} onTabSelect={(_, d) => setExportFmt(d.value as 'bicepparam' | 'bicep')}>
                <Tab value="bicepparam">.bicepparam (deploys main.bicep)</Tab>
                <Tab value="bicep">.bicep (standalone template)</Tab>
              </TabList>
              {exportFmt === 'bicepparam' ? (
                <Body1 className={s.exportHint}>
                  The primary path: a parameter file for the maintained orchestrator. Save as{' '}
                  <code>platform/fiab/bicep/params/{(exportSub?.name || 'plan').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.bicepparam</code> and run{' '}
                  <code>az deployment sub create -f platform/fiab/bicep/main.bicep -p &lt;file&gt;.bicepparam</code>.
                </Body1>
              ) : (
                <Body1 className={s.exportHint}>
                  A self-contained subscription-scoped template generated from the graph: every selected service with a
                  one-button module becomes a real <code>module</code>, and your dependency arrows become module{' '}
                  <code>dependsOn</code>. Save as{' '}
                  <code>platform/fiab/bicep/{(exportSub?.name || 'plan').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.architecture.bicep</code>{' '}
                  (next to main.bicep so the module paths resolve) and run{' '}
                  <code>az deployment sub create -l &lt;region&gt; -f &lt;file&gt;.architecture.bicep</code>. Role grants are
                  skipped here — see the header in the generated file.
                </Body1>
              )}
              {exportSub && (
                <Textarea
                  value={exportFmt === 'bicepparam' ? planToBicepparam(exportSub) : planToBicep(exportSub)}
                  readOnly
                  textarea={{ className: s.exportArea }}
                />
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={() => {
                if (!exportSub) return;
                const text = exportFmt === 'bicepparam' ? planToBicepparam(exportSub) : planToBicep(exportSub);
                navigator.clipboard?.writeText(text);
              }}>Copy</Button>
              <Button icon={<ArrowDownload20Regular />} onClick={() => {
                if (!exportSub) return;
                const sl = (exportSub.name || 'plan').toLowerCase().replace(/[^a-z0-9]+/g, '-');
                const text = exportFmt === 'bicepparam' ? planToBicepparam(exportSub) : planToBicep(exportSub);
                const file = exportFmt === 'bicepparam' ? `${sl}.bicepparam` : `${sl}.architecture.bicep`;
                downloadText(file, text);
              }}>Download</Button>
              <Button appearance="primary" onClick={() => setExportSub(null)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* cost-estimate report dialog */}
      <Dialog open={costOpen} onOpenChange={(_, d) => { if (!d.open) setCostOpen(false); }}>
        <DialogSurface style={{ maxWidth: 940, width: '94vw' }}>
          <DialogBody>
            <DialogTitle>Estimated monthly cost — {costSub?.name}</DialogTitle>
            <DialogContent className={s.costScroll}>
              <div className={s.costPickers}>
                <Field className={s.costPickerField} label="Currency" hint="Azure Retail Prices API currency">
                  <Dropdown
                    aria-label="Estimate currency"
                    value={RETAIL_CURRENCIES.find((c) => c.code === costCurrency)?.label || costCurrency}
                    selectedOptions={[costCurrency]}
                    disabled={costBusy}
                    onOptionSelect={(_, d) => {
                      const code = String(d.optionValue || DEFAULT_CURRENCY);
                      setCostCurrency(code);
                      if (costSub) estimateCost(costSub, { currencyCode: code, region: costRegion });
                    }}
                  >
                    {RETAIL_CURRENCIES.map((c) => (
                      <Option key={c.code} value={c.code} text={c.label}>{c.label}</Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field className={s.costPickerField} label="Pricing region" hint="Commercial armRegionName priced against">
                  <Dropdown
                    aria-label="Pricing region"
                    value={costRegion ? regionLabel(costRegion) : 'Boundary default'}
                    selectedOptions={[costRegion]}
                    disabled={costBusy}
                    onOptionSelect={(_, d) => {
                      const name = String(d.optionValue || '');
                      setCostRegion(name);
                      if (costSub) estimateCost(costSub, { currencyCode: costCurrency, region: name });
                    }}
                  >
                    <Option value="" text="Boundary default">Boundary default</Option>
                    {COMMERCIAL_REGIONS.map((r) => (
                      <Option key={r.name} value={r.name} text={r.label}>{r.label}</Option>
                    ))}
                  </Dropdown>
                </Field>
              </div>
              {costBusy && <Spinner label="Pricing the plan against the Azure Retail Prices API…" />}
              {costErr && (
                <MessageBar intent="error"><MessageBarBody>
                  <MessageBarTitle>Cost estimate failed</MessageBarTitle>{costErr}
                </MessageBarBody></MessageBar>
              )}
              {!costBusy && !costErr && costSummary && (
                <div className={s.costBody}>
                  <MessageBar intent="info"><MessageBarBody>
                    <MessageBarTitle>Best-effort list-price estimate</MessageBarTitle>
                    Computed from the public <strong>Azure Retail Prices API</strong> for{' '}
                    <code>{costSummary.region}</code> ({costSummary.boundary}), in {costSummary.currency}.
                    {costSummary.source === 'fallback-list-price' && ' Live API was unreachable — showing cached Azure list prices.'}
                    {costSummary.source === 'mixed' && ' Some rows fell back to cached Azure list prices (labelled below).'}
                    {' '}Each row is a single <em>representative</em> SKU at on-demand list price — not an exact bill.
                  </MessageBarBody></MessageBar>

                  {costSummary.govDisclaimer && (
                    <MessageBar intent="warning"><MessageBarBody>
                      <MessageBarTitle>Azure Government pricing differs</MessageBarTitle>
                      The Retail Prices API has no public Azure Government endpoint, so these figures are{' '}
                      <strong>Commercial list prices for reference only</strong> (priced against{' '}
                      <code>{costSummary.priceRegion || costSummary.region}</code>). Use the Azure Government pricing
                      pages or your EA price sheet for authoritative Gov ({costSummary.boundary}) cost.
                    </MessageBarBody></MessageBar>
                  )}

                  {costSummary.byDomain.map((dom) => (
                    <div key={dom.domainId} className={s.costDomain}>
                      <div className={s.costDomainHead}>
                        <Subtitle2>{dom.name}</Subtitle2>
                        <span className={s.costDomainTotal}>
                          {fmtMoney(dom.monthly, costSummary.currency)}/mo
                        </span>
                      </div>
                      {dom.rows.length === 0 ? (
                        <Caption1 className={s.costMuted}>No priced services in this domain.</Caption1>
                      ) : (
                        <Table size="small" aria-label={`Cost breakdown for ${dom.name}`}>
                          <TableHeader>
                            <TableRow>
                              <TableHeaderCell>Service</TableHeaderCell>
                              <TableHeaderCell>Representative SKU</TableHeaderCell>
                              <TableHeaderCell>Unit price</TableHeaderCell>
                              <TableHeaderCell>Monthly</TableHeaderCell>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {dom.rows.map((r) => (
                              <TableRow key={`${dom.domainId}:${r.key}`}>
                                <TableCell>
                                  <TableCellLayout
                                    media={<ServiceIconChip def={serviceByKey(r.key) as ServiceDef} vis={serviceVisual(r.key)} Glyph={serviceVisual(r.key).glyph} remote={iconUrl(r.key)} size={22} iconPx={13} radius={5} />}
                                  >
                                    {r.label}
                                    {r.source === 'fallback-list-price' && (
                                      <Badge size="tiny" appearance="outline" color="warning" style={{ marginLeft: 6 }}>list</Badge>
                                    )}
                                  </TableCellLayout>
                                </TableCell>
                                <TableCell>
                                  <Tooltip content={r.assumed} relationship="description">
                                    <span className={s.costSku}>
                                      {r.sku}{' '}
                                      {r.pricingDetailsUrl && (
                                        <Link href={serviceDetailsUrl(r)} target="_blank" rel="noreferrer" aria-label={`${r.label} pricing details`}>
                                          <Open16Regular style={{ verticalAlign: 'middle' }} />
                                        </Link>
                                      )}
                                    </span>
                                  </Tooltip>
                                </TableCell>
                                <TableCell>
                                  <span className={s.costUnit}>
                                    {fmtMoney(r.unitPrice, costSummary.currency)} / {r.unit}
                                  </span>
                                </TableCell>
                                <TableCell><strong>{fmtMoney(r.monthly, costSummary.currency)}</strong></TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                    </div>
                  ))}

                  <Divider />
                  <div className={s.costTotalRow}>
                    <Subtitle2>Estimated total</Subtitle2>
                    <span className={s.costGrand}>
                      {fmtMoney(costSummary.total, costSummary.currency)}/mo
                    </span>
                  </div>

                  {costSummary.unestimated.length > 0 && (
                    <div className={s.costUnest}>
                      <Caption1 style={{ fontWeight: tokens.fontWeightSemibold }}>Not estimated ({costSummary.unestimated.length})</Caption1>
                      <ul className={s.costUnestList}>
                        {costSummary.unestimated.map((u) => (
                          <li key={u.key}>
                            <Caption1>{u.label} — <span className={s.costMuted}>{u.reason}</span></Caption1>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <Caption1 className={s.costFootnote}>
                    Excludes reserved-instance / savings-plan discounts, regional differential, egress, storage,
                    and SLA surcharges. For an authoritative quote use the Azure Pricing Calculator (the deep-link
                    opens the tool — it does not auto-fill; download the breakdown below to transcribe or attach it).
                  </Caption1>
                </div>
              )}
            </DialogContent>
            <DialogActions>
              <Button
                icon={<Open16Regular />}
                as="a"
                href={pricingCalculatorUrl(costSummary?.boundary || costSub?.boundary)}
                target="_blank"
                rel="noreferrer"
              >
                Open Azure Pricing Calculator
              </Button>
              <Button
                icon={<ArrowDownload20Regular />}
                disabled={!costSummary}
                onClick={() => costSummary && downloadText(`${(costSub?.name || 'plan').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-cost-estimate.csv`, breakdownToCsv(costSummary), 'text/csv')}
              >
                Download CSV
              </Button>
              <Button
                icon={<ArrowDownload20Regular />}
                disabled={!costSummary}
                onClick={() => costSummary && downloadText(`${(costSub?.name || 'plan').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-cost-estimate.json`, breakdownToJson(costSummary), 'application/json')}
              >
                Download JSON
              </Button>
              <Button appearance="primary" onClick={() => setCostOpen(false)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

export function DeploymentPlannerView() {
  return (
    <ReactFlowProvider>
      <PlannerInner />
    </ReactFlowProvider>
  );
}

/**
 * One constrained config control. `select` → Dropdown of the module's @allowed
 * set; `number` → SpinButton bounded by @minValue/@maxValue; `text` → Input
 * validated against the field pattern. No freeform JSON (per .claude rules).
 */
function ConfigFieldControl({
  field, value, onChange,
}: {
  field: ConfigField;
  value: ConfigValue;
  onChange: (v: ConfigValue) => void;
}) {
  if (field.type === 'select') {
    const sv = String(value);
    return (
      <Field label={field.label} hint={field.help}>
        <Dropdown
          value={sv}
          selectedOptions={[sv]}
          onOptionSelect={(_, d) => { if (d.optionValue !== undefined) onChange(d.optionValue); }}
          aria-label={field.label}
        >
          {(field.allowed || []).map((opt) => <Option key={opt} value={opt}>{opt}</Option>)}
        </Dropdown>
      </Field>
    );
  }
  if (field.type === 'number') {
    const nv = Number(value);
    return (
      <Field label={field.label} hint={field.help}>
        <SpinButton
          value={Number.isFinite(nv) ? nv : Number(field.default)}
          min={field.min}
          max={field.max}
          onChange={(_, d) => {
            const next = d.value ?? (d.displayValue !== undefined ? Number(d.displayValue) : undefined);
            if (next !== undefined && Number.isFinite(next)) onChange(next);
          }}
          aria-label={field.label}
        />
      </Field>
    );
  }
  // text
  const tv = String(value);
  const invalid = !!field.pattern && tv.length > 0 && !new RegExp(field.pattern).test(tv);
  return (
    <Field
      label={field.label}
      hint={field.help}
      validationState={invalid ? 'warning' : 'none'}
      validationMessage={invalid ? 'Does not match the expected format.' : undefined}
    >
      <Input value={tv} onChange={(_, d) => onChange(d.value)} aria-label={field.label} />
    </Field>
  );
}
