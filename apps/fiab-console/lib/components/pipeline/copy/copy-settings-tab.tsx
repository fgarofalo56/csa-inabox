'use client';

/**
 * CopySettingsTab — Copy activity "Settings" tab at ADF Studio parity.
 *
 * Real ADF Settings-tab capabilities (grounded in the Copy-activity schema,
 * api-version 2018-06-01,
 * https://learn.microsoft.com/azure/templates/microsoft.datafactory/2018-06-01/factories/pipelines):
 *   - Data integration units (Auto / 2…256, powers of two) → dataIntegrationUnits
 *   - Degree of copy parallelism → parallelCopies
 *   - Enable staging (+ staging linked service, path, compression) → enableStaging
 *     / stagingSettings.{linkedServiceName,path,enableCompression}
 *   - Fault tolerance: skip incompatible rows (+ redirect store + path) →
 *     enableSkipIncompatibleRow / redirectIncompatibleRowSettings.*
 *   - Data consistency verification → validateDataConsistency
 *
 * Staging + redirect linked-service pickers come from the real
 * GET /api/adf/linked-services list (via useCopyResources). ADF only accepts
 * Blob / ADLS Gen2 for staging, so that picker is filtered accordingly.
 */

import {
  Field, Input, Switch, Select, Caption1, Subtitle2, Dropdown, Option,
  MessageBar, MessageBarBody, makeStyles, tokens,
} from '@fluentui/react-components';
import type { PipelineActivity } from '../types';
import type { AdfLinkedService } from '@/lib/azure/adf-client';

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: '8px' },
  sub: {
    display: 'flex', flexDirection: 'column', gap: '8px',
    marginLeft: '12px', paddingLeft: '12px',
    borderLeft: `2px solid ${tokens.colorNeutralStroke2}`,
  },
});

/** Valid ADF Data Integration Unit values ('' = Auto). */
const DIU_VALUES = ['', '2', '4', '8', '16', '32', '48', '64', '80', '96', '128', '160', '192', '224', '256'];

/** Linked-service types ADF accepts as a staging store. */
const STAGING_TYPES = new Set(['AzureBlobStorage', 'AzureBlobFS', 'AzureDataLakeStore']);

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
  const stagingStores = linkedServices.filter((ls) => STAGING_TYPES.has(ls.properties.type));

  const lsRef = (referenceName: string) =>
    referenceName ? { referenceName, type: 'LinkedServiceReference' } : undefined;

  return (
    <div className={s.section}>
      {/* ── Performance ── */}
      <Subtitle2>Performance</Subtitle2>
      <Field label="Data integration units (DIU)"
        hint="Compute power for the copy. Auto lets ADF pick the optimal value.">
        <Select
          value={tp.dataIntegrationUnits != null ? String(tp.dataIntegrationUnits) : ''}
          onChange={(_, d) => patchTp({ dataIntegrationUnits: d.value ? Number(d.value) : undefined })}>
          {DIU_VALUES.map((v) => (
            <option key={v || 'auto'} value={v}>{v === '' ? 'Auto' : v}</option>
          ))}
        </Select>
      </Field>
      <Field label="Degree of copy parallelism"
        hint="Max parallel read/write sessions. Blank = auto.">
        <Input type="number" value={tp.parallelCopies != null ? String(tp.parallelCopies) : ''}
          onChange={(_, d) => patchTp({ parallelCopies: d.value ? Number(d.value) : undefined })} />
      </Field>

      {/* ── Staging ── */}
      <Subtitle2>Staging</Subtitle2>
      <Field label="Enable staging"
        hint="Stage data in Blob/ADLS Gen2 before the sink (required for e.g. Synapse PolyBase, Snowflake).">
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
      <Subtitle2>Fault tolerance</Subtitle2>
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
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            Optionally log the skipped rows to a Blob/ADLS store for later inspection.
          </Caption1>
          <Field label="Redirect store linked service">
            <Dropdown
              placeholder={linkedServices.length ? 'Select a store (optional)' : 'No linked services available'}
              value={redirect.linkedServiceName?.referenceName || ''}
              selectedOptions={redirect.linkedServiceName?.referenceName ? [redirect.linkedServiceName.referenceName] : []}
              disabled={!linkedServices.length}
              onOptionSelect={(_, d) => patchTp({
                redirectIncompatibleRowSettings: { ...redirect, linkedServiceName: lsRef(d.optionValue || '') },
              })}>
              <Option value="" text="(none)">(none)</Option>
              {linkedServices.map((ls) => (
                <Option key={ls.name} value={ls.name} text={ls.name}>{ls.name}</Option>
              ))}
            </Dropdown>
          </Field>
          <Field label="Redirect path" hint="Folder for the skipped-row log files.">
            <Input value={redirect.path || ''} placeholder="rejects"
              onChange={(_, d) => patchTp({ redirectIncompatibleRowSettings: { ...redirect, path: d.value || undefined } })} />
          </Field>
        </div>
      )}

      {/* ── Data consistency ── */}
      <Subtitle2>Data consistency</Subtitle2>
      <Field label="Enable data consistency verification"
        hint="After the copy, verify row count (tabular) or file size/checksum (binary) match between source and sink.">
        <Switch checked={!!tp.validateDataConsistency}
          onChange={(_, d) => patchTp({ validateDataConsistency: d.checked })} />
      </Field>
    </div>
  );
}
