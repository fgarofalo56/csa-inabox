'use client';

/**
 * DataPreviewDock — the docked-bottom panel under the Eventstream canvas,
 * matching Fabric Eventstream's data-preview experience:
 *
 *   ┌ Data preview | Authoring errors ─────────────────────────── Refresh ┐
 *   │ source ▾   format: Json ▾   Show data from: Last hour ▾   [search]   │
 *   │ ┌ Partition ┬ Enqueued time ┬ abc deviceId ┬ 123 temp ┬ time ts ─┐  │
 *   │ │    0      │  12:04:11      │  sensor-A    │   30.1   │  …       │  │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * The "Data preview" tab shows LIVE events peeked from the source's real Event
 * Hub (or the newest rows the stream landed in its ADX sink under private
 * networking) via `GET /api/items/eventstream/[id]/events`. Column headers carry
 * a TYPE BADGE inferred from the data (string / number / datetime / boolean /
 * geo / record), each with a data-type override dropdown; a time-range picker
 * and a search box filter the rows client-side. When live receive isn't enabled
 * and no ADX sink exists, the route returns an honest dependency gate which the
 * dock renders as a Fluent warning MessageBar (no faked events — no-vaporware).
 *
 * The "Authoring errors" tab is a static pre-flight lint of the topology
 * (collectAuthoringErrors) — the same problems Fabric surfaces before you
 * publish, computed instantly on every edit with no backend call.
 *
 * Azure-native by default: nothing here requires Microsoft Fabric.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Tab, TabList, Button, Select, Input, Badge, Caption1, Spinner, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, shorthands, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync16Regular, Search16Regular, Warning16Filled, Info16Regular,
  ErrorCircle16Filled, CheckmarkCircle16Filled,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import {
  shapeEventPreview, filterPreviewRows, filterByTimeRange, formatPreviewCell,
  columnLabel, TIME_RANGES,
  type PreviewColumn, type PreviewColumnType, type RawPreviewEvent,
} from './preview-shaping';
import {
  collectAuthoringErrors, authoringErrorCounts,
  type EsTopology, type AuthoringError,
} from './authoring-errors';

const useStyles = makeStyles({
  dock: {
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke2),
    backgroundColor: tokens.colorNeutralBackground2,
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: tokens.spacingHorizontalS,
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalS),
    flexWrap: 'wrap',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
  },
  fieldLabel: {
    color: tokens.colorNeutralForeground3,
  },
  search: {
    marginLeft: 'auto',
    minWidth: '180px',
  },
  body: {
    overflow: 'auto',
    maxHeight: '320px',
    minHeight: '120px',
    ...shorthands.padding('0', tokens.spacingHorizontalS, tokens.spacingVerticalS),
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: tokens.fontSizeBase200,
  },
  th: {
    textAlign: 'left',
    position: 'sticky',
    top: '0',
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke2),
    whiteSpace: 'nowrap',
    verticalAlign: 'bottom',
  },
  thInner: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
  },
  typeBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '26px',
    height: '16px',
    ...shorthands.padding('0', tokens.spacingHorizontalXXS),
    ...shorthands.borderRadius(tokens.borderRadiusSmall),
    backgroundColor: tokens.colorNeutralBackground4,
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase100,
    fontFamily: tokens.fontFamilyMonospace,
    lineHeight: '16px',
    userSelect: 'none',
  },
  typeSelect: {
    minWidth: '92px',
    marginTop: tokens.spacingVerticalXXS,
  },
  td: {
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke3),
    fontFamily: tokens.fontFamilyMonospace,
    maxWidth: '320px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rowAlt: {
    backgroundColor: tokens.colorNeutralBackground2,
  },
  empty: {
    color: tokens.colorNeutralForeground3,
    ...shorthands.padding(tokens.spacingVerticalL, tokens.spacingHorizontalS),
    fontStyle: 'italic',
  },
  errorList: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalS),
  },
  errorRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalS,
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    backgroundColor: tokens.colorNeutralBackground2,
  },
});

/** Short header badge text per inferred type (Fabric-style Abc / 123 / …). */
const TYPE_BADGE: Record<PreviewColumnType, { text: string; label: string }> = {
  string: { text: 'abc', label: 'String' },
  number: { text: '123', label: 'Number' },
  datetime: { text: 'time', label: 'Datetime' },
  boolean: { text: '0/1', label: 'Boolean' },
  geo: { text: 'geo', label: 'Geo (lat/long)' },
  record: { text: '{ }', label: 'Record' },
};

const PREVIEW_TYPES: PreviewColumnType[] = ['string', 'number', 'datetime', 'boolean', 'geo', 'record'];

