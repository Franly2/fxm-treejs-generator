import './style.css';
import { Viewer } from './viewer.js';
import { renderMarkdown, escapeHtml } from './markdown.js';
import { buildExportBundle } from './exportZip.js';
import { codeToFiles, filesToCode, applyModuleEdit } from './files.js';
import * as api from './api.js';

const $ = (s) => document.querySelector(s);
const uid = () => crypto.randomUUID();

const state = {
  config: null,
  sessions: [],
  current: null,
  stream: null,
  abort: null,
  attachments: [],
  viewId: null,
  execModel: 'sonnet',
  editorFiles: [],
  activeFileId: null,
};

const viewer = new Viewer($('#viewer'), $('#viewer-tip'));
window.__viewer = viewer;
viewer.onRuntimeError = (err) => toast(`Model runtime error: ${err.message}`, 'error');

const MODEL_LABEL = { opus: 'Opus 5.5', sonnet: 'Sonnet 5.5', haiku: 'Haiku 5.5', import: 'Imported' };
const DEFAULT_PRICING = {
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
};

function getModelPricing(modelId) {
  const cfg = state.config?.models?.find((m) => m.id === modelId);
  return cfg?.pricing || DEFAULT_PRICING[modelId] || DEFAULT_PRICING.sonnet;
}

