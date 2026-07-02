'use client';

/**
 * ConnectionDetailsPanel — surface server hostname, HTTP path / database,
 * JDBC URL, and a CLI snippet per SQL engine, each with a copy button. Read-only
 * by design (no free-form connection-string editing, per loom_no_freeform_config).
 *
 * Engines:
 *   databricks-sql-warehouse      — odbc_params.hostname + .path from the warehouse REST API
 *   synapse-serverless-sql-pool   — <ws>-ondemand.<suffix> resolved server-side
 *   synapse-dedicated-sql-pool    — <ws>.<suffix> / <pool> resolved server-side
 *
 * Gov endpoints surface the Gov suffix (`*.usgovcloudapi.net`) in the JDBC URL —
 * the BFF resolves it via synapseSqlSuffix() / synapseSqlJdbcHostCert(), so no
 * cloud branching lives in the component.
 *
 * No-vaporware: every value comes from the real BFF route (/api/items/<engine>/
 * <id>/connection). When the engine is unconfigured or a warehouse hasn't
 * provisioned its ODBC endpoint, the panel shows an honest Fluent MessageBar
 * naming the exact env var / action — never a placeholder string.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Subtitle2,
  Caption1,
  Badge,
  Button,
  Spinner,
  Field,
  Input,
  Textarea,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  Copy16Regular,
  LockClosed16Regular,
  ArrowSync16Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalL,
    padding: tokens.spacingVerticalL,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  fieldRow: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
  },
  inputWide: { flexGrow: 1 },
  codeBlock: {
    flexGrow: 1,
    margin: 0,
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    fontSize: tokens.fontSizeBase200,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
  authBadge: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
  },
});

export type ConnectionEngine =
  | 'databricks-sql-warehouse'
  | 'synapse-serverless-sql-pool'
  | 'synapse-dedicated-sql-pool';

interface ConnectionDetails {
  engine: ConnectionEngine;
  hostname: string;
  httpPath?: string; // Databricks only
  database?: string; // Synapse only
  port: number;
  jdbcUrl: string;
  cliSnippet: string;
  authMode: string;
  warehouseName?: string;
}

interface LoadError {
  message: string;
  code?: string;
  missing?: string;
}

interface Props {
  engine: ConnectionEngine;
  /** Item id (route segment). */
  id: string;
  /** Pin a specific Databricks warehouse. */
  warehouseId?: string;
  /** Override the Synapse Serverless database (defaults to `master`). */
  database?: string;
}

function copyToClipboard(text: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    void navigator.clipboard.writeText(text).catch(() => {
      /* clipboard may be blocked by the browser; nothing else to do */
    });
  }
}

