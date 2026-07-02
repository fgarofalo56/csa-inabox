'use client';

/**
 * GraphSourceBinding — per-type Source mapping for a graph-model node/edge type
 * (P0 table-mapping + key-column parity with the Fabric graph model editor).
 *
 * Binds a node/edge TYPE to a real ADX source table and maps its key + property
 * columns from the LIVE table schema (fetched from
 * `/api/items/graph-model/<id>/source-schema`). The captured binding is what the
 * `/materialize` route uses to `.set-or-append` typed rows so the graph has DATA
 * — Azure-native, NO Fabric. When ADX isn't configured the picker degrades to an
 * honest Fluent MessageBar naming the env var to set (per no-vaporware).
 *
 * Binding shape (persisted on the type object in Cosmos):
 *   node: { sourceDatabase?, sourceTable?, keyColumns?: string[] }
 *   edge: { sourceDatabase?, sourceTable?, originKeyColumns?, targetKeyColumns? }
 *   properties[i].sourceColumn — column each property maps from (rename support)
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Button, Dropdown, Option, Field, Caption1, Spinner, Badge,
  MessageBar, MessageBarBody, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ChevronRight16Regular, ChevronDown16Regular, Table16Regular, Key16Regular,
} from '@fluentui/react-icons';

export interface SourceProp { name: string; type: string; sourceColumn?: string }
export interface SourceBindable {
  name: string;
  properties?: SourceProp[];
  sourceDatabase?: string;
  sourceTable?: string;
  keyColumns?: string[];
  originKeyColumns?: string[];
  targetKeyColumns?: string[];
}

const useStyles = makeStyles({
  wrap: {
    marginTop: tokens.spacingVerticalXS,
    borderTop: `1px dashed ${tokens.colorNeutralStroke2}`,
    paddingTop: tokens.spacingVerticalXS,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
  },
  toggle: { justifyContent: 'flex-start', paddingLeft: 0, color: tokens.colorNeutralForeground2 },
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, paddingTop: tokens.spacingVerticalXS },
  row2: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: tokens.spacingHorizontalS },
  mapRow: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: tokens.spacingHorizontalS, alignItems: 'center' },
  mapName: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  hint: { color: tokens.colorNeutralForeground3 },
});

type Col = { name: string; type: string };

export function GraphSourceBinding({
  itemId, kind, type, onChange,
}: {
  itemId: string;
  kind: 'node' | 'edge';
  type: SourceBindable;
  onChange: (patch: Partial<SourceBindable>) => void;
}) {
  const s = useStyles();
  const [open, setOpen] = useState<boolean>(!!type.sourceTable);
  const [loading, setLoading] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [databases, setDatabases] = useState<string[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [columns, setColumns] = useState<Col[]>([]);

  const base = `/api/items/graph-model/${encodeURIComponent(itemId)}/source-schema`;
  const canBind = itemId && itemId !== 'new';

  // Lazily load the database list the first time the Source panel is opened.
  const loadDatabases = useCallback(async () => {
    if (!canBind) return;
    setLoading(true); setErr(null); setGate(null);
    try {
      const r = await fetch(base);
      const j = await r.json().catch(() => ({}));
      if (j?.gate) { setGate(j.gate.remediation); return; }
      if (!j?.ok) { setErr(j?.error || `HTTP ${r.status}`); return; }
      setDatabases((j.databases || []).map((d: any) => d.name).filter(Boolean));
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [base, canBind]);

  const loadTables = useCallback(async (db: string) => {
    if (!canBind || !db) return;
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`${base}?database=${encodeURIComponent(db)}`);
      const j = await r.json().catch(() => ({}));
      if (j?.gate) { setGate(j.gate.remediation); return; }
      if (!j?.ok) { setErr(j?.error || `HTTP ${r.status}`); return; }
      setTables((j.tables || []).map((t: any) => t.name).filter(Boolean));
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [base, canBind]);

  const loadColumns = useCallback(async (db: string, table: string) => {
    if (!canBind || !db || !table) { setColumns([]); return; }
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`${base}?database=${encodeURIComponent(db)}&table=${encodeURIComponent(table)}`);
      const j = await r.json().catch(() => ({}));
      if (j?.gate) { setGate(j.gate.remediation); return; }
      if (!j?.ok) { setErr(j?.error || `HTTP ${r.status}`); return; }
      setColumns(Array.isArray(j.columns) ? j.columns : []);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [base, canBind]);

  useEffect(() => {
    if (open && databases.length === 0 && !gate) void loadDatabases();
  }, [open, databases.length, gate, loadDatabases]);

  // Reload tables/columns to reflect a pre-existing binding when expanded.
  useEffect(() => {
    if (open && type.sourceDatabase) void loadTables(type.sourceDatabase);
    if (open && type.sourceDatabase && type.sourceTable) void loadColumns(type.sourceDatabase, type.sourceTable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const colNames = columns.map((c) => c.name);
  const keyField = kind === 'node' ? 'keyColumns' : undefined;
  const keyVals = (type.keyColumns || []);

  const setKey = (vals: string[], field: 'keyColumns' | 'originKeyColumns' | 'targetKeyColumns') =>
    onChange({ [field]: vals } as Partial<SourceBindable>);

  const setPropColumn = (pname: string, col: string) => {
    const next = (type.properties || []).map((p) => {
      if (p.name !== pname) return p;
      const found = columns.find((c) => c.name === col);
      // Auto-detect the property's value type from the chosen column.
      return { ...p, sourceColumn: col || undefined, ...(found ? { type: found.type } : {}) };
    });
    onChange({ properties: next });
  };

  const bound = !!type.sourceTable;

  return (
    <div className={s.wrap}>
      <Button
        appearance="subtle" size="small" className={s.toggle}
        icon={open ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
        onClick={() => setOpen((v) => !v)}
      >
        Source binding{bound ? '' : ' (optional)'}
        {bound && <Badge appearance="tint" color="brand" size="small" style={{ marginLeft: tokens.spacingHorizontalXS }}>{type.sourceTable}</Badge>}
      </Button>

      {open && (
        <div className={s.body}>
          {!canBind && (
            <MessageBar intent="info"><MessageBarBody>Save this graph model first to browse ADX source tables.</MessageBarBody></MessageBar>
          )}
          {gate && (
            <MessageBar intent="warning"><MessageBarBody>{gate}</MessageBarBody></MessageBar>
          )}
          {err && (
            <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>
          )}
          {loading && <Spinner size="extra-tiny" label="Loading ADX schema…" labelPosition="after" />}

          {canBind && !gate && (
            <>
              <div className={s.row2}>
                <Field label="Source database">
                  <Dropdown
                    value={type.sourceDatabase || ''} selectedOptions={type.sourceDatabase ? [type.sourceDatabase] : []}
                    placeholder="Select database"
                    onOptionSelect={(_, d) => { const db = d.optionValue || ''; onChange({ sourceDatabase: db, sourceTable: undefined, keyColumns: [], originKeyColumns: [], targetKeyColumns: [] }); setColumns([]); void loadTables(db); }}
                  >
                    {databases.map((db) => <Option key={db} value={db}>{db}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Source table">
                  <Dropdown
                    value={type.sourceTable || ''} selectedOptions={type.sourceTable ? [type.sourceTable] : []}
                    placeholder="Select table" disabled={!type.sourceDatabase}
                    onOptionSelect={(_, d) => { const t = d.optionValue || ''; onChange({ sourceTable: t }); void loadColumns(type.sourceDatabase || '', t); }}
                  >
                    {tables.map((t) => <Option key={t} value={t}><Table16Regular />&nbsp;{t}</Option>)}
                  </Dropdown>
                </Field>
              </div>

              {type.sourceTable && columns.length > 0 && (
                <>
                  {kind === 'node' ? (
                    <Field label="Key column(s)" hint="Uniquely identifies each node (compound keys allowed).">
                      <Dropdown
                        multiselect value={keyVals.join(', ')} selectedOptions={keyVals} placeholder="Pick key column(s)"
                        onOptionSelect={(_, d) => setKey(d.selectedOptions, keyField as 'keyColumns')}
                      >
                        {colNames.map((c) => <Option key={c} value={c}><Key16Regular />&nbsp;{c}</Option>)}
                      </Dropdown>
                    </Field>
                  ) : (
                    <div className={s.row2}>
                      <Field label="Origin key column(s)" hint="Edge source → node key">
                        <Dropdown
                          multiselect value={(type.originKeyColumns || []).join(', ')} selectedOptions={type.originKeyColumns || []} placeholder="Origin key(s)"
                          onOptionSelect={(_, d) => setKey(d.selectedOptions, 'originKeyColumns')}
                        >
                          {colNames.map((c) => <Option key={c} value={c}>{c}</Option>)}
                        </Dropdown>
                      </Field>
                      <Field label="Target key column(s)" hint="Edge target → node key">
                        <Dropdown
                          multiselect value={(type.targetKeyColumns || []).join(', ')} selectedOptions={type.targetKeyColumns || []} placeholder="Target key(s)"
                          onOptionSelect={(_, d) => setKey(d.selectedOptions, 'targetKeyColumns')}
                        >
                          {colNames.map((c) => <Option key={c} value={c}>{c}</Option>)}
                        </Dropdown>
                      </Field>
                    </div>
                  )}

                  {(type.properties || []).filter((p) => p.name && p.name !== 'srcType' && p.name !== 'dstType').length > 0 && (
                    <div>
                      <Caption1 className={s.hint}>Map each property to a source column (auto-types from the column):</Caption1>
                      {(type.properties || []).filter((p) => p.name && p.name !== 'srcType' && p.name !== 'dstType').map((p) => (
                        <div key={p.name} className={s.mapRow}>
                          <span className={s.mapName}><Caption1>{p.name}</Caption1><Badge appearance="outline" size="small">{p.type}</Badge></span>
                          <Dropdown
                            value={p.sourceColumn || ''} selectedOptions={p.sourceColumn ? [p.sourceColumn] : []} placeholder={`(same: ${p.name})`}
                            onOptionSelect={(_, d) => setPropColumn(p.name, d.optionValue || '')}
                          >
                            {colNames.map((c) => <Option key={c} value={c}>{c}</Option>)}
                          </Dropdown>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
              {type.sourceTable && !loading && columns.length === 0 && (
                <Caption1 className={s.hint}>No columns found for this table.</Caption1>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
