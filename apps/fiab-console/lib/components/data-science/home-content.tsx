'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * DataScienceHomeContent — the shared body of the Data Science experience
 * landing surface. Rendered both by the top-level experience page
 * (/experience/data-science/home, wrapped in PageShell) and by the
 * data-science-home editor (wrapped in ItemEditorChrome).
 *
 * Everything here is real (no-vaporware):
 *   - Recent notebooks / experiments / models come from
 *     GET /api/items/data-science/home (Cosmos + live Azure ML ARM).
 *   - Quick-create buttons are real <a> links to the notebook / ML-experiment
 *     / ML-model editors — no dead controls.
 *   - When Azure ML isn't wired, an HONEST infra-gate MessageBar names the
 *     exact env vars + role; the rest of the surface still renders.
 *   - The Learning Resources strip is explicitly labelled curated reference
 *     links (stable Microsoft Learn URLs), not live workspace data.
 */

import { useEffect, useState } from 'react';
import { shorthands,
  Spinner, Button, Badge, Text, Body1, Caption1,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Notebook20Regular, Beaker20Regular, BrainCircuit20Regular,
  Open16Regular, ArrowRight20Regular,
} from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { SignInRequired } from '@/lib/components/sign-in-required';
import type {
  DsNotebook, DsExperiment, DsModel,
} from '@/app/api/items/data-science/home/route';

interface HomeData {
  ok: true;
  amlConfigured: boolean;
  amlHint?: string;
  notebooks: DsNotebook[];
  experiments: DsExperiment[];
  models: DsModel[];
  counts: { notebooks: number; experiments: number; models: number };
}

