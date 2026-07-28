'use client';

/**
 * B-N19g — Catalog interop: export Loom governance metadata as DataHub MCE /
 * OpenMetadata JSON / OpenLineage events, and backfill curation the other way.
 *
 * Every control calls the real BFF (no-vaporware.md):
 *   GET  /api/catalog/interop/export?format=…&workspaceId=…&lineage=…
 *   GET  /api/catalog/interop/export?…&download=true      (file attachment)
 *   POST /api/catalog/interop/ingest                       (dry-run, then apply)
 *
 * The ingest is a two-step by design: "Preview changes" runs the plan and shows
 * exactly which items would gain which owners / tags / description / label /
 * lineage (and why each skipped row was skipped); "Apply" performs the real
 * Cosmos writes + lineage records. Nothing is written until you press Apply.
 *
 * Fluent v9 + Loom tokens only, GovernanceShell chrome, no raw px/hex.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  Badge, Body1, Button, Caption1, Dropdown, Field, MessageBar, MessageBarBody,
  MessageBarTitle, Option, Spinner, Switch, Textarea, Text,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowDownload20Regular, ArrowUpload20Regular, DatabaseLink20Regular,
  Eye20Regular, CheckmarkCircle20Regular,
} from '@fluentui/react-icons';
import { GovernanceShell } from '@/lib/components/governance-shell';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { clientFetch } from '@/lib/client-fetch';

type ExportFormat = 'datahub' | 'openmetadata' | 'openlineage';
type IngestFormat = 'datahub' | 'openmetadata';

const EXPORT_FORMATS: Array<{ id: ExportFormat; label: string; hint: string }> = [
  { id: 'datahub', label: 'DataHub (MetadataChangeEvent)', hint: 'Ingest with the DataHub `file` source.' },
  { id: 'openmetadata', label: 'OpenMetadata (entities + lineage)', hint: 'Ingest with the OpenMetadata custom/file connector.' },
  { id: 'openlineage', label: 'OpenLineage 1.x (RunEvent stream)', hint: 'Vendor-neutral: Marquez, DataHub, and OpenMetadata all read it.' },
];

interface ExportResult {
  format: ExportFormat;
  assetCount: number;
  lineageCount: number;
  workspaceCount: number;
  truncated: boolean;
  recordCount: number;
  payload: unknown;
}

interface IngestChange {
  itemId: string;
  itemType: string;
  displayName: string;
  description?: string;
  addOwners: string[];
  addTags: string[];
  sensitivityLabel?: string;
  addUpstreamItemIds: string[];
}

interface IngestPlan {
  changes: IngestChange[];
  skipped: Array<{ uri: string; reason: string }>;
  unresolved: string[];
  totals: {
    records: number;
    itemsToUpdate: number;
    ownersAdded: number;
    tagsAdded: number;
    descriptionsSet: number;
    labelsSet: number;
    lineageEdges: number;
  };
}

interface ApplyResult {
  itemsUpdated: number;
  lineageEdgesWritten: number;
  failures: Array<{ itemId: string; error: string }>;
}

const useStyles = makeStyles({
  head: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  headIcon: { color: tokens.colorBrandForeground1, width: '20px', height: '20px' },
  muted: { color: tokens.colorNeutralForeground3 },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: tokens.spacingHorizontalL, minWidth: 0 },
  field: { minWidth: '260px', flex: '1 1 260px' },
  statRow: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, minWidth: 0, marginBottom: tokens.spacingVerticalM },
  code: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre',
    overflowX: 'auto',
    maxHeight: '320px',
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  tagRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  cellName: { minWidth: 0, overflowWrap: 'anywhere' },
});

export default function CatalogInteropPage() {
  const s = useStyles();

  // Export state.
  const [format, setFormat] = useState<ExportFormat>('datahub');
  const [includeLineage, setIncludeLineage] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [exportErr, setExportErr] = useState<string | null>(null);

  // Ingest state.
  const [ingestFormat, setIngestFormat] = useState<IngestFormat>('datahub');
  const [ingestText, setIngestText] = useState('');
  const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [plan, setPlan] = useState<IngestPlan | null>(null);
  const [applied, setApplied] = useState<ApplyResult | null>(null);
  const [ingestErr, setIngestErr] = useState<string | null>(null);

  const exportUrl = useMemo(
    () => `/api/catalog/interop/export?format=${format}&lineage=${includeLineage ? 'true' : 'false'}`,
    [format, includeLineage],
  );

  const runExport = useCallback(async () => {
    setExporting(true);
    setExportErr(null);
    setExportResult(null);
    try {
      const r = await clientFetch(exportUrl);
      const j = await r.json();
      if (!j.ok) {
        setExportErr(j.error || `HTTP ${r.status}`);
        return;
      }
      setExportResult(j as ExportResult);
    } catch (e) {
      setExportErr((e as Error)?.message || String(e));
    } finally {
      setExporting(false);
    }
  }, [exportUrl]);

  const parseIngestBody = useCallback((): unknown | null => {
    try {
      return JSON.parse(ingestText);
    } catch (e) {
      setIngestErr(`The payload is not valid JSON: ${(e as Error)?.message || e}`);
      return null;
    }
  }, [ingestText]);

  const runPlan = useCallback(async () => {
    setIngestErr(null);
    setPlan(null);
    setApplied(null);
    const payload = parseIngestBody();
    if (payload == null) return;
    setPlanning(true);
    try {
      const r = await clientFetch('/api/catalog/interop/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ format: ingestFormat, payload }),
      });
      const j = await r.json();
      if (!j.ok) {
        setIngestErr(j.error || `HTTP ${r.status}`);
        return;
      }
      setPlan(j.plan as IngestPlan);
    } catch (e) {
      setIngestErr((e as Error)?.message || String(e));
    } finally {
      setPlanning(false);
    }
  }, [ingestFormat, parseIngestBody]);

  const runApply = useCallback(async () => {
    setIngestErr(null);
    const payload = parseIngestBody();
    if (payload == null) return;
    setApplying(true);
    try {
      const r = await clientFetch('/api/catalog/interop/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ format: ingestFormat, payload, apply: true }),
      });
      const j = await r.json();
      if (!j.ok) {
        setIngestErr(j.error || `HTTP ${r.status}`);
        return;
      }
      setPlan(j.plan as IngestPlan);
      setApplied(j.applied as ApplyResult);
    } catch (e) {
      setIngestErr((e as Error)?.message || String(e));
    } finally {
      setApplying(false);
    }
  }, [ingestFormat, parseIngestBody]);

  const preview = useMemo(() => {
    if (!exportResult) return '';
    const text = JSON.stringify(exportResult.payload, null, 2);
    return text.length > 20_000 ? `${text.slice(0, 20_000)}\n… (truncated preview — use Download for the full file)` : text;
  }, [exportResult]);

  const changeColumns: LoomColumn<IngestChange>[] = [
    {
      key: 'displayName', label: 'Item', sortable: true, filterable: true, width: 240,
      getValue: (c) => c.displayName,
      render: (c) => (
        <div className={s.cellName}>
          <strong>{c.displayName}</strong>
          <Caption1 className={s.muted} style={{ display: 'block' }}>{c.itemType}</Caption1>
        </div>
      ),
    },
    {
      key: 'addOwners', label: 'Owners added', sortable: true, width: 200,
      getValue: (c) => c.addOwners.length,
      render: (c) => (
        <div className={s.tagRow}>
          {c.addOwners.length ? c.addOwners.map((o) => <Badge key={o} appearance="tint" size="small">{o}</Badge>) : <span className={s.muted}>—</span>}
        </div>
      ),
    },
    {
      key: 'addTags', label: 'Tags added', sortable: true, width: 220,
      getValue: (c) => c.addTags.length,
      render: (c) => (
        <div className={s.tagRow}>
          {c.addTags.length ? c.addTags.map((t) => <Badge key={t} appearance="tint" color="brand" size="small">{t}</Badge>) : <span className={s.muted}>—</span>}
        </div>
      ),
    },
    {
      key: 'description', label: 'Description', sortable: false, width: 130,
      render: (c) => (c.description ? <Badge appearance="tint" color="success" size="small">set</Badge> : <span className={s.muted}>—</span>),
    },
    {
      key: 'sensitivityLabel', label: 'Label', sortable: false, width: 140,
      render: (c) => (c.sensitivityLabel ? <Badge appearance="tint" color="warning" size="small">{c.sensitivityLabel}</Badge> : <span className={s.muted}>—</span>),
    },
    {
      key: 'addUpstreamItemIds', label: 'Lineage', sortable: true, width: 120,
      getValue: (c) => c.addUpstreamItemIds.length,
      render: (c) => (c.addUpstreamItemIds.length ? <Badge appearance="tint" color="informative" size="small">{`+${c.addUpstreamItemIds.length} upstream`}</Badge> : <span className={s.muted}>—</span>),
    },
  ];

  return (
    <GovernanceShell
      sectionTitle="Catalog interop"
      explainer={
        <>
          Loom speaks the open catalog formats in both directions. Export your governed asset
          inventory &mdash; descriptions, owners, tags, classifications, sensitivity labels, schemas,
          and lineage &mdash; as DataHub MetadataChangeEvents, an OpenMetadata entity payload, or a
          vendor-neutral OpenLineage 1.x stream. Then bring curation the other way: paste a payload
          from your existing catalog, preview exactly what would change, and apply it. Asset identity
          is the same URI Loom&apos;s OpenLineage emitter stamps, so nothing is guessed on the way back.
        </>
      }
    >
      <Body1 className={s.muted}>
        No SaaS catalog is contacted from this page: Loom emits the format and accepts it back, so
        governance metadata is portable without a network dependency on a vendor service.
      </Body1>

      <div style={{ marginTop: tokens.spacingVerticalL, marginBottom: tokens.spacingVerticalL }}>
        <TeachingBanner
          surfaceKey="catalog-interop"
          title="Round-trip your catalog"
          message="Export in your target catalog's format, ingest it there, then paste the curated payload back here and press Preview changes. Loom merges additively — owners and tags union, and a description or label is only written when Loom has none — so an import can never overwrite curation done in Loom."
          learnMoreHref="https://openlineage.io/docs/"
        />
      </div>

      <Section
        title={<span className={s.head}><ArrowDownload20Regular className={s.headIcon} aria-hidden />Export</span>}
        actions={<Badge appearance="tint" color="informative">live · Cosmos catalog + Weave lineage</Badge>}
      >
        <div className={s.row}>
          <Field label="Format" className={s.field} hint={EXPORT_FORMATS.find((f) => f.id === format)?.hint}>
            <Dropdown
              value={EXPORT_FORMATS.find((f) => f.id === format)?.label || ''}
              selectedOptions={[format]}
              onOptionSelect={(_e, d) => setFormat(d.optionValue as ExportFormat)}
            >
              {EXPORT_FORMATS.map((f) => <Option key={f.id} value={f.id}>{f.label}</Option>)}
            </Dropdown>
          </Field>
          <Switch
            checked={includeLineage}
            onChange={(_e, d) => setIncludeLineage(d.checked)}
            label="Include lineage edges"
          />
        </div>

        <Toolbar
          actions={
            <>
              <Button appearance="primary" icon={<Eye20Regular />} disabled={exporting} onClick={() => void runExport()}>
                {exporting ? 'Exporting…' : 'Preview export'}
              </Button>
              <Button icon={<ArrowDownload20Regular />} as="a" href={`${exportUrl}&download=true`}>
                Download JSON
              </Button>
            </>
          }
        />

        {exporting && <Spinner label="Reading the catalog…" />}

        {exportErr && (
          <MessageBar intent="error" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>Export failed</MessageBarTitle>
              {exportErr}
            </MessageBarBody>
          </MessageBar>
        )}

        {exportResult && (
          <>
            <div className={s.statRow}>
              <Badge appearance="tint">{exportResult.assetCount} asset(s)</Badge>
              <Badge appearance="tint">{exportResult.lineageCount} lineage edge(s)</Badge>
              <Badge appearance="tint">{exportResult.workspaceCount} workspace(s)</Badge>
              <Badge appearance="tint" color="brand">{exportResult.recordCount} record(s) emitted</Badge>
            </div>
            {exportResult.truncated && (
              <MessageBar intent="warning" layout="multiline">
                <MessageBarBody>
                  <MessageBarTitle>Export truncated</MessageBarTitle>
                  This catalog is larger than the per-call export cap. Narrow the scope to a single
                  workspace, or export in batches, to publish the full inventory.
                </MessageBarBody>
              </MessageBar>
            )}
            {exportResult.assetCount === 0 ? (
              <MessageBar intent="info" layout="multiline">
                <MessageBarBody>
                  <MessageBarTitle>Nothing to export yet</MessageBarTitle>
                  No catalogued items were found for your workspaces. Create or register items first &mdash;
                  every Loom item becomes an exportable catalog asset automatically.
                </MessageBarBody>
              </MessageBar>
            ) : (
              <Text as="pre" className={s.code}>{preview}</Text>
            )}
          </>
        )}
      </Section>

      <Section
        title={<span className={s.head}><ArrowUpload20Regular className={s.headIcon} aria-hidden />Ingest (backfill)</span>}
        actions={<Badge appearance="tint" color="warning">dry-run by default</Badge>}
      >
        <div className={s.stack}>
          <div className={s.row}>
            <Field label="Payload format" className={s.field}>
              <Dropdown
                value={ingestFormat === 'datahub' ? 'DataHub (MetadataChangeEvent)' : 'OpenMetadata (entities + lineage)'}
                selectedOptions={[ingestFormat]}
                onOptionSelect={(_e, d) => setIngestFormat(d.optionValue as IngestFormat)}
              >
                <Option value="datahub">DataHub (MetadataChangeEvent)</Option>
                <Option value="openmetadata">OpenMetadata (entities + lineage)</Option>
              </Dropdown>
            </Field>
          </div>

          <Field label="Payload JSON" hint="Paste the export from your catalog. Loom resolves each asset by the URI it stamped on export.">
            <Textarea
              value={ingestText}
              onChange={(_e, d) => setIngestText(d.value)}
              rows={8}
              placeholder='{ "mces": [ … ] }'
            />
          </Field>

          <Toolbar
            actions={
              <>
                <Button
                  appearance="primary"
                  icon={<Eye20Regular />}
                  disabled={planning || !ingestText.trim()}
                  onClick={() => void runPlan()}
                >
                  {planning ? 'Planning…' : 'Preview changes'}
                </Button>
                <Button
                  icon={<CheckmarkCircle20Regular />}
                  disabled={applying || !plan || plan.changes.length === 0}
                  onClick={() => void runApply()}
                >
                  {applying ? 'Applying…' : `Apply ${plan ? plan.changes.length : 0} change(s)`}
                </Button>
              </>
            }
          />

          {ingestErr && (
            <MessageBar intent="error" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>Ingest failed</MessageBarTitle>
                {ingestErr}
              </MessageBarBody>
            </MessageBar>
          )}

          {applied && (
            <MessageBar intent={applied.failures.length ? 'warning' : 'success'} layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>
                  {applied.failures.length ? 'Applied with failures' : 'Applied'}
                </MessageBarTitle>
                {`${applied.itemsUpdated} item(s) updated, ${applied.lineageEdgesWritten} lineage edge(s) recorded.`}
                {applied.failures.length ? ` ${applied.failures.length} item(s) failed: ${applied.failures.map((f) => `${f.itemId} (${f.error})`).join('; ')}` : ''}
              </MessageBarBody>
            </MessageBar>
          )}

          {plan && (
            <>
              <div className={s.statRow}>
                <Badge appearance="tint">{plan.totals.records} record(s) read</Badge>
                <Badge appearance="tint" color="brand">{plan.totals.itemsToUpdate} item(s) to update</Badge>
                <Badge appearance="tint">{plan.totals.ownersAdded} owner(s)</Badge>
                <Badge appearance="tint">{plan.totals.tagsAdded} tag(s)</Badge>
                <Badge appearance="tint">{plan.totals.descriptionsSet} description(s)</Badge>
                <Badge appearance="tint">{plan.totals.labelsSet} label(s)</Badge>
                <Badge appearance="tint">{plan.totals.lineageEdges} lineage edge(s)</Badge>
              </div>

              <LoomDataTable
                ariaLabel="Planned catalog-ingest changes"
                getRowId={(c) => c.itemId}
                rows={plan.changes}
                empty="Nothing would change — every asset in the payload already carries this metadata in Loom."
                columns={changeColumns}
              />

              {(plan.skipped.length > 0 || plan.unresolved.length > 0) && (
                <MessageBar intent="info" layout="multiline">
                  <MessageBarBody>
                    <MessageBarTitle>Skipped rows</MessageBarTitle>
                    {plan.skipped.filter((x) => x.reason === 'unknown-item').length > 0 &&
                      `${plan.skipped.filter((x) => x.reason === 'unknown-item').length} asset(s) do not resolve to a Loom item in this scope. `}
                    {plan.skipped.filter((x) => x.reason === 'no-change').length > 0 &&
                      `${plan.skipped.filter((x) => x.reason === 'no-change').length} asset(s) are already up to date. `}
                    {plan.unresolved.length > 0 &&
                      `${plan.unresolved.length} entity URN(s) belong to another platform and cannot be mapped to a Loom item.`}
                  </MessageBarBody>
                </MessageBar>
              )}
            </>
          )}
        </div>
      </Section>

      <Section title={<span className={s.head}><DatabaseLink20Regular className={s.headIcon} aria-hidden />How identity is preserved</span>}>
        <Body1 className={s.muted}>
          Every exported asset is named by the same URI Loom&apos;s OpenLineage emitter stamps on a run
          (<code>loom://items/&lt;type&gt;/&lt;id&gt;</code>, or the physical <code>abfss://</code> URI when one is
          known). DataHub dataset URNs embed that URI, OpenMetadata fully-qualified names prefix it with
          the <code>loom</code> service, and the OpenLineage stream uses it directly &mdash; so all three
          formats describe one graph, and an ingest resolves straight back to the originating item.
        </Body1>
      </Section>
    </GovernanceShell>
  );
}
