import { buildPlanRequest, buildExecRequest } from './prompts.js';

export const config = { runtime: 'edge' };

const MODEL_MAP = {
  opus: process.env.MODEL_OPUS || 'claude-opus-5-5',
  sonnet: process.env.MODEL_SONNET || 'claude-sonnet-5-5',
  haiku: process.env.MODEL_HAIKU || 'claude-haiku-5-5',
  'claude-opus-5-5': process.env.MODEL_OPUS || 'claude-opus-5-5',
  'claude-sonnet-5-5': process.env.MODEL_SONNET || 'claude-sonnet-5-5',
  'claude-haiku-5-5': process.env.MODEL_HAIKU || 'claude-haiku-5-5',
};

const MOCK_PLAN = `OBJECT: Demo Tower
## 1. Object identification
A stepped demo tower used to test the generator pipeline (mock mode, no API call).

## 2. Exact component inventory
- 1 square base plinth
- 3 stacked tapered sections
- 1 spire
- 1 glowing orb on top

## 3. Geometry and architecture
Each section is a tapered box reducing 20% per level.

## 4. Scale and proportions
Total height 12 m, base 6 m x 6 m.

## 5. Colors and materials
Plinth #475569, sections #94a3b8, spire #e2e8f0, orb emissive #6366f1.

## 6. Build strategy
Simple meshes, no instancing needed.

## 7. Interactions and animation
Clicking the tower launches a burst of colored particles.

## 8. Assumptions and open questions
None.`;

const MOCK_CODE = `\`\`\`js
// MODE: FULL
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
return { root };
\`\`\``;

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    const body = await req.json();
    const key = process.env.ANTHROPIC_API_KEY;

    if (!key) {
      return new Response(
        JSON.stringify({
          error: 'ANTHROPIC_API_KEY is missing. Configure it in Vercel Project Settings (Environment Variables).',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      );
    }

    const mode = body.mode === 'execute' ? 'execute' : 'plan';
    const modelId = MODEL_MAP[body.model] || body.model || 'claude-sonnet-5-5';

    // Mock test mode
    if (key === 'mock') {
      const mockText = mode === 'plan' ? MOCK_PLAN : MOCK_CODE;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          for (let i = 0; i < mockText.length; i += 40) {
            const chunk = mockText.slice(i, i + 40);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: chunk })}\n\n`));
            await new Promise((r) => setTimeout(r, 20));
          }
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'done', text: mockText, usage: { input: 0, output: Math.round(mockText.length / 4) } })}\n\n`
            )
          );
          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    const built = mode === 'plan' ? buildPlanRequest(body.session) : buildExecRequest(body.session, body.fix);
    const maxTokens = mode === 'execute' ? Number(process.env.MAX_TOKENS_EXECUTE) || built.maxTokens || 32000 : built.maxTokens || 4096;

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        system: built.system,
        messages: built.messages,
        stream: true,
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      let msg = errText;
      try {
        msg = JSON.parse(errText).error?.message || errText;
      } catch {}
      return new Response(JSON.stringify({ error: `Anthropic API ${anthropicRes.status}: ${msg}` }), {
        status: anthropicRes.status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // Stream SSE back to client
    const transformStream = new TransformStream({
      start() {
        this.decoder = new TextDecoder();
        this.encoder = new TextEncoder();
        this.buf = '';
        this.usage = { input: 0, output: 0 };
        this.stopReason = '';
      },
      transform(chunk, controller) {
        this.buf += this.decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = this.buf.indexOf('\n\n')) !== -1) {
          const block = this.buf.slice(0, idx);
          this.buf = this.buf.slice(idx + 2);
          const line = block.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim());
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              controller.enqueue(this.encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: ev.delta.text })}\n\n`));
            } else if (ev.type === 'message_start') {
              this.usage.input = ev.message?.usage?.input_tokens || 0;
            } else if (ev.type === 'message_delta') {
              this.usage.output = ev.usage?.output_tokens || this.usage.output;
              this.stopReason = ev.delta?.stop_reason || this.stopReason;
            } else if (ev.type === 'message_stop') {
              controller.enqueue(
                this.encoder.encode(`data: ${JSON.stringify({ type: 'done', usage: this.usage, stopReason: this.stopReason })}\n\n`)
              );
            } else if (ev.type === 'error') {
              controller.enqueue(this.encoder.encode(`data: ${JSON.stringify({ type: 'error', error: ev.error?.message || 'Stream error' })}\n\n`));
            }
          } catch {}
        }
      },
      flush() {},
    });

    return new Response(anthropicRes.body.pipeThrough(transformStream), {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
