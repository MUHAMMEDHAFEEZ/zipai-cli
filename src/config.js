/**
 * Config loader.
 * Priority (highest → lowest):
 *   1. CLI flags
 *   2. .zipai file in current directory
 *   3. ~/.zipairc global config
 *   4. Environment variables (ANTHROPIC_API_KEY, etc.)
 *   5. Defaults
 */

import { readFileSync, existsSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { config as loadDotenv } from 'dotenv';

// Load .env if present
loadDotenv();

const DEFAULTS = {
  provider:   'anthropic',
  mode:       'build',
  model:      'claude-sonnet-4-20250514',
  maxTokens:  1024,           // default output cap per response
  budget:     null,           // session-wide token budget (null = unlimited)
  lang:       'zh-CN',        // simplified chinese by default
  format:     'dot',          // input format: dot | json | md
  streaming:  true,
  showTokens: true,
  showTips:   true,
  temperature: 0.3,
};

const GLOBAL_CONFIG_PATH = join(homedir(), '.zipairc');
const LOCAL_CONFIG_NAME  = '.zipai';

function normalizeApiKey(value) {
  if (value == null) return null;
  let key = String(value).trim();

  // Common mistake: keys copied with wrapping quotes.
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }

  return key || null;
}

function parseConfigFile(filePath) {
  if (!existsSync(filePath)) return {};
  if (!statSync(filePath).isFile()) return {};
  const raw = readFileSync(filePath, 'utf8');
  const result = {};

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (!key || rest.length === 0) continue;
    const val = rest.join('=').trim();
    result[key.trim()] = parseValue(val);
  }

  return result;
}

export function parseValue(v) {
  if (v === 'true')  return true;
  if (v === 'false') return false;
  if (v === 'null')  return null;
  const n = Number(v);
  if (!isNaN(n) && v !== '') return n;
  return v;
}

export function loadConfig(cliOverrides = {}, { globalPath, localDir } = {}) {
  const gPath = globalPath || GLOBAL_CONFIG_PATH;
  const lDir  = localDir   || process.cwd();

  const globalCfg = parseConfigFile(gPath);
  const localCfg  = parseConfigFile(join(lDir, LOCAL_CONFIG_NAME));

  const cfg = {
    ...DEFAULTS,
    ...globalCfg,
    ...localCfg,
    ...cliOverrides,
  };

  // Pull API key from env if not set
  if (!cfg.apiKey) {
    cfg.apiKey = process.env.ANTHROPIC_API_KEY || null;
  }

  cfg.apiKey = normalizeApiKey(cfg.apiKey);

  return cfg;
}

export function saveGlobalConfig(updates, globalPath) {
  const gPath = globalPath || GLOBAL_CONFIG_PATH;
  let existing = {};
  if (existsSync(gPath)) {
    existing = parseConfigFile(gPath);
  }
  const merged = { ...existing, ...updates };
  const lines = ['# zipai global config', ''];
  for (const [k, v] of Object.entries(merged)) {
    lines.push(`${k}=${v}`);
  }
  writeFileSync(gPath, lines.join('\n') + '\n');
}

export function saveLocalConfig(updates, localDir) {
  const lDir = localDir || process.cwd();
  const path = join(lDir, LOCAL_CONFIG_NAME);
  let existing = {};
  if (existsSync(path)) {
    existing = parseConfigFile(path);
  }
  const merged = { ...existing, ...updates };
  const lines = ['# zipai project config', ''];
  for (const [k, v] of Object.entries(merged)) {
    lines.push(`${k}=${v}`);
  }
  writeFileSync(path, lines.join('\n') + '\n');
}

export { DEFAULTS };
