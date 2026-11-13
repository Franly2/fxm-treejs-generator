const PATCH_PREFIX = 'const __base = (function (THREE, ctx) {\n';
const PATCH_MID = '\n}).call(null, THREE, ctx);\nconst __add = (function (THREE, ctx, base) {\n';
const PATCH_SUFFIX = `\n}).call(null, THREE, ctx, __base) || {};
const __chain = (a, b) => (a && b ? function (...args) { a.apply(this, args); b.apply(this, args); } : a || b);
return {
  root: __base.root,
  update: __chain(__base.update, __add.update),
  onClick: __chain(__base.onClick, __add.onClick),
  hoverLabel: __add.hoverLabel || __base.hoverLabel,
  isClickable: __add.isClickable && __base.isClickable ? (h) => __add.isClickable(h) || __base.isClickable(h) : __add.isClickable || __base.isClickable,
};`;

/**
 * Unwraps nested composePatch() wrappers back into { baseCode, patches[] }.
 */
export function unwrapPatches(code) {
  let cur = code || '';
  const patches = [];
  while (cur.startsWith(PATCH_PREFIX) && cur.endsWith(PATCH_SUFFIX)) {
    const inner = cur.slice(PATCH_PREFIX.length, cur.length - PATCH_SUFFIX.length);
    const midIdx = inner.lastIndexOf(PATCH_MID);
    if (midIdx === -1) break;
    patches.unshift(inner.slice(midIdx + PATCH_MID.length));
    cur = inner.slice(0, midIdx);
  }
  return { baseCode: cur, patches };
}

function updateBraceDepth(line, depth) {
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (inSingle) {
      if (ch === '\\') i++;
      else if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\') i++;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (ch === '\\') i++;
      else if (ch === '`') inTemplate = false;
      continue;
    }
    if (ch === '/' && next === '/') break;
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === '`') inTemplate = true;
    else if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
  }
  return depth;
}

function sanitizeFileName(rawTitle, used) {
  const withoutParens = rawTitle.replace(/\([^)]*\)/g, '').trim() || rawTitle;
  const words = withoutParens
    .replace(/\.tsx?$/i, '')
    .replace(/\.js$/i, '')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  let base = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
  if (!base) base = 'module';
  let name = `${base}.ts`;
  let n = 2;
  while (used.has(name)) {
    name = `${base}${n}.ts`;
    n++;
  }
  used.add(name);
  return name;
}

const SECTION_RE = /^\s*\/\/\s*(?:FILE:\s*([^\s]+)|[-=]{2,}\s*([^=\-\n]+?)\s*[-=]{2,})\s*$/i;

/**
 * Splits a single base code block into named .ts module chunks at top-level section dividers.
 */
export function splitBaseIntoModules(baseCode) {
  const lines = (baseCode || '').split('\n');
  const sections = [];
  let currentTitle = null;
  let currentExplicitName = null;
  let buf = [];
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = depth === 0 ? SECTION_RE.exec(line) : null;
    if (m) {
      const textBefore = buf.join('\n');
      if (currentTitle !== null || textBefore.trim()) {
        sections.push({
          title: currentTitle || 'setup',
          explicitName: currentExplicitName,
          content: textBefore,
        });
      }
      currentExplicitName = m[1] ? m[1].trim() : null;
      currentTitle = (m[1] || m[2] || '').trim();
      buf = [line];
    } else {
      buf.push(line);
    }
    depth = updateBraceDepth(line, depth);
  }

  const tail = buf.join('\n');
  if (currentTitle !== null || tail.trim()) {
    sections.push({
      title: currentTitle || (sections.length === 0 ? 'main' : 'module'),
      explicitName: currentExplicitName,
      content: tail,
    });
  }

  if (sections.length <= 1) {
    const only = sections[0];
    return [
      {
        id: 'base-0',
        name: only?.explicitName || 'main.ts',
        title: only?.title || 'main',
        kind: 'base',
        content: baseCode || '',
      },
    ];
  }

  const used = new Set();
  return sections.map((sec, idx) => {
    let name = sec.explicitName;
    if (name) {
      if (!name.endsWith('.ts') && !name.endsWith('.js')) name += '.ts';
      while (used.has(name)) name = name.replace(/(\.\w+)$/, `${idx + 1}$1`);
      used.add(name);
    } else {
      name = sanitizeFileName(sec.title, used);
    }
    return {
      id: `base-${idx}`,
      name,
      title: sec.title,
      kind: 'base',
      content: sec.content,
    };
  });
}

/**
 * Decomposes full executable code into editable .ts component files + patch files.
 */
export function codeToFiles(code) {
  const { baseCode, patches } = unwrapPatches(code);
  const files = splitBaseIntoModules(baseCode);
  patches.forEach((p, idx) => {
    files.push({
      id: `patch-${idx}`,
      name: `patch_v${idx + 2}.ts`,
      title: `Patch v${idx + 2}`,
      kind: 'patch',
      content: p,
    });
  });
  return files;
}

/**
 * Re-bundles component files and patch files back into one executable program.
 */
export function filesToCode(files, composePatchFn) {
  const baseParts = [];
  const patchParts = [];
  for (const f of files || []) {
    if (f.kind === 'patch') patchParts.push(f.content);
    else baseParts.push(f.content);
  }
  let code = baseParts.join('\n');
  for (const p of patchParts) {
    code = composePatchFn(code, p);
  }
  return code;
}

function normalizeSectionKey(str) {
  return (str || '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\.(ts|js)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Replaces or inserts only the updated // ---------- <section> ---------- modules
 * into the previous version's code without rewriting untouched modules.
 */
export function applyModuleEdit(prevCode, modulePatchCode, composePatchFn) {
  const existing = codeToFiles(prevCode);
  let baseFiles = existing.filter((f) => f.kind !== 'patch').map((f) => ({ ...f }));
  const patchFiles = existing.filter((f) => f.kind === 'patch').map((f) => ({ ...f }));

  let cleaned = (modulePatchCode || '').replace(/^\s*\/\/\s*MODE:\s*MODULE\b[^\n]*\n?/i, '');
  const deleteKeys = new Set();
  cleaned = cleaned
    .split('\n')
    .filter((line) => {
      const m = /^\s*\/\/\s*DELETE:\s*(.+)$/i.exec(line);
      if (m) {
        const k = normalizeSectionKey(m[1]);
        if (k) deleteKeys.add(k);
        return false;
      }
      return true;
    })
    .join('\n');

  if (deleteKeys.size) {
    baseFiles = baseFiles.filter((f) => !deleteKeys.has(normalizeSectionKey(f.title)) && !deleteKeys.has(normalizeSectionKey(f.name)));
  }

  const incoming = splitBaseIntoModules(cleaned);
  for (const sec of incoming) {
    const key = normalizeSectionKey(sec.title);
    const nameKey = normalizeSectionKey(sec.name);
    const idx = baseFiles.findIndex((f) => {
      const ft = normalizeSectionKey(f.title);
      const fn = normalizeSectionKey(f.name);
      return (key && (ft === key || fn === key)) || (nameKey && (ft === nameKey || fn === nameKey));
    });
    if (idx >= 0) {
      baseFiles[idx] = { ...baseFiles[idx], title: sec.title, content: sec.content };
    } else {
      const insertAt = Math.max(0, baseFiles.length - 1);
      baseFiles.splice(insertAt, 0, {
        id: `base-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: sec.name,
        title: sec.title,
        kind: 'base',
        content: sec.content,
      });
    }
  }

  return filesToCode([...baseFiles, ...patchFiles], composePatchFn);
}


