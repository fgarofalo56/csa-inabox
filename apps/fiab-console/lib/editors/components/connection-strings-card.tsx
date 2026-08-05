/**
 * Connection-strings card for the unified SQL database editor's Connect tab —
 * driver-ready ADO.NET / JDBC / ODBC / PHP / Go strings for the selected
 * server + database, all password-free (Microsoft Entra Managed Identity).
 *
 * Extracted out of `unified-sql-database-editor.tsx` (WS-E monolith ratchet:
 * split by bounded context — this is a self-contained UI section). Purely
 * presentational: it owns only its own driver-tab + copied-flash state and
 * derives every string from the `fqdn` / `database` props.
 */
'use client';

import { useCallback, useMemo, useState } from 'react';
import { Button, Caption1, Subtitle2, Tab, TabList, Tooltip } from '@fluentui/react-components';
import { Copy20Regular, PlugConnected20Regular } from '@fluentui/react-icons';
import { buildConnectionStrings, getSqlHostSuffix } from './connection-strings-builder';

type ConnDriverKey = 'adonet' | 'jdbc' | 'odbc' | 'php' | 'go';

/** Style slice this card needs from the editor's shared `useSharedEditorStyles`. */
export interface ConnectionStringsCardStyles {
  connCard: string;
  connCodeWrap: string;
  connCode: string;
  connCopyBtn: string;
}

export function ConnectionStringsCard({ fqdn, database, s }: {
  /** Fully-qualified server host, e.g. `srv.database.windows.net`. */
  fqdn: string;
  /** Selected database name — empty renders the "pick a database" hint. */
  database: string;
  s: ConnectionStringsCardStyles;
}) {
  const [driver, setDriver] = useState<ConnDriverKey>('adonet');
  const [copied, setCopied] = useState<ConnDriverKey | null>(null);

  const strings = useMemo(
    () => (fqdn && database ? buildConnectionStrings({ fqdn, database }) : null),
    [fqdn, database],
  );

  const copy = useCallback(async (key: ConnDriverKey, value: string) => {
    await navigator.clipboard?.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }, []);

  const suffix = getSqlHostSuffix(fqdn);

  return (
    <div className={s.connCard}>
      <Subtitle2><PlugConnected20Regular style={{ verticalAlign: 'middle' }} /> Connection strings</Subtitle2>
      {!database ? (
        <Caption1>Select a database (left pane or a <strong>Connect</strong> button above) to generate driver-ready strings.</Caption1>
      ) : (
        <>
          <Caption1>
            FQDN: <code>{fqdn}</code> · DB: <code>{database}</code> · Auth: Microsoft Entra Managed Identity (password-free)
          </Caption1>
          <TabList size="small" selectedValue={driver} onTabSelect={(_, d) => setDriver(d.value as ConnDriverKey)}>
            <Tab value="adonet">ADO.NET</Tab>
            <Tab value="jdbc">JDBC</Tab>
            <Tab value="odbc">ODBC</Tab>
            <Tab value="php">PHP</Tab>
            <Tab value="go">Go</Tab>
          </TabList>
          {strings && (
            <div className={s.connCodeWrap}>
              <pre className={s.connCode}>{strings[driver]}</pre>
              <Tooltip content={copied === driver ? 'Copied!' : 'Copy to clipboard'} relationship="label">
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<Copy20Regular />}
                  aria-label={`Copy ${driver} connection string`}
                  className={s.connCopyBtn}
                  onClick={() => copy(driver, strings[driver])}
                />
              </Tooltip>
            </div>
          )}
          <Caption1>
            All strings use password-free Microsoft Entra authentication (Managed Identity / Default).
            Grant the connecting identity <code>db_datareader</code> / <code>db_datawriter</code> in the database via{' '}
            <code>CREATE USER [&lt;entra-principal&gt;] FROM EXTERNAL PROVIDER;</code>.
            {suffix.includes('usgovcloudapi') && (
              <> Gov cloud detected — endpoint suffix is <code>{suffix}</code> (GCC-High / IL5 / DoD).</>
            )}
          </Caption1>
        </>
      )}
    </div>
  );
}
