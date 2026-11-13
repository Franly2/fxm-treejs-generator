import { RETRO_DESK_FAN_SESSION } from './initialSession.js';

const STORAGE_KEY = 'treejs_generator_sessions_v1';
const CURRENT_ID_KEY = 'treejs_generator_current_id_v1';

export function initStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // First visit: Seed exclusively with Retro Desk Fan model!
      const initial = [JSON.parse(JSON.stringify(RETRO_DESK_FAN_SESSION))];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
      localStorage.setItem(CURRENT_ID_KEY, RETRO_DESK_FAN_SESSION.id);
      return initial;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) {
      const initial = [JSON.parse(JSON.stringify(RETRO_DESK_FAN_SESSION))];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
      localStorage.setItem(CURRENT_ID_KEY, RETRO_DESK_FAN_SESSION.id);
      return initial;
    }
    // Ensure Retro Desk Fan model is present in the list
    if (!parsed.some((s) => s.id === RETRO_DESK_FAN_SESSION.id)) {
      parsed.unshift(JSON.parse(JSON.stringify(RETRO_DESK_FAN_SESSION)));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
    }
    return parsed;
  } catch (e) {
    console.error('LocalStorage init error, using fallback:', e);
    return [JSON.parse(JSON.stringify(RETRO_DESK_FAN_SESSION))];
  }
}

export function listSessions() {
  const sessions = initStorage();
  return sessions
    .map((s) => ({
      id: s.id,
      title: s.title || 'Untitled model',
      updatedAt: s.updatedAt || s.createdAt || Date.now(),
      models: (s.messages || []).filter((m) => m.role === 'result' && m.code && !m.error).length,
    }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function getSession(id) {
  const sessions = initStorage();
  const found = sessions.find((s) => s.id === id);
  if (!found) throw new Error(`Session ${id} not found`);
  return JSON.parse(JSON.stringify(found));
}

export function saveSession(session) {
  const sessions = initStorage();
  session.updatedAt = Date.now();
  const idx = sessions.findIndex((s) => s.id === session.id);
  if (idx >= 0) {
    sessions[idx] = JSON.parse(JSON.stringify(session));
  } else {
    sessions.unshift(JSON.parse(JSON.stringify(session)));
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    localStorage.setItem(CURRENT_ID_KEY, session.id);
  } catch (e) {
    console.warn('LocalStorage save warning:', e);
  }
  return { ok: true, updatedAt: session.updatedAt };
}

export function deleteSession(id) {
  let sessions = initStorage();
  sessions = sessions.filter((s) => s.id !== id);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch (e) {
    console.warn('LocalStorage delete warning:', e);
  }
  return { ok: true };
}

export function getSavedCurrentId() {
  try {
    return localStorage.getItem(CURRENT_ID_KEY) || RETRO_DESK_FAN_SESSION.id;
  } catch {
    return RETRO_DESK_FAN_SESSION.id;
  }
}

export function setSavedCurrentId(id) {
  try {
    localStorage.setItem(CURRENT_ID_KEY, id);
  } catch {}
}
