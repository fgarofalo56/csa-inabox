'use client';

/**
 * SqlRestorePanel — the "Restore" surface for Azure SQL Database, one-for-one
 * with the portal's "Create SQL Database - Restore database" blade (per
 * ui-parity.md). Pure Azure SQL control plane — no Microsoft Fabric dependency.
 *
 * Surfaces:
 *   • The REAL restorable window from ARM (properties.earliestRestoreDate → now).
 *   • A source selector: this database (point-in-time) OR a dropped database
 *     still within retention (restorableDroppedDatabases — real ARM list).
 *   • A time picker constrained to the window bounds.
 *   • A target database name (a restore always creates a NEW database; the name
 *     is validated against the live database list + Azure SQL naming rules via
 *     the shared pure validator).
 *   • "Restore" POSTs to /api/items/azure-sql-database/[id]/restore, which
 *     issues the ARM PUT (createMode=PointInTimeRestore / Restore) and returns
 *     the async-operation URL; the panel then POLLS the operation to completion
 *     and shows the live LRO status.
 *
 * The only non-functional state is an honest Fluent MessageBar gate: a 403
 * (UAMI lacks "SQL DB Contributor") surfaces the role to grant / bicep module.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Subtitle2, Caption1, Body1, Badge, Button, Spinner, Field, Input, Dropdown, Option,
  RadioGroup, Radio, ProgressBar,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { DatabaseArrowRight20Regular, History20Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import {
  validateRestoreRequest, defaultRestorePoint, normalizeRestoreStatus,
  type RestorableWindow, type RestoreStatus,
} from '@/lib/azure/sql-restore-model';

// ── content-type-guarded clientFetch → JSON (carries session cookie + 6s cap) ──
async function fetchJson(input: string, init?: RequestInit): Promise<any> {
  let r: Response;
  try {
    r = await clientFetch(input, init);
  } catch (e: any) {
    return { ok: false, status: 0, error: e?.message || String(e) };
  }
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await r.text().catch(() => '');
    return {
      ok: false,
      status: r.status,
      error:
        `Expected JSON from ${input} but received ${ct || 'an unknown content type'} (HTTP ${r.status}). ` +
        (r.status === 401 || r.status === 403
          ? 'Your session may have expired — sign in again.'
          : `First bytes: ${text.slice(0, 120)}`),
    };
  }
  try { return await r.json(); }
  catch (e: any) { return { ok: false, status: r.status, error: `Malformed JSON from ${input}: ${e?.message || String(e)}` }; }
}

interface DroppedDb {
  id: string;
  databaseName: string;
  deletionDate?: string;
  earliestRestoreDate?: string;
}

const useStyles = makeStyles({
  pad: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  card: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacingVerticalM },
  mono: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200 },
  windowRow: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
});

export interface SqlRestorePanelProps {
  id: string;
  server: string;
  database: string;
  /** Live database names on the server — the restore target must not collide. */
  existingNames?: string[];
}

