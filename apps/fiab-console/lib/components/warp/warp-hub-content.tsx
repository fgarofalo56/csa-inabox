'use client';

/**
 * WarpHubContent — the shared body of the Warp experience: CSA Loom's unified
 * visual + code transform / pipeline builder.
 *
 * Warp is a BRANDED surface over three existing, production pillars (no new
 * engine — see csa_loom_weave_epic.md):
 *   - "Pipeline Builder" tab → the visual transform pillars: the Visual Query
 *     canvas (lib/editors/components/visual-query-canvas.tsx, compiled by
 *     lib/editors/visual-query-compiler.ts:compileGraph) plus the data-pipeline,
 *     Spark-job-definition, dataflow and Synapse-pipeline editors. Visual
 *     transforms emit and run real T-SQL / Spark SQL through
 *     /api/items/[type]/[id]/visual-query.
 *   - "Code Repos" tab → the dbt-job pillar: the medallion DAG generates a real
 *     dbt Core project (lib/dbt/dbt-codegen.ts) and runs it Azure-natively
 *     (Databricks Job dbt_task by default; loom-dbt-runner for Synapse/Fabric)
 *     via /api/items/dbt-job/[id]/run.
 *
 * Everything here is real (no-vaporware):
 *   - Recent items come from GET /api/experience/warp/home (Cosmos `items`).
 *   - Quick-create buttons are real <a> links to the actual /items/<slug>/new
 *     editors — no dead controls.
 *   - The "generated SQL" preview is produced live by the SAME pure compiler
 *     the canvas and the run route use (compileGraph), so it is a faithful
 *     demonstration of the canvas → SQL contract, not hard-coded sample text.
 *   - The Azure-native default path works with LOOM_DEFAULT_FABRIC_WORKSPACE
 *     unset (no Fabric dependency).
 */

import type React from 'react';
import { useEffect, useState } from 'react';
import {
  Spinner, Button, Text, Body1, Caption1,
  TabList, Tab,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Flow20Regular, Code20Regular, BranchFork20Regular, DatabaseLightning20Regular,
  Beaker20Regular, ArrowRight20Regular, Open16Regular,
} from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { SignInRequired } from '@/lib/components/sign-in-required';
import type { WarpItem } from '@/app/api/experience/warp/home/route';
import { WarpTransformCanvas, type WarpRunTarget, type WarpWorkspaceOption } from '@/lib/components/warp/warp-transform-canvas';

interface HomeData {
  ok: true;
  pipelines: WarpItem[];
  codeRepos: WarpItem[];
  counts: { pipelines: number; codeRepos: number; total: number };
}

interface TransformsData {
  targets: WarpRunTarget[];
  workspaces: WarpWorkspaceOption[];
}

type WarpTab = 'pipeline' | 'code';

const PIPELINE_CREATE: { slug: string; label: string; icon: React.JSX.Element }[] = [
  { slug: 'data-pipeline', label: 'New data pipeline', icon: <Flow20Regular /> },
  { slug: 'spark-job-definition', label: 'New Spark job', icon: <DatabaseLightning20Regular /> },
  { slug: 'dataflow', label: 'New dataflow', icon: <BranchFork20Regular /> },
];

const CODE_CREATE: { slug: string; label: string; icon: React.JSX.Element }[] = [
  { slug: 'dbt-job', label: 'New dbt project', icon: <Code20Regular /> },
];

const LEARNING_RESOURCES: { title: string; blurb: string; href: string }[] = [
  {
    title: 'Visual Query editor',
    blurb: 'Drag tables onto a canvas, add applied steps, and view the generated SQL.',
    href: 'https://learn.microsoft.com/fabric/data-warehouse/visual-query-editor',
  },
  {
    title: 'Databricks dbt task',
    blurb: 'Run a dbt project as a Databricks Job — the Warp Code Repos default.',
    href: 'https://learn.microsoft.com/azure/databricks/jobs/dbt',
  },
  {
    title: 'Spark job definition',
    blurb: 'Submit a Spark application (PY/JAR) against a Synapse Spark pool.',
    href: 'https://learn.microsoft.com/azure/data-factory/transform-data-synapse-spark-job-definition',
  },
  {
    title: 'dbt project structure',
    blurb: 'Sources, models, refs, materializations and tests — the dbt Core layout Warp emits.',
    href: 'https://docs.getdbt.com/docs/build/projects',
  },
];

