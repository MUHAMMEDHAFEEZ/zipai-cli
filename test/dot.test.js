import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { encodeDot, decodeDot, buildDotPrompt, compareFormats } from '../src/dot.js';

// ── Round-trip safety ─────────────────────────────────────────────────────

describe('round-trip: decodeDot(encodeDot(obj))', () => {
  it('round-trips single task field', () => {
    const obj = { task: 'fix' };
    assert.deepStrictEqual(decodeDot(encodeDot(obj)), obj);
  });

  it('round-trips single file field', () => {
    const obj = { file: 'app.js' };
    assert.deepStrictEqual(decodeDot(encodeDot(obj)), obj);
  });

  it('round-trips single lang field', () => {
    const obj = { lang: 'js' };
    assert.deepStrictEqual(decodeDot(encodeDot(obj)), obj);
  });

  it('round-trips single content field', () => {
    const obj = { content: 'const x = 1' };
    assert.deepStrictEqual(decodeDot(encodeDot(obj)), obj);
  });

  it('round-trips single question field', () => {
    const obj = { question: 'why does this fail' };
    assert.deepStrictEqual(decodeDot(encodeDot(obj)), obj);
  });

  it('round-trips single error field', () => {
    const obj = { error: 'TypeError: x is not a function' };
    assert.deepStrictEqual(decodeDot(encodeDot(obj)), obj);
  });

  it('round-trips single context field', () => {
    const obj = { context: 'this is the auth module' };
    assert.deepStrictEqual(decodeDot(encodeDot(obj)), obj);
  });

  it('round-trips multi-field object', () => {
    const obj = { task: 'fix', file: 'app.js', lang: 'js', content: 'const x = 1' };
    assert.deepStrictEqual(decodeDot(encodeDot(obj)), obj);
  });

  it('round-trips content with newlines', () => {
    const obj = { content: 'line1\nline2\nline3' };
    assert.deepStrictEqual(decodeDot(encodeDot(obj)), obj);
  });

  it('round-trips content with tabs', () => {
    const obj = { content: 'if (x) {\n\treturn y;\n}' };
    assert.deepStrictEqual(decodeDot(encodeDot(obj)), obj);
  });

  it('round-trips config-only object', () => {
    const obj = { config: { lang: 'en', max: '1024' } };
    assert.deepStrictEqual(decodeDot(encodeDot(obj)), obj);
  });

  it('round-trips all fields populated', () => {
    const obj = {
      task: 'explain',
      lang: 'py',
      file: 'utils.py',
      line: '10-50',
      content: 'def foo():\n\treturn 42',
      error: 'NameError: foo',
      context: 'Python 3.11 project',
      question: 'what does this do',
    };
    assert.deepStrictEqual(decodeDot(encodeDot(obj)), obj);
  });
});

// ── encodeDot ─────────────────────────────────────────────────────────────

describe('encodeDot', () => {
  it('omits falsy keys', () => {
    const result = encodeDot({ task: 'fix', file: '', lang: undefined, content: null });
    assert.strictEqual(result, '.t:fix');
  });

  it('escapes newlines as ↵', () => {
    const result = encodeDot({ content: 'a\nb' });
    assert.ok(result.includes('↵'));
    assert.ok(!result.includes('\n'));
  });

  it('escapes tabs as →', () => {
    const result = encodeDot({ content: 'a\tb' });
    assert.ok(result.includes('→'));
    assert.ok(!result.includes('\t'));
  });

  it('produces fields in canonical order', () => {
    // Even if keys are provided out of order, output follows: .t .l .f .line .c .e .ctx .q .cfg
    const result = encodeDot({
      question: 'why',
      task: 'fix',
      file: 'x.js',
      lang: 'js',
    });
    const tIdx = result.indexOf('.t:');
    const lIdx = result.indexOf('.l:');
    const fIdx = result.indexOf('.f:');
    const qIdx = result.indexOf('.q:');
    assert.ok(tIdx < lIdx, '.t before .l');
    assert.ok(lIdx < fIdx, '.l before .f');
    assert.ok(fIdx < qIdx, '.f before .q');
  });

  it('handles multiple .cfg entries', () => {
    const result = encodeDot({ config: { lang: 'en', max: '512' } });
    assert.ok(result.includes('.cfg:lang=en'));
    assert.ok(result.includes('.cfg:max=512'));
  });
});

