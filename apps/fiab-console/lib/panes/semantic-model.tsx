'use client';

/**
 * SemanticModelWorkspacePane — workspace-level deploy surface for the
 * /semantic-model page.
 *
 * Lists the REAL tabular databases on the env-pinned Azure Analysis Services
 * server (fetched from GET /api/items/semantic-model/workspace-pane, backed by
 * listDatabases() → ARM api-version 2017-08-01) plus the tenant's Loom-native
 * semantic-model items, and lets the operator deploy a model's TMSL to the live
 * tabular engine.
 *
 * NO HARD-CODED TABLE LIST. The database <Select> is seeded from `useState([])`
 * and populated only from the real fetch — there is no `initialTables` array.
 * The Deploy button posts { action:'deploy', modelId, database } to the same
 * route, which runs the real XMLA write (executeAasXmla) or, opt-in, the Fabric
 * REST writeback (updateFabricSemanticModelTmsl). Per
 * .claude/rules/no-fabric-dependency.md the Azure-native path is the default;
 * per .claude/rules/no-vaporware.md the button calls a real backend (or, when no
 * writeback is configured, is hidden behind an honest infra-gate MessageBar —
 * never a dead control).
 *
 * GCC-High / DoD: AAS is not an Azure Government service. The pane renders the
 * Loom-native model list with an honest "not available in <cloud>" MessageBar
 * and HIDES the Deploy controls (not a disabled button with a false tooltip).
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  makeStyles, shorthands, tokens, Title2, Subtitle2, Caption1, Body1,
  Badge, Button, Select, Spinner, Divider, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle,
} from '@fluentui/react-components';
import {
  Database20Regular, CloudArrowUp20Regular, Table20Regular,
  DatabaseStack16Regular,
} from '@fluentui/react-icons';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { EmptyState } from '@/lib/components/empty-state';

interface AasDatabaseLite {
  name: string;
  storageMode?: string;
  state?: string;
  compatibilityLevel?: number;
}
interface LoomModelLite {
  id: string;
  name: string;
  tableCount: number;
}
interface DeployCapability {
  backend: 'aas-xmla' | 'fabric' | 'unavailable';
  available: boolean;
  hint?: string;
}
interface PaneGate {
  kind: 'config' | 'unavailable' | 'error';
  missing: string;
  detail?: string;
}
interface PaneResponse {
  ok: boolean;
  serverName: string;
  region: string;
  aasDatabases: AasDatabaseLite[];
  loomModels: LoomModelLite[];
  deploy: DeployCapability;
  gate?: PaneGate;
  error?: string;
  status: number;
}
interface DeployResult {
  ok: boolean;
  backend?: string;
  database?: string;
  workspaceId?: string;
  error?: string;
  deployUnavailable?: boolean;
  hint?: string;
  tmslApplied?: boolean;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, height: '100%' },
  loading: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minHeight: '240px',
  },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  spacer: { flex: 1 },
  card: {
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
    paddingTop: tokens.spacingVerticalL, paddingRight: tokens.spacingHorizontalXL, paddingBottom: tokens.spacingVerticalL, paddingLeft: tokens.spacingHorizontalXL,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  cardIcon: {
    fontSize: '20px', color: tokens.colorBrandForeground1,
    display: 'flex', alignItems: 'center',
  },
  cardCount: { marginLeft: 'auto' },
  deployRow: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: '220px' },
  fieldLabel: { color: tokens.colorNeutralForeground2, fontWeight: 600 },
  dbGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: '10px',
  },
  dbTile: {
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    paddingTop: '12px', paddingRight: '14px', paddingBottom: '12px', paddingLeft: '14px',
    display: 'flex', flexDirection: 'column', gap: '6px',
    transitionProperty: 'box-shadow, border-color, transform',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': {
      ...shorthands.borderColor(tokens.colorBrandStroke1),
      boxShadow: tokens.shadow4,
    },
  },
  dbName: {
    display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  tileIcon: { color: tokens.colorBrandForeground1, display: 'flex', flexShrink: 0 },
  badgeRow: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
  meta: { color: tokens.colorNeutralForeground3 },
});

async function fetchPane(): Promise<PaneResponse> {
  const res = await fetch('/api/items/semantic-model/workspace-pane', { cache: 'no-store' });
  const json = await res.json().catch(() => ({}));
  return { ...json, status: res.status };
}

async function deployModel(body: { modelId: string; database: string }): Promise<DeployResult> {
  const res = await fetch('/api/items/semantic-model/workspace-pane', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'deploy', ...body }),
  });
  const json = (await res.json().catch(() => ({}))) as DeployResult;
  return json;
}

export function SemanticModelWorkspacePane() {
  const styles = useStyles();
  const { data, isLoading } = useQuery({ queryKey: ['sm-workspace-pane'], queryFn: fetchPane });

  const databases = useMemo<AasDatabaseLite[]>(() => data?.aasDatabases ?? [], [data]);
  const loomModels = useMemo<LoomModelLite[]>(() => data?.loomModels ?? [], [data]);

  // Database picker selection. Seeded EMPTY — never from a hard-coded list — and
  // synced to the first real database once the fetch resolves.
  const [selectedDb, setSelectedDb] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<string>('');

  useEffect(() => {
    if (!selectedDb && databases.length > 0) setSelectedDb(databases[0].name);
  }, [databases, selectedDb]);
  useEffect(() => {
    if (!selectedModel && loomModels.length > 0) setSelectedModel(loomModels[0].id);
  }, [loomModels, selectedModel]);

  const deploy = useMutation({ mutationFn: deployModel });

  if (isLoading) {
    return (
      <div className={styles.loading}>
        <Spinner size="medium" label="Loading semantic models…" />
      </div>
    );
  }
  if (data && data.status === 401) return <SignInRequired subject="semantic models" />;
  if (!data || !data.ok) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>
          <MessageBarTitle>Could not load semantic models</MessageBarTitle>
          {data?.error ?? 'unknown error'}
        </MessageBarBody>
      </MessageBar>
    );
  }

  const gate = data.gate;
  const govUnavailable = gate?.kind === 'unavailable';
  const deployable = data.deploy?.available && !govUnavailable;
  const result = deploy.data;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Title2>Semantic models</Title2>
        <div className={styles.spacer} />
        {data.serverName && (
          <Tooltip
            relationship="label"
            content={`Env-pinned Azure Analysis Services server${data.region ? ` in ${data.region}` : ''}`}
          >
            <Badge appearance="tint" color="brand" icon={<Database20Regular />}>
              {data.serverName}{data.region ? ` · ${data.region}` : ''}
            </Badge>
          </Tooltip>
        )}
      </div>

      {/* Honest gates — never a fabricated list. */}
      {gate?.kind === 'config' && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Azure Analysis Services not configured</MessageBarTitle>
            Set {gate.missing} to list and deploy to live tabular databases. {gate.detail}
            {' '}Loom-native models below still work without any tabular server.
          </MessageBarBody>
        </MessageBar>
      )}
      {gate?.kind === 'unavailable' && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Tabular deploy not available in this cloud</MessageBarTitle>
            {gate.detail}
          </MessageBarBody>
        </MessageBar>
      )}
      {gate?.kind === 'error' && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not list Analysis Services databases</MessageBarTitle>
            {gate.detail}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Live AAS databases — real ARM listDatabases() result, never hard-coded. */}
      {!govUnavailable && databases.length > 0 && (
        <div className={styles.card}>
          <div className={styles.cardHead}>
            <span className={styles.cardIcon}><Database20Regular /></span>
            <Subtitle2>Tabular databases on {data.serverName}</Subtitle2>
            <Badge className={styles.cardCount} appearance="tint" color="informative" size="small">
              {databases.length}
            </Badge>
          </div>
          <div className={styles.dbGrid} role="list" aria-label="Tabular databases">
            {databases.map((db) => (
              <div key={db.name} className={styles.dbTile} role="listitem">
                <div className={styles.dbName}>
                  <span className={styles.tileIcon}><DatabaseStack16Regular /></span> {db.name}
                </div>
                <div className={styles.badgeRow}>
                  {db.storageMode && (
                    <Badge size="small" appearance="outline" color="informative">{db.storageMode}</Badge>
                  )}
                  {db.state && (
                    <Badge size="small" appearance="tint" color={/succeed/i.test(db.state) ? 'success' : 'subtle'}>
                      {db.state}
                    </Badge>
                  )}
                  {typeof db.compatibilityLevel === 'number' && (
                    <Badge size="small" appearance="outline" color="subtle">CL {db.compatibilityLevel}</Badge>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Deploy surface — real XMLA / Fabric writeback. Hidden (not a dead,
          disabled control) when no live writeback backend is configured. */}
      {deployable ? (
        <div className={styles.card}>
          <div className={styles.cardHead}>
            <span className={styles.cardIcon}><CloudArrowUp20Regular /></span>
            <Subtitle2>Deploy a model to the tabular engine</Subtitle2>
          </div>
          <Caption1 className={styles.meta}>
            Builds the model.bim TMSL from the model&apos;s stored tables + relationships and applies it via{' '}
            {data.deploy.backend === 'fabric' ? 'the Fabric REST updateDefinition API (opt-in).' : 'the Azure Analysis Services XMLA endpoint.'}
          </Caption1>
          <div className={styles.deployRow}>
            <div className={styles.field}>
              <Caption1 className={styles.fieldLabel}>Model</Caption1>
              <Select
                aria-label="Semantic model to deploy"
                value={selectedModel}
                onChange={(_e, d) => setSelectedModel(d.value)}
                disabled={loomModels.length === 0}
              >
                {loomModels.length === 0 && <option value="">No Loom-native models in this tenant</option>}
                {loomModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.name} ({m.tableCount} tables)</option>
                ))}
              </Select>
            </div>
            {data.deploy.backend === 'aas-xmla' && (
              <div className={styles.field}>
                <Caption1 className={styles.fieldLabel}>Target database</Caption1>
                <Select
                  aria-label="Target tabular database"
                  value={selectedDb}
                  onChange={(_e, d) => setSelectedDb(d.value)}
                >
                  {databases.length === 0 && <option value="">Use the model name as the catalog</option>}
                  {databases.map((db) => (
                    <option key={db.name} value={db.name}>{db.name}</option>
                  ))}
                </Select>
              </div>
            )}
            <Button
              appearance="primary"
              icon={<CloudArrowUp20Regular />}
              disabled={!selectedModel || deploy.isPending}
              onClick={() => deploy.mutate({ modelId: selectedModel, database: selectedDb })}
            >
              {deploy.isPending ? 'Deploying…' : 'Deploy'}
            </Button>
          </div>

          {result && result.ok && (
            <MessageBar intent="success">
              <MessageBarBody>
                <MessageBarTitle>Model deployed</MessageBarTitle>
                TMSL applied via {result.backend}
                {result.database ? ` to database ${result.database}` : ''}
                {result.workspaceId ? ` in workspace ${result.workspaceId}` : ''}.
              </MessageBarBody>
            </MessageBar>
          )}
          {result && !result.ok && (
            <MessageBar intent={result.deployUnavailable ? 'warning' : 'error'}>
              <MessageBarBody>
                <MessageBarTitle>{result.deployUnavailable ? 'Deploy not configured' : 'Deploy failed'}</MessageBarTitle>
                {result.hint || result.error || 'unknown error'}
              </MessageBarBody>
            </MessageBar>
          )}
          {deploy.isError && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Deploy request failed</MessageBarTitle>
                {(deploy.error as Error)?.message || String(deploy.error)}
              </MessageBarBody>
            </MessageBar>
          )}
        </div>
      ) : (
        !govUnavailable && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Live deploy not configured</MessageBarTitle>
              {data.deploy?.hint
                ?? 'Set LOOM_AAS_XMLA_ENDPOINT (Azure-native default) or LOOM_SEMANTIC_MODEL_BACKEND=fabric (opt-in) to deploy. Model structure is stored with each item and emitted as TMSL at provision time.'}
            </MessageBarBody>
          </MessageBar>
        )
      )}

      <Divider />

      {/* Loom-native model inventory — always available (no-Fabric default). */}
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <span className={styles.cardIcon}><Table20Regular /></span>
          <Subtitle2>Loom-native models</Subtitle2>
          {loomModels.length > 0 && (
            <Badge className={styles.cardCount} appearance="tint" color="brand" size="small">
              {loomModels.length}
            </Badge>
          )}
        </div>
        {loomModels.length === 0 ? (
          <EmptyState
            icon={<Table20Regular />}
            title="No Loom-native semantic models yet"
            body="Loom-native models work without any tabular server. Create a semantic model item to define tables, measures, and relationships — then deploy it to the tabular engine from here."
          />
        ) : (
          <div className={styles.dbGrid} role="list" aria-label="Loom-native semantic models">
            {loomModels.map((m) => (
              <div key={m.id} className={styles.dbTile} role="listitem">
                <div className={styles.dbName}>
                  <span className={styles.tileIcon}><Table20Regular /></span> {m.name}
                </div>
                <Caption1 className={styles.meta}>{m.tableCount} {m.tableCount === 1 ? 'table' : 'tables'}</Caption1>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
