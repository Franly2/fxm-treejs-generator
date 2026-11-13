import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlanRequest, buildExecRequest } from './prompts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'sessions');
const DIST_DIR = path.join(ROOT, 'dist');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- env (re-read on every request so the key can be added without restart) ----------
let fileEnv = {};
function loadEnv() {
  const p = path.join(ROOT, '.env');
  fileEnv = {};
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) fileEnv[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const getEnv = (k) => fileEnv[k] || process.env[k] || '';
loadEnv();

const MODEL_DEFS = {
  opus: { label: 'Opus 5.5', envKey: 'MODEL_OPUS', fallback: 'claude-opus-5-5', roles: ['plan'], pricing: { input: 5, output: 25 } },
  sonnet: { label: 'Sonnet 5.5', envKey: 'MODEL_SONNET', fallback: 'claude-sonnet-5-5', roles: ['plan', 'execute'], pricing: { input: 3, output: 15 } },
  haiku: { label: 'Haiku 5.5', envKey: 'MODEL_HAIKU', fallback: 'claude-haiku-5-5', roles: ['plan', 'execute'], pricing: { input: 1, output: 5 } },
};

// ---------- helpers ----------
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

function readJson(req, limit = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const safeId = (id) => /^[A-Za-z0-9-]{8,64}$/.test(id || '');
const sessionFile = (id) => path.join(DATA_DIR, `${id}.json`);

// ---------- mock mode (ANTHROPIC_API_KEY=mock) ----------
const MOCK_PLAN = `OBJECT: Demo Tower
## 1. Object identification
A stepped demo tower used to test the generator pipeline (mock mode, no API call).

## 2. Exact component inventory
- 1 square base plinth
- 3 stacked tapered sections
- 1 spire
- 1 glowing orb on top

## 3. Geometry and architecture
Each section is a tapered box (frustum) reducing 20% per level.

## 4. Scale and proportions
Total height 12 m, base 6 m x 6 m.

## 5. Colors and materials
Plinth #475569, sections #94a3b8, spire #e2e8f0, orb emissive #6366f1.

## 6. Build strategy
Simple meshes, no instancing needed.

## 7. Interactions and animation
Clicking the tower launches a burst of colored particles from the orb.

## 8. Assumptions and open questions
None.`;

const MOCK_CODE = `\`\`\`js
const root = new THREE.Group();
const mat = (c, r = 0.6, m = 0.1) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
const plinth = new THREE.Mesh(new THREE.BoxGeometry(6, 0.6, 6), mat('#475569'));
plinth.position.y = 0.3; plinth.castShadow = plinth.receiveShadow = true; root.add(plinth);
let y = 0.6;
for (let i = 0; i < 3; i++) {
  const w = 4.6 - i * 1.0, h = 3.2;
  const g = new THREE.CylinderGeometry(w * 0.62, w * 0.78, h, 4, 1);
  g.rotateY(Math.PI / 4);
  const m = new THREE.Mesh(g, mat('#94a3b8', 0.5, 0.2));
  m.position.y = y + h / 2; m.castShadow = m.receiveShadow = true; m.name = 'section_' + i; root.add(m);
  y += h;
}
const spire = new THREE.Mesh(new THREE.ConeGeometry(0.35, 3, 12), mat('#e2e8f0', 0.3, 0.6));
spire.position.y = y + 1.5; spire.castShadow = true; root.add(spire);
const orb = new THREE.Mesh(new THREE.SphereGeometry(0.3, 24, 24), new THREE.MeshStandardMaterial({ color: '#6366f1', emissive: '#6366f1', emissiveIntensity: 2 }));
orb.position.y = y + 3.2; root.add(orb);
const parts = [];
function burst() {
  for (let i = 0; i < 80; i++) {
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(Math.random(), 0.9, 0.6) }));
    p.position.copy(orb.position);
    const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5).normalize().multiplyScalar(2 + Math.random() * 4);
    parts.push({ p, v, life: 1.6 });
    root.add(p);
  }
}
return {
  root,
  hoverLabel: 'Click for fireworks',
  onClick() { burst(); },
  update(dt, t) {
    orb.scale.setScalar(1 + Math.sin(t * 3) * 0.15);
    for (let i = parts.length - 1; i >= 0; i--) {
      const q = parts[i]; q.life -= dt; q.v.y -= 6 * dt; q.p.position.addScaledVector(q.v, dt);
      if (q.life <= 0) { root.remove(q.p); parts.splice(i, 1); }
    }
  },
};
\`\`\``;

async function mockStream(send, text, ac) {
  for (let i = 0; i < text.length; i += 48) {
    if (ac.signal.aborted) return;
    send({ type: 'delta', text: text.slice(i, i + 48) });
    await new Promise((r) => setTimeout(r, 18));
  }
}

// ---------- generation (SSE) ----------
async function handleGenerate(req, res) {
  loadEnv();
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return json(res, 400, { error: `Bad request: ${e.message}` });
  }
  const def = MODEL_DEFS[body.model];
  const mode = body.mode === 'execute' ? 'execute' : 'plan';
  if (!def) return json(res, 400, { error: 'Unknown model' });
  if (!def.roles.includes(mode)) return json(res, 400, { error: `${def.label} cannot be used for ${mode}` });
  const key = getEnv('ANTHROPIC_API_KEY');
  if (!key) {
    return json(res, 400, {
      error: 'ANTHROPIC_API_KEY is missing. Add it to treejs-generator/.env (or set it to "mock" to test) and retry.',
    });
  }
  if (!body.session || !Array.isArray(body.session.messages)) return json(res, 400, { error: 'Missing session' });

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (o) => !res.writableEnded && res.write(`data: ${JSON.stringify(o)}\n\n`);
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  try {
    if (key === 'mock') {
      const text = mode === 'plan' ? MOCK_PLAN : MOCK_CODE;
      await mockStream(send, text, ac);
      send({ type: 'done', text, usage: { input: 1200, output: Math.round(text.length / 4) } });
      return res.end();
    }

    const built = mode === 'plan' ? buildPlanRequest(body.session) : buildExecRequest(body.session, body.fix);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: getEnv(def.envKey) || def.fallback,
        max_tokens: mode === 'execute' ? Number(getEnv('MAX_TOKENS_EXECUTE')) || 64000 : built.maxTokens,
        system: [{ type: 'text', text: built.system, cache_control: { type: 'ephemeral' } }],
        messages: built.messages,
        stream: true,
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      let msg = t;
      try {
        msg = JSON.parse(t).error?.message || t;
      } catch {}
      send({ type: 'error', error: `Anthropic API ${r.status}: ${msg}` });
      return res.end();
    }

    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    const usage = { input: 0, output: 0 };
    let stopReason = '';
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = block.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          full += ev.delta.text;
          send({ type: 'delta', text: ev.delta.text });
        } else if (ev.type === 'message_start') {
          const u = ev.message?.usage || {};
          usage.input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        } else if (ev.type === 'message_delta') {
          usage.output = ev.usage?.output_tokens || usage.output;
          stopReason = ev.delta?.stop_reason || stopReason;
        }
        else if (ev.type === 'error') {
          send({ type: 'error', error: ev.error?.message || 'Stream error' });
          return res.end();
        }
      }
    }
    send({ type: 'done', text: full, usage, stopReason });
    res.end();
  } catch (e) {
    if (e.name !== 'AbortError') send({ type: 'error', error: e.message });
    res.end();
  }
}

