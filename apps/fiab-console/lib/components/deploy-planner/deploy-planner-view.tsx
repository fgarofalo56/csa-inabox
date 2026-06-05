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
  useReactFlow, type Node, type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Button, Badge, Caption1, Subtitle2, Body1, Input, Dropdown, Option, Field, Tooltip,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle, Spinner, Textarea,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Save20Regular, ArrowDownload20Regular, Delete20Regular, Search16Regular,
  ChevronDown20Regular, ChevronRight20Regular,
} from '@fluentui/react-icons';
import { SubscriptionNode, DomainNode, ServiceNode, ServiceIconChip } from './deploy-plan-nodes';
import {
  SERVICE_CATALOG, SERVICE_CATEGORY_ORDER, servicesByCategory, serviceByKey, serviceVisual,
  SERVICE_COUNT, TOGGLEABLE_SERVICE_COUNT,
  type ServiceDef, type ServiceCategory,
} from './service-catalog';
import { iconUrl } from '../ui/item-type-visual';
import { planToBicepparam } from './bicepparam';
import type { PlanSubscription } from './types';

const nodeTypes: NodeTypes = { subscription: SubscriptionNode, domain: DomainNode, service: ServiceNode };

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
          data: { serviceKey: key },
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
  | null;

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
  rectsRef.current = rects;

  const onNodeClick = useCallback((_: unknown, n: Node) => {
    const [kind, si, di, key] = n.id.split(':');
    if (kind === 'sub') setSel({ kind: 'subscription', si: Number(si) });
    else if (kind === 'dom') setSel({ kind: 'domain', si: Number(si), di: Number(di) });
    else if (kind === 'svc') setSel({ kind: 'service', si: Number(si), di: Number(di), key });
  }, []);

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
      if (sel.kind === 'service') {
        const dom = d[sel.si]?.domains[sel.di];
        if (dom) dom.services = dom.services.filter((k) => k !== sel.key);
      } else if (sel.kind === 'domain') {
        d[sel.si]?.domains.splice(sel.di, 1);
      } else if (sel.kind === 'subscription') {
        d.splice(sel.si, 1);
      }
    });
    setSel(null);
  }, [sel, mutate]);

  const patchSelectedSub = useCallback((patch: Partial<PlanSubscription>) => {
    if (sel?.kind !== 'subscription') return;
    mutate((d) => { Object.assign(d[sel.si], patch); });
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

  const q = query.trim().toLowerCase();
  const matches = (def: ServiceDef) =>
    (catFilter === 'all' || def.category === catFilter) &&
    (!q || def.label.toLowerCase().includes(q) || def.key.toLowerCase().includes(q)
      || def.description.toLowerCase().includes(q));
  const matchCount = SERVICE_CATALOG.filter(matches).length;

  const selectedSub = sel?.kind === 'subscription' ? subs[sel.si] : null;

  if (loading) return <Spinner label="Loading deployment plan…" />;

  return (
    <div className={s.root}>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Planning, not deploying</MessageBarTitle>
          Plan from a catalog of {SERVICE_COUNT} Azure service types ({TOGGLEABLE_SERVICE_COUNT} have a
          one-button bicep toggle; <Badge size="tiny" appearance="outline" color="warning">plan</Badge> services
          are real Azure but not auto-provisioned by main.bicep yet, so they are not written as bicep params).
          Save persists this plan to Cosmos. To deploy, use <strong>Export bicepparam</strong> on a
          subscription, then run <code>az deployment sub create -f platform/fiab/bicep/main.bicep -p &lt;file&gt;.bicepparam</code>
          {' '}or trigger the deploy-fiab workflow. Domains come from{' '}
          <a href="/admin/domains">Admin → Domains</a>.
        </MessageBarBody>
      </MessageBar>

      <div className={s.toolbar}>
        <Button appearance="primary" icon={<Add20Regular />} onClick={addSubscription}>Add subscription</Button>
        <Button icon={<Add20Regular />} disabled={sel?.kind !== 'subscription' && sel?.kind !== 'domain'} onClick={addDomainToSelectedSub}>Add domain</Button>
        <Button icon={<Delete20Regular />} disabled={!sel} onClick={deleteSelected}>
          Remove {sel?.kind || 'selection'}
        </Button>
        <div style={{ flex: 1 }} />
        <Button icon={<ArrowDownload20Regular />} disabled={!selectedSub} onClick={() => selectedSub && setExportSub(selectedSub)}>
          Export bicepparam
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
                        <ServiceIconChip def={def} vis={vis} Glyph={vis.glyph} remote={iconUrl(def.key)} size={28} iconPx={17} radius={6} />
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
            edges={[]}
            nodeTypes={nodeTypes}
            onNodeClick={onNodeClick}
            onPaneClick={() => setSel(null)}
            nodesConnectable={false}
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
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', padding: 12, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6 }}>
          <Field label="Subscription name">
            <Input value={selectedSub.name} onChange={(_, d) => patchSelectedSub({ name: d.value })} />
          </Field>
          <Field label="Boundary">
            <Dropdown value={selectedSub.boundary || 'Commercial'} selectedOptions={[selectedSub.boundary || 'Commercial']}
              onOptionSelect={(_, d) => patchSelectedSub({ boundary: d.optionValue as PlanSubscription['boundary'] })}>
              <Option value="Commercial">Commercial</Option>
              <Option value="GCC">GCC</Option>
              <Option value="GCC-High">GCC-High</Option>
              <Option value="IL5">IL5</Option>
            </Dropdown>
          </Field>
          <Field label="Region (optional)">
            <Input value={selectedSub.region || ''} placeholder="eastus2 / usgovvirginia" onChange={(_, d) => patchSelectedSub({ region: d.value })} />
          </Field>
        </div>
      )}

      {/* bicepparam export dialog */}
      <Dialog open={!!exportSub} onOpenChange={(_, d) => { if (!d.open) setExportSub(null); }}>
        <DialogSurface style={{ maxWidth: 760, width: '90vw' }}>
          <DialogBody>
            <DialogTitle>bicepparam — {exportSub?.name}</DialogTitle>
            <DialogContent>
              <Body1 style={{ display: 'block', marginBottom: 8, color: tokens.colorNeutralForeground3 }}>
                Save as <code>platform/fiab/bicep/params/{(exportSub?.name || 'plan').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.bicepparam</code> and run
                {' '}<code>az deployment sub create</code> against it.
              </Body1>
              {exportSub && (
                <Textarea value={planToBicepparam(exportSub)} readOnly textarea={{ style: { fontFamily: 'monospace', fontSize: 12, minHeight: 320 } }} />
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={() => { if (exportSub) navigator.clipboard?.writeText(planToBicepparam(exportSub)); }}>Copy</Button>
              <Button appearance="primary" onClick={() => setExportSub(null)}>Close</Button>
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