const useStyles = makeStyles({
  hero: {
    display: 'flex',
    gap: tokens.spacingHorizontalXXL,
    alignItems: 'center',
    flexWrap: 'wrap',
    padding: tokens.spacingVerticalXL,
    borderRadius: tokens.borderRadiusXLarge,
    background: `linear-gradient(135deg, ${tokens.colorBrandBackground2} 0%, ${tokens.colorNeutralBackground1} 100%)`,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow2,
    marginBottom: tokens.spacingVerticalL,
  },
  heroText: { flex: 1, minWidth: '320px' },
  heroTitle: {
    fontSize: '24px', fontWeight: 700, lineHeight: 1.3,
    letterSpacing: '-0.01em', marginBottom: tokens.spacingVerticalS,
  },
  heroBody: {
    color: tokens.colorNeutralForeground2, fontSize: '14px',
    lineHeight: 1.55, maxWidth: '660px',
  },
  heroStats: { display: 'flex', gap: tokens.spacingHorizontalL, flexWrap: 'wrap' },
  heroStat: {
    display: 'flex', flexDirection: 'column',
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    minWidth: '120px',
    boxShadow: tokens.shadow4,
  },
  heroStatVal: {
    fontSize: '32px', fontWeight: 700,
    color: tokens.colorBrandForeground1, lineHeight: 1.1,
  },
  heroStatLabel: {
    fontSize: '12px', color: tokens.colorNeutralForeground3,
    marginTop: tokens.spacingVerticalXS,
  },
  quickRow: {
    display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap',
    marginBottom: tokens.spacingVerticalL,
  },
  empty: { color: tokens.colorNeutralForeground3 },
  learnGrid: {
    display: 'grid',
    gap: tokens.spacingHorizontalL,
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
  },
  learnCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    textDecoration: 'none',
    color: tokens.colorNeutralForeground1,
    transitionDuration: tokens.durationNormal,
    transitionProperty: 'box-shadow, transform, border-color',
    ':hover': {
      boxShadow: tokens.shadow8,
      transform: 'translateY(-2px)',
      border: `1px solid ${tokens.colorNeutralStroke1}`,
    },
  },
  learnTitle: {
    display: 'inline-flex', alignItems: 'center', gap: '6px',
    fontWeight: tokens.fontWeightSemibold,
  },
  spinnerWrap: { padding: tokens.spacingVerticalXXL, display: 'flex', justifyContent: 'center' },
});

