'use client';

/**
 * ConnectionPicker — the shared control for REUSING a saved, Key Vault-backed
 * Loom Connection anywhere in Loom. Reads the caller's connections via
 * {@link useConnections}, renders them in a Fluent Dropdown (type icon + host),
 * and (optionally) offers an inline "New connection…" that opens the
 * {@link ConnectionBuilder} so a user can add one without leaving the surface.
 *
 * Consumers: notebook "read from connection", the lakehouse shortcut builder,
 * pipeline linked services, and the report Get-Data recent-connections list all
 * bind a connection through this ONE control — enter creds once, pick everywhere.
 *
 * Real backend only (no-vaporware): the list is the live GET /api/connections;
 * an empty / error state is honest (never a mock). Fluent v9 + Loom tokens; no
 * hard-coded px / hex (web3-ui).
 */

import { useCallback, useMemo, useState } from 'react';
import {
  Dropdown, Option, Field, Spinner, Badge, Caption1, Button,
  MessageBar, MessageBarBody, makeStyles, tokens,
} from '@fluentui/react-components';
import { Add16Regular, PlugConnected20Regular } from '@fluentui/react-icons';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { CONN_TILE_SLUG, CONN_TYPE_LABEL } from '@/lib/azure/connectable-types';
import type { ConnectionType } from '@/lib/azure/connections-store';
import { useConnections, type SavedConnection } from './use-connections';
import { ConnectionBuilder, type ConnectionView } from './connection-builder';

const useStyles = makeStyles({
  optionRow: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  optionMeta: { color: tokens.colorNeutralForeground3, marginInlineStart: tokens.spacingHorizontalXS },
  addRow: { display: 'flex', justifyContent: 'flex-end', marginTop: tokens.spacingVerticalXS },
  loadingRow: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS, padding: tokens.spacingVerticalXS },
  typeIcon: { fontSize: tokens.fontSizeBase400, flexShrink: 0 },
});

export interface ConnectionPickerProps {
  /** Currently-selected connection id (controlled). */
  value?: string;
  /** Fires with the picked connection (or null when cleared). */
  onSelect: (conn: SavedConnection | null) => void;
  /** Restrict the list to these connection types (e.g. SQL-only surfaces). */
  types?: readonly ConnectionType[];
  /** Field label (default "Connection"). */
  label?: string;
  /** Field-level required flag. */
  required?: boolean;
  /** Show the inline "New connection…" builder trigger (default true). */
  allowCreate?: boolean;
  /** Only pre-select this type when the inline builder is opened. */
  createDefaultType?: ConnectionType;
  /** Optional hint under the field. */
  hint?: string;
  disabled?: boolean;
}

/**
 * A themed dropdown that binds a saved Loom Connection. `onSelect` yields the
 * full connection record (id + type + host…) so the caller can persist a
 * connectionId AND know its type for the object ref it will build.
 */
export function ConnectionPicker({
  value, onSelect, types, label = 'Connection', required, allowCreate = true,
  createDefaultType, hint, disabled,
}: ConnectionPickerProps) {
  const s = useStyles();
  const { connections, loading, error, reload } = useConnections(types);
  const [builderOpen, setBuilderOpen] = useState(false);

  const byId = useMemo(() => {
    const m = new Map<string, SavedConnection>();
    for (const c of connections || []) m.set(c.id, c);
    return m;
  }, [connections]);

  const selected = value ? byId.get(value) : undefined;

  const onOptionSelect = useCallback((_: unknown, data: { optionValue?: string }) => {
    const id = data.optionValue || '';
    onSelect(id ? (byId.get(id) || null) : null);
  }, [byId, onSelect]);

  // After an inline create, refresh the list and auto-select the new connection.
  const onCreated = useCallback(async (created: ConnectionView) => {
    await reload();
    onSelect({
      id: created.id, name: created.name, type: created.type as ConnectionType,
      authMethod: created.authMethod, hasSecret: created.hasSecret,
      host: created.host, database: created.database,
    });
  }, [reload, onSelect]);

  const list = connections || [];

  return (
    <>
      <Field label={label} required={required} hint={hint}>
        {loading && connections === null ? (
          <span className={s.loadingRow}><Spinner size="tiny" /> <Caption1>Loading connections…</Caption1></span>
        ) : (
          <Dropdown
            disabled={disabled}
            placeholder={list.length ? 'Pick a saved connection…' : 'No connections yet'}
            value={selected ? selected.name : ''}
            selectedOptions={selected ? [selected.id] : []}
            onOptionSelect={onOptionSelect}
            aria-label={label}
          >
            {list.map((c) => {
              const TypeIcon = itemVisual(CONN_TILE_SLUG[c.type] ?? c.type).icon;
              return (
                <Option key={c.id} value={c.id} text={c.name}>
                  <span className={s.optionRow}>
                    <TypeIcon className={s.typeIcon} />
                    <span>{c.name}</span>
                    <Badge appearance="tint" color="brand" size="small">{CONN_TYPE_LABEL[c.type] || c.type}</Badge>
                    {c.host && <span className={s.optionMeta}>{c.host}</span>}
                  </span>
                </Option>
              );
            })}
          </Dropdown>
        )}
      </Field>

      {error && (
        <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
      )}

      {!loading && list.length === 0 && !error && (
        <Caption1>
          No {types ? 'matching ' : ''}connections yet.{allowCreate ? ' Add one to get started.' : ' Create one on the Connections page first.'}
        </Caption1>
      )}

      {allowCreate && (
        <div className={s.addRow}>
          <Button size="small" appearance="secondary" icon={<Add16Regular />} onClick={() => setBuilderOpen(true)}>
            New connection…
          </Button>
        </div>
      )}

      {allowCreate && (
        <ConnectionBuilder
          open={builderOpen}
          lockType={createDefaultType}
          onClose={() => setBuilderOpen(false)}
          onCreated={(c) => { setBuilderOpen(false); void onCreated(c); }}
        />
      )}
    </>
  );
}

export default ConnectionPicker;