// ── decodeDot ─────────────────────────────────────────────────────────────

describe('decodeDot', () => {
  it('parses all known keys', () => {
    const dot = '.t:fix.l:js.f:app.js.c:code.e:err.ctx:ctx.q:why';
    const obj = decodeDot(dot);
    assert.strictEqual(obj.task, 'fix');
    assert.strictEqual(obj.lang, 'js');
    assert.strictEqual(obj.file, 'app.js');
    assert.strictEqual(obj.content, 'code');
    assert.strictEqual(obj.error, 'err');
    assert.strictEqual(obj.context, 'ctx');
    assert.strictEqual(obj.question, 'why');
  });

  it('handles content containing dots that are not key prefixes', () => {
    // File extension .js inside content should not break parsing
    const dot = '.f:src/app.js.l:js';
    const obj = decodeDot(dot);
    assert.strictEqual(obj.file, 'src/app.js');
    assert.strictEqual(obj.lang, 'js');
  });

  it('returns empty object for empty string', () => {
    assert.deepStrictEqual(decodeDot(''), {});
  });

  it('parses .cfg keys into config object', () => {
    const dot = '.cfg:lang=en.cfg:max=1024';
    const obj = decodeDot(dot);
    assert.deepStrictEqual(obj.config, { lang: 'en', max: '1024' });
  });

  it('unescapes ↵ back to newlines', () => {
    const dot = '.c:line1↵line2';
    const obj = decodeDot(dot);
    assert.strictEqual(obj.content, 'line1\nline2');
  });

  it('unescapes → back to tabs', () => {
    const dot = '.c:a→b';
    const obj = decodeDot(dot);
    assert.strictEqual(obj.content, 'a\tb');
  });
});

// ── buildDotPrompt ────────────────────────────────────────────────────────

describe('buildDotPrompt', () => {
  it('returns dotPayload and estimatedTokens', () => {
    const result = buildDotPrompt({ task: 'fix', file: 'app.js' });
    assert.ok(typeof result.dotPayload === 'string');
    assert.ok(typeof result.estimatedTokens === 'number');
  });

  it('estimates tokens as ceil(length / 3.5)', () => {
    const result = buildDotPrompt({ question: 'hello world' });
    const expected = Math.ceil(result.dotPayload.length / 3.5);
    assert.strictEqual(result.estimatedTokens, expected);
  });

  it('includes all provided fields in payload', () => {
    const result = buildDotPrompt({
      task: 'fix',
      file: 'x.js',
      lang: 'js',
      content: 'code',
      error: 'err',
    });
    assert.ok(result.dotPayload.includes('.t:fix'));
    assert.ok(result.dotPayload.includes('.f:x.js'));
    assert.ok(result.dotPayload.includes('.c:code'));
  });
});

// ── compareFormats ────────────────────────────────────────────────────────

describe('compareFormats', () => {
  it('DOT uses fewer tokens than Markdown and JSON', () => {
    const data = { task: 'explain', file: 'app.js', lang: 'js', content: 'const x = 1;\nconst y = 2;' };
    const cmp = compareFormats(data);
    assert.ok(cmp.dot.tokens < cmp.markdown.tokens, 'DOT < Markdown');
    assert.ok(cmp.dot.tokens < cmp.json.tokens, 'DOT < JSON');
  });

  it('savings percentages are correct', () => {
    const data = { task: 'fix', file: 'app.js', lang: 'js', content: 'code here' };
    const cmp = compareFormats(data);
    const expectedVsJson = Math.round((1 - cmp.dot.tokens / cmp.json.tokens) * 100);
    const expectedVsMd = Math.round((1 - cmp.dot.tokens / cmp.markdown.tokens) * 100);
    assert.strictEqual(cmp.savings.vsJson, expectedVsJson);
    assert.strictEqual(cmp.savings.vsMarkdown, expectedVsMd);
  });

  it('returns all three format strings', () => {
    const data = { task: 'review', question: 'what is this' };
    const cmp = compareFormats(data);
    assert.ok(typeof cmp.json.str === 'string');
    assert.ok(typeof cmp.markdown.str === 'string');
    assert.ok(typeof cmp.dot.str === 'string');
  });
});
