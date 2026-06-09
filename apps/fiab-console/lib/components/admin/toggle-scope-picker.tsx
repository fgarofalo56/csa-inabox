'use client';

/**
 * ToggleScopePicker — the per-toggle "Apply to" scope block (F2) rendered below
 * a tenant-setting Switch. Mirrors Microsoft Fabric's tenant-setting scoping:
 *
 *   • Entire organization
 *   • Specific security groups            (enabled only for the chosen groups)
 *   • Entire org, except specific groups  (enabled for everyone but the chosen groups)
 *
 * The mode picker is a Fluent Dropdown; the group list is the multi-select
 * GroupMultiPicker (real Microsoft Graph search). Security groups only — matches
 * Fabric's restriction.
 */

import { useMemo } from 'react';
import {
  Dropdown, Option, Field, makeStyles, tokens,
} from '@fluentui/react-components';
import { GroupMultiPicker } from '@/lib/components/ui/group-multi-picker';
import {
  APPLIES_TO_MODES,
  type AppliesToConfig,
  type AppliesToMode,
} from '@/lib/types/tenant-settings';
import type { IdentityHit } from '@/lib/components/ui/identity-picker';

const MODE_LABELS: Record<AppliesToMode, string> = {
  'entire-org': 'Entire organization',
  'specific-groups': 'Specific security groups',
  'except-groups': 'Entire org, except specific groups',
};

const useStyles = makeStyles({
  block: {
    marginTop: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalS,
    borderTop: `1px solid ${tokens.colorNeutralStroke3}`,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
  },
  modeRow: { maxWidth: '360px' },
});

export interface ToggleScopePickerProps {
  config: AppliesToConfig;
  onChange: (next: AppliesToConfig) => void;
  disabled?: boolean;
  /** Resolved OID → display name map from the groups-resolve route (load time). */
  resolvedGroupNames?: Record<string, string>;
}

export function ToggleScopePicker({
  config,
  onChange,
  disabled = false,
  resolvedGroupNames = {},
}: ToggleScopePickerProps) {
  const s = useStyles();
  const mode = config.mode;

  // Build IdentityHit[] for the multi-picker from stored ids + cached / resolved
  // display names. Falls back to the raw OID when a name isn't resolvable.
  const selectedHits = useMemo<IdentityHit[]>(() => {
    return (config.groupIds || []).map((id, i): IdentityHit => ({
      id,
      type: 'group',
      displayName:
        config.groupDisplayNames?.[i] || resolvedGroupNames[id] || id,
    }));
  }, [config.groupIds, config.groupDisplayNames, resolvedGroupNames]);

  function setMode(next: AppliesToMode) {
    if (next === 'entire-org') {
      onChange({ mode: 'entire-org', groupIds: [], groupDisplayNames: [] });
    } else {
      onChange({ ...config, mode: next });
    }
  }

  function setGroups(groups: IdentityHit[]) {
    onChange({
      mode: config.mode,
      groupIds: groups.map((g) => g.id),
      groupDisplayNames: groups.map((g) => g.displayName),
    });
  }

  return (
    <div className={s.block}>
      <Field label="Apply to" className={s.modeRow}>
        <Dropdown
          disabled={disabled}
          selectedOptions={[mode]}
          value={MODE_LABELS[mode]}
          onOptionSelect={(_e, d) => {
            if (d.optionValue) setMode(d.optionValue as AppliesToMode);
          }}
        >
          {APPLIES_TO_MODES.map((m) => (
            <Option key={m} value={m} text={MODE_LABELS[m]}>{MODE_LABELS[m]}</Option>
          ))}
        </Dropdown>
      </Field>

      {mode !== 'entire-org' && (
        <GroupMultiPicker
          selected={selectedHits}
          onSelectionChange={setGroups}
          disabled={disabled}
          label={mode === 'except-groups' ? 'Except these security groups' : 'Enabled for these security groups'}
        />
      )}
    </div>
  );
}

export default ToggleScopePicker;
