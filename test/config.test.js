import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig, saveGlobalConfig, saveLocalConfig, parseValue, DEFAULTS } from '../src/config.js';

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'zipai-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── parseValue ────────────────────────────────────────────────────────────

describe('parseValue', () => {
  it('converts "true" to boolean true', () => {
    assert.strictEqual(parseValue('true'), true);
  });

  it('converts "false" to boolean false', () => {
    assert.strictEqual(parseValue('false'), false);
  });

  it('converts "null" to null', () => {
    assert.strictEqual(parseValue('null'), null);
  });

  it('converts numeric string to number', () => {
    assert.strictEqual(parseValue('42'), 42);
  });

  it('converts float string to number', () => {
    assert.strictEqual(parseValue('0.3'), 0.3);
  });

  it('keeps regular strings as strings', () => {
    assert.strictEqual(parseValue('hello'), 'hello');
  });

  it('keeps empty string as string', () => {
    assert.strictEqual(parseValue(''), '');
  });
});

// ── loadConfig ────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  it('returns defaults when no config files exist', () => {
    const globalPath = join(tmpDir, '.zipairc');
    const cfg = loadConfig({}, { globalPath, localDir: tmpDir });
    assert.strictEqual(cfg.model, DEFAULTS.model);
    assert.strictEqual(cfg.maxTokens, DEFAULTS.maxTokens);
    assert.strictEqual(cfg.lang, DEFAULTS.lang);
    assert.strictEqual(cfg.streaming, DEFAULTS.streaming);
  });

  it('CLI overrides take highest priority', () => {
    const globalPath = join(tmpDir, '.zipairc');
    writeFileSync(globalPath, 'lang=ja\nmaxTokens=2048\n');
    writeFileSync(join(tmpDir, '.zipai'), 'lang=en\n');

    const cfg = loadConfig(
      { lang: 'ar' },
      { globalPath, localDir: tmpDir }
    );
    assert.strictEqual(cfg.lang, 'ar');
  });

  it('local config overrides global config', () => {
    const globalPath = join(tmpDir, '.zipairc');
    writeFileSync(globalPath, 'lang=ja\n');
    writeFileSync(join(tmpDir, '.zipai'), 'lang=en\n');

    const cfg = loadConfig({}, { globalPath, localDir: tmpDir });
    assert.strictEqual(cfg.lang, 'en');
  });

  it('global config overrides defaults', () => {
    const globalPath = join(tmpDir, '.zipairc');
    writeFileSync(globalPath, 'maxTokens=2048\n');

    const cfg = loadConfig({}, { globalPath, localDir: tmpDir });
    assert.strictEqual(cfg.maxTokens, 2048);
  });

  it('API key falls back to env var', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    try {
      const globalPath = join(tmpDir, '.zipairc');
      const cfg = loadConfig({}, { globalPath, localDir: tmpDir });
      assert.strictEqual(cfg.apiKey, 'sk-test-key');
    } finally {
      if (saved !== undefined) {
        process.env.ANTHROPIC_API_KEY = saved;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it('apiKey from config overrides env var', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-env-key';
    try {
      const globalPath = join(tmpDir, '.zipairc');
      const cfg = loadConfig(
        { apiKey: 'sk-cli-key' },
        { globalPath, localDir: tmpDir }
      );
      assert.strictEqual(cfg.apiKey, 'sk-cli-key');
    } finally {
      if (saved !== undefined) {
        process.env.ANTHROPIC_API_KEY = saved;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it('normalizes quoted apiKey from env var', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = '"sk-ant-quoted"';
    try {
      const globalPath = join(tmpDir, '.zipairc');
      const cfg = loadConfig({}, { globalPath, localDir: tmpDir });
      assert.strictEqual(cfg.apiKey, 'sk-ant-quoted');
    } finally {
      if (saved !== undefined) {
        process.env.ANTHROPIC_API_KEY = saved;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it('normalizes whitespace around apiKey from config', () => {
    const globalPath = join(tmpDir, '.zipairc');
    writeFileSync(globalPath, 'apiKey=   sk-ant-spaces   \n');

    const cfg = loadConfig({}, { globalPath, localDir: tmpDir });
    assert.strictEqual(cfg.apiKey, 'sk-ant-spaces');
  });
});

// ── Config file parsing ───────────────────────────────────────────────────

describe('config file parsing', () => {
  it('ignores empty lines and comments', () => {
    const globalPath = join(tmpDir, '.zipairc');
    writeFileSync(globalPath, '# comment\n\nlang=en\n\n# another\nmaxTokens=512\n');

    const cfg = loadConfig({}, { globalPath, localDir: tmpDir });
    assert.strictEqual(cfg.lang, 'en');
    assert.strictEqual(cfg.maxTokens, 512);
  });

  it('handles value containing equals sign', () => {
    const globalPath = join(tmpDir, '.zipairc');
    writeFileSync(globalPath, 'apiKey=sk-ant-abc=123=456\n');

    const cfg = loadConfig({}, { globalPath, localDir: tmpDir });
    assert.strictEqual(cfg.apiKey, 'sk-ant-abc=123=456');
  });

  it('handles missing files without throwing', () => {
    const globalPath = join(tmpDir, 'nonexistent');
    assert.doesNotThrow(() => {
      loadConfig({}, { globalPath, localDir: join(tmpDir, 'nope') });
    });
  });

  it('parses boolean and numeric values', () => {
    const globalPath = join(tmpDir, '.zipairc');
    writeFileSync(globalPath, 'streaming=false\ntemperature=0.7\nbudget=null\n');

    const cfg = loadConfig({}, { globalPath, localDir: tmpDir });
    assert.strictEqual(cfg.streaming, false);
    assert.strictEqual(cfg.temperature, 0.7);
    assert.strictEqual(cfg.budget, null);
  });
});

// ── saveGlobalConfig / saveLocalConfig ────────────────────────────────────

describe('saveGlobalConfig', () => {
  it('writes key=value format with header', () => {
    const globalPath = join(tmpDir, '.zipairc');
    saveGlobalConfig({ lang: 'en', maxTokens: 512 }, globalPath);

    const cfg = loadConfig({}, { globalPath, localDir: tmpDir });
    assert.strictEqual(cfg.lang, 'en');
    assert.strictEqual(cfg.maxTokens, 512);
  });

  it('merges with existing config', () => {
    const globalPath = join(tmpDir, '.zipairc');
    writeFileSync(globalPath, 'lang=ja\nmaxTokens=2048\n');
    saveGlobalConfig({ lang: 'en' }, globalPath);

    const cfg = loadConfig({}, { globalPath, localDir: tmpDir });
    assert.strictEqual(cfg.lang, 'en');
    assert.strictEqual(cfg.maxTokens, 2048); // preserved from existing
  });
});

describe('saveLocalConfig', () => {
  it('writes to .zipai in the specified directory', () => {
    saveLocalConfig({ lang: 'fr' }, tmpDir);

    const cfg = loadConfig({}, { globalPath: join(tmpDir, 'nope'), localDir: tmpDir });
    assert.strictEqual(cfg.lang, 'fr');
  });

  it('merges with existing local config', () => {
    writeFileSync(join(tmpDir, '.zipai'), 'lang=ja\nstreaming=false\n');
    saveLocalConfig({ lang: 'de' }, tmpDir);

    const cfg = loadConfig({}, { globalPath: join(tmpDir, 'nope'), localDir: tmpDir });
    assert.strictEqual(cfg.lang, 'de');
    assert.strictEqual(cfg.streaming, false); // preserved
  });
});
