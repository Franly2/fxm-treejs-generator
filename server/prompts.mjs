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

export const EDIT_PLAN_SYSTEM = `You are the PLANNER of a "photo to 3D" generator. An existing Three.js model ALREADY exists in CURRENT MODEL CODE.
Your job is to write a SHORT, SURGICAL DELTA PLAN describing ONLY what changes for this edit request. Do NOT repeat untouched components, inventories, or tables.

Reply in the language the user writes in (default: English).

The VERY FIRST LINE of your reply must be:
OBJECT: <short name of the object>

Then write ONLY these concise Markdown sections (aim for ~150–400 words total):

## 1. Edit summary
Bullet list of what changes and what stays untouched.

## 2. Module changes
Name the exact existing \`// ---------- <section> ----------\` module(s) from CURRENT MODEL CODE to modify or add, with exact coordinates, dimensions, hex colors, and logic changes.

## 3. Assumptions
1–3 brief bullets only if anything is ambiguous; propose defaults.

Rules:
- Never re-list untouched meshes, untouched colors, or full triangle budgets.
- No code blocks of final implementation.`;

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
- Organize \`// MODE: FULL\` code into clear top-level sections per 3D sub-asset/component using \`// ---------- <componentName> ----------\` (e.g. \`// ---------- setup ----------\`, \`// ---------- body ----------\`, \`// ---------- wheels ----------\`, \`// ---------- animation ----------\`) so the editor can show each component as a separate module tab.
- The code must run on the first try. Double-check variable names, closing brackets and API usage of THREE.

THREE OUTPUT MODES (the FIRST LINE inside the code block must be a mode comment)
- When NO previous code exists: start with \`// MODE: FULL\` and write the complete model organized into \`// ---------- <section> ----------\` sections.
- When PREVIOUS VERSION CODE exists, minimize tokens by choosing the smallest applicable mode:
  1) \`// MODE: MODULE\` (PREFERRED for almost all edits — modifying existing curves, positions, counts, colors, labels, UI, helpers, or adding/replacing components):
     Start with \`// MODE: MODULE\`, then output ONLY the modified or new \`// ---------- <sectionName> ----------\` block(s).
     - To replace an existing section, use its EXACT header (e.g. \`// ---------- pipe bundle (straight, horizontal) ----------\`) and write the updated code for that section ONLY.
     - Keep using variables/helpers defined in earlier untouched sections (e.g. \`root\`, \`g\`, \`M\`, \`add\`). Do NOT repeat untouched sections!
     - To remove a section, write a single line \`// DELETE: <sectionName>\`.
     - If editing a section that returns \`{ root, update, ... }\`, keep the \`return { ... }\` at the end of that final section.
  2) \`// MODE: PATCH\` (ONLY when adding standalone effects/overlays via \`function (THREE, ctx, base)\` without modifying any existing section internals). Return optional \`{ update, onClick, hoverLabel, isClickable }\` chained onto \`base\`.
  3) \`// MODE: FULL\` ONLY as a last resort when the entire codebase architecture must be rewritten from scratch or no section structure exists.
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

function extractSectionNames(code) {
  const names = [];
  for (const line of (code || '').split('\n')) {
    const m = /^\s*\/\/\s*(?:FILE:\s*([^\s]+)|[-=]{2,}\s*([^=\-\n]+?)\s*[-=]{2,})\s*$/i.exec(line);
    if (m) names.push((m[1] || m[2] || '').trim());
  }
  return names;
}

function imagesAfterLastBuild(session) {
  const msgs = session.messages || [];
  let lastResultIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'result' && msgs[i].code && !msgs[i].error) { lastResultIdx = i; break; }
  }
  if (lastResultIdx === -1) return null;
  const out = [];
  for (let i = lastResultIdx + 1; i < msgs.length; i++) {
    if (msgs[i].role === 'user') for (const u of msgs[i].images || []) out.push(u);
  }
  return out;
}

export function buildPlanRequest(session) {
  const code = lastGoodCode(session);
  const isEdit = !!code;
  const afterBuild = isEdit ? imagesAfterLastBuild(session) : null;
  // On text-only edits, skip re-sending old reference images to save ~3k-8k input tokens
  const allow = isEdit && afterBuild !== null
    ? new Set(afterBuild.slice(-3))
    : recentImageSet(session, isEdit ? 3 : 8);
  const messages = [];
  for (const m of session.messages || []) {
    if (m.role === 'user') messages.push({ role: 'user', content: userBlocks(m, allow) });
    else if (m.role === 'plan') {
      if (isEdit && m.executed) messages.push({ role: 'assistant', content: '[Previous plan approved and built.]' });
      else messages.push({ role: 'assistant', content: m.raw || m.text });
    } else if (m.role === 'result' && !m.error) {
      messages.push({ role: 'assistant', content: `[Model version ${m.version} generated.]` });
    }
  }
  let system = isEdit ? EDIT_PLAN_SYSTEM : PLAN_SYSTEM;
  if (code) {
    const sections = extractSectionNames(code);
    const secLine = sections.length ? `\nEXISTING MODULES: ${sections.join(', ')}\n` : '';
    system += `${secLine}\nCURRENT MODEL CODE (the latest generated version; treat new requests as surgical edits to it):\n\`\`\`js\n${code.slice(0, 60000)}\n\`\`\``;
  }
  return { system, messages, maxTokens: isEdit ? 4000 : 12000 };
}

