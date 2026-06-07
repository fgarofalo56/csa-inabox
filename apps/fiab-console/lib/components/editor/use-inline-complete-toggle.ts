'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Per-session toggle for inline code completion (ghost text), persisted in
 * localStorage under `loom.inlineComplete` and synced across every code cell in
 * the tab via a custom window event. Defaults to ON.
 *
 * This is the user-level switch surfaced by the sparkle toolbar button on each
 * code cell. The tenant-admin org-wide switch lives in tenant-settings
 * (`ai.inlineCodeComplete`) and is enforced server-side by /api/copilot/complete.
 */
const STORAGE_KEY = 'loom.inlineComplete';
const EVENT = 'loom-inline-complete-changed';

function read(): boolean {
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem(STORAGE_KEY) !== 'false';
}

export function useInlineCompleteToggle(): [boolean, () => void] {
  const [enabled, setEnabled] = useState<boolean>(read);

  useEffect(() => {
    const onChange = () => setEnabled(read());
    window.addEventListener(EVENT, onChange);
    // Cross-tab sync.
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  const toggle = useCallback(() => {
    const next = !read();
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, String(next));
    }
    setEnabled(next);
    window.dispatchEvent(new Event(EVENT));
  }, []);

  return [enabled, toggle];
}
