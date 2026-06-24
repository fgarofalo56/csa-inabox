'use client';

/**
 * CopySettingsTab — Copy activity "Settings" tab at ADF Studio parity.
 *
 * Real ADF Settings-tab capabilities (grounded in the Copy-activity schema,
 * api-version 2018-06-01, + the performance / fault-tolerance / log / preserve
 * feature docs:
 *   https://learn.microsoft.com/azure/templates/microsoft.datafactory/2018-06-01/factories/pipelines
 *   https://learn.microsoft.com/azure/data-factory/copy-activity-performance-features
 *   https://learn.microsoft.com/azure/data-factory/copy-activity-fault-tolerance
 *   https://learn.microsoft.com/azure/data-factory/copy-activity-log
 *   https://learn.microsoft.com/azure/data-factory/copy-activity-preserve-metadata):
 *
 *   Performance
 *     - Data integration units (Auto / 2…256)  → dataIntegrationUnits
 *     - Degree of copy parallelism             → parallelCopies
 *   Staging
 *     - Enable staging                          → enableStaging
 *     - Staging linked service / path / compress→ stagingSettings.{linkedServiceName,path,enableCompression}
 *   Fault tolerance
 *     - Skip incompatible rows                  → enableSkipIncompatibleRow
 *     - Log skipped rows store + path           → redirectIncompatibleRowSettings.{linkedServiceName,path}
 *     - Skip missing/forbidden files            → skipErrorFile.fileMissingOrForbidden
 *     - Skip inconsistent data                  → skipErrorFile.dataInconsistency
 *     - Abort on first failure                  → abortOnFirstFailure
 *   Logging
 *     - Enable logging                          → enableCopyActivityLog
 *     - Log level / reliable logging            → copyActivityLogSettings.{logLevel,enableReliableLogging}
 *     - Log store linked service / path         → logSettings.logLocationSettings.{linkedServiceName,path}
 *   Preserve
 *     - Preserve attributes / ACLs              → preserve[]  ('Attributes' / 'ACL')
 *   Data consistency
 *     - Verify data consistency                 → validateDataConsistency
 *     - Max concurrent connections (activity)   → maxConcurrentConnections
 *
 * Staging is constrained to Blob / ADLS Gen2 stores (an ADF rule), so that
 * picker is a filtered Dropdown over the real GET /api/adf/linked-services list.
 * The redirect-store and log-store pickers reuse the Wave-1 <LinkedServicePicker/>
 * (self-fetching select + "New linked service" gallery), so a user can pick OR
 * create the store inline. Every control writes the real `typeProperties` keys
 * the ARM Copy-activity PUT round-trips — no mocks, no freeform JSON (per
 * no-vaporware.md / loom-no-freeform-config).
 */

import {
  Field, Input, Switch, Select, Caption1, Subtitle2, Dropdown, Option,
  MessageBar, MessageBarBody, makeStyles, tokens,
} from '@fluentui/react-components';
import { LinkedServicePicker } from '../linked-service-gallery';
import { DIU_VALUES, STAGING_LINKED_SERVICE_TYPES } from '@/lib/pipeline/copy-activity-catalog';
import type { PipelineActivity } from '../types';
import type { AdfLinkedService } from '@/lib/azure/adf-client';

