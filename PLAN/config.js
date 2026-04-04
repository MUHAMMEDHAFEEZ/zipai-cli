/**
 * Config loader.
 * Priority (highest → lowest):
 *   1. CLI flags
 *   2. .aicli file in current directory
 *   3. ~/.aiclirc global config
 *   4. Environment variables (ANTHROPIC_API_KEY, etc.)
 *   5. Defaults
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { config as loadDotenv } from 'dotenv';

// Load .env if present
loadDotenv();

const DEFAULTS = {
  model:      'claude-sonnet-4-20250514',
  maxTokens:  1024,           // default output cap per response
  budget:     null,           // session-wide token budget (null = unlimited)
  lang:       'zh-CN',        // simplified chinese by default
  format:     'dot',          // input format: dot | json | md
  streaming:  true,
  showTokens: true,
  temperature: 0.3,
};

const GLOBAL_CONFIG_PATH = join(homedir(), '.aiclirc');
const LOCAL_CONFIG_NAME  = '.aicli';

function parseConfigFile(filePath) {
  if (!existsSync(filePath)) return {};
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

function parseValue(v) {
  if (v === 'true')  return true;
  if (v === 'false') return false;
  if (v === 'null')  return null;
  const n = Number(v);
  if (!isNaN(n) && v !== '') return n;
  return v;
}

export function loadConfig(cliOverrides = {}) {
  const globalCfg = parseConfigFile(GLOBAL_CONFIG_PATH);
  const localCfg  = parseConfigFile(join(process.cwd(), LOCAL_CONFIG_NAME));

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

  return cfg;
}

export function saveGlobalConfig(updates) {
  let existing = {};
  if (existsSync(GLOBAL_CONFIG_PATH)) {
    existing = parseConfigFile(GLOBAL_CONFIG_PATH);
  }
  const merged = { ...existing, ...updates };
  const lines = ['# aicli global config', ''];
  for (const [k, v] of Object.entries(merged)) {
    lines.push(`${k}=${v}`);
  }
  writeFileSync(GLOBAL_CONFIG_PATH, lines.join('\n') + '\n');
}

export function saveLocalConfig(updates) {
  const path = join(process.cwd(), LOCAL_CONFIG_NAME);
  let existing = {};
  if (existsSync(path)) {
    existing = parseConfigFile(path);
  }
  const merged = { ...existing, ...updates };
  const lines = ['# aicli project config', ''];
  for (const [k, v] of Object.entries(merged)) {
    lines.push(`${k}=${v}`);
  }
  writeFileSync(path, lines.join('\n') + '\n');
}

export { DEFAULTS };
