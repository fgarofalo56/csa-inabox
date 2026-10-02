/**
 * Lakehouse settings: a refused save shows the route's remediation.
 *
 * The settings route refuses a read-only role with `{ok:false, error, code,
 * remediation}`. The hook used to surface `error` alone, so the dialog said
 * what was wrong but not what to do about it.
 *
 * What breaks each case is named at the assertion.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useLakehouseSettings } from '../hooks/use-lakehouse-settings';

const ERROR = 'Your role on this lakehouse is read-only.';
const REMEDIATION = 'Ask a workspace Member or Admin to make the change, or to give you an item grant that includes Edit.';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function installSave(body: unknown, status = 403) {
  vi.spyOn(global, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) as any);
}

function mount() {
  const setActionStatus = vi.fn();
  const hook = renderHook(() => useLakehouseSettings({
    lakehouseId: 'lh-1', schemasEnabled: false, setSchemasEnabled: () => {}, setActionStatus,
  }));
  return { ...hook, setActionStatus };
}

describe('useLakehouseSettings: refused save', () => {
  it('puts the remediation after the error', async () => {
    installSave({ ok: false, code: 'read_only', error: ERROR, remediation: REMEDIATION });
    const { result, setActionStatus } = mount();
    await act(async () => { await result.current.saveSettings(); });
    // Breaks if `remediation` is dropped (the text would be ERROR alone).
    expect(result.current.settingsError).toBe(`${ERROR} ${REMEDIATION}`);
    // Breaks if a refusal is reported as saved.
    expect(setActionStatus).not.toHaveBeenCalled();
  });

  it('shows the error alone when the route sends no remediation', async () => {
    installSave({ ok: false, error: ERROR });
    const { result } = mount();
    await act(async () => { await result.current.saveSettings(); });
    // Breaks if an absent remediation adds text (e.g. a trailing 'undefined').
    expect(result.current.settingsError).toBe(ERROR);
  });
});
