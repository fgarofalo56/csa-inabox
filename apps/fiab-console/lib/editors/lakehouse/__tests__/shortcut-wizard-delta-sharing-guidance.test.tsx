/**
 * Shortcut wizard, Delta Sharing step: the guidance points only to actions that
 * exist. The wizard has no Save to Key Vault for a credential file; the
 * credential is the one Loom stores when a provider is added under Data shares,
 * and the table-level action there is "Create lakehouse shortcut"
 * (share-explorer.tsx) reached from "Explore & query" (data-shares.tsx).
 *
 * WHAT BREAKS IT:
 *   - the previous banner ("Shortcut into lakehouse", "name a shortcut
 *     credential Loom saved (loom-sc-…)", "replace the credential with a fresh
 *     file"): the positive checks for "Explore & query", "Create lakehouse
 *     shortcut" and "Add provider" fail, and the loom-sc- absence check fails.
 *   - a sanitisation example that disagrees with the real mapping: the example
 *     is checked against `shareProviderSecretName`, the function the providers
 *     route stores the credential under.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

vi.mock('@/lib/components/onelake/shortcut-wizard', () => ({
  SHORTCUT_SOURCE_CARDS: [],
  ShortcutSourceLogo: () => null,
  ExternalCredsForm: () => null,
  RemoteBrowseTree: () => null,
  SharePointBrowser: () => null,
}));

import { ShortcutWizardDialog } from '../dialogs/shortcut-wizard-dialog';
import { LakehouseEditorContext } from '../lakehouse-editor-context';
import { shareProviderSecretName } from '@/lib/azure/kv-secret-name';

afterEach(cleanup);

function mountDeltaStep() {
  const noop = vi.fn();
  const ctx: any = {
    scWizardOpen: true, setScWizardOpen: noop, scStep: 2, setScStep: noop,
    scType: 'delta_sharing', setScType: noop,
    scAdlsMode: 'picker', setScAdlsMode: noop,
    scAcctHost: '', setScAcctHost: noop, storageAccts: [], storageAcctsLoading: false,
    scAdlsContainer: '', setScAdlsContainer: noop, scAdlsPath: '', setScAdlsPath: noop,
    scInternalContainer: '', setScInternalContainer: noop, scInternalPath: '', setScInternalPath: noop, containers: [],
    scTargetUri: '', setScTargetUri: noop,
    scExtSas: '', setScExtSas: noop, scExtSasBusy: false, scExtSasErr: null, stashExternalSas: noop,
    scKvSecret: '', setScKvSecret: noop,
    extCreds: {}, setExtCreds: noop,
    scSpSelection: null, setScSpSelection: noop,
    scKind: 'tables', setScKind: noop,
    scParentPath: '', setScParentPath: noop,
    scName: '', setScName: noop,
    scFormat: 'delta', setScFormat: noop,
    scTargetSchema: 'dbo', setScTargetSchema: noop,
    scSubmitError: null, scSubmitting: false, submitShortcut: noop,
    shortcutLakehouseId: 'lh1', schemas: [], schemasEnabled: false,
  };
  render(
    <FluentProvider theme={webLightTheme}>
      <LakehouseEditorContext.Provider value={ctx}>
        <ShortcutWizardDialog />
      </LakehouseEditorContext.Provider>
    </FluentProvider>,
  );
}

describe('shortcut wizard — Delta Sharing guidance', () => {
  it('the banner names the Data shares actions that exist, and no wizard save', () => {
    mountDeltaStep();
    const banner = screen.getByText('Delta Sharing (cross-tenant)').closest('.fui-MessageBarBody') as HTMLElement;
    expect(banner).not.toBeNull();
    const text = banner.textContent || '';
    expect(text).toContain('Add provider');
    // WHAT BREAKS IT: a path that skips Subscribe (Explore & query lists only
    // subscribed shares), renewal advice without the unmount step or without the
    // same provider name.
    expect(text).toContain('Shared with me → Subscribe to the share → Explore & query');
    expect(text).toContain('Create lakehouse shortcut');
    expect(text).toContain('Saving a credential file from this wizard is not available');
    expect(text).toContain('unmount the provider\'s subscribed catalogs (Remove is refused while they are mounted)');
    expect(text).toContain('add it again under the same provider name with that file');
    expect(text).not.toContain('Shortcut into lakehouse');
    expect(text).not.toContain('loom-sc-');
    expect(text).not.toContain('Save to Key Vault');
  });

  it('the secret-name hint states how provider names map, and the example is the real mapping', () => {
    mountDeltaStep();
    const hint = screen.getByText(/loom-dsp- plus the provider name/);
    expect(hint.textContent).toContain('provider acme_corp → loom-dsp-acme-corp');
    // The example must agree with the name the providers route stores.
    expect(shareProviderSecretName('acme_corp')).toBe('loom-dsp-acme-corp');
  });
});