function calcCost(inputTokens, outputTokens, modelId) {
  const p = getModelPricing(modelId);
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

function fmtTokens(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 1 : 2).replace(/\.0+$/, '')}k`;
  return String(n);
}

function fmtCost(usd) {
  if (usd <= 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function getMsgUsage(m) {
  if (!m) return { input: 0, output: 0, total: 0, cost: 0, estimated: false };
  if (m.usage && (typeof m.usage.input === 'number' || typeof m.usage.output === 'number')) {
    const input = m.usage.input || 0;
    const output = m.usage.output || 0;
    return { input, output, total: input + output, cost: calcCost(input, output, m.model), estimated: false };
  }
  if (m.role === 'result') {
    const output = m.tokens || Math.round((m.code?.length || 0) / 4);
    const input = Math.round((m.code?.length || 4000) / 3.5);
    return { input, output, total: input + output, cost: calcCost(input, output, m.model), estimated: true };
  }
  if (m.role === 'plan') {
    const len = (m.raw || m.text || '').length;
    const output = Math.round(len / 4);
    const input = 1800;
    return { input, output, total: input + output, cost: calcCost(input, output, m.model), estimated: true };
  }
  return { input: 0, output: 0, total: 0, cost: 0, estimated: false };
}

function getVersionTotalUsage(session, resultMsg) {
  const msgs = session?.messages || [];
  const idx = msgs.findIndex((x) => x.id === resultMsg.id);
  let pairedPlan = null;
  for (let i = idx - 1; i >= 0; i--) {
    if (msgs[i].role === 'result' && !msgs[i].error) break;
    if (msgs[i].role === 'plan') {
      pairedPlan = msgs[i];
      break;
    }
  }
  const build = getMsgUsage(resultMsg);
  const plan = pairedPlan ? getMsgUsage(pairedPlan) : { input: 0, output: 0, total: 0, cost: 0, estimated: false };
  return {
    build,
    plan,
    input: build.input + plan.input,
    output: build.output + plan.output,
    total: build.total + plan.total,
    cost: build.cost + plan.cost,
    estimated: build.estimated || plan.estimated,
  };
}

function getSessionUsage(session) {
  let input = 0;
  let output = 0;
  let cost = 0;
  let estimated = false;
  for (const m of session?.messages || []) {
    if (m.role !== 'plan' && m.role !== 'result') continue;
    const u = getMsgUsage(m);
    input += u.input;
    output += u.output;
    cost += u.cost;
    if (u.estimated) estimated = true;
  }
  return { input, output, total: input + output, cost, estimated };
}

// ---------------------------------------------------------------- helpers
function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => {
    el.classList.remove('in');
    setTimeout(() => el.remove(), 300);
  }, 4200);
}

const newSession = () => ({ id: uid(), title: 'New chat', titleSet: false, createdAt: Date.now(), messages: [] });
const results = (s) => s.messages.filter((m) => m.role === 'result' && m.code && !m.error);
const pendingPlan = (s) => {
  const last = s.messages[s.messages.length - 1];
  return last && last.role === 'plan' && !last.executed ? last : null;
};
const busy = () => !!state.stream;

function timeAgo(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function persist() {
  const s = state.current;
  if (!s || !s.messages.length) return;
  try {
    const r = await api.saveSession(s);
    s.updatedAt = r.updatedAt;
    const entry = { id: s.id, title: s.title, updatedAt: s.updatedAt, models: results(s).length };
    const i = state.sessions.findIndex((x) => x.id === s.id);
    if (i >= 0) state.sessions[i] = entry;
    else state.sessions.unshift(entry);
    state.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    renderSidebar();
  } catch (e) {
    toast(`Could not save chat: ${e.message}`, 'error');
  }
}

// ---------------------------------------------------------------- sidebar
function renderSidebar() {
  const cur = state.current;
  const items = [];
  if (cur && !cur.messages.length) {
    items.push(`<div class="h-item active"><div class="h-main"><div class="h-title">New chat</div><div class="h-meta">Not saved yet</div></div></div>`);
  }
  for (const s of state.sessions) {
    items.push(`<div class="h-item ${cur && cur.id === s.id ? 'active' : ''}" data-id="${s.id}">
      <div class="h-main"><div class="h-title">${escapeHtml(s.title)}</div>
      <div class="h-meta">${s.models} model${s.models === 1 ? '' : 's'} &middot; ${timeAgo(s.updatedAt)}</div></div>
      <button class="h-del" data-del="${s.id}" title="Delete chat">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button></div>`);
  }
  if (!items.length) items.push('<div class="h-empty">Your generated models will be listed here.</div>');
  $('#history').innerHTML = items.join('');
}

$('#history').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    if (busy()) return toast('Wait for the current generation to finish.');
    const id = del.dataset.del;
    if (!confirm('Delete this chat and its models?')) return;
    await api.deleteSession(id).catch(() => { });
    state.sessions = state.sessions.filter((s) => s.id !== id);
    if (state.current && state.current.id === id) startNewChat();
    else renderSidebar();
    return;
  }
  const item = e.target.closest('.h-item[data-id]');
  if (item) openSession(item.dataset.id);
});

async function openSession(id) {
  if (busy()) return toast('Wait for the current generation to finish.');
  try {
    state.current = await api.getSession(id);
  } catch (e) {
    return toast(e.message, 'error');
  }
  state.attachments = [];
  const list = results(state.current);
  state.viewId = list.length ? list[list.length - 1].id : null;
  renderAll();
  showVersion(state.viewId);
}

function startNewChat() {
  if (busy()) return toast('Wait for the current generation to finish.');
  state.current = newSession();
  state.attachments = [];
  state.viewId = null;
  viewer.clear();
  syncCodePanel(null);
  renderAll();
  updateViewerEmpty();
  $('#prompt').focus();
}
$('#btn-new').addEventListener('click', startNewChat);

// ---------------------------------------------------------------- viewer / versions
function updateViewerEmpty() {
  $('#viewer-empty').classList.toggle('hide', !!viewer.root);
  $('#btn-export').disabled = !viewer.root;
  $('#btn-export-code').disabled = !viewer.root || !activeModelMsg();
  if (!viewer.root) $('#viewer-stats').textContent = '';
}

function activeModelMsg() {
  const s = state.current;
  return s && s.messages.find((m) => m.id === state.viewId && m.code);
}

function activeFile() {
  return state.editorFiles.find((f) => f.id === state.activeFileId) || state.editorFiles[0] || null;
}

function updateCodeLineNumbers() {
  const editor = $('#code-editor');
  const linesEl = $('#code-lines');
  if (!editor || !linesEl) return;
  const count = editor.value ? editor.value.split('\n').length : 1;
  const nums = [];
  for (let i = 1; i <= count; i++) nums.push(i);
  linesEl.textContent = nums.join('\n');
}

function renderCodeTabs() {
  const tabsEl = $('#code-tabs');
  if (!tabsEl) return;
  const m = activeModelMsg();
  const savedFiles = m ? codeToFiles(m.code) : [];
  const savedById = new Map(savedFiles.map((f) => [f.id, f.content]));
  tabsEl.innerHTML = state.editorFiles
    .map((f) => {
      const isActive = f.id === state.activeFileId;
      const dirty = savedById.get(f.id) !== f.content;
      const lines = (f.content || '').split('\n').length;
      return `<button class="code-tab ${isActive ? 'active' : ''}" data-file-id="${escapeHtml(f.id)}" title="${escapeHtml(f.name)} (${lines} lines)">
        ${dirty ? '<span class="code-tab-dot"></span>' : ''}
        <span>${escapeHtml(f.name)}</span>
        <span class="code-tab-lines">${lines}</span>
      </button>`;
    })
    .join('');
  tabsEl.querySelector('.code-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function updateDirtyState() {
  const m = activeModelMsg();
  const dirtyEl = $('#code-dirty');
  if (!dirtyEl || !m) return;
  const bundled = filesToCode(state.editorFiles, composePatch);
  const isEditedFromSaved = bundled !== (m.code || '');
  const isModifiedFromOriginal = m.originalCode ? bundled !== m.originalCode : false;
  if (isEditedFromSaved) {
    dirtyEl.textContent = 'Unsaved edits';
    dirtyEl.className = 'code-dirty unsaved';
  } else if (isModifiedFromOriginal) {
    dirtyEl.textContent = 'Edited';
    dirtyEl.className = 'code-dirty';
  } else {
    dirtyEl.className = 'code-dirty hide';
  }
}

function loadActiveFileIntoEditor() {
  const editor = $('#code-editor');
  const f = activeFile();
  if (!editor || !f) return;
  editor.value = f.content || '';
  updateCodeLineNumbers();
  renderCodeTabs();
  updateDirtyState();
}

function switchCodeTab(fileId) {
  const cur = activeFile();
  const editor = $('#code-editor');
  if (cur && editor) cur.content = editor.value;
  if (!state.editorFiles.some((f) => f.id === fileId)) return;
  state.activeFileId = fileId;
  loadActiveFileIntoEditor();
}

function addNewComponentFile() {
  const m = activeModelMsg();
  if (!m) return;
  const cur = activeFile();
  const editor = $('#code-editor');
  if (cur && editor) cur.content = editor.value;
  const raw = prompt('Nama file modul (.ts), contoh: antenna.ts', `module${state.editorFiles.length + 1}.ts`);
  if (!raw) return;
  let name = raw.trim().replace(/[^a-zA-Z0-9._-]/g, '');
  if (!name) return;
  if (!name.endsWith('.ts') && !name.endsWith('.js')) name += '.ts';
  if (state.editorFiles.some((f) => f.name === name)) {
    return toast(`File "${name}" already exists.`, 'error');
  }
  const id = `patch-${Date.now()}`;
  const cleanTitle = name.replace(/\.(ts|js)$/i, '');
  state.editorFiles.push({
    id,
    name,
    title: cleanTitle,
    kind: 'patch',
    content: `// FILE: ${name}\n// Component module added to base.root\nconst partGroup = new THREE.Group();\npartGroup.name = '${cleanTitle}';\nbase.root.add(partGroup);\n`,
  });
  state.activeFileId = id;
  loadActiveFileIntoEditor();
  $('#code-editor')?.focus();
}

