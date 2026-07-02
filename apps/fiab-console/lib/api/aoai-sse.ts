/**
 * Shared decoder for an Azure OpenAI **streaming** chat-completions response.
 *
 * The copilot streaming routes (Plan Copilot, Notebook Copilot, SQL Copilot)
 * each open an AOAI `stream:true` completion and then re-emit its deltas under
 * their own Server-Sent-Events envelope (`token|final`, or `chunk|done`). The
 * line-buffered parse loop that pulls `choices[0].delta.content` out of the
 * AOAI `data:` frames is identical across all of them; this generator is that
 * loop, extracted once so the routes keep only their distinct event names and
 * side-effects (behavior-preserving — same deltas, same order).
 *
 * Line-buffered: accumulates the byte stream, splits on '\n', keeps the
 * trailing partial line across reads, processes only `data:` frames, skips the
 * `[DONE]` sentinel, and ignores any frame that isn't valid delta JSON
 * (keepalives / partial frames spanning a chunk boundary). Yields only
 * non-empty string content deltas.
 *
 * @example
 *   for await (const delta of iterateAoaiDeltas(upstream)) {
 *     full += delta
 *     send('token', { text: delta })
 *   }
 */
export async function* iterateAoaiDeltas(
  upstream: Response,
): AsyncGenerator<string, void, unknown> {
  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const delta = j?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) yield delta;
      } catch {
        /* keepalive / partial frame across a read boundary — ignore */
      }
    }
  }
}
