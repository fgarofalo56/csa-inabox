/**
 * U9 — canvas full-screen mode as a shared kit feature.
 *
 * These jsdom tests exercise the REAL `CanvasFullscreenHost` + the
 * `CanvasRightRail` context wiring and pin the U9 contract:
 *   1. inactive, the host is layout-neutral and the rail (outside a host)
 *      shows NO full-screen button;
 *   2. inside a host, the rail shows the maximize button; clicking it
 *      maximizes (data-canvas-fullscreen="true", role="region", overlay) and
 *      the button flips to "Exit full screen" with aria-pressed;
 *   3. the enter/exit transitions are announced via the polite live region;
 *   4. Esc exits; F11 exits; a defaultPrevented Esc (a dialog consumed it)
 *      does NOT exit;
 *   5. focus returns to the triggering button on exit (a11y restore);
 *   6. ResizableCanvasRegion embeds the host: maximized it drops its committed
 *      inline height + hides the resize grip, and NOTHING is persisted to
 *      localStorage by the round-trip (session-scoped by design);
 *   7. the canvas subtree is NOT remounted across enter/exit (undo/redo,
 *      palette, and node state survive — pinned via DOM node identity).
 *
 * The FLAG0 read inside the rail runs without a QueryClientProvider here and
 * fail-opens to true (the documented useCanvasFullscreenFlag contract).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { CanvasFullscreenHost, useCanvasFullscreen } from '../canvas-fullscreen';
import { CanvasRightRail } from '../canvas-node-kit';
import { ResizableCanvasRegion } from '../resizable-canvas';

afterEach(() => {
  cleanup();
  try { window.localStorage.clear(); } catch { /* ignore */ }
  document.body.style.overflow = '';
});

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

const railProps = {
  zoom: 1,
  onZoomChange: () => {},
  onZoomIn: () => {},
  onZoomOut: () => {},
  onFit: () => {},
};

/** The host element carrying the data-canvas-fullscreen state attribute. */
function hostEl(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-canvas-fullscreen]');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

describe('CanvasFullscreenHost + CanvasRightRail (U9)', () => {
  it('rail OUTSIDE a host shows no full-screen button (context is null)', () => {
    wrap(<CanvasRightRail {...railProps} />);
    expect(screen.queryByRole('button', { name: 'Full screen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Exit full screen' })).toBeNull();
  });

  it('maximizes from the rail button, flips it to Exit, and exposes the region a11y contract', () => {
    wrap(
      <CanvasFullscreenHost ariaLabel="Test canvas full screen">
        <div>canvas-body</div>
        <CanvasRightRail {...railProps} />
      </CanvasFullscreenHost>,
    );
    expect(hostEl()).toHaveAttribute('data-canvas-fullscreen', 'false');

    const maximize = screen.getByRole('button', { name: 'Full screen' });
    expect(maximize).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(maximize);

    const host = hostEl();
    expect(host).toHaveAttribute('data-canvas-fullscreen', 'true');
    // Maximized the host is a named, focus-targetable region.
    expect(host).toHaveAttribute('role', 'region');
    expect(host).toHaveAttribute('aria-label', 'Test canvas full screen');
    expect(host).toHaveAttribute('tabindex', '-1');
    // Body scroll locked while maximized.
    expect(document.body.style.overflow).toBe('hidden');

    const exit = screen.getByRole('button', { name: 'Exit full screen' });
    expect(exit).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(exit);
    expect(hostEl()).toHaveAttribute('data-canvas-fullscreen', 'false');
    expect(document.body.style.overflow).toBe('');
  });

  it('announces enter and exit via the polite live region', () => {
    wrap(
      <CanvasFullscreenHost>
        <CanvasRightRail {...railProps} />
      </CanvasFullscreenHost>,
    );
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(status).toHaveTextContent('Canvas is full screen. Press Escape to exit.');
    fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }));
    expect(status).toHaveTextContent('Exited canvas full screen.');
  });

  it('Esc and F11 exit; a defaultPrevented Escape (consumed by a dialog) does not', () => {
    wrap(
      <CanvasFullscreenHost>
        <CanvasRightRail {...railProps} />
      </CanvasFullscreenHost>,
    );
    const enter = () => fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));

    enter();
    expect(hostEl()).toHaveAttribute('data-canvas-fullscreen', 'true');
    // A dialog/menu that consumed Escape wins — full screen stays.
    const consumed = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    consumed.preventDefault();
    document.dispatchEvent(consumed);
    expect(hostEl()).toHaveAttribute('data-canvas-fullscreen', 'true');
    // An unconsumed Escape exits.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(hostEl()).toHaveAttribute('data-canvas-fullscreen', 'false');

    enter();
    fireEvent.keyDown(document, { key: 'F11' });
    expect(hostEl()).toHaveAttribute('data-canvas-fullscreen', 'false');
  });

  it('restores focus to the triggering element on exit', () => {
    wrap(
      <CanvasFullscreenHost>
        <CanvasRightRail {...railProps} />
      </CanvasFullscreenHost>,
    );
    const maximize = screen.getByRole('button', { name: 'Full screen' });
    maximize.focus();
    fireEvent.click(maximize);
    fireEvent.keyDown(document, { key: 'Escape' });
    // The SAME DOM button (it flips label via icon/aria only) regains focus.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Full screen' }));
  });

  it('preserves the canvas subtree across enter/exit (no remount — state survives)', () => {
    function Toggler() {
      const fs = useCanvasFullscreen();
      return <button onClick={() => fs?.toggle()}>toggle-fs</button>;
    }
    wrap(
      <CanvasFullscreenHost>
        <div data-testid="canvas-subtree">stateful-canvas</div>
        <Toggler />
      </CanvasFullscreenHost>,
    );
    const before = screen.getByTestId('canvas-subtree');
    fireEvent.click(screen.getByText('toggle-fs'));
    expect(screen.getByTestId('canvas-subtree')).toBe(before);
    fireEvent.click(screen.getByText('toggle-fs'));
    expect(screen.getByTestId('canvas-subtree')).toBe(before);
  });
});

describe('ResizableCanvasRegion embeds the full-screen host (U9 × G3)', () => {
  function FsToggle() {
    const fs = useCanvasFullscreen();
    return <button onClick={() => fs?.toggle()}>region-fs-toggle</button>;
  }

  it('maximized: committed height + resize grip drop out; restored: both return; nothing persists', () => {
    wrap(
      <ResizableCanvasRegion storageKey="t-fs-region" defaultPx={480} minPx={320} maxPx={900}>
        <FsToggle />
      </ResizableCanvasRegion>,
    );
    // Windowed: grip present, committed inline height applied.
    const sep = screen.getByRole('separator');
    expect(sep).toHaveAttribute('aria-valuenow', '480');

    fireEvent.click(screen.getByText('region-fs-toggle'));
    expect(hostEl()).toHaveAttribute('data-canvas-fullscreen', 'true');
    // The grip is hidden while maximized (height is the viewport's) …
    expect(screen.queryByRole('separator')).toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    // … and the windowed height contract returns intact after exit.
    const sepBack = screen.getByRole('separator');
    expect(sepBack).toHaveAttribute('aria-valuenow', '480');
    // Session-scoped BY DESIGN: the full-screen round-trip persisted nothing.
    expect(window.localStorage.getItem('loom.canvasHeight.t-fs-region')).toBeNull();
  });
});
