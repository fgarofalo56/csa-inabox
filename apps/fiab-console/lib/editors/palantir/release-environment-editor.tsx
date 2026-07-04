'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * ReleaseEnvironmentEditor (Apollo → Shuttle) — promotion pipeline + ARM deploy history.
 *
 * Extracted verbatim from palantir-editors.tsx (behavior-preserving split —
 * zero logic change). Shared helpers/types/styles live in ./shared.
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
import { useStyles, CodeBlock, useItemState, SaveStrip, SectionHead, useOntologyBinding, type ItemDoc, type OntologySummary, type OntologyClassLite, type OntologyActionLite, type OntologySurface } from './shared';

// ───────────────────────── Release environment (Apollo → Shuttle) ─────────────────────────
type EnvType = 'dev' | 'test' | 'staging' | 'preprod' | 'prod' | 'custom';
type TargetKind = 'workspace' | 'appservice' | 'ade';
const ENV_TYPES: EnvType[] = ['dev', 'test', 'staging', 'preprod', 'prod', 'custom'];
function envTypeColor(t?: EnvType): 'brand' | 'informative' | 'warning' | 'severe' | 'success' | 'subtle' {
  switch (t) {
    case 'dev': return 'informative';
    case 'test': return 'brand';
    case 'staging': return 'warning';
    case 'preprod': return 'severe';
    case 'prod': return 'success';
    default: return 'subtle';
  }
}
interface ReleaseStage { id: string; name: string; workspace?: string }
interface ReleaseEnvironment {
  id: string; name: string; type: EnvType; order: number; targetKind: TargetKind;
  workspace?: string; subscriptionId?: string; resourceGroup?: string; site?: string; slot?: string;
  region?: string; deploymentIdentity?: string; tags?: string; currentVersion?: string;
}
interface PipelineEdge { id: string; from: string; to: string; mode: 'manual' | 'auto'; approvalsRequired: number; approvers?: string }
interface ReleaseVersion { id: string; version: string; buildId?: string; commit?: string; image?: string; notes?: string; createdAt: string }
interface ApprovalRecord { by: string; at: string; decision: 'approve' | 'reject'; comment?: string }
interface Promotion {
  id: string; fromStage: string; toStage: string; note?: string; environmentDefinition?: string; version?: string;
  status?: 'completed' | 'pending' | 'rejected'; approvalsRequired?: number; approvals?: ApprovalRecord[];
  promotedAt: string; promotedBy?: string; deployedEnvironment?: { name: string; provisioningState: string };
}
interface SwapRecord { id: string; site: string; resourceGroup: string; sourceSlot?: string; targetSlot: string; action: string; status: number; at: string; by?: string }
interface ReleaseState {
  environments?: ReleaseEnvironment[]; pipeline?: PipelineEdge[]; versions?: ReleaseVersion[];
  promotions?: Promotion[]; swaps?: SwapRecord[]; stages?: ReleaseStage[]; [k: string]: unknown;
}
interface ArmDeploymentLite { name: string; resourceGroup?: string; provisioningState?: string; timestamp?: string }
interface SlotLite { name: string; state?: string; defaultHostName?: string }

/** Migrate legacy flat `stages` into the rich environment model so existing items aren't empty. */
function migrateEnvs(p: ReleaseState): ReleaseEnvironment[] {
  const envs = Array.isArray(p.environments) ? p.environments : [];
  if (envs.length) return envs;
  const legacy = Array.isArray(p.stages) ? p.stages : [];
  return legacy.map((st, i) => ({ id: st.id, name: st.name, type: 'custom' as EnvType, order: i, targetKind: 'workspace' as TargetKind, workspace: st.workspace }));
}

