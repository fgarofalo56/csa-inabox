/**
 * Content-type-safe fetch + JSON parse for the ml-model editor.
 *
 * Why this exists: a missing/erroring BFF route (e.g. a 404 for an unbound
 * model item, or a Next.js 404 HTML page) returns *HTML*, not JSON. Calling
 * `res.json()` on that throws "Unexpected token < in JSON" and crashes the
 * editor's catch with an opaque error — the exact reported failure mode.
 * `safeModelJson` guards the content-type and returns a structured
 * `{ ok:false, error, code }` instead, so the editor can render its bind UI /
 * honest gate rather than a blank crash.
 */

export interface ModelJsonResult<T = any> {
  ok: boolean;
  status: number;
  /** Parsed JSON body when the response was JSON; null otherwise. */
  data: (T & { ok?: boolean; error?: string; code?: string }) | null;
  /** Structured code echoed from the BFF (e.g. 'unbound', 'not_found'). */
  code?: string;
  /** A human-readable error when the response was not ok or not JSON. */
  error?: string;
}

export async function safeModelJson<T = any>(res: Response): Promise<ModelJsonResult<T>> {
  const ct = res.headers.get('content-type') || '';
  if (!ct.toLowerCase().includes('application/json')) {
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
  return {
    ok,
    status: res.status,
    data,
    code: data?.code,
    error: ok ? undefined : (data?.error || `HTTP ${res.status}`),
  };
}
