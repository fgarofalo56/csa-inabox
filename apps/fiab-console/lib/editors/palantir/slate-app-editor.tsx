'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * SlateAppEditor (Slate) — custom HTML/JS app published to Azure Static Web Apps.
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

// ───────────────────────── Slate app ─────────────────────────
interface SlateVersion { version: string; url: string; hostname: string; staticSiteName: string; createdAt: string; widgetCount: number }
interface SlateState {
  apiBaseUrl?: string; widgets?: SlateWidgetDef[]; queries?: SlateQueryDef[]; variables?: SlateVariable[]; lastGeneratedAt?: string;
  // Real SWA publish history (Microsoft.Web/staticSites) persisted to Cosmos.
  versions?: SlateVersion[]; staticSiteName?: string; lastPublishedUrl?: string; lastPublishedAt?: string;
  // Set by the rayfin-azure-stack demote-to-template scaffold: the backing
  // Azure Functions API item this SWA web tier calls (apiBaseUrl is seeded to
  // its route). Proves the template wired a REAL Functions sibling.
  functionItemId?: string;
  [k: string]: unknown;
}

export function SlateAppEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const router = useRouter();
  const { state, setState, loading, saving, error, savedAt, save, reload, dirty } = useItemState<SlateState>('slate-app', id, { apiBaseUrl: '/api', widgets: [], queries: [], variables: [] });
  const [genBusy, setGenBusy] = useState(false);
  const [genErr, setGenErr] = useState<string | null>(null);
  const [files, setFiles] = useState<Array<{ name: string; content: string }>>([]);
  const [fileTab, setFileTab] = useState('index.html');
  // Publish → Azure Static Web Apps.
  const [pubOpen, setPubOpen] = useState(false);
  const [pubBusy, setPubBusy] = useState(false);
  const [pubMsg, setPubMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);

  const widgets = Array.isArray(state.widgets) ? state.widgets : [];
  const queries = Array.isArray(state.queries) ? state.queries : [];
  const variables = Array.isArray(state.variables) ? state.variables : [];
  const versions = Array.isArray(state.versions) ? state.versions : [];

  // Map the builder's typed widgets back onto the static-SWA codegen contract
  // ({id,title,kind,query}). REST-bound widgets carry a real path so the
  // generated bundle stays deployable; KQL/SQL/text/container widgets (which a
  // static SWA can't execute) are simply omitted from the bundle.
  const widgetsForCodegen = useMemo(() => {
    const byId = new Map(queries.map((q) => [q.id, q]));
    return widgets.map((w) => {
      let query = '';
      if (w.queryId) { const q = byId.get(w.queryId); if (q?.type === 'rest-dab') query = q.path || ''; }
      else if (w.query) query = w.query;
      const kind: 'table' | 'chart' | 'metric' = w.kind === 'chart' || w.kind === 'metric' ? w.kind : 'table';
      return { id: w.id, title: w.title, kind, query };
    }).filter((w) => w.query);
  }, [widgets, queries]);

  const setApiBaseUrl = useCallback((v: string) => setState((p) => ({ ...p, apiBaseUrl: v })), [setState]);
  const onQueriesChange = useCallback((next: SlateQueryDef[]) => setState((p) => ({ ...p, queries: next })), [setState]);
  const onWidgetsChange = useCallback((next: SlateWidgetDef[]) => setState((p) => ({ ...p, widgets: next })), [setState]);
  const onVariablesChange = useCallback((next: SlateVariable[]) => setState((p) => ({ ...p, variables: next })), [setState]);

  const generate = useCallback(async () => {
    setGenBusy(true); setGenErr(null);
    try {
      const r = await clientFetch(`/api/items/slate-app/${encodeURIComponent(id)}/generate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiBaseUrl: state.apiBaseUrl || '/api', widgets: widgetsForCodegen }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setGenErr(j?.error || `HTTP ${r.status}`); return; }
      setFiles(Array.isArray(j.files) ? j.files : []);
      setFileTab((j.files?.[0]?.name) || 'index.html');
    } catch (e: any) { setGenErr(e?.message || String(e)); }
    finally { setGenBusy(false); }
  }, [id, state.apiBaseUrl, widgetsForCodegen]);

  const publish = useCallback(async () => {
    setPubBusy(true); setPubMsg(null);
    try {
      // Persist the latest queries/widgets first so Publish deploys the current app.
      if (dirty) await save();
      const r = await clientFetch(`/api/items/slate-app/${encodeURIComponent(id)}/publish`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.reason || ''} ${j.gate.remediation || ''}` : '';
        setPubMsg({ intent: j?.gate ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setPubMsg({ intent: 'success', text: `Published ${j.version} → Azure Static Web App “${j.staticSiteName}”.${j.url ? ` Live at ${j.url}.` : ''}${j.tokenRetrieved ? ' Deployment token retrieved.' : ''}` });
      await reload(); // pull the new versions[] from Cosmos
    } catch (e: any) { setPubMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setPubBusy(false); }
  }, [id, dirty, save, reload]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'App', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || !dirty },
        { label: genBusy ? 'Generating…' : 'Generate bundle', onClick: generate, disabled: genBusy || widgetsForCodegen.length === 0 },
      ]},
      { label: 'Deploy', actions: [
        { label: 'Publish…', onClick: () => { setPubMsg(null); setPubOpen(true); }, disabled: false },
      ]},
    ]},
  ], [save, saving, dirty, generate, genBusy, widgetsForCodegen.length]);

  if (id === 'new') return <NewItemCreateGate item={item} createLabel="Create Slate app" intro="A live dashboard / app builder over Azure-native data (ADX, Synapse serverless, DAB REST). Compose queries + widgets on a drag-resize canvas, drive them with variables + interactions, preview live, then publish to Azure Static Web Apps — no Fabric required." />;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info"><MessageBarBody>
          <MessageBarTitle>Slate app (Palantir Slate)</MessageBarTitle>
          Build a live app: define queries (REST / KQL / SQL over Azure-native backends), place widgets on the drag-resize canvas, wire variables + interactions, and preview them bound to real data. Publish to Azure Static Web Apps when ready. No Microsoft Fabric required.
        </MessageBarBody></MessageBar>

        <div className={s.section}>
          <SectionHead icon={<Database20Regular />} title="Data API base" hint="The DAB / Ontology-SDK REST base that REST queries + write-backs resolve against (e.g. /api or an APIM URL). KQL / SQL queries hit ADX / Synapse directly." />
          <Field label="API base URL"><Input value={String(state.apiBaseUrl || '/api')} onChange={(_, d) => setApiBaseUrl(d.value)} placeholder="/api" /></Field>
          {state.functionItemId && (
            <Caption1 className={s.hint}>
              Backed by an Azure Functions API scaffolded with this app — the base URL above points at its route.
              <Button appearance="transparent" size="small" icon={<Link20Regular />}
                onClick={() => router.push(`/items/user-data-function/${encodeURIComponent(String(state.functionItemId))}`)}>
                Open Functions API
              </Button>
            </Caption1>
          )}
        </div>

        <SlateAppBuilder
          id={id}
          apiBaseUrl={String(state.apiBaseUrl || '/api')}
          queries={queries}
          widgets={widgets}
          variables={variables}
          onQueriesChange={onQueriesChange}
          onWidgetsChange={onWidgetsChange}
          onVariablesChange={onVariablesChange}
        />

        {genErr && <MessageBar intent="error"><MessageBarBody>{genErr}</MessageBarBody></MessageBar>}

        {files.length > 0 && (
          <div className={s.section}>
            <SectionHead icon={<Code20Regular />} title="Generated Static Web Apps bundle" hint="Copy these files into your SWA repo, or push them with the deployment token retrieved by Publish. REST-bound widgets are embedded; KQL / SQL widgets run live in Preview but aren't part of the static bundle." />
            <TabList selectedValue={fileTab} onTabSelect={(_, d) => setFileTab(d.value as string)}>
              {files.map((f) => <Tab key={f.name} value={f.name}>{f.name}</Tab>)}
            </TabList>
            <CodeBlock ariaLabel={`${fileTab} source`} content={files.find((f) => f.name === fileTab)?.content || ''} />
          </div>
        )}

        {/* Publish history — real Azure Static Web Apps versions persisted to Cosmos. */}
        <div className={s.section}>
          <SectionHead icon={<CloudArrowUp20Regular />} title="Publish → Azure Static Web Apps" hint="Each publish provisions (or updates) a real Microsoft.Web/staticSites resource and records a version. Azure-native — no Fabric." />
          <div className={s.addBar}>
            <Button appearance="primary" icon={<CloudArrowUp20Regular />} onClick={() => { setPubMsg(null); setPubOpen(true); }}>Publish…</Button>
            {state.lastPublishedUrl && (
              <Button appearance="outline" icon={<Open20Regular />} onClick={() => window.open(String(state.lastPublishedUrl), '_blank', 'noopener')}>Open live app</Button>
            )}
          </div>
          {versions.length === 0 ? (
            <div className={s.empty}><Caption1>Not published yet — click Publish to create an Azure Static Web App and record the first version.</Caption1></div>
          ) : (
            <div className={s.tableWrap}>
              <Table size="small" aria-label="Publish history">
                <TableHeader><TableRow>
                  <TableHeaderCell>Version</TableHeaderCell><TableHeaderCell>Static Web App</TableHeaderCell>
                  <TableHeaderCell>URL</TableHeaderCell><TableHeaderCell>Widgets</TableHeaderCell><TableHeaderCell>Published</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {versions.map((v) => (
                    <TableRow key={v.version + v.createdAt}>
                      <TableCell><Badge appearance="tint" color="brand">{v.version}</Badge></TableCell>
                      <TableCell>{v.staticSiteName}</TableCell>
                      <TableCell>{v.url
                        ? <Button appearance="transparent" size="small" icon={<Open20Regular />} onClick={() => window.open(v.url, '_blank', 'noopener')}>{v.hostname || 'open'}</Button>
                        : <Caption1 className={s.mutedCaption}>provisioning…</Caption1>}</TableCell>
                      <TableCell>{v.widgetCount}</TableCell>
                      <TableCell>{v.createdAt ? new Date(v.createdAt).toLocaleString() : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <SaveStrip saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />

        <Dialog open={pubOpen} onOpenChange={(_, d) => { if (!d.open) setPubOpen(false); }}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Publish to Azure Static Web Apps</DialogTitle>
              <DialogContent>
                <div className={s.dialogForm}>
                  <MessageBar intent="info"><MessageBarBody>
                    Publish provisions (or updates) a real <strong>Microsoft.Web/staticSites</strong> resource for this app and retrieves its SWA deployment token — the credential the SWA CLI / GitHub Action uses to push the generated bundle. Requires <strong>LOOM_SWA_SUBSCRIPTION_ID</strong> + <strong>LOOM_SWA_RESOURCE_GROUP</strong> (optional <strong>LOOM_SWA_LOCATION</strong>) and the Console UAMI granted <strong>Website Contributor</strong> on that resource group. Azure-native — no Microsoft Fabric.
                  </MessageBarBody></MessageBar>
                  <Caption1 className={s.hint}>
                    {widgetsForCodegen.length} REST-bound widget{widgetsForCodegen.length === 1 ? '' : 's'} will be embedded in the deployed bundle.
                    {dirty ? ' Unsaved changes are saved automatically before publishing.' : ''}
                  </Caption1>
                  {pubMsg && <MessageBar intent={pubMsg.intent}><MessageBarBody>{pubMsg.text}</MessageBarBody></MessageBar>}
                </div>
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setPubOpen(false)}>Close</Button>
                <Button appearance="primary" icon={pubBusy ? <Spinner size="tiny" /> : <CloudArrowUp20Regular />} disabled={pubBusy} onClick={publish}>
                  {pubBusy ? 'Publishing…' : 'Publish now'}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </div>
    } />
  );
}
