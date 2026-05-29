/**
 * Content-type-safe fetch + JSON parse for the pipeline editors.
 *
 * Why this exists: a missing BFF route (e.g. the old absent ADF `/runs`)
 * returns Next.js's 404 *HTML* page, not JSON. Calling `res.json()` on that
 * throws "Unexpected token < in JSON" and crashes the editor's catch block
 * with an opaque error. `safePipelineJson` guards the content-type and returns
 * a structured `{ ok:false, error }` instead.
 */

export interface PipelineJsonResult<T = any> {
  ok: boolean;
  status: number;
  /** Parsed JSON body when the response was JSON; null otherwise. */
  data: (T & { ok?: boolean; error?: string; code?: string }) | null;
  /** A human-readable error when the response was not ok or not JSON. */
  error?: string;
}

export async function safePipelineJson<T = any>(res: Response): Promise<PipelineJsonResult<T>> {
  const ct = res.headers.get('content-type') || '';
  if (!ct.toLowerCase().includes('application/json')) {
    // Non-JSON (almost always an HTML error page). Read a snippet for context
    // but never feed it to JSON.parse.
    let snippet = '';
    try { snippet = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    return {
      ok: false,
      status: res.status,
      data: null,
      error: `Expected JSON but got ${ct || 'no content-type'} (HTTP ${res.status})${snippet ? `: ${snippet}` : ''}`,
    };
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch (e: any) {
    return { ok: false, status: res.status, data: null, error: e?.message || 'Failed to parse JSON' };
  }
  const ok = res.ok && data?.ok !== false;
  return { ok, status: res.status, data, error: ok ? undefined : (data?.error || `HTTP ${res.status}`) };
}
