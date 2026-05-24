'use client';

/**
 * DeploymentPipelinesPane — 3-stage Dev / Test / Prod pipeline with
 * compare + deploy actions. Mirrors the Fabric deployment pipelines
 * UI described in inventory §2.7.
 */

import {
  Subtitle2, Body1, Caption1, Badge, Button,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Fragment } from 'react';
import { ArrowRight20Regular } from '@fluentui/react-icons';

const STAGES = [
  { name: 'Development', ws: 'fin-dev',  items: 47, changed: 6,  lastDeploy: '—' },
  { name: 'Test',        ws: 'fin-test', items: 47, changed: 2,  lastDeploy: '2026-05-22 14:30' },
  { name: 'Production',  ws: 'fin-prod', items: 45, changed: 0,  lastDeploy: '2026-05-15 09:00' },
];

const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: '1fr 32px 1fr 32px 1fr', alignItems: 'stretch', gap: 0 },
  stage: {
    padding: 16,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 8,
    backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex', flexDirection: 'column', gap: 8,
    minHeight: 200,
  },
  arrow: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: tokens.colorNeutralForeground3,
  },
  stat: { display: 'flex', justifyContent: 'space-between' },
  itemRow: { display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: `1px solid ${tokens.colorNeutralStroke3}` },
});

export function DeploymentPipelinesPane() {
  const s = useStyles();
  return (
    <div>
      <Subtitle2>fin-deployment-pipeline</Subtitle2>
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 16 }}>
        Promote items across stages with diff review. Loom auto-binds default-lakehouse and environment references across stages; configure per-item rules to override.
      </Body1>
      <div className={s.grid}>
        {STAGES.map((st, i) => (
          <Fragment key={st.name}>
            <div className={s.stage}>
              <Subtitle2>{st.name}</Subtitle2>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Workspace: {st.ws}</Caption1>
              <div className={s.stat}><Body1>Items</Body1><Body1>{st.items}</Body1></div>
              <div className={s.stat}><Body1>Changed vs next</Body1>{st.changed ? <Badge color="brand">{st.changed}</Badge> : <Caption1>—</Caption1>}</div>
              <div className={s.stat}><Body1>Last deploy</Body1><Caption1>{st.lastDeploy}</Caption1></div>
              <div style={{ marginTop: 'auto', display: 'flex', gap: 8 }}>
                <Button appearance="subtle" size="small">Compare</Button>
                {st.changed > 0 && <Button appearance="primary" size="small">Deploy →</Button>}
              </div>
            </div>
            {i < STAGES.length - 1 && <div className={s.arrow}><ArrowRight20Regular /></div>}
          </Fragment>
        ))}
      </div>
      <Subtitle2 style={{ marginTop: 24 }}>Changed items (Dev → Test)</Subtitle2>
      <div>
        {[
          { name: 'fact_sales (Lakehouse)', kind: 'Modified' },
          { name: 'CustomerSemantic (Semantic model)', kind: 'Modified' },
          { name: 'churn-model (ML model)', kind: 'New' },
          { name: 'nightly-orders-pipeline (Pipeline)', kind: 'Modified' },
          { name: 'orders-mirror (Mirrored DB)', kind: 'New' },
          { name: 'security-rules (Activator)', kind: 'Modified' },
        ].map((r) => (
          <div key={r.name} className={s.itemRow}>
            <Body1>{r.name}</Body1>
            <Badge appearance="outline" color={r.kind === 'New' ? 'success' : 'brand'}>{r.kind}</Badge>
          </div>
        ))}
      </div>
    </div>
  );
}
