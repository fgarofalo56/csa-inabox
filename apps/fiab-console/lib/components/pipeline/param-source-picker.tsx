'use client';

/**
 * ParamSourcePicker — per-parameter value source control for the TriggerWizard
 * (F4: schedule-time parameter overrides). ADF Studio's "Add trigger" wizard
 * shows a literal value box per pipeline parameter; Loom extends that with a
 * SOURCE dropdown so a value can come from:
 *
 *   Direct value   — a literal (or an ADF expression like @trigger().scheduledTime)
 *   Key Vault       — a secret in LOOM_PARAM_KEYVAULT, resolved server-side at
 *                     trigger-creation time and written as the literal parameter
 *   App Config      — a key in LOOM_PARAM_APPCONFIG, resolved the same way
 *
 * KV / App Config values are resolved ONCE, when the trigger is created
 * (snapshot semantics) — the resolved literal is what ADF stores in the trigger
 * `parameters`. The picker surfaces this with a "resolved at creation" note so
 * the operator knows to recreate the trigger if the secret/key changes.
 *
 * This component is purely controlled — it makes no network calls. Resolution
 * happens in /api/items/data-pipeline/[id]/triggers (the BFF route).
 */

import {
  Dropdown, Option, Input, Field, Text, Badge, makeStyles, tokens,
} from '@fluentui/react-components';
import type { PipelineParameterType } from './types';

export type ParamSource = 'direct' | 'keyvault' | 'appconfig';

export interface ParamBinding {
  source: ParamSource;
  /** Literal value (or ADF expression) when source === 'direct'. */
  directValue: string;
  /** Key Vault secret NAME (not a full URI) when source === 'keyvault'. */
  secretName: string;
  /** App Configuration key when source === 'appconfig'. */
  configKey: string;
  /** Optional App Configuration label when source === 'appconfig'. */
  configLabel: string;
}

export const EMPTY_BINDING: ParamBinding = {
  source: 'direct', directValue: '', secretName: '', configKey: '', configLabel: '',
};

const SOURCE_LABEL: Record<ParamSource, string> = {
  direct: 'Direct value',
  keyvault: 'Key Vault secret',
  appconfig: 'App Config key',
};

const useStyles = makeStyles({
  row: { display: 'flex', flexDirection: 'column', gap: '8px' },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' },
  note: { display: 'flex', alignItems: 'center', gap: '6px', color: tokens.colorNeutralForeground3 },
});

export interface ParamSourcePickerProps {
  binding: ParamBinding;
  onChange: (next: ParamBinding) => void;
  /** Pipeline parameter type — drives secure masking for secureString. */
  paramType?: PipelineParameterType;
  /** LOOM_PARAM_KEYVAULT configured — drives the honest gate hint. */
  kvAvailable?: boolean;
  /** LOOM_PARAM_APPCONFIG configured — drives the honest gate hint. */
  appConfigAvailable?: boolean;
}

export function ParamSourcePicker({
  binding, onChange, paramType, kvAvailable = true, appConfigAvailable = true,
}: ParamSourcePickerProps) {
  const styles = useStyles();
  const set = (patch: Partial<ParamBinding>) => onChange({ ...binding, ...patch });
  const secure = paramType === 'secureString';

  return (
    <div className={styles.row}>
      <Dropdown
        value={SOURCE_LABEL[binding.source]}
        selectedOptions={[binding.source]}
        onOptionSelect={(_, d) => d.optionValue && set({ source: d.optionValue as ParamSource })}
      >
        <Option value="direct">{SOURCE_LABEL.direct}</Option>
        <Option value="keyvault">{SOURCE_LABEL.keyvault}</Option>
        <Option value="appconfig">{SOURCE_LABEL.appconfig}</Option>
      </Dropdown>

      {binding.source === 'direct' && (
        <Field
          hint={secure
            ? 'Secure parameter — this literal is stored in plain text in the trigger. Prefer Key Vault for secrets.'
            : 'Literal value or an ADF expression (e.g. @trigger().scheduledTime).'}
        >
          <Input
            type={secure ? 'password' : 'text'}
            value={binding.directValue}
            onChange={(_, d) => set({ directValue: d.value })}
            placeholder={secure ? '••••••' : 'value'}
          />
        </Field>
      )}

      {binding.source === 'keyvault' && (
        <>
          <Field hint="Name of the secret in the parameter Key Vault (LOOM_PARAM_KEYVAULT).">
            <Input
              value={binding.secretName}
              onChange={(_, d) => set({ secretName: d.value })}
              placeholder="pipeline-input-container"
            />
          </Field>
          {!kvAvailable && (
            <Text size={200} className={styles.note}>
              <Badge appearance="tint" color="warning">Not configured</Badge>
              Set LOOM_PARAM_KEYVAULT and grant the Console identity
              &ldquo;Key Vault Secrets User&rdquo; on that vault.
            </Text>
          )}
          <Text size={200} className={styles.note}>
            <Badge appearance="tint" color="informative">Resolved at creation</Badge>
            The secret is read once when the trigger is created — recreate the
            trigger if the value changes.
          </Text>
        </>
      )}

      {binding.source === 'appconfig' && (
        <>
          <div className={styles.grid2}>
            <Field label="Key" hint="App Configuration key.">
              <Input
                value={binding.configKey}
                onChange={(_, d) => set({ configKey: d.value })}
                placeholder="pipeline:maxRows"
              />
            </Field>
            <Field label="Label (optional)" hint="App Configuration label.">
              <Input
                value={binding.configLabel}
                onChange={(_, d) => set({ configLabel: d.value })}
                placeholder="prod"
              />
            </Field>
          </div>
          {!appConfigAvailable && (
            <Text size={200} className={styles.note}>
              <Badge appearance="tint" color="warning">Not configured</Badge>
              Set LOOM_PARAM_APPCONFIG to your App Configuration endpoint and
              grant the Console identity &ldquo;App Configuration Data Reader&rdquo;.
            </Text>
          )}
          <Text size={200} className={styles.note}>
            <Badge appearance="tint" color="informative">Resolved at creation</Badge>
            The key is read once when the trigger is created — recreate the
            trigger if the value changes.
          </Text>
        </>
      )}
    </div>
  );
}
