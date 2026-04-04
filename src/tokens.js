/**
 * Token counting and budget management.
 *
 * Uses a simple but accurate heuristic (chars / 3.5) when tiktoken
 * is unavailable, or tiktoken's cl100k_base when available.
 */

let encoder = null;

async function getEncoder() {
  if (encoder) return encoder;
  try {
    const { get_encoding } = await import('tiktoken');
    encoder = get_encoding('cl100k_base');
  } catch {
    // tiktoken not available — use heuristic
    encoder = null;
  }
  return encoder;
}

/**
 * Count tokens in a string.
 * Returns an integer estimate.
 */
export async function countTokens(text) {
  const enc = await getEncoder();
  if (enc) {
    try {
      return enc.encode(text).length;
    } catch {
      // fall through
    }
  }
  // Heuristic: ~3.5 chars per token for mixed code/prose
  return Math.ceil(text.length / 3.5);
}

/**
 * Count tokens synchronously (heuristic only — for fast UI feedback)
 */
export function countTokensSync(text) {
  return Math.ceil(text.length / 3.5);
}

/**
 * Token budget manager.
 * Tracks how many tokens have been used across the session.
 */
export class TokenBudget {
  constructor(maxTokens = null) {
    this.max = maxTokens;        // null = unlimited
    this.usedInput  = 0;
    this.usedOutput = 0;
    this.calls      = 0;
  }

  get total() { return this.usedInput + this.usedOutput; }

  get remaining() {
    if (this.max === null) return Infinity;
    return Math.max(0, this.max - this.total);
  }

  get isExhausted() {
    if (this.max === null) return false;
    return this.total >= this.max;
  }

  /**
   * Check if a request with estimated input tokens can proceed.
   * Returns { ok, message }
   */
  canAfford(inputEstimate, requestedMaxOutput) {
    if (this.max === null) return { ok: true };

    const needed = inputEstimate + requestedMaxOutput;
    if (needed > this.remaining) {
      return {
        ok: false,
        message: `Token budget exceeded. Need ~${needed}, have ${this.remaining} remaining (${this.total}/${this.max} used).`,
      };
    }
    return { ok: true };
  }

  /**
   * Compute the safe max_tokens for a single API call.
   * Never exceeds the remaining budget.
   */
  safeMaxOutput(requested) {
    if (this.max === null) return requested;
    const headroom = this.remaining - 200; // keep 200 token safety margin
    return Math.max(50, Math.min(requested, headroom));
  }

  record(inputTokens, outputTokens) {
    this.usedInput  += inputTokens;
    this.usedOutput += outputTokens;
    this.calls++;
  }

  summary() {
    return {
      calls:  this.calls,
      input:  this.usedInput,
      output: this.usedOutput,
      total:  this.total,
      max:    this.max,
      pct:    this.max ? Math.round((this.total / this.max) * 100) : null,
    };
  }

  toString() {
    const s = this.summary();
    if (s.max) {
      return `tokens: ${s.total}/${s.max} (${s.pct}%) — in:${s.input} out:${s.output} calls:${s.calls}`;
    }
    return `tokens: ${s.total} total — in:${s.input} out:${s.output} calls:${s.calls}`;
  }
}