const LEARNING_RESOURCES: { title: string; blurb: string; href: string }[] = [
  { title: 'Train a model', blurb: 'Build and run a training job on Azure Machine Learning compute.',
    href: 'https://learn.microsoft.com/azure/machine-learning/how-to-train-model' },
  { title: 'Track runs with MLflow', blurb: 'Log metrics, params and artifacts from any experiment.',
    href: 'https://learn.microsoft.com/azure/machine-learning/how-to-use-mlflow-cli-runs' },
  { title: 'Register a model', blurb: 'Version models in the workspace registry with MLflow.',
    href: 'https://learn.microsoft.com/azure/machine-learning/how-to-manage-models' },
  { title: 'Deploy an online endpoint', blurb: 'Serve a registered model for low-latency scoring.',
    href: 'https://learn.microsoft.com/azure/machine-learning/concept-endpoints-online' },
  { title: 'Automated ML', blurb: 'Let AutoML search models and hyperparameters for you.',
    href: 'https://learn.microsoft.com/azure/machine-learning/concept-automated-ml' },
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
    lineHeight: 1.55, maxWidth: '640px',
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
    display: 'flex', flexDirection: 'column', gap: '4px',
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
      ...shorthands.borderColor(tokens.colorNeutralStroke1),
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

export function DataScienceHomeContent() {
  const s = useStyles();
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    clientFetch('/api/items/data-science/home')
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

  if (unauth) return <SignInRequired subject="your Data Science items" />;

  if (loading) {
    return <div className={s.spinnerWrap}><Spinner label="Loading Data Science home…" /></div>;
  }

  if (error) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>
          <MessageBarTitle>Couldn't load the Data Science home</MessageBarTitle>
          {error}
        </MessageBarBody>
      </MessageBar>
    );
  }

  const d = data!;

  return (
    <div>
      {/* Honest Azure infra-gate — non-blocking; the surface still renders. */}
      {!d.amlConfigured && d.amlHint && (
        <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalL }}>
          <MessageBarBody>
            <MessageBarTitle>Azure Machine Learning isn't connected</MessageBarTitle>
            {d.amlHint}
          </MessageBarBody>
          <MessageBarActions>
            <Button
              size="small"
              as="a"
              href="https://learn.microsoft.com/azure/machine-learning/how-to-manage-workspace"
              target="_blank"
              rel="noopener noreferrer"
            >
              Workspace setup docs
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}

      {/* Hero band */}
      <div className={s.hero}>
        <div className={s.heroText}>
          <div className={s.heroTitle}>Data Science</div>
          <Body1 className={s.heroBody}>
            Notebooks, experiments and models — powered by Azure Machine Learning.
            Author notebooks against Synapse Spark or Databricks compute, track
            experiment runs, and register models to the workspace registry, all
            from one place.
          </Body1>
        </div>
        <div className={s.heroStats}>
          <div className={s.heroStat}>
            <div className={s.heroStatVal}>{d.counts.notebooks}</div>
            <div className={s.heroStatLabel}>recent notebooks</div>
          </div>
          <div className={s.heroStat}>
            <div className={s.heroStatVal}>{d.counts.experiments}</div>
            <div className={s.heroStatLabel}>recent experiments</div>
          </div>
          <div className={s.heroStat}>
            <div className={s.heroStatVal}>{d.counts.models}</div>
            <div className={s.heroStatLabel}>recent models</div>
          </div>
        </div>
      </div>

      {/* Quick-create */}
      <div className={s.quickRow}>
        <Button as="a" href="/items/notebook/new" appearance="primary" icon={<Notebook20Regular />}>
          New notebook
        </Button>
        <Button as="a" href="/items/ml-experiment/new" appearance="secondary" icon={<Beaker20Regular />}>
          New experiment
        </Button>
        <Button as="a" href="/items/ml-model/new" appearance="secondary" icon={<BrainCircuit20Regular />}>
          Register model
        </Button>
      </div>

      {/* Recent notebooks */}
      <Section
        title="Recent notebooks"
        actions={
          <Button as="a" href="/browse?type=notebook" appearance="subtle" size="small"
            icon={<ArrowRight20Regular />} iconPosition="after">
            View all
          </Button>
        }
      >
        {d.notebooks.length === 0 ? (
          <Text className={s.empty}>
            No notebooks yet. Use “New notebook” above to author your first one.
          </Text>
        ) : (
          <TileGrid minTileWidth={260}>
            {d.notebooks.map((n) => (
              <ItemTile
                key={n.id}
                type={n.itemType}
                title={n.displayName}
                subtitle="Notebook"
                meta={n.updatedAt ? `Modified ${fmtWhen(n.updatedAt)}` : undefined}
                onClick={() => { window.location.href = `/items/${n.itemType}/${n.id}`; }}
              />
            ))}
          </TileGrid>
        )}
      </Section>

      {/* Recent experiments */}
      <Section
        title="Recent experiments"
        actions={
          <Button as="a" href="/items/ml-experiment/new" appearance="subtle" size="small"
            icon={<ArrowRight20Regular />} iconPosition="after">
            New experiment
          </Button>
        }
      >
        {d.experiments.length === 0 ? (
          <Text className={s.empty}>
            {d.amlConfigured
              ? 'No experiment runs found in the connected Azure ML workspace yet.'
              : 'Connect Azure Machine Learning (above) to see experiment runs.'}
          </Text>
        ) : (
          <TileGrid minTileWidth={260}>
            {d.experiments.map((e) => (
              <ItemTile
                key={e.name}
                type="ml-experiment"
                title={e.displayName || e.name}
                subtitle={e.experimentName || e.jobType || 'Run'}
                meta={
                  <span style={{ display: 'inline-flex', gap: tokens.spacingHorizontalSNudge, alignItems: 'center' }}>
                    {e.status && <Badge appearance="tint" size="small">{e.status}</Badge>}
                    {e.startTimeUtc && <Caption1>{fmtWhen(e.startTimeUtc)}</Caption1>}
                  </span>
                }
                onClick={() => { window.location.href = `/items/ml-experiment/${encodeURIComponent(e.name)}`; }}
              />
            ))}
          </TileGrid>
        )}
      </Section>

      {/* Recent model registrations */}
      <Section
        title="Recent model registrations"
        actions={
          <Button as="a" href="/items/ml-model/new" appearance="subtle" size="small"
            icon={<ArrowRight20Regular />} iconPosition="after">
            Register model
          </Button>
        }
      >
        {d.models.length === 0 ? (
          <Text className={s.empty}>
            {d.amlConfigured
              ? 'No registered models found in the connected Azure ML workspace yet.'
              : 'Connect Azure Machine Learning (above) to see registered models.'}
          </Text>
        ) : (
          <TileGrid minTileWidth={260}>
            {d.models.map((m) => (
              <ItemTile
                key={m.name}
                type="ml-model"
                title={m.name}
                subtitle={m.description || 'Registered model'}
                meta={
                  <span style={{ display: 'inline-flex', gap: tokens.spacingHorizontalSNudge, alignItems: 'center' }}>
                    {m.latestVersion && <Badge appearance="tint" size="small">v{m.latestVersion}</Badge>}
                    {m.createdAt && <Caption1>{fmtWhen(m.createdAt)}</Caption1>}
                  </span>
                }
                onClick={() => { window.location.href = `/items/ml-model/${encodeURIComponent(m.name)}`; }}
              />
            ))}
          </TileGrid>
        )}
      </Section>

      {/* Learning Resources — curated reference links (not live data). */}
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

export default DataScienceHomeContent;
