/**
 * Lightweight plugin registry.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

const ZIPAI_STATE_DIR = '.zipai-state';
const LEGACY_DIR = '.zipai';
const PLUGINS_DIR = 'plugins';
const MANIFEST_FILE = 'plugin.json';

function nowIso() {
  return new Date().toISOString();
}

function sanitizeModuleRef(moduleRef) {
  return String(moduleRef || '')
    .trim()
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9._/-]/g, '')
    .replace(/[\/]+/g, '-');
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

function getPluginsRoot(workspaceDir = process.cwd()) {
  return join(resolveStateDir(workspaceDir), PLUGINS_DIR);
}

function ensurePluginsRoot(workspaceDir = process.cwd()) {
  const root = getPluginsRoot(workspaceDir);
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  return root;
}

export function listPlugins(workspaceDir = process.cwd()) {
  const root = getPluginsRoot(workspaceDir);
  if (!existsSync(root)) return [];

  const entries = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  const plugins = [];

  for (const dirName of entries) {
    const manifestPath = join(root, dirName, MANIFEST_FILE);
    if (!existsSync(manifestPath)) {
      plugins.push({
        id: dirName,
        module: dirName,
        installedAt: null,
      });
      continue;
    }

    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
      plugins.push({
        id: dirName,
        module: parsed.module || dirName,
        installedAt: parsed.installedAt || null,
      });
    } catch {
      plugins.push({
        id: dirName,
        module: dirName,
        installedAt: null,
      });
    }
  }

  return plugins;
}

export function installPlugin(moduleRef, options = {}) {
  const { workspaceDir = process.cwd(), force = false } = options;
  const cleaned = sanitizeModuleRef(moduleRef);

  if (!cleaned) {
    throw new Error('Plugin module name is required');
  }

  const root = ensurePluginsRoot(workspaceDir);
  const pluginDir = join(root, cleaned);
  const manifestPath = join(pluginDir, MANIFEST_FILE);
  const existedBefore = existsSync(pluginDir);

  if (existedBefore && !force) {
    throw new Error(`Plugin already installed: ${cleaned}`);
  }

  if (!existsSync(pluginDir)) {
    mkdirSync(pluginDir, { recursive: true });
  }

  const manifest = {
    module: String(moduleRef).trim(),
    installedAt: nowIso(),
  };

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  return {
    id: cleaned,
    module: manifest.module,
    manifestPath,
    overwritten: existedBefore && force,
  };
}
