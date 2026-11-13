async function jsonFetch(url, opts) {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

export const getConfig = () => jsonFetch('/api/config');
export const listSessions = () => jsonFetch('/api/sessions');
export const getSession = (id) => jsonFetch(`/api/sessions/${id}`);
export const deleteSession = (id) => jsonFetch(`/api/sessions/${id}`, { method: 'DELETE' });
export const saveSession = (s) =>
  jsonFetch(`/api/sessions/${s.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(s),
  });

/** Streams a generation. Resolves with { text, usage }. */
export async function stream(payload, { onDelta, signal } = {}) {
  const r = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${r.status})`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let result = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!block.startsWith('data:')) continue;
      const ev = JSON.parse(block.slice(5).trim());
      if (ev.type === 'delta') onDelta && onDelta(ev.text);
      else if (ev.type === 'done') result = ev;
      else if (ev.type === 'error') throw new Error(ev.error);
    }
  }
  if (!result) throw new Error('The connection closed before the response finished.');
  return result;
}