function syncCodePanel(msg) {
  const panel = $('#code-panel');
  const editor = $('#code-editor');
  const errEl = $('#code-error');
  if (!panel || !editor) return;
  if (!msg || !msg.code) {
    panel.classList.add('hide');
    editor.value = '';
    state.editorFiles = [];
    state.activeFileId = null;
    if (errEl) errEl.classList.add('hide');
    return;
  }
  panel.classList.remove('hide');
  const parsed = codeToFiles(msg.code);
  state.editorFiles = parsed.map((f) => ({ ...f }));
  if (!state.editorFiles.some((f) => f.id === state.activeFileId)) {
    state.activeFileId = state.editorFiles[0]?.id || null;
  }
  if (errEl) errEl.classList.add('hide');
  const lines = msg.code.split('\n').length;
  const u = getVersionTotalUsage(state.current, msg);
  $('#code-title').textContent = `Model v${msg.version}`;
  // $('#code-meta').textContent = `${state.editorFiles.length} file${state.editorFiles.length === 1 ? '' : 's'} · ${lines} lines · ${(msg.code.length / 1024).toFixed(1)} KB · ${u.estimated ? '~' : ''}${u.total.toLocaleString()} tok (${fmtCost(u.cost)})`;
  $('#code-meta').textContent = `${state.editorFiles.length} file${state.editorFiles.length === 1 ? '' : 's'} · ${lines} lines · ${(msg.code.length / 1024).toFixed(1)} KB`;
  loadActiveFileIntoEditor();
}

function showVersion(id, opts = {}) {
  const s = state.current;
  const msg = s && s.messages.find((m) => m.id === id);
  if (!msg || !msg.code) {
    viewer.clear();
    updateViewerEmpty();
    syncCodePanel(null);
    renderVersions();
    return;
  }
  const r = viewer.load(msg.code, opts);
  state.viewId = id;
  if (!r.ok) toast(`Could not run this version: ${r.error}`, 'error');
  updateViewerEmpty();
  if (r.ok) $('#viewer-stats').textContent = `${r.stats.meshes.toLocaleString()} meshes  |  ${r.stats.triangles.toLocaleString()} triangles`;
  syncCodePanel(msg);
  renderVersions();
  renderThread(false);
}

async function refreshCodeFromEditor() {
  const m = activeModelMsg();
  const editor = $('#code-editor');
  const errEl = $('#code-error');
  if (!m || !editor) return;
  const cur = activeFile();
  if (cur) cur.content = editor.value;
  const code = filesToCode(state.editorFiles, composePatch);
  const r = viewer.load(code, { preserveCamera: true });
  if (!r.ok) {
    if (errEl) {
      errEl.textContent = r.error;
      errEl.classList.remove('hide');
    }
    toast(`Code error: ${r.error}`, 'error');
    return;
  }
  if (errEl) errEl.classList.add('hide');
  if (!m.originalCode) m.originalCode = m.code;
  m.code = code;
  m.stats = r.stats;
  updateViewerEmpty();
  $('#viewer-stats').textContent = `${r.stats.meshes.toLocaleString()} meshes  |  ${r.stats.triangles.toLocaleString()} triangles`;
  syncCodePanel(m);
  renderHeader();
  renderThread(false);
  await persist();
  toast(`Model v${m.version} refreshed & saved`, 'success');
}

async function resetCodeEditor() {
  const m = activeModelMsg();
  if (!m) return;
  const orig = m.originalCode || m.code;
  const cur = activeFile();
  if (cur && $('#code-editor')) cur.content = $('#code-editor').value;
  const bundled = filesToCode(state.editorFiles, composePatch);
  if (bundled === orig && m.code === orig) {
    toast('Code is already at original version');
    return;
  }
  state.editorFiles = codeToFiles(orig).map((f) => ({ ...f }));
  state.activeFileId = state.editorFiles[0]?.id || null;
  loadActiveFileIntoEditor();
  await refreshCodeFromEditor();
}