/** Convert an ISO string to the value a <input type="datetime-local"> expects
 *  (local wall-clock, no seconds/zone). */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SqlRestorePanel({ id, server, database, existingNames }: SqlRestorePanelProps) {
  const s = useStyles();

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [window, setWindow] = useState<RestorableWindow | null>(null);
  const [dropped, setDropped] = useState<DroppedDb[]>([]);

  const [sourceKind, setSourceKind] = useState<'live' | 'dropped'>('live');
  const [droppedId, setDroppedId] = useState<string>('');
  const [restorePoint, setRestorePoint] = useState<string>(''); // datetime-local value
  const [target, setTarget] = useState<string>('');

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<RestoreStatus | null>(null);
  const [statusRaw, setStatusRaw] = useState<string>('');
  const [opError, setOpError] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const encId = encodeURIComponent(id);

  // Load window + dropped list on server/database change.
  const load = useCallback(async () => {
    if (!server || !database) return;
    setLoading(true); setLoadError(null); setGate(null);
    const r = await fetchJson(
      `/api/items/azure-sql-database/${encId}/restore?server=${encodeURIComponent(server)}&database=${encodeURIComponent(database)}`,
    );
    setLoading(false);
    if (r?.ok === false) {
      if (r.status === 403 || /SQL DB Contributor/i.test(r.error || '')) setGate(r.error || 'Permission required');
      else setLoadError(r.error || 'Failed to load the restorable window');
      return;
    }
    setWindow(r.window || null);
    setDropped(Array.isArray(r.droppedDatabases) ? r.droppedDatabases : []);
    // Seed the picker + a sensible default target name.
    if (r.window) setRestorePoint(toLocalInput(defaultRestorePoint(r.window)));
    setTarget((t) => t || `${database}_restore`);
  }, [server, database, encId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { if (pollTimer.current) clearInterval(pollTimer.current); }, []);

  const selectedDropped = useMemo(() => dropped.find((d) => d.id === droppedId), [dropped, droppedId]);

  // ISO restore point derived from the local-time input.
  const restorePointIso = useMemo(() => {
    if (!restorePoint) return '';
    const d = new Date(restorePoint);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }, [restorePoint]);

  const validation = useMemo(() => {
    if (sourceKind === 'dropped') {
      // No live window bound for a dropped restore (ARM validates its own
      // retention); validate the target name + restore point presence only.
      return validateRestoreRequest({
        window: window || undefined,
        restorePointInTime: restorePointIso,
        targetDatabase: target,
        existingNames,
        // don't compare against source db name for dropped restores
      });
    }
    return validateRestoreRequest({
      window: window || undefined,
      restorePointInTime: restorePointIso,
      targetDatabase: target,
      existingNames,
      sourceDatabase: database,
    });
  }, [sourceKind, window, restorePointIso, target, existingNames, database]);

  const canRestore = validation.ok && !busy && (sourceKind === 'live' || !!droppedId)
    && status !== 'InProgress';

  const poll = useCallback((op: string | undefined, targetDb: string) => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = setInterval(async () => {
      const qs = new URLSearchParams({ server, mode: 'status' });
      if (op) qs.set('op', op); else qs.set('target', targetDb);
      const r = await fetchJson(`/api/items/azure-sql-database/${encId}/restore?${qs.toString()}`);
      if (r?.ok === false) return; // transient — keep polling
      const st = normalizeRestoreStatus(r.status);
      setStatus(st);
      setStatusRaw(r.raw || r.status || '');
      if (r.opError) setOpError(r.opError);
      if (st === 'Succeeded' || st === 'Failed') {
        if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
        setBusy(false);
      }
    }, 5000);
  }, [server, encId]);

  const startRestore = useCallback(async () => {
    setBusy(true); setStatus('InProgress'); setStatusRaw('Creating'); setOpError(null); setGate(null);
    const body: any = { server, targetDatabase: target, restorePointInTime: restorePointIso, existingNames };
    if (sourceKind === 'dropped' && selectedDropped) {
      body.restorableDroppedDatabaseId = selectedDropped.id;
      if (selectedDropped.deletionDate) body.sourceDatabaseDeletionDate = selectedDropped.deletionDate;
    } else {
      body.sourceDatabase = database;
    }
    const r = await fetchJson(`/api/items/azure-sql-database/${encId}/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (r?.ok === false) {
      setBusy(false); setStatus(null);
      if (r.status === 403 || r.hint) setGate(r.error || 'Permission required');
      else setOpError(r.error || 'Restore failed to start');
      return;
    }
    // Started — poll the LRO to completion.
    poll(r.asyncOperationUrl, target);
  }, [server, target, restorePointIso, existingNames, sourceKind, selectedDropped, database, encId, poll]);

  if (!server || !database) {
    return (
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>No database selected</MessageBarTitle>
          Pick an Azure SQL server and database on the <strong>Connect</strong> tab to see its restorable
          window and create a point-in-time restore.
        </MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <div className={s.pad}>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Restore — ARM Microsoft.Sql/servers/databases (PointInTimeRestore)</MessageBarTitle>
          Restore this database to an earlier point in time within its backup-retention window, or restore a
          dropped database. Each restore creates a <strong>new</strong> database on this server (Azure SQL never
          restores in place). Requires the console UAMI to hold <code>SQL DB Contributor</code> on the server&apos;s
          resource group.
        </MessageBarBody>
      </MessageBar>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Restore permission missing</MessageBarTitle>
            {gate}
            {' '}Grant the console UAMI <code>SQL DB Contributor</code> (role id{' '}
            <code>9b7fa17d-e63e-47b0-bb0a-15c516ac86ec</code>) on the server&apos;s resource group, or deploy{' '}
            <code>platform/fiab/bicep/modules/admin-plane/sql-rbac.bicep</code> by setting <code>loomAzureSqlServerRg</code>.
          </MessageBarBody>
        </MessageBar>
      )}
      {loadError && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Could not load restore info</MessageBarTitle>{loadError}</MessageBarBody></MessageBar>
      )}

      <div className={s.card}>
        <Subtitle2><History20Regular style={{ verticalAlign: 'middle' }} /> Restorable window</Subtitle2>
        {loading ? <Spinner size="tiny" label="Reading ARM…" labelPosition="after" /> : (
          window ? (
            <div className={s.windowRow}>
              <Badge appearance="outline" color="brand">Earliest: <span className={s.mono}>{new Date(window.earliestRestoreDate).toLocaleString()}</span></Badge>
              <Badge appearance="outline" color="brand">Latest: <span className={s.mono}>{new Date(window.latestRestoreDate).toLocaleString()}</span></Badge>
              <Button size="small" appearance="subtle" onClick={() => void load()}>Refresh</Button>
            </div>
          ) : (
            <Caption1>No restorable point published for this database yet (ARM reported no earliestRestoreDate — the database may be brand new). Dropped-database restore is still available below if any exist.</Caption1>
          )
        )}
      </div>

      <div className={s.card}>
        <Subtitle2>Source</Subtitle2>
        <RadioGroup value={sourceKind} onChange={(_, d) => setSourceKind(d.value as 'live' | 'dropped')} layout="horizontal">
          <Radio value="live" label={`This database (${database})`} />
          <Radio value="dropped" label={`Dropped database (${dropped.length})`} disabled={dropped.length === 0} />
        </RadioGroup>

        {sourceKind === 'dropped' && (
          <Field label="Dropped database to restore">
            <Dropdown
              selectedOptions={droppedId ? [droppedId] : []}
              value={selectedDropped ? `${selectedDropped.databaseName} (deleted ${selectedDropped.deletionDate ? new Date(selectedDropped.deletionDate).toLocaleString() : '—'})` : ''}
              onOptionSelect={(_, d) => setDroppedId(d.optionValue || '')}
              placeholder="Select a dropped database"
              aria-label="Dropped database"
            >
              {dropped.map((d) => (
                <Option key={d.id} value={d.id}>
                  {`${d.databaseName} — deleted ${d.deletionDate ? new Date(d.deletionDate).toLocaleString() : '—'}`}
                </Option>
              ))}
            </Dropdown>
          </Field>
        )}

        <div className={s.grid}>
          <Field
            label="Restore point in time"
            validationState={validation.ok || !restorePoint ? 'none' : 'error'}
            validationMessage={!validation.ok && restorePoint && /restore point/i.test(validation.error || '') ? validation.error : undefined}
          >
            <Input
              type="datetime-local"
              value={restorePoint}
              onChange={(_, d) => setRestorePoint(d.value)}
              min={window ? toLocalInput(window.earliestRestoreDate) : undefined}
              max={window ? toLocalInput(window.latestRestoreDate) : undefined}
              aria-label="Restore point in time"
            />
          </Field>
          <Field
            label="Restore to new database"
            validationState={validation.ok || !target ? 'none' : 'error'}
            validationMessage={!validation.ok && target && /database|name/i.test(validation.error || '') ? validation.error : undefined}
          >
            <Input value={target} onChange={(_, d) => setTarget(d.value)} placeholder={`${database}_restore`} aria-label="Target database name" />
          </Field>
        </div>

        <Button
          appearance="primary"
          icon={busy ? <Spinner size="tiny" /> : <DatabaseArrowRight20Regular />}
          disabled={!canRestore}
          onClick={startRestore}
        >
          {busy || status === 'InProgress' ? 'Restoring…' : 'Restore'}
        </Button>
        {!validation.ok && (target || restorePoint) && (
          <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{validation.error}</Caption1>
        )}
      </div>

      {/* LRO status */}
      {status && (
        status === 'Succeeded' ? (
          <MessageBar intent="success">
            <MessageBarBody>
              <MessageBarTitle>Restore complete</MessageBarTitle>
              Database <span className={s.mono}>{target}</span> was restored and is online. It appears in the
              database list on the Connect tab — it is a new, independent database (the source is unchanged).
            </MessageBarBody>
          </MessageBar>
        ) : status === 'Failed' ? (
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>Restore failed</MessageBarTitle>
              {opError || 'The restore operation reported a failure. Check the source/target names, the restore point, and that the target name is unique.'}
            </MessageBarBody>
          </MessageBar>
        ) : (
          <div className={s.card}>
            <Subtitle2>Restore in progress</Subtitle2>
            <ProgressBar />
            <Caption1>
              Creating <span className={s.mono}>{target}</span> from the {sourceKind === 'dropped' ? 'dropped database' : 'point-in-time backup'} —{' '}
              status <strong>{statusRaw || 'Creating'}</strong>. A restore can take several minutes; this polls ARM
              until it settles (you can leave this tab and come back).
            </Caption1>
          </div>
        )
      )}

      <Caption1>
        <Body1 as="span"></Body1>
        Point-in-time restore uses Azure SQL&apos;s automated backups — no Microsoft Fabric, no Power BI. To make
        the restored database a replacement, rename the original and rename the restore to the original name (ALTER DATABASE).
      </Caption1>
    </div>
  );
}