export interface DataPreviewDockProps {
  /** Cosmos eventstream id — absent on /new (preview is then gated on save). */
  itemId?: string;
  /** The live topology (sources / transforms / sinks) for the errors tab + source picker. */
  topology: EsTopology;
}

export function DataPreviewDock({ itemId, topology }: DataPreviewDockProps) {
  const s = useStyles();
  const [tab, setTab] = useState<'preview' | 'errors'>('preview');

  const sources = Array.isArray(topology.sources) ? topology.sources : [];

  // Preview controls.
  const [sourceIdx, setSourceIdx] = useState(0);
  const [rangeId, setRangeId] = useState('1h');
  const [search, setSearch] = useState('');
  const [overrides, setOverrides] = useState<Record<string, PreviewColumnType>>({});

  // Preview data.
  const [events, setEvents] = useState<RawPreviewEvent[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const loadedFor = useRef<string | null>(null);

  const authoring = useMemo(() => collectAuthoringErrors(topology), [topology]);
  const counts = useMemo(() => authoringErrorCounts(authoring), [authoring]);

  const refresh = useCallback(async () => {
    if (!itemId || itemId === 'new') { setGate('Save the eventstream first — live preview needs a persisted item.'); return; }
    setBusy(true); setErr(null); setGate(null); setNote(null);
    try {
      const r = await clientFetch(`/api/items/eventstream/${itemId}/events?nodeIdx=${sourceIdx}&maxEvents=50`);
      const j = await r.json();
      if (j.ok) {
        setEvents(Array.isArray(j.events) ? j.events : []);
        setNote(typeof j.note === 'string' ? j.note : null);
      } else if (j.code === 'receive_unavailable') {
        setEvents(null);
        setGate(j.hint || j.error || 'Live receive is not enabled in this deployment.');
      } else {
        setEvents(null);
        setErr(j.error || 'preview failed');
      }
    } catch (e: any) {
      setEvents(null);
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [itemId, sourceIdx]);

  // Auto-load once when the preview tab is first shown for a saved item.
  useEffect(() => {
    if (tab !== 'preview' || !itemId || itemId === 'new') return;
    const key = `${itemId}:${sourceIdx}`;
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    void refresh();
  }, [tab, itemId, sourceIdx, refresh]);

  const shape = useMemo(
    () => shapeEventPreview(events || [], { typeOverrides: overrides }),
    [events, overrides],
  );
  const rangeMs = useMemo(() => (TIME_RANGES.find((t) => t.id === rangeId) ?? TIME_RANGES[1]).ms, [rangeId]);
  const visibleRows = useMemo(() => {
    const byTime = filterByTimeRange(shape.rows, rangeMs);
    return filterPreviewRows(byTime, shape.columns, search);
  }, [shape, rangeMs, search]);

  const setColType = useCallback((key: string, type: PreviewColumnType) => {
    setOverrides((prev) => ({ ...prev, [key]: type }));
  }, []);

  return (
    <div className={s.dock} role="region" aria-label="Eventstream data preview">
      <div className={s.header}>
        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'preview' | 'errors')} size="small">
          <Tab value="preview">Data preview</Tab>
          <Tab value="errors">
            Authoring errors
            {counts.errors > 0 && <Badge appearance="filled" color="danger" size="small" style={{ marginLeft: tokens.spacingHorizontalXS }}>{counts.errors}</Badge>}
            {counts.errors === 0 && counts.warnings > 0 && <Badge appearance="filled" color="warning" size="small" style={{ marginLeft: tokens.spacingHorizontalXS }}>{counts.warnings}</Badge>}
          </Tab>
        </TabList>
        {tab === 'preview' && (
          <Button size="small" appearance="subtle" icon={busy ? <Spinner size="tiny" /> : <ArrowSync16Regular />} onClick={refresh} disabled={busy || !itemId || itemId === 'new'}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </Button>
        )}
      </div>

      {tab === 'preview' && (
        <>
          <div className={s.toolbar}>
            {sources.length > 1 && (
              <label className={s.field}>
                <Caption1 className={s.fieldLabel}>Source</Caption1>
                <Select size="small" value={String(sourceIdx)} onChange={(_, d) => { setSourceIdx(Number(d.value) || 0); loadedFor.current = null; }} aria-label="Preview source">
                  {sources.map((n, i) => <option key={i} value={String(i)}>{n?.name || `source-${i + 1}`}</option>)}
                </Select>
              </label>
            )}
            <label className={s.field}>
              <Caption1 className={s.fieldLabel}>Format</Caption1>
              <Select size="small" value="json" aria-label="Data format" disabled>
                <option value="json">Json</option>
              </Select>
            </label>
            <label className={s.field}>
              <Caption1 className={s.fieldLabel}>Show data from</Caption1>
              <Select size="small" value={rangeId} onChange={(_, d) => setRangeId(d.value)} aria-label="Time range">
                {TIME_RANGES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </Select>
            </label>
            <Input
              className={s.search}
              size="small"
              contentBefore={<Search16Regular />}
              value={search}
              onChange={(_, d) => setSearch(d.value)}
              placeholder="Search rows…"
              aria-label="Search preview rows"
            />
          </div>

          <div className={s.body}>
            {gate && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Live preview not enabled</MessageBarTitle>
                  {gate} Sending a test event to the source works today; add a KQL Database destination to preview the newest ingested rows from Azure Data Explorer.
                </MessageBarBody>
              </MessageBar>
            )}
            {err && !gate && (
              <MessageBar intent="error">
                <MessageBarBody><MessageBarTitle>Preview failed</MessageBarTitle>{err}</MessageBarBody>
              </MessageBar>
            )}
            {note && !gate && !err && (
              <Caption1 className={s.fieldLabel} style={{ display: 'block', padding: `${tokens.spacingVerticalXS} 0` }}>{note}</Caption1>
            )}

            {!gate && !err && events !== null && shape.columns.length === 0 && (
              <div className={s.empty}>No events on this source yet. Send a test event, then Refresh.</div>
            )}
            {!gate && !err && events === null && !busy && (
              <div className={s.empty}>Click Refresh to peek the newest live events from this source.</div>
            )}

            {!gate && !err && shape.columns.length > 0 && (
              <table className={s.table} aria-label="Live event preview">
                <thead>
                  <tr>
                    {shape.columns.map((c) => (
                      <PreviewHeader key={c.key} col={c} onType={setColType} className={{ th: s.th, inner: s.thInner, badge: s.typeBadge, select: s.typeSelect }} />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.slice(0, 200).map((row, ri) => (
                    <tr key={ri} className={ri % 2 ? s.rowAlt : undefined}>
                      {shape.columns.map((c) => (
                        <td key={c.key} className={s.td} title={formatPreviewCell(row[c.key])}>{formatPreviewCell(row[c.key])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {!gate && !err && shape.columns.length > 0 && visibleRows.length === 0 && (
              <div className={s.empty}>No rows match the current search / time range.</div>
            )}
          </div>
        </>
      )}

      {tab === 'errors' && (
        <div className={s.errorList}>
          {authoring.length === 0 ? (
            <div className={s.errorRow}>
              <CheckmarkCircle16Filled style={{ color: tokens.colorPaletteGreenForeground1, flexShrink: 0 }} />
              <Caption1>No authoring errors — the topology is publish-ready.</Caption1>
            </div>
          ) : (
            authoring.map((e) => <AuthoringRow key={e.id} err={e} className={s.errorRow} />)
          )}
        </div>
      )}
    </div>
  );
}

function PreviewHeader({
  col, onType, className,
}: {
  col: PreviewColumn;
  onType: (key: string, type: PreviewColumnType) => void;
  className: { th: string; inner: string; badge: string; select: string };
}) {
  const badge = TYPE_BADGE[col.type];
  return (
    <th className={className.th}>
      <div className={className.inner}>
        <Tooltip content={badge.label} relationship="label">
          <span className={className.badge} aria-label={`${badge.label} column`}>{badge.text}</span>
        </Tooltip>
        <span>{columnLabel(col.key)}</span>
      </div>
      {!col.system && (
        <Select
          className={className.select}
          size="small"
          value={col.type}
          onChange={(_, d) => onType(col.key, d.value as PreviewColumnType)}
          aria-label={`${columnLabel(col.key)} data type`}
        >
          {PREVIEW_TYPES.map((t) => <option key={t} value={t}>{TYPE_BADGE[t].label}</option>)}
        </Select>
      )}
    </th>
  );
}

function AuthoringRow({ err, className }: { err: AuthoringError; className: string }) {
  const icon = err.severity === 'error'
    ? <ErrorCircle16Filled style={{ color: tokens.colorPaletteRedForeground1, flexShrink: 0 }} />
    : <Warning16Filled style={{ color: tokens.colorPaletteYellowForeground1, flexShrink: 0 }} />;
  return (
    <div className={className}>
      {icon}
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS }}>
        <Caption1>{err.message}</Caption1>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          <Info16Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXXS }} />
          {err.nodeType}{err.nodeName ? ` · ${err.nodeName}` : ''}
        </Caption1>
      </div>
    </div>
  );
}