function renderVersions() {
  const s = state.current;
  const list = s ? results(s) : [];
  const el = $('#versions');
  el.innerHTML = list
    .map((m) => {
      const u = getVersionTotalUsage(s, m);
      // return `<button class="ver ${m.id === state.viewId ? 'active' : ''}" data-ver="${m.id}" title="${u.estimated ? '~' : ''}${u.total.toLocaleString()} tokens (${fmtCost(u.cost)})">v${m.version} <span class="ver-tok">${fmtTokens(u.total)}</span></button>`;
      const vLabel = m.versionLabel ? escapeHtml(m.versionLabel) : `v${m.version}`;
      return `<button class="ver ${m.id === state.viewId ? 'active' : ''}" data-ver="${m.id}">${vLabel}<span class="ver-del" data-del-ver="${m.id}" title="Delete version">&times;</span></button>`;
    })
    .join('');
  el.querySelector('.ver.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
$('#versions').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del-ver]');
  if (del) {
    e.stopPropagation();
    const s = state.current;
    if (!s || !confirm('Delete this model version?')) return;
    const id = del.dataset.delVer;
    s.messages = s.messages.filter((m) => m.id !== id);
    s.updatedAt = Date.now();
    await api.saveSession(s);
    const rem = results(s);
    if (state.viewId === id) {
      state.viewId = null;
      if (rem.length) showVersion(rem[rem.length - 1].id);
      else { viewer.clear(); updateViewerEmpty(); renderCodeTabs(); }
    }
    renderAll();
    toast('Version deleted');
    return;
  }
  const b = e.target.closest('[data-ver]');
  if (b) showVersion(b.dataset.ver);
});
$('#btn-frame').addEventListener('click', () => viewer.frame3d());
function askDialog({ title, label, confirmText, defaultValue }) {
  return new Promise((resolve) => {
    const dlg = $('#export-dialog');
    const inp = $('#export-project-name');
    const cancel = $('#export-cancel');
    dlg.querySelector('.export-dialog-title').textContent = title;
    dlg.querySelector('.export-dialog-label').textContent = label;
    $('#export-confirm').textContent = confirmText;
    inp.value = defaultValue;
    const done = (val) => {
      dlg.removeEventListener('close', onClose);
      cancel.removeEventListener('click', onCancel);
      dlg.removeEventListener('click', onBackdrop);
      resolve(val);
    };
    const onClose = () => done(dlg.returnValue === 'cancel' ? null : inp.value);
    const onCancel = () => { dlg.returnValue = 'cancel'; dlg.close(); };
    const onBackdrop = (e) => { if (e.target === dlg) onCancel(); };
    dlg.returnValue = '';
    dlg.addEventListener('close', onClose);
    cancel.addEventListener('click', onCancel);
    dlg.addEventListener('click', onBackdrop);
    dlg.showModal();
    inp.focus();
    inp.select();
  });
}

const askProjectName = (defaultName) =>
  askDialog({ title: 'Export Code (.zip)', label: 'Project name', confirmText: 'Export', defaultValue: defaultName });

function unwrapExportedCode(text) {
  const m = text.match(/export\s+function\s+buildModel\s*\([^)]*\)\s*\{([\s\S]*)\}\s*$/);
  return (m ? m[1] : text).trim();
}

function readZipModelIndex(buf) {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const dec = new TextDecoder();
  let off = 0;
  while (off + 30 <= bytes.length && view.getUint32(off, true) === 0x04034b50) {
    const method = view.getUint16(off + 8, true);
    const compSize = view.getUint32(off + 18, true);
    const nameLen = view.getUint16(off + 26, true);
    const extraLen = view.getUint16(off + 28, true);
    const name = dec.decode(bytes.subarray(off + 30, off + 30 + nameLen));
    const dataStart = off + 30 + nameLen + extraLen;
    if (name === 'src/model/index.ts' || name.endsWith('/index.ts')) {
      if (method !== 0) throw new Error('Compressed ZIP is not supported; import .ts/.js or an uncompressed .zip');
      return dec.decode(bytes.subarray(dataStart, dataStart + compSize));
    }
    off = dataStart + compSize;
  }
  throw new Error('src/model/index.ts not found in ZIP');
}

$('#btn-import-code').addEventListener('click', () => $('#import-file-input').click());
$('#import-file-input').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;
  try {
    const target = files.find((f) => {
      const p = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
      return !p.includes('/node_modules/') && (p.endsWith('/src/model/index.ts') || p === 'src/model/index.ts');
    });
    if (!target) throw new Error('src/model/index.ts not found in selected folder');
    const code = unwrapExportedCode(await target.text());
    if (!code) throw new Error('src/model/index.ts is empty');

    if (!state.current) await createNewChat();
    const s = state.current;
    const nextVer = (results(s).reduce((max, r) => Math.max(max, r.version || 0), 0)) + 1;
    const input = await askDialog({
      title: 'Import Code',
      label: 'Version name',
      confirmText: 'Save',
      defaultValue: `v${nextVer}-custom`,
    });
    if (input === null) return;
    const versionLabel = input.trim() || `v${nextVer}-custom`;
    const msg = {
      id: uid(),
      role: 'result',
      code,
      model: 'import',
      version: nextVer,
      versionLabel,
      createdAt: Date.now(),
    };
    s.messages.push(msg);
    s.updatedAt = Date.now();
    await api.saveSession(s);
    renderAll();
    showVersion(msg.id);
    toast(`Imported ${versionLabel}`, 'success');
  } catch (err) {
    toast(`Import failed: ${err.message}`, 'error');
  }
});

$('#btn-export-code').addEventListener('click', async () => {
  const s = state.current;
  const m = activeModelMsg();
  if (!m?.code) return toast('No model code to export', 'error');
  const defaultName = s?.title || '3D Model';
  const input = await askProjectName(defaultName);
  if (input === null) return;
  const projectName = input.trim() || defaultName;
  const base = projectName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'model';
  const filename = `${base}-v${m.version || 1}.zip`;
  const vFiles = state.editorFiles?.length ? state.editorFiles : codeToFiles(m.code);
  const blob = buildExportBundle(projectName, m.code, vFiles);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  toast(`Exported ${filename} (${(blob.size / 1024).toFixed(1)} KB)`, 'success');
});

$('#btn-export').addEventListener('click', async () => {
  const s = state.current;
  const m = s && s.messages.find((x) => x.id === state.viewId);
  const base = (s?.title || 'model').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  try {
    const size = await viewer.exportGLB(`${base}-v${m ? m.version : 1}.glb`);
    toast(`Exported GLB (${(size / 1024).toFixed(0)} KB)`, 'success');
  } catch (e) {
    toast(`Export failed: ${e.message}`, 'error');
  }
});

// ---------------------------------------------------------------- chat rendering
function modelOptions(role, selected) {
  return (state.config?.models || [])
    .filter((m) => m.roles.includes(role))
    .map((m) => `<option value="${m.id}" ${m.id === selected ? 'selected' : ''}>${m.label}</option>`)
    .join('');
}

