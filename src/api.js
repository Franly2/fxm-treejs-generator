async function jsonFetch(url, opts) {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

const LS_KEY = 'treejs_gen_sessions_v1';
function readStore() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}
function writeStore(map) {
  localStorage.setItem(LS_KEY, JSON.stringify(map));
}

export const getConfig = () => jsonFetch('/api/config');
export const listSessions = async () => {
  const map = readStore();
  return Object.values(map)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((s) => ({
      id: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
      models: (s.messages || []).filter((m) => m.role === 'result' && m.code && !m.error).length,
    }));
};
export const getSession = async (id) => {
  const s = readStore()[id];
  if (!s) throw new Error('Session not found');
  return s;
};
export const deleteSession = async (id) => {
  const map = readStore();
  delete map[id];
  writeStore(map);
  return { ok: true };
};
export const saveSession = async (s) => {
  s.updatedAt = Date.now();
  const map = readStore();
  map[s.id] = s;
  writeStore(map);
  return { ok: true, updatedAt: s.updatedAt };
};

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