export function ConnectionDetailsPanel({ engine, id, warehouseId, database }: Props) {
  const s = useStyles();
  const [details, setDetails] = useState<ConnectionDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (warehouseId) params.set('warehouseId', warehouseId);
      if (database) params.set('database', database);
      const qs = params.toString();
      const res = await fetch(
        `/api/items/${engine}/${encodeURIComponent(id)}/connection${qs ? `?${qs}` : ''}`,
      );
      const j = await res.json();
      if (!j.ok) {
        setError({ message: j.error || 'Failed to load connection details', code: j.code, missing: j.missing });
      } else {
        setDetails(j as ConnectionDetails);
      }
    } catch (e: any) {
      setError({ message: e?.message || String(e) });
    } finally {
      setLoading(false);
    }
  }, [engine, id, warehouseId, database]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Spinner size="small" label="Loading connection details…" />;

  if (error) {
    if (error.code === 'not_configured') {
      return (
        <div className={s.root}>
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Engine not configured</MessageBarTitle>
              {error.message}
              {error.missing ? (
                <>
                  {' '}Set <code>{error.missing}</code> on the console container app.
                </>
              ) : null}
            </MessageBarBody>
          </MessageBar>
        </div>
      );
    }
    if (error.code === 'odbc_params_unavailable') {
      return (
        <div className={s.root}>
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Connection details unavailable</MessageBarTitle>
              {error.message}
            </MessageBarBody>
            <Button size="small" appearance="transparent" icon={<ArrowSync16Regular />} onClick={() => void load()}>
              Retry
            </Button>
          </MessageBar>
        </div>
      );
    }
    return (
      <div className={s.root}>
        <MessageBar intent="error">
          <MessageBarBody>{error.message}</MessageBarBody>
          <Button size="small" appearance="transparent" icon={<ArrowSync16Regular />} onClick={() => void load()}>
            Retry
          </Button>
        </MessageBar>
      </div>
    );
  }

  if (!details) return null;

  const isDbx = engine === 'databricks-sql-warehouse';
  const isSynapse = engine.startsWith('synapse-');

  return (
    <div className={s.root}>
      <div className={s.header}>
        <Subtitle2>{details.warehouseName || 'Connection details'}</Subtitle2>
        <Tooltip content="Refresh" relationship="label">
          <Button
            size="small"
            appearance="subtle"
            icon={<ArrowSync16Regular />}
            aria-label="Refresh connection details"
            onClick={() => void load()}
          />
        </Tooltip>
      </div>

      <Field label="Server / Hostname">
        <div className={s.fieldRow}>
          <Input className={s.inputWide} readOnly value={details.hostname} />
          <Tooltip content="Copy hostname" relationship="label">
            <Button
              size="small"
              appearance="subtle"
              icon={<Copy16Regular />}
              aria-label="Copy hostname"
              onClick={() => copyToClipboard(details.hostname)}
            />
          </Tooltip>
        </div>
      </Field>

      {isDbx && details.httpPath ? (
        <Field label="HTTP Path">
          <div className={s.fieldRow}>
            <Input className={s.inputWide} readOnly value={details.httpPath} />
            <Tooltip content="Copy HTTP path" relationship="label">
              <Button
                size="small"
                appearance="subtle"
                icon={<Copy16Regular />}
                aria-label="Copy HTTP path"
                onClick={() => copyToClipboard(details.httpPath as string)}
              />
            </Tooltip>
          </div>
        </Field>
      ) : null}

      {isSynapse && details.database ? (
        <Field label="Database">
          <div className={s.fieldRow}>
            <Input className={s.inputWide} readOnly value={details.database} />
            <Tooltip content="Copy database name" relationship="label">
              <Button
                size="small"
                appearance="subtle"
                icon={<Copy16Regular />}
                aria-label="Copy database name"
                onClick={() => copyToClipboard(details.database as string)}
              />
            </Tooltip>
          </div>
        </Field>
      ) : null}

      <Field label="Port">
        <Input readOnly value={String(details.port)} style={{ width: '120px' }} />
      </Field>

      <Field label="JDBC URL">
        <div className={s.fieldRow}>
          <Textarea className={s.inputWide} readOnly value={details.jdbcUrl} rows={3} />
          <Tooltip content="Copy JDBC URL" relationship="label">
            <Button
              size="small"
              appearance="subtle"
              icon={<Copy16Regular />}
              aria-label="Copy JDBC URL"
              onClick={() => copyToClipboard(details.jdbcUrl)}
            />
          </Tooltip>
        </div>
      </Field>

      <Field label="CLI snippet">
        <div className={s.fieldRow}>
          <pre className={s.codeBlock}>{details.cliSnippet}</pre>
          <Tooltip content="Copy CLI snippet" relationship="label">
            <Button
              size="small"
              appearance="subtle"
              icon={<Copy16Regular />}
              aria-label="Copy CLI snippet"
              onClick={() => copyToClipboard(details.cliSnippet)}
            />
          </Tooltip>
        </div>
      </Field>

      <div className={s.authBadge}>
        <LockClosed16Regular />
        <Caption1>{details.authMode}</Caption1>
        <Badge appearance="tint" color="informative" size="small">
          No passwords stored
        </Badge>
      </div>
    </div>
  );
}
