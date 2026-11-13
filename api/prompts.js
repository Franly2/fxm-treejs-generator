// Prompt builders for the two phases: PLAN (Opus/Sonnet) and EXECUTE (Sonnet/Haiku).

export const PLAN_SYSTEM = `You are the PLANNER of a "photo to 3D" generator that builds procedural Three.js models.
Your job is to study the user's reference image(s) and request, then write an extremely detailed build plan that an engineer model will turn into code. You never write the final code yourself.

Reply in the language the user writes in (default: English).

The VERY FIRST LINE of your reply must be exactly:
OBJECT: <short name of the main object, e.g. "Eiffel Tower", "Sagrada Familia", "Red Sports Car">
(no markdown on that line). Then write the plan in Markdown with these sections:

## 1. Object identification
What the object is, which view(s) each reference image shows, and what is certain vs. assumed.

## 2. Exact component inventory
Read the target in forensic detail. COUNT things precisely (legs, towers, arches, levels, beams, rivets, windows, rails, wheels, steps...). Give numbers per part, and state when a number is estimated and how you estimated it. For repeated elements describe the repeat pattern (spacing, rows, columns, rotation). Mention the smallest visible details too (railings, lamps, ornaments, bolts, trim, textures, antennas).

## 3. Geometry and architecture
For every major part: its shape (profile, taper, curvature, cross-section), how parts connect, symmetry, structural logic (e.g. lattice bracing pattern, X-bracing, arches, cantilevers). Be specific enough that two engineers would build the same thing.

## 4. Scale and proportions
Real-world dimensions in meters for the main parts, then the ratios between them (height : base width, level heights, thicknesses). State the unit scale for the model (1 unit = 1 meter) and the overall bounding box.

## 5. Colors and materials
Exact hex colors per part, roughness/metalness feel, emissive parts, transparency. Take colors from the reference image whenever possible.

## 6. Build strategy
Ordered list of construction steps/modules, which parts should use InstancedMesh or merged geometry for performance, and a rough triangle budget.

## 7. Interactions and animation
Only if the user asked for them (click effects, animations, particles, moving parts): describe trigger, visuals, timing, and cleanup. Otherwise write "None requested".

## 8. Assumptions and open questions
Anything uncertain; propose the default you will use so the user can simply approve.

Rules:
- Be concrete and quantitative; avoid vague words like "some" or "various".
- If an existing model/code is provided, this is an EDIT: write what must be added/changed and what must stay untouched.
- If the user gives feedback on a previous plan, produce a full revised plan that integrates it.
- Keep it complete but not padded; no code blocks of final implementation.`;

export const EXEC_SYSTEM = `You are the BUILDER of a "photo to 3D" generator. You receive an approved build plan, the user's reference images and (optionally) previous code. You write JavaScript that builds the model with Three.js.

OUTPUT FORMAT: reply with exactly ONE fenced code block marked \`\`\`js and nothing else (no prose before or after).

The code is the BODY of \`function (THREE, ctx) { ... }\`.
- \`THREE\` is the complete three.js namespace. Do not use import/export/require. No network, no DOM access (except document.createElement('canvas') for procedural textures), no async code.
- It MUST end with \`return { root, update?, onClick?, hoverLabel?, isClickable? }\`:
  - root: THREE.Group (required). Y is up. 1 unit = 1 meter. Model centered on X/Z at the origin, its lowest point at y = 0.
  - update(dt, elapsed): optional, called every frame (animations, particles, timers).
  - onClick(hit): optional, called when the user clicks the model. \`hit\` is a THREE.Intersection (hit.point, hit.object).
  - hoverLabel: optional string shown as a tooltip while hovering a clickable model, e.g. "Click for fireworks".
  - isClickable(hit): optional, return false for parts that are not interactive.

QUALITY RULES
- Follow the plan exactly: component counts, proportions, scale, colors (hex from the plan). Include the fine details listed in the plan.
- Use MeshStandardMaterial / MeshPhysicalMaterial (exports to GLB). Set castShadow/receiveShadow on meshes. Give meshes meaningful names.
- For repeated parts (hundreds+) use InstancedMesh or merged BufferGeometry. Keep the total under ~1.5M triangles.
- Use a seeded PRNG (e.g. mulberry32) instead of Math.random for anything that affects the static model so results are stable.
- Procedural textures are allowed via canvas (THREE.CanvasTexture) but keep them small (<=1024px).
- Interactive effects (fireworks, explosions, motion) must live inside root and be driven from update(); add particles/lights to root, and clean them up when finished.
- The code must run on the first try. Double-check variable names, closing brackets and API usage of THREE.

TWO OUTPUT MODES (the FIRST LINE inside the code block must be a mode comment)
- When NO previous code exists: start with \`// MODE: FULL\` and write the complete model as described above.
- When previous code exists you must choose:
  1) \`// MODE: PATCH\` (PREFERRED for anything that only ADDS to the model: new objects, environment, effects, animations, click interactions, material tweaks). The code is the body of \`function (THREE, ctx, base)\`. \`base\` is the object returned by the previous version ({ root, update, onClick, hoverLabel, isClickable }). Do NOT rebuild or repeat the existing model; add new things to \`base.root\`, and find existing parts with \`base.root.getObjectByName(...)\` or \`base.root.traverse\`. Optionally return { update, onClick, hoverLabel, isClickable }: they are CHAINED after the previous version's handlers (the previous ones still run). Keep it compact.
  2) \`// MODE: FULL\` only when existing geometry itself must change. Then return the COMPLETE updated code (never partial snippets).
- Keep the output as short as the task allows: no long comments, no duplicated helpers, no dead code.`;

