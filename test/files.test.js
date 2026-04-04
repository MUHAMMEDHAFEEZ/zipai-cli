import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFileContext, detectLang, trimToTokenBudget } from '../src/files.js';

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'zipai-files-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── readFileContext ───────────────────────────────────────────────────────

describe('readFileContext', () => {
  it('returns correct structure for a JS file', () => {
    const filePath = join(tmpDir, 'app.js');
    writeFileSync(filePath, 'const x = 1;\nconst y = 2;\n');

    const result = readFileContext(filePath);
    assert.strictEqual(result.file, 'app.js');
    assert.strictEqual(result.filePath, filePath);
    assert.strictEqual(result.lang, 'js');
    assert.strictEqual(result.truncated, false);
    assert.ok(result.content.includes('const x = 1'));
    assert.strictEqual(typeof result.lines, 'number');
    assert.strictEqual(typeof result.chars, 'number');
  });

  it('detects language from extension', () => {
    const cases = [
      ['test.py', 'py'],
      ['test.rs', 'rs'],
      ['test.go', 'go'],
      ['test.ts', 'ts'],
      ['test.html', 'html'],
      ['test.yaml', 'yaml'],
    ];
    for (const [name, expectedLang] of cases) {
      const filePath = join(tmpDir, name);
      writeFileSync(filePath, 'content');
      const result = readFileContext(filePath);
      assert.strictEqual(result.lang, expectedLang, `${name} should be ${expectedLang}`);
    }
  });

  it('defaults to txt for unknown extensions', () => {
    const filePath = join(tmpDir, 'data.xyz');
    writeFileSync(filePath, 'content');
    assert.strictEqual(readFileContext(filePath).lang, 'txt');
  });

  it('throws on missing file', () => {
    assert.throws(
      () => readFileContext(join(tmpDir, 'nope.js')),
      /File not found/
    );
  });

  it('throws on directory', () => {
    const dir = join(tmpDir, 'subdir');
    mkdirSync(dir);
    assert.throws(
      () => readFileContext(dir),
      /Not a file/
    );
  });

  it('truncates files exceeding 8000 chars', () => {
    const filePath = join(tmpDir, 'big.js');
    writeFileSync(filePath, 'x'.repeat(10000));

    const result = readFileContext(filePath);
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.content.length, 8000);
  });

  it('extracts correct line range with startLine/endLine', () => {
    const filePath = join(tmpDir, 'lines.js');
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    writeFileSync(filePath, lines.join('\n'));

    const result = readFileContext(filePath, { startLine: 5, endLine: 10 });
    const resultLines = result.content.split('\n');
    assert.strictEqual(resultLines[0], 'line 5');
    assert.strictEqual(resultLines[resultLines.length - 1], 'line 10');
    assert.strictEqual(resultLines.length, 6);
  });

  it('handles startLine without endLine', () => {
    const filePath = join(tmpDir, 'lines2.js');
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    writeFileSync(filePath, lines.join('\n'));

    const result = readFileContext(filePath, { startLine: 8 });
    const resultLines = result.content.split('\n');
    assert.strictEqual(resultLines[0], 'line 8');
  });
});

// ── detectLang ────────────────────────────────────────────────────────────

describe('detectLang', () => {
  it('detects JavaScript', () => {
    assert.strictEqual(detectLang('import x from "y"'), 'js');
    assert.strictEqual(detectLang('const x = 1'), 'js');
    assert.strictEqual(detectLang('export function foo()'), 'js');
  });

  it('detects Python', () => {
    assert.strictEqual(detectLang('def foo():'), 'py');
    assert.strictEqual(detectLang('from sys import argv'), 'py');
    assert.strictEqual(detectLang('if __name__'), 'py');
  });

  it('detects Rust', () => {
    assert.strictEqual(detectLang('fn main() {'), 'rs');
    assert.strictEqual(detectLang('use std::io'), 'rs');
    assert.strictEqual(detectLang('struct Point { x: i32 }'), 'rs');
  });

  it('detects Go', () => {
    assert.strictEqual(detectLang('package main'), 'go');
    assert.strictEqual(detectLang('func main() {'), 'go');
  });

  it('detects PHP', () => {
    assert.strictEqual(detectLang('<?php'), 'php');
  });

  it('falls back to txt for unknown content', () => {
    assert.strictEqual(detectLang('random text here'), 'txt');
    assert.strictEqual(detectLang('12345'), 'txt');
  });
});

// ── trimToTokenBudget ─────────────────────────────────────────────────────

describe('trimToTokenBudget', () => {
  it('returns short content unchanged', () => {
    const content = 'short content';
    assert.strictEqual(trimToTokenBudget(content, 100), content);
  });

  it('trims long content with middle cut', () => {
    const content = 'A'.repeat(1000);
    const result = trimToTokenBudget(content, 10); // 10 tokens = 35 chars
    assert.ok(result.length < content.length);
    assert.ok(result.includes('[truncated]'));
  });

  it('preserves start and end of content', () => {
    const start = 'START_MARKER ';
    const middle = 'x'.repeat(1000);
    const end = ' END_MARKER';
    const content = start + middle + end;

    const result = trimToTokenBudget(content, 20); // 20 tokens = 70 chars
    assert.ok(result.startsWith('START_MARKER'));
    assert.ok(result.endsWith('END_MARKER'));
  });
});
