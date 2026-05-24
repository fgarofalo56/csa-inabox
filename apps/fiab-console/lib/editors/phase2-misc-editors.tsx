'use client';

/**
 * Simple form-style editors for the remaining Phase 2 item types.
 * Spark job definition, Environment, Copy job, dbt job. Each renders
 * a realistic Fluent UI form layout — the heavy lift (real runs, real
 * scheduling) lives in later iterations.
 */

import {
  Subtitle2, Body1, Caption1, Input, Dropdown, Option, Button, Badge,
  Tab, TabList,
  Textarea,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { useState } from 'react';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  form: { padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '720px' },
  row: { display: 'flex', gap: '12px' },
  field: { flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' },
  tabBar: { padding: '8px 16px 0', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  tabBody: { padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px' },
});

const SPARK_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Run', actions: [{ label: 'Submit' }, { label: 'Stop' }, { label: 'Schedule' }] },
    { label: 'Files', actions: [{ label: 'Upload main file' }, { label: 'Upload library' }] },
  ]},
];

export function SparkJobDefinitionEditor({ item, id }: { item: FabricItemType; id: string }) {
  const styles = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={SPARK_RIBBON} main={
      <div className={styles.form}>
        <Subtitle2>Job configuration</Subtitle2>
        <div className={styles.row}>
          <div className={styles.field}>
            <Caption1>Language</Caption1>
            <Dropdown defaultValue="Python" defaultSelectedOptions={['Python']}>
              <Option>Python</Option><Option>Scala</Option><Option>R</Option><Option>Java</Option>
            </Dropdown>
          </div>
          <div className={styles.field}>
            <Caption1>Main class</Caption1>
            <Input placeholder="com.example.Main (Scala/Java only)" />
          </div>
        </div>
        <div className={styles.field}>
          <Caption1>Executable file (main.py / *.jar)</Caption1>
          <Input placeholder="abfss://files@onelake.dfs.fabric.microsoft.com/jobs/main.py" />
        </div>
        <div className={styles.field}>
          <Caption1>Command-line arguments</Caption1>
          <Input placeholder="--input gold/sales --output gold/sales_agg" />
        </div>
        <div className={styles.field}>
          <Caption1>Default lakehouse</Caption1>
          <Dropdown defaultValue="ldn-gold-lakehouse" defaultSelectedOptions={['ldn-gold-lakehouse']}>
            <Option>ldn-gold-lakehouse</Option><Option>raw-lakehouse</Option>
          </Dropdown>
        </div>
        <div className={styles.field}>
          <Caption1>Environment</Caption1>
          <Dropdown defaultValue="prod-spark-3.5" defaultSelectedOptions={['prod-spark-3.5']}>
            <Option>prod-spark-3.5</Option><Option>dev-spark-3.5</Option>
          </Dropdown>
        </div>
        <Button appearance="primary" style={{ alignSelf: 'flex-start', marginTop: 8 }}>Submit job</Button>
      </div>
    } />
  );
}

const ENV_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Publish', actions: [{ label: 'Save' }, { label: 'Publish' }] },
    { label: 'Compute', actions: [{ label: 'Spark settings' }, { label: 'Pool' }] },
  ]},
];

