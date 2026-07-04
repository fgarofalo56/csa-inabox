'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * OntologySdkEditor (OSDK) — typed SDK over an ontology (Data API Builder).
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

// ───────────────────────── Ontology SDK (OSDK) ─────────────────────────
interface OsdkState {
  boundOntologyId?: string; boundOntologyName?: string;
  objectCount?: number; linkCount?: number; actionCount?: number; lastGeneratedAt?: string;
  selectedObjectTypes?: string[]; selectedLinkTypes?: string[]; selectedActionTypes?: string[];
  /** DAB runtime origin (Azure Container Apps) the live "Try it" explorer proxies. */
  serviceUrl?: string;
  [k: string]: unknown;
}
interface GeneratedSdk { typescript: string; python: string; dabConfig: unknown; actions: string; objectCount: number; linkCount: number; actionCount: number; propertyCount: number }

/** Stable identity for a link in the scope selector (kind + endpoints). */
function osdkLinkKey(l: { from: string; to: string; kind: string }): string { return `${l.kind}:${l.from}->${l.to}`; }
function osdkLinkLabel(l: { from: string; to: string; kind: string }): string { return `${l.from} —${l.kind}→ ${l.to}`; }

// ── OSDK live "Try it" API Explorer — proxies the real DAB runtime (REST + GraphQL) ──
interface OsdkTryResult { columns: string[]; rows: unknown[][]; url?: string; rowCount?: number; raw?: unknown; error?: string; gate?: { reason: string; remediation: string } }

