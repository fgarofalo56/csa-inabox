'use client';

import { useState } from 'react';
import {
  Title2,
  Body1,
  makeStyles,
  tokens,
  Button,
  Dropdown,
  Option,
  Input,
  Field,
  Badge,
  Tab,
  TabList,
} from '@fluentui/react-components';
import { Add24Regular, Flash24Regular } from '@fluentui/react-icons';

type Primitive =
  | 'increasesAbove'
  | 'decreasesBelow'
  | 'isAbove'
  | 'isBelow'
  | 'changesTo'
  | 'andStays'
  | 'noPresenceOfData'
  | 'everyNthTime';

type ActionType = 'teams' | 'email' | 'logic-app' | 'webhook';

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  primitive: Primitive;
  property: string;
  threshold?: number;
  duration?: string;
  action: ActionType;
  target: string;
  lastFired?: string;
  fireCount?: number;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '16px' },
  header: { display: 'flex', alignItems: 'center', gap: '12px' },
  spacer: { flex: 1 },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: {
    textAlign: 'left',
    padding: '8px',
    backgroundColor: tokens.colorNeutralBackground2,
    fontWeight: '600',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  td: { padding: '8px', borderBottom: `1px solid ${tokens.colorNeutralStroke3}` },
  editor: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    padding: '16px',
    display: 'grid',
    gridTemplateColumns: '120px 1fr',
    gap: '12px 16px',
  },
});

const seedRules: Rule[] = [
  {
    id: 'r1',
    name: 'Server CPU spike',
    enabled: true,
    primitive: 'increasesAbove',
    property: 'cpu_pct',
    threshold: 85,
    duration: 'PT5M',
    action: 'teams',
    target: 'sre-oncall',
    lastFired: '2026-05-22 13:42 UTC',
    fireCount: 14,
  },
  {
    id: 'r2',
    name: 'Order pipeline silence',
    enabled: true,
    primitive: 'noPresenceOfData',
    property: 'order_event',
    duration: 'PT10M',
    action: 'logic-app',
    target: 'la-order-incident-escalation',
    lastFired: '2026-05-21 02:11 UTC',
    fireCount: 2,
  },
];

export function ActivatorPane() {
  const styles = useStyles();
  const [rules, setRules] = useState(seedRules);
  const [editing, setEditing] = useState<Rule | null>(null);

  function toggleRule(id: string) {
    setRules((r) => r.map((rule) => (rule.id === id ? { ...rule, enabled: !rule.enabled } : rule)));
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Title2>Activator</Title2>
        <Badge color="brand">8 Fabric primitives supported</Badge>
        <div className={styles.spacer} />
        <Button appearance="primary" icon={<Add24Regular />} onClick={() => setEditing({
          id: 'new',
          name: '',
          enabled: true,
          primitive: 'increasesAbove',
          property: '',
          action: 'teams',
          target: '',
        })}>New rule</Button>
      </div>

      <TabList defaultSelectedValue="rules">
        <Tab value="rules">Rules</Tab>
        <Tab value="objects">Objects</Tab>
        <Tab value="history">Action history</Tab>
      </TabList>

      <table className={styles.table}>
        <thead>
          <tr>
            <th className={styles.th}>Rule</th>
            <th className={styles.th}>Primitive</th>
            <th className={styles.th}>Property</th>
            <th className={styles.th}>Action</th>
            <th className={styles.th}>Last fired</th>
            <th className={styles.th}>Count</th>
            <th className={styles.th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id} onClick={() => setEditing(r)} style={{ cursor: 'pointer' }}>
              <td className={styles.td}>{r.name}</td>
              <td className={styles.td}><code>{r.primitive}</code></td>
              <td className={styles.td}>{r.property}{r.threshold !== undefined ? ` > ${r.threshold}` : ''}</td>
              <td className={styles.td}>{r.action} → {r.target}</td>
              <td className={styles.td}>{r.lastFired ?? '—'}</td>
              <td className={styles.td}>{r.fireCount ?? 0}</td>
              <td className={styles.td}>
                <Button
                  size="small"
                  appearance={r.enabled ? 'primary' : 'subtle'}
                  icon={<Flash24Regular />}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleRule(r.id);
                  }}
                >
                  {r.enabled ? 'On' : 'Off'}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing && (
        <div className={styles.editor}>
          <Body1 weight="semibold">Name</Body1>
          <Input value={editing.name} onChange={(_, d) => setEditing({ ...editing, name: d.value })} />

          <Body1 weight="semibold">Primitive</Body1>
          <Dropdown
            value={editing.primitive}
            selectedOptions={[editing.primitive]}
            onOptionSelect={(_, d) => setEditing({ ...editing, primitive: d.optionValue as Primitive })}
          >
            <Option value="increasesAbove">increasesAbove</Option>
            <Option value="decreasesBelow">decreasesBelow</Option>
            <Option value="isAbove">isAbove</Option>
            <Option value="isBelow">isBelow</Option>
            <Option value="changesTo">changesTo</Option>
            <Option value="andStays">andStays</Option>
            <Option value="noPresenceOfData">noPresenceOfData</Option>
            <Option value="everyNthTime">everyNthTime</Option>
          </Dropdown>

          <Body1 weight="semibold">Property</Body1>
          <Input
            value={editing.property}
            onChange={(_, d) => setEditing({ ...editing, property: d.value })}
            placeholder="e.g., cpu_pct"
          />

          <Body1 weight="semibold">Threshold</Body1>
          <Input
            type="number"
            value={String(editing.threshold ?? '')}
            onChange={(_, d) => setEditing({ ...editing, threshold: Number(d.value) })}
          />

          <Body1 weight="semibold">Duration</Body1>
          <Input
            value={editing.duration ?? ''}
            onChange={(_, d) => setEditing({ ...editing, duration: d.value })}
            placeholder="ISO-8601 (e.g., PT5M)"
          />

          <Body1 weight="semibold">Action</Body1>
          <Dropdown
            value={editing.action}
            selectedOptions={[editing.action]}
            onOptionSelect={(_, d) => setEditing({ ...editing, action: d.optionValue as ActionType })}
          >
            <Option value="teams">Teams message</Option>
            <Option value="email">Email</Option>
            <Option value="logic-app">Logic App</Option>
            <Option value="webhook">Webhook</Option>
          </Dropdown>

          <Body1 weight="semibold">Target</Body1>
          <Input
            value={editing.target}
            onChange={(_, d) => setEditing({ ...editing, target: d.value })}
            placeholder="channel / email / app name"
          />

          <div />
          <div style={{ display: 'flex', gap: '8px' }}>
            <Button
              appearance="primary"
              onClick={() => {
                if (editing.id === 'new') {
                  setRules((r) => [...r, { ...editing, id: `r${r.length + 1}` }]);
                } else {
                  setRules((r) => r.map((rule) => (rule.id === editing.id ? editing : rule)));
                }
                setEditing(null);
              }}
            >
              Save
            </Button>
            <Button appearance="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
