'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * TenantThemeBridge — fetches /api/tenant-theme on first paint and applies
 * the tenant's brand overrides (accent + brand name) to :root CSS vars.
 *
 * The whole Loom UI consumes these vars, so re-painting is automatic —
 * topbar gradient, hero, hover states, focus rings all pick up the new
 * accent without component changes.
 *
 * Honest fallback: when the tenant has no theme record, nothing changes
 * and the default Loom palette stays.
 */

import { useEffect } from 'react';

export function TenantThemeBridge() {
  useEffect(() => {
    let aborted = false;
    clientFetch('/api/tenant-theme').then(r => r.json()).then(d => {
      if (aborted || !d?.theme) return;
      const root = document.documentElement;
      const { accent, brandName } = d.theme;
      if (accent) {
        // primary brand var — every gradient that uses it re-derives.
        root.style.setProperty('--loom-indigo-700', accent);
        root.style.setProperty('--loom-tenant-accent', accent);
      }
      if (brandName) {
        root.style.setProperty('--loom-tenant-brand', `"${brandName.replace(/"/g, '\\"')}"`);
        document.title = `${brandName} — CSA Loom`;
      }
    }).catch(() => { /* keep defaults */ });
    return () => { aborted = true; };
  }, []);
  return null;
}
