'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * PermissionMatrix — Loom-native role grant UI for Unity Catalog +
 * Fabric/OneLake. The user picks (source, securable, principal, role) and
 * the BFF fans out to the right back-end privileges automatically.
 *
 * No fake principals, no mocked grants — every submit POSTs to
 * /api/catalog/permissions and surfaces the response in a live audit log.
 *
 * Web-3.0 layout (per docs/fiab/design/ui-web3-guide.md):
 *   • A left gutter so nothing butts the CatalogShell sidebar's vertical rule.
 *   • Grant form + Audit log each wrapped in a <Section> — real vertical
 *     rhythm, never smushed together.
 *   • Form fields are Field-wrapped (label + hint), laid out on a responsive
 *     grid with Fluent spacing tokens, and capped in width (never full-bleed).
 *   • Buttons sit in a spaced toolbar row, right-aligned, with real gaps.
 *   • The audit log renders in <LoomDataTable> (sort + resize + per-column
 *     filter) — no dense hand-rolled list butting its borders.
 */
import { useMemo, useState } from 'react';
import {
  Input, Button, Spinner, Dropdown, Option, Field, Switch,
  Badge, Text, Caption1, makeStyles, tokens,
} from '@fluentui/react-components';
import { CheckmarkCircle24Regular, DismissCircle24Regular } from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { loomDocUrl } from '@/lib/learn/content';

const useStyles = makeStyles({
  // left gutter so content never touches the sidebar's vertical rule
  gutter: {
    paddingLeft: tokens.spacingHorizontalL,
  },
  intro: {
    color: tokens.colorNeutralForeground2,
    marginBottom: tokens.spacingVerticalL,
    maxWidth: '720px',
  },
  // responsive two-up grid; fields cap their own width inside
  formGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    columnGap: tokens.spacingHorizontalXXL,
    rowGap: tokens.spacingVerticalL,
    alignItems: 'start',
  },
  // span both columns on the responsive grid
  full: {
    gridColumn: '1 / -1',
  },
  // capped-width controls so nothing stretches full-bleed
  control: {
    maxWidth: '420px',
    width: '100%',
  },
  controlWide: {
    maxWidth: '640px',
    width: '100%',
  },
  // spaced, right-aligned button toolbar
  toolbar: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
    justifyContent: 'flex-end',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginTop: tokens.spacingVerticalXL,
    paddingTop: tokens.spacingVerticalL,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  spinnerRow: {
    marginRight: 'auto',
  },
  // audit log cells
  actionCell: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  ok: { color: tokens.colorPaletteGreenForeground1, flexShrink: 0 },
  err: { color: tokens.colorPaletteRedForeground1, flexShrink: 0 },
  detailOk: { color: tokens.colorNeutralForeground2 },
  detailErr: { color: tokens.colorPaletteRedForeground1 },
  ts: { color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap' },
});

interface LogEntry {
  id: string;
  ts: string;
  ok: boolean;
  action: string;
  detail: string;
}

const LOOM_ROLES = ['Reader', 'Contributor', 'Admin', 'Owner'];
const UC_SEC_TYPES = ['CATALOG', 'SCHEMA', 'TABLE', 'VOLUME'];
const FABRIC_PRINCIPAL_TYPES = ['User', 'Group', 'ServicePrincipal'];