export function ReleaseEnvironmentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<ReleaseState>('release-environment', id, { environments: [], pipeline: [], versions: [], promotions: [] });
  const [tab, setTab] = useState('environments');

  // Route-managed logs (real Cosmos via the promote/approve/swap/arm routes).
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [devCenter, setDevCenter] = useState(false);

  // Environment add-form.
  const [envName, setEnvName] = useState('');
  const [envType, setEnvType] = useState<EnvType>('dev');
  const [targetKind, setTargetKind] = useState<TargetKind>('workspace');
  const [envWorkspace, setEnvWorkspace] = useState('');
  const [envSub, setEnvSub] = useState('');
  const [envRg, setEnvRg] = useState('');
  const [envSite, setEnvSite] = useState('');
  const [envSlot, setEnvSlot] = useState('');
  const [envRegion, setEnvRegion] = useState('');
  const [envIdentity, setEnvIdentity] = useState('');
  const [envTags, setEnvTags] = useState('');

  // Pipeline edge add-form.
  const [edgeFrom, setEdgeFrom] = useState('');
  const [edgeTo, setEdgeTo] = useState('');
  const [edgeMode, setEdgeMode] = useState<'manual' | 'auto'>('manual');
  const [edgeApprovals, setEdgeApprovals] = useState('0');
  const [edgeApprovers, setEdgeApprovers] = useState('');

  // Version add-form.
  const [verName, setVerName] = useState('');
  const [verBuild, setVerBuild] = useState('');
  const [verCommit, setVerCommit] = useState('');
  const [verImage, setVerImage] = useState('');
  const [verNotes, setVerNotes] = useState('');

  // Promote form.
  const [fromStage, setFromStage] = useState('');
  const [toStage, setToStage] = useState('');
  const [promoVersion, setPromoVersion] = useState('');
  const [promoNote, setPromoNote] = useState('');
  const [envDef, setEnvDef] = useState('');
  const [promoMsg, setPromoMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [promoBusy, setPromoBusy] = useState(false);

  // Approvals.
  const [apprComment, setApprComment] = useState<Record<string, string>>({});
  const [apprBusy, setApprBusy] = useState(false);
  const [apprMsg, setApprMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);

  // Slot swap.
  const [swapEnvId, setSwapEnvId] = useState('');
  const [slots, setSlots] = useState<SlotLite[] | null>(null);
  const [swapSource, setSwapSource] = useState('');
  const [swapTarget, setSwapTarget] = useState('');
  const [swapAction, setSwapAction] = useState<'swap' | 'apply' | 'complete' | 'cancel'>('swap');
  const [swapGate, setSwapGate] = useState<string | null>(null);
  const [swapMsg, setSwapMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [swapBusy, setSwapBusy] = useState(false);

  // ARM history.
  const [arm, setArm] = useState<ArmDeploymentLite[] | null>(null);
  const [armGate, setArmGate] = useState<string | null>(null);
  const [armBusy, setArmBusy] = useState(false);

  const environments = useMemo<ReleaseEnvironment[]>(
    () => [...migrateEnvs(state)].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [state],
  );
  const pipeline = Array.isArray(state.pipeline) ? state.pipeline : [];
  const versions = Array.isArray(state.versions) ? state.versions : [];
  const swaps = Array.isArray(state.swaps) ? state.swaps : [];
  const appserviceEnvs = environments.filter((e) => e.targetKind === 'appservice');
  const pending = promotions.filter((p) => p.status === 'pending');

  const loadPromotions = useCallback(async () => {
    try {
      const r = await clientFetch(`/api/items/release-environment/${encodeURIComponent(id)}/promote`);
      const j = await r.json().catch(() => ({}));
      if (j?.ok) { setPromotions(Array.isArray(j.promotions) ? j.promotions : []); setDevCenter(!!j.devCenterConfigured); }
    } catch { /* ignore */ }
  }, [id]);
  useEffect(() => { if (id && id !== 'new') void loadPromotions(); }, [id, loadPromotions]);

  const loadArm = useCallback(async () => {
    setArmBusy(true); setArmGate(null);
    try {
      const r = await clientFetch(`/api/items/release-environment/${encodeURIComponent(id)}/arm`);
      const j = await r.json().catch(() => ({}));
      if (j?.ok) setArm(Array.isArray(j.deployments) ? j.deployments : []);
      else if (j?.gate) setArmGate(j.gate.remediation || j.gate.reason || 'Azure Resource Manager not configured.');
      else setArmGate(j?.error || `HTTP ${r.status}`);
    } catch (e: any) { setArmGate(e?.message || String(e)); }
    finally { setArmBusy(false); }
  }, [id]);

  const addEnvironment = useCallback(() => {
    const name = envName.trim(); if (!name) return;
    setState((p) => {
      const cur = migrateEnvs(p);
      const order = cur.reduce((m, e) => Math.max(m, e.order ?? 0), -1) + 1;
      const next: ReleaseEnvironment = {
        id: `env_${Date.now()}`, name, type: envType, order, targetKind,
        workspace: envWorkspace.trim() || undefined, subscriptionId: envSub.trim() || undefined,
        resourceGroup: envRg.trim() || undefined, site: envSite.trim() || undefined, slot: envSlot.trim() || undefined,
        region: envRegion.trim() || undefined, deploymentIdentity: envIdentity.trim() || undefined, tags: envTags.trim() || undefined,
      };
      return { ...p, environments: [...cur, next] };
    });
    setEnvName(''); setEnvWorkspace(''); setEnvSub(''); setEnvRg(''); setEnvSite(''); setEnvSlot(''); setEnvRegion(''); setEnvIdentity(''); setEnvTags('');
  }, [envName, envType, targetKind, envWorkspace, envSub, envRg, envSite, envSlot, envRegion, envIdentity, envTags, setState]);

  const removeEnvironment = useCallback((eid: string) => {
    setState((p) => ({ ...p, environments: migrateEnvs(p).filter((x) => x.id !== eid) }));
  }, [setState]);

  const moveEnvironment = useCallback((eid: string, dir: -1 | 1) => {
    setState((p) => {
      const cur = [...migrateEnvs(p)].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const i = cur.findIndex((x) => x.id === eid); const j = i + dir;
      if (i < 0 || j < 0 || j >= cur.length) return p;
      [cur[i], cur[j]] = [cur[j], cur[i]];
      return { ...p, environments: cur.map((e, k) => ({ ...e, order: k })) };
    });
  }, [setState]);

  const addEdge = useCallback(() => {
    if (!edgeFrom || !edgeTo || edgeFrom === edgeTo) return;
    setState((p) => ({ ...p, pipeline: [...(Array.isArray(p.pipeline) ? p.pipeline : []), {
      id: `edge_${Date.now()}`, from: edgeFrom, to: edgeTo, mode: edgeMode,
      approvalsRequired: Math.max(0, Number(edgeApprovals) || 0), approvers: edgeApprovers.trim() || undefined,
    }] }));
    setEdgeApprovers('');
  }, [edgeFrom, edgeTo, edgeMode, edgeApprovals, edgeApprovers, setState]);

  const removeEdge = useCallback((edid: string) => {
    setState((p) => ({ ...p, pipeline: (Array.isArray(p.pipeline) ? p.pipeline : []).filter((x) => x.id !== edid) }));
  }, [setState]);

  const addVersion = useCallback(() => {
    const v = verName.trim(); if (!v) return;
    setState((p) => ({ ...p, versions: [{
      id: `ver_${Date.now()}`, version: v, buildId: verBuild.trim() || undefined, commit: verCommit.trim() || undefined,
      image: verImage.trim() || undefined, notes: verNotes.trim() || undefined, createdAt: new Date().toISOString(),
    }, ...(Array.isArray(p.versions) ? p.versions : [])] }));
    setVerName(''); setVerBuild(''); setVerCommit(''); setVerImage(''); setVerNotes('');
  }, [verName, verBuild, verCommit, verImage, verNotes, setState]);

  const removeVersion = useCallback((vid: string) => {
    setState((p) => ({ ...p, versions: (Array.isArray(p.versions) ? p.versions : []).filter((x) => x.id !== vid) }));
  }, [setState]);

  const promote = useCallback(async () => {
    if (!fromStage || !toStage) { setPromoMsg({ intent: 'error', text: 'Pick both environments.' }); return; }
    setPromoBusy(true); setPromoMsg(null);
    try {
      const r = await clientFetch(`/api/items/release-environment/${encodeURIComponent(id)}/promote`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fromStage, toStage, version: promoVersion.trim() || undefined, note: promoNote.trim() || undefined, environmentDefinition: envDef.trim() || undefined }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const text = j?.gate ? `${j.gate.reason} ${j.gate.remediation}` : (j?.error || `HTTP ${r.status}`);
        setPromoMsg({ intent: j?.gate ? 'warning' : 'error', text });
        return;
      }
      setPromotions(Array.isArray(j.promotions) ? j.promotions : []);
      const dep = j.deployedEnvironment;
      setPromoMsg({
        intent: 'success',
        text: j.pending
          ? `Promotion ${fromStage} → ${toStage} queued for approval — clear it in the Approvals tab.`
          : dep
            ? `Promoted ${fromStage} → ${toStage}. Azure Deployment Environment "${dep.name}" → ${dep.provisioningState}.`
            : `Promoted ${fromStage} → ${toStage}.`,
      });
      setPromoNote('');
    } catch (e: any) { setPromoMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setPromoBusy(false); }
  }, [id, fromStage, toStage, promoVersion, promoNote, envDef]);

  const decide = useCallback(async (promotionId: string, decision: 'approve' | 'reject') => {
    setApprBusy(true); setApprMsg(null);
    try {
      const r = await clientFetch(`/api/items/release-environment/${encodeURIComponent(id)}/approve`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ promotionId, decision, comment: (apprComment[promotionId] || '').trim() || undefined }),
      });
      const j = await r.json().catch(() => ({}));
      if (Array.isArray(j.promotions)) setPromotions(j.promotions);
      if (!j?.ok) {
        const text = j?.gate ? `${j.gate.reason} ${j.gate.remediation}` : (j?.error || `HTTP ${r.status}`);
        setApprMsg({ intent: 'warning', text });
        return;
      }
      setApprMsg({ intent: 'success', text: `Recorded ${decision}.${j.promotion?.status === 'completed' ? ' Promotion completed + deployed.' : j.promotion?.status === 'rejected' ? ' Promotion rejected.' : ''}` });
      setApprComment((m) => ({ ...m, [promotionId]: '' }));
    } catch (e: any) { setApprMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setApprBusy(false); }
  }, [id, apprComment]);

  const loadSlots = useCallback(async () => {
    const env = environments.find((e) => e.id === swapEnvId);
    setSwapGate(null); setSwapMsg(null); setSlots(null);
    if (!env?.resourceGroup || !env?.site) { setSwapMsg({ intent: 'warning', text: 'Selected environment needs a resource group and App Service site.' }); return; }
    setSwapBusy(true);
    try {
      const r = await clientFetch(`/api/items/release-environment/${encodeURIComponent(id)}/swap?resourceGroup=${encodeURIComponent(env.resourceGroup)}&site=${encodeURIComponent(env.site)}`);
      const j = await r.json().catch(() => ({}));
      if (j?.ok) setSlots(Array.isArray(j.slots) ? j.slots : []);
      else if (j?.gate) setSwapGate(j.gate.remediation || j.gate.reason);
      else setSwapMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` });
    } catch (e: any) { setSwapMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setSwapBusy(false); }
  }, [environments, swapEnvId, id]);

  const runSwap = useCallback(async () => {
    const env = environments.find((e) => e.id === swapEnvId);
    if (!env?.resourceGroup || !env?.site) { setSwapMsg({ intent: 'warning', text: 'Selected environment needs a resource group and App Service site.' }); return; }
    if (!swapTarget.trim()) { setSwapMsg({ intent: 'warning', text: 'Pick a target slot.' }); return; }
    setSwapBusy(true); setSwapMsg(null); setSwapGate(null);
    try {
      const r = await clientFetch(`/api/items/release-environment/${encodeURIComponent(id)}/swap`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resourceGroup: env.resourceGroup, site: env.site, sourceSlot: swapSource.trim() || undefined, targetSlot: swapTarget.trim(), action: swapAction }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const text = j?.gate ? `${j.gate.reason} ${j.gate.remediation}` : (j?.error || `HTTP ${r.status}`);
        setSwapMsg({ intent: j?.gate ? 'warning' : 'error', text });
        return;
      }
      setSwapMsg({ intent: 'success', text: `Slot ${swapAction} on ${env.site} (${swapSource.trim() || 'production'} ↔ ${swapTarget.trim()}) accepted — ARM HTTP ${j.result?.status}.` });
    } catch (e: any) { setSwapMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setSwapBusy(false); }
  }, [environments, swapEnvId, swapSource, swapTarget, swapAction, id]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Environment', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || !dirty },
        { label: armBusy ? 'Loading…' : 'ARM history', onClick: loadArm, disabled: armBusy },
      ]},
    ]},
  ], [save, saving, dirty, loadArm, armBusy]);

  if (id === 'new') return <NewItemCreateGate item={item} createLabel="Create release environment" intro="Promotion / release orchestration across environments (dev → test → prod) with a promotion pipeline, approval gates, release versions, and real App Service slot swaps + Azure Deployment Environments. Azure-native — no Fabric required." />;

  // Pipeline lane: ordered environment cards joined by connectors that surface
  // each consecutive edge's mode + gate (Fabric Deployment Pipelines style).
  const laneNodes: ReactNode[] = [];
  environments.forEach((e, i) => {
    laneNodes.push(
      <div key={e.id} className={s.stageCard}>
        <div className={s.cardHead}><Cloud20Regular /><Subtitle2>{e.name}</Subtitle2><Badge appearance="tint" color={envTypeColor(e.type)}>{e.type}</Badge></div>
        <Caption1 className={s.hint}>{e.targetKind}{e.site ? ` · ${e.site}${e.slot ? `/${e.slot}` : ''}` : e.workspace ? ` · ${e.workspace}` : ''}</Caption1>
        <Badge appearance="outline">{e.currentVersion ? `v ${e.currentVersion}` : 'no version'}</Badge>
      </div>,
    );
    if (i < environments.length - 1) {
      const next = environments[i + 1];
      const edge = pipeline.find((x) => x.from === e.name && x.to === next.name);
      laneNodes.push(
        <div key={`c_${e.id}`} className={s.connector}>
          <ChevronRight20Regular />
          {edge
            ? <Badge size="small" appearance="tint" color={edge.mode === 'auto' ? 'success' : 'informative'}>{edge.mode}</Badge>
            : <Caption1 className={s.hint}>no edge</Caption1>}
          {edge && edge.approvalsRequired > 0 && <Badge size="small" appearance="tint" color="warning">gate {edge.approvalsRequired}</Badge>}
        </div>,
      );
    }
  });

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info"><MessageBarBody>
          <MessageBarTitle>Release environment (Palantir Apollo → Shuttle)</MessageBarTitle>
          Model dev → test → prod environments, wire a promotion pipeline with approval gates, track release versions, and execute real Azure promotions — App Service slot swaps and Azure Deployment Environments.{devCenter ? ' Azure Deployment Environments is configured — name a catalog environment definition when promoting.' : ' Set LOOM_DEVCENTER_PROJECT to provision catalog-driven Azure Deployment Environments.'} No Fabric required.
        </MessageBarBody></MessageBar>

        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)} className={s.tabStrip}>
          <Tab value="environments" icon={<Cloud20Regular />}>Environments</Tab>
          <Tab value="pipeline" icon={<Branch20Regular />}>Pipeline</Tab>
          <Tab value="promote" icon={<Rocket20Regular />}>Promote / Swap</Tab>
          <Tab value="approvals" icon={<People20Regular />}>Approvals{pending.length ? ` (${pending.length})` : ''}</Tab>
          <Tab value="versions" icon={<Tag20Regular />}>Versions</Tab>
          <Tab value="history" icon={<History20Regular />}>History</Tab>
        </TabList>

        {/* ───────── Environments ───────── */}
        {tab === 'environments' && (
        <div className={s.section}>
          <SectionHead icon={<Cloud20Regular />} title="Environments" hint="dev → test → prod environments as first-class objects, ordered into a promotion sequence." />
          <div className={s.addBar}>
            <Field label="Name" className={s.fieldNarrow}><Input value={envName} onChange={(_, d) => setEnvName(d.value)} placeholder="prod" /></Field>
            <Field label="Type" className={s.fieldNarrow}><Dropdown value={envType} selectedOptions={[envType]} onOptionSelect={(_, d) => setEnvType((d.optionValue as EnvType) || 'dev')}>
              {ENV_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
            </Dropdown></Field>
            <Field label="Target" className={s.fieldNarrow}><Dropdown value={targetKind} selectedOptions={[targetKind]} onOptionSelect={(_, d) => setTargetKind((d.optionValue as TargetKind) || 'workspace')}>
              <Option value="workspace">Loom workspace</Option><Option value="appservice">App Service + slot</Option><Option value="ade">Deployment env</Option>
            </Dropdown></Field>
            {targetKind === 'workspace' && <Field label="Workspace"><Input value={envWorkspace} onChange={(_, d) => setEnvWorkspace(d.value)} placeholder="workspace id / name" /></Field>}
            {targetKind === 'appservice' && <>
              <Field label="Resource group" className={s.fieldNarrow}><Input value={envRg} onChange={(_, d) => setEnvRg(d.value)} placeholder="rg-loom" /></Field>
              <Field label="Site" className={s.fieldNarrow}><Input value={envSite} onChange={(_, d) => setEnvSite(d.value)} placeholder="loom-app" /></Field>
              <Field label="Slot" className={s.fieldNarrow}><Input value={envSlot} onChange={(_, d) => setEnvSlot(d.value)} placeholder="staging" /></Field>
            </>}
            {targetKind === 'ade' && <Field label="Resource group" className={s.fieldNarrow}><Input value={envRg} onChange={(_, d) => setEnvRg(d.value)} placeholder="rg-loom" /></Field>}
            {targetKind !== 'workspace' && <Field label="Subscription" className={s.fieldNarrow}><Input value={envSub} onChange={(_, d) => setEnvSub(d.value)} placeholder="sub id (optional)" /></Field>}
            <Field label="Region" className={s.fieldNarrow}><Input value={envRegion} onChange={(_, d) => setEnvRegion(d.value)} placeholder="eastus" /></Field>
            <Field label="Identity" className={s.fieldNarrow}><Input value={envIdentity} onChange={(_, d) => setEnvIdentity(d.value)} placeholder="UAMI (optional)" /></Field>
            <Field label="Tags" className={s.fieldNarrow}><Input value={envTags} onChange={(_, d) => setEnvTags(d.value)} placeholder="team=data" /></Field>
            <Button appearance="primary" icon={<Add20Regular />} disabled={!envName.trim()} onClick={addEnvironment}>Add environment</Button>
          </div>
          {environments.length === 0 ? <div className={s.empty}><Caption1>No environments yet — add dev / test / prod above.</Caption1></div> : (
            <div className={s.grid2}>
              {environments.map((e) => (
                <div key={e.id} className={s.stageCard}>
                  <div className={s.cardHead}>
                    <Cloud20Regular /><Subtitle2>{e.name}</Subtitle2>
                    <Badge appearance="tint" color={envTypeColor(e.type)}>{e.type}</Badge>
                    <span className={s.spacer} /><Caption1 className={s.hint}>#{(e.order ?? 0) + 1}</Caption1>
                  </div>
                  <div className={s.kv}><Caption1 className={s.hint}>Target</Caption1><Caption1>{e.targetKind}</Caption1></div>
                  {e.targetKind === 'workspace' && e.workspace && <div className={s.kv}><Caption1 className={s.hint}>Workspace</Caption1><Caption1>{e.workspace}</Caption1></div>}
                  {e.targetKind === 'appservice' && <div className={s.kv}><Caption1 className={s.hint}>Site / slot</Caption1><Caption1>{e.site || '—'}{e.slot ? ` / ${e.slot}` : ''}</Caption1></div>}
                  {e.resourceGroup && <div className={s.kv}><Caption1 className={s.hint}>Resource group</Caption1><Caption1>{e.resourceGroup}</Caption1></div>}
                  {e.region && <div className={s.kv}><Caption1 className={s.hint}>Region</Caption1><Caption1>{e.region}</Caption1></div>}
                  {e.deploymentIdentity && <div className={s.kv}><Caption1 className={s.hint}>Identity</Caption1><Caption1>{e.deploymentIdentity}</Caption1></div>}
                  {e.tags && <div className={s.kv}><Caption1 className={s.hint}>Tags</Caption1><Caption1>{e.tags}</Caption1></div>}
                  <div className={s.kv}><Caption1 className={s.hint}>Installed version</Caption1><Badge appearance="outline">{e.currentVersion || 'none'}</Badge></div>
                  <div className={s.cardActions}>
                    <Button size="small" appearance="subtle" onClick={() => moveEnvironment(e.id, -1)}>↑ Up</Button>
                    <Button size="small" appearance="subtle" onClick={() => moveEnvironment(e.id, 1)}>↓ Down</Button>
                    <span className={s.spacer} />
                    <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${e.name}`} onClick={() => removeEnvironment(e.id)}>Remove</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <SaveStrip saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
        </div>
        )}

        {/* ───────── Pipeline ───────── */}
        {tab === 'pipeline' && (
        <div className={s.section}>
          <SectionHead icon={<Branch20Regular />} title="Promotion pipeline" hint="Directed promotion paths between environments, each with a manual/auto mode and an optional approval gate." />
          {environments.length === 0 ? <div className={s.empty}><Caption1>Add environments first.</Caption1></div> : <div className={s.pipelineLane}>{laneNodes}</div>}
          <div className={s.addBar}>
            <Field label="From" className={s.fieldNarrow}><Dropdown value={edgeFrom} selectedOptions={edgeFrom ? [edgeFrom] : []} onOptionSelect={(_, d) => setEdgeFrom(d.optionValue || '')} placeholder="from">
              {environments.map((e) => <Option key={e.id} value={e.name}>{e.name}</Option>)}
            </Dropdown></Field>
            <Field label="To" className={s.fieldNarrow}><Dropdown value={edgeTo} selectedOptions={edgeTo ? [edgeTo] : []} onOptionSelect={(_, d) => setEdgeTo(d.optionValue || '')} placeholder="to">
              {environments.map((e) => <Option key={e.id} value={e.name}>{e.name}</Option>)}
            </Dropdown></Field>
            <Field label="Mode" className={s.fieldNarrow}><Dropdown value={edgeMode} selectedOptions={[edgeMode]} onOptionSelect={(_, d) => setEdgeMode((d.optionValue as 'manual' | 'auto') || 'manual')}>
              <Option value="manual">manual</Option><Option value="auto">auto</Option>
            </Dropdown></Field>
            <Field label="Approvals required" className={s.fieldNarrow}><Input type="number" value={edgeApprovals} onChange={(_, d) => setEdgeApprovals(d.value)} /></Field>
            <Field label="Approvers (optional)"><Input value={edgeApprovers} onChange={(_, d) => setEdgeApprovers(d.value)} placeholder="alice@contoso.com, bob@contoso.com" /></Field>
            <Button appearance="primary" icon={<Add20Regular />} disabled={!edgeFrom || !edgeTo || edgeFrom === edgeTo} onClick={addEdge}>Add edge</Button>
          </div>
          {pipeline.length === 0 ? <div className={s.empty}><Caption1>No promotion edges yet.</Caption1></div> : (
            <div className={s.tableWrap}>
            <Table size="small" aria-label="Pipeline edges">
              <TableHeader><TableRow><TableHeaderCell>From</TableHeaderCell><TableHeaderCell>To</TableHeaderCell><TableHeaderCell>Mode</TableHeaderCell><TableHeaderCell>Gate</TableHeaderCell><TableHeaderCell>Approvers</TableHeaderCell><TableHeaderCell /></TableRow></TableHeader>
              <TableBody>
                {pipeline.map((ed) => (
                  <TableRow key={ed.id}>
                    <TableCell>{ed.from}</TableCell><TableCell>{ed.to}</TableCell>
                    <TableCell><Badge appearance="tint" color={ed.mode === 'auto' ? 'success' : 'informative'}>{ed.mode}</Badge></TableCell>
                    <TableCell>{ed.approvalsRequired > 0 ? <Badge appearance="tint" color="warning">{ed.approvalsRequired} approver(s)</Badge> : <Caption1 className={s.hint}>none</Caption1>}</TableCell>
                    <TableCell>{ed.approvers || '—'}</TableCell>
                    <TableCell><Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Remove edge" onClick={() => removeEdge(ed.id)} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
          <SaveStrip saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
        </div>
        )}

        {/* ───────── Promote / Swap ───────── */}
        {tab === 'promote' && (<>
        <div className={s.section}>
          <SectionHead icon={<Rocket20Regular />} title="Promote" hint="Promote a release version between environments. Gated edges queue for approval; an Azure Deployment Environment is created when a definition is named." />
          <div className={s.addBar}>
            <Field label="From" className={s.fieldNarrow}><Dropdown value={fromStage} selectedOptions={fromStage ? [fromStage] : []} onOptionSelect={(_, d) => setFromStage(d.optionValue || '')} placeholder="from">
              {environments.map((e) => <Option key={e.id} value={e.name}>{e.name}</Option>)}
            </Dropdown></Field>
            <Field label="To" className={s.fieldNarrow}><Dropdown value={toStage} selectedOptions={toStage ? [toStage] : []} onOptionSelect={(_, d) => setToStage(d.optionValue || '')} placeholder="to">
              {environments.map((e) => <Option key={e.id} value={e.name}>{e.name}</Option>)}
            </Dropdown></Field>
            <Field label="Version" className={s.fieldNarrow}><Dropdown value={promoVersion} selectedOptions={promoVersion ? [promoVersion] : []} onOptionSelect={(_, d) => setPromoVersion(d.optionValue || '')} placeholder="version">
              {versions.map((v) => <Option key={v.id} value={v.version}>{v.version}</Option>)}
            </Dropdown></Field>
            {devCenter && <Field label="Environment definition"><Input value={envDef} onChange={(_, d) => setEnvDef(d.value)} placeholder="loom-app-env" /></Field>}
            <Field label="Note"><Input value={promoNote} onChange={(_, d) => setPromoNote(d.value)} placeholder="release notes" /></Field>
            <Button appearance="primary" icon={<Rocket20Regular />} disabled={promoBusy || !fromStage || !toStage} onClick={promote}>{promoBusy ? 'Promoting…' : 'Promote'}</Button>
          </div>
          {promoMsg && <MessageBar intent={promoMsg.intent}><MessageBarBody>{promoMsg.text}</MessageBarBody></MessageBar>}
        </div>

        <div className={s.section}>
          <SectionHead icon={<ArrowSwap20Regular />} title="App Service slot swap" hint="Blue-green promotion + rollback via real Microsoft.Web/sites slot swaps for an App Service-backed environment." />
          {appserviceEnvs.length === 0 ? (
            <div className={s.empty}><Caption1>No App Service environments. Add an environment with target “App Service + slot” (resource group + site) to swap slots.</Caption1></div>
          ) : (<>
            <div className={s.addBar}>
              <Field label="Environment" className={s.fieldStep}><Dropdown value={environments.find((e) => e.id === swapEnvId)?.name || ''} selectedOptions={swapEnvId ? [swapEnvId] : []} onOptionSelect={(_, d) => { setSwapEnvId(d.optionValue || ''); setSlots(null); setSwapGate(null); }} placeholder="App Service env">
                {appserviceEnvs.map((e) => <Option key={e.id} value={e.id} text={`${e.name} · ${e.site}`}>{e.name} · {e.site}</Option>)}
              </Dropdown></Field>
              <Button appearance="outline" disabled={swapBusy || !swapEnvId} onClick={loadSlots}>{swapBusy ? 'Loading…' : 'Load slots'}</Button>
            </div>
            {swapGate && <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>App Service not configured</MessageBarTitle>{swapGate}</MessageBarBody></MessageBar>}
            {slots && (
              <div className={s.addBar}>
                <Field label="Source slot" className={s.fieldNarrow}><Dropdown value={swapSource} selectedOptions={swapSource ? [swapSource] : []} onOptionSelect={(_, d) => setSwapSource(d.optionValue || '')} placeholder="production">
                  <Option value="production">production</Option>
                  {slots.map((sl) => <Option key={sl.name} value={sl.name}>{sl.name}</Option>)}
                </Dropdown></Field>
                <Field label="Target slot" className={s.fieldNarrow}><Dropdown value={swapTarget} selectedOptions={swapTarget ? [swapTarget] : []} onOptionSelect={(_, d) => setSwapTarget(d.optionValue || '')} placeholder="staging">
                  {slots.map((sl) => <Option key={sl.name} value={sl.name}>{sl.name}</Option>)}
                  <Option value="production">production</Option>
                </Dropdown></Field>
                <Field label="Action" className={s.fieldNarrow}><Dropdown value={swapAction} selectedOptions={[swapAction]} onOptionSelect={(_, d) => setSwapAction((d.optionValue as 'swap' | 'apply' | 'complete' | 'cancel') || 'swap')}>
                  <Option value="swap">swap</Option><Option value="apply">apply (preview)</Option><Option value="complete">complete</Option><Option value="cancel">cancel</Option>
                </Dropdown></Field>
                <Button appearance="primary" icon={<ArrowSwap20Regular />} disabled={swapBusy || !swapTarget} onClick={runSwap}>{swapBusy ? 'Running…' : 'Run'}</Button>
              </div>
            )}
            {slots && slots.length === 0 && !swapGate && <div className={s.empty}><Caption1>Site has no deployment slots — add a staging slot in the portal to enable swaps.</Caption1></div>}
            {swapMsg && <MessageBar intent={swapMsg.intent}><MessageBarBody>{swapMsg.text}</MessageBarBody></MessageBar>}
          </>)}
        </div>
        </>)}

        {/* ───────── Approvals ───────── */}
        {tab === 'approvals' && (
        <div className={s.section}>
          <SectionHead icon={<People20Regular />} title="Pending approvals" hint="Promotions held by an approval gate. Approve or reject with a comment; the deploy runs when the gate clears." />
          {apprMsg && <MessageBar intent={apprMsg.intent}><MessageBarBody>{apprMsg.text}</MessageBarBody></MessageBar>}
          {pending.length === 0 ? <div className={s.empty}><Caption1>No promotions waiting for approval.</Caption1></div> : (
            <div className={s.grid2}>
              {pending.map((p) => {
                const approved = (p.approvals || []).filter((a) => a.decision === 'approve').length;
                return (
                  <div key={p.id} className={s.stageCard}>
                    <div className={s.cardHead}>
                      <Badge appearance="tint" color="informative">{p.fromStage}</Badge><ChevronRight20Regular /><Badge appearance="tint" color="brand">{p.toStage}</Badge>
                      <span className={s.spacer} /><Badge appearance="tint" color="warning">{approved}/{p.approvalsRequired || 1}</Badge>
                    </div>
                    {p.version && <div className={s.kv}><Caption1 className={s.hint}>Version</Caption1><Caption1>{p.version}</Caption1></div>}
                    {p.note && <div className={s.kv}><Caption1 className={s.hint}>Note</Caption1><Caption1>{p.note}</Caption1></div>}
                    <div className={s.kv}><Caption1 className={s.hint}>Requested by</Caption1><Caption1>{p.promotedBy || '—'}</Caption1></div>
                    <Field label="Comment"><Input value={apprComment[p.id] || ''} onChange={(_, d) => setApprComment((m) => ({ ...m, [p.id]: d.value }))} placeholder="optional approval comment" /></Field>
                    <div className={s.cardActions}>
                      <Button size="small" appearance="primary" icon={<CheckmarkCircle20Regular />} disabled={apprBusy} onClick={() => decide(p.id, 'approve')}>Approve</Button>
                      <Button size="small" appearance="subtle" icon={<DismissCircle20Regular />} disabled={apprBusy} onClick={() => decide(p.id, 'reject')}>Reject</Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        )}

        {/* ───────── Versions ───────── */}
        {tab === 'versions' && (
        <div className={s.section}>
          <SectionHead icon={<Tag20Regular />} title="Release versions" hint="The artifact versions promoted between environments — build id, git commit, container tag, notes." />
          <div className={s.addBar}>
            <Field label="Version" className={s.fieldNarrow}><Input value={verName} onChange={(_, d) => setVerName(d.value)} placeholder="1.4.0" /></Field>
            <Field label="Build id" className={s.fieldNarrow}><Input value={verBuild} onChange={(_, d) => setVerBuild(d.value)} placeholder="ci-1234" /></Field>
            <Field label="Commit" className={s.fieldNarrow}><Input value={verCommit} onChange={(_, d) => setVerCommit(d.value)} placeholder="a1b2c3d" /></Field>
            <Field label="Container tag" className={s.fieldNarrow}><Input value={verImage} onChange={(_, d) => setVerImage(d.value)} placeholder="acr.azurecr.io/app:1.4.0" /></Field>
            <Field label="Notes"><Input value={verNotes} onChange={(_, d) => setVerNotes(d.value)} placeholder="changelog" /></Field>
            <Button appearance="primary" icon={<Add20Regular />} disabled={!verName.trim()} onClick={addVersion}>Add version</Button>
          </div>
          {versions.length === 0 ? <div className={s.empty}><Caption1>No versions yet.</Caption1></div> : (
            <div className={s.tableWrap}>
            <Table size="small" aria-label="Versions">
              <TableHeader><TableRow><TableHeaderCell>Version</TableHeaderCell><TableHeaderCell>Build</TableHeaderCell><TableHeaderCell>Commit</TableHeaderCell><TableHeaderCell>Container tag</TableHeaderCell><TableHeaderCell>Notes</TableHeaderCell><TableHeaderCell /></TableRow></TableHeader>
              <TableBody>
                {versions.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell><Badge appearance="tint" color="brand">{v.version}</Badge></TableCell>
                    <TableCell>{v.buildId || '—'}</TableCell><TableCell>{v.commit || '—'}</TableCell>
                    <TableCell>{v.image || '—'}</TableCell><TableCell>{v.notes || '—'}</TableCell>
                    <TableCell><Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Remove version" onClick={() => removeVersion(v.id)} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
          <SectionHead icon={<Database20Regular />} title="What's where" hint="The release version currently installed in each environment (updated on promotion)." />
          {environments.length === 0 ? <div className={s.empty}><Caption1>Add environments to see the matrix.</Caption1></div> : (
            <div className={s.tableWrap}>
            <Table size="small" aria-label="Version matrix">
              <TableHeader><TableRow><TableHeaderCell>Environment</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>Installed version</TableHeaderCell></TableRow></TableHeader>
              <TableBody>
                {environments.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>{e.name}</TableCell>
                    <TableCell><Badge appearance="tint" color={envTypeColor(e.type)}>{e.type}</Badge></TableCell>
                    <TableCell>{e.currentVersion ? <Badge appearance="outline">{e.currentVersion}</Badge> : <Caption1 className={s.hint}>none</Caption1>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
          <SaveStrip saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
        </div>
        )}

        {/* ───────── History ───────── */}
        {tab === 'history' && (<>
        <div className={s.section}>
          <SectionHead icon={<History20Regular />} title="Promotion history" hint="Every recorded promotion, its status, version, and any deployed Azure environment." />
          {promotions.length === 0 ? <div className={s.empty}><Caption1>No promotions yet.</Caption1></div> : (
            <div className={s.tableWrap}>
            <Table size="small" aria-label="Promotions">
              <TableHeader><TableRow><TableHeaderCell>From</TableHeaderCell><TableHeaderCell>To</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell><TableHeaderCell>Version</TableHeaderCell><TableHeaderCell>When</TableHeaderCell><TableHeaderCell>By</TableHeaderCell><TableHeaderCell>Note</TableHeaderCell></TableRow></TableHeader>
              <TableBody>
                {promotions.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{p.fromStage}</TableCell><TableCell>{p.toStage}</TableCell>
                    <TableCell><Badge appearance="tint" color={p.status === 'completed' ? 'success' : p.status === 'rejected' ? 'danger' : 'warning'}>{p.status || 'completed'}</Badge></TableCell>
                    <TableCell>{p.version || '—'}</TableCell>
                    <TableCell>{new Date(p.promotedAt).toLocaleString()}</TableCell>
                    <TableCell>{p.promotedBy || '—'}</TableCell><TableCell>{p.note || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </div>

        {swaps.length > 0 && (
        <div className={s.section}>
          <SectionHead icon={<ArrowSwap20Regular />} title="Slot swaps" hint="Real App Service slot operations executed from this environment." />
          <div className={s.tableWrap}>
          <Table size="small" aria-label="Slot swaps">
            <TableHeader><TableRow><TableHeaderCell>Site</TableHeaderCell><TableHeaderCell>Action</TableHeaderCell><TableHeaderCell>Slots</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell><TableHeaderCell>When</TableHeaderCell><TableHeaderCell>By</TableHeaderCell></TableRow></TableHeader>
            <TableBody>
              {swaps.map((sw) => (
                <TableRow key={sw.id}>
                  <TableCell>{sw.site}</TableCell><TableCell><Badge appearance="tint" color="informative">{sw.action}</Badge></TableCell>
                  <TableCell>{sw.sourceSlot || 'production'} ↔ {sw.targetSlot}</TableCell>
                  <TableCell>{sw.status}</TableCell>
                  <TableCell>{new Date(sw.at).toLocaleString()}</TableCell><TableCell>{sw.by || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>
        </div>
        )}

        <div className={s.section}>
          <SectionHead icon={<Database20Regular />} title="Azure Resource Manager deployments" hint="Real ARM deployment history across the Loom resource groups." />
          <Button appearance="outline" disabled={armBusy} onClick={loadArm}>{armBusy ? 'Loading…' : 'Load ARM history'}</Button>
          {armGate && <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Azure not configured</MessageBarTitle>{armGate}</MessageBarBody></MessageBar>}
          {arm && arm.length === 0 && !armGate && <div className={s.empty}><Caption1>No ARM deployments found in the Loom resource groups.</Caption1></div>}
          {arm && arm.length > 0 && (
            <div className={s.tableWrap}>
            <Table size="small" aria-label="ARM deployments">
              <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Resource group</TableHeaderCell><TableHeaderCell>State</TableHeaderCell><TableHeaderCell>Timestamp</TableHeaderCell></TableRow></TableHeader>
              <TableBody>
                {arm.map((d, i) => (
                  <TableRow key={`${d.name}_${i}`}>
                    <TableCell>{d.name}</TableCell><TableCell>{d.resourceGroup || '—'}</TableCell>
                    <TableCell>{d.provisioningState || '—'}</TableCell>
                    <TableCell>{d.timestamp ? new Date(d.timestamp).toLocaleString() : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </div>
        </>)}
      </div>
    } />
  );
}