export function EnvironmentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const styles = useStyles();
  const [tab, setTab] = useState('spark');
  return (
    <ItemEditorChrome item={item} id={id} ribbon={ENV_RIBBON} main={
      <>
        <div className={styles.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
            <Tab value="spark">Spark settings</Tab>
            <Tab value="public">Public libraries</Tab>
            <Tab value="custom">Custom libraries</Tab>
            <Tab value="resources">Resources</Tab>
          </TabList>
        </div>
        <div className={styles.tabBody}>
          {tab === 'spark' && (<>
            <Subtitle2>Spark properties</Subtitle2>
            <div className={styles.row}>
              <div className={styles.field}><Caption1>Driver cores</Caption1><Input defaultValue="8" /></div>
              <div className={styles.field}><Caption1>Driver memory</Caption1><Input defaultValue="56 GB" /></div>
            </div>
            <div className={styles.row}>
              <div className={styles.field}><Caption1>Executor cores</Caption1><Input defaultValue="8" /></div>
              <div className={styles.field}><Caption1>Executor memory</Caption1><Input defaultValue="56 GB" /></div>
            </div>
            <div className={styles.field}><Caption1>Runtime version</Caption1><Input defaultValue="Spark 3.5 / Delta 3.2" /></div>
          </>)}
          {tab === 'public' && (<>
            <Subtitle2>Public libraries (PyPI)</Subtitle2>
            <Body1>pandas==2.2.2, scikit-learn==1.4.2, plotly==5.22, mlflow==2.13.0</Body1>
            <Button appearance="primary" style={{ alignSelf: 'flex-start' }}>Add from PyPI</Button>
          </>)}
          {tab === 'custom' && (<>
            <Subtitle2>Custom libraries (.whl, .jar)</Subtitle2>
            <Body1>No custom libraries yet.</Body1>
            <Button appearance="primary" style={{ alignSelf: 'flex-start' }}>Upload</Button>
          </>)}
          {tab === 'resources' && (<>
            <Subtitle2>Files & resources</Subtitle2>
            <Body1>Upload reference data, config files, or models packaged with this environment.</Body1>
          </>)}
        </div>
      </>
    } />
  );
}

const COPY_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Configure', actions: [{ label: 'Source' }, { label: 'Destination' }, { label: 'Mapping' }] },
    { label: 'Run', actions: [{ label: 'Run now' }, { label: 'Schedule' }] },
  ]},
];

export function CopyJobEditor({ item, id }: { item: FabricItemType; id: string }) {
  const styles = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={COPY_RIBBON} main={
      <div className={styles.form}>
        <Subtitle2>Source</Subtitle2>
        <div className={styles.field}>
          <Caption1>Connector</Caption1>
          <Dropdown defaultValue="Azure Blob Storage" defaultSelectedOptions={['Azure Blob Storage']}>
            <Option>Azure Blob Storage</Option><Option>ADLS Gen2</Option><Option>SQL Server</Option><Option>Snowflake</Option><Option>Amazon S3</Option>
          </Dropdown>
        </div>
        <div className={styles.field}>
          <Caption1>Path</Caption1>
          <Input placeholder="https://store.blob.core.windows.net/raw/orders/*.csv" />
        </div>
        <Subtitle2 style={{ marginTop: 8 }}>Destination</Subtitle2>
        <div className={styles.field}>
          <Caption1>Target lakehouse / warehouse</Caption1>
          <Dropdown defaultValue="ldn-bronze-lakehouse" defaultSelectedOptions={['ldn-bronze-lakehouse']}>
            <Option>ldn-bronze-lakehouse</Option><Option>fin-warehouse</Option>
          </Dropdown>
        </div>
        <Badge appearance="outline" color="success" style={{ alignSelf: 'flex-start' }}>Ready to run</Badge>
      </div>
    } />
  );
}

const DBT_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Run', actions: [{ label: 'Run all' }, { label: 'Run selected' }, { label: 'Test' }] },
    { label: 'Project', actions: [{ label: 'Connect repo' }, { label: 'Profiles' }] },
  ]},
];

export function DbtJobEditor({ item, id }: { item: FabricItemType; id: string }) {
  const styles = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={DBT_RIBBON} main={
      <div className={styles.form}>
        <Subtitle2>Project</Subtitle2>
        <div className={styles.field}><Caption1>Git repo</Caption1><Input placeholder="https://github.com/contoso/dbt-prod" /></div>
        <div className={styles.field}><Caption1>Branch</Caption1><Input defaultValue="main" /></div>
        <div className={styles.field}><Caption1>Subdirectory</Caption1><Input placeholder="/dbt" /></div>
        <Subtitle2 style={{ marginTop: 8 }}>profiles.yml</Subtitle2>
        <Textarea rows={6} defaultValue={`fabric:\n  target: prod\n  outputs:\n    prod:\n      type: fabric\n      workspace: fin-prod\n      warehouse: fin-warehouse`} />
        <Button appearance="primary" style={{ alignSelf: 'flex-start' }}>dbt run</Button>
      </div>
    } />
  );
}