export function PermissionMatrix() {
  const s = useStyles();
  const [source, setSource] = useState<'unity-catalog' | 'onelake'>('unity-catalog');
  const [secType, setSecType] = useState('CATALOG');
  const [securable, setSecurable] = useState('');
  const [host, setHost] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [principal, setPrincipal] = useState('');
  const [principalType, setPrincipalType] = useState('User');
  const [role, setRole] = useState('Reader');
  const [useSQL, setUseSQL] = useState(false);
  const [warehouseId, setWarehouseId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);

  async function submit(action: 'POST' | 'DELETE') {
    setSubmitting(true);
    const body: any = { source, loomRole: role, principal };
    if (source === 'unity-catalog') {
      body.host = host; body.secType = secType; body.securable = securable;
      if (useSQL) { body.useSQL = true; body.warehouseId = warehouseId; }
    } else {
      body.workspaceId = workspaceId; body.principalType = principalType;
    }
    try {
      const r = await clientFetch('/api/catalog/permissions', {
        method: action,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      setLog((prev) => [{
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toISOString(),
        ok: !!j.ok,
        action: `${action === 'POST' ? 'GRANT' : 'REVOKE'} ${role} on ${source === 'unity-catalog' ? `${secType} ${securable}` : `workspace ${workspaceId}`} to ${principal}`,
        detail: j.ok ? `mode=${j.mode}${j.role ? ` role=${j.role}` : ''}` : j.error,
      }, ...prev].slice(0, 50));
    } catch (e: any) {
      setLog((prev) => [{
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toISOString(),
        ok: false,
        action: `${action} failed`,
        detail: e?.message || String(e),
      }, ...prev].slice(0, 50));
    } finally { setSubmitting(false); }
  }

  const logColumns: LoomColumn<LogEntry>[] = useMemo(() => [
    {
      key: 'action',
      label: 'Action',
      width: 420,
      minWidth: 240,
      getValue: (e) => e.action,
      render: (e) => (
        <span className={s.actionCell}>
          {e.ok
            ? <CheckmarkCircle24Regular className={s.ok} />
            : <DismissCircle24Regular className={s.err} />}
          <Text weight="semibold">{e.action}</Text>
        </span>
      ),
    },
    {
      key: 'detail',
      label: 'Result',
      width: 280,
      minWidth: 160,
      getValue: (e) => e.detail,
      render: (e) => (
        <Text className={e.ok ? s.detailOk : s.detailErr}>{e.detail}</Text>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      width: 120,
      minWidth: 100,
      getValue: (e) => (e.ok ? 'Success' : 'Failed'),
      render: (e) => (
        <Badge appearance="tint" color={e.ok ? 'success' : 'danger'} size="small">
          {e.ok ? 'Success' : 'Failed'}
        </Badge>
      ),
    },
    {
      key: 'ts',
      label: 'Time',
      width: 220,
      minWidth: 160,
      getValue: (e) => e.ts,
      render: (e) => <Caption1 className={s.ts}>{e.ts}</Caption1>,
    },
  ], [s]);

  return (
    <div className={s.gutter}>
      {/* ── Grant a role ───────────────────────────────────────────── */}
      <Section title="Grant a role">
        <Text as="p" className={s.intro}>
          Pick a securable, a principal, and a Loom role. Loom maps the role to
          Unity Catalog privileges or Fabric workspace roles per the table in{' '}
          <a href={loomDocUrl('fiab/catalog/permissions')} target="_blank" rel="noreferrer">docs</a>.
        </Text>

        <div className={s.formGrid}>
          <Field label="Source" hint="Which governed store to grant against.">
            <Dropdown
              className={s.control}
              value={source === 'unity-catalog' ? 'Databricks Unity Catalog' : 'Fabric / OneLake'}
              onOptionSelect={(_, d) => setSource(d.optionValue as any)}
              selectedOptions={[source]}
            >
              <Option value="unity-catalog">Databricks Unity Catalog</Option>
              <Option value="onelake">Fabric / OneLake</Option>
            </Dropdown>
          </Field>

          <Field label="Loom role" hint="Mapped to back-end privileges automatically.">
            <Dropdown
              className={s.control}
              value={role}
              onOptionSelect={(_, d) => setRole(d.optionValue as any)}
              selectedOptions={[role]}
            >
              {LOOM_ROLES.map((r) => <Option key={r} value={r}>{r}</Option>)}
            </Dropdown>
          </Field>

          {source === 'unity-catalog' ? (
            <>
              <Field
                label="Workspace hostname"
                hint="e.g. adb-1234567890.12.azuredatabricks.net"
              >
                <Input className={s.control} value={host} onChange={(_, d) => setHost(d.value)} placeholder="adb-….azuredatabricks.net" />
              </Field>

              <Field label="Securable type" hint="The Unity Catalog object class.">
                <Dropdown
                  className={s.control}
                  value={secType}
                  onOptionSelect={(_, d) => setSecType(d.optionValue as any)}
                  selectedOptions={[secType]}
                >
                  {UC_SEC_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
                </Dropdown>
              </Field>

              <Field
                className={s.full}
                label={`${secType} full name`}
                hint="Three-level name, e.g. main.bronze.customers"
              >
                <Input className={s.controlWide} value={securable} onChange={(_, d) => setSecurable(d.value)} placeholder="main.bronze.customers" />
              </Field>

              <Field
                label="SQL warehouse fan-out"
                hint="Issue real GRANT statements via a running warehouse."
              >
                <Switch
                  checked={useSQL}
                  onChange={(_, d) => setUseSQL(d.checked)}
                  label={useSQL ? 'Enabled' : 'Disabled'}
                />
              </Field>

              {useSQL && (
                <Field label="Warehouse id" hint="Must be a running SQL warehouse.">
                  <Input className={s.control} value={warehouseId} onChange={(_, d) => setWarehouseId(d.value)} placeholder="0123456789abcdef" />
                </Field>
              )}
            </>
          ) : (
            <>
              <Field
                className={s.full}
                label="Workspace id (Fabric)"
                hint="The GUID of the target Fabric workspace."
              >
                <Input className={s.controlWide} value={workspaceId} onChange={(_, d) => setWorkspaceId(d.value)} placeholder="11111111-2222-3333-4444-555555555555" />
              </Field>

              <Field label="Principal type" hint="How the principal is resolved in Entra.">
                <Dropdown
                  className={s.control}
                  value={principalType}
                  onOptionSelect={(_, d) => setPrincipalType(d.optionValue as any)}
                  selectedOptions={[principalType]}
                >
                  {FABRIC_PRINCIPAL_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
                </Dropdown>
              </Field>
            </>
          )}

          <Field
            className={s.full}
            label="Principal"
            hint="UPN, group object id, or service-principal app id."
          >
            <Input className={s.controlWide} value={principal} onChange={(_, d) => setPrincipal(d.value)} placeholder="alice@contoso.com" />
          </Field>
        </div>

        <div className={s.toolbar}>
          {submitting && (
            <span className={s.spinnerRow}>
              <Spinner size="tiny" label="Updating permissions…" labelPosition="after" />
            </span>
          )}
          <Button onClick={() => submit('DELETE')} disabled={submitting || !principal} appearance="secondary">Revoke</Button>
          <Button onClick={() => submit('POST')} disabled={submitting || !principal} appearance="primary">Grant</Button>
        </div>
      </Section>

      {/* ── Audit log ──────────────────────────────────────────────── */}
      {log.length > 0 && (
        <Section title="Audit log (session)">
          <LoomDataTable<LogEntry>
            columns={logColumns}
            rows={log}
            getRowId={(e) => e.id}
            ariaLabel="Permission change audit log"
            empty="No permission changes yet this session."
          />
        </Section>
      )}
    </div>
  );
}
