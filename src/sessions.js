/**
 * Session storage and switching.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

const ZIPAI_STATE_DIR = '.zipai-state';
const LEGACY_DIR = '.zipai';
const STORE_FILE = 'sessions.json';

function nowIso() {
  return new Date().toISOString();
}

function randomId() {
  const part = Math.random().toString(36).slice(2, 8);
  return `s_${Date.now().toString(36)}_${part}`;
}

function defaultStore() {
  return {
    active: null,
    sessions: [],
  };
}

function resolveStateDir(workspaceDir = process.cwd()) {
  const preferred = join(workspaceDir, ZIPAI_STATE_DIR);
  if (existsSync(preferred)) return preferred;

  const legacy = join(workspaceDir, LEGACY_DIR);
  if (existsSync(legacy) && statSync(legacy).isDirectory()) {
    try {
      renameSync(legacy, preferred);
      return preferred;
    } catch {
      return legacy;
    }
  }

  return preferred;
}

function getZipaiDir(workspaceDir = process.cwd()) {
  return resolveStateDir(workspaceDir);
}

function getStorePath(workspaceDir = process.cwd()) {
  return join(getZipaiDir(workspaceDir), STORE_FILE);
}

function ensureStoreDir(workspaceDir = process.cwd()) {
  const dir = getZipaiDir(workspaceDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function loadSessionStore(workspaceDir = process.cwd()) {
  const storePath = getStorePath(workspaceDir);
  if (!existsSync(storePath)) return defaultStore();

  try {
    const parsed = JSON.parse(readFileSync(storePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return defaultStore();
    if (!Array.isArray(parsed.sessions)) parsed.sessions = [];
    if (typeof parsed.active !== 'string') parsed.active = null;
    return parsed;
  } catch {
    return defaultStore();
  }
}

export function saveSessionStore(store, workspaceDir = process.cwd()) {
  ensureStoreDir(workspaceDir);
  const storePath = getStorePath(workspaceDir);
  writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

function findSession(store, id) {
  return store.sessions.find((s) => s.id === id) || null;
}

function buildSessionName(name, index = 1) {
  if (name && String(name).trim()) return String(name).trim();
  return `Session ${index}`;
}

export function createSession(options = {}) {
  const {
    workspaceDir = process.cwd(),
    name,
    provider,
    model,
  } = options;

  const store = loadSessionStore(workspaceDir);
  const id = randomId();
  const createdAt = nowIso();

  const session = {
    id,
    name: buildSessionName(name, store.sessions.length + 1),
    provider: provider || null,
    model: model || null,
    createdAt,
    updatedAt: createdAt,
    history: [],
  };

  store.sessions.push(session);
  store.active = id;
  saveSessionStore(store, workspaceDir);

  return session;
}

export function listSessions(workspaceDir = process.cwd()) {
  const store = loadSessionStore(workspaceDir);
  const sorted = [...store.sessions].sort((a, b) => {
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });

  return sorted.map((session) => ({
    id: session.id,
    name: session.name,
    provider: session.provider,
    model: session.model,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    turns: Math.floor((session.history || []).length / 2),
    active: session.id === store.active,
  }));
}

export function setActiveSession(id, workspaceDir = process.cwd()) {
  const store = loadSessionStore(workspaceDir);
  const found = findSession(store, id);
  if (!found) {
    throw new Error(`Session not found: ${id}`);
  }

  store.active = id;
  found.updatedAt = nowIso();
  saveSessionStore(store, workspaceDir);
  return found;
}

export function getActiveSession(workspaceDir = process.cwd()) {
  const store = loadSessionStore(workspaceDir);
  if (!store.active) return null;
  return findSession(store, store.active);
}

export function getSessionById(id, workspaceDir = process.cwd()) {
  const store = loadSessionStore(workspaceDir);
  return findSession(store, id);
}

export function getOrCreateSession(options = {}) {
  const {
    workspaceDir = process.cwd(),
    sessionId,
    createIfMissing = true,
    name,
    provider,
    model,
  } = options;

  const store = loadSessionStore(workspaceDir);

  if (sessionId) {
    const found = findSession(store, sessionId);
    if (!found) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    store.active = sessionId;
    found.updatedAt = nowIso();
    saveSessionStore(store, workspaceDir);
    return found;
  }

  if (store.active) {
    const found = findSession(store, store.active);
    if (found) return found;
  }

  if (!createIfMissing) return null;

  return createSession({
    workspaceDir,
    name,
    provider,
    model,
  });
}

export function updateSessionHistory(id, history, workspaceDir = process.cwd()) {
  const store = loadSessionStore(workspaceDir);
  const found = findSession(store, id);
  if (!found) {
    throw new Error(`Session not found: ${id}`);
  }

  found.history = Array.isArray(history) ? history : [];
  found.updatedAt = nowIso();
  store.active = id;
  saveSessionStore(store, workspaceDir);

  return found;
}