function renderHeader() {
  const s = state.current;
  $('#chat-title').textContent = s ? s.title : 'New chat';
  const n = s ? results(s).length : 0;
  $('#chat-sub').textContent = n ? `${n} model${n === 1 ? '' : 's'} generated` : '';
  // const usageEl = $('#chat-usage');
  // if (usageEl) {
  //   const u = s ? getSessionUsage(s) : { total: 0, input: 0, output: 0, cost: 0, estimated: false };
  //   if (u.total > 0) {
  //     const prefix = u.estimated ? '~' : '';
  //     usageEl.innerHTML = `<span class="usage-pill" title="Cumulative input: ${prefix}${u.input.toLocaleString()} | output: ${prefix}${u.output.toLocaleString()}">Chat: <strong>${prefix}${u.total.toLocaleString()}</strong> tok &middot; <strong>${prefix}${fmtCost(u.cost)}</strong></span>`;
  //   } else {
  //     usageEl.innerHTML = '';
  //   }
  // }
}

function userHtml(m) {
  const imgs = (m.images || []).length
    ? `<div class="u-imgs">${m.images.map((u) => `<img src="${u}" alt="reference" />`).join('')}</div>`
    : '';
  const text = m.text ? `<div class="u-text">${escapeHtml(m.text)}</div>` : '';
  return `<div class="msg user"><div class="bubble">${imgs}${text}</div></div>`;
}

function planHtml(m, isPending) {
  const u = getMsgUsage(m);
  const prefix = u.estimated ? '~' : '';
  // const usageBadge = u.total
  //   ? `<span class="tok-badge" title="Input: ${prefix}${u.input.toLocaleString()} | Output: ${prefix}${u.output.toLocaleString()}">${prefix}${u.total.toLocaleString()} tok &middot; ${prefix}${fmtCost(u.cost)}</span>`
  //   : '';
  const usageBadge = '';
  const action = isPending
    ? `<div class="plan-actions">
         <div class="pa-left">
           <div class="pa-title">Ready to build?</div>
           <div class="pa-sub">Reply below to revise this plan, or start the build.</div>
         </div>
         <div class="pa-right">
           <label class="sel"><span>Builder</span><select id="exec-model">${modelOptions('execute', state.execModel)}</select></label>
           <button id="btn-start" class="start-btn" ${busy() ? 'disabled' : ''}>
             <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>
             Start
           </button>
         </div>
       </div>`
    : m.executed
      ? `<div class="plan-done">Plan approved and built</div>`
      : '';
  return `<div class="msg ai"><div class="card plan-card">
    <div class="card-head"><span class="chip violet">Plan</span><span class="by">${MODEL_LABEL[m.model] || m.model}</span>${usageBadge}</div>
    <div class="md">${renderMarkdown(m.text)}</div>${action}</div></div>`;
}

function resultHtml(m) {
  const u = getMsgUsage(m);
  const prefix = u.estimated ? '~' : '';
  if (m.error) {
    const retry = isRetryOnly(m);
    return `<div class="msg ai"><div class="card err-card">
      // <div class="card-head"><span class="chip red">${retry ? 'Build incomplete' : 'Build failed'}</span><span class="by">${MODEL_LABEL[m.model] || m.model}${u.total ? ` &middot; ${prefix}${u.total.toLocaleString()} tok (${prefix}${fmtCost(u.cost)})` : ''}</span></div>
      <div class="card-head"><span class="chip red">${retry ? 'Build incomplete' : 'Build failed'}</span><span class="by">${MODEL_LABEL[m.model] || m.model}</span></div>
      <div class="err-text">${escapeHtml(m.error)}</div>
      <div class="err-actions">
        <label class="sel"><span>Builder</span><select id="retry-model-${m.id}">${modelOptions('execute', m.model)}</select></label>
        <button class="fix-btn" data-fix="${m.id}" ${busy() ? 'disabled' : ''}>${retry ? 'Retry' : 'Fix'}</button>
      </div></div></div>`;
  }
  const active = m.id === state.viewId;
  // const verTotal = getVersionTotalUsage(state.current, m);
  // const vPrefix = verTotal.estimated ? '~' : '';
  // const tokenLine = `Build: ${prefix}${u.input.toLocaleString()} in / ${prefix}${u.output.toLocaleString()} out (${prefix}${fmtCost(u.cost)})` +
  //   (verTotal.plan.total ? ` &middot; Total v${m.version} (Plan+Build): ${vPrefix}${verTotal.total.toLocaleString()} tok (${vPrefix}${fmtCost(verTotal.cost)})` : '');
  return `<div class="msg ai"><div class="card result-card ${active ? 'active' : ''}" data-ver="${m.id}">
    <div class="r-icon"><div class="mini-cube"><i></i><i></i><i></i></div></div>
    <div class="r-main">
      <div class="r-title">Model v${m.version}</div>
      <div class="r-meta">${MODEL_LABEL[m.model] || m.model}${m.stats ? ` &middot; ${m.stats.triangles.toLocaleString()} triangles` : ''}</div>
      <!-- <div class="r-tokens">\${tokenLine}</div> -->
    </div>
    <div class="r-open">${active ? 'Showing' : 'View in 3D'}</div></div></div>`;
}

