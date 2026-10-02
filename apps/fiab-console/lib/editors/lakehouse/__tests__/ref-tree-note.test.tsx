/**
 * Reference explorer: an empty level shows the listing route's note.
 *
 * `/api/lakehouse/references/paths` answers `paths: []` with a `note` when the
 * requested container is not the one the referenced lakehouse stores its files
 * in. The tree used to show "(empty)", which reads as "this folder has nothing
 * in it". The hook records the note under the key it caches the listing by, and
 * RefTreeChildren reads it by the key it looks the listing up by -- so this file
 * drives both halves together: a key mismatch between them shows "(empty)".
 *
 * What breaks each case is named at the assertion.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup, render, screen } from '@testing-library/react';
import { FluentProvider, Tree, webLightTheme } from '@fluentui/react-components';
import { useLakehouseSecondary } from '../hooks/use-lakehouse-secondary';
import { RefTreeChildren } from '../ref-tree-children';

const NOTE = 'This lakehouse stores its files in the landing container.';
const REF = { id: 'ref-1', displayName: 'Contoso Raw', containers: ['bronze', 'landing'] };

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** Each call to the paths route takes the next body from `bodies`. */
function installPaths(bodies: unknown[]) {
  let i = 0;
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    const body = url.includes('/api/lakehouse/references/paths')
      ? bodies[Math.min(i++, bodies.length - 1)]
      : { ok: true, references: [], data: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }) as any;
  });
}

function mountHook() {
  return renderHook(() => useLakehouseSecondary({
    id: 'lh-1', isNewItem: false, activeContainer: 'landing', shortcutLakehouseId: 'lh-1',
    schemasEnabled: false, setSchemasEnabled: () => {}, loadPaths: async () => {},
    tablesPrefix: 'Tables', confirm: async () => true,
    itemQ: { data: undefined } as any, maintainTable: '', tab: 'files',
  }));
}

function renderLevel(sec: { refOpenPrefixes: any; refPathNotes: Record<string, string> }) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <Tree aria-label="refs">
        <RefTreeChildren
          ref_={REF} container="bronze" prefix=""
          openPrefixes={sec.refOpenPrefixes} notes={sec.refPathNotes}
          loadRefPaths={async () => {}} selectRefFile={async () => {}}
        />
      </Tree>
    </FluentProvider>,
  );
}

describe('reference explorer: empty level', () => {
  it('shows the route note instead of "(empty)"', async () => {
    installPaths([{ ok: true, paths: [], note: NOTE }]);
    const { result } = mountHook();
    await act(async () => { await result.current.loadRefPaths('ref-1', 'bronze', ''); });
    renderLevel(result.current);
    // Breaks if the hook drops `note`, stores it under another key, or the
    // component renders '(empty)' regardless.
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(screen.queryByText('(empty)')).toBeNull();
  });

  it('shows "(empty)" when the route sends no note', async () => {
    installPaths([{ ok: true, paths: [] }]);
    const { result } = mountHook();
    await act(async () => { await result.current.loadRefPaths('ref-1', 'bronze', ''); });
    renderLevel(result.current);
    // Breaks if the fallback text is removed (an empty Caption1 would render).
    expect(screen.getByText('(empty)')).toBeInTheDocument();
  });

  it('drops a note once a reload of the same level no longer sends one', async () => {
    installPaths([{ ok: true, paths: [], note: NOTE }, { ok: true, paths: [] }]);
    const { result } = mountHook();
    await act(async () => { await result.current.loadRefPaths('ref-1', 'bronze', ''); });
    expect(result.current.refPathNotes['ref::ref-1::bronze::']).toBe(NOTE);
    await act(async () => { await result.current.loadRefPaths('ref-1', 'bronze', ''); });
    renderLevel(result.current);
    // Breaks if the hook only ever adds notes (the stale note would still show).
    expect(screen.getByText('(empty)')).toBeInTheDocument();
    expect(screen.queryByText(NOTE)).toBeNull();
  });
});
