/**
 * A GET that always resolves to a JSON-ish object, never throws, and cannot hang.
 *
 * Extracted from `app/admin/scaling/page.tsx` on 2026-08-23 when the estate
 * pause/resume panel moved out of that file: both the page and the panel need
 * it, and duplicating a fetch helper is how two copies quietly drift apart.
 *
 * The 12s abort is the point — a hung backend route would otherwise leave a
 * panel spinning forever, and a timeout is reported as an honest
 * `{ ok:false, error }` rather than a rejected promise each caller must catch.
 */
import { clientFetch } from '@/lib/client-fetch';

export async function jsonGet(url: string): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await clientFetch(url, { signal: ctrl.signal, cache: 'no-store' });
    return await r.json().catch(() => ({}));
  } catch (e: any) {
    return { ok: false, error: e?.name === 'AbortError' ? `Timed out loading ${url}` : (e?.message || String(e)) };
  } finally {
    clearTimeout(timer);
  }
}