function streamHtml() {
  const st = state.stream;
  if (!st) return '';
  if (st.mode === 'plan') {
    return `<div class="msg ai" id="stream-msg"><div class="card plan-card live">
      <div class="card-head"><span class="chip violet pulse">Planning</span><span class="by">${MODEL_LABEL[st.model]}</span>
        <button class="stop-btn" id="btn-stop">Stop</button></div>
      <div class="thinking"><div class="dots"><i></i><i></i><i></i></div><span id="stream-status">Studying your references in detail...</span></div>
      <div class="md" id="stream-body"></div></div></div>`;
  }
  return `<div class="msg ai" id="stream-msg"><div class="card live-build">
      <div class="card-head"><span class="chip green pulse">Building</span><span class="by">${MODEL_LABEL[st.model]}</span>
        <button class="stop-btn" id="btn-stop">Stop</button></div>
      <div class="build-steps" id="build-steps"></div></div></div>`;
}

function emptyHtml() {
  return `<div class="welcome">
    <div class="hero-orb"><i></i><i></i><i></i></div>
    <h1>What do you want to build in 3D?</h1>
    <p>Upload one or more reference photos. Claude plans every detail first, you approve, then it builds a model you can explore, extend with new prompts and export as GLB.</p>
    <div class="chips">
      <button class="sugg" data-s="Build this landmark with exact component counts, proportions and colors.">Reproduce a landmark</button>
      <button class="sugg" data-s="Build this object as a clean low-poly game asset with a clickable interaction.">Game asset with interaction</button>
      <button class="sugg" data-s="Build this building with its surrounding environment, roads and trees.">Building plus environment</button>
    </div></div>`;
}

function renderThread(scroll = true) {
  const s = state.current;
  const el = $('#thread');
  const pend = s ? pendingPlan(s) : null;
  let html = '';
  if (!s || (!s.messages.length && !state.stream)) html = emptyHtml();
  else {
    for (const m of s.messages) {
      if (m.role === 'user') html += userHtml(m);
      else if (m.role === 'plan') html += planHtml(m, pend && pend.id === m.id);
      else if (m.role === 'result') html += resultHtml(m);
    }
    html += streamHtml();
  }
  const keep = el.scrollTop;
  el.innerHTML = html;
  if (scroll) el.scrollTop = el.scrollHeight;
  else el.scrollTop = keep;
  if (state.stream?.mode === 'execute') updateBuildSteps();
  if (state.stream?.mode === 'plan') updatePlanStream();
}

function renderComposer() {
  $('#btn-send').disabled = busy();
  $('#prompt').disabled = false;
  $('#composer').classList.toggle('busy', busy());
  const hasCode = state.current && results(state.current).length;
  $('#prompt').placeholder = busy()
    ? 'Generating... you can stop it from the card above'
    : hasCode
      ? 'Describe a change, add an environment, or attach another reference...'
      : pendingPlan(state.current || { messages: [] })
        ? 'Ask for changes to the plan...'
        : 'Attach a reference photo and describe what to build...';
  $('#attach-row').innerHTML = state.attachments
    .map((u, i) => `<div class="att"><img src="${u}" alt="" /><button data-rm="${i}" title="Remove">&times;</button></div>`)
    .join('');
}

function renderAll() {
  renderSidebar();
  renderHeader();
  renderThread();
  renderComposer();
  renderVersions();
}

// ---------------------------------------------------------------- live streaming UI
let rafPending = false;
function updatePlanStream() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const st = state.stream;
    const body = $('#stream-body');
    if (!st || st.mode !== 'plan' || !body) return;
    const text = st.text.replace(/^OBJECT:.*\n?/i, '');
    body.innerHTML = renderMarkdown(text);
    const status = $('#stream-status');
    if (status && text.length) status.textContent = `Writing the plan... ${text.length.toLocaleString()} characters`;
    const t = $('#thread');
    if (t.scrollHeight - t.scrollTop - t.clientHeight < 220) t.scrollTop = t.scrollHeight;
  });
}

const BUILD_PHASES = [
  'Reading the approved plan',
  'Laying out the main structure',
  'Modeling components and details',
  'Applying colors and materials',
  'Wiring up interactions',
  'Finalizing the code',
];
function updateBuildSteps() {
  const st = state.stream;
  if (!st || st.mode !== 'execute') return;
  const chars = st.text.length;
  const phase = chars === 0 ? 0 : Math.min(BUILD_PHASES.length - 1, 1 + Math.floor(chars / 3500));
  const steps = $('#build-steps');
  if (steps) {
    steps.innerHTML = BUILD_PHASES.map(
      (p, i) => `<div class="step ${i < phase ? 'done' : i === phase ? 'run' : ''}"><span class="dot"></span>${p}</div>`
    ).join('');
  }
  $('#loader-title').textContent = `${MODEL_LABEL[st.model]} is building your model`;
  $('#loader-sub').textContent = chars ? `${BUILD_PHASES[phase]}  |  ${chars.toLocaleString()} characters written` : BUILD_PHASES[0];
}

function setLoader(on) {
  $('#viewer-loader').classList.toggle('show', on);
}

