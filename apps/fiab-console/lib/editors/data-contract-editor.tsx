'use client';

/**
 * DataContractEditor — the standalone `data-contract` item type (W10).
 *
 * The data-mesh / ODCS "data contract" as a first-class Loom item: an output
 * schema + quantified SLAs + data-quality expectations, authored in the SAME
 * typed designer the data-product Contract tab uses (extracted, reused — no
 * free-typed JSON). Persists to the item's own Cosmos state and validates
 * against a bound Azure Data Explorer table (real KQL). Bind the contract to a
 * data product to ENFORCE it at publish time (BR-CONTRACT-GATE). Azure-native —
 * no Microsoft Fabric dependency (no-fabric-dependency.md); every control hits a
 * real backend (no-vaporware.md).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Field, Dropdown, Option, Spinner, Divider,
  Card, CardHeader, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Save20Regular, Table20Regular, ShieldCheckmark20Regular, LinkRegular, DatabaseSearch20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemCreateGate } from './new-item-gate';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { useItemState } from './palantir/shared';
import {
  DataContractDesigner, ContractQualityRunPanel,
} from './components/data-contract-designer';
import { DataContractOdcsPanel } from './components/data-contract-odcs-panel';
import { EMPTY_CONTRACT, contractStats, type ContractColumn, type DataContract } from '@/lib/dataproducts/contract';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

interface DataContractState extends Record<string, unknown> {
  contract?: DataContract;
  databaseName?: string;
  databaseTable?: string;
}

const useStyles = makeStyles({
  body: { padding: tokens.spacingVerticalXL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, maxWidth: '1100px' },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  card: { padding: tokens.spacingHorizontalL, borderRadius: tokens.borderRadiusLarge, boxShadow: tokens.shadow4, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  bindGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: tokens.spacingHorizontalM },
  hint: { color: tokens.colorNeutralForeground3 },
});

export function DataContractEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, save, dirty } =
    useItemState<DataContractState>('data-contract', id, { contract: EMPTY_CONTRACT, databaseName: '', databaseTable: '' });

  const [savedVersion, setSavedVersion] = useState(0);
  const [databases, setDatabases] = useState<string[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [adxGate, setAdxGate] = useState<string | null>(null);
  const [deriving, setDeriving] = useState(false);
  const [deriveMsg, setDeriveMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  const contract = state.contract ?? EMPTY_CONTRACT;
  const stats = useMemo(() => contractStats(contract), [contract]);

  // ADX database picker (real ADX list via the item's quality browse endpoint).
  useEffect(() => {
    if (!id || id === 'new') return;
    (async () => {
      try {
        const r = await clientFetch(`/api/items/data-contract/${encodeURIComponent(id)}/quality?browse=databases`);
        const j = await r.json();
        if (j.ok) { setDatabases(j.databases || []); if (j.gate?.adx) setAdxGate(j.gate.adx.missing); }
      } catch { /* honest: dropdown stays empty */ }
    })();
  }, [id]);

  const loadTables = useCallback(async (db: string) => {
    setTables([]);
    if (!db || id === 'new') return;
    try {
      const r = await clientFetch(`/api/items/data-contract/${encodeURIComponent(id)}/quality?browse=tables&database=${encodeURIComponent(db)}`);
      const j = await r.json();
      if (j.ok) setTables(j.tables || []);
    } catch { /* honest: dropdown stays empty */ }
  }, [id]);

  // Load tables for the persisted database on first load.
  useEffect(() => { if (state.databaseName) void loadTables(state.databaseName); }, [state.databaseName, loadTables]);

  const doSave = useCallback(async () => {
    const ok = await save();
    if (ok) setSavedVersion((v) => v + 1);
  }, [save]);

  /**
   * N6 — DERIVE the schema from the bound table. A real ADX read
   * (`.show table <T> schema as json`), never a hand-typed column list. Columns
   * the steward already annotated keep their description / classification /
   * primary-key flag; columns the source dropped are removed; new columns are
   * appended — so re-deriving after a source change is a diff, not a wipe.
   */
  const deriveSchema = useCallback(async () => {
    setDeriving(true);
    setDeriveMsg(null);
    try {
      const r = await clientFetch(`/api/items/data-contract/${encodeURIComponent(id)}/introspect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ database: state.databaseName, table: state.databaseTable }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Could not read the table schema.');
      const derived: ContractColumn[] = Array.isArray(j.columns) ? j.columns : [];
      setState((p) => {
        const prior = new Map((p.contract?.schema || []).map((c) => [c.name, c]));
        const merged: ContractColumn[] = derived.map((d) => {
          const keep = prior.get(d.name);
          return keep
            ? { ...d, description: keep.description ?? d.description, classification: keep.classification, primaryKey: keep.primaryKey, nullable: keep.nullable }
            : d;
        });
        return { ...p, contract: { ...(p.contract ?? EMPTY_CONTRACT), schema: merged } };
      });
      setDeriveMsg({ intent: 'success', text: `Derived ${derived.length} column${derived.length === 1 ? '' : 's'} from ${j.database}.${j.table}. Save the contract to persist them.` });
    } catch (e) {
      setDeriveMsg({ intent: 'error', text: (e as Error)?.message || 'Could not read the table schema.' });
    } finally {
      setDeriving(false);
    }
  }, [id, state.databaseName, state.databaseTable, setState]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Contract', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: dirty && !saving ? doSave : undefined, disabled: !dirty || saving },
      ]},
      { label: 'Schema', actions: [
        { label: deriving ? 'Deriving…' : 'Derive from table', onClick: !deriving && state.databaseTable ? deriveSchema : undefined, disabled: deriving || !state.databaseTable },
      ]},
    ]},
  ], [saving, dirty, doSave, deriving, deriveSchema, state.databaseTable]);

  if (id === 'new') {
    return (
      <NewItemCreateGate item={item} createLabel="Create data contract"
        intro="A data contract is the formal agreement a data product makes to consumers: an output-port schema (typed columns + PII classification), quantified SLAs, and data-quality expectations — all authored in a typed designer. Bind it to a data product to block that product's publish when validation fails. Azure-native — no Microsoft Fabric required. Create it, then define the schema, SLAs, and expectations." />
    );
  }

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.body}>
        <TeachingBanner
          surfaceKey="data-contract-editor"
          icon={ShieldCheckmark20Regular}
          title="Author a data contract"
          message="Define the output schema, the SLAs, and the data-quality expectations this contract commits to — all from typed controls, never JSON. Bind an ADX table to validate the expectations live, then bind the contract to a data product to enforce it at publish time (a failing error-severity expectation blocks the publish). Azure-native — no Microsoft Fabric required."
          learnMoreHref="https://learn.microsoft.com/purview/concept-data-products"
        />
        {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{error}</MessageBarBody></MessageBar>}

        <div className={s.toolbar}>
          <Badge appearance="tint" color="brand">{stats.columns} column{stats.columns === 1 ? '' : 's'}</Badge>
          <Badge appearance="tint" color="informative">{stats.slos} SLO{stats.slos === 1 ? '' : 's'}</Badge>
          <Badge appearance="tint" color="success">{stats.expectations} expectation{stats.expectations === 1 ? '' : 's'}</Badge>
          {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
          <div className={s.spacer} />
          <Button appearance="primary" icon={saving ? <Spinner size="tiny" /> : <Save20Regular />} disabled={saving || !dirty} onClick={doSave}>
            {saving ? 'Saving…' : 'Save contract'}
          </Button>
        </div>

        {loading ? (
          <Spinner label="Loading data contract…" />
        ) : (
          <>
            {deriveMsg && (
              <MessageBar intent={deriveMsg.intent} layout="multiline">
                <MessageBarBody>
                  <MessageBarTitle>{deriveMsg.intent === 'success' ? 'Schema derived from the bound table' : 'Could not derive the schema'}</MessageBarTitle>
                  {deriveMsg.text}
                </MessageBarBody>
              </MessageBar>
            )}

            <DataContractDesigner value={contract} onChange={(next) => setState((p) => ({ ...p, contract: next }))} />

            {/* ── Validation binding (real ADX, dropdown-driven) ────────────── */}
            <Card className={s.card}>
              <CardHeader
                image={<Table20Regular />}
                header={<Subtitle2>Validate against a table</Subtitle2>}
                description={<Caption1 className={s.hint}>Bind an Azure Data Explorer table to run the contract&apos;s quality expectations against live data.</Caption1>}
              />
              {adxGate && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>ADX not configured</MessageBarTitle>
                    Contract validation queries Azure Data Explorer. Set <code>{adxGate}</code> to the ADX cluster URI on the loom-console container env
                    (wired by <code>platform/fiab/bicep/modules/admin-plane/adx-cluster.bicep</code>) to bind a table and run checks.
                  </MessageBarBody>
                </MessageBar>
              )}
              <div className={s.bindGrid}>
                <Field label="ADX database">
                  <Dropdown value={state.databaseName || ''} selectedOptions={state.databaseName ? [state.databaseName] : []} placeholder={databases.length ? 'Select a database' : 'No databases listed'}
                    disabled={!databases.length}
                    onOptionSelect={(_, d) => { const db = d.optionValue || ''; setState((p) => ({ ...p, databaseName: db, databaseTable: '' })); void loadTables(db); }}>
                    {databases.map((db) => <Option key={db} value={db}>{db}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Table">
                  <Dropdown value={state.databaseTable || ''} selectedOptions={state.databaseTable ? [state.databaseTable] : []} placeholder={tables.length ? 'Select a table' : 'Pick a database first'}
                    disabled={!tables.length}
                    onOptionSelect={(_, d) => setState((p) => ({ ...p, databaseTable: d.optionValue || '' }))}>
                    {tables.map((t) => <Option key={t} value={t}>{t}</Option>)}
                  </Dropdown>
                </Field>
              </div>
              <div className={s.toolbar}>
                <Button icon={deriving ? <Spinner size="tiny" /> : <DatabaseSearch20Regular />} disabled={deriving || !state.databaseTable} onClick={deriveSchema}>
                  {deriving ? 'Deriving…' : 'Derive schema from this table'}
                </Button>
                <Caption1 className={s.hint}>Reads the live table schema from Azure Data Explorer and fills the designer — annotations you already wrote are kept.</Caption1>
              </div>
              <Caption1 className={s.hint}>Save the contract after changing the binding so validation runs against the persisted table.</Caption1>
            </Card>

            <ContractQualityRunPanel id={id} endpoint={`/api/items/data-contract/${encodeURIComponent(id)}/quality`} reloadKey={savedVersion} dirty={dirty} />

            {/* ── N6: ODCS 3.1 registration, enforcement posture, bindings ─── */}
            <DataContractOdcsPanel id={id} reloadKey={savedVersion} />

            {/* ── Where this contract is enforced ───────────────────────────── */}
            <MessageBar intent="info" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle><LinkRegular /> Enforcing this contract</MessageBarTitle>
                Bind an ingestion path above (mirroring engine, pipeline sink, or eventstream) and Loom applies this contract to every batch:
                conforming rows land, violating rows are quarantined to the Bronze <code>_rejected</code> dead-letter path and alerted.
                Separately, binding this contract to a data product (its <code>dataContractId</code>) enforces the error-severity expectations at
                that product&apos;s publish time (BR-CONTRACT-GATE).
              </MessageBarBody>
            </MessageBar>
          </>
        )}
        <Divider />
        <Caption1 className={s.hint}>Everything above is authored from typed controls and persisted to the item&apos;s Cosmos state. Validation runs real KQL against the bound Azure Data Explorer table.</Caption1>
      </div>
    } />
  );
}
