'use client';

/**
 * MappingDataFlowEditor — the editor for the "Mapping data flow" item type
 * (slug `mapping-dataflow`). It hosts the visual ADF / Synapse SPARK-based
 * <MappingDataFlowDesigner/> (graph of Source / transformation / Sink nodes
 * compiling to the Data Flow Script Spark runs).
 *
 * This is DISTINCT from the `dataflow` item type, which is the Power Query /
 * Dataflow Gen2 (WranglingDataFlow) editor. Both coexist; this one owns the
 * MappingDataFlow (`Microsoft.DataFactory/factories/dataflows`,
 * `properties.type === 'MappingDataFlow'`) surface.
 *
 * Round-trips via the real REST already wired in:
 *   - GET  /api/adf/dataflows/{name}     → hydrate an existing flow
 *   - PUT  /api/adf/dataflows/{name}     → upsert (real ARM `upsertDataFlow`)
 *   - GET  /api/adf/datasets             → source/sink DatasetPicker list
 * The factory is the env-pinned deployment default; when it isn't configured
 * the routes return a 503 `not_configured` gate which we surface as an honest
 * Fluent MessageBar (per no-vaporware.md). Data preview / debug needs a live
 * Spark data-flow debug cluster — the designer renders that as an honest gate;
 * we never fake preview rows.
 *
 * The item `id` is the data flow name. `new` opens a fresh, unsaved flow; the
 * user names the first transformation and Saves, which PUTs the named flow.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, MessageBar, MessageBarBody, MessageBarTitle, Field, Input, Button,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Save20Regular, ArrowSync20Regular } from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { MappingDataFlowDesigner } from '@/lib/components/pipeline/dataflow/mapping-dataflow-designer';
import { clientFetch } from '@/lib/client-fetch';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import type { AdfDataset, AdfDataFlow } from '@/lib/azure/adf-client';

const useStyles = makeStyles({
  pad: {
    padding: tokens.spacingVerticalL,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    flex: 1, minHeight: 0,
  },
  nameRow: {
    display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap',
  },
  nameField: { minWidth: '280px' },
  loading: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalXXL, justifyContent: 'center',
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow4,
    color: tokens.colorNeutralForeground3,
  },
  breakText: { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0, maxWidth: '100%' },
  // Honest infra-gate banner for the data-flow Spark debug cluster — sits with
  // the designer it applies to so the gated Debug/Preview affordance is never
  // ambiguous (per no-vaporware.md). Subtle elevation to match sibling cards.
  debugGate: { boxShadow: tokens.shadow2 },
  gateCode: {
    fontFamily: tokens.fontFamilyMonospace,
    backgroundColor: tokens.colorNeutralBackground3,
    paddingInline: tokens.spacingHorizontalXXS,
    borderRadius: tokens.borderRadiusSmall,
  },
});

const NAME_RE = /^[A-Za-z0-9_]{1,260}$/;

interface EditorProps { item: FabricItemType; id: string; }

export function MappingDataFlowEditor({ item, id }: EditorProps) {
  const s = useStyles();
  const isNew = id === 'new';

  // For a new flow the user names it before saving; for an existing one the id
  // IS the data-flow name.
  const [name, setName] = useState(isNew ? '' : id);
  const [initial, setInitial] = useState<AdfDataFlow['properties'] | undefined>(undefined);
  const [datasets, setDatasets] = useState<AdfDataset[]>([]);
  const [datasetGate, setDatasetGate] = useState<string | null>(null);
  const [loadGate, setLoadGate] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [reloadKey, setReloadKey] = useState(0);

  // Load source/sink datasets (real GET — honest gate when factory unconfigured).
  const loadDatasets = useCallback(async () => {
    setDatasetGate(null);
    try {
      const r = await clientFetch('/api/adf/datasets', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 && j?.code === 'not_configured') {
        setDatasetGate(String(j.error || 'Data Factory not configured.'));
        setDatasets([]);
        return;
      }
      if (!r.ok || !j?.ok) { setDatasetGate(String(j?.error || `HTTP ${r.status}`)); setDatasets([]); return; }
      setDatasets(Array.isArray(j.datasets) ? j.datasets : []);
    } catch (e: any) {
      setDatasetGate(e?.message || String(e));
      setDatasets([]);
    }
  }, []);

  // Hydrate an existing flow's definition (real GET /api/adf/dataflows/{name}).
  const loadFlow = useCallback(async () => {
    if (isNew) { setInitial(undefined); setLoading(false); return; }
    setLoading(true); setLoadGate(null); setLoadError(null);
    try {
      const r = await clientFetch(`/api/adf/dataflows/${encodeURIComponent(id)}`, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 && j?.code === 'not_configured') {
        setLoadGate(String(j.error || 'Data Factory not configured.'));
        return;
      }
      if (!r.ok || !j?.ok) {
        // A brand-new (not-yet-saved) flow id 404s — treat as an empty canvas.
        if (r.status === 404 || /not\s*found/i.test(String(j?.error || ''))) {
          setInitial(undefined);
          return;
        }
        setLoadError(String(j?.error || `HTTP ${r.status}`));
        return;
      }
      setInitial((j.dataflow as AdfDataFlow)?.properties);
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [id, isNew]);

  useEffect(() => { loadDatasets(); }, [loadDatasets, reloadKey]);
  useEffect(() => { loadFlow(); }, [loadFlow, reloadKey]);

  const nameValid = NAME_RE.test(name.trim());

  const ribbon: RibbonTab[] = useMemo(() => [
    {
      id: 'home',
      label: 'Home',
      groups: [
        {
          label: 'Data flow',
          actions: [
            {
              label: 'Refresh',
              icon: <ArrowSync20Regular />,
              onClick: () => setReloadKey((k) => k + 1),
            },
          ],
        },
      ],
    },
  ], []);

  const main = (
    <div className={s.pad} data-editor="mapping-dataflow">
      {/* New-flow name field — the data-flow resource name (ADF dataflows/{name}). */}
      {isNew && (
        <div className={s.nameRow}>
          <Field
            className={s.nameField}
            label="Data flow name"
            required
            validationState={name && !nameValid ? 'error' : 'none'}
            validationMessage={name && !nameValid ? '1–260 chars: letters, digits, underscore.' : undefined}
            hint="The MappingDataFlow resource name. Save publishes it to the deployment Data Factory."
          >
            <Input
              value={name}
              placeholder="dataflow1"
              onChange={(_, d) => setName(d.value.replace(/[^A-Za-z0-9_]/g, ''))}
            />
          </Field>
        </div>
      )}

      {loadGate && (
        <MessageBar intent="warning">
          <MessageBarBody className={s.breakText}>
            <MessageBarTitle>Data Factory not configured</MessageBarTitle>
            {loadGate} The designer still renders so you can author the graph;
            Save publishes once the factory is configured.
          </MessageBarBody>
        </MessageBar>
      )}
      {loadError && (
        <MessageBar intent="error">
          <MessageBarBody className={s.breakText}>
            <MessageBarTitle>Couldn’t load the data flow</MessageBarTitle>
            {loadError}
            <div style={{ marginTop: tokens.spacingVerticalS }}>
              <Button size="small" icon={<ArrowSync20Regular />} onClick={() => setReloadKey((k) => k + 1)}>
                Retry
              </Button>
            </div>
          </MessageBarBody>
        </MessageBar>
      )}

      {loading ? (
        <div className={s.loading}>
          <Spinner size="small" /> Loading data flow…
        </div>
      ) : (
        // The designer owns the canvas + config panel + Save. For a NEW flow we
        // pass the (validated) name so its Save targets the right resource; the
        // designer disables nothing structurally — it just needs a stable name.
        <>
          {/* Honest infra-gate (per no-vaporware.md): authoring is fully
              functional — add transform / configure / Save write the REAL ADF
              data-flow definition now — but Data preview / Debug needs a Spark
              data-flow debug cluster that is not wired in this deployment. We
              surface that EXPLICITLY here (not just implicitly via the designer's
              disabled toggle) so `debugClusterAvailable={false}` reads as an
              honest gate, not a silent dead control. */}
          <MessageBar intent="warning" className={s.debugGate}>
            <MessageBarBody className={s.breakText}>
              <MessageBarTitle>Data preview / debug is gated in this deployment</MessageBarTitle>
              Data preview / debug needs a Spark data-flow debug cluster
              (<code className={s.gateCode}>createDataFlowDebugSession</code> +{' '}
              <code className={s.gateCode}>executeDataFlowDebugCommand</code> on{' '}
              <code className={s.gateCode}>Microsoft.DataFactory/factories</code>),
              which is not wired in this deployment — authoring (add transform /
              configure / save) writes the real ADF data-flow definition now;
              preview lights up once the debug-session helper is added to{' '}
              <code className={s.gateCode}>lib/azure/adf-client.ts</code>.
            </MessageBarBody>
          </MessageBar>

          <MappingDataFlowDesigner
            key={`${reloadKey}:${isNew ? name || 'new' : id}`}
            name={isNew ? (nameValid ? name.trim() : 'dataflow1') : id}
            initial={initial}
            datasets={datasets}
            datasetGate={datasetGate}
            // No Spark data-flow debug cluster is wired in this deployment, so the
            // designer's Debug toggle + per-transform Data preview render their
            // honest "start a debug session" gate rather than faking rows. This
            // flag is the single switch the helper above flips on once
            // createDataFlowDebugSession is added to lib/azure/adf-client.ts.
            debugClusterAvailable={false}
          />
        </>
      )}
    </div>
  );

  return <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={main} />;
}

export default MappingDataFlowEditor;
