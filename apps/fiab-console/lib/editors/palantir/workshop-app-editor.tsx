'use client';

/**
 * WorkshopAppEditor (Workshop → Atelier) — ontology-bound low-code app.
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

// ───────────────────────── Workshop app (Atelier) ─────────────────────────
interface WorkshopAction { id: string; label: string; kind: 'create' | 'update' | 'delete'; entity: string }
interface WorkshopVersion { version: string; url: string; hostname: string; staticSiteName: string; createdAt: string; widgetCount: number }
interface WorkshopState {
  boundOntologyId?: string; boundOntologyName?: string;
  objectViews?: string[]; actions?: WorkshopAction[];
  // New app-builder model (canvas widgets + typed variables), persisted to Cosmos.
  widgets?: WorkshopWidget[]; variables?: WorkshopVariable[];
  // Real SWA publish history (Microsoft.Web/staticSites) persisted to Cosmos.
  versions?: WorkshopVersion[]; staticSiteName?: string; lastPublishedUrl?: string; lastPublishedAt?: string;
  // Set by the slate-workshop-app demote-to-template scaffold: the backing
  // Data API Builder item this Workshop app was wired to (proves the template
  // created REAL, navigable sibling items — no placeholder).
  dataApiItemId?: string; dataApiBaseUrl?: string;
  [k: string]: unknown;
}

export function WorkshopAppEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const router = useRouter();
  const { state, setState, loading, saving, error, savedAt, save, reload, dirty } = useItemState<WorkshopState>('workshop-app', id, { widgets: [], variables: [] });
  const onto = useOntologyBinding('workshop-app', id);
  const [pickOnto, setPickOnto] = useState('');
  // Publish → Azure Static Web Apps (mirrors the Slate app's real SWA publish).
  const [pubOpen, setPubOpen] = useState(false);
  const [pubBusy, setPubBusy] = useState(false);
  const [pubMsg, setPubMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [pubFiles, setPubFiles] = useState<Array<{ name: string; content: string }>>([]);
  const [pubFileTab, setPubFileTab] = useState('index.html');

  const classes = onto.surface?.classes || [];
  const entityTypes = useMemo(() => classes.map((c) => c.name), [classes]);
  const widgets = Array.isArray(state.widgets) ? state.widgets : [];
  const variables = Array.isArray(state.variables) ? state.variables : [];
  const versions = Array.isArray(state.versions) ? state.versions : [];
  // Widgets the publish route embeds in the deployed bundle (text/button always;
  // data widgets need a bound object type).
  const publishableCount = useMemo(
    () => widgets.filter((w) => w.kind === 'text' || w.kind === 'button' || !!w.entityType).length,
    [widgets],
  );

  const onWidgetsChange = useCallback((next: WorkshopWidget[]) => setState((p) => ({ ...p, widgets: next })), [setState]);
  const onVariablesChange = useCallback((next: WorkshopVariable[]) => setState((p) => ({ ...p, variables: next })), [setState]);

  const publish = useCallback(async () => {
    setPubBusy(true); setPubMsg(null);
    try {
      // Persist the latest widgets/variables first so Publish deploys the current app.
      if (dirty) await save();
      const r = await fetch(`/api/items/workshop-app/${encodeURIComponent(id)}/publish`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.reason || ''} ${j.gate.remediation || ''}` : '';
        setPubMsg({ intent: j?.gate ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setPubMsg({ intent: 'success', text: `Published ${j.version} → Azure Static Web App “${j.staticSiteName}”.${j.url ? ` Live at ${j.url}.` : ''}${j.tokenRetrieved ? ' Deployment token retrieved.' : ''}` });
      if (Array.isArray(j.files)) { setPubFiles(j.files); setPubFileTab(j.files[0]?.name || 'index.html'); }
      await reload(); // pull the new versions[] from Cosmos
    } catch (e: any) { setPubMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setPubBusy(false); }
  }, [id, dirty, save, reload]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'App', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || !dirty },
      ]},
      { label: 'Deploy', actions: [
        { label: 'Publish…', onClick: () => { setPubMsg(null); setPubOpen(true); }, disabled: false },
      ]},
    ]},
  ], [save, saving, dirty]);

  if (id === 'new') return <NewItemCreateGate item={item} createLabel="Create Workshop app" intro="An operational low-code app builder bound to a Loom Ontology. Place widgets — object tables, charts, KPIs, filters, forms and buttons — on a drag-resize canvas, drive them with typed variables, and wire events, all over the ontology's Azure-native Synapse warehouse. No Fabric required." />;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info"><MessageBarBody>
          <MessageBarTitle>Workshop app (Palantir Workshop → Atelier)</MessageBarTitle>
          Bind a Loom Ontology, then build an operational low-code app on the canvas — object tables, charts, KPIs, filters, forms and buttons over the ontology's entity types, driven by typed variables and event wiring. Runs on Azure Container Apps over the ontology's bound Synapse warehouse — no Microsoft Fabric required.
        </MessageBarBody></MessageBar>

        {state.dataApiItemId && (
          <MessageBar intent="success"><MessageBarBody>
            <MessageBarTitle>Wired to a Data API</MessageBarTitle>
            This app was scaffolded with a backing Data API Builder item as its query surface{state.dataApiBaseUrl ? <> at <strong>{String(state.dataApiBaseUrl)}</strong></> : ''}.
            <Button appearance="transparent" size="small" icon={<Link20Regular />}
              onClick={() => router.push(`/items/data-api-builder/${encodeURIComponent(String(state.dataApiItemId))}`)}>
              Open Data API
            </Button>
          </MessageBarBody></MessageBar>
        )}

        <div className={s.section}>
          <SectionHead icon={<Link20Regular />} title="Bound ontology" hint="Pick a saved Ontology; its object types become the app's data sources (widgets bind to them)." />
          {!onto.loaded ? <div className={s.empty}><Spinner size="tiny" /></div> : onto.ontologies.length === 0 ? (
            <MessageBar intent="warning"><MessageBarBody>No ontologies found. Create an Ontology item first, then bind it here.</MessageBarBody></MessageBar>
          ) : (
            <div className={s.addBar}>
              <Field label="Ontology" className={s.fieldWide}>
                <Dropdown value={onto.ontologies.find((o) => o.id === (pickOnto || onto.boundOntologyId))?.displayName || ''}
                  selectedOptions={[(pickOnto || onto.boundOntologyId)]}
                  onOptionSelect={(_, d) => setPickOnto(d.optionValue || '')} placeholder="Select an ontology">
                  {onto.ontologies.map((o) => <Option key={o.id} value={o.id} text={o.displayName}>{`${o.displayName} (${o.classCount} objects)`}</Option>)}
                </Dropdown>
              </Field>
              <Button appearance="primary" icon={<Database20Regular />} disabled={onto.busy || !(pickOnto || onto.boundOntologyId)} onClick={() => onto.bind(pickOnto || onto.boundOntologyId)}>
                {onto.busy ? 'Binding…' : 'Bind ontology'}
              </Button>
            </div>
          )}
          {onto.msg && <MessageBar intent={onto.msg.intent}><MessageBarBody>{onto.msg.text}</MessageBarBody></MessageBar>}
        </div>

        <WorkshopAppBuilder id={id} entityTypes={entityTypes} widgets={widgets} variables={variables}
          onWidgetsChange={onWidgetsChange} onVariablesChange={onVariablesChange} />

        {/* Publish history — real Azure Static Web Apps versions persisted to Cosmos. */}
        <div className={s.section}>
          <SectionHead icon={<CloudArrowUp20Regular />} title="Publish → Azure Static Web Apps" hint="Each publish generates the app bundle from the canvas (widgets read live Synapse rows via the run-action API), provisions (or updates) a real Microsoft.Web/staticSites resource, and records a version. Azure-native — no Fabric." />
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

        {pubFiles.length > 0 && (
          <div className={s.section}>
            <SectionHead icon={<Code20Regular />} title="Generated Static Web Apps bundle" hint="The bundle the last publish generated from the canvas. Push these files with the SWA deployment token retrieved by Publish (SWA CLI / GitHub Action) — data widgets read live rows through this console's run-action API." />
            <TabList selectedValue={pubFileTab} onTabSelect={(_, d) => setPubFileTab(d.value as string)}>
              {pubFiles.map((f) => <Tab key={f.name} value={f.name}>{f.name}</Tab>)}
            </TabList>
            <CodeBlock ariaLabel={`${pubFileTab} source`} content={pubFiles.find((f) => f.name === pubFileTab)?.content || ''} />
          </div>
        )}

        <SaveStrip saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />

        <Dialog open={pubOpen} onOpenChange={(_, d) => { if (!d.open) setPubOpen(false); }}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Publish to Azure Static Web Apps</DialogTitle>
              <DialogContent>
                <div className={s.dialogForm}>
                  <MessageBar intent="info"><MessageBarBody>
                    Publish generates the app bundle from the canvas, provisions (or updates) a real <strong>Microsoft.Web/staticSites</strong> resource, and retrieves its SWA deployment token — the credential the SWA CLI / GitHub Action uses to push the bundle. Requires <strong>LOOM_SWA_SUBSCRIPTION_ID</strong> + <strong>LOOM_SWA_RESOURCE_GROUP</strong> (optional <strong>LOOM_SWA_LOCATION</strong>) and the Console UAMI granted <strong>Website Contributor</strong> on that resource group. Azure-native — no Microsoft Fabric.
                  </MessageBarBody></MessageBar>
                  <Caption1 className={s.hint}>
                    {publishableCount} widget{publishableCount === 1 ? '' : 's'} will be embedded in the deployed bundle (data widgets need a bound object type).
                    {dirty ? ' Unsaved changes are saved automatically before publishing.' : ''}
                  </Caption1>
                  {pubMsg && <MessageBar intent={pubMsg.intent}><MessageBarBody>{pubMsg.text}</MessageBarBody></MessageBar>}
                </div>
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setPubOpen(false)}>Close</Button>
                <Button appearance="primary" icon={pubBusy ? <Spinner size="tiny" /> : <CloudArrowUp20Regular />} disabled={pubBusy || publishableCount === 0} onClick={publish}>
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