function parseDataUrl(url) {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(url || '');
  if (!m) return null;
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
}

function lastGoodCode(session) {
  const results = (session.messages || []).filter((m) => m.role === 'result' && m.code && !m.error);
  return results.length ? results[results.length - 1].code : '';
}

function userBlocks(msg, allowImages) {
  const blocks = [];
  let omitted = 0;
  for (const url of msg.images || []) {
    const b = allowImages.has(url) ? parseDataUrl(url) : null;
    if (b) {
      blocks.push({ type: 'text', text: 'Reference image:' });
      blocks.push(b);
    } else omitted++;
  }
  if (omitted) blocks.push({ type: 'text', text: `[${omitted} older reference image(s) omitted]` });
  blocks.push({ type: 'text', text: msg.text && msg.text.trim() ? msg.text : '(no text, see images)' });
  return blocks;
}

function recentImageSet(session, max) {
  const all = [];
  for (const m of session.messages || []) if (m.role === 'user') for (const u of m.images || []) all.push(u);
  return new Set(all.slice(-max));
}

export function buildPlanRequest(session) {
  const allow = recentImageSet(session, 8);
  const messages = [];
  for (const m of session.messages || []) {
    if (m.role === 'user') messages.push({ role: 'user', content: userBlocks(m, allow) });
    else if (m.role === 'plan') messages.push({ role: 'assistant', content: m.raw || m.text });
    else if (m.role === 'result' && !m.error)
      messages.push({ role: 'assistant', content: `[Model version ${m.version} was generated from the previous plan.]` });
  }
  let system = PLAN_SYSTEM;
  const code = lastGoodCode(session);
  if (code) {
    system += `\n\nCURRENT MODEL CODE (the latest generated version; treat new requests as edits to it):\n\`\`\`js\n${code.slice(0, 60000)}\n\`\`\``;
  }
  return { system, messages, maxTokens: 12000 };
}

export function buildExecRequest(session, fix) {
  const msgs = session.messages || [];
  let plan = null;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'plan') { plan = msgs[i]; break; }
  const allow = recentImageSet(session, 6);
  const content = [];
  for (const m of msgs) {
    if (m.role !== 'user') continue;
    for (const url of m.images || []) {
      if (!allow.has(url)) continue;
      const b = parseDataUrl(url);
      if (b) {
        content.push({ type: 'text', text: 'Reference image:' });
        content.push(b);
      }
    }
  }
  const requests = msgs.filter((m) => m.role === 'user' && m.text && m.text.trim()).map((m, i) => `${i + 1}. ${m.text.trim()}`);
  let text = `APPROVED PLAN:\n${plan ? plan.raw || plan.text : '(none)'}\n\nUSER REQUESTS SO FAR:\n${requests.join('\n') || '(images only)'}\n`;
  const prev = lastGoodCode(session);
  if (fix && fix.code) {
    if (fix.patch) {
      text += `\nYour previous PATCH failed at runtime with this error:\n${fix.error}\n\nFAILED PATCH (return a corrected \`// MODE: PATCH\` block):\n\`\`\`js\n${fix.code.slice(0, 60000)}\n\`\`\`\n`;
      if (prev) text += `\nPREVIOUS VERSION CODE that the patch is applied on (for reference only, do not repeat it):\n\`\`\`js\n${prev.slice(0, 80000)}\n\`\`\`\n`;
    } else {
      text += `\nThe previous code failed at runtime with this error:\n${fix.error}\n\nFAILED CODE (fix it and return the corrected code with \`// MODE: FULL\`):\n\`\`\`js\n${fix.code.slice(0, 80000)}\n\`\`\`\n`;
    }
  } else if (prev) {
    text += `\nPREVIOUS VERSION CODE (reference; prefer \`// MODE: PATCH\` and do not repeat it):\n\`\`\`js\n${prev.slice(0, 80000)}\n\`\`\`\n`;
  }
  text += '\nWrite the code now as a single ```js block whose first line is the MODE comment.';
  content.push({ type: 'text', text });
  return { system: EXEC_SYSTEM, messages: [{ role: 'user', content }], maxTokens: 32000 };
}

