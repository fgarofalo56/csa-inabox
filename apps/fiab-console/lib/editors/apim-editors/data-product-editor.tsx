'use client';

// data-product-editor.tsx — DataProductEditor shell. The 12-tab editor's
// private types + constants, pure projection helpers, picker-source data hooks,
// and the F21 Publish-as-API dialog were extracted to ./data-product/* in the
// R8 decomposition (loom-next-level WS-E). Pure move — no behavior change; the
// shell keeps the shared editor state (state/dirty/status) + all tab render
// blocks + save/publish/register handlers.
//   ./data-product/types.ts                  — DataProductState + siblings, DP_EMPTY, GUID_RE
//   ./data-product/content.ts                — projectDataProductContent, parseOwnerString (pure)
//   ./data-product/hooks.ts                  — useDataProductWorkspaces, useGovernanceDomains
//   ./data-product/publish-as-api-dialog.tsx — PublishAsApiDialog (F21)
// (Originally itself extracted verbatim from apim-editors.tsx — WS-E1.)
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Input, Textarea, Switch, Dropdown, Option, Field,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, Tooltip,
  tokens,
} from '@fluentui/react-components';
import {
  Save20Regular, ArrowSync20Regular, CloudArrowUp20Regular,
  Document20Regular, Code20Regular, Library20Regular, BranchFork20Regular,
  ArrowImport20Regular, Add20Regular, Delete20Regular, Key20Regular, Edit20Regular,
  Pulse20Regular, Database20Regular, Warning20Filled, MoreHorizontal20Regular, Link20Regular,
  ShieldCheckmark20Regular, History20Regular,
  DocumentBulletList20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { ItemEditorChrome } from '../item-editor-chrome';
import { EmptyState } from '@/lib/components/empty-state';
import { ManagePoliciesDialog } from '../components/manage-policies-dialog';
import { policyTiers } from '@/lib/types/access-policy';
import { useObservability, DqScoreGauge, ObservabilityTabContent } from '../data-product-detail';
import { DeleteDataProductDialog } from '../components/delete-data-product-dialog';
import { AddDataAssetsPanel, type DataAssetRef as DataAssetWithFlags } from '../components/add-data-assets-panel';
import { ImportDataProductsFlyout } from '../components/import-data-products-flyout';
import {
  SelectAttributePanel, LinkListAttributePanel, type AttrReceipt,
} from '../components/inline-attribute-panel';
import { UPDATE_FREQUENCIES } from '@/lib/dataproducts/attributes';
import { OwnerPeoplePicker } from '@/lib/dataproducts/owner-picker';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { useRegisterRibbonCommands } from '@/lib/components/shared/ribbon-commands';
import { LinkedResourcesPanel } from '../components/linked-resources';
import { DataContractStudioTab } from '../components/data-contract-designer';
import { DataProductEditDialog } from '../data-product-edit-dialog';
import { CertificationPanel } from '../components/certification-panel';
import { PortsPanel } from '../components/ports-panel';
import { VersionsPanel } from '../components/versions-panel';
import { useStyles } from './styles';
import { StatusBar } from './shared';
import {
  type DataProductDataset, type DataProductGlossaryLink, type PersistedAssetRef,
  type DataProductState, type PurviewNotConfiguredHint,
  GUID_RE, DP_EMPTY,
} from './data-product/types';
import { projectDataProductContent } from './data-product/content';
import { useDataProductWorkspaces, useGovernanceDomains } from './data-product/hooks';
import { PublishAsApiDialog } from './data-product/publish-as-api-dialog';

export function DataProductEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const router = useRouter();
  const searchParams = useSearchParams();
  const ws = useDataProductWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [state, setState] = useState<DataProductState>(DP_EMPTY);
  // Mirror `state` into a ref so async action handlers (save / publish*) read
  // the freshest committed field values directly. The old trick —
  // `setState(prev => { snapshot = prev; return prev; })` — only captured fresh
  // state via React's eager-evaluation bailout, which is SKIPPED once the fiber
  // already has a pending update (e.g. setStatus('saving') runs first), so the
  // snapshot read DP_EMPTY and create persisted an empty product. The ref is
  // unconditionally current.
  const stateRef = useRef(state);
  stateRef.current = state;
  const [loading, setLoading] = useState(id !== 'new');
  // F4 — Data Product Edit dialog (3-step, per-step PATCH) open state.
  const [editOpen, setEditOpen] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'ok' | 'err'; msg?: string }>({ kind: 'idle' });
  const [dirty, setDirty] = useState(false);
  // Phase 1: when /register-purview returns 501, we surface the structured
  // hint payload as a dedicated MessageBar so the operator sees the bicep
  // module path + roles to grant.
  const [purviewHint, setPurviewHint] = useState<PurviewNotConfiguredHint | null>(null);
  // F13 — precondition-gated destructive delete dialog.
  const [deleteOpen, setDeleteOpen] = useState(false);

  // F21 Publish-as-API — dialog state. The serviceUrl is the backing query
  // endpoint APIM proxies to; the receipt carries the callable URL + key.
  const [publishApiOpen, setPublishApiOpen] = useState(false);
  const [publishApiServiceUrl, setPublishApiServiceUrl] = useState('');
  const [publishApiBusy, setPublishApiBusy] = useState(false);
  const [publishApiResult, setPublishApiResult] = useState<{
    callableUrl: string; primaryKey?: string; apiId: string; productId: string; sid: string; gatewayUrl: string;
  } | null>(null);
  const [publishApiGate, setPublishApiGate] = useState<{ hint: string; missing?: string; bicepModule?: string } | null>(null);
  const [publishApiErr, setPublishApiErr] = useState<string | null>(null);
  const [publishApiKeyVisible, setPublishApiKeyVisible] = useState(false);

  const domains = useGovernanceDomains();

  // Tabs: Overview | Datasets | Data assets | Glossary | Linked resources | Lineage | Access policies | Observability
  // Initial tab can be deep-linked via ?tab= (e.g. the details page's
  // "Manage policies" action opens directly on the policies tab).
  type DpTab = 'overview' | 'contract' | 'datasets' | 'data-assets' | 'glossary' | 'linked-resources' | 'lineage' | 'policies' | 'observability' | 'certification' | 'ports' | 'versions';
  const initialTab = ((): DpTab => {
    const t = searchParams?.get('tab');
    return t === 'contract' || t === 'datasets' || t === 'data-assets' || t === 'glossary' || t === 'linked-resources' || t === 'lineage' || t === 'policies' || t === 'observability' || t === 'certification'
      ? t
      : 'overview';
  })();
  const [tab, setTab] = useState<DpTab>(initialTab);

  // F19/F20 — Data Observability: live GET feeds the Overview DQ gauge AND the
  // Observability tab (lineage + health charts + DQ breakdown). One source of truth.
  const observability = useObservability(id);

  // Bulk "Import from CSV" flyout (F2 import + F18 monitoring) — creates many
  // draft data-product items from a CSV in one shot. Available on /new and on
  // an existing item alike (it always creates NEW items).
  const [importOpen, setImportOpen] = useState(false);

  // Dataset (Atlas entity) registration form.
  const [dsName, setDsName] = useState('');
  // Azure-native leads (no-fabric-dependency.md): the default asset type is
  // an ADLS Gen2 (Delta) lakehouse path; OneLake/Fabric is the opt-in tail.
  const [dsType, setDsType] = useState('azure_datalake_gen2_path');
  const [dsQName, setDsQName] = useState('');
  const [dsClass, setDsClass] = useState<string[]>([]);
  // Governance label taxonomy (/api/governance/classification-types) so dataset
  // classifications are PICKED from the tenant's standard set, not free-typed
  // (.claude/rules/loom-no-freeform-config.md). No free-text fallback: when the
  // taxonomy is empty the form shows an honest deep-link to the admin page.
  const [classTypes, setClassTypes] = useState<string[]>([]);
  useEffect(() => {
    clientFetch('/api/governance/classification-types')
      .then((r) => r.json())
      .then((j) => { if (j?.ok) setClassTypes((j.types || []).map((t: any) => t.name).filter(Boolean)); })
      .catch(() => {});
  }, []);
  const dsClassSelected = dsClass;
  const [dsBusy, setDsBusy] = useState(false);
  const [dsMsg, setDsMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Glossary term create/link.
  const [glName, setGlName] = useState('');
  const [glDesc, setGlDesc] = useState('');
  const [glBusy, setGlBusy] = useState(false);
  const [glMsg, setGlMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // F9 — Data assets (curated physical Data Map assets, with deleted/dqRunning flags).
  const [assets, setAssets] = useState<DataAssetWithFlags[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [assetsErr, setAssetsErr] = useState<string | null>(null);
  const [assetPanelOpen, setAssetPanelOpen] = useState(false);
  const [assetMsg, setAssetMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const [removingGuid, setRemovingGuid] = useState<string | null>(null);

  // Lineage.
  const [lineage, setLineage] = useState<{ nodes: any[]; edges: any[] } | null>(null);
  const [lineageBusy, setLineageBusy] = useState(false);
  const [lineageErr, setLineageErr] = useState<string | null>(null);

  // Access policies (F8) — per-product policy persisted to state.accessPolicy
  // in Cosmos, edited via the Manage Policies dialog.
  const [policiesOpen, setPoliciesOpen] = useState(false);

  // F6 — lifecycle (Publish / Set to draft / Set to expired).
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [lifecycleMsg, setLifecycleMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Phase 4.5 — all field mutations use functional updates so that if an
  // async response (e.g. registerPurview hydrating purviewDataProductId)
  // lands between the user's keystroke and React's commit, neither edit
  // clobbers the other. Same pattern as notebook-editor.tsx patchCell fix.
  const patchState = useCallback((patch: Partial<DataProductState>) => {
    setState((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  }, []);

  // Inline right-rail attribute persistence (F5 / F11 / F12). Sends ONLY the
  // changed field to the partial-merge PATCH /api/data-products/[id] — the
  // server merges it into the persisted Cosmos state without clobbering other
  // fields — and returns a receipt (request body + response) for the panel.
  const patchAttr = useCallback(async (patch: Record<string, unknown>): Promise<AttrReceipt> => {
    const url = `/api/data-products/${encodeURIComponent(id)}`;
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.ok === false) throw new Error(j?.error || `HTTP ${r.status}`);
    return { method: 'PATCH', url, requestBody: patch, status: r.status, response: j, at: new Date().toISOString() };
  }, [id]);

  // v3.27: F-vaporware fix — Cosmos-backed load, removes hardcoded
  // 'Customer 360' / alice@contoso / fixed bundle grid.
  useEffect(() => {
    if (id === 'new') { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await clientFetch(`/api/cosmos-items/data-product/${encodeURIComponent(id)}`);
        const j = await r.json();
        if (cancelled) return;
        // /api/cosmos-items/[type]/[id] returns the bare WorkspaceItem record
        // (state lives at the top level), not an { ok, item } envelope. On
        // error it returns { ok:false, error }. Read state from the top level
        // (with a legacy j.item.state fallback) so a bundle-installed data
        // product opens FULLY BUILT-OUT — its datasets, glossary terms, owner,
        // and endorsement from state.content — instead of an empty form.
        const itemState = (j?.state ?? j?.item?.state) as Record<string, unknown> | undefined;
        if (j?.ok === false) {
          // 404 on fresh items is expected; show empty form rather than error.
          if (r.status !== 404) setLoadErr(j.error || `HTTP ${r.status}`);
        } else if (itemState) {
          setState({ ...DP_EMPTY, ...projectDataProductContent(itemState) });
          setDirty(false);
        }
      } catch (e: any) {
        if (!cancelled) setLoadErr(e?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  const save = useCallback(async () => {
    setStatus({ kind: 'saving' });
    setPurviewHint(null);
    // Snapshot current state from the latest committed render via functional
    // setter — guarantees we PUT the user's freshest field values, not a
    // stale closure capture from when the Save callback was last memoised.
    const snapshot: DataProductState = stateRef.current;
    const displayName = snapshot.displayName || 'Untitled data product';
    try {
      if (id === 'new') {
        // Create a real Cosmos item, then navigate to the persisted editor
        // where Register-with-Purview / Publish-to-APIM act on a real id.
        if (!workspaceId) { setStatus({ kind: 'err', msg: 'Select a workspace before saving.' }); return; }
        const r = await clientFetch(`/api/cosmos-items/data-product`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId, displayName, state: snapshot }),
        });
        const j = await r.json();
        if (!j.ok || !j.item?.id) { setStatus({ kind: 'err', msg: j.error || `HTTP ${r.status}` }); return; }
        setDirty(false);
        router.push(`/items/data-product/${encodeURIComponent(j.item.id)}`);
        return;
      }
      const r = await clientFetch(`/api/cosmos-items/data-product/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: snapshot, displayName }),
      });
      const j = await r.json();
      if (!j.ok) { setStatus({ kind: 'err', msg: j.error || `HTTP ${r.status}` }); return; }
      setDirty(false);
      setStatus({ kind: 'ok', msg: snapshot.purviewDataProductId
        ? 'Saved to Cosmos. Re-register with Purview to propagate edits to the Unified Catalog.'
        : 'Saved to Cosmos. Click Register with Purview to publish to the Unified Catalog.' });
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message || String(e) });
    }
  }, [id, workspaceId, router]);

  const publishApimMirror = useCallback(async () => {
    setStatus({ kind: 'saving' });
    setPurviewHint(null);
    // Snapshot to avoid stale closure of state.displayName/description.
    const snapshot: DataProductState = stateRef.current;
    try {
      const r = await clientFetch(`/api/items/apim-product`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id,
          displayName: snapshot.displayName || 'Untitled data product',
          description: snapshot.description,
          state: 'published',
          subscriptionRequired: true,
          approvalRequired: false,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setStatus({ kind: 'err', msg: j.error || `HTTP ${r.status}` }); return; }
      // Stamp apimPublished on the item so the F8 Manage-policies dialog gates
      // editing while Published (Purview parity). Persist it durably to Cosmos.
      setState((prev) => ({ ...prev, apimPublished: true }));
      try {
        await clientFetch(`/api/cosmos-items/data-product/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ state: { ...snapshot, apimPublished: true } }),
        });
      } catch { /* non-fatal: local flag still gates the dialog this session */ }
      setStatus({ kind: 'ok', msg: `Published API consumer surface as APIM product '${j.product.name}'. (Note: this is the API access layer, NOT the Purview Data Product registration.)` });
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message || String(e) });
    }
  }, [id]);

  // F21 — Publish-as-API: create a real APIM API + product + active subscription
  // fronting the data product's backing query endpoint, then persist the API
  // ref to Cosmos and surface the callable URL + subscription key.
  const publishAsApi = useCallback(async () => {
    if (!publishApiServiceUrl.trim()) { setPublishApiErr('Backing service URL is required.'); return; }
    setPublishApiBusy(true); setPublishApiErr(null); setPublishApiGate(null); setPublishApiResult(null);
    // Snapshot so the request body uses the freshest name/description.
    const snapshot: DataProductState = stateRef.current;
    try {
      const r = await clientFetch(`/api/items/data-product/${encodeURIComponent(id)}/publish-api`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          serviceUrl: publishApiServiceUrl.trim(),
          displayName: snapshot.displayName || undefined,
          description: snapshot.description || undefined,
        }),
      });
      const j = await r.json();
      if (r.status === 503 && j?.gated) {
        setPublishApiGate({ hint: j.hint || j.error || 'APIM not configured', missing: j.missing, bicepModule: j.bicepModule });
        return;
      }
      if (!j.ok) { setPublishApiErr(j.error || `HTTP ${r.status}`); return; }
      // Hydrate the Cosmos-persisted refs from the receipt (no reload needed).
      setState((prev) => ({
        ...prev,
        apimApiId: j.apiId,
        apimProductId: j.productId,
        apimSubscriptionId: j.sid,
        apimGatewayUrl: j.gatewayUrl,
        apimServiceUrl: publishApiServiceUrl.trim(),
        apimApiPath: j.apimCreate?.api?.path,
        apimPublishedAt: j.apimPublishedAt,
      }));
      setPublishApiResult({
        callableUrl: j.callableUrl,
        primaryKey: j.primaryKey,
        apiId: j.apiId,
        productId: j.productId,
        sid: j.sid,
        gatewayUrl: j.gatewayUrl,
      });
    } catch (e: any) { setPublishApiErr(e?.message || String(e)); }
    finally { setPublishApiBusy(false); }
  }, [id, publishApiServiceUrl]);

  const registerPurview = useCallback(async () => {
    setStatus({ kind: 'saving' });
    setPurviewHint(null);
    try {
      const r = await clientFetch(`/api/items/data-product/${encodeURIComponent(id)}/register-purview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      const j = await r.json();
      if (r.status === 501 && j?.hint) {
        // Honest config-only state per .claude/rules/no-vaporware.md — the
        // backend is gated, surface the actionable hint to the operator.
        setPurviewHint(j.hint as PurviewNotConfiguredHint);
        setStatus({ kind: 'idle' });
        return;
      }
      if (!j.ok) {
        const detail = j.hint?.followUp ? ` Hint: ${j.hint.followUp}` : (j.hint ? ` Hint: ${j.hint}` : '');
        setStatus({ kind: 'err', msg: `${j.error || `HTTP ${r.status}`}${detail}` });
        return;
      }
      // Success — hydrate the local state with the returned id + timestamp
      // so the MessageBar flips from "pending" to "registered" without a reload.
      setState((prev) => ({
        ...prev,
        purviewDataProductId: j.purviewDataProductId,
        lastRegisteredAt: j.lastRegisteredAt,
      }));
      setStatus({
        kind: 'ok',
        msg: `Registered with Purview Unified Catalog. dataProductId=${j.purviewDataProductId} · lastRegisteredAt=${j.lastRegisteredAt}`,
      });
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message || String(e) });
    }
  }, [id]);

  // Bundle composition is DERIVED from the real attached components — never
  // free-typed (no-freeform-config). It reflects exactly what this data product
  // wraps: curated Data Map assets, registered datasets, linked glossary terms,
  // the access policy, and any published API. Persisted into state.bundle so the
  // Purview register call (register-purview) always ships accurate descriptors.
  const derivedBundle = useMemo(() => {
    const lines: string[] = [];
    for (const a of (state.dataAssets || [])) lines.push(`Data asset: ${a.name}${a.entityType ? ` (${a.entityType})` : ''}`);
    for (const d of (state.datasets || [])) lines.push(`Dataset: ${d.name}${d.typeName ? ` (${d.typeName})` : ''}`);
    for (const g of (state.glossaryLinks || [])) lines.push(`Glossary term: ${g.name}`);
    if (state.accessPolicy) lines.push('Access policy: configured');
    if (state.apimApiId) lines.push(`Published API: ${state.apimApiPath || state.apimApiId}`);
    return lines;
  }, [state.dataAssets, state.datasets, state.glossaryLinks, state.accessPolicy, state.apimApiId, state.apimApiPath]);

  // Keep the persisted bundle in sync with the derived composition. Uses the
  // functional setState updater (fresh prev) + an equality guard so it never
  // loops and never spuriously marks the form dirty on load.
  useEffect(() => {
    setState((prev) => {
      const cur = prev.bundle || [];
      if (cur.length === derivedBundle.length && cur.every((v, i) => v === derivedBundle[i])) return prev;
      return { ...prev, bundle: derivedBundle };
    });
  }, [derivedBundle]);

  // ---- F6 lifecycle: Publish / Set to draft / Set to expired ----
  // The server (/api/data-products/[id]/status) is the authoritative guard:
  // Publish enforces >=1 asset + an active Access policy + a set domain and
  // returns 422 with the precise precondition reason. We surface that reason
  // verbatim in the lifecycle MessageBar. Cosmos is the source of truth — no
  // Microsoft Fabric / Power BI dependency.
  const handleSetStatus = useCallback(async (next: 'PUBLISHED' | 'DRAFT' | 'EXPIRED') => {
    setLifecycleBusy(true); setLifecycleMsg(null);
    try {
      const r = await clientFetch(`/api/data-products/${encodeURIComponent(id)}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      const j = await r.json();
      if (r.status === 422 && j?.preconditionFailed) {
        setLifecycleMsg({ intent: 'error', text: j.preconditionFailed.message });
        return;
      }
      if (!j?.ok) { setLifecycleMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
      setState((prev) => ({ ...prev, lifecycleStatus: next, lifecycleStatusAt: j.lifecycleStatusAt }));
      const label = next === 'PUBLISHED' ? 'Published' : next === 'EXPIRED' ? 'set to expired' : 'set to draft';
      setLifecycleMsg({
        intent: 'success',
        text: next === 'PUBLISHED'
          ? `Published. ${j.purviewSync ? 'Purview unified catalog updated.' : (j.purviewSyncNote || 'Consumers can now discover this data product.')}`
          : `Status ${label}.${next === 'EXPIRED' ? ' Consumers can no longer discover this data product.' : ''}`,
      });
    } catch (e: any) {
      setLifecycleMsg({ intent: 'error', text: e?.message || String(e) });
    } finally {
      setLifecycleBusy(false);
    }
  }, [id]);

  // ---- Datasets (register Atlas entity + classifications) ----
  const registerDataset = useCallback(async () => {
    if (!dsName.trim() || !dsQName.trim()) { setDsMsg({ intent: 'error', text: 'Name and qualified name are required.' }); return; }
    setDsBusy(true); setDsMsg(null);
    const classifications = dsClass.map((c) => c.trim()).filter(Boolean);
    try {
      // register-via-Atlas through the existing cross-source register route.
      const r = await clientFetch('/api/catalog/register', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: dsType.startsWith('databricks') ? 'unity-catalog' : 'onelake',
          displayName: dsName.trim(),
          // For onelake source, the route resolves workspaceId/itemId; for a
          // direct Atlas upsert we pass the qualifiedName + classifications.
          fullName: dsQName.trim(),
          qualifiedName: dsQName.trim(),
          typeName: dsType,
          classifications,
          domain: GUID_RE.test(state.domain) ? state.domain : undefined,
        }),
      });
      const j = await r.json();
      if (r.status === 501) { setDsMsg({ intent: 'error', text: 'Purview not provisioned in this deployment — set LOOM_PURVIEW_ACCOUNT to register datasets.' }); return; }
      if (!j.ok) { setDsMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      const ds: DataProductDataset = { name: dsName.trim(), typeName: dsType, qualifiedName: dsQName.trim(), classifications, guid: j.guid || j.primaryGuid };
      setState((prev) => ({ ...prev, datasets: [...(prev.datasets || []), ds] }));
      setDirty(true);
      setDsMsg({ intent: 'success', text: `Registered ${dsName} (guid ${ds.guid || 'assigned'}). Save to persist the link.` });
      setDsName(''); setDsQName(''); setDsClass([]);
    } catch (e: any) { setDsMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setDsBusy(false); }
  }, [dsName, dsType, dsQName, dsClass, state.domain]);

  const removeDataset = (qn: string) => { setState((prev) => ({ ...prev, datasets: (prev.datasets || []).filter((d) => d.qualifiedName !== qn) })); setDirty(true); };

  // ---- Glossary terms (create + link to the product) ----
  const createGlossaryLink = useCallback(async () => {
    if (!glName.trim()) { setGlMsg({ intent: 'error', text: 'Term name is required.' }); return; }
    setGlBusy(true); setGlMsg(null);
    try {
      const r = await clientFetch('/api/catalog/glossary', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          term: { name: glName.trim(), longDescription: glDesc || undefined },
          ...(state.purviewDataProductId ? { applyTo: { source: 'purview', entityGuid: state.purviewDataProductId } } : {}),
        }),
      });
      const j = await r.json();
      if (r.status === 501) { setGlMsg({ intent: 'error', text: 'Purview not provisioned — set LOOM_PURVIEW_ACCOUNT to manage glossary terms.' }); return; }
      if (!j.ok) { setGlMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      const link: DataProductGlossaryLink = { name: j.term?.name || glName.trim(), guid: j.term?.guid };
      setState((prev) => ({ ...prev, glossaryLinks: [...(prev.glossaryLinks || []), link] }));
      setDirty(true);
      setGlMsg({ intent: 'success', text: `Created term '${link.name}'${j.applied ? ' and linked to the data product' : ''}. Save to persist.` });
      setGlName(''); setGlDesc('');
    } catch (e: any) { setGlMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setGlBusy(false); }
  }, [glName, glDesc, state.purviewDataProductId]);

  const removeGlossaryLink = (name: string) => { setState((prev) => ({ ...prev, glossaryLinks: (prev.glossaryLinks || []).filter((g) => g.name !== name) })); setDirty(true); };

  // ---- F9 Data assets (curate physical Data Map assets the product wraps) ----
  // The /api/data-products/[id]/assets route is the source of truth: it persists
  // state.dataAssets directly to Cosmos AND computes deleted / dqRunning flags.
  // We mirror the persisted refs back into editor state so a later Overview Save
  // round-trips them instead of clobbering state.dataAssets with the empty form.
  const syncAssetRefs = useCallback((persisted: PersistedAssetRef[]) => {
    setState((prev) => ({
      ...prev,
      dataAssets: persisted.map((a) => ({
        guid: a.guid, name: a.name, qualifiedName: a.qualifiedName,
        entityType: a.entityType, addedAt: a.addedAt,
      })),
    }));
  }, []);

  const loadAssets = useCallback(async () => {
    if (id === 'new') { setAssets([]); return; }
    setAssetsLoading(true); setAssetsErr(null);
    try {
      const r = await clientFetch(`/api/data-products/${encodeURIComponent(id)}/assets`);
      const j = await r.json();
      if (!j.ok) { setAssetsErr(j.error || `HTTP ${r.status}`); return; }
      const list: DataAssetWithFlags[] = j.assets || [];
      setAssets(list);
      syncAssetRefs(list);
    } catch (e: any) {
      setAssetsErr(e?.message || String(e));
    } finally {
      setAssetsLoading(false);
    }
  }, [id, syncAssetRefs]);

  // After the panel attaches assets (route already persisted), refresh flags.
  const onAssetsAdded = useCallback((persisted: PersistedAssetRef[]) => {
    syncAssetRefs(persisted);
    setAssetMsg({ intent: 'success', text: `Added ${persisted.length} attached asset${persisted.length === 1 ? '' : 's'}.` });
    void loadAssets();
  }, [syncAssetRefs, loadAssets]);

  const removeAsset = useCallback(async (guid: string, force = false) => {
    setRemovingGuid(guid); setAssetMsg(null);
    try {
      const r = await clientFetch(
        `/api/data-products/${encodeURIComponent(id)}/assets?guid=${encodeURIComponent(guid)}${force ? '&force=1' : ''}`,
        { method: 'DELETE' },
      );
      const j = await r.json();
      if (!j.ok) {
        setAssetMsg({ intent: 'error', text: j.blocked ? `Blocked: ${j.error}` : (j.error || `HTTP ${r.status}`) });
        return;
      }
      syncAssetRefs(j.dataAssets || []);
      setAssetMsg({ intent: 'success', text: 'Asset removed.' });
      void loadAssets();
    } catch (e: any) {
      setAssetMsg({ intent: 'error', text: e?.message || String(e) });
    } finally {
      setRemovingGuid(null);
    }
  }, [id, syncAssetRefs, loadAssets]);

  // ---- Lineage ----
  const loadLineage = useCallback(async () => {
    const guid = state.datasets?.[0]?.guid || state.purviewDataProductId;
    if (!guid) { setLineageErr('Register a dataset (or the data product with Purview) first — lineage is centered on a Purview entity GUID.'); return; }
    setLineageBusy(true); setLineageErr(null); setLineage(null);
    try {
      const r = await clientFetch(`/api/catalog/lineage?source=purview&id=${encodeURIComponent(guid)}`);
      const j = await r.json();
      if (r.status === 501) { setLineageErr('Purview not provisioned — lineage requires LOOM_PURVIEW_ACCOUNT.'); return; }
      if (!j.ok) { setLineageErr(j.error || `HTTP ${r.status}`); return; }
      setLineage({ nodes: j.nodes || [], edges: j.edges || [] });
    } catch (e: any) { setLineageErr(e?.message || String(e)); }
    finally { setLineageBusy(false); }
  }, [state.datasets, state.purviewDataProductId]);

  // ---- Access policies (F8) ----
  // Per-product access policy is edited via the Manage Policies dialog
  // (GET/PUT /api/data-products/[id]/access-policy → state.accessPolicy in
  // Cosmos). The read-only summary on the policies tab renders from
  // state.accessPolicy, hydrated on item load.

  useEffect(() => {
    if (tab === 'lineage') loadLineage();
    if (tab === 'data-assets') loadAssets();
  }, [tab, loadLineage, loadAssets]);

  // Phase 4.5 — Ctrl+S / Cmd+S shortcut for Save. Matches notebook-editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && status.kind !== 'saving' && state.displayName) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, status.kind, state.displayName, save]);

  // Ribbon — Save + Publish to APIM + the full Purview governance surface
  // (Datasets / Glossary / Lineage / Access policies). No disabled buttons.
  const isNew = id === 'new';
  // On /new the primary action is "Create": enabled once a name + workspace
  // are set. On an existing item it's "Save", enabled when there are edits.
  const canSave = status.kind !== 'saving' && (isNew
    ? (!!state.displayName.trim() && !!workspaceId)
    : dirty);
  // F6 — client-side preflight for the Publish button. The server is the
  // authoritative gate (assets / policy / domain); this only blocks obvious
  // non-starters with an honest tooltip.
  const isPublished = state.lifecycleStatus === 'PUBLISHED';
  const canPublish = !isNew && !lifecycleBusy && status.kind !== 'saving' && !isPublished && !!state.displayName.trim();
  const publishBlockReason = isNew
    ? 'Create the data product first'
    : isPublished ? 'Already published'
    : !state.displayName.trim() ? 'Display name is required'
    : undefined;
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Product', actions: [
        { label: status.kind === 'saving' ? (isNew ? 'Creating…' : 'Saving…') : (isNew ? 'Create' : 'Save'),
          onClick: canSave ? save : undefined, disabled: !canSave,
          title: isNew ? (!state.displayName.trim() ? 'Enter a name' : !workspaceId ? 'Select a workspace' : undefined) : (!dirty ? 'No unsaved changes' : undefined) },
        { label: 'Publish to APIM', onClick: !isNew && status.kind !== 'saving' && state.displayName ? publishApimMirror : undefined, disabled: isNew || status.kind === 'saving' || !state.displayName, title: isNew ? 'Create the data product first' : !state.displayName ? 'displayName is required' : undefined },
        { label: 'Edit (Basic / Business / Custom)', onClick: !isNew ? () => setEditOpen(true) : undefined, disabled: isNew, title: isNew ? 'Create the data product first' : 'Open the 3-step edit dialog (per-step Save + Endorse)' },
        { label: 'Publish as API', onClick: !isNew && status.kind !== 'saving' ? () => {
            setPublishApiServiceUrl(state.apimServiceUrl || '');
            setPublishApiResult(null);
            setPublishApiGate(null);
            setPublishApiErr(null);
            setPublishApiKeyVisible(false);
            setPublishApiOpen(true);
          } : undefined,
          disabled: isNew || status.kind === 'saving',
          title: isNew ? 'Create the data product first' : 'Expose this data product as a consumable APIM API with a subscription key' },
        { label: 'Delete', onClick: !isNew ? () => setDeleteOpen(true) : undefined, disabled: isNew, title: isNew ? 'Create the data product first' : 'Delete this data product (requires Draft/Expired, no assets, terms, or open requests)' },
      ]},
      { label: 'Lifecycle', actions: [
        { label: lifecycleBusy ? 'Publishing…' : 'Publish',
          onClick: canPublish ? () => handleSetStatus('PUBLISHED') : undefined,
          disabled: !canPublish, title: publishBlockReason },
        { label: 'Unpublish',
          disabled: isNew || lifecycleBusy || !isPublished,
          title: isNew ? 'Create the data product first' : !isPublished ? 'Publish the data product first' : undefined,
          dropdownItems: [
            { label: 'Set to draft', onClick: () => handleSetStatus('DRAFT') },
            { label: 'Set to expired', onClick: () => handleSetStatus('EXPIRED') },
          ] },
      ]},
      { label: 'Govern', actions: [
        { label: 'Datasets', onClick: () => setTab('datasets') },
        { label: 'Data assets', onClick: () => setTab('data-assets') },
        { label: 'Glossary', onClick: () => setTab('glossary') },
        { label: 'Linked resources', onClick: () => setTab('linked-resources') },
        { label: 'Lineage', onClick: () => setTab('lineage') },
        { label: 'Access policies', onClick: () => setTab('policies') },
        { label: 'Manage policies', onClick: !isNew ? () => setPoliciesOpen(true) : undefined, disabled: isNew, title: isNew ? 'Create the data product first' : undefined },
        { label: 'Observability', onClick: () => setTab('observability') },
      ]},
      { label: 'Bulk', actions: [
        { label: 'Import from CSV', onClick: () => setImportOpen(true) },
      ]},
    ]},
  ], [status.kind, isNew, canSave, dirty, save, state.displayName, state.apimServiceUrl, workspaceId, publishApimMirror, canPublish, isPublished, lifecycleBusy, publishBlockReason, handleSetStatus]);
  useRegisterRibbonCommands(ribbon, item.slug);

  return (
    <>
    <ItemEditorChrome splitKeyPrefix={item.slug} item={item} id={id} ribbon={ribbon} commandSearch rightPanelLabel="Properties" rightPanel={isNew ? undefined : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
        <SelectAttributePanel
          title="Update frequency"
          value={state.updateFrequency ?? ''}
          options={UPDATE_FREQUENCIES}
          placeholder="Not set"
          onSave={async (v) => {
            const receipt = await patchAttr({ updateFrequency: v || null });
            setState((prev) => ({ ...prev, updateFrequency: v || undefined }));
            return receipt;
          }}
        />
        <LinkListAttributePanel
          title="Terms of use"
          entries={state.termsOfUse ?? []}
          onAdd={async (entry) => {
            const next = [...(state.termsOfUse ?? []), entry];
            const receipt = await patchAttr({ termsOfUse: next });
            setState((prev) => ({ ...prev, termsOfUse: next }));
            return receipt;
          }}
          onRemove={async (idx) => {
            const next = (state.termsOfUse ?? []).filter((_, i) => i !== idx);
            const receipt = await patchAttr({ termsOfUse: next });
            setState((prev) => ({ ...prev, termsOfUse: next }));
            return receipt;
          }}
        />
        <LinkListAttributePanel
          title="Documentation"
          entries={state.documentation ?? []}
          onAdd={async (entry) => {
            const next = [...(state.documentation ?? []), entry];
            const receipt = await patchAttr({ documentation: next });
            setState((prev) => ({ ...prev, documentation: next }));
            return receipt;
          }}
          onRemove={async (idx) => {
            const next = (state.documentation ?? []).filter((_, i) => i !== idx);
            const receipt = await patchAttr({ documentation: next });
            setState((prev) => ({ ...prev, documentation: next }));
            return receipt;
          }}
        />
      </div>
    )} main={
      <div className={s.pad}>
        {state.purviewDataProductId ? (
          <MessageBar intent="success" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>Registered with Purview Unified Catalog</MessageBarTitle>
              Data product <code>{state.purviewDataProductId}</code> is live in the catalog.{' '}
              {state.lastRegisteredAt && <>Last registered <code>{state.lastRegisteredAt}</code>.{' '}</>}
              Re-click <strong>Register with Purview</strong> after edits to push updates. APIM publish remains a separate, API-access-layer concern.
            </MessageBarBody>
          </MessageBar>
        ) : (
          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>Not yet registered with Purview Unified Catalog</MessageBarTitle>
              The item persists configuration to Cosmos, but it has not been published to the canonical Purview Data Product catalog. Click <strong>Register with Purview</strong> below to create the Unified Catalog data product via <code>POST /datagovernance/catalog/dataProducts</code>. Requires a Purview account (<code>LOOM_PURVIEW_ACCOUNT</code>), a <code>businessDomainId</code> GUID in <code>state.domain</code>, and the Loom UAMI to hold the <code>Data Curator</code> + <code>Data Product Owner</code> roles. See <code>docs/fiab/data-product-parity-spec.md</code>.
            </MessageBarBody>
          </MessageBar>
        )}

        {purviewHint && (
          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>Purview is not provisioned in this deployment</MessageBarTitle>
              Missing env var: <code>{purviewHint.missingEnvVar}</code>.{' '}
              Bicep module: <code>{purviewHint.bicepModule}</code> — {purviewHint.bicepStatus}{' '}
              Required Purview roles (granted via the Purview portal, NOT ARM RBAC):
              <ul style={{ marginTop: tokens.spacingVerticalXS, marginBottom: tokens.spacingVerticalXS, marginLeft: tokens.spacingHorizontalL, marginRight: tokens.spacingHorizontalNone }}>
                {purviewHint.rolesRequired.map((r) => (
                  <li key={r.name}><strong>{r.name}</strong> at {r.scope} — {r.reason}</li>
                ))}
              </ul>
              {purviewHint.followUp}
            </MessageBarBody>
          </MessageBar>
        )}

        {loadErr && <MessageBar intent="error"><MessageBarBody>{loadErr}</MessageBarBody></MessageBar>}
        {loading && <Spinner size="tiny" label="Loading…" />}

        <div className={s.toolbar}>
          {(() => {
            const ls = state.lifecycleStatus;
            if (ls === 'PUBLISHED') return <Badge appearance="filled" color="success">Published</Badge>;
            if (ls === 'EXPIRED') return <Badge appearance="filled" color="danger">Expired</Badge>;
            return <Badge appearance="outline" color="warning">Draft</Badge>;
          })()}
          {state.domain && <Badge appearance="filled" color="brand">Domain: {state.domain}</Badge>}
          {state.owner && <Badge appearance="outline">Owner: {state.owner}</Badge>}
          {/* DP-5 — the two-rung endorsement ladder (reconciles the legacy
              certified/endorsed booleans): Certified (reviewer-gated) outranks
              Promoted (lightweight). Manage it on the Certification tab. */}
          {state.certificationState === 'certified'
            ? <Badge appearance="filled" color="success" icon={<ShieldCheckmark20Regular />}>Certified</Badge>
            : (state.endorsed || state.certified) && <Badge appearance="tint" color="brand">Promoted</Badge>}
          {state.purviewDataProductId && <Badge appearance="outline" color="success">Purview: {state.purviewDataProductId.slice(0, 8)}…</Badge>}
          {state.apimApiId && <Badge appearance="outline" color="success" icon={<Key20Regular />}>APIM API: {state.apimApiId}</Badge>}
          {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
          {!isNew && <DqScoreGauge obs={observability.data} loading={observability.loading} />}
          <Button appearance={isNew ? 'primary' : 'secondary'} icon={<Save20Regular />} onClick={save} disabled={!canSave}>
            {status.kind === 'saving' ? (isNew ? 'Creating…' : 'Saving…') : isNew ? 'Create' : 'Save'}
          </Button>
          <Button
            appearance="secondary"
            icon={<Edit20Regular />}
            onClick={() => setEditOpen(true)}
            disabled={isNew}
            title={isNew ? 'Create the data product first' : 'Edit Basic / Business / Custom attributes (per-step Save + Endorse)'}
          >
            Edit
          </Button>
          <Button
            appearance={state.purviewDataProductId ? 'secondary' : 'primary'}
            icon={<Library20Regular />}
            onClick={registerPurview}
            disabled={isNew || status.kind === 'saving' || !state.displayName}
            title={isNew ? 'Create the data product first' : undefined}
            style={{ marginLeft: 'auto' }}
          >
            {status.kind === 'saving'
              ? 'Registering…'
              : state.purviewDataProductId ? 'Re-register with Purview' : 'Register with Purview'}
          </Button>
          <Button appearance="secondary" icon={<CloudArrowUp20Regular />} onClick={publishApimMirror} disabled={isNew || status.kind === 'saving' || !state.displayName} title={isNew ? 'Create the data product first' : undefined}>
            {status.kind === 'saving' ? 'Publishing…' : 'Publish to APIM'}
          </Button>
          <Button
            appearance="primary"
            icon={<Key20Regular />}
            onClick={() => {
              setPublishApiServiceUrl(state.apimServiceUrl || '');
              setPublishApiResult(null);
              setPublishApiGate(null);
              setPublishApiErr(null);
              setPublishApiKeyVisible(false);
              setPublishApiOpen(true);
            }}
            disabled={isNew || status.kind === 'saving'}
            title={isNew ? 'Create the data product first' : 'Expose this data product as a consumable APIM API with a subscription key'}
          >
            {state.apimApiId ? 'Re-publish as API' : 'Publish as API'}
          </Button>
        </div>
        <StatusBar status={status} />

        {lifecycleMsg && (
          <MessageBar intent={lifecycleMsg.intent}>
            <MessageBarBody>
              <MessageBarTitle>{lifecycleMsg.intent === 'error' ? 'Lifecycle error' : 'Status updated'}</MessageBarTitle>
              {lifecycleMsg.text}
            </MessageBarBody>
          </MessageBar>
        )}
        {state.lifecycleStatus === 'EXPIRED' && (
          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>This data product is expired</MessageBarTitle>
              It is visible only to stewards and owners. Consumers cannot discover it in the catalog or request access. Use <strong>Publish</strong> to make it discoverable again.
            </MessageBarBody>
          </MessageBar>
        )}
        <PublishAsApiDialog
          open={publishApiOpen}
          onOpenChange={setPublishApiOpen}
          serviceUrl={publishApiServiceUrl}
          onServiceUrlChange={setPublishApiServiceUrl}
          busy={publishApiBusy}
          result={publishApiResult}
          gate={publishApiGate}
          err={publishApiErr}
          keyVisible={publishApiKeyVisible}
          onToggleKey={() => setPublishApiKeyVisible((v) => !v)}
          onPublish={publishAsApi}
          republish={!!state.apimApiId}
        />

        {/* F4 — 3-step edit dialog (per-step PATCH) + F7 Endorse. Renders only
            for a persisted product; onSaved mirrors the saved endorsed flag to
            the header badge. Operates on the SAME Cosmos `items` data-product
            record the marketplace lists, via /api/data-products/[id] with
            optimistic-concurrency If-Match (Azure-native, no Fabric dependency). */}
        {!isNew && (
          <DataProductEditDialog
            id={id}
            open={editOpen}
            onOpenChange={setEditOpen}
            onSaved={(doc) => patchState({ endorsed: doc.endorsed })}
          />
        )}



        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
          <Tab value="overview" icon={<Document20Regular />}>Overview</Tab>
          <Tab value="contract" icon={<DocumentBulletList20Regular />}>Contract</Tab>
          <Tab value="datasets" icon={<Code20Regular />}>Datasets</Tab>
          <Tab value="data-assets" icon={<Database20Regular />}>Data assets</Tab>
          <Tab value="glossary" icon={<Library20Regular />}>Glossary</Tab>
          <Tab value="linked-resources" icon={<Link20Regular />}>Linked resources</Tab>
          <Tab value="lineage" icon={<BranchFork20Regular />}>Lineage</Tab>
          <Tab value="policies" icon={<Library20Regular />}>Access policies</Tab>
          <Tab value="observability" icon={<Pulse20Regular />}>Observability</Tab>
          <Tab value="certification" icon={<ShieldCheckmark20Regular />}>Certification</Tab>
          <Tab value="ports" icon={<ArrowImport20Regular />}>Ports</Tab>
          <Tab value="versions" icon={<History20Regular />}>Versions</Tab>
        </TabList>

        {tab === 'overview' && (
          <>
            <div className={s.form}>
              {isNew && (
                <Field label="Workspace (required to create)" style={{ gridColumn: '1 / -1' }}>
                  <Dropdown
                    placeholder={ws.loading ? 'Loading workspaces…' : (ws.workspaces?.length ?? 0) === 0 ? 'No workspaces — create one first' : 'Select a workspace'}
                    value={(ws.workspaces || []).find((w) => w.id === workspaceId)?.name || ''}
                    selectedOptions={workspaceId ? [workspaceId] : []}
                    disabled={ws.loading || (ws.workspaces?.length ?? 0) === 0}
                    onOptionSelect={(_, d) => setWorkspaceId(d.optionValue || '')}
                  >
                    {(ws.workspaces || []).map((w) => <Option key={w.id} value={w.id}>{w.name}</Option>)}
                  </Dropdown>
                </Field>
              )}
              <Field label="Display name"><Input value={state.displayName} onChange={(_, d) => patchState({ displayName: d.value })} /></Field>
              <Field
                label="Governance domain"
                hint={domains.notConfigured ? 'Purview not provisioned — set LOOM_PURVIEW_ACCOUNT to populate domains. You can still type a businessDomainId GUID below.' : 'Resolves to the Purview businessDomainId GUID required for registration.'}
              >
                {(domains.domains?.length ?? 0) > 0 ? (
                  <Dropdown
                    placeholder="Select a governance domain"
                    value={(domains.domains || []).find((dm) => dm.id === state.domain)?.name || state.domain}
                    selectedOptions={state.domain ? [state.domain] : []}
                    onOptionSelect={(_, d) => patchState({ domain: d.optionValue || '' })}
                  >
                    {(domains.domains || []).map((dm) => <Option key={dm.id} value={dm.id}>{dm.name}</Option>)}
                  </Dropdown>
                ) : (
                  <Input value={state.domain} onChange={(_, d) => patchState({ domain: d.value })} placeholder="0a1b2c3d-4e5f-6789-abcd-ef0123456789" />
                )}
              </Field>
              <div style={{ gridColumn: '1 / -1' }}>
                <OwnerPeoplePicker
                  owners={state.owners || []}
                  onChange={(next) => patchState({
                    owners: next,
                    // Mirror owners[0] into the singular `owner` for back-compat
                    // + the marketplace / AI-Search owner facet (DP-17).
                    owner: next.length ? (next[0].upn || next[0].displayName || '') : '',
                  })}
                  label="Owners"
                  hint="Search your directory (Microsoft Graph) and add owners."
                />
              </div>
              <Field label="SLA"><Input value={state.sla} onChange={(_, d) => patchState({ sla: d.value })} placeholder="99.9% · P95 < 200 ms" /></Field>
              <Field label="Description" style={{ gridColumn: '1 / -1' }}>
                <Textarea value={state.description} onChange={(_, d) => patchState({ description: d.value })} rows={3} />
              </Field>
              <Field label="Certified" style={{ gridColumn: '1 / -1' }}>
                <Switch checked={state.certified} onChange={(_, d) => patchState({ certified: d.checked })} label={state.certified ? 'Certified by data governance' : 'Not certified'} />
              </Field>
              <Field
                label="Lifecycle status"
                hint="Draft (not yet published) · Published (visible in the catalog) · Expired (deprecated, visible only to stewards). Deletion requires Draft or Expired."
              >
                <Dropdown
                  value={state.lifecycleStatus || 'Draft'}
                  selectedOptions={[state.lifecycleStatus || 'Draft']}
                  onOptionSelect={(_, d) => d.optionValue && patchState({ lifecycleStatus: d.optionValue as DataProductState['lifecycleStatus'] })}
                >
                  <Option value="Draft">Draft</Option>
                  <Option value="Published">Published</Option>
                  <Option value="Expired">Expired</Option>
                </Dropdown>
              </Field>
            </div>
            <Subtitle2 style={{ marginTop: tokens.spacingVerticalM }}>
              <Library20Regular style={{ verticalAlign: 'text-bottom', marginRight: tokens.spacingHorizontalXS }} />
              Bundle composition
            </Subtitle2>
            <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
              Auto-composed from what this product wraps — add components in the <strong>Data assets</strong>, <strong>Datasets</strong>, <strong>Glossary</strong>, and <strong>Access policies</strong> tabs. These descriptors ship to the Purview Unified Catalog on registration.
            </Caption1>
            {state.bundle.length > 0 ? (
              <div className={s.cardGrid}>
                {state.bundle.map((b, i) => <div key={i} className={s.card}>{b}</div>)}
              </div>
            ) : (
              <EmptyState
                icon={<Library20Regular />}
                title="Nothing bundled yet"
                body="This data product doesn't wrap any components yet. Attach curated Data Map assets, register datasets, link glossary terms, or set an access policy — the bundle composition builds itself from what you add."
                primaryAction={{ label: 'Add data assets', onClick: () => setTab('data-assets') }}
              />
            )}
          </>
        )}

        {tab === 'contract' && (
          <DataContractStudioTab id={id} />
        )}

        {tab === 'datasets' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
            <Body1>Register data assets (Atlas entities) into Purview and map them to this data product. Classifications attach inline.</Body1>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacingVerticalM }}>
              <Field label="Asset name"><Input value={dsName} onChange={(_, d) => setDsName(d.value)} placeholder="silver_revenue" /></Field>
              <Field label="Type">
                <Dropdown value={dsType} selectedOptions={[dsType]} onOptionSelect={(_, d) => d.optionValue && setDsType(d.optionValue)}>
                  <Option value="azure_datalake_gen2_path">Lakehouse — ADLS Gen2 (Delta) path</Option>
                  <Option value="azure_sql_table">Azure SQL table</Option>
                  <Option value="databricks_table">Databricks (Unity Catalog) table</Option>
                  <Option value="DataSet">Generic dataset</Option>
                  <Option value="fabric_lakehouse">OneLake / Fabric lakehouse (opt-in)</Option>
                </Dropdown>
              </Field>
              <Field label="Qualified name (unique asset id)" style={{ gridColumn: '1 / -1' }}>
                <Input
                  value={dsQName}
                  onChange={(_, d) => setDsQName(d.value)}
                  placeholder={
                    dsType === 'fabric_lakehouse' ? 'https://onelake.dfs.fabric.microsoft.com/<ws>/<lh>.Lakehouse/Tables/silver_revenue'
                    : dsType === 'databricks_table' ? '<catalog>.<schema>.silver_revenue'
                    : dsType === 'azure_sql_table' ? 'mssql://<server>.database.windows.net/<db>/dbo/silver_revenue'
                    : 'abfss://gold@<account>.dfs.core.windows.net/silver_revenue'
                  }
                />
              </Field>
              <Field label="Classifications" hint="Pick from the tenant label taxonomy (manage in Governance → Classifications)." style={{ gridColumn: '1 / -1' }}>
                {classTypes.length > 0 ? (
                  <Dropdown multiselect placeholder="Select labels…"
                    value={dsClassSelected.join(', ')} selectedOptions={dsClassSelected}
                    onOptionSelect={(_, d) => setDsClass(d.selectedOptions || [])}>
                    {classTypes.map((c) => <Option key={c} value={c}>{c}</Option>)}
                  </Dropdown>
                ) : (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      No classification taxonomy is defined yet. Add labels in{' '}
                      <a href="/governance/classifications" target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>
                        Governance → Classifications
                      </a>{' '}— classifications are picked from the taxonomy, never free-typed.
                    </MessageBarBody>
                  </MessageBar>
                )}
              </Field>
            </div>
            <Button appearance="primary" icon={<Add20Regular />} onClick={registerDataset} disabled={dsBusy} style={{ alignSelf: 'flex-start' }}>
              {dsBusy ? 'Registering…' : 'Register dataset'}
            </Button>
            {dsMsg && <MessageBar intent={dsMsg.intent}><MessageBarBody>{dsMsg.text}</MessageBarBody></MessageBar>}
            <Table size="small" aria-label="Datasets">
              <TableHeader><TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Classifications</TableHeaderCell>
                <TableHeaderCell>GUID</TableHeaderCell>
                <TableHeaderCell />
              </TableRow></TableHeader>
              <TableBody>
                {(state.datasets || []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5}>
                      <EmptyState
                        icon={<Code20Regular />}
                        title="No datasets mapped yet"
                        body="Register data assets (Atlas entities) into Purview and map them to this data product using the form above. Classifications attach inline from the tenant label taxonomy."
                      />
                    </TableCell>
                  </TableRow>
                )}
                {(state.datasets || []).map((d) => (
                  <TableRow key={d.qualifiedName}>
                    <TableCell><strong>{d.name}</strong></TableCell>
                    <TableCell><code>{d.typeName}</code></TableCell>
                    <TableCell>{d.classifications.map((c) => <Badge key={c} appearance="outline" style={{ marginRight: tokens.spacingHorizontalXXS }}>{c}</Badge>)}</TableCell>
                    <TableCell><code style={{ fontSize: tokens.fontSizeBase100 }}>{d.guid?.slice(0, 12) || '—'}</code></TableCell>
                    <TableCell><Button size="small" icon={<Delete20Regular />} onClick={() => removeDataset(d.qualifiedName)}>Remove</Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {tab === 'linked-resources' && (
          <LinkedResourcesPanel
            dataProductId={id}
            glossaryLinks={state.glossaryLinks || []}
            onGlossaryLinksChange={(links) => patchState({ glossaryLinks: links })}
            datasetsKey={(state.datasets || []).length}
          />
        )}

        {tab === 'data-assets' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
              <Body1 style={{ flex: 1 }}>
                Physical assets this data product wraps, curated from the Microsoft Purview Data Map and scoped to the product&apos;s governance domain. The publish guard requires at least one attached asset.
              </Body1>
              <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={loadAssets} disabled={assetsLoading || id === 'new'}>
                {assetsLoading ? 'Loading…' : 'Refresh'}
              </Button>
              <Button appearance="primary" icon={<Add20Regular />} onClick={() => setAssetPanelOpen(true)} disabled={id === 'new'} title={id === 'new' ? 'Create the data product first' : undefined}>
                Add assets
              </Button>
            </div>
            {id === 'new' && (
              <MessageBar intent="info"><MessageBarBody>Create (Save) the data product before adding data assets.</MessageBarBody></MessageBar>
            )}
            {assetsErr && <MessageBar intent="error"><MessageBarBody>{assetsErr}</MessageBarBody></MessageBar>}
            {assetMsg && <MessageBar intent={assetMsg.intent}><MessageBarBody>{assetMsg.text}</MessageBarBody></MessageBar>}
            <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
              <Badge appearance="filled" color="brand">{assets.length} attached</Badge>
              {assets.some((a) => a.deleted) && (
                <Badge appearance="outline" color="warning">{assets.filter((a) => a.deleted).length} deleted in Data Map</Badge>
              )}
            </div>
            <Table size="small" aria-label="Attached data assets">
              <TableHeader><TableRow>
                <TableHeaderCell style={{ width: 28 }} />
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Qualified name</TableHeaderCell>
                <TableHeaderCell>Added</TableHeaderCell>
                <TableHeaderCell style={{ width: 44 }} />
              </TableRow></TableHeader>
              <TableBody>
                {assets.length === 0 && !assetsLoading && (
                  <TableRow>
                    <TableCell colSpan={6}>
                      <EmptyState
                        icon={<Database20Regular />}
                        title="No data assets attached yet"
                        body="Curate the physical assets this product wraps from the Microsoft Purview Data Map. The publish guard requires at least one attached asset."
                        primaryAction={id === 'new' ? undefined : { label: 'Add assets', onClick: () => setAssetPanelOpen(true) }}
                      />
                    </TableCell>
                  </TableRow>
                )}
                {assets.map((a) => (
                  <TableRow key={a.guid}>
                    <TableCell>
                      {a.deleted && (
                        <Tooltip relationship="label" content="This asset has been deleted from the Data Map. It can still be removed.">
                          <Warning20Filled style={{ color: tokens.colorPaletteYellowForeground1 }} />
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell>
                      <strong>{a.name}</strong>
                      {a.dqRunning && <Badge appearance="outline" color="important" style={{ marginLeft: tokens.spacingHorizontalXS }}>DQ rule running</Badge>}
                    </TableCell>
                    <TableCell><code style={{ fontSize: tokens.fontSizeBase100 }}>{a.entityType || '—'}</code></TableCell>
                    <TableCell><code style={{ fontSize: tokens.fontSizeBase100, wordBreak: 'break-all' }}>{a.qualifiedName || '—'}</code></TableCell>
                    <TableCell><Caption1>{a.addedAt ? new Date(a.addedAt).toLocaleDateString() : '—'}</Caption1></TableCell>
                    <TableCell>
                      <Menu>
                        <MenuTrigger disableButtonEnhancement>
                          <Button size="small" appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label={`Actions for ${a.name}`} />
                        </MenuTrigger>
                        <MenuPopover>
                          <MenuList>
                            {a.dqRunning && !a.deleted ? (
                              <Tooltip relationship="label" content={`Blocked: data-quality rule "${a.dqRuleName || ''}" is running against this asset. Disable it first.`}>
                                <MenuItem disabled icon={<Delete20Regular />}>Remove (blocked — DQ rule running)</MenuItem>
                              </Tooltip>
                            ) : (
                              <MenuItem
                                icon={<Delete20Regular />}
                                disabled={removingGuid === a.guid}
                                onClick={() => removeAsset(a.guid)}
                              >
                                {removingGuid === a.guid ? 'Removing…' : 'Remove'}
                              </MenuItem>
                            )}
                          </MenuList>
                        </MenuPopover>
                      </Menu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <AddDataAssetsPanel
              productId={id}
              open={assetPanelOpen}
              onClose={() => setAssetPanelOpen(false)}
              onAdded={onAssetsAdded}
              existingGuids={new Set(assets.map((a) => a.guid))}
            />
          </div>
        )}

        {tab === 'glossary' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
            <Body1>Create glossary terms and link them to this data product. {state.purviewDataProductId ? 'Terms are applied to the registered Purview data product.' : 'Register the data product with Purview to auto-apply created terms.'}</Body1>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: tokens.spacingVerticalM, alignItems: 'flex-end' }}>
              <Field label="Term name"><Input value={glName} onChange={(_, d) => setGlName(d.value)} placeholder="Net Revenue" /></Field>
              <Field label="Definition"><Input value={glDesc} onChange={(_, d) => setGlDesc(d.value)} placeholder="Revenue after returns and discounts" /></Field>
            </div>
            <Button appearance="primary" icon={<Add20Regular />} onClick={createGlossaryLink} disabled={glBusy} style={{ alignSelf: 'flex-start' }}>
              {glBusy ? 'Creating…' : 'Create + link term'}
            </Button>
            {glMsg && <MessageBar intent={glMsg.intent}><MessageBarBody>{glMsg.text}</MessageBarBody></MessageBar>}
            <Table size="small" aria-label="Glossary terms">
              <TableHeader><TableRow><TableHeaderCell>Term</TableHeaderCell><TableHeaderCell>GUID</TableHeaderCell><TableHeaderCell /></TableRow></TableHeader>
              <TableBody>
                {(state.glossaryLinks || []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3}>
                      <EmptyState
                        icon={<Library20Regular />}
                        title="No glossary terms linked yet"
                        body="Create a business glossary term and link it to this data product using the form above. Linked terms carry the product's semantics into the Purview Unified Catalog."
                      />
                    </TableCell>
                  </TableRow>
                )}
                {(state.glossaryLinks || []).map((g) => (
                  <TableRow key={g.name}>
                    <TableCell><strong>{g.name}</strong></TableCell>
                    <TableCell><code style={{ fontSize: tokens.fontSizeBase100 }}>{g.guid?.slice(0, 12) || '—'}</code></TableCell>
                    <TableCell><Button size="small" icon={<Delete20Regular />} onClick={() => removeGlossaryLink(g.name)}>Unlink</Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {tab === 'lineage' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
            <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
              <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={loadLineage} disabled={lineageBusy}>{lineageBusy ? 'Loading…' : 'Refresh lineage'}</Button>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Centered on the first registered dataset (or the Purview data product) GUID.</Caption1>
            </div>
            {lineageErr && <MessageBar intent="warning"><MessageBarBody>{lineageErr}</MessageBarBody></MessageBar>}
            {lineage && (
              <>
                <Subtitle2><Database20Regular style={{ verticalAlign: 'text-bottom', marginRight: tokens.spacingHorizontalXS }} />Nodes ({lineage.nodes.length})</Subtitle2>
                <Table size="small" aria-label="Lineage nodes">
                  <TableHeader><TableRow><TableHeaderCell>Asset</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>Source</TableHeaderCell></TableRow></TableHeader>
                  <TableBody>
                    {lineage.nodes.map((n: any) => (
                      <TableRow key={n.id}>
                        <TableCell style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>{n.label || n.id}</TableCell>
                        <TableCell><code style={{ wordBreak: 'break-all', overflowWrap: 'anywhere' }}>{n.type || '—'}</code></TableCell>
                        <TableCell>{n.source || 'purview'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Subtitle2><BranchFork20Regular style={{ verticalAlign: 'text-bottom', marginRight: tokens.spacingHorizontalXS }} />Edges ({lineage.edges.length})</Subtitle2>
                <div className={s.specViewer} style={{ maxHeight: 200, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {lineage.edges.map((e: any, i: number) => `${e.from} → ${e.to}${e.label ? ` (${e.label})` : ''}`).join('\n') || '(no edges)'}
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'policies' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
            <Body1>Access policies for this data product — permitted purposes and the approval sequence (manager → privacy review → approvers → access provider). Mirrors Purview "Manage policies". Saved policy persists to this item in Cosmos.</Body1>
            {state.apimPublished && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Product is Published</MessageBarTitle>
                  Access policies can only be edited while the data product is unpublished. The dialog opens read-only until you unpublish.
                </MessageBarBody>
              </MessageBar>
            )}
            <Button appearance="primary" icon={<Add20Regular />} onClick={() => setPoliciesOpen(true)} disabled={isNew} title={isNew ? 'Create the data product first' : undefined} style={{ alignSelf: 'flex-start' }}>
              Manage policies
            </Button>
            <Subtitle2><Library20Regular style={{ verticalAlign: 'text-bottom', marginRight: tokens.spacingHorizontalXS }} />Permitted purposes</Subtitle2>
            <Table size="small" aria-label="Permitted purposes">
              <TableHeader><TableRow><TableHeaderCell>Purpose</TableHeaderCell><TableHeaderCell>Description</TableHeaderCell></TableRow></TableHeader>
              <TableBody>
                {(!state.accessPolicy?.allowedPurposes?.length) && (
                  <TableRow>
                    <TableCell colSpan={2}>
                      <EmptyState
                        icon={<Key20Regular />}
                        title="No purposes defined yet"
                        body="Access to this data product is governed by permitted purposes. Click Manage policies to define who can request access and for what purpose — enforced by the Purview access-policy engine."
                        primaryAction={isNew ? undefined : { label: 'Manage policies', onClick: () => setPoliciesOpen(true) }}
                      />
                    </TableCell>
                  </TableRow>
                )}
                {(state.accessPolicy?.allowedPurposes || []).map((p) => (
                  <TableRow key={p.name}><TableCell><strong>{p.name}</strong></TableCell><TableCell>{p.description || '—'}</TableCell></TableRow>
                ))}
              </TableBody>
            </Table>
            <Subtitle2><BranchFork20Regular style={{ verticalAlign: 'text-bottom', marginRight: tokens.spacingHorizontalXS }} />Approval sequence</Subtitle2>
            {state.accessPolicy && policyTiers(state.accessPolicy).length > 0 ? (
              <Table size="small" aria-label="Approval sequence">
                <TableHeader><TableRow><TableHeaderCell>Tier</TableHeaderCell><TableHeaderCell>Approver / detail</TableHeaderCell></TableRow></TableHeader>
                <TableBody>
                  {policyTiers(state.accessPolicy).map((t, i) => (
                    <TableRow key={t.key}><TableCell>{i + 1}. {t.label}</TableCell><TableCell>{t.detail || '—'}</TableCell></TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Caption1>No approval tiers configured — access requests will be auto-approved.</Caption1>
            )}
          </div>
        )}

        {tab === 'observability' && (
          <ObservabilityTabContent
            id={id}
            obs={observability.data}
            loading={observability.loading}
            err={observability.err}
            refresh={observability.refresh}
          />
        )}

        {tab === 'certification' && <CertificationPanel id={id} isNew={isNew} />}

        {tab === 'ports' && <PortsPanel id={id} isNew={isNew} />}

        {tab === 'versions' && <VersionsPanel id={id} isNew={isNew} />}

        <DeleteDataProductDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          id={id}
          displayName={state.displayName || 'this data product'}
          onDeleted={(wsId) => router.push(wsId ? `/workspaces/${encodeURIComponent(wsId)}` : '/workspaces')}
        />
      </div>
    } />
    <ManagePoliciesDialog
      open={policiesOpen}
      productId={id}
      isPublished={!!state.apimPublished}
      onClose={() => setPoliciesOpen(false)}
      onSaved={(policy) => { setState((prev) => ({ ...prev, accessPolicy: policy })); setPoliciesOpen(false); }}
    />
    <ImportDataProductsFlyout
      open={importOpen}
      onOpenChange={setImportOpen}
      defaultWorkspaceId={workspaceId || undefined}
    />
    </>
  );
}