// ---------------------------------------------------------------- generation flow
function parsePlan(raw) {
  const m = /^\s*OBJECT:\s*(.+)$/im.exec(raw);
  const object = m ? m[1].replace(/[*_`]/g, '').trim() : '';
  return { object, body: raw.replace(/^\s*OBJECT:.*\n?/im, '').trim() };
}

function extractCode(raw, stopReason) {
  const open = /```(?:js|javascript)?\s*\n/i.exec(raw);
  if (!open) return { error: 'The model did not return a code block.', kind: 'retry' };
  const rest = raw.slice(open.index + open[0].length);
  const close = rest.lastIndexOf('```');
  let code;
  if (close === -1) {
    if (stopReason === 'max_tokens') {
      return {
        error: 'The model hit its output token limit before finishing the code. Retry (a PATCH-style answer is shorter), or pick Sonnet for big edits.',
        kind: 'retry',
      };
    }
    code = rest.trim(); // finished normally but forgot the closing fence
  } else code = rest.slice(0, close).trim();
  const mode = /^\s*\/\/\s*MODE:\s*(PATCH|MODULE|FULL)/i.exec(code);
  const kind = mode ? mode[1].toUpperCase() : 'FULL';
  return { code, patch: kind === 'PATCH', moduleEdit: kind === 'MODULE' };
}

/** Wraps the previous version and a patch into one self-contained program. */
function composePatch(prev, addon) {
  return `const __base = (function (THREE, ctx) {\n${prev}\n}).call(null, THREE, ctx);
const __add = (function (THREE, ctx, base) {\n${addon}\n}).call(null, THREE, ctx, __base) || {};
const __chain = (a, b) => (a && b ? function (...args) { a.apply(this, args); b.apply(this, args); } : a || b);
return {
  root: __base.root,
  update: __chain(__base.update, __add.update),
  onClick: __chain(__base.onClick, __add.onClick),
  hoverLabel: __add.hoverLabel || __base.hoverLabel,
  isClickable: __add.isClickable && __base.isClickable ? (h) => __add.isClickable(h) || __base.isClickable(h) : __add.isClickable || __base.isClickable,
};`;
}

const isRetryOnly = (m) => m.kind === 'retry' || /cut off|code block|token limit/i.test(m.error || '');

async function runStream(mode, model, extra = {}) {
  const s = state.current;
  state.stream = { mode, model, text: '' };
  state.abort = new AbortController();
  if (mode === 'execute') setLoader(true);
  renderThread();
  renderComposer();
  try {
    const res = await api.stream(
      { mode, model, session: s, ...extra },
      {
        signal: state.abort.signal,
        onDelta: (t) => {
          state.stream.text += t;
          if (mode === 'plan') updatePlanStream();
          else updateBuildSteps();
        },
      }
    );
    return res;
  } catch (e) {
    if (e.name === 'AbortError') toast('Stopped.');
    else toast(e.message, 'error');
    return null;
  } finally {
    state.stream = null;
    state.abort = null;
    setLoader(false);
  }
}

async function sendMessage() {
  if (busy()) return;
  const text = $('#prompt').value.trim();
  if (!text && !state.attachments.length) return;
  if (!state.config?.hasKey) return toast('Add ANTHROPIC_API_KEY to treejs-generator/.env first.', 'error');
  const s = state.current;
  s.messages.push({ id: uid(), role: 'user', text, images: [...state.attachments], createdAt: Date.now() });
  $('#prompt').value = '';
  autoGrow();
  state.attachments = [];
  await persist();
  const model = $('#plan-model').value;
  const res = await runStream('plan', model);
  const raw = res && res.text;
  if (raw) {
    const { object, body } = parsePlan(raw);
    const usage = res.usage || { input: 0, output: 0 };
    s.messages.push({ id: uid(), role: 'plan', text: body, raw, object, model, usage, executed: false, createdAt: Date.now() });
    if (!s.titleSet) {
      const firstText = s.messages.find((m) => m.role === 'user' && m.text)?.text || '';
      s.title = object ? `${object} model` : firstText.slice(0, 40) || 'New model';
      s.titleSet = true;
    }
  }
  renderAll();
  await persist();
}

async function startBuild(fixMsg) {
  if (busy()) return;
  const s = state.current;
  const plan = pendingPlan(s);
  const sel = $('#exec-model');
  const retrySel = fixMsg ? document.querySelector(`#retry-model-${fixMsg.id}`) : null;
  const model = retrySel ? retrySel.value : sel ? sel.value : state.execModel;
  state.execModel = model;
  const retryOnly = fixMsg && isRetryOnly(fixMsg);
  if (plan) plan.executed = true;
  const extra = fixMsg && !retryOnly
    ? { fix: { error: fixMsg.error, code: fixMsg.code, patch: !!fixMsg.patch, moduleEdit: !!fixMsg.moduleEdit } }
    : {};
  const res = await runStream('execute', model, extra);
  if (res === null) {
    if (plan) plan.executed = false;
    renderAll();
    return;
  }
  const ex = extractCode(res.text, res.stopReason);
  const baseCode = (() => {
    const g = results(s);
    return g.length ? g[g.length - 1].code : '';
  })();
  let error = ex.error;
  let kind = ex.kind;
  let stats;
  let finalCode = ex.code || '';
  if (!error) {
    if (ex.moduleEdit) {
      finalCode = baseCode ? applyModuleEdit(baseCode, ex.code, composePatch) : null;
      if (finalCode === null) {
        error = 'The model returned a MODULE edit but there is no previous version to edit.';
        kind = 'retry';
      }
    } else if (ex.patch) {
      finalCode = baseCode ? composePatch(baseCode, ex.code) : null;
      if (finalCode === null) {
        error = 'The model returned a PATCH but there is no previous version to patch.';
        kind = 'retry';
      }
    }
    if (!error) {
      const r = viewer.load(finalCode);
      if (!r.ok) error = r.error;
      else stats = r.stats;
    }
  }
  const version = results(s).length + (error ? 0 : 1);
  const usage = res.usage || { input: 0, output: 0 };
  const builtCode = error ? ex.code || '' : finalCode;
  const msg = {
    id: uid(), role: 'result', model, code: builtCode, originalCode: builtCode,
    patch: !!ex.patch && !!error, moduleEdit: !!ex.moduleEdit && !!error, error, kind,
    stats, version, usage, tokens: (usage.input || 0) + (usage.output || 0), createdAt: Date.now(),
  };
  s.messages.push(msg);
  if (error) {
    const good = results(s);
    if (good.length) showVersion(good[good.length - 1].id);
    else {
      viewer.clear();
      updateViewerEmpty();
      syncCodePanel(null);
    }
    toast(isRetryOnly(msg) ? 'The build did not finish. You can retry.' : 'The build failed. You can fix it automatically.', 'error');
  } else {
    state.viewId = msg.id;
    $('#viewer-stats').textContent = `${stats.meshes.toLocaleString()} meshes  |  ${stats.triangles.toLocaleString()} triangles`;
    syncCodePanel(msg);
    toast(`Model v${version} is ready. Try clicking it!`, 'success');
  }
  updateViewerEmpty();
  renderAll();
  await persist();
}

// ---------------------------------------------------------------- events
$('#thread').addEventListener('click', (e) => {
  if (e.target.closest('#btn-start')) return startBuild();
  if (e.target.closest('#btn-stop')) return state.abort && state.abort.abort();
  const fix = e.target.closest('[data-fix]');
  if (fix) {
    const m = state.current.messages.find((x) => x.id === fix.dataset.fix);
    if (m) return startBuild(m);
  }
  const card = e.target.closest('.result-card[data-ver]');
  if (card) return showVersion(card.dataset.ver);
  const sg = e.target.closest('.sugg');
  if (sg) {
    $('#prompt').value = sg.dataset.s;
    autoGrow();
    $('#prompt').focus();
  }
});
$('#thread').addEventListener('change', (e) => {
  if (e.target.id === 'exec-model') state.execModel = e.target.value;
});

$('#btn-send').addEventListener('click', sendMessage);
$('#prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});
function autoGrow() {
  const p = $('#prompt');
  p.style.height = 'auto';
  p.style.height = `${Math.min(p.scrollHeight, 180)}px`;
}
$('#prompt').addEventListener('input', autoGrow);

// ---------------------------------------------------------------- code editor events
$('#btn-refresh-code')?.addEventListener('click', refreshCodeFromEditor);
$('#btn-reset-code')?.addEventListener('click', resetCodeEditor);
$('#btn-add-file')?.addEventListener('click', addNewComponentFile);
$('#code-tabs')?.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-file-id]');
  if (tab) switchCodeTab(tab.dataset.fileId);
});
$('#btn-copy-code')?.addEventListener('click', async () => {
  const ed = $('#code-editor');
  if (!ed || !ed.value) return;
  try {
    await navigator.clipboard.writeText(ed.value);
    toast('Current file code copied to clipboard', 'success');
  } catch {
    ed.select();
    document.execCommand('copy');
    toast('Current file code copied', 'success');
  }
});
$('#btn-toggle-code')?.addEventListener('click', () => {
  const panel = $('#code-panel');
  const btn = $('#btn-toggle-code');
  if (!panel || !btn) return;
  const collapsed = panel.classList.toggle('collapsed');
  btn.textContent = collapsed ? 'Show Code' : 'Hide Code';
});
$('#code-editor')?.addEventListener('input', (e) => {
  const cur = activeFile();
  if (cur) cur.content = e.target.value;
  updateCodeLineNumbers();
  renderCodeTabs();
  updateDirtyState();
});
$('#code-editor')?.addEventListener('scroll', (e) => {
  const linesEl = $('#code-lines');
  if (linesEl) linesEl.scrollTop = e.target.scrollTop;
});
$('#code-editor')?.addEventListener('keydown', (e) => {
  const ed = e.target;
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    refreshCodeFromEditor();
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = ed.selectionStart;
    const end = ed.selectionEnd;
    ed.value = ed.value.slice(0, start) + '  ' + ed.value.slice(end);
    ed.selectionStart = ed.selectionEnd = start + 2;
    const cur = activeFile();
    if (cur) cur.content = ed.value;
    updateCodeLineNumbers();
    renderCodeTabs();
    updateDirtyState();
  }
});

