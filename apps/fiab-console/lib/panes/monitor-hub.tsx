'use client';

/**
 * MonitorHubPane — Activities table with filters, status badges,
 * and per-item-type icons. Mirrors the Fabric Monitor hub described
 * in inventory §2.3.
 */

import { useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Dropdown, Option,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Search20Regular, ArrowClockwise20Regular } from '@fluentui/react-icons';

const ROWS = [
  { name: 'nightly-orders-pipeline', type: 'Pipeline',    status: 'Succeeded', started: '2026-05-24 02:00', duration: '14m 22s', submitter: 'system' },
  { name: 'ChurnModel.train',        type: 'Notebook',    status: 'Succeeded', started: '2026-05-24 01:30', duration: '38m 11s', submitter: 'carl@contoso' },
  { name: 'mirror-azuresql',         type: 'Mirrored DB', status: 'Running',   started: '2026-05-24 09:12', duration: '—',       submitter: 'alice@contoso' },
  { name: 'fin-warehouse refresh',   type: 'Warehouse',   status: 'Failed',    started: '2026-05-24 08:55', duration: '02m 04s', submitter: 'bob@contoso' },
  { name: 'orders→silver',           type: 'Dataflow Gen2', status: 'Succeeded', started: '2026-05-24 08:00', duration: '06m 47s', submitter: 'alice@contoso' },
  { name: 'eventstream-billing',     type: 'Eventstream', status: 'Running',   started: '2026-05-22 14:30', duration: 'streaming', submitter: 'eve@contoso' },
];
const STATUSES = ['(All)', 'Succeeded', 'Running', 'Failed', 'Queued', 'Canceled'];
const TYPES = ['(All)', 'Pipeline', 'Notebook', 'Dataflow Gen2', 'Mirrored DB', 'Warehouse', 'Eventstream', 'ML experiment'];

const useStyles = makeStyles({
  bar: { display: 'flex', gap: '12px', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' },
  rowHover: { ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover, cursor: 'pointer' } },
});

export function MonitorHubPane() {
  const s = useStyles();
  const [tab, setTab] = useState('activities');
  const [status, setStatus] = useState('(All)');
  const [type, setType] = useState('(All)');
  const [q, setQ] = useState('');
  const filtered = ROWS.filter((r) =>
    (status === '(All)' || r.status === status) &&
    (type === '(All)' || r.type === type) &&
    (!q || r.name.toLowerCase().includes(q.toLowerCase()))
  );
  return (
    <div>
      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
        <Tab value="activities">Activities</Tab>
        <Tab value="schedule">Schedule failures (preview)</Tab>
      </TabList>
      <div style={{ marginTop: 12 }}>
        {tab === 'activities' && (<>
          <div className={s.bar}>
            <Input contentBefore={<Search20Regular />} placeholder="Search activities" value={q} onChange={(_, d) => setQ(d.value)} style={{ flex: 1, minWidth: 200 }} />
            <Caption1>Status:</Caption1>
            <Dropdown value={status} selectedOptions={[status]} onOptionSelect={(_, d) => setStatus(d.optionValue ?? status)}>
              {STATUSES.map((x) => <Option key={x} value={x}>{x}</Option>)}
            </Dropdown>
            <Caption1>Item type:</Caption1>
            <Dropdown value={type} selectedOptions={[type]} onOptionSelect={(_, d) => setType(d.optionValue ?? type)}>
              {TYPES.map((x) => <Option key={x} value={x}>{x}</Option>)}
            </Dropdown>
            <Button appearance="subtle" icon={<ArrowClockwise20Regular />}>Refresh</Button>
            <Button appearance="subtle">Export CSV</Button>
          </div>
          <Table aria-label="Activities">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Item type</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell><TableHeaderCell>Started</TableHeaderCell>
                <TableHeaderCell>Duration</TableHeaderCell><TableHeaderCell>Submitter</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => (
                <TableRow key={r.name} className={s.rowHover}>
                  <TableCell>{r.name}</TableCell>
                  <TableCell>{r.type}</TableCell>
                  <TableCell>
                    <Badge appearance="filled" color={r.status === 'Succeeded' ? 'success' : r.status === 'Failed' ? 'danger' : r.status === 'Running' ? 'brand' : 'subtle'}>
                      {r.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{r.started}</TableCell>
                  <TableCell>{r.duration}</TableCell>
                  <TableCell>{r.submitter}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Caption1 style={{ color: tokens.colorNeutralForeground3, marginTop: 8 }}>{filtered.length} of {ROWS.length} activities · last 30 days</Caption1>
        </>)}
        {tab === 'schedule' && (
          <Body1>Schedule failure notifications for scheduled items will appear here. Configure per-item recipients from the item&apos;s Settings.</Body1>
        )}
      </div>
    </div>
  );
}
