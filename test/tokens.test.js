import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { countTokensSync, TokenBudget } from '../src/tokens.js';

// ── countTokensSync ───────────────────────────────────────────────────────

describe('countTokensSync', () => {
  it('returns ceil(length / 3.5) for a known string', () => {
    const text = 'hello world'; // 11 chars
    assert.strictEqual(countTokensSync(text), Math.ceil(11 / 3.5));
  });

  it('returns 0 for empty string', () => {
    assert.strictEqual(countTokensSync(''), 0);
  });

  it('handles very long strings without crashing', () => {
    const long = 'x'.repeat(100_000);
    const result = countTokensSync(long);
    assert.strictEqual(result, Math.ceil(100_000 / 3.5));
  });

  it('returns a positive integer for non-empty input', () => {
    const result = countTokensSync('some code here');
    assert.ok(result > 0);
    assert.strictEqual(result, Math.ceil(14 / 3.5));
  });
});

// ── TokenBudget — unlimited ───────────────────────────────────────────────

describe('TokenBudget (unlimited)', () => {
  it('has Infinity remaining when max is null', () => {
    const b = new TokenBudget(null);
    assert.strictEqual(b.remaining, Infinity);
  });

  it('is never exhausted', () => {
    const b = new TokenBudget(null);
    assert.strictEqual(b.isExhausted, false);
    b.record(10000, 10000);
    assert.strictEqual(b.isExhausted, false);
  });

  it('canAfford always returns ok', () => {
    const b = new TokenBudget(null);
    assert.deepStrictEqual(b.canAfford(999999, 999999), { ok: true });
  });

  it('safeMaxOutput passes through the requested value', () => {
    const b = new TokenBudget(null);
    assert.strictEqual(b.safeMaxOutput(1024), 1024);
  });

  it('tracks usage even without a limit', () => {
    const b = new TokenBudget(null);
    b.record(100, 200);
    assert.strictEqual(b.total, 300);
    assert.strictEqual(b.usedInput, 100);
    assert.strictEqual(b.usedOutput, 200);
    assert.strictEqual(b.calls, 1);
  });

  it('toString shows total without percentage', () => {
    const b = new TokenBudget(null);
    b.record(100, 200);
    const s = b.toString();
    assert.ok(s.includes('300 total'));
    assert.ok(!s.includes('%'));
  });
});

// ── TokenBudget — limited ─────────────────────────────────────────────────

describe('TokenBudget (limited)', () => {
  it('tracks usage correctly after record', () => {
    const b = new TokenBudget(1000);
    b.record(300, 200);
    assert.strictEqual(b.total, 500);
    assert.strictEqual(b.remaining, 500);
    assert.strictEqual(b.calls, 1);
  });

  it('canAfford returns ok when budget sufficient', () => {
    const b = new TokenBudget(1000);
    b.record(200, 200); // total=400, remaining=600
    assert.deepStrictEqual(b.canAfford(300, 300), { ok: true });
  });

  it('canAfford returns not ok when budget insufficient', () => {
    const b = new TokenBudget(1000);
    b.record(200, 200); // total=400, remaining=600
    const result = b.canAfford(300, 400); // needs 700, has 600
    assert.strictEqual(result.ok, false);
    assert.ok(result.message.includes('700'));
    assert.ok(result.message.includes('600'));
  });

  it('isExhausted returns true when total >= max', () => {
    const b = new TokenBudget(500);
    b.record(300, 200);
    assert.strictEqual(b.isExhausted, true);
  });

  it('isExhausted returns false when under budget', () => {
    const b = new TokenBudget(1000);
    b.record(300, 200);
    assert.strictEqual(b.isExhausted, false);
  });

  it('safeMaxOutput caps at remaining minus 200', () => {
    const b = new TokenBudget(1000);
    b.record(300, 200); // remaining = 500, headroom = 300
    assert.strictEqual(b.safeMaxOutput(1024), 300);
  });

  it('safeMaxOutput returns at least 50', () => {
    const b = new TokenBudget(1000);
    b.record(400, 400); // remaining = 200, headroom = 0
    assert.strictEqual(b.safeMaxOutput(1024), 50);
  });

  it('safeMaxOutput returns requested if under headroom', () => {
    const b = new TokenBudget(10000);
    assert.strictEqual(b.safeMaxOutput(512), 512);
  });

  it('toString includes percentage', () => {
    const b = new TokenBudget(1000);
    b.record(250, 250);
    const s = b.toString();
    assert.ok(s.includes('500/1000'));
    assert.ok(s.includes('50%'));
  });

  it('summary returns correct structure', () => {
    const b = new TokenBudget(1000);
    b.record(100, 200);
    b.record(50, 50);
    const s = b.summary();
    assert.strictEqual(s.calls, 2);
    assert.strictEqual(s.input, 150);
    assert.strictEqual(s.output, 250);
    assert.strictEqual(s.total, 400);
    assert.strictEqual(s.max, 1000);
    assert.strictEqual(s.pct, 40);
  });

  it('remaining never goes below zero', () => {
    const b = new TokenBudget(100);
    b.record(80, 80); // total=160 > max=100
    assert.strictEqual(b.remaining, 0);
  });
});