const useStyles = makeStyles({
  section: {
    display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  sub: {
    display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    marginLeft: tokens.spacingHorizontalM,
    paddingLeft: tokens.spacingHorizontalM,
    borderLeft: `${tokens.strokeWidthThick} solid ${tokens.colorNeutralStroke2}`,
  },
  hint: { color: tokens.colorNeutralForeground3 },
  sectionTop: { marginTop: tokens.spacingVerticalS },
});

export interface CopySettingsTabProps {
  activity: PipelineActivity;
  linkedServices: AdfLinkedService[];
  gateError?: string | null;
  onPatch: (patch: Partial<PipelineActivity>) => void;
}

export function CopySettingsTab({ activity, linkedServices, gateError, onPatch }: CopySettingsTabProps) {
  const s = useStyles();
  const tp = (activity.typeProperties || {}) as any;

  /** Shallow-merge keys into typeProperties (deleting keys set to undefined). */
  const patchTp = (patch: Record<string, unknown>) => {
    const next = { ...tp, ...patch };
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete next[k];
    onPatch({ typeProperties: next });
  };

  const staging = (tp.stagingSettings || {}) as any;
  const redirect = (tp.redirectIncompatibleRowSettings || {}) as any;
  const skipErrorFile = (tp.skipErrorFile || {}) as any;
  const logSettings = (tp.logSettings || {}) as any;
  const logLocation = (logSettings.logLocationSettings || {}) as any;
  const logActivity = (tp.copyActivityLogSettings || {}) as any;
  const preserve: string[] = Array.isArray(tp.preserve) ? tp.preserve : [];

  const stagingStores = linkedServices.filter((ls) => STAGING_LINKED_SERVICE_TYPES.has(ls.properties.type));

  const lsRef = (referenceName: string) =>
    referenceName ? { referenceName, type: 'LinkedServiceReference' } : undefined;

  /** Patch a nested settings object (drops it entirely when it becomes empty). */
  const patchNested = (key: string, current: Record<string, unknown>, patch: Record<string, unknown>) => {
    const next: Record<string, unknown> = { ...current, ...patch };
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete next[k];
    patchTp({ [key]: Object.keys(next).length ? next : undefined });
  };

  /** Toggle a value in the `preserve` string array. */
  const togglePreserve = (token: string, on: boolean) => {
    const next = on
      ? Array.from(new Set([...preserve, token]))
      : preserve.filter((p) => p !== token);
    patchTp({ preserve: next.length ? next : undefined });
  };

  return (
    <div className={s.section}>
      {/* ── Performance ── */}
      <Subtitle2>Performance</Subtitle2>
      <Caption1 className={s.hint}>Compute power and parallelism for the copy.</Caption1>
      <Field label="Data integration units (DIU)"
        hint="Compute power for the copy. Auto lets ADF pick the optimal value (2–256).">
        <Select
          value={tp.dataIntegrationUnits != null ? String(tp.dataIntegrationUnits) : ''}
          onChange={(_, d) => patchTp({ dataIntegrationUnits: d.value ? Number(d.value) : undefined })}>
          {DIU_VALUES.map((v) => (
            <option key={v || 'auto'} value={v}>{v === '' ? 'Auto' : v}</option>
          ))}
        </Select>
      </Field>
      <Field label="Degree of copy parallelism"
        hint="Max parallel read/write sessions (and partition parallelism). Blank = auto.">
        <Input type="number" min={1} value={tp.parallelCopies != null ? String(tp.parallelCopies) : ''}
          onChange={(_, d) => patchTp({ parallelCopies: d.value ? Number(d.value) : undefined })} />
      </Field>

      {/* ── Staging ── */}
      <Subtitle2 className={s.sectionTop}>Staging</Subtitle2>
      <Caption1 className={s.hint}>
        Stage data in Blob / ADLS Gen2 before the sink (required for e.g. Synapse PolyBase, Snowflake).
      </Caption1>
      <Field label="Enable staging">
        <Switch checked={!!tp.enableStaging}
          onChange={(_, d) => patchTp({
            enableStaging: d.checked,
            ...(d.checked ? {} : { stagingSettings: undefined }),
          })} />
      </Field>
      {tp.enableStaging && (
        <div className={s.sub}>
          {gateError && (
            <MessageBar intent="warning"><MessageBarBody>{gateError}</MessageBarBody></MessageBar>
          )}
          {stagingStores.length === 0 && !gateError && (
            <MessageBar intent="warning">
              <MessageBarBody>
                No Azure Blob Storage or ADLS Gen2 linked services found. Create one in the
                ribbon&apos;s <strong>Manage</strong> hub to use it as a staging store.
              </MessageBarBody>
            </MessageBar>
          )}
          <Field label="Staging linked service" required>
            <Dropdown
              placeholder={stagingStores.length ? 'Select a Blob / ADLS store' : 'No staging stores available'}
              value={staging.linkedServiceName?.referenceName || ''}
              selectedOptions={staging.linkedServiceName?.referenceName ? [staging.linkedServiceName.referenceName] : []}
              disabled={!stagingStores.length}
              onOptionSelect={(_, d) => patchTp({
                stagingSettings: { ...staging, linkedServiceName: lsRef(d.optionValue || '') },
              })}>
              {stagingStores.map((ls) => (
                <Option key={ls.name} value={ls.name} text={ls.name}>{ls.name}</Option>
              ))}
            </Dropdown>
          </Field>
          <Field label="Staging path" hint="Folder within the staging store. Blank = auto-created container.">
            <Input value={staging.path || ''} placeholder="staging"
              onChange={(_, d) => patchTp({ stagingSettings: { ...staging, path: d.value || undefined } })} />
          </Field>
          <Field label="Enable compression">
            <Switch checked={!!staging.enableCompression}
              onChange={(_, d) => patchTp({ stagingSettings: { ...staging, enableCompression: d.checked } })} />
          </Field>
        </div>
      )}

      {/* ── Fault tolerance ── */}
      <Subtitle2 className={s.sectionTop}>Fault tolerance</Subtitle2>
      <Caption1 className={s.hint}>
        Skip incompatible rows / forbidden / missing files instead of failing the copy.
      </Caption1>
      <Field label="Skip incompatible rows"
        hint="Skip rows whose source/sink types are incompatible instead of failing the copy.">
        <Switch checked={!!tp.enableSkipIncompatibleRow}
          onChange={(_, d) => patchTp({
            enableSkipIncompatibleRow: d.checked,
            ...(d.checked ? {} : { redirectIncompatibleRowSettings: undefined }),
          })} />
      </Field>
      {tp.enableSkipIncompatibleRow && (
        <div className={s.sub}>
          <Caption1 className={s.hint}>
            Optionally log the skipped rows to a Blob / ADLS store for later inspection.
          </Caption1>
          <LinkedServicePicker
            engine="adf"
            label="Log skipped rows to (linked service)"
            value={redirect.linkedServiceName?.referenceName || ''}
            onSelected={(name) => patchTp({
              redirectIncompatibleRowSettings: {
                ...redirect,
                linkedServiceName: lsRef(name),
              },
            })}
          />
          <Field label="Skipped-row log path" hint="Folder for the skipped-row log files.">
            <Input value={redirect.path || ''} placeholder="rejects"
              onChange={(_, d) => patchTp({ redirectIncompatibleRowSettings: { ...redirect, path: d.value || undefined } })} />
          </Field>
        </div>
      )}
      <Field label="Skip missing / forbidden files"
        hint="Continue when a source file is deleted or access is denied during the run (binary/file copy).">
        <Switch checked={!!skipErrorFile.fileMissingOrForbidden}
          onChange={(_, d) => patchNested('skipErrorFile', skipErrorFile, {
            fileMissingOrForbidden: d.checked || undefined,
          })} />
      </Field>
      <Field label="Skip inconsistent data"
        hint="Continue on file size / last-modified inconsistency between source and sink.">
        <Switch checked={!!skipErrorFile.dataInconsistency}
          onChange={(_, d) => patchNested('skipErrorFile', skipErrorFile, {
            dataInconsistency: d.checked || undefined,
          })} />
      </Field>
      <Field label="Abort on first failure"
        hint="Stop the activity on the first incompatible row instead of skipping (mutually exclusive with skip).">
        <Switch checked={!!tp.abortOnFirstFailure}
          onChange={(_, d) => patchTp({ abortOnFirstFailure: d.checked || undefined })} />
      </Field>

      {/* ── Logging ── */}
      <Subtitle2 className={s.sectionTop}>Logging</Subtitle2>
      <Caption1 className={s.hint}>
        Record per-file copy outcomes (session log) to a store for audit.
      </Caption1>
      <Field label="Enable logging">
        <Switch checked={!!tp.enableCopyActivityLog}
          onChange={(_, d) => patchTp({
            enableCopyActivityLog: d.checked,
            ...(d.checked ? {} : { copyActivityLogSettings: undefined, logSettings: undefined }),
          })} />
      </Field>
      {tp.enableCopyActivityLog && (
        <div className={s.sub}>
          <Field label="Log level" hint="Warning logs only failures; Info logs all copied files.">
            <Select
              value={logActivity.logLevel || 'Warning'}
              onChange={(_, d) => patchNested('copyActivityLogSettings', logActivity, {
                logLevel: d.value || undefined,
              })}>
              <option value="Warning">Warning (failures only)</option>
              <option value="Info">Info (all files)</option>
            </Select>
          </Field>
          <Field label="Reliable logging"
            hint="Guarantee log durability (lower throughput) vs. best-effort.">
            <Switch checked={!!logActivity.enableReliableLogging}
              onChange={(_, d) => patchNested('copyActivityLogSettings', logActivity, {
                enableReliableLogging: d.checked || undefined,
              })} />
          </Field>
          <LinkedServicePicker
            engine="adf"
            label="Log store (linked service)"
            required
            value={logLocation.linkedServiceName?.referenceName || ''}
            onSelected={(name) => patchTp({
              logSettings: {
                ...logSettings,
                logLocationSettings: { ...logLocation, linkedServiceName: lsRef(name) },
              },
            })}
          />
          <Field label="Log path" hint="Folder for the session log files.">
            <Input value={logLocation.path || ''} placeholder="copylogs"
              onChange={(_, d) => patchTp({
                logSettings: {
                  ...logSettings,
                  logLocationSettings: { ...logLocation, path: d.value || undefined },
                },
              })} />
          </Field>
        </div>
      )}

      {/* ── Preserve ── */}
      <Subtitle2 className={s.sectionTop}>Preserve</Subtitle2>
      <Caption1 className={s.hint}>
        Carry source metadata / ACLs through to the sink (Blob / ADLS / file stores).
      </Caption1>
      <Field label="Preserve attributes"
        hint="Preserve file attributes (owner, last-modified, etc.) onto the sink.">
        <Switch checked={preserve.includes('Attributes')}
          onChange={(_, d) => togglePreserve('Attributes', d.checked)} />
      </Field>
      <Field label="Preserve ACLs"
        hint="Preserve POSIX ACLs from an ADLS Gen1/Gen2 source onto an ADLS Gen2 sink.">
        <Switch checked={preserve.includes('ACL')}
          onChange={(_, d) => togglePreserve('ACL', d.checked)} />
      </Field>

      {/* ── Data consistency ── */}
      <Subtitle2 className={s.sectionTop}>Data consistency</Subtitle2>
      <Caption1 className={s.hint}>Verify the copy after it completes.</Caption1>
      <Field label="Enable data consistency verification"
        hint="After the copy, verify row count (tabular) or file size/checksum (binary) match between source and sink.">
        <Switch checked={!!tp.validateDataConsistency}
          onChange={(_, d) => patchTp({ validateDataConsistency: d.checked || undefined })} />
      </Field>
      <Field label="Max concurrent connections (activity)"
        hint="Cap concurrent connections across the whole activity. Blank = unlimited.">
        <Input type="number" min={1} value={tp.maxConcurrentConnections != null ? String(tp.maxConcurrentConnections) : ''}
          onChange={(_, d) => patchTp({ maxConcurrentConnections: d.value ? Number(d.value) : undefined })} />
      </Field>
    </div>
  );
}