function fmtWhen(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

export function WarpHubContent() {
  const s = useStyles();
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<WarpTab>('pipeline');
  const [transforms, setTransforms] = useState<TransformsData>({ targets: [], workspaces: [] });

  // Run targets + workspaces for the editable transform canvas (best-effort —
  // the canvas still builds/saves a graph even if these are empty).
  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch('/api/experience/warp/transforms').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/workspaces').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([t, ws]) => {
      if (!alive) return;
      const targets: WarpRunTarget[] = t?.ok && Array.isArray(t.targets) ? t.targets : [];
      const workspaces: WarpWorkspaceOption[] = Array.isArray(ws)
        ? ws.map((w: any) => ({ id: w.id, name: w.name || w.displayName || w.id }))
        : [];
      setTransforms({ targets, workspaces });
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch('/api/experience/warp/home')
      .then(async (r) => {
        if (r.status === 401 || r.status === 403) { if (alive) setUnauth(true); return null; }
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('application/json')) throw new Error(`Unexpected response (${r.status})`);
        const body = await r.json();
        if (!r.ok || !body?.ok) throw new Error(body?.error || `Request failed (${r.status})`);
        return body as HomeData;
      })
      .then((body) => { if (alive && body) setData(body); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  if (unauth) return <SignInRequired subject="your Warp transforms and pipelines" />;

  if (loading) {
    return <div className={s.spinnerWrap}><Spinner label="Loading Warp…" /></div>;
  }

  if (error) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>
          <MessageBarTitle>Couldn't load Warp</MessageBarTitle>
          {error}
        </MessageBarBody>
      </MessageBar>
    );
  }

  const d = data!;
  const createList = tab === 'pipeline' ? PIPELINE_CREATE : CODE_CREATE;
  const recent = tab === 'pipeline' ? d.pipelines : d.codeRepos;

  return (
    <div>
      {/* Hero band */}
      <div className={s.hero}>
        <div className={s.heroText}>
          <div className={s.heroTitle}>Warp</div>
          <Body1 className={s.heroBody}>
            One place to build data transforms — visually or in code — that emit and
            run real Spark / SQL. Draw a transform on the Pipeline Builder canvas and
            it compiles to T-SQL or Spark SQL; author a dbt project in Code Repos and
            it generates a real dbt Core project that runs on Databricks (default) or
            Synapse. Azure-native by default; no Microsoft Fabric capacity required.
          </Body1>
        </div>
        <div className={s.heroStats}>
          <div className={s.heroStat}>
            <div className={s.heroStatVal}>{d.counts.pipelines}</div>
            <div className={s.heroStatLabel}>recent pipelines</div>
          </div>
          <div className={s.heroStat}>
            <div className={s.heroStatVal}>{d.counts.codeRepos}</div>
            <div className={s.heroStatLabel}>recent code repos</div>
          </div>
        </div>
      </div>

      {/* Pillar tabs */}
      <TabList
        selectedValue={tab}
        onTabSelect={(_, data2) => setTab(data2.value as WarpTab)}
        style={{ marginBottom: tokens.spacingVerticalL }}
      >
        <Tab value="pipeline" icon={<Flow20Regular />}>Pipeline Builder</Tab>
        <Tab value="code" icon={<Code20Regular />}>Code Repos</Tab>
      </TabList>

      {/* Quick-create */}
      <div className={s.quickRow}>
        {createList.map((c, i) => (
          <Button
            key={c.slug}
            as="a"
            href={`/items/${c.slug}/new`}
            appearance={i === 0 ? 'primary' : 'secondary'}
            icon={c.icon}
          >
            {c.label}
          </Button>
        ))}
        {tab === 'pipeline' && (
          <Button as="a" href="/items/notebook/new" appearance="secondary" icon={<Beaker20Regular />}>
            New notebook
          </Button>
        )}
      </div>

      {/* Pipeline Builder: the editable visual transform canvas. Build a
          Source → Transform → Sink graph, configure each node with guided
          controls, and Validate / Preview / Run against a real Azure-native
          SQL engine. The graph compiles live to T-SQL / Spark SQL (Code tab)
          and saves to Cosmos. */}
      {tab === 'pipeline' && (
        <Section
          title="Visual transform builder"
          actions={
            <Button
              size="small"
              appearance="subtle"
              as="a"
              href="/browse?type=data-pipeline"
              icon={<ArrowRight20Regular />}
              iconPosition="after"
            >
              Open in a data pipeline
            </Button>
          }
        >
          <Body1 style={{ color: tokens.colorNeutralForeground2, marginBottom: tokens.spacingVerticalM, display: 'block' }}>
            Build a transform on the canvas — add a source, chain steps (filter,
            select, derive, aggregate, join, union, rename, cast, dedup, sort),
            and land it in a sink. Pick a run target and Validate / Preview / Run
            against a live Synapse or Databricks backend. The Code tab shows the
            generated SQL. Azure-native by default; no Microsoft Fabric required.
          </Body1>
          <WarpTransformCanvas targets={transforms.targets} workspaces={transforms.workspaces} />
        </Section>
      )}

      {/* Recent items for the active pillar */}
      <Section
        title={tab === 'pipeline' ? 'Recent pipelines & transforms' : 'Recent code repos'}
        actions={
          <Button
            as="a"
            href={tab === 'pipeline' ? '/browse?type=data-pipeline' : '/browse?type=dbt-job'}
            appearance="subtle"
            size="small"
            icon={<ArrowRight20Regular />}
            iconPosition="after"
          >
            View all
          </Button>
        }
      >
        {recent.length === 0 ? (
          <Text className={s.empty}>
            {tab === 'pipeline'
              ? 'No pipelines or transforms yet. Use the quick-create buttons above to author your first one.'
              : 'No dbt projects yet. Create one above — the medallion canvas generates a real dbt Core project and runs it on Databricks.'}
          </Text>
        ) : (
          <TileGrid minTileWidth={260}>
            {recent.map((it) => (
              <ItemTile
                key={it.id}
                type={it.itemType}
                title={it.displayName}
                subtitle={it.itemType}
                meta={it.updatedAt ? `Modified ${fmtWhen(it.updatedAt)}` : undefined}
                onClick={() => { window.location.href = `/items/${it.itemType}/${it.id}`; }}
              />
            ))}
          </TileGrid>
        )}
      </Section>

      {/* Learning resources — curated reference links (not live data). */}
      <Section title="Learning resources">
        <div className={s.learnGrid}>
          {LEARNING_RESOURCES.map((r) => (
            <a
              key={r.href}
              className={s.learnCard}
              href={r.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className={s.learnTitle}>
                {r.title} <Open16Regular />
              </span>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{r.blurb}</Caption1>
            </a>
          ))}
        </div>
      </Section>
    </div>
  );
}

export default WarpHubContent;
