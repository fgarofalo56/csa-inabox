'use client';
/**
 * Every lakehouse dialog that takes NO props — each reads its state from
 * `useLakehouseCtx()` — rendered in one place.
 *
 * Extracted from `lakehouse-editor-shell.tsx`, which renders this once inside
 * its context provider, exactly where these twelve used to be rendered one by
 * one. Behaviour-preserving: same components, same order, same provider. The
 * point is the shell's line budget — that file is pinned at a zero-headroom
 * ratchet ceiling (`scripts/ci/check-file-size.mjs`), and this moves the import
 * and render of these twelve dialogs out of it by decomposition rather than by
 * packing code onto fewer lines.
 *
 * Dialogs that take props from shell-local state (`DeltaMaintenanceDialog`,
 * `TierDialog`, the confirm dialog) stay in the shell, because their state does
 * not live in the context.
 */
import {
  ContextMenu, LabelDialog, ReferencePickerDialog, PropertiesDialog,
  ShareDialog, DataAgentDialog, MoveTableDialog, SemanticModelGateDialog,
} from './small-dialogs';
import { ShortcutWizardDialog } from './shortcut-wizard-dialog';
import { PermissionsDialog } from './permissions-dialog';
import { SettingsDialog } from './settings-dialog';
import { CheckVariablesDialog } from './check-variables-dialog';

export function LakehouseContextDialogs() {
  return (
    <>
      <ContextMenu />
      <LabelDialog />
      <PropertiesDialog />
      <SemanticModelGateDialog />
      <CheckVariablesDialog />
      <ShareDialog />
      <DataAgentDialog />
      <MoveTableDialog />
      <ShortcutWizardDialog />
      <PermissionsDialog />
      <SettingsDialog />
      <ReferencePickerDialog />
    </>
  );
}