// attachments
function downscale(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 1568;
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.86));
    };
    img.onerror = () => reject(new Error('Unsupported image'));
    img.src = url;
  });
}
async function addFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith('image/'));
  for (const f of list) {
    if (state.attachments.length >= 6) {
      toast('Up to 6 images per message.');
      break;
    }
    try {
      state.attachments.push(await downscale(f));
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  renderComposer();
}
$('#btn-attach').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => {
  addFiles(e.target.files);
  e.target.value = '';
});
$('#attach-row').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rm]');
  if (b) {
    state.attachments.splice(Number(b.dataset.rm), 1);
    renderComposer();
  }
});
window.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) addFiles(files);
});
const chatEl = $('#chat');
['dragenter', 'dragover'].forEach((ev) =>
  chatEl.addEventListener(ev, (e) => {
    e.preventDefault();
    chatEl.classList.add('drag');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  chatEl.addEventListener(ev, (e) => {
    e.preventDefault();
    chatEl.classList.remove('drag');
  })
);
chatEl.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

// ---------------------------------------------------------------- init
async function init() {
  try {
    state.config = await api.getConfig();
  } catch {
    state.config = { hasKey: false, models: [] };
    toast('Cannot reach the API server. Run "npm run dev" in treejs-generator.', 'error');
  }
  $('#plan-model').innerHTML = modelOptions('plan', 'opus');
  const ks = $('#key-status');
  ks.className = `key-status ${state.config.hasKey ? 'ok' : 'warn'}`;
  ks.innerHTML = state.config.hasKey
    ? state.config.mock
      ? '<span class="dot"></span>Mock mode (no API calls)'
      : '<span class="dot"></span>Ready'
    : '<span class="dot"></span>Add ANTHROPIC_API_KEY to .env';
  try {
    state.sessions = await api.listSessions();
  } catch {
    state.sessions = [];
  }
  state.current = newSession();
  renderAll();
  updateViewerEmpty();
}
init();

