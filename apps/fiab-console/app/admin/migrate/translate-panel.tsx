'use client';

/**
 * /admin/migrate → Translate tab (M3 code translation review-diff).
 *
 * Transpile a Snowflake / T-SQL view, a DAX measure, or a Power BI / Fabric
 * report to a Loom artifact and review it SIDE-BY-SIDE (source vs generated)
 * with per-construct supported / needs-review badges. An unsupported construct
 * is shown needs-review with the exact reason — never a fabricated translation
 * (POST /api/migrate/translate; the transpilers reuse the A1/A2/A3 DAX parser +
 * fold and the N16 code-report parser). A supported artifact lands as a DRAFT
 * Loom item through the normal item-create path; a parseable DAX measure can be
 * emitted into the N9 semantic contract.
 *
 * IL5: the transpilers run fully in-boundary (pure parse/fold) — no SaaS call.
 */
import { useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import { SplitPane } from '@/lib/components/shared/split-pane';
import { listWorkspaces, createItem, updateItem, type Workspace } from '@/lib/api/workspaces';
import {
  makeStyles, tokens, Subtitle2, Caption1, Body1, Badge, Spinner, Dropdown, Option,
  Button, Input, Field, Textarea, MessageBar, MessageBarBody, MessageBarTitle, Tooltip, Divider,
} from '@fluentui/react-components';
import {
  CodeBlock20Regular, ArrowRight20Regular, CheckmarkCircle20Regular, Warning20Regular,
  DocumentArrowRight20Regular, DatabaseLink20Regular,
} from '@fluentui/react-icons';

type TranslateKind = 'sql-view' | 'stored-routine' | 'dax-measure' | 'report';

const KIND_LABELS: Record<TranslateKind, string> = {
  'sql-view': 'SQL view (Snowflake / T-SQL)',
  'stored-routine': 'Stored procedure / UDF',
  'dax-measure': 'DAX measure',
  report: 'Power BI / Fabric report',
};
const KINDS: TranslateKind[] = ['sql-view', 'stored-routine', 'dax-measure', 'report'];
const DIALECTS = [{ v: 'snowflake', l: 'Snowflake' }, { v: 'tsql', l: 'T-SQL / Fabric' }] as const;

interface ConstructFlag { construct: string; supported: boolean; reason: string; }
interface DraftItemPayload { itemType: string; displayName: string; description?: string; state: Record<string, unknown>; }
interface ArtifactTranslation {
  kind: TranslateKind;
  name: string;
  status: 'supported' | 'needs-review';
  language: 'sql' | 'dax' | 'code-report';
  source: string;
  generated: string | null;
  constructs: ConstructFlag[];
  reason: string;
  draftItem?: DraftItemPayload;
  metricDraft?: unknown;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  section: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4, minWidth: 0,
  },
  header: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 },
  form: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: tokens.spacingHorizontalM, minWidth: 0 },
  badgeRow: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0, alignItems: 'center' },
  code: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: '12px', whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere', margin: 0, height: '100%', overflow: 'auto',
    padding: tokens.spacingVerticalM, minWidth: 0,
  },
  diffWrap: { height: '360px', borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`, overflow: 'hidden', minWidth: 0 },
  paneHeader: {
    display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center',
    padding: tokens.spacingVerticalS, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  pane: { display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 },
  constructReason: { color: tokens.colorNeutralForeground3, fontSize: '12px', overflowWrap: 'anywhere' },
  reasonList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  inlineIcon: { verticalAlign: 'middle' },
  actions: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' },
});

const REPORT_PLACEHOLDER = `{
  "name": "Sales overview",
  "narrative": "Monthly sales by region.",
  "engine": "synapse",
  "queries": [
    { "name": "sales_by_region", "sql": "SELECT region, SUM(amount) AS total FROM sales GROUP BY region" }
  ],
  "visuals": [
    { "type": "bar", "query": "sales_by_region", "x": "region", "y": "total", "title": "Sales by region" }
  ]
}`;

export function TranslatePanel() {
  const styles = useStyles();
  const [kind, setKind] = useState<TranslateKind>('sql-view');
  const [name, setName] = useState('');
  const [dialect, setDialect] = useState<'snowflake' | 'tsql'>('snowflake');
  const [sql, setSql] = useState('');
  const [dax, setDax] = useState('');
  const [table, setTable] = useState('');
  const [reportJson, setReportJson] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<ArtifactTranslation | null>(null);

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdMsg, setCreatedMsg] = useState<string | null>(null);
  const [emitMsg, setEmitMsg] = useState<string | null>(null);

  useEffect(() => {
    listWorkspaces().then((ws) => {
      setWorkspaces(ws);
      if (ws[0]) setWorkspaceId(ws[0].id);
    }).catch(() => setWorkspaces([]));
  }, []);

  function buildArtifactBody() {
    const base: Record<string, unknown> = { kind, name: name.trim() || 'artifact' };
    if (kind === 'sql-view' || kind === 'stored-routine') { base.dialect = dialect; base.sql = sql; }
    else if (kind === 'dax-measure') { base.dax = dax; base.table = table.trim(); }
    else if (kind === 'report') {
      try { base.report = JSON.parse(reportJson || '{}'); }
      catch (e) { throw new Error(`Report definition is not valid JSON: ${(e as Error).message}`); }
    }
    return base;
  }

  async function runTranslate(commit = false) {
    setLoading(true); setError(null); setArtifact(null); setCreatedMsg(null); setEmitMsg(null);
    try {
      const body = { artifacts: [buildArtifactBody()], commit };
      const res = await clientFetch('/api/migrate/translate', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }, 60_000);
      const json = await res.json().catch(() => ({}));
      if (res.status === 503) { setError(json?.error || 'Code translation is turned off.'); return; }
      if (json?.ok === false || !json?.result) { setError(json?.error || `Translation failed (${res.status}).`); return; }
      const art = (json.result.artifacts?.[0] ?? null) as ArtifactTranslation | null;
      setArtifact(art);
      if (commit && Array.isArray(json.emitted)) {
        setEmitMsg(json.emitted.length
          ? `Emitted ${json.emitted.length} measure(s) into the semantic contract: ${json.emitted.map((e: { metricId: string }) => e.metricId).join(', ')}.`
          : 'No measures were emitted (only parseable DAX measures are eligible).');
      }
    } catch (e) {
      setError((e as Error)?.message || 'Translation failed.');
    } finally { setLoading(false); }
  }

  async function createDraft() {
    if (!artifact?.draftItem || !workspaceId) return;
    setCreating(true); setCreatedMsg(null); setError(null);
    try {
      const d = artifact.draftItem;
      const created = await createItem(workspaceId, { itemType: d.itemType, displayName: d.displayName, description: d.description });
      // Persist the generated body onto the new draft item's state.
      await updateItem(d.itemType, created.id, { state: { ...(created.state || {}), ...d.state } });
      const wsName = workspaces.find((w) => w.id === workspaceId)?.name || workspaceId;
      setCreatedMsg(`Created draft ${d.itemType} "${d.displayName}" in workspace "${wsName}".`);
    } catch (e) {
      setError(`Could not create the draft item: ${(e as Error)?.message || 'unknown error'}`);
    } finally { setCreating(false); }
  }

  const isSql = kind === 'sql-view' || kind === 'stored-routine';
  const canTranslate = !loading && (
    (isSql && sql.trim().length > 0) ||
    (kind === 'dax-measure' && dax.trim().length > 0) ||
    (kind === 'report' && reportJson.trim().length > 0)
  );

  return (
    <div className={styles.root}>
      <div className={styles.section}>
        <div className={styles.header}>
          <CodeBlock20Regular />
          <Subtitle2>Translate a source artifact</Subtitle2>
        </div>
        <div className={styles.form}>
          <Field label="Artifact type">
            <Dropdown
              value={KIND_LABELS[kind]} selectedOptions={[kind]} aria-label="Artifact type"
              onOptionSelect={(_, d) => setKind((d.optionValue as TranslateKind) || 'sql-view')}
            >
              {KINDS.map((k) => <Option key={k} value={k}>{KIND_LABELS[k]}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Artifact name">
            <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="e.g. vw_active_customers" />
          </Field>
          {isSql && (
            <Field label="Source dialect">
              <Dropdown
                value={DIALECTS.find((x) => x.v === dialect)?.l} selectedOptions={[dialect]} aria-label="Source dialect"
                onOptionSelect={(_, d) => setDialect((d.optionValue as 'snowflake' | 'tsql') || 'snowflake')}
              >
                {DIALECTS.map((x) => <Option key={x.v} value={x.v}>{x.l}</Option>)}
              </Dropdown>
            </Field>
          )}
          {kind === 'dax-measure' && (
            <Field label="Home table">
              <Input value={table} onChange={(_, d) => setTable(d.value)} placeholder="e.g. Sales" />
            </Field>
          )}
        </div>

        {isSql && (
          <Field label="Source SQL" hint="One or more ;-separated statements. Each is classified independently.">
            <Textarea value={sql} onChange={(_, d) => setSql(d.value)} rows={8}
              placeholder={"CREATE OR REPLACE VIEW active_customers AS\nSELECT id, NVL(name, 'n/a') AS name FROM customers WHERE active = TRUE"} />
          </Field>
        )}
        {kind === 'dax-measure' && (
          <Field label="DAX expression" hint="Validated with the A1 parser; probed for a loom-native SQL fold (A2/A3).">
            <Textarea value={dax} onChange={(_, d) => setDax(d.value)} rows={5}
              placeholder={'CALCULATE(SUM(Sales[Amount]))'} />
          </Field>
        )}
        {kind === 'report' && (
          <Field label="Report definition (queries + visuals)" hint="A structured report payload the reader enumerates from the PBIX; validated against the N16 code-report parser.">
            <Textarea value={reportJson} onChange={(_, d) => setReportJson(d.value)} rows={10} placeholder={REPORT_PLACEHOLDER} />
          </Field>
        )}

        <div className={styles.actions}>
          <Button appearance="primary" icon={loading ? <Spinner size="tiny" /> : <ArrowRight20Regular />}
            onClick={() => runTranslate(false)} disabled={!canTranslate}>
            Translate
          </Button>
          <Caption1 className={styles.constructReason}>
            An unsupported construct is flagged needs-review with the exact reason — never a fabricated translation.
          </Caption1>
        </div>
      </div>

      {error && (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody><MessageBarTitle>Translation error</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}

      {artifact && <ReviewDiff artifact={artifact} styles={styles}
        workspaces={workspaces} workspaceId={workspaceId} setWorkspaceId={setWorkspaceId}
        onCreateDraft={createDraft} creating={creating} createdMsg={createdMsg}
        onEmit={() => runTranslate(true)} emitMsg={emitMsg} />}
    </div>
  );
}

function ReviewDiff({
  artifact, styles, workspaces, workspaceId, setWorkspaceId, onCreateDraft, creating, createdMsg, onEmit, emitMsg,
}: {
  artifact: ArtifactTranslation;
  styles: ReturnType<typeof useStyles>;
  workspaces: Workspace[];
  workspaceId: string;
  setWorkspaceId: (v: string) => void;
  onCreateDraft: () => void;
  creating: boolean;
  createdMsg: string | null;
  onEmit: () => void;
  emitMsg: string | null;
}) {
  const supported = artifact.status === 'supported';
  const unsupportedConstructs = artifact.constructs.filter((c) => !c.supported);
  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <Subtitle2>Review diff — {artifact.name}</Subtitle2>
        <Badge appearance="tint" color={supported ? 'success' : 'warning'}
          icon={supported ? <CheckmarkCircle20Regular /> : <Warning20Regular />}>
          {supported ? 'supported' : 'needs-review'}
        </Badge>
      </div>

      <div className={styles.badgeRow}>
        {artifact.constructs.map((c, i) => (
          <Tooltip key={`${c.construct}-${i}`} content={c.reason} relationship="description">
            <Badge appearance="tint" color={c.supported ? 'success' : 'warning'}>{c.construct}</Badge>
          </Tooltip>
        ))}
      </div>
      {!supported && <MessageBar intent="warning" layout="multiline">
        <MessageBarBody><MessageBarTitle>Needs review</MessageBarTitle>{artifact.reason}</MessageBarBody>
      </MessageBar>}

      <div className={styles.diffWrap}>
        <SplitPane direction="horizontal" defaultSize="50%" minSize={160} storageKey="migrate-translate-diff" dividerLabel="Resize the diff panes">
          <div className={styles.pane}>
            <div className={styles.paneHeader}><Caption1>Source ({artifact.kind}{artifact.language === 'sql' ? '' : `, ${artifact.language}`})</Caption1></div>
            <pre className={styles.code}>{artifact.source || '(empty)'}</pre>
          </div>
          <div className={styles.pane}>
            <div className={styles.paneHeader}>
              <Caption1>Generated {artifact.language === 'code-report' ? 'code-report' : artifact.language === 'dax' ? 'loom-native SQL' : 'Loom SQL'}</Caption1>
            </div>
            <pre className={styles.code}>
              {artifact.generated ?? '— no confident translation — see the needs-review reasons above. The source is preserved verbatim; nothing was fabricated.'}
            </pre>
          </div>
        </SplitPane>
      </div>

      {/* Per-construct reason list (accessible, non-truncated). */}
      <div className={styles.reasonList}>
        {unsupportedConstructs.map((c, i) => (
          <Body1 key={`r-${i}`} className={styles.constructReason}>
            <Warning20Regular className={styles.inlineIcon} /> <strong>{c.construct}:</strong> {c.reason}
          </Body1>
        ))}
      </div>

      {(artifact.draftItem || artifact.metricDraft) ? <Divider /> : null}

      {artifact.draftItem && (
        <div className={styles.actions}>
          <Field label="Land as a draft in workspace" style={{ minWidth: '240px' }}>
            <Dropdown
              value={workspaces.find((w) => w.id === workspaceId)?.name || (workspaces.length ? '' : 'No workspaces')}
              selectedOptions={workspaceId ? [workspaceId] : []} aria-label="Target workspace"
              onOptionSelect={(_, d) => setWorkspaceId((d.optionValue as string) || '')} disabled={workspaces.length === 0}
            >
              {workspaces.map((w) => <Option key={w.id} value={w.id}>{w.name}</Option>)}
            </Dropdown>
          </Field>
          <Button appearance="primary" icon={creating ? <Spinner size="tiny" /> : <DocumentArrowRight20Regular />}
            onClick={onCreateDraft} disabled={creating || !workspaceId}>
            Create draft {artifact.draftItem.itemType}
          </Button>
        </div>
      )}
      {createdMsg && <MessageBar intent="success"><MessageBarBody>{createdMsg}</MessageBarBody></MessageBar>}

      {artifact.kind === 'dax-measure' && artifact.metricDraft ? (
        <div className={styles.actions}>
          <Button appearance="secondary" icon={<DatabaseLink20Regular />} onClick={onEmit}>
            Emit measure to the semantic contract (N9)
          </Button>
          <Caption1 className={styles.constructReason}>
            Registers the measure as a governed N9 metric (sourceRef = the original DAX, carried over verbatim).
          </Caption1>
        </div>
      ) : null}
      {emitMsg && <MessageBar intent="success"><MessageBarBody>{emitMsg}</MessageBarBody></MessageBar>}
    </div>
  );
}