// ---------- routes ----------
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/api/config' && req.method === 'GET') {
      loadEnv();
      const key = getEnv('ANTHROPIC_API_KEY');
      return json(res, 200, {
        hasKey: !!key,
        mock: key === 'mock',
        models: Object.entries(MODEL_DEFS).map(([id, d]) => ({ id, label: d.label, roles: d.roles, pricing: d.pricing })),
      });
    }
    if (p === '/api/sessions' && req.method === 'GET') {
      const list = [];
      for (const f of fs.readdirSync(DATA_DIR)) {
        if (!f.endsWith('.json')) continue;
        try {
          const s = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
          list.push({
            id: s.id, title: s.title, updatedAt: s.updatedAt || s.createdAt || 0,
            models: (s.messages || []).filter((m) => m.role === 'result' && m.code && !m.error).length,
          });
        } catch {}
      }
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      return json(res, 200, list);
    }
    const sm = p.match(/^\/api\/sessions\/([^/]+)$/);
    if (sm) {
      const id = sm[1];
      if (!safeId(id)) return json(res, 400, { error: 'Bad id' });
      if (req.method === 'GET') {
        if (!fs.existsSync(sessionFile(id))) return json(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(fs.readFileSync(sessionFile(id)));
      }
      if (req.method === 'PUT') {
        const s = await readJson(req);
        s.id = id;
        s.updatedAt = Date.now();
        fs.writeFileSync(sessionFile(id), JSON.stringify(s));
        return json(res, 200, { ok: true, updatedAt: s.updatedAt });
      }
      if (req.method === 'DELETE') {
        if (fs.existsSync(sessionFile(id))) fs.unlinkSync(sessionFile(id));
        return json(res, 200, { ok: true });
      }
    }
    if (p === '/api/generate' && req.method === 'POST') return handleGenerate(req, res);

    // static (production build)
    if (!p.startsWith('/api') && fs.existsSync(DIST_DIR)) {
      let file = path.join(DIST_DIR, p === '/' ? 'index.html' : p);
      if (!file.startsWith(DIST_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST_DIR, 'index.html');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(file));
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

const PORT = Number(getEnv('PORT')) || 8787;
server.listen(PORT, () => console.log(`[treejs-generator] API listening on http://localhost:${PORT}`));