function OsdkTryIt({ id, objectTypes, serviceUrl, onServiceUrl }: {
  id: string; objectTypes: string[]; serviceUrl: string; onServiceUrl: (v: string) => void;
}) {
  const s = useStyles();
  const [mode, setMode] = useState<'rest' | 'graphql'>('rest');
  const [objectType, setObjectType] = useState('');
  const [first, setFirst] = useState('25');
  const [filter, setFilter] = useState('');
  const [gql, setGql] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<OsdkTryResult | null>(null);

  useEffect(() => { if (!objectType && objectTypes.length) setObjectType(objectTypes[0]); }, [objectTypes, objectType]);
  useEffect(() => {
    if (!gql && objectType) setGql(`{\n  ${objectType.charAt(0).toLowerCase()}${objectType.slice(1)}s {\n    items { __typename }\n  }\n}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectType]);

  const run = useCallback(async () => {
    setBusy(true); setRes(null);
    try {
      const body = mode === 'graphql'
        ? { mode, graphql: gql }
        : { mode, objectType, first: Number(first) || 25, filter: filter.trim() || undefined };
      const r = await clientFetch(`/api/items/ontology-sdk/${encodeURIComponent(id)}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setRes({ columns: [], rows: [], error: j?.error || `HTTP ${r.status}`, gate: j?.gate }); return; }
      setRes({ columns: j.columns || [], rows: j.rows || [], url: j.url, rowCount: j.rowCount, raw: j.raw });
    } catch (e: any) { setRes({ columns: [], rows: [], error: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [id, mode, objectType, first, filter, gql]);

  return (
    <div className={s.section}>
      <SectionHead icon={<Beaker20Regular />} title="Try it — live API Explorer" hint="Run real REST (OData) + GraphQL requests against the Data API Builder runtime that serves this ontology on Azure Container Apps. Results are live rows — no mock data." />
      <Field label="DAB runtime service URL" hint="This SDK's Data API origin (set at Publish, or point at the shared preview runtime). Blank falls back to LOOM_DAB_PREVIEW_URL.">
        <Input value={serviceUrl} onChange={(_, d) => onServiceUrl(d.value)} placeholder="https://dab-loom.<region>.azurecontainerapps.io" />
      </Field>
      <TabList selectedValue={mode} onTabSelect={(_, d) => { setMode(d.value as 'rest' | 'graphql'); setRes(null); }}>
        <Tab value="rest" icon={<Globe20Regular />}>REST</Tab>
        <Tab value="graphql" icon={<Braces20Regular />}>GraphQL</Tab>
      </TabList>

      {mode === 'rest' ? (
        <div className={s.addBar}>
          <Field label="Object type" className={s.fieldMed}>
            <Dropdown value={objectType} selectedOptions={objectType ? [objectType] : []} placeholder={objectTypes.length ? 'Select object type' : 'Bind an ontology first'}
              onOptionSelect={(_, d) => setObjectType(d.optionValue || '')}>
              {objectTypes.map((t) => <Option key={t} value={t}>{t}</Option>)}
            </Dropdown>
          </Field>
          <Field label="$first" className={s.fieldNarrow}><Input type="number" value={first} onChange={(_, d) => setFirst(d.value)} /></Field>
          <Field label="$filter (OData, optional)" className={s.fieldWide}><Input value={filter} onChange={(_, d) => setFilter(d.value)} placeholder="Status eq 'active'" /></Field>
          <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <Play20Regular />} disabled={busy || !objectType} onClick={run}>{busy ? 'Running…' : 'Run'}</Button>
        </div>
      ) : (
        <>
          <Field label="GraphQL query">
            <Textarea value={gql} onChange={(_, d) => setGql(d.value)} rows={6} resize="vertical" placeholder={'{\n  employees { items { id name } }\n}'} />
          </Field>
          <div className={s.addBar}>
            <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <Play20Regular />} disabled={busy || !gql.trim()} onClick={run}>{busy ? 'Running…' : 'Run'}</Button>
          </div>
        </>
      )}

      {res?.gate && <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Configure the Data API runtime</MessageBarTitle>{res.gate.reason} {res.gate.remediation}</MessageBarBody></MessageBar>}
      {res?.error && !res.gate && <MessageBar intent="error"><MessageBarBody>{res.error}</MessageBarBody></MessageBar>}
      {res && !res.error && (
        <>
          {res.url && <Caption1 className={s.hint}><strong>Request:</strong> <span className={s.outPill}>{mode.toUpperCase()} {res.url}</span></Caption1>}
          <Caption1 className={s.hint}>{res.rowCount ?? res.rows.length} row(s)</Caption1>
          {res.rows.length === 0 ? <div className={s.empty}><Caption1>The request succeeded but returned no rows.</Caption1></div> : (
            <div className={s.tableWrap}>
              <Table size="small" aria-label="Try it result">
                <TableHeader><TableRow>{res.columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
                <TableBody>
                  {res.rows.slice(0, 50).map((row, ri) => (
                    <TableRow key={ri}>{res.columns.map((_, ci) => <TableCell key={ci}>{row[ci] === null || row[ci] === undefined ? '' : String(row[ci])}</TableCell>)}</TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function OntologySdkEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<OsdkState>('ontology-sdk', id, {});
  const onto = useOntologyBinding('ontology-sdk', id);
  const [pickOnto, setPickOnto] = useState('');
  const [genBusy, setGenBusy] = useState(false);
  const [genErr, setGenErr] = useState<string | null>(null);
  const [gen, setGen] = useState<GeneratedSdk | null>(null);
  const [tab, setTab] = useState<'ts' | 'py' | 'actions' | 'dab'>('ts');
  const [pubBusy, setPubBusy] = useState(false);
  const [pubMsg, setPubMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);

  // Scope selector state.
  const [scopeTab, setScopeTab] = useState<'objects' | 'links' | 'actions'>('objects');
  const [filter, setFilter] = useState('');
  const [selObj, setSelObj] = useState<Set<string>>(new Set());
  const [selLink, setSelLink] = useState<Set<string>>(new Set());
  const [selAct, setSelAct] = useState<Set<string>>(new Set());
  const seededFor = useRef<string>('');

  const classes = onto.surface?.classes || [];
  const links = onto.surface?.links || [];
  const actionTypes = onto.surface?.actionTypes || [];
  const bindings = onto.surface?.bindings || [];
  const surfaceId = onto.surface?.id || '';

  // Real typed-property derivation (same pure fn the codegen route uses) so the
  // selector can show each object type's declared members.
  const propsByType = useMemo(
    () => deriveObjectProperties(classes, bindings, actionTypes.map((a) => ({ name: a.name, objectType: a.objectType, kind: a.kind, params: a.params }))),
    [classes, bindings, actionTypes],
  );

  // Seed the selection from persisted state (else "all") whenever the bound
  // surface changes. Guarded by surface id so binding a new ontology re-seeds.
  useEffect(() => {
    if (!onto.loaded || loading || !onto.surface) return;
    if (seededFor.current === surfaceId) return;
    const allObj = classes.map((c) => c.name);
    const allLink = links.map(osdkLinkKey);
    const allAct = actionTypes.map((a) => a.name);
    const so = Array.isArray(state.selectedObjectTypes) ? state.selectedObjectTypes.filter((n) => allObj.includes(n)) : allObj;
    const sl = Array.isArray(state.selectedLinkTypes) ? state.selectedLinkTypes.filter((n) => allLink.includes(n)) : allLink;
    const sa = Array.isArray(state.selectedActionTypes) ? state.selectedActionTypes.filter((n) => allAct.includes(n)) : allAct;
    setSelObj(new Set(so)); setSelLink(new Set(sl)); setSelAct(new Set(sa));
    seededFor.current = surfaceId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceId, onto.loaded, loading]);

  // Mirror a selection change into persisted item state (deferred out of the set
  // updater) so Save (Ctrl+S) persists the chosen scope to Cosmos.
  const persist = useCallback((patch: Partial<OsdkState>) => {
    queueMicrotask(() => setState((p) => ({ ...p, ...patch })));
  }, [setState]);
  const applyObj = useCallback((next: Set<string>) => { setSelObj(next); persist({ selectedObjectTypes: [...next] }); }, [persist]);
  const applyLink = useCallback((next: Set<string>) => { setSelLink(next); persist({ selectedLinkTypes: [...next] }); }, [persist]);
  const applyAct = useCallback((next: Set<string>) => { setSelAct(next); persist({ selectedActionTypes: [...next] }); }, [persist]);
  const toggle = (set: Set<string>, key: string) => { const n = new Set(set); n.has(key) ? n.delete(key) : n.add(key); return n; };

  const generate = useCallback(async () => {
    setGenBusy(true); setGenErr(null);
    try {
      const r = await clientFetch(`/api/items/ontology-sdk/${encodeURIComponent(id)}/generate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selectedObjectTypes: [...selObj], selectedLinkTypes: [...selLink], selectedActionTypes: [...selAct] }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setGenErr(j?.error || `HTTP ${r.status}`); return; }
      const next: GeneratedSdk = {
        typescript: j.typescript, python: j.python, dabConfig: j.dabConfig, actions: j.actions || '',
        objectCount: j.objectCount || 0, linkCount: j.linkCount || 0, actionCount: j.actionCount || 0, propertyCount: j.propertyCount || 0,
      };
      setGen(next);
      setTab((t) => (t === 'actions' && !next.actions) ? 'ts' : t);
    } catch (e: any) { setGenErr(e?.message || String(e)); }
    finally { setGenBusy(false); }
  }, [id, selObj, selLink, selAct]);

  const publish = useCallback(async () => {
    setPubBusy(true); setPubMsg(null);
    try {
      const r = await clientFetch(`/api/items/ontology-sdk/${encodeURIComponent(id)}/publish`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || ''}` : '';
        setPubMsg({ intent: j?.gate ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setPubMsg({ intent: 'success', text: `Published to APIM as "${j.api?.displayName}" at /${j.api?.path}.` });
    } catch (e: any) { setPubMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setPubBusy(false); }
  }, [id]);

  const canGenerate = !!onto.boundOntologyId && selObj.size > 0;

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'SDK', actions: [
        { label: saving ? 'Saving…' : 'Save scope', onClick: () => save(), disabled: saving || !dirty },
        { label: genBusy ? 'Generating…' : 'Generate SDK', onClick: generate, disabled: genBusy || !canGenerate },
        { label: pubBusy ? 'Publishing…' : 'Publish to APIM', onClick: publish, disabled: pubBusy || !onto.boundOntologyId },
      ]},
    ]},
  ], [save, saving, dirty, generate, genBusy, canGenerate, onto.boundOntologyId, publish, pubBusy]);

  if (id === 'new') return <NewItemCreateGate item={item} createLabel="Create Ontology SDK" intro="A typed TypeScript / Python client + REST Data API over an Ontology's object, link, and action types. Scope it to the types you need, generate typed write-back actions, and publish through APIM — via Microsoft Data API Builder on Azure Container Apps. No Fabric required." />;

  // Filtered rows for the active scope tab.
  const f = filter.trim().toLowerCase();
  const objRows = classes.filter((c) => !f || c.name.toLowerCase().includes(f) || (c.description || '').toLowerCase().includes(f));
  const linkRows = links.filter((l) => !f || osdkLinkLabel(l).toLowerCase().includes(f));
  const actRows = actionTypes.filter((a) => !f || a.name.toLowerCase().includes(f) || a.objectType.toLowerCase().includes(f));

  const selectAllCurrent = () => {
    if (scopeTab === 'objects') applyObj(new Set(classes.map((c) => c.name)));
    else if (scopeTab === 'links') applyLink(new Set(links.map(osdkLinkKey)));
    else applyAct(new Set(actionTypes.map((a) => a.name)));
  };
  const clearCurrent = () => {
    if (scopeTab === 'objects') applyObj(new Set());
    else if (scopeTab === 'links') applyLink(new Set());
    else applyAct(new Set());
  };

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info"><MessageBarBody>
          <MessageBarTitle>Ontology SDK (Palantir OSDK)</MessageBarTitle>
          Bind an Ontology, scope the SDK to the object / link / action types you need, then generate typed TypeScript + Python clients (with <strong>applyCreate / applyUpdate / applyDelete</strong> write-back methods) and a real dab-config.json. The Data API runs on Microsoft Data API Builder (Azure Container Apps) and publishes through APIM — no Fabric required.
        </MessageBarBody></MessageBar>

        <div className={s.section}>
          <SectionHead icon={<Link20Regular />} title="Bound ontology" hint="Its object / link / action types define the typed SDK surface." />
          {!onto.loaded ? <div className={s.empty}><Spinner size="tiny" /></div> : onto.ontologies.length === 0 ? (
            <MessageBar intent="warning"><MessageBarBody>No ontologies found. Create an Ontology item first, then bind it here.</MessageBarBody></MessageBar>
          ) : (
            <div className={s.addBar}>
              <Field label="Ontology" className={s.fieldWide}>
                <Dropdown value={onto.ontologies.find((o) => o.id === (pickOnto || onto.boundOntologyId))?.displayName || ''}
                  selectedOptions={[(pickOnto || onto.boundOntologyId)]} onOptionSelect={(_, d) => setPickOnto(d.optionValue || '')} placeholder="Select an ontology">
                  {onto.ontologies.map((o) => <Option key={o.id} value={o.id} text={o.displayName}>{`${o.displayName} (${o.classCount} objects)`}</Option>)}
                </Dropdown>
              </Field>
              <Button appearance="primary" icon={<Database20Regular />} disabled={onto.busy || !(pickOnto || onto.boundOntologyId)} onClick={() => onto.bind(pickOnto || onto.boundOntologyId)}>
                {onto.busy ? 'Binding…' : 'Bind ontology'}
              </Button>
              <Button appearance="outline" icon={<Code20Regular />} disabled={genBusy || !canGenerate} onClick={generate}>
                {genBusy ? 'Generating…' : 'Generate SDK'}
              </Button>
              <Button appearance="outline" icon={<Rocket20Regular />} disabled={pubBusy || !onto.boundOntologyId} onClick={publish}>
                {pubBusy ? 'Publishing…' : 'Publish to APIM'}
              </Button>
            </div>
          )}
          {onto.msg && <MessageBar intent={onto.msg.intent}><MessageBarBody>{onto.msg.text}</MessageBarBody></MessageBar>}
          {genErr && <MessageBar intent="error"><MessageBarBody>{genErr}</MessageBarBody></MessageBar>}
          {pubMsg && <MessageBar intent={pubMsg.intent}><MessageBarBody>{pubMsg.text}</MessageBarBody></MessageBar>}
        </div>

        {/* Ontology scope selector — choose which object / link / action types the
            SDK includes. Persisted to Cosmos; the /generate route filters by it. */}
        <div className={s.section}>
          <SectionHead icon={<Database20Regular />} title="SDK scope" hint="Choose which object, link, and action types the generated SDK includes. The token and generated client are scoped to exactly these entities." />
          {!onto.boundOntologyId ? (
            <div className={s.empty}><Caption1>Bind an ontology to choose the SDK scope.</Caption1></div>
          ) : classes.length === 0 ? (
            <MessageBar intent="warning"><MessageBarBody>The bound ontology has no object types yet. Add entities to it, then re-bind.</MessageBarBody></MessageBar>
          ) : (
            <>
              <TabList selectedValue={scopeTab} onTabSelect={(_, d) => { setScopeTab(d.value as 'objects' | 'links' | 'actions'); setFilter(''); }}>
                <Tab value="objects">Objects · {selObj.size}/{classes.length}</Tab>
                <Tab value="links">Links · {selLink.size}/{links.length}</Tab>
                <Tab value="actions">Actions · {selAct.size}/{actionTypes.length}</Tab>
              </TabList>
              <div className={s.scopeBar}>
                <SearchBox value={filter} onChange={(_, d) => setFilter(d.value)} placeholder={`Filter ${scopeTab}…`} className={s.fieldMed} />
                <span className={s.spacer} />
                <Button size="small" appearance="subtle" onClick={selectAllCurrent}>Select all</Button>
                <Button size="small" appearance="subtle" onClick={clearCurrent}>Clear</Button>
              </div>

              {scopeTab === 'objects' && (
                <div className={s.scopeScroll}>
                  {objRows.length === 0 ? <div className={s.empty}><Caption1>No matching object types.</Caption1></div> : objRows.map((c) => {
                    const props = propsByType[c.name];
                    const keyProp = props?.find((p) => p.isKey);
                    return (
                      <div key={c.name} className={s.row}>
                        <Checkbox checked={selObj.has(c.name)} onChange={() => applyObj(toggle(selObj, c.name))} aria-label={`Include ${c.name}`} />
                        <div className={s.rowText}>
                          <Body1><strong>{c.name}</strong>{c.parent ? <Caption1 as="span" className={s.hint}> : {c.parent}</Caption1> : null}</Body1>
                          {c.description && <Caption1 className={s.hint}>{c.description}</Caption1>}
                          <div className={s.chipBar}>
                            {keyProp && <Badge appearance="tint" color="brand">key: {keyProp.name}</Badge>}
                            {props ? props.filter((p) => !p.isKey).slice(0, 10).map((p) => <Badge key={p.name} appearance="outline">{p.name}: {p.tsType}</Badge>)
                              : <Caption1 className={s.mutedCaption}>untyped (no column bindings)</Caption1>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {scopeTab === 'links' && (
                <div className={s.scopeScroll}>
                  {links.length === 0 ? <div className={s.empty}><Caption1>This ontology declares no link types.</Caption1></div>
                    : linkRows.length === 0 ? <div className={s.empty}><Caption1>No matching link types.</Caption1></div>
                    : linkRows.map((l) => {
                      const k = osdkLinkKey(l); const endpointsIncluded = selObj.has(l.from) && selObj.has(l.to);
                      return (
                        <div key={k} className={s.row}>
                          <Checkbox checked={selLink.has(k)} onChange={() => applyLink(toggle(selLink, k))} aria-label={`Include ${osdkLinkLabel(l)}`} />
                          <Body1>{l.from} <Badge appearance="tint">{l.kind}</Badge> {l.to}</Body1>
                          <span className={s.spacer} />
                          {!endpointsIncluded && <Badge appearance="tint" color="warning">endpoint excluded</Badge>}
                        </div>
                      );
                    })}
                </div>
              )}

              {scopeTab === 'actions' && (
                <div className={s.scopeScroll}>
                  {actionTypes.length === 0 ? (
                    <MessageBar intent="info"><MessageBarBody>This ontology declares no write-back action types. Add create / update / delete actions on the Ontology to generate typed applyAction methods here.</MessageBarBody></MessageBar>
                  ) : actRows.length === 0 ? <div className={s.empty}><Caption1>No matching action types.</Caption1></div> : actRows.map((a) => {
                    const targetIncluded = selObj.has(a.objectType);
                    return (
                      <div key={a.name} className={s.row}>
                        <Checkbox checked={selAct.has(a.name)} onChange={() => applyAct(toggle(selAct, a.name))} aria-label={`Include ${a.name}`} />
                        <Badge appearance="tint" color={a.kind === 'create' ? 'success' : a.kind === 'delete' ? 'danger' : 'brand'}>{a.kind}</Badge>
                        <div className={s.rowText}>
                          <Body1><strong>{a.name}</strong> <Caption1 as="span" className={s.hint}>→ {a.objectType}</Caption1></Body1>
                          {a.params && a.params.length > 0 && <Caption1 className={s.hint}>params: {a.params.join(', ')}</Caption1>}
                        </div>
                        <span className={s.spacer} />
                        {!targetIncluded && <Badge appearance="tint" color="warning">object excluded</Badge>}
                      </div>
                    );
                  })}
                </div>
              )}
              <Caption1 className={s.mutedCaption}>
                Generating includes <strong>{selObj.size}</strong> object type{selObj.size === 1 ? '' : 's'}
                {selLink.size > 0 ? <>, {selLink.size} link{selLink.size === 1 ? '' : 's'}</> : null}
                {selAct.size > 0 ? <>, {selAct.size} action{selAct.size === 1 ? '' : 's'}</> : null}. Links / actions to excluded object types are skipped.
              </Caption1>
            </>
          )}
          <SaveStrip saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
        </div>

        {gen && (
          <div className={s.section}>
            <SectionHead icon={<Code20Regular />} title="Generated SDK" hint={`${gen.objectCount} object type${gen.objectCount === 1 ? '' : 's'} · ${gen.actionCount} action${gen.actionCount === 1 ? '' : 's'} · ${gen.propertyCount} typed propert${gen.propertyCount === 1 ? 'y' : 'ies'}. Real typed clients + dab-config.json — copy into your project.`} />
            {gen.propertyCount === 0 && (
              <MessageBar intent="info"><MessageBarBody>
                <MessageBarTitle>Untyped object properties</MessageBarTitle>
                No column bindings are declared on this ontology yet, so the interfaces use an untyped property bag. Bind a Lakehouse / Warehouse source on the Ontology (with key + writable columns) to emit typed members. Precise scalar typing (int / decimal / datetime / bool) is introspected from the source schema in a later pass.
              </MessageBarBody></MessageBar>
            )}
            <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'ts' | 'py' | 'actions' | 'dab')}>
              <Tab value="ts">TypeScript</Tab>
              <Tab value="py">Python</Tab>
              {gen.actions ? <Tab value="actions">Actions</Tab> : null}
              <Tab value="dab">dab-config.json</Tab>
            </TabList>
            <CodeBlock ariaLabel="Generated SDK source" content={
              tab === 'ts' ? gen.typescript
                : tab === 'py' ? gen.python
                : tab === 'actions' ? gen.actions
                : JSON.stringify(gen.dabConfig, null, 2)
            } />
          </div>
        )}

        {onto.boundOntologyId && (
          <OsdkTryIt
            id={id}
            objectTypes={[...selObj].length ? [...selObj] : classes.map((c) => c.name)}
            serviceUrl={String(state.serviceUrl || '')}
            onServiceUrl={(v) => setState((p) => ({ ...p, serviceUrl: v }))}
          />
        )}
      </div>
    } />
  );
}