export function buildExecRequest(session, fix) {
  const msgs = session.messages || [];
  let plan = null;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'plan') { plan = msgs[i]; break; }
  const prev = lastGoodCode(session);

  // On edits, only send images attached after the last built result (skip old images on text-only edits)
  const afterBuild = prev ? imagesAfterLastBuild(session) : null;
  const allow = (!prev || afterBuild === null)
    ? recentImageSet(session, 6)
    : new Set(afterBuild.slice(-4));

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
  if (fix && fix.code) {
    if (fix.moduleEdit) {
      text += `\nYour previous MODULE edit failed at runtime with this error:\n${fix.error}\n\nFAILED MODULE EDIT (return a corrected \`// MODE: MODULE\` block):\n\`\`\`js\n${fix.code.slice(0, 60000)}\n\`\`\`\n`;
      if (prev) text += `\nPREVIOUS VERSION CODE (reference only; do not repeat untouched sections):\n\`\`\`js\n${prev.slice(0, 80000)}\n\`\`\`\n`;
    } else if (fix.patch) {
      text += `\nYour previous PATCH failed at runtime with this error:\n${fix.error}\n\nFAILED PATCH (return a corrected \`// MODE: PATCH\` block):\n\`\`\`js\n${fix.code.slice(0, 60000)}\n\`\`\`\n`;
      if (prev) text += `\nPREVIOUS VERSION CODE that the patch is applied on (for reference only, do not repeat it):\n\`\`\`js\n${prev.slice(0, 80000)}\n\`\`\`\n`;
    } else {
      text += `\nThe previous code failed at runtime with this error:\n${fix.error}\n\nFAILED CODE (fix it and return the corrected code with \`// MODE: FULL\`):\n\`\`\`js\n${fix.code.slice(0, 80000)}\n\`\`\`\n`;
    }
  } else if (prev) {
    const sections = extractSectionNames(prev);
    if (sections.length) {
      text += `\nEXISTING MODULES IN PREVIOUS CODE (target only what changes via \`// MODE: MODULE\`):\n- ${sections.join('\n- ')}\n`;
    }
    text += `\nPREVIOUS VERSION CODE (reference; prefer \`// MODE: MODULE\` and output ONLY changed sections):\n\`\`\`js\n${prev.slice(0, 80000)}\n\`\`\`\n`;
  }
  text += '\nWrite the code now as a single ```js block whose first line is the MODE comment.';
  content.push({ type: 'text', text });
  return { system: EXEC_SYSTEM, messages: [{ role: 'user', content }], maxTokens: prev ? 16000 : 32000 };
}

